import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { JOB_KINDS, MEETING_STATUSES, PIPELINE_STEPS, RECORDING_STATUSES, RSVP_STATUSES, STEP_STATUSES, type StatusTagIds } from '../domain/types.js';
import type { MeetingSummary } from '../ai/llm/schema.js';

const tz = (name?: string) => (name ? timestamp(name, { withTimezone: true }) : timestamp({ withTimezone: true }));
const createdAt = () => tz().notNull().defaultNow();
const updatedAt = () =>
  tz()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const meetingStatus = pgEnum('meeting_status', MEETING_STATUSES);
export const rsvpStatus = pgEnum('rsvp_status', RSVP_STATUSES);
export const jobKind = pgEnum('job_kind', JOB_KINDS);
export const recordingStatus = pgEnum('recording_status', RECORDING_STATUSES);
export const pipelineStep = pgEnum('pipeline_step', PIPELINE_STEPS);
export const stepStatus = pgEnum('step_status', STEP_STATUSES);

/** Réglages Discord d'un serveur, modifiés via /config. */
export const guildSettings = pgTable('guild_settings', {
  guildId: text().primaryKey(),
  /** Bot retiré du serveur : ses données sont supprimées 30 jours après (sauf retour du bot). */
  leftAt: timestamp({ withTimezone: true }),
  forumChannelId: text(),
  /** Post épinglé du forum : bouton « Nouvelle réunion » et liste des prochaines réunions. */
  hubThreadId: text(),
  /** Résumé désactivé pour ce serveur (transcription et audio seulement). */
  llmEnabled: boolean().notNull().default(true),
  /** Salon où le bot signale les problèmes qui demandent une action (traitement en échec, disque…). */
  alertChannelId: text(),
  /** Si renseigné, toutes les réunions se tiennent dans ce salon vocal (pas de choix à la création). */
  voiceChannelId: text(),
  /** Un salon vocal temporaire est créé pour chaque réunion, `autoVoiceLeadMin` minutes avant le début. */
  autoVoice: boolean().notNull().default(false),
  /** Catégorie des salons temporaires ; null = celle du forum. */
  autoVoiceCategoryId: text(),
  autoVoiceLeadMin: integer().notNull().default(15),
  /** Vocabulaire du serveur (pseudos, noms de projets, jargon) : aide la transcription et le résumé. */
  vocabulary: text().array().notNull().default(sql`'{}'::text[]`),
  tagIds: jsonb().$type<StatusTagIds>(),
  /** Ancien rôle gestionnaire unique : repris dans managerRoleIds par la migration, plus utilisé. */
  managerRoleId: text(),
  /** Rôles gestionnaires (jusqu'à 5) : gèrent toutes les réunions. */
  managerRoleIds: text().array().notNull().default(sql`'{}'::text[]`),
  /** Ancien rôle « ne pas m'enregistrer » : ses membres sont repris dans recording_optouts, puis il est oublié. */
  optoutRoleId: text(),
  /** Si renseigné, ses membres sans réponse sont relancés à chaque rappel. */
  nudgeRoleId: text(),
  creatorsRestricted: boolean().notNull().default(false),
  timezone: text().notNull(),
  locale: text().notNull(),
  reminderOffsetsMin: integer().array().notNull(),
  defaultDurationMin: integer().notNull(),
  autoRecordDefault: boolean().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const meetings = pgTable(
  'meetings',
  {
    id: uuid().primaryKey().defaultRandom(),
    guildId: text().notNull(),
    /** Post du forum ; null le temps de la création. Son id est aussi celui du premier message (la carte). */
    threadId: text().unique(),
    /** Second message du post, dédié à l'ordre du jour. */
    agendaMessageId: text(),
    /** Message de contrôle de l'enregistrement, publié au début de la réunion (quelqu'un dans le vocal). */
    controlMessageId: text(),
    /**
     * État affiché par ce message à boutons : « idle », « rec:<session> » ou « stopped:<session> ».
     * Quand l'état change, l'ancien message perd ses boutons et un nouveau est publié en bas du post.
     */
    controlState: text(),
    /** Suivi de l'ordre du jour pendant l'enregistrement (message sous l'avertissement). */
    liveMessageId: text(),
    /** Message de suivi du compte rendu (progression, puis lien vers le compte rendu publié). */
    reportStatusMessageId: text(),
    scheduledEventId: text(),
    /** Null tant que le salon temporaire n'est pas créé (mode « créé automatiquement »). */
    voiceChannelId: text(),
    /** Salon créé par le bot pour cette réunion : supprimé une fois la réunion finie et le salon vide. */
    voiceTemporary: boolean().notNull().default(false),
    voiceDeletedAt: tz(),
    title: text().notNull(),
    description: text().notNull().default(''),
    startsAt: tz().notNull(),
    durationMin: integer().notNull(),
    organizerId: text().notNull(),
    status: meetingStatus().notNull().default('scheduled'),
    autoRecord: boolean().notNull().default(false),
    agendaLocked: boolean().notNull().default(false),
    startedAt: tz(),
    endedAt: tz(),
    /** Sondage de date : fin des réponses (null une fois la date fixée, ou pour une réunion classique). */
    pollClosesAt: tz(),
    /** Personnes qui ont demandé une correction ou une régénération : prévenues à la publication. */
    reportRequesters: text().array().notNull().default(sql`'{}'::text[]`),
    /** Rôles invités à répondre (sondage) : mentionnés à l'invitation, relancés à la place du rôle de relance du serveur. */
    targetRoleIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** « Personne » choisi à la création : aucune relance, même avec un rôle relancé dans /config. */
    inviteNone: boolean().notNull().default(false),
    /** Avis « le compte rendu n'a pas pu être terminé » en cours : remplacé au prochain échec, retiré à la réussite. */
    failureNoticeId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.guildId, t.startsAt)],
);

export const rsvps = pgTable(
  'rsvps',
  {
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    status: rsvpStatus().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.userId] })],
);

