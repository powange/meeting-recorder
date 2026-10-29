import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { GuildSeed } from '../config/index.js';
import { reindex } from '../domain/agenda.js';
import { glossaryKey, type GlossaryEntry } from '../domain/glossary.js';
import type { PlannedJob } from '../domain/reminders.js';
import { PIPELINE_STEPS, type MeetingStatus, type PipelineStep, type RsvpStatus } from '../domain/types.js';
import type { Db } from './client.js';
import {
  agendaItems,
  dateSlots,
  llmBackends,
  dateVotes,
  glossaryTerms,
  audioSegments,
  captureStats,
  pipelineSteps,
  recordingOptouts,
  summaries,
  transcriptionBackends,
  transcriptionBlocks,
  transcriptSegments,
  recordingPresence,
  recordings,
  guildSettings,
  guildStorage,
  meetingMarkers,
  meetings,
  rsvps,
  scheduledJobs,
  type AgendaItemRow,
  type GlossaryTermRow,
  type PipelineStepRow,
  type SummaryRow,
  type TranscriptionBackendRow,
  type TranscriptionBlockRow,
  type TranscriptSegmentRow,
  type AudioSegmentRow,
  type RecordingPresenceRow,
  type RecordingRow,
  type GuildSettingsRow,
  type GuildStorageRow,
  type MeetingMarkerRow,
  type DateSlotRow,
  type LlmBackendRow,
  type MeetingRow,
  type RsvpRow,
  type ScheduledJobRow,
} from './schema.js';

type MeetingInsert = typeof meetings.$inferInsert;
type SettingsPatch = Partial<Omit<typeof guildSettings.$inferInsert, 'guildId' | 'createdAt' | 'updatedAt'>>;

export class Repositories {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- guild_settings

  async getSettings(guildId: string, seed: GuildSeed): Promise<GuildSettingsRow> {
    const [existing] = await this.db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
    if (existing) return existing;
    await this.db
      .insert(guildSettings)
      .values({ guildId, ...seed })
      .onConflictDoNothing();
    const [created] = await this.db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
    return created!;
  }

  /** Bot retiré du serveur (ou revenu : null). */
  async markGuildLeft(guildId: string, at: Date | null): Promise<void> {
    await this.db.update(guildSettings).set({ leftAt: at }).where(eq(guildSettings.guildId, guildId));
  }

  /** Serveurs connus en base (réglages créés). */
  async listGuildIds(): Promise<Array<{ guildId: string; leftAt: Date | null }>> {
    return this.db.select({ guildId: guildSettings.guildId, leftAt: guildSettings.leftAt }).from(guildSettings);
  }

  async listGuildsLeftBefore(before: Date): Promise<string[]> {
    const rows = await this.db.select({ guildId: guildSettings.guildId }).from(guildSettings).where(lt(guildSettings.leftAt, before));
    return rows.map((r) => r.guildId);
  }

