import { ComponentType, type APIEmbed } from 'discord.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { GuildSettingsRow, MeetingRow } from '../src/db/schema.js';
import { renderPollPanel, renderSlotChoice } from '../src/discord/embeds/datePoll.js';
import { renderMeetingCard } from '../src/discord/embeds/meetingCard.js';
import { renderMeetingManager } from '../src/discord/embeds/meetingManager.js';
import { handleDatePoll } from '../src/discord/interactions/datePoll.js';
import { decode, encode, type Action } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';
import { UserError } from '../src/lib/errors.js';
import { fakeInteraction, spyObject } from './helpers/discordFakes.js';

const m = messages('fr');
const meetingId = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const meeting = {
  id: meetingId, guildId: 'g', threadId: 't', title: 'Bureau', description: '', status: 'polling', organizerId: 'organizer',
  startsAt: new Date('2026-10-20T16:00:00Z'), durationMin: 60, voiceChannelId: null, autoRecord: false, agendaLocked: false, pollClosesAt: new Date('2026-10-16T10:00:00Z'),
} as unknown as MeetingRow;
const slots = Array.from({ length: 10 }, (_, i) => ({
  slotId: i + 1,
  startsAt: new Date(Date.UTC(2026, 9, 20 + i, 16)),
  durationMin: 60,
  label: `Mar. ${20 + i}/10 · 18h00-19h00`,
  yes: Array.from({ length: 30 }, (_, k) => String(100000000000000000n + BigInt(k + i))),
  maybe: i === 3 ? ['200000000000000000'] : [],
  // Beaucoup de « pas disponible » aussi : la carte doit rester sous les limites de Discord.
  no: Array.from({ length: 30 }, (_, k) => String(300000000000000000n + BigInt(k + i))),
}));

const flatten = (node: unknown): Array<Record<string, unknown>> => {
  const n = node as { components?: unknown[]; accessory?: unknown };
  return [node as Record<string, unknown>, ...(n.components ?? []).flatMap(flatten), ...(n.accessory ? flatten(n.accessory) : [])];
};

describe('identifiants des actions du sondage', () => {
  it.each<Action>([
    { type: 'poll.create' },
    { type: 'poll.createSubmit' },
    { type: 'poll.createRetry' },
    { type: 'poll.answer', meetingId },
    { type: 'poll.vote', meetingId, slotId: 42 },
    { type: 'poll.fix', meetingId },
    { type: 'poll.fixSelect', meetingId },
    { type: 'poll.add', meetingId },
    { type: 'poll.addSubmit', meetingId },
    { type: 'poll.remove', meetingId },
    { type: 'poll.removeSelect', meetingId },
  ])('%j : aller-retour', (action) => {
    expect(decode(encode(action))).toEqual(action);
  });
});

describe('carte d’un sondage', () => {
  it('une ligne par créneau, meilleur créneau ⭐, boutons Répondre et Gérer, embed sous 6 000 caractères', () => {
    const card = renderMeetingCard(meeting, [], m, null, undefined, { slots, closesAt: meeting.pollClosesAt });
    const embed = card.embeds[0] as APIEmbed;
    expect(embed.fields?.slice(0, 10).map((f) => f.name.startsWith('⭐'))).toEqual([false, false, false, true, false, false, false, false, false, false]);
    expect(embed.fields?.[0]?.value).toMatch(/^✅ 30 · 🟡 0 · ❌ 30/);
    expect(embed.fields?.[0]?.value).toContain('❌ <@300000000000000000>');
    const size = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0) + (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(size).toBeLessThanOrEqual(6000);
    expect(embed.fields?.every((f) => f.value.length <= 1024)).toBe(true);
    const ids = card.components.flatMap((row) => row.components).map((c) => decode((c as { custom_id: string }).custom_id)?.type);
    expect(ids).toEqual(['poll.answer', 'meeting.manage']);
  });
});

