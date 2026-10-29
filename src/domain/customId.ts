import { RSVP_STATUSES, type RsvpStatus } from './types.js';

/**
 * customId persistants : tout l'état nécessaire est encodé dans l'id (pas de collecteur en mémoire),
 * ce qui permet aux boutons de fonctionner après un redémarrage. Préfixe de version pour pouvoir
 * changer le format sans casser les anciens messages.
 */
export type Action =
  | { type: 'rsvp'; meetingId: string; status: RsvpStatus }
  // Sondage de date (grille de disponibilités)
  | { type: 'poll.create' }
  | { type: 'poll.createSubmit' }
  | { type: 'poll.createRetry' }
  | { type: 'poll.answer'; meetingId: string }
  | { type: 'poll.vote'; meetingId: string; slotId: number }
  | { type: 'poll.fix'; meetingId: string }
  | { type: 'poll.fixSelect'; meetingId: string }
  | { type: 'poll.add'; meetingId: string }
  | { type: 'poll.addSubmit'; meetingId: string }
  | { type: 'poll.remove'; meetingId: string }
  | { type: 'poll.removeSelect'; meetingId: string }
  | { type: 'agenda.add'; meetingId: string }
  | { type: 'agenda.addSubmit'; meetingId: string }
  | { type: 'agenda.manage'; meetingId: string }
  | { type: 'agenda.select'; meetingId: string }
  | { type: 'agenda.read'; meetingId: string }
  | { type: 'agenda.readSelect'; meetingId: string }
  | { type: 'agenda.move'; meetingId: string; itemId: number; direction: 'up' | 'down' }
  | { type: 'agenda.remove'; meetingId: string; itemId: number }
  | { type: 'agenda.removeConfirm'; meetingId: string; itemId: number }
  | { type: 'agenda.edit'; meetingId: string; itemId: number }
  | { type: 'agenda.editSubmit'; meetingId: string; itemId: number }
  | { type: 'agenda.lock'; meetingId: string; locked: boolean }
  | { type: MeetingVerbType; meetingId: string }
  | { type: 'consent.open' }
  | { type: 'consent.refuse' }
  | { type: 'consent.accept' }
  | { type: 'report.retry'; meetingId: string }
  | { type: 'report.retryNow'; meetingId: string }
  | { type: 'report.correct'; meetingId: string }
  | { type: 'report.regen'; meetingId: string }
  | { type: 'report.regenConfirm'; meetingId: string }
  | { type: 'report.correctSubmit'; meetingId: string }
  | { type: 'tx'; action: TxAction; backendId: number | null }
  | { type: 'cfg'; action: CfgAction; arg?: string }
  | { type: 'rec.start'; meetingId: string }
  | { type: 'rec.stop'; meetingId: string }
  | { type: 'rec.stopConfirm'; meetingId: string }
  | { type: 'rec.next'; meetingId: string }
  | { type: 'rec.goto'; meetingId: string }
  | { type: 'rec.note'; meetingId: string }
  | { type: 'rec.noteSubmit'; meetingId: string }
  | { type: DraftType; draftId: string }
  | { type: 'meeting.create' }
  | { type: 'meeting.createSubmit' }
  | { type: 'meeting.createRetry' };

/** Actions du panneau des serveurs de transcription (`backendId` : serveur visé, sinon null). */
export const TX_ACTIONS = ['select', 'up', 'down', 'toggle', 'test', 'delete', 'confirmDelete', 'edit', 'editSubmit', 'add', 'addSubmit', 'testAll', 'vocab', 'vocabSubmit'] as const;
export type TxAction = (typeof TX_ACTIONS)[number];

/** Actions du panneau /config (navigation et réglages). */
export const CFG_ACTIONS = [
  'home',
  'section',
  'forum',
  'forumPosts',
  'voice',
  'voiceClear',
  'voiceMode',
  'voiceCategory',
  'voiceLead',
  'roleManager',
  'roleNudge',
  'roleNudgeEveryone',
  'remindersEdit',
  'remindersSubmit',
  'generalEdit',
  'generalSubmit',
  'toggleCreators',
  'toggleAutoRecord',
  'alerts',
  'alertsClear',
  'alertsTest',
  'page',
  'llmEdit',
  'llmSubmit',
  'llmModels',
  'llmModel',
  'llmTest',
  'llmReset',
  'llmToggle',
  'llmPick',
  'llmCancel',
  'llmAdd',
  'llmAddSubmit',
  'llmUp',
  'llmToggleServer',
  'llmThinking',
  'llmDelete',
  'llmDeleteConfirm',
  'llmTestAll',
  'llmDisableConfirm',
  'storageConnect',
  'storageCode',
  'storageCodeSubmit',
  'storageCancel',
  'storageTest',
  'storageFolder',
  'storageFolderSubmit',
  'storageDisconnect',
  'storageDisconnectConfirm',
  'glossaryPick',
  'glossaryPage',
  'glossaryAdd',
  'glossaryAddSubmit',
  'glossaryEdit',
  'glossaryEditSubmit',
  'glossaryDelete',
  'glossaryDeleteConfirm',
  'glossaryCancel',
  'glossaryImport',
  'glossaryImportSubmit',
  'glossaryExport',
] as const;
export type CfgAction = (typeof CFG_ACTIONS)[number];