export const agendaItems = pgTable(
  'agenda_items',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    title: text().notNull(),
    detail: text().notNull().default(''),
    authorId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.meetingId, t.position)],
);

/**
 * Repères pris en direct pendant l'enregistrement : passage d'un point d'ordre du jour au suivant
 * (« ▶️ Point suivant ») et notes (décision, action, remarque). Transmis au résumé, et horodatés
 * comme la transcription.
 */
export const meetingMarkers = pgTable(
  'meeting_markers',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    kind: text({ enum: ['agenda', 'decision', 'action', 'note'] }).notNull(),
    at: tz().notNull(),
    /** Point commencé (repère « agenda ») ; null : fin de l'ordre du jour, hors ODJ. */
    agendaItemId: integer().references(() => agendaItems.id, { onDelete: 'set null' }),
    text: text().notNull().default(''),
    /** Responsable d'une action, tel que saisi. */
    who: text(),
    authorId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.meetingId, t.at)],
);

/** Créneaux proposés par un sondage de date. */
export const dateSlots = pgTable(
  'date_slots',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    startsAt: tz().notNull(),
    durationMin: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.meetingId, t.startsAt)],
);

/** Réponses au sondage : disponible (yes), si nécessaire (maybe), pas disponible (no). */
export const dateVotes = pgTable(
  'date_votes',
  {
    slotId: integer()
      .notNull()
      .references(() => dateSlots.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    answer: rsvpStatus().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.slotId, t.userId] })],
);

/** Échéances (rappels, début, clôture auto) : la BDD est la source de vérité du scheduler. */
export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    kind: jobKind().notNull(),
    offsetMin: integer().notNull().default(0),
    dueAt: tz().notNull(),
    doneAt: tz(),
    attempts: integer().notNull().default(0),
    /** Bail d'exécution : l'échéance est en cours de traitement jusqu'à cette date. */
    lockedUntil: tz(),
    /** Nouvelle tentative après un échec, pas avant cette date (distinct du bail : replanifiable). */
    retryAt: tz(),
    lastError: text(),
  },
  (t) => [
    unique().on(t.meetingId, t.kind, t.offsetMin),
    index('scheduled_jobs_pending_idx').on(t.dueAt).where(sql`${t.doneAt} is null`),
  ],
);

/** Personnes qui refusent l'enregistrement (par serveur) : présence notée, voix jamais enregistrée. */
export const recordingOptouts = pgTable(
  'recording_optouts',
  {
    guildId: text().notNull(),
    userId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId] })],
);

