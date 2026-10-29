import { createHash } from 'node:crypto';
import { chunkLines, estimateTokens } from '../../domain/transcript.js';
import { isContextOverflow } from '../../domain/failure.js';
import { glossaryBlock, glossaryFor, type GlossaryEntry } from '../../domain/glossary.js';
import { applyReplacements, correctionReplacements } from '../../domain/vocabulary.js';
import type { ChatMessage } from './client.js';
import type { JsonLlm } from './failover.js';
import { meetingSummarySchema, type MeetingSummary, type Topic } from './schema.js';

export interface SummaryContext {
  title: string;
  description: string;
  date: string;
  participants: readonly string[];
  agenda: ReadonlyArray<{ id: number; title: string; detail: string }>;
  /** Vocabulaire du serveur : orthographe de référence des noms propres et du jargon. */
  vocabulary?: readonly string[];
  /** Consignes de correction de l'organisateur, prioritaires sur la transcription. */
  corrections?: readonly string[];
  /** Glossaire du serveur : seules les définitions des termes présents dans la passe sont envoyées. */
  glossary?: readonly GlossaryEntry[];
}

/**
 * Reprise après un redémarrage : les notes partielles déjà obtenues (passe « map », une par
 * morceau) sont gardées sous une clé qui dépend de tout ce qui les produit (consignes, contexte,
 * morceaux). Même clé à la reprise : les morceaux déjà résumés ne sont pas redemandés.
 */
export interface SummaryCheckpoint {
  load(key: string): MeetingSummary[] | undefined;
  save(key: string, partials: readonly MeetingSummary[]): Promise<void>;
}

export interface SummarizeResult {
  summary: MeetingSummary;
  passes: number;
  models: string[];
}

const FORMAT = `Réponds uniquement avec un objet JSON de la forme :
{
  "overview": "synthèse de la réunion en 2 à 4 phrases",
  "topics": [
    {
      "agendaItemId": <numéro du point d'ordre du jour (1, 2…), ou null pour un sujet hors ordre du jour>,
      "title": "titre du sujet",
      "summary": "ce qui a été dit, en quelques phrases",
      "decisions": ["décision prise", ...],
      "actions": [{ "what": "tâche", "who": "nom du participant ou null", "when": "échéance en clair ou null" }],
      "openQuestions": ["question restée sans réponse", ...]
    }
  ]
}`;

const RULES = `Règles :
- Écris en français, de façon factuelle et concise, même si la réunion s'est tenue dans une autre langue ou en plusieurs langues.
- N'invente rien : uniquement ce qui figure dans la transcription. Une transcription automatique contient des erreurs : corrige les mots manifestement mal reconnus, sans changer le sens.
- Un sujet = une question discutée. Rattache-le à un point de l'ordre du jour (son numéro dans agendaItemId) seulement s'il traite vraiment de ce point, même abordé dans le désordre ou en d'autres termes.
- Tout autre sujet (digression, autre projet, sujet évoqué en passant) est un sujet distinct hors ordre du jour (agendaItemId null), avec un titre court que tu rédiges et ses propres décisions et actions. Ne le fusionne jamais dans un point de l'ordre du jour, même s'il a été évoqué juste après ou par les mêmes personnes.
- Pour un sujet rattaché à un point de l'ordre du jour, le titre est celui du point, tel quel, sans sa description.
- Un point de l'ordre du jour non abordé n'apparaît pas.
- Une décision est un choix acté par le groupe ; une action est une tâche confiée (who = nom exact d'un participant, ou null).
- Lignes « ▶️ Point N de l'ordre du jour » : repères posés en direct par l'animateur au moment où la réunion passe à ce point (« Fin de l'ordre du jour » : la suite est hors ordre du jour). Sers-t'en pour rattacher les échanges au bon point, sans en faire un sujet.
- Lignes « 📝 … notée en direct » : décisions, actions et remarques saisies pendant la réunion par un participant. Reprends chaque décision et chaque action notée (avec son responsable) dans le sujet correspondant, même si la transcription ne la reprend pas mot pour mot.
- Listes vides si rien de tel n'a été dit.`;

/** Consignes de l'organisateur, placées dans le prompt système (prioritaires). */
export function correctionsBlock(corrections: readonly string[] | undefined): string {
  if (!corrections?.length) return '';
  return `\n\nConsignes de l'organisateur de la réunion, à appliquer en priorité (elles corrigent la transcription ou un précédent résumé) :\n${corrections.map((c) => `- ${c}`).join('\n')}`;
}

function contextBlock(ctx: SummaryContext): string {
  const agenda = ctx.agenda.length
    ? ctx.agenda.map((a, i) => `${i + 1}. ${a.title}${a.detail.trim() ? ` — ${a.detail.trim().replace(/\s*\n\s*/g, ' / ')}` : ''}`).join('\n')
    : '(aucun ordre du jour)';
  return `Réunion : ${ctx.title}${ctx.description ? `\nDescription : ${ctx.description}` : ''}
Date : ${ctx.date}
Participants : ${ctx.participants.join(', ') || '(inconnus)'}${ctx.vocabulary?.length ? `\nVocabulaire (orthographe correcte des noms et termes) : ${ctx.vocabulary.join(', ')}` : ''}
Ordre du jour :
${agenda}`;
}

