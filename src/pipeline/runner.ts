import { rm } from 'node:fs/promises';
import { MessageFlags, type Client } from 'discord.js';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import type { GuildSettingsRow, MeetingRow, PipelineStepRow } from '../db/schema.js';
import { renderPipelineStatus, type StepView } from '../discord/embeds/pipelineStatus.js';
import { ensureUnarchived } from '../discord/forum.js';
import { fetchThread, isUnknownMessage } from '../discord/threads.js';
import { PIPELINE_STEPS, type PipelineStep } from '../domain/types.js';
import { messages, type Messages } from '../i18n/index.js';
import { failureCause, TRANSIENT_CAUSES } from '../domain/failure.js';
import { errorMessage } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { SettingsService } from '../services/settings.js';
import type { StorageService } from '../services/storage.js';

export interface StepContext {
  meeting: MeetingRow;
  settings: GuildSettingsRow;
  m: Messages;
  signal: AbortSignal;
  log: Logger;
  /** Progression affichée dans le message de suivi (mises à jour regroupées). */
  progress(detail: string): void;
}

/** Une étape renvoie son résultat (gardé en BDD) ; elle doit être idempotente. */
export type StepFn = (ctx: StepContext) => Promise<Record<string, unknown>>;

export interface PipelineDeps {
  /** Alertes opérateur (optionnel : absent dans les tests). */
  alerts?: { guild(guildId: string, cause: string, message: string): Promise<void> };
  client: Client;
  repos: Repositories;
  /** Stockage du serveur (copie des fichiers) : absent dans les tests. */
  storage?: StorageService;
  settings: SettingsService;
  config: AppConfig;
  log: Logger;
}

const STATUS_THROTTLE_MS = 3000;

/** Étapes lancées ensemble : l'audio complet et la transcription ne dépendent pas l'un de l'autre. */
const PARALLEL_STEPS: readonly PipelineStep[] = ['mix', 'transcribe'];

/** Étapes restantes, par vagues : les étapes parallèles ensemble, puis les autres une à une. */
export function waves<T extends { step: PipelineStep }>(rows: readonly T[]): T[][] {
  const parallel = rows.filter((r) => PARALLEL_STEPS.includes(r.step));
  const rest = rows.filter((r) => !PARALLEL_STEPS.includes(r.step));
  return [...(parallel.length ? [parallel] : []), ...rest.map((r) => [r])];
}

type StepOutcome = 'done' | 'failed' | 'stop';

interface RunContext {
  meeting: MeetingRow;
  settings: GuildSettingsRow;
  m: Messages;
  details: Map<PipelineStep, string>;
  status: StatusMessage;
  plog: Logger;
  /** Arrêt du bot, ou annulation de ce traitement (nouveau résumé demandé pendant le résumé). */
  signal: AbortSignal;
}

/** Suite d'une demande de nouveau résumé (correction, régénération), selon l'étape en cours. */
export type RegenerationOutcome = 'scheduled' | 'restarted' | 'after' | 'included';

/**
 * Relances automatiques d'une étape qui dépend d'un serveur (transcription, résumé, copie vers le
 * stockage, envoi de l'audio complet) quand l'échec est passager (éteint, occupé, trop lent) : après 30 s, 2 min puis 5 min.
 * L'organisateur n'est prévenu qu'une fois ces relances épuisées. Ce qui est déjà fait est gardé
 * (blocs transcrits…).
 */
export const AUTO_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 5 * 60_000] as const;
const AUTO_RETRY_STEPS: readonly PipelineStep[] = ['mix', 'transcribe', 'summarize', 'export'];

/**
 * Traitement post-réunion, reprenable : chaque étape est enregistrée en BDD. Une réunion à la
 * fois (les GPU de transcription et de résumé sont partagés). Un échec arrête le traitement et
 * propose « Relancer », qui ne refait que l'étape en échec et les suivantes ; un arrêt du bot
 * remet l'étape en cours en attente, reprise au démarrage suivant.
 */