/**
 * Actions sur une réunion (panneau « Gérer » de la carte) : `meeting.<verbe>:<meetingId>`.
 * Ils remplacent les anciennes sous-commandes /reunion.
 */
export const MEETING_VERBS = [
  'edit',
  'editSubmit',
  'editRetry',
  'manage',
  'duplicate',
  'duplicateSubmit',
  'autoRecord',
  'end',
  'endConfirm',
  'cancel',
  'cancelSubmit',
  'regen',
  'regenAll',
  'regenAllConfirm',
  'roles',
  'everyone',
  'none',
  'default',
  'reslot',
  'reslotSelect',
  'dismiss',
] as const;
type MeetingVerbType = `meeting.${(typeof MEETING_VERBS)[number]}`;

/** Brouillon de création (« Qui inviter ? ») : `draft.<verbe>:<id>`, id de 12 caractères hexadécimaux. */
export const DRAFT_VERBS = ['roles', 'everyone', 'default', 'none', 'create', 'cancel'] as const;
export type DraftType = `draft.${(typeof DRAFT_VERBS)[number]}`;
const DRAFT_ID = /^[0-9a-f]{12}$/;

const POLL_VERBS = ['answer', 'fix', 'fixSelect', 'add', 'addSubmit', 'remove', 'removeSelect'] as const;

const VERSION = 'v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encode(action: Action): string {
  const parts: Array<string | number> = [VERSION];
  switch (action.type) {
    case 'rsvp':
      parts.push('rsvp', action.meetingId, action.status);
      break;
    case 'agenda.move':
      parts.push('agenda', 'move', action.meetingId, action.itemId, action.direction);
      break;
    case 'agenda.remove':
    case 'agenda.removeConfirm':
    case 'agenda.edit':
    case 'agenda.editSubmit':
      parts.push('agenda', action.type.split('.')[1]!, action.meetingId, action.itemId);
      break;
    case 'agenda.lock':
      parts.push('agenda', 'lock', action.meetingId, action.locked ? 1 : 0);
      break;
    case 'meeting.create':
      parts.push('meeting', 'create');
      break;
    case 'tx':
      parts.push('tx', action.action, action.backendId ?? '-');
      break;
    case 'cfg':
      parts.push('cfg', action.action, ...(action.arg !== undefined ? [action.arg] : []));
      break;
    case 'meeting.createSubmit':
      parts.push('meeting', 'createSubmit');
      break;
    case 'meeting.createRetry':
      parts.push('meeting', 'createRetry');
      break;
    case 'poll.create':
    case 'poll.createSubmit':
    case 'poll.createRetry':
      parts.push('poll', action.type.split('.')[1]!);
      break;
    case 'poll.vote':
      parts.push('poll', 'vote', action.meetingId, action.slotId);
      break;
    case 'draft.roles':
    case 'draft.everyone':
    case 'draft.default':
    case 'draft.none':
    case 'draft.create':
    case 'draft.cancel':
      parts.push('draft', action.type.split('.')[1]!, action.draftId);
      break;
    case 'consent.open':
    case 'consent.refuse':
    case 'consent.accept':
      parts.push('consent', action.type.split('.')[1]!);
      break;
    default: {
      const [group, verb] = action.type.split('.') as [string, string];
      parts.push(group, verb, action.meetingId);
    }
  }
  const id = parts.join(':');
  if (id.length > 100) throw new Error(`customId trop long (${id.length}) : ${id}`);
  return id;
}

