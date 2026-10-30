import { describe, expect, it } from 'vitest';
import { decode, encode, type Action } from '../src/domain/customId.js';

const id = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';

describe('customId', () => {
  const actions: Action[] = [
    { type: 'rsvp', meetingId: id, status: 'yes' },
    { type: 'rsvp', meetingId: id, status: 'maybe' },
    { type: 'agenda.add', meetingId: id },
    { type: 'agenda.addSubmit', meetingId: id },
    { type: 'agenda.manage', meetingId: id },
    { type: 'agenda.select', meetingId: id },
    { type: 'agenda.move', meetingId: id, itemId: 42, direction: 'down' },
    { type: 'agenda.remove', meetingId: id, itemId: 7 },
    { type: 'agenda.edit', meetingId: id, itemId: 8 },
    { type: 'agenda.editSubmit', meetingId: id, itemId: 8 },
    { type: 'agenda.lock', meetingId: id, locked: true },
    { type: 'agenda.lock', meetingId: id, locked: false },
    { type: 'meeting.edit', meetingId: id },
    { type: 'meeting.editSubmit', meetingId: id },
    { type: 'report.retry', meetingId: id },
    { type: 'report.retryNow', meetingId: id },
    { type: 'report.regenConfirm', meetingId: id },
    { type: 'rec.stopConfirm', meetingId: id },
    { type: 'meeting.dismiss', meetingId: id },
    { type: 'meeting.organizer', meetingId: id },
    { type: 'meeting.organizerSelect', meetingId: id },
    { type: 'organizer.confirm', meetingId: id, userId: '508017247537725460' },
    { type: 'report.correct', meetingId: id },
    { type: 'report.regen', meetingId: id },
    { type: 'report.correctSubmit', meetingId: id },
    { type: 'tx', action: 'up', backendId: 12 },
    { type: 'tx', action: 'add', backendId: null },
    { type: 'cfg', action: 'forum' },
    { type: 'cfg', action: 'home' },
    { type: 'cfg', action: 'page', arg: 'alerts.2' },
    { type: 'rec.start', meetingId: id },
    { type: 'rec.stop', meetingId: id },
    { type: 'draft.create', draftId: 'a1b2c3d4e5f6' },
    { type: 'draft.none', draftId: '0123456789ab' },
    { type: 'meeting.none', meetingId: id },
    { type: 'meeting.create' },
    { type: 'meeting.manage', meetingId: id },
    { type: 'meeting.duplicateSubmit', meetingId: id },
    { type: 'meeting.regenAll', meetingId: id },
    { type: 'consent.open' },
    { type: 'consent.refuse' },
    { type: 'consent.accept' },
    { type: 'meeting.createSubmit' },
  ];

  it.each(actions)('aller-retour $type', (action) => {
    const encoded = encode(action);
    expect(encoded.length).toBeLessThanOrEqual(100);
    expect(encoded.startsWith('v1:')).toBe(true);
    expect(decode(encoded)).toEqual(action);
  });

  it('format stable (les anciens messages doivent rester cliquables)', () => {
    expect(encode({ type: 'rsvp', meetingId: id, status: 'no' })).toBe(`v1:rsvp:${id}:no`);
    expect(encode({ type: 'agenda.move', meetingId: id, itemId: 3, direction: 'up' })).toBe(`v1:agenda:move:${id}:3:up`);
  });

  it.each([
    'autre-bot:truc',
    `v2:rsvp:${id}:yes`,
    `v1:rsvp:${id}:peut-etre`,
    'v1:rsvp:pas-un-uuid:yes',
    `v1:rsvp:${id}:yes:extra`,
    `v1:agenda:move:${id}:abc:up`,
    `v1:agenda:move:${id}:3:left`,
    `v1:agenda:lock:${id}:2`,
    `v1:agenda:explode:${id}`,
    `v1:rec:pause:${id}`,
    'v1:tx:explode:1',
    'v1:tx:up:abc',
    'v1:cfg:explode',
    `v1:meeting:explode:${id}`,
    'v1:consent:maybe',
    'v1:cfg:page:../etc',
    `v1:rec:start:${id}:x`,
    `v1:meeting:edit:${id}:x`,
    '',
  ])('rejette %s', (raw) => {
    expect(decode(raw)).toBeNull();
  });
});