export class PipelineService {
  /** Réunions en attente, par serveur (ordre d'arrivée). */
  private readonly pending = new Map<string, string[]>();
  /** Réunions en cours de mise en file (serveur en cours de lecture en base). */
  private readonly enqueuing = new Set<string>();
  /** Traitements en cours : réunion → serveur. */
  private readonly running = new Map<string, { guildId: string; done: Promise<void> }>();
  /** Dernier serveur servi : le suivant dans l'ordre passe en premier (tour de rôle). */
  private lastGuild: string | null = null;
  /** Réunions à retraiter dès la fin du traitement en cours (nouvel enregistrement entre-temps). */
  private readonly refreshAfterRun = new Set<string>();
  /** Réunions à reprendre telles quelles dès la fin du traitement en cours (relance automatique échue). */
  private readonly resumeAfterRun = new Set<string>();
  /** Réunions dont le résumé est à refaire dès la fin du traitement en cours (correction pendant le traitement). */
  private readonly regenerateAfterRun = new Set<string>();
  /** Annulation propre à chaque traitement en cours. */
  private readonly runAborts = new Map<string, AbortController>();
  /** Étapes en cours d'exécution, par réunion. */
  private readonly runningSteps = new Map<string, Set<PipelineStep>>();
  /** Relances automatiques déjà faites, et relance programmée, par réunion. */
  private readonly autoRetries = new Map<string, Map<PipelineStep, number>>();
  private readonly retryTimers = new Map<string, { timer: NodeJS.Timeout; step: PipelineStep }>();
  /** Délais des relances automatiques (raccourcis dans les tests). */
  autoRetryDelaysMs: readonly number[] = AUTO_RETRY_DELAYS_MS;

  /** Compte rendu publié : la carte (liens) et le post épinglé (derniers comptes rendus) sont mis à jour. */
  private onPublished: (meeting: MeetingRow) => void = () => undefined;
  private readonly abort = new AbortController();
  private stopping = false;

  constructor(
    private readonly deps: PipelineDeps,
    /** Étapes ; la publication provisoire (`preview`) est facultative : absente, elle est sautée. */
    private readonly steps: Record<Exclude<PipelineStep, 'preview'>, StepFn> & Partial<Record<'preview', StepFn>>,
  ) {}

  /**
   * Fin d'un enregistrement : traitement complet, ou mise à jour s'il a déjà eu lieu (audio
   * refait avec toutes les sessions, seuls les nouveaux passages transcrits, compte rendu
   * remplacé). Si la réunion est en cours de traitement, la mise à jour suit immédiatement.
   */
  async refresh(meetingId: string): Promise<void> {
    this.clearAutoRetry(meetingId);
    if (!(await this.hasSpeech(meetingId))) return;
    if (this.running.has(meetingId)) {
      this.refreshAfterRun.add(meetingId);
      return;
    }
    await this.deps.repos.ensurePipeline(meetingId);
    await this.deps.repos.resetSteps(meetingId, [...PIPELINE_STEPS]);
    await this.enqueue(meetingId);
  }

  /**
   * Clôture de la réunion : traite ce qui ne l'a pas encore été (par exemple une session
   * interrompue par une coupure, qui ne déclenche rien pour laisser la place à une reprise).
   */
  async processIfNeeded(meetingId: string): Promise<void> {
    if (this.isQueued(meetingId) || !(await this.hasSpeech(meetingId))) return;
    const mix = (await this.deps.repos.listPipeline(meetingId)).find((r) => r.step === 'mix');
    const lastEnd = Math.max(0, ...(await this.deps.repos.listRecordingsForMeeting(meetingId)).map((r) => r.endedAt?.getTime() ?? 0));
    const covered = mix?.status === 'done' && mix.finishedAt !== null && mix.finishedAt.getTime() >= lastEnd;
    if (!covered) await this.refresh(meetingId);
  }

  /** Quelque chose à traiter : de la parole enregistrée, et un post où publier (pas supprimé à la main). */
  private async hasSpeech(meetingId: string): Promise<boolean> {
    if (!(await this.deps.repos.getMeeting(meetingId))?.threadId) return false;
    return this.deps.repos.hasSpeech(meetingId);
  }

  setOnPublished(fn: (meeting: MeetingRow) => void): void {
    this.onPublished = fn;
  }