/** Décode un customId ; renvoie `null` pour tout ce qui n'est pas à nous ou est malformé. */
export function decode(customId: string): Action | null {
  const [version, group, ...rest] = customId.split(':');
  if (version !== VERSION || group === undefined) return null;

  if (group === 'rsvp') {
    const [meetingId, status] = rest;
    if (!isUuid(meetingId) || !RSVP_STATUSES.includes(status as RsvpStatus) || rest.length !== 2) return null;
    return { type: 'rsvp', meetingId, status: status as RsvpStatus };
  }

  if (group === 'poll') {
    const [verb, meetingId, slot] = rest;
    if (rest.length === 1 && (verb === 'create' || verb === 'createSubmit' || verb === 'createRetry')) return { type: `poll.${verb}` };
    if (!isUuid(meetingId)) return null;
    if (verb === 'vote') {
      const slotId = toId(slot);
      return slotId !== null && rest.length === 3 ? { type: 'poll.vote', meetingId, slotId } : null;
    }
    if (rest.length === 2 && POLL_VERBS.includes(verb as (typeof POLL_VERBS)[number])) return { type: `poll.${verb as (typeof POLL_VERBS)[number]}`, meetingId };
    return null;
  }

  if (group === 'cfg') {
    const [action, arg] = rest;
    if (rest.length > 2 || !CFG_ACTIONS.includes(action as CfgAction)) return null;
    // « section.page » (pagination), « s.<id> » (serveur de résumé) ou « p.<service> » (stockage).
    if (arg !== undefined && !/^[a-z]+\.(\d{1,10}|[a-z]{1,20})$/.test(arg)) return null;
    return arg === undefined ? { type: 'cfg', action: action as CfgAction } : { type: 'cfg', action: action as CfgAction, arg };
  }

  if (group === 'tx') {
    const [action, id] = rest;
    if (rest.length !== 2 || !TX_ACTIONS.includes(action as TxAction)) return null;
    if (id === '-') return { type: 'tx', action: action as TxAction, backendId: null };
    const backendId = toId(id);
    return backendId === null ? null : { type: 'tx', action: action as TxAction, backendId };
  }

  const [verb, meetingId, a, b] = rest;
  if (group === 'draft') {
    const draftId = meetingId; // « draft:<verbe>:<id> »
    if (rest.length !== 2 || !DRAFT_ID.test(draftId ?? '') || !DRAFT_VERBS.includes(verb as (typeof DRAFT_VERBS)[number])) return null;
    return { type: `draft.${verb as (typeof DRAFT_VERBS)[number]}`, draftId: draftId! };
  }

  if (group === 'consent') {
    const [v] = rest;
    if (rest.length === 1 && (v === 'open' || v === 'refuse' || v === 'accept')) return { type: `consent.${v}` };
    return null;
  }

  if (group === 'meeting' && rest.length === 1) {
    if (verb === 'create') return { type: 'meeting.create' };
    if (verb === 'createSubmit') return { type: 'meeting.createSubmit' };
    if (verb === 'createRetry') return { type: 'meeting.createRetry' };
  }
  if (!isUuid(meetingId)) return null;

  if (group === 'meeting') {
    if (rest.length !== 2 || !MEETING_VERBS.includes(verb as (typeof MEETING_VERBS)[number])) return null;
    return { type: `meeting.${verb}` as MeetingVerbType, meetingId };
  }

  if (group === 'report') {
    if (rest.length !== 2) return null;
    if (verb === 'retry') return { type: 'report.retry', meetingId };
    if (verb === 'retryNow') return { type: 'report.retryNow', meetingId };
    if (verb === 'correct') return { type: 'report.correct', meetingId };
    if (verb === 'regen') return { type: 'report.regen', meetingId };
    if (verb === 'regenConfirm') return { type: 'report.regenConfirm', meetingId };
    if (verb === 'correctSubmit') return { type: 'report.correctSubmit', meetingId };
    return null;
  }

  if (group === 'rec') {
    if (rest.length !== 2) return null;
    if (verb === 'start') return { type: 'rec.start', meetingId };
    if (verb === 'stop') return { type: 'rec.stop', meetingId };
    if (verb === 'stopConfirm') return { type: 'rec.stopConfirm', meetingId };
    if (verb === 'next') return { type: 'rec.next', meetingId };
    if (verb === 'goto') return { type: 'rec.goto', meetingId };
    if (verb === 'note') return { type: 'rec.note', meetingId };
    if (verb === 'noteSubmit') return { type: 'rec.noteSubmit', meetingId };
    return null;
  }

  if (group === 'agenda') {
    switch (verb) {
      case 'add':
      case 'addSubmit':
      case 'manage':
      case 'select':
      case 'read':
      case 'readSelect':
        return rest.length === 2 ? { type: `agenda.${verb}`, meetingId } : null;
      case 'move': {
        const itemId = toId(a);
        if (itemId === null || (b !== 'up' && b !== 'down') || rest.length !== 4) return null;
        return { type: 'agenda.move', meetingId, itemId, direction: b };
      }
      case 'remove':
      case 'removeConfirm':
      case 'edit':
      case 'editSubmit': {
        const itemId = toId(a);
        return itemId !== null && rest.length === 3 ? { type: `agenda.${verb}`, meetingId, itemId } : null;
      }
      case 'lock':
        return (a === '1' || a === '0') && rest.length === 3 ? { type: 'agenda.lock', meetingId, locked: a === '1' } : null;
    }
  }
  return null;
}

function isUuid(value: string | undefined): value is string {
  return value !== undefined && UUID_RE.test(value);
}

function toId(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,10}$/.test(value)) return null;
  return Number(value);
}