  /**
   * Toutes les données d'un serveur quitté : réunions (et en cascade enregistrements,
   * transcriptions, résumés, réponses, échéances…), refus d'enregistrement, serveurs d'IA,
   * stockage, réglages. Les fichiers sont supprimés par l'appelant.
   */
  async purgeGuild(guildId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(meetings).where(eq(meetings.guildId, guildId));
      await tx.delete(recordingOptouts).where(eq(recordingOptouts.guildId, guildId));
      await tx.delete(llmBackends).where(eq(llmBackends.guildId, guildId));
      await tx.delete(transcriptionBackends).where(eq(transcriptionBackends.guildId, guildId));
      await tx.delete(guildStorage).where(eq(guildStorage.guildId, guildId));
      await tx.delete(glossaryTerms).where(eq(glossaryTerms.guildId, guildId));
      await tx.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
    });
  }

  // ---------------------------------------------------------------- glossaire

  async listGlossary(guildId: string): Promise<GlossaryTermRow[]> {
    const rows = await this.db.select().from(glossaryTerms).where(eq(glossaryTerms.guildId, guildId));
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Ajoute ou met à jour des termes (même terme à la casse et aux accents près : mis à jour).
   * Renvoie le nombre d'ajouts et de mises à jour.
   */
  async upsertGlossary(guildId: string, entries: readonly GlossaryEntry[], by: string): Promise<{ added: number; updated: number }> {
    if (entries.length === 0) return { added: 0, updated: 0 };
    const existing = new Set((await this.listGlossary(guildId)).map((r) => r.key));
    const values = entries.map((e) => ({ guildId, key: glossaryKey(e.term), term: e.term, variants: [...e.variants], definition: e.definition, updatedBy: by, updatedAt: new Date() }));
    await this.db
      .insert(glossaryTerms)
      .values(values)
      .onConflictDoUpdate({
        target: [glossaryTerms.guildId, glossaryTerms.key],
        set: { term: sql`excluded.term`, variants: sql`excluded.variants`, definition: sql`excluded.definition`, updatedBy: sql`excluded.updated_by`, updatedAt: sql`excluded.updated_at` },
      });
    const added = values.filter((v) => !existing.has(v.key)).length;
    return { added, updated: values.length - added };
  }

  /** Modifie un terme ; faux si un autre terme du serveur a déjà cette écriture. */
  async updateGlossaryTerm(guildId: string, id: number, entry: GlossaryEntry, by: string): Promise<boolean> {
    const key = glossaryKey(entry.term);
    const clash = (await this.listGlossary(guildId)).some((r) => r.key === key && r.id !== id);
    if (clash) return false;
    await this.db
      .update(glossaryTerms)
      .set({ key, term: entry.term, variants: [...entry.variants], definition: entry.definition, updatedBy: by, updatedAt: new Date() })
      .where(and(eq(glossaryTerms.guildId, guildId), eq(glossaryTerms.id, id)));
    return true;
  }

  async deleteGlossaryTerm(guildId: string, id: number): Promise<void> {
    await this.db.delete(glossaryTerms).where(and(eq(glossaryTerms.guildId, guildId), eq(glossaryTerms.id, id)));
  }

  /** Chiffre les clés d'API encore stockées en clair (APP_SECRET_KEY ajoutée après coup). Renvoie leur nombre. */
  async encryptPlaintextSecrets(encrypt: (plain: string) => string): Promise<number> {
    let count = 0;
    const llms = await this.db
      .select({ id: llmBackends.id, key: llmBackends.apiKey })
      .from(llmBackends)
      .where(and(isNotNull(llmBackends.apiKey), sql`${llmBackends.apiKey} not like 'enc:%'`));
    for (const row of llms) {
      await this.db.update(llmBackends).set({ apiKey: encrypt(row.key!) }).where(eq(llmBackends.id, row.id));
      count++;
    }
    const backends = await this.db
      .select({ id: transcriptionBackends.id, key: transcriptionBackends.apiKey })
      .from(transcriptionBackends)
      .where(and(isNotNull(transcriptionBackends.apiKey), sql`${transcriptionBackends.apiKey} not like 'enc:%'`));
    for (const row of backends) {
      await this.db.update(transcriptionBackends).set({ apiKey: encrypt(row.key!) }).where(eq(transcriptionBackends.id, row.id));
      count++;
    }
    const storages = await this.db
      .select({ guildId: guildStorage.guildId, credentials: guildStorage.credentials })
      .from(guildStorage)
      .where(sql`${guildStorage.credentials} not like 'enc:%'`);
    for (const row of storages) {
      await this.db.update(guildStorage).set({ credentials: encrypt(row.credentials) }).where(eq(guildStorage.guildId, row.guildId));
      count++;
    }
    return count;
  }

  /** Serveurs dont le forum des réunions est configuré. */
  async listConfiguredGuildIds(): Promise<string[]> {
    const rows = await this.db.select({ id: guildSettings.guildId }).from(guildSettings).where(isNotNull(guildSettings.forumChannelId));
    return rows.map((r) => r.id);
  }

  async listHubThreadIds(): Promise<string[]> {
    const rows = await this.db.select({ id: guildSettings.hubThreadId }).from(guildSettings).where(isNotNull(guildSettings.hubThreadId));
    return rows.map((r) => r.id!);
  }

  /** Réglages sans création (lecture seule). */
  async getSettingsIfExists(guildId: string): Promise<GuildSettingsRow | undefined> {
    const [row] = await this.db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
    return row;
  }

  /** Serveurs qui utilisaient encore un rôle « ne pas m'enregistrer » (reprise en base). */
  async listOptoutRoles(): Promise<Array<{ guildId: string; optoutRoleId: string }>> {
    const rows = await this.db
      .select({ guildId: guildSettings.guildId, optoutRoleId: guildSettings.optoutRoleId })
      .from(guildSettings)
      .where(isNotNull(guildSettings.optoutRoleId));
    return rows.map((r) => ({ guildId: r.guildId, optoutRoleId: r.optoutRoleId! }));
  }

  async listAlertChannels(): Promise<string[]> {
    const rows = await this.db.select({ id: guildSettings.alertChannelId }).from(guildSettings).where(isNotNull(guildSettings.alertChannelId));
    return rows.map((r) => r.id!);
  }

  async updateSettings(guildId: string, patch: SettingsPatch): Promise<void> {
    await this.db.update(guildSettings).set(patch).where(eq(guildSettings.guildId, guildId));
  }

  // ---------------------------------------------------------------- meetings

  async insertMeeting(values: MeetingInsert): Promise<MeetingRow> {
    const [row] = await this.db.insert(meetings).values(values).returning();
    return row!;
  }

  async getMeeting(id: string): Promise<MeetingRow | undefined> {
    const [row] = await this.db.select().from(meetings).where(eq(meetings.id, id));
    return row;
  }

  /** Réunions dont le post est à vérifier au démarrage : ouvertes, ou closes depuis moins de `days` jours. */
  async listMeetingsWithThread(days: number): Promise<MeetingRow[]> {
    return this.db
      .select()
      .from(meetings)
      .where(
        and(
          isNotNull(meetings.threadId),
          or(inArray(meetings.status, ['scheduled', 'live', 'polling']), sql`${meetings.endedAt} > now() - make_interval(days => ${days})`),
        ),
      );
  }

  async getMeetingByThread(threadId: string): Promise<MeetingRow | undefined> {
    const [row] = await this.db.select().from(meetings).where(eq(meetings.threadId, threadId));
    return row;
  }

  async updateMeeting(id: string, patch: Partial<MeetingInsert>): Promise<MeetingRow | undefined> {
    const [row] = await this.db.update(meetings).set(patch).where(eq(meetings.id, id)).returning();
    return row;
  }

  /** Réunions à venir, en cours ou en sondage de date, tous serveurs confondus. */
  async listOpenMeetings(): Promise<MeetingRow[]> {
    return this.db.select().from(meetings).where(inArray(meetings.status, ['scheduled', 'live', 'polling']));
  }

  /** Salons temporaires de réunions finies ou annulées, pas encore supprimés. */
  async listTemporaryVoicesToDelete(): Promise<MeetingRow[]> {
    return this.db
      .select()
      .from(meetings)
      .where(and(eq(meetings.voiceTemporary, true), isNull(meetings.voiceDeletedAt), inArray(meetings.status, ['ended', 'cancelled'])));
  }

  async listMeetings(guildId: string, statuses: readonly MeetingStatus[]): Promise<MeetingRow[]> {
    return this.db
      .select()
      .from(meetings)
      .where(and(eq(meetings.guildId, guildId), inArray(meetings.status, [...statuses])));
  }

  async deleteMeeting(id: string): Promise<void> {
    await this.db.delete(meetings).where(eq(meetings.id, id));
  }

  /**
   * Changement de statut conditionnel (compare-and-set) : renvoie la ligne si la transition
   * a eu lieu, `undefined` si la réunion n'était plus dans un des statuts `from` (course entre
   * le scheduler et un clic, par exemple).
   */
  async transitionMeeting(
    id: string,
    from: readonly MeetingStatus[],
    to: MeetingStatus,
    patch: Partial<MeetingInsert> = {},
  ): Promise<MeetingRow | undefined> {
    const [row] = await this.db
      .update(meetings)
      .set({ ...patch, status: to })
      .where(and(eq(meetings.id, id), inArray(meetings.status, [...from])))
      .returning();
    return row;
  }

  // ---------------------------------------------------------------- rsvps

  // ---------------------------------------------------------------- sondages de date

  async insertSlots(meetingId: string, slots: ReadonlyArray<{ startsAt: Date; durationMin: number }>): Promise<void> {
    if (slots.length === 0) return;
    await this.db.insert(dateSlots).values(slots.map((s) => ({ meetingId, startsAt: s.startsAt, durationMin: s.durationMin })));
  }

  async listSlots(meetingId: string): Promise<DateSlotRow[]> {
    return this.db.select().from(dateSlots).where(eq(dateSlots.meetingId, meetingId)).orderBy(asc(dateSlots.startsAt));
  }

  async deleteSlot(meetingId: string, slotId: number): Promise<void> {
    await this.db.delete(dateSlots).where(and(eq(dateSlots.meetingId, meetingId), eq(dateSlots.id, slotId)));
  }

  async setVote(slotId: number, userId: string, answer: RsvpStatus): Promise<void> {
    await this.db
      .insert(dateVotes)
      .values({ slotId, userId, answer })
      .onConflictDoUpdate({ target: [dateVotes.slotId, dateVotes.userId], set: { answer, updatedAt: new Date() } });
  }

  async listVotes(meetingId: string): Promise<Array<{ slotId: number; userId: string; answer: RsvpStatus }>> {
    return this.db
      .select({ slotId: dateVotes.slotId, userId: dateVotes.userId, answer: dateVotes.answer })
      .from(dateVotes)
      .innerJoin(dateSlots, eq(dateSlots.id, dateVotes.slotId))
      .where(eq(dateSlots.meetingId, meetingId));
  }

  async deleteRsvp(meetingId: string, userId: string): Promise<void> {
    await this.db.delete(rsvps).where(and(eq(rsvps.meetingId, meetingId), eq(rsvps.userId, userId)));
  }

  async setRsvp(meetingId: string, userId: string, status: RsvpStatus): Promise<void> {
    await this.db
      .insert(rsvps)
      .values({ meetingId, userId, status })
      .onConflictDoUpdate({ target: [rsvps.meetingId, rsvps.userId], set: { status, updatedAt: new Date() } });
  }

  async listRsvps(meetingId: string): Promise<RsvpRow[]> {
    return this.db.select().from(rsvps).where(eq(rsvps.meetingId, meetingId));
  }

  // ---------------------------------------------------------------- agenda

  async listAgenda(meetingId: string): Promise<AgendaItemRow[]> {
    return this.db
      .select()
      .from(agendaItems)
      .where(eq(agendaItems.meetingId, meetingId))
      .orderBy(asc(agendaItems.position), asc(agendaItems.id));
  }

  /**
   * Ajoute un point en fin de liste. Le verrou sur la réunion sérialise les ajouts concurrents
   * (position et limite de taille cohérentes). `prepare` reçoit le nombre de points actuel et
   * l'état de verrouillage, renvoie le point validé à insérer, ou lève une erreur pour refuser.
   */
  async addAgendaItem(
    meetingId: string,
    authorId: string,
    prepare: (count: number, locked: boolean) => { title: string; detail: string },
  ): Promise<AgendaItemRow> {
    return this.db.transaction(async (tx) => {
      const [meeting] = await tx
        .select({ locked: meetings.agendaLocked })
        .from(meetings)
        .where(eq(meetings.id, meetingId))
        .for('update');
      if (!meeting) throw new Error(`Réunion ${meetingId} introuvable`);
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(agendaItems)
        .where(eq(agendaItems.meetingId, meetingId));
      const item = prepare(count, meeting.locked);
      const [row] = await tx
        .insert(agendaItems)
        .values({ meetingId, position: count, authorId, ...item })
        .returning();
      return row!;
    });
  }

  async updateAgendaItem(meetingId: string, itemId: number, patch: { title: string; detail: string }): Promise<boolean> {
    const rows = await this.db
      .update(agendaItems)
      .set(patch)
      .where(and(eq(agendaItems.meetingId, meetingId), eq(agendaItems.id, itemId)))
      .returning({ id: agendaItems.id });
    return rows.length > 0;
  }

  /** Applique un nouvel ordre (liste complète des ids) et retire les points absents de la liste. */
  async reorderAgenda(meetingId: string, orderedIds: readonly number[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.select({ id: meetings.id }).from(meetings).where(eq(meetings.id, meetingId)).for('update');
      const current = await tx.select({ id: agendaItems.id }).from(agendaItems).where(eq(agendaItems.meetingId, meetingId));
      const keep = new Set(orderedIds);
      const removed = current.map((r) => r.id).filter((id) => !keep.has(id));
      if (removed.length > 0) {
        await tx.delete(agendaItems).where(and(eq(agendaItems.meetingId, meetingId), inArray(agendaItems.id, removed)));
      }
      for (const { id, position } of reindex(orderedIds)) {
        await tx
          .update(agendaItems)
          .set({ position })
          .where(and(eq(agendaItems.meetingId, meetingId), eq(agendaItems.id, id)));
      }
    });
  }

  async copyAgenda(fromMeetingId: string, toMeetingId: string): Promise<void> {
    const items = await this.listAgenda(fromMeetingId);
    if (items.length === 0) return;
    await this.db.insert(agendaItems).values(
      items.map((i, position) => ({ meetingId: toMeetingId, position, title: i.title, detail: i.detail, authorId: i.authorId })),
    );
  }

  // ---------------------------------------------------------------- scheduled_jobs

  /**
   * Remplace les échéances en attente d'une réunion par `planned` (réarme aussi celles déjà
   * exécutées). Une échéance en cours d'exécution (réservée par le scheduler) est conservée :
   * c'est souvent elle qui déclenche la replanification (passage « En cours »).
   */
  async replaceJobs(meetingId: string, planned: readonly PlannedJob[]): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .delete(scheduledJobs)
        .where(
          and(
            eq(scheduledJobs.meetingId, meetingId),
            isNull(scheduledJobs.doneAt),
            or(isNull(scheduledJobs.lockedUntil), lt(scheduledJobs.lockedUntil, now)),
          ),
        );
      if (planned.length === 0) return;
      await tx
        .insert(scheduledJobs)
        .values(planned.map((j) => ({ meetingId, kind: j.kind, offsetMin: j.offsetMin, dueAt: j.dueAt })))
        .onConflictDoUpdate({
          target: [scheduledJobs.meetingId, scheduledJobs.kind, scheduledJobs.offsetMin],
          set: { dueAt: sql`excluded.due_at`, doneAt: null, attempts: 0, lockedUntil: null, retryAt: null, lastError: null },
        });
    });
  }

  async cancelPendingJobs(meetingId: string): Promise<void> {
    await this.db.delete(scheduledJobs).where(and(eq(scheduledJobs.meetingId, meetingId), isNull(scheduledJobs.doneAt)));
  }

  /**
   * Réserve les échéances dues (bail de `leaseSec` secondes). `SKIP LOCKED` rend la réservation
   * sûre même si deux instances tournaient par erreur en parallèle.
   */
  async claimDueJobs(now: Date, limit: number, maxAttempts: number, leaseSec = 120): Promise<ScheduledJobRow[]> {
    const result = await this.db.execute<{ id: number }>(sql`
      update ${scheduledJobs}
         set locked_until = ${new Date(now.getTime() + leaseSec * 1000)}, attempts = attempts + 1
       where id in (
         select id from ${scheduledJobs}
          where done_at is null and due_at <= ${now} and attempts < ${maxAttempts}
            and (locked_until is null or locked_until < ${now})
            and (retry_at is null or retry_at <= ${now})
          order by due_at
          limit ${limit}
          for update skip locked)
      returning id`);
    const ids = result.rows.map((r) => r.id);
    if (ids.length === 0) return [];
    return this.db.select().from(scheduledJobs).where(inArray(scheduledJobs.id, ids)).orderBy(asc(scheduledJobs.dueAt));
  }

  async completeJob(id: number): Promise<void> {
    await this.db.update(scheduledJobs).set({ doneAt: new Date(), lockedUntil: null }).where(eq(scheduledJobs.id, id));
  }

  /** Échec : nouvelle tentative après un backoff exponentiel (1, 2, 4… min). */
  async failJob(job: ScheduledJobRow, error: string, now: Date): Promise<void> {
    const backoffMs = 60_000 * 2 ** Math.max(0, job.attempts - 1);
    await this.db
      .update(scheduledJobs)
      .set({ lastError: error.slice(0, 2000), lockedUntil: null, retryAt: new Date(now.getTime() + backoffMs) })
      .where(eq(scheduledJobs.id, job.id));
  }

  // ---------------------------------------------------------------- recordings

  async insertRecording(values: typeof recordings.$inferInsert): Promise<RecordingRow> {
    const [row] = await this.db.insert(recordings).values(values).returning();
    return row!;
  }

  async updateRecording(id: string, patch: Partial<typeof recordings.$inferInsert>): Promise<void> {
    await this.db.update(recordings).set(patch).where(eq(recordings.id, id));
  }

  async getRecording(id: string): Promise<RecordingRow | undefined> {
    const [row] = await this.db.select().from(recordings).where(eq(recordings.id, id));
    return row;
  }

  async getActiveRecording(meetingId: string): Promise<RecordingRow | undefined> {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(and(eq(recordings.meetingId, meetingId), eq(recordings.status, 'recording')));
    return row;
  }

  async listRecordingsByStatus(status: RecordingRow['status']): Promise<RecordingRow[]> {
    return this.db.select().from(recordings).where(eq(recordings.status, status));
  }

  async insertPresence(values: typeof recordingPresence.$inferInsert): Promise<void> {
    await this.db.insert(recordingPresence).values(values);
  }

  /** Clôt le passage en cours d'un participant (ou de tous si `userId` est omis). */
  async closePresence(recordingId: string, at: Date, userId?: string): Promise<void> {
    await this.db
      .update(recordingPresence)
      .set({ leftAt: at })
      .where(
        and(
          eq(recordingPresence.recordingId, recordingId),
          isNull(recordingPresence.leftAt),
          userId ? eq(recordingPresence.userId, userId) : undefined,
        ),
      );
  }

  async listPresence(recordingId: string): Promise<RecordingPresenceRow[]> {
    return this.db.select().from(recordingPresence).where(eq(recordingPresence.recordingId, recordingId)).orderBy(asc(recordingPresence.joinedAt));
  }

  async insertSegment(values: typeof audioSegments.$inferInsert): Promise<void> {
    await this.db.insert(audioSegments).values(values);
  }

  async listSegments(recordingId: string): Promise<AudioSegmentRow[]> {
    return this.db
      .select()
      .from(audioSegments)
      .where(eq(audioSegments.recordingId, recordingId))
      .orderBy(asc(audioSegments.userId), asc(audioSegments.startMs));
  }

  async listRecordingsForMeeting(meetingId: string): Promise<RecordingRow[]> {
    return this.db.select().from(recordings).where(eq(recordings.meetingId, meetingId)).orderBy(asc(recordings.startedAt));
  }

  /** Dernier nom affiché connu de chaque participant enregistré (pour la transcription). */
  async displayNamesForMeeting(meetingId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .select({ userId: recordingPresence.userId, name: recordingPresence.displayName })
      .from(recordingPresence)
      .innerJoin(recordings, eq(recordings.id, recordingPresence.recordingId))
      .where(eq(recordings.meetingId, meetingId))
      .orderBy(asc(recordingPresence.joinedAt));
    return new Map(rows.map((r) => [r.userId, r.name]));
  }

  // ---------------------------------------------------------------- pipeline

  /** Crée les étapes manquantes (en attente) ; les étapes existantes ne sont pas touchées. */
  async ensurePipeline(meetingId: string): Promise<void> {
    await this.db
      .insert(pipelineSteps)
      .values(PIPELINE_STEPS.map((step) => ({ meetingId, step })))
      .onConflictDoNothing();
  }

  async listPipeline(meetingId: string): Promise<PipelineStepRow[]> {
    const rows = await this.db.select().from(pipelineSteps).where(eq(pipelineSteps.meetingId, meetingId));
    return rows.sort((a, b) => PIPELINE_STEPS.indexOf(a.step) - PIPELINE_STEPS.indexOf(b.step));
  }

  async updateStep(meetingId: string, step: PipelineStep, patch: Partial<typeof pipelineSteps.$inferInsert>): Promise<void> {
    await this.db
      .update(pipelineSteps)
      .set(patch)
      .where(and(eq(pipelineSteps.meetingId, meetingId), eq(pipelineSteps.step, step)));
  }

  /** Remet en attente les étapes données (relance). */
  async resetSteps(meetingId: string, steps: readonly PipelineStep[]): Promise<void> {
    if (steps.length === 0) return;
    await this.db
      .update(pipelineSteps)
      .set({ status: 'pending', error: null, startedAt: null, finishedAt: null })
      .where(and(eq(pipelineSteps.meetingId, meetingId), inArray(pipelineSteps.step, [...steps])));
  }

  /** Réunions dont le traitement n'est pas terminé (reprise au démarrage). */
  /** Réunions closes avec un enregistrement mais sans compte rendu lancé (arrêt du bot juste après la clôture). */
  async listEndedWithoutPipeline(): Promise<string[]> {
    const rows = await this.db
      .select({ id: meetings.id })
      .from(meetings)
      .where(
        and(
          eq(meetings.status, 'ended'),
          sql`exists (select 1 from ${recordings} where ${recordings.meetingId} = ${meetings.id})`,
          sql`not exists (select 1 from ${pipelineSteps} where ${pipelineSteps.meetingId} = ${meetings.id})`,
        ),
      );
    return rows.map((r) => r.id);
  }

  /** Liens publiés d'une réunion : compte rendu et audio complet (null tant qu'ils n'existent pas). */
  async publishedLinks(meetingId: string): Promise<{ report: string | null; audio: string | null }> {
    const rows = await this.listPipeline(meetingId);
    const url = (step: string) => {
      const row = rows.find((r) => r.step === step && r.status === 'done');
      return typeof row?.output?.url === 'string' && row.output.url ? row.output.url : null;
    };
    // Compte rendu provisoire (transcription publiée avant le résumé) : même message, même lien.
    return { report: url('publish') ?? url('preview'), audio: url('mix') };
  }

  /** Derniers comptes rendus publiés d'un serveur (post épinglé). */
  async listRecentReports(guildId: string, limit: number): Promise<Array<{ title: string; startsAt: Date; url: string }>> {
    const rows = await this.db
      .select({ id: meetings.id, title: meetings.title, startsAt: meetings.startsAt, step: pipelineSteps.step, output: pipelineSteps.output })
      .from(pipelineSteps)
      .innerJoin(meetings, eq(meetings.id, pipelineSteps.meetingId))
      // Post supprimé à la main (threadId vidé) : plus de lien vers ce compte rendu. Compte rendu
      // provisoire (transcription publiée, résumé en préparation) compris.
      .where(and(eq(meetings.guildId, guildId), isNotNull(meetings.threadId), inArray(pipelineSteps.step, ['publish', 'preview']), eq(pipelineSteps.status, 'done')))
      .orderBy(sql`${meetings.startsAt} desc`)
      .limit(limit * 2);
    const byMeeting = new Map<string, { title: string; startsAt: Date; url: string; final: boolean }>();
    for (const r of rows) {
      if (typeof r.output?.url !== 'string' || !r.output.url) continue;
      const known = byMeeting.get(r.id);
      if (!known || (!known.final && r.step === 'publish')) byMeeting.set(r.id, { title: r.title, startsAt: r.startsAt, url: r.output.url, final: r.step === 'publish' });
    }
    return [...byMeeting.values()].slice(0, limit).map(({ title, startsAt, url }) => ({ title, startsAt, url }));
  }

  /** Ajoute une personne à prévenir à la prochaine publication du compte rendu (sans doublon). */
  async addReportRequester(meetingId: string, userId: string): Promise<void> {
    await this.db
      .update(meetings)
      .set({ reportRequesters: sql`array_append(array_remove(${meetings.reportRequesters}, ${userId}), ${userId})` })
      .where(eq(meetings.id, meetingId));
  }

  /** Personnes à prévenir, retirées de la liste (une seule notification). */
  async takeReportRequesters(meetingId: string): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select({ ids: meetings.reportRequesters }).from(meetings).where(eq(meetings.id, meetingId)).for('update');
      if (!row || row.ids.length === 0) return [];
      await tx.update(meetings).set({ reportRequesters: [] }).where(eq(meetings.id, meetingId));
      return row.ids;
    });
  }

  async listUnfinishedPipelines(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ meetingId: pipelineSteps.meetingId })
      .from(pipelineSteps)
      .where(inArray(pipelineSteps.status, ['pending', 'running']));
    return rows.map((r) => r.meetingId);
  }

  // ---------------------------------------------------------------- transcription

  /** Enregistre les blocs (idempotent : un bloc existant n'est pas recréé) et renvoie tous ceux de la réunion. */
  /**
   * Aligne les blocs des sessions `recordingIds` sur ceux calculés : un bloc dont les prises de
   * parole ont changé (session encore en cours lors d'un traitement précédent, réglage de
   * regroupement modifié) est remis à transcrire, un bloc disparu est supprimé avec son texte.
   * Les blocs des autres sessions (purgées, par exemple) ne sont pas touchés.
   */
  async syncBlocks(
    meetingId: string,
    recordingIds: readonly string[],
    blocks: ReadonlyArray<Omit<typeof transcriptionBlocks.$inferInsert, 'meetingId'>>,
  ): Promise<TranscriptionBlockRow[]> {
    await this.db.transaction(async (tx) => {
      const existing = recordingIds.length
        ? await tx
            .select()
            .from(transcriptionBlocks)
            .where(and(eq(transcriptionBlocks.meetingId, meetingId), inArray(transcriptionBlocks.recordingId, [...recordingIds])))
        : [];
      const key = (b: { recordingId: string; userId: string; startMs: number }) => `${b.recordingId}|${b.userId}|${b.startMs}`;
      const byKey = new Map(existing.map((b) => [key(b), b]));
      const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id, i) => id === b[i]);
      const fresh = [];
      for (const b of blocks) {
        const old = byKey.get(key(b));
        byKey.delete(key(b));
        if (!old) fresh.push({ ...b, meetingId });
        else if (old.endMs !== b.endMs || !sameIds(old.segmentIds, b.segmentIds)) {
          await tx.delete(transcriptSegments).where(eq(transcriptSegments.blockId, old.id));
          await tx.update(transcriptionBlocks).set({ endMs: b.endMs, segmentIds: b.segmentIds, done: false, backend: null, model: null }).where(eq(transcriptionBlocks.id, old.id));
        }
      }
      const gone = [...byKey.values()].map((b) => b.id);
      if (gone.length) await tx.delete(transcriptionBlocks).where(inArray(transcriptionBlocks.id, gone)); // texte supprimé en cascade
      if (fresh.length) await tx.insert(transcriptionBlocks).values(fresh);
    });
    return this.listBlocks(meetingId);
  }

  async listBlocks(meetingId: string): Promise<TranscriptionBlockRow[]> {
    return this.db.select().from(transcriptionBlocks).where(eq(transcriptionBlocks.meetingId, meetingId)).orderBy(asc(transcriptionBlocks.startMs));
  }

  async segmentsByIds(ids: readonly number[]) {
    if (ids.length === 0) return [];
    return this.db.select().from(audioSegments).where(inArray(audioSegments.id, [...ids])).orderBy(asc(audioSegments.startMs));
  }

  /** Enregistre le texte d'un bloc et le marque traité (transaction : pas de bloc à moitié écrit). */
  async completeBlock(blockId: number, meetingId: string, lines: ReadonlyArray<Omit<typeof transcriptSegments.$inferInsert, 'meetingId' | 'blockId'>>, backend: string, model: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(transcriptSegments).where(eq(transcriptSegments.blockId, blockId));
      if (lines.length > 0) await tx.insert(transcriptSegments).values(lines.map((l) => ({ ...l, meetingId, blockId })));
      await tx.update(transcriptionBlocks).set({ done: true, backend, model }).where(eq(transcriptionBlocks.id, blockId));
    });
  }

  /** Oublie la transcription d'une réunion (retranscription complète). */
  async resetTranscription(meetingId: string): Promise<void> {
    await this.db.delete(transcriptionBlocks).where(eq(transcriptionBlocks.meetingId, meetingId));
  }

  async listTranscript(meetingId: string): Promise<TranscriptSegmentRow[]> {
    return this.db.select().from(transcriptSegments).where(eq(transcriptSegments.meetingId, meetingId)).orderBy(asc(transcriptSegments.startAt));
  }

  async saveSummary(values: typeof summaries.$inferInsert): Promise<void> {
    const { meetingId, ...rest } = values;
    await this.db.insert(summaries).values(values).onConflictDoUpdate({ target: summaries.meetingId, set: { ...rest, createdAt: new Date() } });
  }

  /** Ajoute une consigne de correction ; faux s'il n'y a pas encore de résumé. */
  async addCorrection(meetingId: string, correction: string): Promise<boolean> {
    const rows = await this.db
      .update(summaries)
      .set({ corrections: sql`array_append(${summaries.corrections}, ${correction})` })
      .where(eq(summaries.meetingId, meetingId))
      .returning({ id: summaries.meetingId });
    return rows.length > 0;
  }

  async getSummary(meetingId: string): Promise<SummaryRow | undefined> {
    const [row] = await this.db.select().from(summaries).where(eq(summaries.meetingId, meetingId));
    return row;
  }

  // ---------------------------------------------------------------- serveurs de transcription

  // ---------------------------------------------------------------- repères en direct

  async addMarker(values: Omit<typeof meetingMarkers.$inferInsert, 'id' | 'createdAt'>): Promise<MeetingMarkerRow> {
    const [row] = await this.db.insert(meetingMarkers).values(values).returning();
    return row!;
  }

  async listMarkers(meetingId: string): Promise<MeetingMarkerRow[]> {
    return this.db.select().from(meetingMarkers).where(eq(meetingMarkers.meetingId, meetingId)).orderBy(asc(meetingMarkers.at), asc(meetingMarkers.id));
  }

  // ---------------------------------------------------------------- stockage du serveur

  async getStorage(guildId: string): Promise<GuildStorageRow | undefined> {
    const [row] = await this.db.select().from(guildStorage).where(eq(guildStorage.guildId, guildId));
    return row;
  }

  /** Connexion (ou reconnexion) : remplace le stockage précédent, garde le dossier choisi. */
  async setStorage(values: Pick<GuildStorageRow, 'guildId' | 'provider' | 'credentials' | 'account' | 'connectedBy'>): Promise<GuildStorageRow> {
    const fresh = { ...values, connectedAt: new Date(), rootId: null, rootUrl: null, lastOkAt: null, lastError: null };
    const [row] = await this.db.insert(guildStorage).values(fresh).onConflictDoUpdate({ target: guildStorage.guildId, set: fresh }).returning();
    return row!;
  }

  async updateStorage(guildId: string, patch: Partial<Pick<GuildStorageRow, 'credentials' | 'folder' | 'rootId' | 'rootUrl' | 'lastOkAt' | 'lastError'>>): Promise<void> {
    await this.db.update(guildStorage).set(patch).where(eq(guildStorage.guildId, guildId));
  }

  async removeStorage(guildId: string): Promise<void> {
    await this.db.delete(guildStorage).where(eq(guildStorage.guildId, guildId));
  }

  // ---------------------------------------------------------------- serveurs de résumé

  async listLlmBackends(guildId: string): Promise<LlmBackendRow[]> {
    return this.db.select().from(llmBackends).where(eq(llmBackends.guildId, guildId)).orderBy(asc(llmBackends.position), asc(llmBackends.id));
  }

  /** Ajoute en fin de liste (priorité la plus basse) et renvoie le serveur créé. */
  async addLlmBackend(values: Omit<typeof llmBackends.$inferInsert, 'position' | 'id' | 'createdAt'>): Promise<LlmBackendRow> {
    return this.db.transaction(async (tx) => {
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(llmBackends).where(eq(llmBackends.guildId, values.guildId));
      const [row] = await tx.insert(llmBackends).values({ ...values, position: n }).returning();
      return row!;
    });
  }

  async updateLlmBackend(guildId: string, id: number, patch: Partial<typeof llmBackends.$inferInsert>): Promise<void> {
    await this.db.update(llmBackends).set(patch).where(and(eq(llmBackends.guildId, guildId), eq(llmBackends.id, id)));
  }

  /** Retire un serveur et recompacte les priorités. */
  async removeLlmBackend(guildId: string, id: number): Promise<void> {
    await this.db.delete(llmBackends).where(and(eq(llmBackends.guildId, guildId), eq(llmBackends.id, id)));
    await this.reorderLlmBackends(guildId, (await this.listLlmBackends(guildId)).map((b) => b.id));
  }

  /** Applique un ordre de priorité (liste complète des ids). */
  async reorderLlmBackends(guildId: string, ids: readonly number[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const [position, id] of ids.entries()) await tx.update(llmBackends).set({ position }).where(and(eq(llmBackends.guildId, guildId), eq(llmBackends.id, id)));
    });
  }

  async listBackends(guildId: string): Promise<TranscriptionBackendRow[]> {
    return this.db.select().from(transcriptionBackends).where(eq(transcriptionBackends.guildId, guildId)).orderBy(asc(transcriptionBackends.position));
  }

  /** Ajoute en fin de liste (priorité la plus basse). */
  async addBackend(values: Omit<typeof transcriptionBackends.$inferInsert, 'position' | 'id' | 'createdAt'>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transcriptionBackends)
        .where(eq(transcriptionBackends.guildId, values.guildId));
      await tx.insert(transcriptionBackends).values({ ...values, position: n });
    });
  }

  async updateBackend(guildId: string, name: string, patch: Partial<typeof transcriptionBackends.$inferInsert>): Promise<boolean> {
    const rows = await this.db
      .update(transcriptionBackends)
      .set(patch)
      .where(and(eq(transcriptionBackends.guildId, guildId), eq(transcriptionBackends.name, name)))
      .returning({ id: transcriptionBackends.id });
    return rows.length > 0;
  }

  /** Retire un serveur et recompacte les priorités. */
  async removeBackend(guildId: string, name: string): Promise<boolean> {
    const remaining = (await this.listBackends(guildId)).filter((b) => b.name !== name);
    const deleted = await this.db
      .delete(transcriptionBackends)
      .where(and(eq(transcriptionBackends.guildId, guildId), eq(transcriptionBackends.name, name)))
      .returning({ id: transcriptionBackends.id });
    await this.reorderBackends(guildId, remaining.map((b) => b.name));
    return deleted.length > 0;
  }

  /** Applique un ordre de priorité (liste complète des noms). */
  async reorderBackends(guildId: string, names: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const [position, name] of names.entries()) {
        await tx
          .update(transcriptionBackends)
          .set({ position })
          .where(and(eq(transcriptionBackends.guildId, guildId), eq(transcriptionBackends.name, name)));
      }
    });
  }

  async getBackend(guildId: string, id: number): Promise<TranscriptionBackendRow | undefined> {
    const [row] = await this.db
      .select()
      .from(transcriptionBackends)
      .where(and(eq(transcriptionBackends.guildId, guildId), eq(transcriptionBackends.id, id)));
    return row;
  }

  // ---------------------------------------------------------------- rétention

  /** Sessions terminées et non purgées, avec ce qu'il faut pour décider de la purge. */
  async listRawPurgeCandidates() {
    const recs = await this.db
      .select({
        recordingId: recordings.id,
        meetingId: recordings.meetingId,
        guildId: recordings.guildId,
        dataDir: recordings.dataDir,
        endedAt: recordings.endedAt,
        purgedAt: recordings.purgedAt,
        meetingStatus: meetings.status,
      })
      .from(recordings)
      .innerJoin(meetings, eq(meetings.id, recordings.meetingId))
      .where(and(isNull(recordings.purgedAt), isNotNull(recordings.endedAt)));
    if (recs.length === 0) return [];
    // Statuts des étapes et présence de parole en deux requêtes, pas deux par session.
    const steps = await this.db
      .select({ meetingId: pipelineSteps.meetingId, step: pipelineSteps.step, status: pipelineSteps.status })
      .from(pipelineSteps)
      .where(and(inArray(pipelineSteps.meetingId, [...new Set(recs.map((r) => r.meetingId))]), inArray(pipelineSteps.step, ['mix', 'transcribe'])));
    const withSpeech = new Set(
      (
        await this.db
          .selectDistinct({ id: audioSegments.recordingId })
          .from(audioSegments)
          .where(inArray(audioSegments.recordingId, recs.map((r) => r.recordingId)))
      ).map((r) => r.id),
    );
    const statusOf = (meetingId: string, step: string) => steps.find((s) => s.meetingId === meetingId && s.step === step)?.status ?? null;
    return recs.map((r) => ({ ...r, mix: statusOf(r.meetingId, 'mix'), transcribe: statusOf(r.meetingId, 'transcribe'), hasSegments: withSpeech.has(r.recordingId) }));
  }

  /** Au moins une prise de parole enregistrée pour la réunion. */
  async hasSpeech(meetingId: string): Promise<boolean> {
    const rows = await this.db.execute(
      sql`select exists (select 1 from ${audioSegments} s join ${recordings} r on r.id = s.recording_id where r.meeting_id = ${meetingId}) as found`,
    );
    return (rows.rows[0] as { found?: boolean } | undefined)?.found === true;
  }

  async markRecordingPurged(id: string, at: Date): Promise<void> {
    await this.db.update(recordings).set({ purgedAt: at }).where(eq(recordings.id, id));
  }

  /** Étapes « mix » terminées (audio complet local), avec le serveur de la réunion. */
  async listMixOutputs() {
    return this.db
      .select({ meetingId: pipelineSteps.meetingId, guildId: meetings.guildId, meetingStatus: meetings.status, finishedAt: pipelineSteps.finishedAt, output: pipelineSteps.output })
      .from(pipelineSteps)
      .innerJoin(meetings, eq(meetings.id, pipelineSteps.meetingId))
      .where(and(eq(pipelineSteps.step, 'mix'), eq(pipelineSteps.status, 'done')));
  }

  /**
   * Mix sans perte d'une réunion terminée : il ne sert qu'à ajouter de nouvelles sessions, et
   * pèse ~17 fois l'audio Opus. Retiré du résultat une fois la réunion close ; renvoie son chemin, à supprimer.
   */
  async dropMixMaster(meetingId: string): Promise<string | null> {
    const row = (await this.listPipeline(meetingId)).find((r) => r.step === 'mix' && r.status === 'done');
    const master = row?.output?.master;
    if (typeof master !== 'string') return null;
    await this.updateStep(meetingId, 'mix', { output: { ...row!.output, master: null } });
    return master;
  }

  async markMixPurged(meetingId: string, output: Record<string, unknown>, at: Date): Promise<void> {
    await this.updateStep(meetingId, 'mix', { output: { ...output, purgedAt: at.toISOString() } });
  }

  async saveCaptureStats(recordingId: string, rows: ReadonlyArray<{ userId: string; receivedPackets: number; writtenPackets: number; streamErrors: number }>): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insert(captureStats)
      .values(rows.map((r) => ({ recordingId, ...r })))
      .onConflictDoNothing();
  }

  async listCaptureStats(recordingId: string) {
    return this.db.select().from(captureStats).where(eq(captureStats.recordingId, recordingId));
  }

  // ---------------------------------------------------------------- refus d'enregistrement

  async listOptouts(guildId: string): Promise<string[]> {
    const rows = await this.db.select({ userId: recordingOptouts.userId }).from(recordingOptouts).where(eq(recordingOptouts.guildId, guildId)).orderBy(asc(recordingOptouts.createdAt));
    return rows.map((r) => r.userId);
  }

  async setOptout(guildId: string, userId: string, refused: boolean): Promise<void> {
    if (refused) await this.db.insert(recordingOptouts).values({ guildId, userId }).onConflictDoNothing();
    else await this.db.delete(recordingOptouts).where(and(eq(recordingOptouts.guildId, guildId), eq(recordingOptouts.userId, userId)));
  }
}