  /** Programme le traitement (étapes créées si besoin). */
  async schedule(meetingId: string): Promise<void> {
    await this.deps.repos.ensurePipeline(meetingId);
    await this.enqueue(meetingId);
  }

  /**
   * Relance : les étapes en échec repassent en attente ; les suivantes le sont déjà. Une étape
   * terminée en parallèle (transcription pendant un audio complet en échec) n'est pas refaite.
   */
  async retry(meetingId: string): Promise<void> {
    this.clearAutoRetry(meetingId);
    const rows = await this.deps.repos.listPipeline(meetingId);
    await this.deps.repos.resetSteps(meetingId, rows.filter((r) => r.status === 'failed').map((r) => r.step));
    // Encore en cours (l'autre étape parallèle) : reprise dès la fin du traitement.
    if (this.running.has(meetingId)) this.resumeAfterRun.add(meetingId);
    await this.enqueue(meetingId);
  }

  /**
   * « Réessayer maintenant » : la relance automatique en attente part tout de suite. Le compteur
   * de relances est gardé (un nouvel échec reprend la série) ; sans attente en cours, relance normale.
   */
  async retryNow(meetingId: string): Promise<void> {
    const waiting = this.retryTimers.get(meetingId);
    if (!waiting) return this.retry(meetingId);
    clearTimeout(waiting.timer);
    this.retryTimers.delete(meetingId);
    if (this.running.has(meetingId)) this.resumeAfterRun.add(meetingId); // l'audio complet tourne encore
    await this.enqueue(meetingId);
  }

  /**
   * Nouveau résumé demandé (correction, « Régénérer ») alors qu'un traitement peut tourner :
   * - aucun traitement : régénération normale (`scheduled`) ;
   * - résumé pas encore commencé : il lira toutes les consignes (`included`) ;
   * - résumé en cours : annulé aussitôt, puis refait avec toutes les consignes (`restarted`) ;
   * - résumé déjà fait (publication, copie en cours) : refait dès la fin (`after`).
   * La personne est prévenue à la publication, comme pour une régénération.
   */
  async requestRegeneration(meetingId: string, requestedBy?: string): Promise<RegenerationOutcome> {
    if (!this.running.has(meetingId)) {
      await this.regenerate(meetingId, false, requestedBy);
      return 'scheduled';
    }
    if (requestedBy) await this.deps.repos.addReportRequester(meetingId, requestedBy);
    if (this.runningSteps.get(meetingId)?.has('summarize')) {
      this.regenerateAfterRun.add(meetingId);
      this.runAborts.get(meetingId)?.abort();
      return 'restarted';
    }
    const summarize = (await this.deps.repos.listPipeline(meetingId)).find((r) => r.step === 'summarize');
    if (summarize && summarize.status !== 'done') return 'included';
    this.regenerateAfterRun.add(meetingId);
    return 'after';
  }

  /** Nouveau compte rendu : résumé et publication refaits ; la transcription aussi si demandé. */
  async regenerate(meetingId: string, retranscribe: boolean, requestedBy?: string): Promise<void> {
    this.clearAutoRetry(meetingId);
    // Gardé en base : la personne est prévenue à la publication, même après un redémarrage.
    if (requestedBy) await this.deps.repos.addReportRequester(meetingId, requestedBy);
    await this.deps.repos.ensurePipeline(meetingId);
    if (retranscribe) await this.deps.repos.resetTranscription(meetingId);
    await this.deps.repos.resetSteps(meetingId, retranscribe ? [...PIPELINE_STEPS] : ['summarize', 'publish', 'export']);
    // Nouveau résumé demandé : les notes partielles d'un résumé interrompu ne sont pas reprises.
    await this.deps.repos.updateStep(meetingId, 'summarize', { output: null });
    await this.enqueue(meetingId);
  }

  isQueued(meetingId: string): boolean {
    return this.running.has(meetingId) || this.enqueuing.has(meetingId) || [...this.pending.values()].some((q) => q.includes(meetingId));
  }

