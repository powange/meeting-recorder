import { Collection } from 'discord.js';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import type { GuildSettingsRow, MeetingRow } from '../src/db/schema.js';
import { handleAction } from '../src/discord/interactions/components.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';
import { fakeInteraction, spyObject } from './helpers/discordFakes.js';

const m = messages('fr');
const meetingId = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const meeting = { id: meetingId, guildId: 'g', title: 'Bureau', status: 'ended', organizerId: 'organizer', autoRecord: false, targetRoleIds: [] } as unknown as MeetingRow;

function setup() {
  const transferOrganizer = vi.fn(async (_id: string, userId: string) => ({ ...meeting, organizerId: userId }));
  const ctx = {
    config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
    log: pino({ level: 'silent' }),
    settings: { get: async () => ({ guildId: 'g', locale: 'fr', managerRoleIds: [], nudgeRoleId: null }) as unknown as GuildSettingsRow, messages: async () => m },
    owners: { isOwner: () => false },
    meetings: spyObject({ transferOrganizer }),
    recordings: spyObject({ isRecording: () => false }),
    repos: spyObject({ getMeeting: async () => meeting, listRecordingsForMeeting: async () => [], listSlots: async () => [] }),
  };
  return { ctx, transferOrganizer };
}

const ids = (payload: unknown) => [...JSON.stringify(payload).matchAll(/"custom_id":"([^"]+)"/g)].map((x) => x[1]!);

describe('changer d’organisateur', () => {
  it('organisateur : choix d’un membre, confirmation, puis transmission', async () => {
    const { ctx, transferOrganizer } = setup();
    const open = fakeInteraction({ kind: 'button', userId: 'organizer' });
    await handleAction(ctx as never, open.interaction as never, { type: 'meeting.organizer', meetingId });
    expect(ids(open.replies.at(-1)!.payload).map((id) => decode(id)?.type)).toEqual(['meeting.organizerSelect', 'meeting.manage']);

    const pick = fakeInteraction({ kind: 'userSelect', userId: 'organizer' });
    Object.assign(pick.interaction, { users: new Collection([['508017247537725460', { id: '508017247537725460', bot: false }]]) });
    await handleAction(ctx as never, pick.interaction as never, { type: 'meeting.organizerSelect', meetingId });
    const confirm = ids(pick.replies.at(-1)!.payload).map((id) => decode(id));
    expect(confirm[0]).toEqual({ type: 'organizer.confirm', meetingId, userId: '508017247537725460' });
    expect(transferOrganizer).not.toHaveBeenCalled();

    const ok = fakeInteraction({ kind: 'button', userId: 'organizer' });
    await handleAction(ctx as never, ok.interaction as never, { type: 'organizer.confirm', meetingId, userId: '508017247537725460' });
    expect(transferOrganizer).toHaveBeenCalledWith(meetingId, '508017247537725460', 'organizer');
    expect(JSON.stringify(ok.replies.at(-1)!.payload)).toContain(m.manage.organizerDone('508017247537725460'));
  });

  it('un bot, ou la même personne : refusé ; un simple membre ne peut pas transmettre', async () => {
    const { ctx } = setup();
    const pick = (userId: string, bot: boolean) => {
      const i = fakeInteraction({ kind: 'userSelect', userId: 'organizer' });
      Object.assign(i.interaction, { users: new Collection([[userId, { id: userId, bot }]]) });
      return handleAction(ctx as never, i.interaction as never, { type: 'meeting.organizerSelect', meetingId }).then(() => null, (e: Error) => e.message);
    };
    expect(await pick('999999999999999999', true)).toBe(m.manage.organizerBot);
    expect(await pick('organizer', false)).toBe(m.manage.organizerSame);
    const member = fakeInteraction({ kind: 'button', userId: 'member' });
    await expect(handleAction(ctx as never, member.interaction as never, { type: 'organizer.confirm', meetingId, userId: '508017247537725460' })).rejects.toThrow();
  });
});