/** Serveurs de transcription d'un serveur Discord (/config transcription), par ordre de priorité. */
/**
 * Glossaire d'un serveur : termes propres au serveur et leur définition, envoyés au modèle de
 * résumé quand ils apparaissent dans la réunion (et les termes seuls à Whisper). `key` : forme
 * normalisée du terme (casse, accents, ponctuation ignorés), unique par serveur.
 */
export const glossaryTerms = pgTable(
  'glossary_terms',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    guildId: text().notNull(),
    key: text().notNull(),
    term: text().notNull(),
    variants: text().array().notNull().default(sql`'{}'::text[]`),
    definition: text().notNull(),
    updatedBy: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.guildId, t.key)],
);

/**
 * Serveurs de résumé (compatibles OpenAI : LM Studio, Ollama, LiteLLM), par ordre de priorité :
 * en cas d'échec de l'un, le suivant prend le relais. Clé d'API chiffrée (APP_SECRET_KEY).
 */
export const llmBackends = pgTable(
  'llm_backends',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    guildId: text().notNull(),
    position: integer().notNull(),
    name: text().notNull(),
    url: text().notNull(),
    model: text().notNull(),
    apiKey: text(),
    enabled: boolean().notNull().default(true),
    /** Réflexion du modèle (qwen3…) : désactivée par défaut (« /no_think » ajouté aux consignes). */
    thinking: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.guildId, t.name), index().on(t.guildId, t.position)],
);

/** Stockage du serveur (Google Drive, OneDrive, Dropbox) : comptes rendus, transcriptions et audios y sont copiés. */
export const guildStorage = pgTable('guild_storage', {
  guildId: text().primaryKey(),
  provider: text({ enum: ['google', 'onedrive', 'dropbox'] }).notNull(),
  /** Jetons OAuth (JSON), chiffrés avec APP_SECRET_KEY. */
  credentials: text().notNull(),
  /** Compte connecté (adresse ou nom), affiché dans /config. */
  account: text().notNull(),
  /** Dossier racine des copies. */
  folder: text().notNull().default('Meeting recorder'),
  /** Dossier racine suivi par son identifiant (il peut être déplacé dans un dossier partagé) et son lien. */
  rootId: text(),
  rootUrl: text(),
  connectedBy: text().notNull(),
  connectedAt: createdAt(),
  lastOkAt: tz(),
  lastError: text(),
});

export const transcriptionBackends = pgTable(
  'transcription_backends',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    guildId: text().notNull(),
    position: integer().notNull(),
    name: text().notNull(),
    type: text().$type<'vibe' | 'openai'>().notNull(),
    url: text().notNull(),
    model: text().notNull().default('whisper-1'),
    apiKey: text(),
    timeoutSec: integer().notNull().default(600),
    concurrency: integer().notNull().default(1),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.guildId, t.name), index().on(t.guildId, t.position)],
);

/** Une session d'enregistrement (une réunion peut en avoir plusieurs : reprise après coupure). */
export const recordings = pgTable(
  'recordings',
  {
    id: uuid().primaryKey().defaultRandom(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    guildId: text().notNull(),
    voiceChannelId: text().notNull(),
    /** null = démarrage automatique. */
    startedBy: text(),
    startedAt: tz().notNull(),
    endedAt: tz(),
    status: recordingStatus().notNull().default('recording'),
    stopReason: text(),
    /** Arrêt manuel : qui l'a arrêté. */
    stoppedBy: text(),
    /** Dossier local des pistes de cette session. */
    dataDir: text().notNull(),
    /** Pistes brutes supprimées par la rétention (les métadonnées restent). */
    purgedAt: tz(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.meetingId), index().on(t.status)],
);

/** Présence réelle dans le vocal pendant l'enregistrement (une ligne par passage). */
export const recordingPresence = pgTable(
  'recording_presence',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    recordingId: uuid()
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    displayName: text().notNull(),
    joinedAt: tz().notNull(),
    leftAt: tz(),
    /** Rôle « ne pas m'enregistrer » : présence notée, voix jamais enregistrée. */
    excluded: boolean().notNull().default(false),
  },
  (t) => [index().on(t.recordingId)],
);

/**
 * Qualité de capture par personne et par session : paquets reçus (avant déchiffrement DAVE),
 * paquets effectivement écrits, flux interrompus. Révèle les pertes silencieuses de DAVE.
 */