describe('panneau de réponse', () => {
  it('10 créneaux : un menu chacun, réponse actuelle présélectionnée, sous la limite de 40 composants', () => {
    const panel = renderPollPanel(meeting, slots.map((s, i) => ({ id: s.slotId, label: s.label, answer: i === 0 ? 'maybe' : null })), m);
    const all = flatten(panel);
    expect(all.length).toBeLessThanOrEqual(40);
    const selects = all.filter((c) => c.type === ComponentType.StringSelect) as Array<{ custom_id: string; options: Array<{ value: string; default?: boolean; label: string }> }>;
    expect(selects).toHaveLength(10);
    expect(selects[0]!.options.find((o) => o.default)?.value).toBe('maybe');
    expect(selects[1]!.options.some((o) => o.default)).toBe(false);
    expect(selects[0]!.options[0]!.label).toContain('Mar. 20/10');
    expect(decode(selects[2]!.custom_id)).toEqual({ type: 'poll.vote', meetingId, slotId: 3 });
  });

  it('choix du créneau par l’organisateur : votes affichés', () => {
    const view = renderSlotChoice(meeting, [{ id: 7, label: 'Jeu. 22/10 · 18h00-19h00', yes: 4, maybe: 1, no: 0 }], 'fix', m);
    const select = flatten(view).find((c) => c.type === ComponentType.StringSelect) as { options: Array<{ value: string; description: string }> };
    expect(select.options[0]).toMatchObject({ value: '7', description: '✅ 4 · 🟡 1 · ❌ 0' });
  });

  it('⚙️ Gérer d’un sondage : fixer la date, ajouter, retirer, modifier, annuler', () => {
    const types = flatten(renderMeetingManager(meeting, { hasRecording: false }, m))
      .filter((c) => typeof c.custom_id === 'string')
      .map((c) => decode(c.custom_id as string)?.type);
    expect(types).toEqual(['poll.fix', 'poll.add', 'poll.remove', 'meeting.edit', 'meeting.organizer', 'meeting.cancel', 'meeting.roles', 'meeting.everyone', 'meeting.none']);
  });
});

function context(over: Partial<GuildSettingsRow> = {}) {
  const settings = { guildId: 'g', locale: 'fr', timezone: 'Europe/Paris', managerRoleIds: [], creatorsRestricted: false, voiceChannelId: null, autoVoice: false, forumChannelId: 'forum', defaultDurationMin: 60, ...over } as unknown as GuildSettingsRow;
  const repos = spyObject({
    getMeeting: async () => meeting,
    listSlots: async () => [{ id: 1, startsAt: new Date('2026-10-20T16:00:00Z'), durationMin: 60 }],
    listVotes: async () => [],
  });
  const ctx = {
    config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
    log: pino({ level: 'silent' }),
    settings: { get: async () => settings, messages: async () => m },
    client: { channels: { fetch: async () => ({ type: 15 }) } },
    repos,
    meetings: spyObject({ slotChoices: async () => [{ id: 1, label: 'Mar. 20/10 · 18h00-19h00', yes: 0, maybe: 0, no: 0, past: false }] }),
    cards: spyObject(),
  };
  return { ctx, repos };
}

describe('gestionnaires du sondage', () => {
  it('formulaire de création valide ; salon demandé seulement s’il est au choix', async () => {
    for (const [over, withVoice] of [[{}, true], [{ autoVoice: true }, false], [{ voiceChannelId: 'v' }, false]] as const) {
      const { ctx } = context(over);
      const { interaction, replies } = fakeInteraction({ kind: 'button' });
      await handleDatePoll(ctx as never, interaction as never, { type: 'poll.create' });
      const modal = (replies.find((r) => r.how === 'showModal')!.payload as { toJSON(): { components: Array<{ label: string }> } }).toJSON();
      expect(modal.components.some((c) => c.label === m.modal.voice)).toBe(withVoice);
    }
  });

  it('tout membre peut répondre ; seuls l’organisateur et les gestionnaires fixent la date', async () => {
    const { ctx, repos } = context();
    const vote = fakeInteraction({ kind: 'select', userId: 'member', values: ['yes'] });
    await handleDatePoll(ctx as never, vote.interaction as never, { type: 'poll.vote', meetingId, slotId: 1 });
    expect(repos.calls()).toContain('setVote');

    const fix = fakeInteraction({ kind: 'button', userId: 'member' });
    await expect(handleDatePoll(ctx as never, fix.interaction as never, { type: 'poll.fix', meetingId })).rejects.toBeInstanceOf(UserError);
    const organizer = fakeInteraction({ kind: 'button', userId: 'organizer' });
    await handleDatePoll(ctx as never, organizer.interaction as never, { type: 'poll.fix', meetingId });
    expect(organizer.interaction.update).toHaveBeenCalled();
    // Depuis le message public de clôture : réponse privée, le message public n'est pas modifié.
    const fromClosed = fakeInteraction({ kind: 'button', userId: 'organizer', messageFlags: 0 });
    await handleDatePoll(ctx as never, fromClosed.interaction as never, { type: 'poll.fix', meetingId });
    expect(fromClosed.interaction.update).not.toHaveBeenCalled();
    expect(fromClosed.replies.at(-1)).toMatchObject({ how: 'reply' });
  });
});