  /**
   * Au démarrage : reprise des traitements interrompus. Un traitement en échec attend
   * « Relancer » : il n'est pas refait (ni signalé de nouveau) à chaque redémarrage.
   */
  async resume(): Promise<void> {
    for (const meetingId of await this.deps.repos.listUnfinishedPipelines()) {
      const rows = await this.deps.repos.listPipeline(meetingId);
      if (rows.some((r) => r.status === 'failed')) continue;
      const running = rows.filter((r) => r.status === 'running').map((r) => r.step);
      await this.deps.repos.resetSteps(meetingId, running);
      await this.enqueue(meetingId);
    }
    // Clôture juste avant un arrêt du bot : le compte rendu n'avait pas encore été lancé.
    for (const meetingId of await this.deps.repos.listEndedWithoutPipeline()) await this.processIfNeeded(meetingId);
  }

  private clearAutoRetry(meetingId: string): void {
    clearTimeout(this.retryTimers.get(meetingId)?.timer);
    this.retryTimers.delete(meetingId);
    this.autoRetries.delete(meetingId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const { timer } of this.retryTimers.values()) clearTimeout(timer);
    this.abort.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  /**
   * File par serveur, servie à tour de rôle, avec un plafond global de traitements simultanés
   * (pipeline.maxConcurrent, 1 par défaut : les GPU de transcription et de résumé sont partagés).
   * Un serveur n'attend donc que le traitement en cours, pas toute la file des autres. Une
   * réunion n'est jamais traitée deux fois en même temps, ni deux réunions d'un même serveur.
   */
  private async enqueue(meetingId: string): Promise<void> {
    if (this.stopping || this.isQueued(meetingId)) return;
    // Marquée tout de suite : la recherche du serveur ne doit pas la faire paraître « libre ».
    this.enqueuing.add(meetingId);
    try {
      const meeting = await this.deps.repos.getMeeting(meetingId);
      if (!meeting || this.stopping) return;
      const queue = this.pending.get(meeting.guildId) ?? [];
      queue.push(meetingId);
      this.pending.set(meeting.guildId, queue);
    } finally {
      this.enqueuing.delete(meetingId);
    }
    this.pump();
    // Pas de place tout de suite (traitement d'un autre serveur en cours) : le suivi le dit, au
    // lieu de rester muet parfois longtemps.
    if (!this.running.has(meetingId) && this.isQueued(meetingId)) await this.showQueued(meetingId).catch(() => undefined);
  }

  private async showQueued(meetingId: string): Promise<void> {
    const meeting = await this.deps.repos.getMeeting(meetingId);
    if (!meeting?.threadId) return;
    const m = messages((await this.deps.settings.get(meeting.guildId)).locale);
    await new StatusMessage(this.deps, meeting, m, () => null, true).update(new Map());
  }

  /** Lance des traitements tant qu'il reste de la place et un serveur en attente. */
  private pump(): void {
    const max = this.deps.config.pipeline.maxConcurrent;
    while (!this.stopping && this.running.size < max) {
      const busy = new Set([...this.running.values()].map((r) => r.guildId));
      const guilds = [...this.pending.keys()].filter((g) => (this.pending.get(g)?.length ?? 0) > 0 && !busy.has(g));
      if (guilds.length === 0) return;
      // Tour de rôle : le premier serveur après le dernier servi.
      const after = this.lastGuild ? guilds.find((g) => g > this.lastGuild!) : undefined;
      const guildId = after ?? [...guilds].sort()[0]!;
      const meetingId = this.pending.get(guildId)!.shift()!;
      if (this.pending.get(guildId)!.length === 0) this.pending.delete(guildId);
      this.lastGuild = guildId;
      const done = this.process(meetingId).finally(() => {
        this.running.delete(meetingId);
        this.pump();
      });
      this.running.set(meetingId, { guildId, done });
    }
  }

  private async process(meetingId: string): Promise<void> {
    for (;;) {
      try {
        await this.run(meetingId);
      } catch (err) {
        this.deps.log.error({ meetingId, err }, 'Traitement post-réunion en échec');
      }
      // Mise à jour demandée pendant le traitement : elle suit aussitôt, sans que la réunion
      // paraisse « libre » un instant (elle serait doublée).
      if (this.stopping) return;
      if (!this.refreshAfterRun.delete(meetingId)) {
        // Nouveau résumé demandé pendant le traitement (correction) : refait aussitôt, avec toutes
        // les consignes, sans reprendre les notes partielles du résumé interrompu.
        if (this.regenerateAfterRun.delete(meetingId)) {
          this.resumeAfterRun.delete(meetingId);
          await this.deps.repos.resetSteps(meetingId, ['summarize', 'publish', 'export']).catch((err) => this.deps.log.error({ meetingId, err }, 'Nouveau résumé impossible'));
          await this.deps.repos.updateStep(meetingId, 'summarize', { output: null }).catch(() => undefined);
          continue;
        }
        if (this.resumeAfterRun.delete(meetingId)) continue;
        return;
      }
      this.resumeAfterRun.delete(meetingId);
      this.regenerateAfterRun.delete(meetingId); // tout est refait de toute façon
      await this.deps.repos.resetSteps(meetingId, [...PIPELINE_STEPS]).catch((err) => this.deps.log.error({ meetingId, err }, 'Mise à jour du traitement impossible'));
    }
  }

  private async run(meetingId: string): Promise<void> {
    const { repos, log } = this.deps;
    const meeting = await repos.getMeeting(meetingId);
    if (!meeting) return;
    const settings = await this.deps.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    const details = new Map<PipelineStep, string>();
    const status = new StatusMessage(this.deps, meeting, m, () => this.retryTimers.get(meetingId)?.step ?? null);
    const plog = log.child({ meetingId });

    const abort = new AbortController();
    this.runAborts.set(meetingId, abort);
    const run = { meeting, settings, m, details, status, plog, signal: AbortSignal.any([this.abort.signal, abort.signal]) };
    try {
      await this.runWaves(meetingId, run);
    } finally {
      this.runAborts.delete(meetingId);
      this.runningSteps.delete(meetingId);
    }
  }

  private async runWaves(meetingId: string, run: RunContext): Promise<void> {
    const { repos } = this.deps;
    const { status, details, plog } = run;
    // Audio complet et transcription en même temps (la transcription repart des pistes de chaque
    // personne, pas du mix) ; la suite attend les deux. Une étape arrêtée (échec, relance
    // automatique, arrêt du bot) n'interrompt pas l'autre, mais le traitement s'arrête ensuite.
    const all = await repos.listPipeline(meetingId);
    const published = all.some((r) => r.step === 'publish' && r.status === 'done');
    let mixRedone = false;
    for (const wave of waves(all.filter((r) => r.status !== 'done'))) {
      if (this.stopping) return;
      const outcomes = await Promise.all(wave.map((row) => this.runStep(row, run)));
      // L'audio complet en échec ne bloque pas le compte rendu : résumé et publication suivent
      // sans audio ; « Réessayer » refait le mix, puis republie pour l'ajouter.
      const blocked = wave.some((row, i) => outcomes[i] !== 'done' && !(row.step === 'mix' && outcomes[i] === 'failed'));
      if (blocked) {
        await status.update(details); // état final des étapes de la vague (l'autre a pu finir après)
        return;
      }
      if (wave.some((row, i) => row.step === 'mix' && outcomes[i] === 'done')) mixRedone = true;
      // Nouvelle session arrivée entre-temps : tout sera refait, inutile de résumer et publier l'ancienne.
      if (this.refreshAfterRun.has(meetingId)) return;
    }
    // Audio complet refait après une publication sans lui : le compte rendu est republié avec.
    if (mixRedone && published) {
      await repos.resetSteps(meetingId, ['publish', 'export']);
      for (const row of (await repos.listPipeline(meetingId)).filter((r) => r.step === 'publish' || r.step === 'export')) {
        if ((await this.runStep(row, run)) !== 'done') return;
      }
    }
    // Étape encore en échec (audio complet) : le suivi l'affiche, l'avis reste, le mix sans perte est gardé.
    if ((await repos.listPipeline(meetingId)).some((r) => r.status === 'failed')) {
      await status.update(details);
      return;
    }
    // Tout est fait : le suivi n'a plus d'utilité (le compte rendu et le bilan portent les liens).
    await status.remove();
    this.autoRetries.delete(meetingId);
    await this.clearFailureNotice(meetingId).catch((e) => plog.warn({ err: errorMessage(e) }, 'Avis d’échec non retiré'));
    // Réunion close : plus de nouvelle session possible, le mix sans perte ne sert plus.
    if ((await repos.getMeeting(meetingId))?.status === 'ended') {
      const master = await repos.dropMixMaster(meetingId);
      if (master) {
        await rm(master, { force: true }).catch((err) => plog.warn({ err: errorMessage(err) }, 'Suppression du mix sans perte impossible'));
        await rm(`${master}.json`, { force: true }).catch(() => undefined); // son manifeste
      }
    }
  }

  /**
   * Une étape : `done`, `failed` (échec signalé, « Réessayer ») ou `stop` (relance automatique
   * programmée, arrêt du bot) ; le traitement s'arrête après une étape non terminée, sauf l'audio
   * complet en échec (voir run).
   */
  private async runStep(row: PipelineStepRow, run: RunContext): Promise<StepOutcome> {
    try {
      return await this.runStepInner(row, run);
    } finally {
      this.runningSteps.get(run.meeting.id)?.delete(row.step); // étape finie : plus « en cours »
    }
  }

  private async runStepInner(row: PipelineStepRow, run: RunContext): Promise<StepOutcome> {
    const { repos } = this.deps;
    const { meeting, settings, m, details, status, plog } = run;
    const meetingId = meeting.id;
    if (this.stopping) return 'stop';
    // Étape en échec : refaite seulement après « Relancer » (pas par la relance automatique de
    // l'étape parallèle) ; la vague s'arrête là.
    if (row.status === 'failed') return 'failed';
    await repos.updateStep(meetingId, row.step, { status: 'running', attempts: row.attempts + 1, startedAt: new Date(), error: null });
    const active = this.runningSteps.get(meetingId) ?? new Set<PipelineStep>();
    this.runningSteps.set(meetingId, active.add(row.step));
    await status.update(details);
    plog.info({ step: row.step }, 'Étape démarrée');
    try {
      const step: StepFn = this.steps[row.step] ?? (async () => ({ skipped: true }));
      const output = await step({
        meeting,
        settings,
        m,
        signal: run.signal,
        log: plog.child({ step: row.step }),
        progress: (detail) => {
          details.set(row.step, detail);
          status.schedule(details);
        },
      });
      await repos.updateStep(meetingId, row.step, { status: 'done', finishedAt: new Date(), output });
      plog.info({ step: row.step }, 'Étape terminée');
      // Série de relances propre à chaque étape : la réussite de l'audio complet, en parallèle,
      // ne remet pas à zéro celle de la transcription.
      this.autoRetries.get(meetingId)?.delete(row.step);
      // Compte rendu publié : la carte, le post épinglé et les demandeurs n'attendent pas la copie vers le stockage.
      // Compte rendu provisoire publié (transcription disponible) : la carte, le post épinglé et le
      // bilan reçoivent déjà son lien, qui ne changera plus.
      if (row.step === 'preview' && Array.isArray(output.messageIds)) this.onPublished(meeting);
      if (row.step === 'publish') {
        this.onPublished(meeting);
        await this.notifyRequesters(meeting, m).catch((e) => plog.warn({ err: errorMessage(e) }, 'Avis de mise à jour impossible'));
      }
    } catch (err) {
      // Arrêt du bot (reprise au redémarrage) ou traitement annulé pour un nouveau résumé : ni
      // échec ni relance automatique, l'étape est simplement remise en attente.
      if (run.signal.aborted) {
        await repos.updateStep(meetingId, row.step, { status: 'pending' });
        return 'stop';
      }
      const message = errorMessage(err);
      // Échec passager d'un serveur : relance automatique plus tard, sans prévenir personne.
      const tries = this.autoRetries.get(meetingId)?.get(row.step) ?? 0;
      const cause = failureCause(message);
      if (AUTO_RETRY_STEPS.includes(row.step) && TRANSIENT_CAUSES.includes(cause) && tries < this.autoRetryDelaysMs.length && !this.stopping) {
        const delay = this.autoRetryDelaysMs[tries]!;
        this.autoRetries.set(meetingId, (this.autoRetries.get(meetingId) ?? new Map<PipelineStep, number>()).set(row.step, tries + 1));
        plog.warn({ step: row.step, err: message, attempt: tries + 1, delayMs: delay }, 'Étape en échec passager : relance automatique');
        await repos.updateStep(meetingId, row.step, { status: 'pending', error: message });
        details.set(row.step, m.pipeline.autoRetry(m.pipeline.causes[cause], Math.max(1, Math.round(delay / 60_000)), delay < 60_000, tries + 1, this.autoRetryDelaysMs.length));
        // Une seule relance programmée par réunion : elle reprend toutes les étapes en attente.
        clearTimeout(this.retryTimers.get(meetingId)?.timer);
        const timer = setTimeout(() => {
          this.retryTimers.delete(meetingId);
          // Encore en cours (l'audio complet, en parallèle) : reprise dès la fin du traitement.
          if (this.running.has(meetingId)) this.resumeAfterRun.add(meetingId);
          void this.enqueue(meetingId).catch((e) => plog.error({ err: e }, 'Relance automatique impossible'));
        }, delay);
        this.retryTimers.set(meetingId, { timer, step: row.step });
        await status.update(details); // bouton « Réessayer … maintenant » pendant l'attente
        return 'stop';
      }
      plog.error({ step: row.step, err }, 'Étape en échec');
      await repos.updateStep(meetingId, row.step, { status: 'failed', finishedAt: new Date(), error: message });
      details.set(row.step, message);
      await status.update(details);
      // L'organisateur est prévenu (le message de suivi, lui, est silencieux) ; pas pour la copie
      // vers le stockage : le compte rendu est publié, c'est l'affaire des administrateurs (alerte).
      if (row.step !== 'export') await this.notifyFailure(meeting, m).catch((e) => plog.warn({ err: errorMessage(e) }, 'Avis d’échec impossible'));
      const url = meeting.threadId ? `https://discord.com/channels/${meeting.guildId}/${meeting.threadId}` : '';
      await this.deps.alerts
        ?.guild(meeting.guildId, `pipeline:${row.step}`, m.alerts.stepFailed(meeting.title, m.pipeline.steps[row.step] ?? row.step, message.slice(0, 300), url))
        .catch(() => undefined);
      return 'failed';
    }
    return 'done';
  }

  private async notifyFailure(meeting: MeetingRow, m: Messages): Promise<void> {
    const thread = await fetchThread(this.deps.client, meeting.threadId);
    if (!thread) return;
    // Ceux qui ont demandé la régénération sont prévenus aussi ; ils le seront de nouveau à la
    // publication réussie (relance).
    const requesters = (await this.deps.repos.getMeeting(meeting.id))?.reportRequesters ?? [];
    const users = [...new Set([meeting.organizerId, ...requesters])];
    await ensureUnarchived(thread);
    // Un seul avis par réunion : le précédent est remplacé (le nouveau notifie de nouveau).
    await this.clearFailureNotice(meeting.id);
    const notice = await thread.send({ content: m.pipeline.failedNotice(users), allowedMentions: { users } });
    await this.deps.repos.updateMeeting(meeting.id, { failureNoticeId: notice.id });
  }

  /** Avis d'échec retiré : traitement réussi, ou remplacé par un nouvel avis. */
  private async clearFailureNotice(meetingId: string): Promise<void> {
    const noticeId = (await this.deps.repos.getMeeting(meetingId))?.failureNoticeId;
    if (!noticeId) return;
    await this.deps.repos.updateMeeting(meetingId, { failureNoticeId: null });
    const meeting = await this.deps.repos.getMeeting(meetingId);
    const thread = await fetchThread(this.deps.client, meeting?.threadId ?? null);
    await thread?.messages.delete(noticeId).catch(() => undefined);
  }

  /** Compte rendu publié : ceux qui avaient demandé une correction ou une régénération sont prévenus. */
  private async notifyRequesters(meeting: MeetingRow, m: Messages): Promise<void> {
    const users = await this.deps.repos.takeReportRequesters(meeting.id);
    if (users.length === 0) return;
    const thread = await fetchThread(this.deps.client, meeting.threadId);
    if (!thread) return;
    const publish = (await this.deps.repos.listPipeline(meeting.id)).find((r) => r.step === 'publish');
    const url = typeof publish?.output?.url === 'string' ? publish.output.url : null;
    await ensureUnarchived(thread);
    await thread.send({ content: m.pipeline.updatedNotice(users, url), allowedMentions: { users } });
  }
}

/** Message de suivi dans le post (créé au premier affichage, puis édité ; éditions espacées). */
class StatusMessage {
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: PipelineDeps,
    private readonly meeting: MeetingRow,
    private readonly m: Messages,
    /** Étape dont la relance automatique est programmée : bouton « Réessayer … maintenant ». */
    private readonly waiting: () => PipelineStep | null = () => null,
    /** En attente dans la file (traitement d'un autre serveur en cours). */
    private readonly queued = false,
  ) {}