/**
 * Résumé structuré par point d'ordre du jour. Une réunion longue est résumée en plusieurs
 * passes : chaque morceau de transcription donne des notes partielles (même format), puis les
 * notes sont fusionnées (par paquets si nécessaire) jusqu'à un résumé unique.
 */
export async function summarizeMeeting(
  llm: JsonLlm,
  ctx: SummaryContext,
  lines: readonly string[],
  chunkTokens: number,
  onProgress: (pass: number, total: number) => void = () => undefined,
  signal?: AbortSignal,
  checkpoint?: SummaryCheckpoint,
): Promise<SummarizeResult> {
  const models = new Set<string>();
  const run = async (messages: ChatMessage[]) => {
    const r = await llm.json(messages, meetingSummarySchema, signal);
    models.add(r.deployment ? `${r.model} (${r.deployment})` : r.model);
    return r.value;
  };
  const system: ChatMessage = {
    role: 'system',
    content: `Tu rédiges le compte rendu d'une réunion à partir de sa transcription.\n${RULES}${correctionsBlock(ctx.corrections)}\n\n${FORMAT}`,
  };

  // Consignes « Pol et non Paul » : appliquées par le bot, dans la transcription envoyée et dans
  // le résumé obtenu ; un petit modèle ne les suit pas toujours, surtout sur plusieurs passes.
  const replacements = correctionReplacements(ctx.corrections ?? []);
  const fix = (text: string) => applyReplacements(text, replacements);
  const finish = (summary: MeetingSummary) => sanitize(replacements.length ? fixStrings(summary, fix) : summary, ctx);
  const chunks = chunkLines(replacements.length ? lines.map(fix) : lines, chunkTokens);
  // Glossaire : pour chaque passe, les définitions des seuls termes qu'elle contient.
  const glossaryOf = (text: string) => glossaryBlock(glossaryFor(text, ctx.glossary ?? []));
  // Passes : une par morceau, puis les fusions (estimées pour l'affichage).
  const estimatedTotal = chunks.length === 1 ? 1 : chunks.length + Math.max(1, Math.ceil(chunks.length / 4));
  let pass = 0;

  if (chunks.length === 1) {
    onProgress(++pass, estimatedTotal);
    const text = chunks[0]!.join('\n');
    const summary = await run([system, { role: 'user', content: `${contextBlock(ctx)}${glossaryOf(text)}\n\nTranscription :\n${text}` }]);
    return { summary: finish(summary), passes: pass, models: [...models] };
  }

  // Passe « map » : notes partielles par morceau, gardées au fur et à mesure (reprise).
  const key = createHash('sha256').update(JSON.stringify({ system: system.content, context: contextBlock(ctx), glossary: ctx.glossary ?? [], chunks })).digest('hex').slice(0, 32);
  let partials: MeetingSummary[] = [...(checkpoint?.load(key) ?? [])].slice(0, chunks.length);
  pass = partials.length;
  for (const [i, chunk] of chunks.entries()) {
    if (i < partials.length) continue; // déjà résumé avant un redémarrage
    onProgress(++pass, estimatedTotal);
    partials.push(
      await run([
        system,
        {
          role: 'user',
          content: `${contextBlock(ctx)}${glossaryOf(chunk.join('\n'))}\n\nVoici l'extrait ${i + 1}/${chunks.length} de la transcription. Résume uniquement cet extrait (même format) ; une fusion suivra.\n\nTranscription :\n${chunk.join('\n')}`,
        },
      ]),
    );
    await checkpoint?.save(key, partials);
  }

  // Passes « reduce » : fusion par paquets tenant dans la fenêtre, jusqu'à un seul résumé.
  while (partials.length > 1) {
    const groups: MeetingSummary[][] = [];
    let current: MeetingSummary[] = [];
    let size = 0;
    for (const p of partials) {
      const t = estimateTokens(JSON.stringify(p));
      if (current.length >= 2 && size + t > chunkTokens) {
        groups.push(current);
        current = [];
        size = 0;
      }
      current.push(p);
      size += t;
    }
    groups.push(current);
    // Paquet trop gros pour le contexte du modèle : fusionné en deux moitiés, sans redemander les
    // passes déjà faites (les notes partielles sont gardées).
    const mergeGroup = async (group: MeetingSummary[]): Promise<MeetingSummary[]> => {
      if (group.length === 1) return group;
      try {
        onProgress(++pass, Math.max(estimatedTotal, pass));
        return [
          await run([
            system,
            {
              role: 'user',
              content: `${contextBlock(ctx)}${glossaryOf(JSON.stringify(group))}\n\nVoici ${group.length} résumés partiels successifs de la même réunion. Fusionne-les en un seul (même format) : regroupe par sujet, supprime les doublons, garde toutes les décisions et actions.\n\n${group.map((p, i) => `Résumé ${i + 1} :\n${JSON.stringify(p)}`).join('\n\n')}`,
            },
          ]),
        ];
      } catch (err) {
        if (group.length <= 2 || !isContextOverflow(err instanceof Error ? err.message : String(err))) throw err;
        const half = Math.ceil(group.length / 2);
        return [...(await mergeGroup(group.slice(0, half))), ...(await mergeGroup(group.slice(half)))];
      }
    };
    const merged: MeetingSummary[] = [];
    for (const group of groups) merged.push(...(await mergeGroup(group)));
    partials = merged;
  }
  return { summary: finish(partials[0]!), passes: pass, models: [...models] };
}