export const captureStats = pgTable(
  'capture_stats',
  {
    recordingId: uuid()
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    receivedPackets: integer().notNull(),
    writtenPackets: integer().notNull(),
    streamErrors: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.recordingId, t.userId] })],
);

/** Une prise de parole = un fichier OGG/Opus 48 kHz. Les temps sont relatifs au début de la session. */
export const audioSegments = pgTable(
  'audio_segments',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    recordingId: uuid()
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    startMs: integer().notNull(),
    endMs: integer().notNull(),
    packets: integer().notNull(),
    filePath: text().notNull(),
  },
  (t) => [index().on(t.recordingId, t.userId, t.startMs)],
);

/** Traitement post-réunion : une ligne par étape et par réunion, pour ne relancer que ce qui a échoué. */
export const pipelineSteps = pgTable(
  'pipeline_steps',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    step: pipelineStep().notNull(),
    status: stepStatus().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    startedAt: tz(),
    finishedAt: tz(),
    error: text(),
    /** Progression ou résultat de l'étape (ex. { done: 12, total: 30 }). */
    output: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [unique().on(t.meetingId, t.step)],
);

/**
 * Bloc de transcription : prises de parole consécutives d'une même personne, assemblées en un
 * seul fichier audio (moins de requêtes, plus de contexte pour Whisper).
 */
export const transcriptionBlocks = pgTable(
  'transcription_blocks',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    recordingId: uuid()
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    /** Relatifs au début de la session d'enregistrement. */
    startMs: integer().notNull(),
    endMs: integer().notNull(),
    segmentIds: integer().array().notNull(),
    done: boolean().notNull().default(false),
    backend: text(),
    model: text(),
  },
  (t) => [index().on(t.meetingId), unique().on(t.recordingId, t.userId, t.startMs)],
);

/** Transcription horodatée (temps absolus), fusionnable chronologiquement entre participants. */
export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    meetingId: uuid()
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    blockId: integer()
      .notNull()
      .references(() => transcriptionBlocks.id, { onDelete: 'cascade' }),
    userId: text().notNull(),
    startAt: tz().notNull(),
    endAt: tz().notNull(),
    text: text().notNull(),
  },
  // block_id : chaque bloc transcrit remplace ses segments, et la suppression d'un bloc cascade.
  (t) => [index().on(t.meetingId, t.startAt), index().on(t.blockId)],
);

/** Résumé structuré d'une réunion, avec la trace des modèles utilisés. */
export const summaries = pgTable('summaries', {
  meetingId: uuid()
    .primaryKey()
    .references(() => meetings.id, { onDelete: 'cascade' }),
  content: jsonb().$type<MeetingSummary>().notNull(),
  llmModel: text().notNull(),
  llmDeployments: text().array().notNull(),
  transcriptionBackends: text().array().notNull(),
  passes: integer().notNull(),
  /** Consignes de correction de l'organisateur, cumulées et rejouées à chaque régénération. */
  corrections: text().array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
});

export type RecordingRow = typeof recordings.$inferSelect;
export type CaptureStatsRow = typeof captureStats.$inferSelect;
export type TranscriptionBackendRow = typeof transcriptionBackends.$inferSelect;
export type GuildStorageRow = typeof guildStorage.$inferSelect;
export type MeetingMarkerRow = typeof meetingMarkers.$inferSelect;
export type PipelineStepRow = typeof pipelineSteps.$inferSelect;
export type TranscriptionBlockRow = typeof transcriptionBlocks.$inferSelect;
export type TranscriptSegmentRow = typeof transcriptSegments.$inferSelect;
export type SummaryRow = typeof summaries.$inferSelect;
export type RecordingPresenceRow = typeof recordingPresence.$inferSelect;
export type AudioSegmentRow = typeof audioSegments.$inferSelect;
export type GuildSettingsRow = typeof guildSettings.$inferSelect;
export type MeetingRow = typeof meetings.$inferSelect;
export type AgendaItemRow = typeof agendaItems.$inferSelect;
export type RsvpRow = typeof rsvps.$inferSelect;
export type ScheduledJobRow = typeof scheduledJobs.$inferSelect;

export type DateSlotRow = typeof dateSlots.$inferSelect;
export type LlmBackendRow = typeof llmBackends.$inferSelect;
export type GlossaryTermRow = typeof glossaryTerms.$inferSelect;