  schedule(details: Map<PipelineStep, string>): void {
    if (this.timer) return;
    const wait = Math.max(0, STATUS_THROTTLE_MS - (Date.now() - this.last));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.update(details).catch(() => undefined);
    }, wait);
  }

  /** Traitement réussi : le message de suivi est supprimé (il sera recréé au prochain traitement). */
  remove(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const next = this.queue.then(async () => {
      const meeting = await this.deps.repos.getMeeting(this.meeting.id);
      if (!meeting?.reportStatusMessageId) return;
      const thread = await fetchThread(this.deps.client, meeting.threadId);
      await thread?.messages.delete(meeting.reportStatusMessageId).catch(() => undefined);
      await this.deps.repos.updateMeeting(meeting.id, { reportStatusMessageId: null });
    });
    this.queue = next.catch(() => undefined);
    return next.catch((err) => this.deps.log.warn({ meetingId: this.meeting.id, err: errorMessage(err) }, 'Message de suivi non supprimé'));
  }

  /** Mises à jour l'une après l'autre : deux étapes en parallèle ne créent pas deux messages. */
  update(details: Map<PipelineStep, string>): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.last = Date.now();
    const next = this.queue.then(() => this.render(details));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async render(details: Map<PipelineStep, string>): Promise<void> {
    const { repos, client, log } = this.deps;
    const meeting = (await repos.getMeeting(this.meeting.id)) ?? this.meeting;
    // Copie vers le stockage affichée seulement si le serveur en a un (ou si elle a eu lieu).
    const storage = (await this.deps.storage?.get(meeting.guildId).catch(() => undefined)) !== undefined;
    const rows = (await repos.listPipeline(meeting.id)).filter((r) => r.step !== 'export' || (r.status === 'done' ? r.output?.skipped !== true : storage || r.status === 'failed'));
    const views: StepView[] = rows.map((r) => ({
      step: r.step,
      status: r.status,
      detail: r.status === 'failed' ? (r.error ?? details.get(r.step)) : (details.get(r.step) ?? null),
      skipped: r.status === 'done' && r.output?.skipped === true,
    }));
    const publish = rows.find((r) => r.step === 'publish');
    const url = typeof publish?.output?.url === 'string' ? publish.output.url : undefined;
    const container = renderPipelineStatus(meeting.id, views, this.m, url, this.waiting(), this.queued);

    try {
      const thread = await fetchThread(client, meeting.threadId);
      if (!thread) return;
      if (meeting.reportStatusMessageId) {
        // Recréé seulement s'il a été supprimé, pas sur une erreur passagère (doublon sinon).
        const message = await thread.messages.fetch(meeting.reportStatusMessageId).catch((err: unknown) => {
          if (isUnknownMessage(err)) return null;
          throw err;
        });
        if (message) {
          await ensureUnarchived(thread);
          await message.edit({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
          return;
        }
      }
      await ensureUnarchived(thread);
      const message = await thread.send({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
        allowedMentions: { parse: [] },
      });
      await repos.updateMeeting(meeting.id, { reportStatusMessageId: message.id });
    } catch (err) {
      log.warn({ meetingId: meeting.id, err: errorMessage(err) }, 'Message de suivi du compte rendu impossible');
    }
  }
}