/**
 * Rattachement fiable à l'ordre du jour : le modèle désigne les points par leur numéro (1, 2…),
 * converti ici en id. Un sujet sans numéro valide mais dont le titre est celui d'un point y est
 * rattaché (les petits modèles se trompent de numéro). Plusieurs sujets pour un même point : ceux
 * dont le titre est celui du point y sont fusionnés, les autres sont des sujets distincts, hors ODJ
 * (un modèle range volontiers une digression dans le point voisin). Les sujets vides sont retirés.
 */
/** Toutes les chaînes du résumé passées par `fix` (titres, synthèses, décisions, actions…). */
function fixStrings<T>(value: T, fix: (text: string) => string): T {
  if (typeof value === 'string') return fix(value) as T;
  if (Array.isArray(value)) return value.map((v) => fixStrings(v, fix)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fixStrings(v, fix)])) as T;
  return value;
}

export function sanitize(summary: MeetingSummary, ctx: SummaryContext): MeetingSummary {
  const titleOf = new Map(ctx.agenda.map((a) => [a.id, normalizeTitle(a.title)]));
  const sameTitle = (topicTitle: string, agendaId: number): boolean => {
    const a = titleOf.get(agendaId)!;
    const t = normalizeTitle(topicTitle);
    return a === t || (a.length >= 4 && t.length >= 4 && (a.includes(t) || t.includes(a)));
  };
  const resolve = (t: Topic): number | null => {
    const n = t.agendaItemId;
    if (n !== null && Number.isInteger(n) && n >= 1 && n <= ctx.agenda.length) return ctx.agenda[n - 1]!.id;
    const close = ctx.agenda.filter((a) => sameTitle(t.title, a.id));
    return close.length === 1 ? close[0]!.id : null;
  };

  const kept = summary.topics
    .filter((t) => t.summary || t.decisions.length || t.actions.length || t.openQuestions.length)
    .map((t) => ({ ...t, agendaItemId: resolve(t) }));
  // Sujet principal de chaque point : le premier qui en porte le titre, sinon le premier rattaché.
  const primary = new Map<number, Topic>();
  for (const t of kept) if (t.agendaItemId !== null && !primary.has(t.agendaItemId) && sameTitle(t.title, t.agendaItemId)) primary.set(t.agendaItemId, t);
  for (const t of kept) if (t.agendaItemId !== null && !primary.has(t.agendaItemId)) primary.set(t.agendaItemId, t);

  const topics: Topic[] = [];
  for (const t of kept) {
    const main = t.agendaItemId === null ? undefined : primary.get(t.agendaItemId);
    if (!main || main === t) {
      topics.push(t);
    } else if (sameTitle(t.title, t.agendaItemId!)) {
      main.summary = [main.summary, t.summary].filter(Boolean).join(' ');
      main.decisions = [...main.decisions, ...t.decisions];
      main.actions = [...main.actions, ...t.actions];
      main.openQuestions = [...main.openQuestions, ...t.openQuestions];
    } else {
      topics.push({ ...t, agendaItemId: null });
    }
  }
  return { overview: summary.overview, topics: topics.map(dedupe) };
}

/**
 * Doublons retirés (fusion des passes : la même action vue dans deux extraits) : même texte à
 * la casse, aux accents et à la ponctuation près. Une action en double garde le responsable et
 * l'échéance de l'une ou l'autre.
 */
function dedupe(topic: Topic): Topic {
  const unique = (items: readonly string[]) => items.filter((item, i) => items.findIndex((other) => normalizeTitle(other) === normalizeTitle(item)) === i);
  const actions = new Map<string, Topic['actions'][number]>();
  for (const a of topic.actions) {
    const key = normalizeTitle(a.what);
    const seen = actions.get(key);
    actions.set(key, seen ? { ...seen, who: seen.who || a.who, when: seen.when || a.when } : a);
  }
  return { ...topic, decisions: unique(topic.decisions), actions: [...actions.values()], openQuestions: unique(topic.openQuestions) };
}

/** « L'Apothicaire ! » → « l apothicaire » : casse, accents et ponctuation ignorés. */
function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
