import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase } from './helpers/db.js';
import { createDb, runMigrations, type Db } from '../src/db/client.js';
import { Repositories } from '../src/db/repositories.js';
import { planJobs } from '../src/domain/reminders.js';

/**
 * Tests d'intégration sur un vrai PostgreSQL (ignorés sans TEST_DATABASE_URL) :
 *   docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=test postgres:17
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm test
 */
const url = process.env.TEST_DATABASE_URL;
const seed = { timezone: 'Europe/Paris', locale: 'fr' as const, reminderOffsetsMin: [1440, 15], defaultDurationMin: 60, autoRecordDefault: false };

describe.skipIf(!url)('Repositories (PostgreSQL)', () => {
  let db: Db;
  let pool: { end(): Promise<void>; query(sql: string): Promise<{ rows: Array<{ n: number }> }> };
  let repos: Repositories;

  beforeAll(async () => {
    ({ db, pool } = createDb(await freshDatabase(url!, 'repos')));
    await runMigrations(db);
    repos = new Repositories(db);
  });
  afterAll(async () => pool?.end());

  const newMeeting = (startsAt = new Date(Date.now() + 3 * 86_400_000)) =>
    repos.insertMeeting({ guildId: 'g', organizerId: 'o', title: 'T', startsAt, durationMin: 60, voiceChannelId: 'v' });

  it('crée les réglages à partir du seed une seule fois', async () => {
    const s1 = await repos.getSettings('g', seed);
    await repos.updateSettings('g', { timezone: 'Europe/Brussels' });
    const s2 = await repos.getSettings('g', seed);
    expect(s1.reminderOffsetsMin).toEqual([1440, 15]);
    expect(s2.timezone).toBe('Europe/Brussels');
  });

  it('derniers comptes rendus : sans ceux dont le post a été supprimé ; posts à vérifier au démarrage', async () => {
    const make = async (title: string, threadId: string | null, status: 'ended' | 'scheduled', endedDaysAgo = 1) => {
      const mt = await repos.insertMeeting({ guildId: 'rr', organizerId: 'o', title, startsAt: new Date('2026-10-01T16:00:00Z'), durationMin: 60, voiceChannelId: 'v' });
      await repos.updateMeeting(mt.id, { threadId, status, endedAt: status === 'ended' ? new Date(Date.now() - endedDaysAgo * 86_400_000) : null });
      await repos.ensurePipeline(mt.id);
      await repos.updateStep(mt.id, 'publish', { status: 'done', output: { url: `https://discord.com/x/${title}` } });
      return mt;
    };
    await make('gardé', 't1', 'ended');
    await make('post supprimé', null, 'ended');
    await make('ancien', 't3', 'ended', 60);
    await make('à venir', 't4', 'scheduled');
    expect((await repos.listRecentReports('rr', 10)).map((r) => r.title).sort()).toEqual(['ancien', 'gardé', 'à venir']);
    expect((await repos.listMeetingsWithThread(30)).filter((x) => x.guildId === 'rr').map((x) => x.title).sort()).toEqual(['gardé', 'à venir']);
  });

  it('transition conditionnelle', async () => {
    const m = await newMeeting();
    expect(await repos.transitionMeeting(m.id, ['scheduled'], 'live')).toMatchObject({ status: 'live' });
    expect(await repos.transitionMeeting(m.id, ['scheduled'], 'live')).toBeUndefined();
  });

  it('RSVP : upsert', async () => {
    const m = await newMeeting();
    await repos.setRsvp(m.id, 'u', 'yes');
    await repos.setRsvp(m.id, 'u', 'no');
    expect((await repos.listRsvps(m.id)).map((r) => r.status)).toEqual(['no']);
  });

  it('ODJ : ajouts concurrents, réordonnancement, retrait', async () => {
    const m = await newMeeting();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => repos.addAgendaItem(m.id, 'a', () => ({ title: `P${i}`, detail: '' }))),
    );
    let items = await repos.listAgenda(m.id);
    expect(items.map((i) => i.position)).toEqual([0, 1, 2, 3, 4]);
    const ids = items.map((i) => i.id);
    await repos.reorderAgenda(m.id, [ids[4]!, ids[0]!, ids[2]!]); // retire ids[1] et ids[3]
    items = await repos.listAgenda(m.id);
    expect(items.map((i) => [i.id, i.position])).toEqual([
      [ids[4], 0],
      [ids[0], 1],
      [ids[2], 2],
    ]);
    await expect(
      repos.addAgendaItem(m.id, 'a', (count) => {
        if (count >= 3) throw new Error('plein');
        return { title: 'x', detail: '' };
      }),
    ).rejects.toThrow('plein');
  });

  it('échéances : réservation, exécution, replanification', async () => {
    const startsAt = new Date(Date.now() + 10 * 60_000);
    const m = await newMeeting(startsAt);
    const now = new Date();
    await repos.replaceJobs(m.id, planJobs({ startsAt, durationMin: 60, status: 'scheduled' }, [1440, 5], now));

    // Rien n'est dû maintenant ; dans 6 minutes, seul le rappel à 5 min l'est.
    expect((await repos.claimDueJobs(now, 10, 5)).filter((j) => j.meetingId === m.id)).toHaveLength(0);
    const later = new Date(now.getTime() + 6 * 60_000);
    const claimed = (await repos.claimDueJobs(later, 10, 5)).filter((j) => j.meetingId === m.id);
    expect(claimed.map((j) => [j.kind, j.offsetMin, j.attempts])).toEqual([['reminder', 5, 1]]);
    // Réservé : un second tick ne le reprend pas.
    expect((await repos.claimDueJobs(later, 10, 5)).filter((j) => j.meetingId === m.id)).toHaveLength(0);
    await repos.completeJob(claimed[0]!.id);

    // Replanification (réunion décalée d'un jour) : le rappel déjà envoyé est réarmé.
    const moved = new Date(startsAt.getTime() + 86_400_000);
    await repos.replaceJobs(m.id, planJobs({ startsAt: moved, durationMin: 60, status: 'scheduled' }, [5], now));
    const inADay = new Date(moved.getTime() - 4 * 60_000);
    const again = (await repos.claimDueJobs(inADay, 10, 5)).filter((j) => j.meetingId === m.id);
    expect(again.map((j) => j.kind)).toEqual(['reminder']);
  });

  it("replanifier pendant l'exécution conserve l'échéance en cours", async () => {
    const m = await newMeeting(new Date(Date.now() + 60_000));
    await repos.replaceJobs(m.id, [{ kind: 'start', offsetMin: 0, dueAt: new Date(Date.now() - 1000) }]);
    const [job] = (await repos.claimDueJobs(new Date(), 10, 5)).filter((j) => j.meetingId === m.id);
    // Le passage « En cours » replanifie (ici : une échéance quelconque à venir).
    await repos.replaceJobs(m.id, [{ kind: 'auto_end', offsetMin: 0, dueAt: new Date(Date.now() + 3_600_000) }]);
    await repos.completeJob(job!.id);
    const rows = await db.execute<{ kind: string; done: boolean }>(
      `select kind, done_at is not null as done from scheduled_jobs where meeting_id = '${m.id}' order by kind`,
    );
    // Tri par ordre de déclaration de l'enum : reminder, start, auto_end.
    expect(rows.rows).toEqual([
      { kind: 'start', done: true },
      { kind: 'auto_end', done: false },
    ]);
  });

  it('échec : backoff puis nouvelle tentative', async () => {
    const m = await newMeeting(new Date(Date.now() + 60_000));
    await repos.replaceJobs(m.id, [{ kind: 'start', offsetMin: 0, dueAt: new Date(Date.now() - 1000) }]);
    const now = new Date();
    const [job] = (await repos.claimDueJobs(now, 10, 5)).filter((j) => j.meetingId === m.id);
    await repos.failJob(job!, 'boom', now);
    expect((await repos.claimDueJobs(new Date(now.getTime() + 30_000), 10, 5)).filter((j) => j.meetingId === m.id)).toHaveLength(0);
    const retried = (await repos.claimDueJobs(new Date(now.getTime() + 61_000), 10, 5)).filter((j) => j.meetingId === m.id);
    expect(retried.map((j) => [j.attempts, j.lastError])).toEqual([[2, 'boom']]);
  });

  it('échec en attente de nouvelle tentative : supprimé si on retire ce rappel des réglages', async () => {
    const m = await newMeeting(new Date(Date.now() + 3_600_000));
    await repos.replaceJobs(m.id, [{ kind: 'reminder', offsetMin: 90, dueAt: new Date(Date.now() - 1000) }]);
    const now = new Date();
    const [job] = (await repos.claimDueJobs(now, 10, 5)).filter((j) => j.meetingId === m.id);
    await repos.failJob(job!, 'boom', now);
    await repos.replaceJobs(m.id, []); // délai de 90 min retiré de /config → Rappels
    const left = await pool.query(`select count(*)::int as n from scheduled_jobs where meeting_id = '${m.id}'`);
    expect(left.rows[0]?.n).toBe(0);
  });

  it('enregistrement : session active, présences, segments', async () => {
    const m = await newMeeting();
    const t0 = new Date('2026-10-15T16:00:00Z');
    const rec = await repos.insertRecording({ meetingId: m.id, guildId: 'g', voiceChannelId: 'v', startedAt: t0, dataDir: '/data/x' });
    expect((await repos.getActiveRecording(m.id))?.id).toBe(rec.id);

    await repos.insertPresence({ recordingId: rec.id, userId: 'a', displayName: 'A', joinedAt: t0 });
    await repos.insertPresence({ recordingId: rec.id, userId: 'b', displayName: 'B', joinedAt: t0, excluded: true });
    await repos.closePresence(rec.id, new Date('2026-10-15T16:10:00Z'), 'a');
    await repos.closePresence(rec.id, new Date('2026-10-15T16:30:00Z'));
    const presence = await repos.listPresence(rec.id);
    expect(presence.map((p) => [p.userId, p.leftAt?.toISOString(), p.excluded])).toEqual([
      ['a', '2026-10-15T16:10:00.000Z', false],
      ['b', '2026-10-15T16:30:00.000Z', true],
    ]);

    await repos.insertSegment({ recordingId: rec.id, userId: 'a', startMs: 5000, endMs: 7000, packets: 100, filePath: '/x/a/2.ogg' });
    await repos.insertSegment({ recordingId: rec.id, userId: 'a', startMs: 1000, endMs: 2000, packets: 50, filePath: '/x/a/1.ogg' });
    expect((await repos.listSegments(rec.id)).map((s) => s.startMs)).toEqual([1000, 5000]);

    await repos.updateRecording(rec.id, { status: 'stopped', endedAt: new Date() });
    expect(await repos.getActiveRecording(m.id)).toBeUndefined();
  });

  it('serveurs de transcription : ajout, priorité, retrait, et repli sur le YAML', async () => {
    const { effectiveBackends } = await import('../src/services/transcriptionBackends.js');
    const { buildConfig } = await import('../src/config/index.js');
    const config = buildConfig(
      { discord: { token: 'x' }, database: { url: 'postgres://a@b/c' }, defaults: { transcription: { backends: [{ name: 'yaml-vibe', type: 'vibe', url: 'http://y:8080' }] } } },
      {},
    );
    const g = 'guild-backends';
    expect(await effectiveBackends(repos, config, g)).toMatchObject({ source: 'yaml', backends: [{ name: 'yaml-vibe' }] });

    await repos.addBackend({ guildId: g, name: 'vibe-pc', type: 'vibe', url: 'http://pc:8080' });
    await repos.addBackend({ guildId: g, name: 'speaches', type: 'openai', url: 'http://s:8000/v1', model: 'large-v3', apiKey: 'k' });
    await repos.addBackend({ guildId: g, name: 'amd', type: 'vibe', url: 'http://amd:8080' });
    await repos.reorderBackends(g, ['amd', 'vibe-pc', 'speaches']);
    await repos.updateBackend(g, 'vibe-pc', { enabled: false });
    const eff = await effectiveBackends(repos, config, g);
    expect(eff.source).toBe('discord');
    expect(eff.backends.map((b) => b.name)).toEqual(['amd', 'speaches']); // désactivé ignoré
    expect(eff.backends[1]).toMatchObject({ type: 'openai', model: 'large-v3', apiKey: 'k' });

    await repos.removeBackend(g, 'amd');
    expect((await repos.listBackends(g)).map((r) => [r.name, r.position])).toEqual([
      ['vibe-pc', 0],
      ['speaches', 1],
    ]);
    await repos.removeBackend(g, 'vibe-pc');
    await repos.removeBackend(g, 'speaches');
    expect((await effectiveBackends(repos, config, g)).source).toBe('yaml');
  });

  it('corrections : cumulées, et conservées quand le résumé est régénéré', async () => {
    const m = await newMeeting();
    expect(await repos.addCorrection(m.id, 'x')).toBe(false); // pas encore de résumé
    const save = () =>
      repos.saveSummary({ meetingId: m.id, content: { overview: 'v', topics: [] }, llmModel: 'q', llmDeployments: [], transcriptionBackends: [], passes: 1 });
    await save();
    await repos.addCorrection(m.id, 'Pol et non Paul');
    await repos.addCorrection(m.id, 'Reporter à janvier');
    await save(); // régénération
    expect((await repos.getSummary(m.id))?.corrections).toEqual(['Pol et non Paul', 'Reporter à janvier']);
  });

  it('glossaire : ajout et mise à jour (casse et accents ignorés), modification sans doublon, suppression', async () => {
    const add = await repos.upsertGlossary('gg', [
      { term: 'Ram Strat', variants: ['ramstrat'], definition: 'éperonner.' },
      { term: 'Keg', variants: [], definition: 'tonneau.' },
    ], 'u1');
    expect(add).toEqual({ added: 2, updated: 0 });
    expect(await repos.upsertGlossary('gg', [{ term: 'kég', variants: [], definition: 'tonneau explosif.' }], 'u2')).toEqual({ added: 0, updated: 1 });
    const rows = await repos.listGlossary('gg');
    expect(rows.map((r) => [r.term, r.definition])).toEqual([
      ['kég', 'tonneau explosif.'],
      ['Ram Strat', 'éperonner.'],
    ]);
    const ram = rows.find((r) => r.term === 'Ram Strat')!;
    expect(await repos.updateGlossaryTerm('gg', ram.id, { term: 'KEG', variants: [], definition: 'x' }, 'u1')).toBe(false); // déjà pris
    expect(await repos.updateGlossaryTerm('gg', ram.id, { term: 'Ram strat', variants: ['rs'], definition: 'éperonner avec une chaloupe.' }, 'u1')).toBe(true);
    await repos.deleteGlossaryTerm('gg', rows[0]!.id);
    expect((await repos.listGlossary('gg')).map((r) => [r.term, r.variants])).toEqual([['Ram strat', ['rs']]]);
    expect(await repos.listGlossary('autre')).toEqual([]);
  });

  it('clés d’API en clair chiffrées au démarrage, une seule fois', async () => {
    await repos.getSettings('gk', { timezone: 'Europe/Paris', locale: 'fr', reminderOffsetsMin: [], defaultDurationMin: 60, autoRecordDefault: false });
    await repos.addBackend({ guildId: 'gk', name: 'srv', type: 'openai', url: 'http://s/v1', apiKey: 'k-clair' });
    const encrypt = (v: string) => `enc:v1:test:${v}`;
    expect(await repos.encryptPlaintextSecrets(encrypt)).toBeGreaterThanOrEqual(1);
    expect(await repos.encryptPlaintextSecrets(encrypt)).toBe(0);
    expect((await repos.listBackends('gk'))[0]!.apiKey).toBe('enc:v1:test:k-clair');
  });

  it('refus d’enregistrement : par serveur, idempotents', async () => {
    const { OptoutService } = await import('../src/services/optouts.js');
    const { pino } = await import('pino');
    const optouts = new OptoutService(repos, pino({ level: 'silent' }));
    await optouts.set('g1', 'u1', true);
    await optouts.set('g1', 'u1', true);
    await optouts.set('g2', 'u2', true);
    expect(await repos.listOptouts('g1')).toEqual(['u1']);
    expect(optouts.isOptedOut('g1', 'u1')).toBe(true);
    expect(optouts.isOptedOut('g1', 'u2')).toBe(false); // autre serveur
    await optouts.set('g1', 'u1', false);
    expect(optouts.isOptedOut('g1', 'u1')).toBe(false);
    expect(await repos.listOptouts('g1')).toEqual([]);
  });

  it('suppression en cascade', async () => {
    const m = await newMeeting();
    await repos.setRsvp(m.id, 'u', 'yes');
    await repos.deleteMeeting(m.id);
    expect(await repos.listRsvps(m.id)).toEqual([]);
  });
});
