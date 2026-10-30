import { MessageFlags, MessageFlagsBitField, PermissionFlagsBits } from 'discord.js';
import { vi } from 'vitest';

/**
 * Faux objets Discord minimaux pour tester les services et les gestionnaires d'interactions
 * sans connexion : seules les méthodes réellement appelées par le code sont présentes, et
 * chacune enregistre ses appels.
 */

export interface FakeMessage {
  id: string;
  url: string;
  edit: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

/** Post de forum : messages envoyés, édités et supprimés. */
export function fakeThread(id = 'thread1') {
  const sent: Array<Record<string, unknown>> = [];
  const edited: Array<{ id: string } & Record<string, unknown>> = [];
  const deleted: string[] = [];
  const messages = new Map<string, FakeMessage>();
  let n = 0;
  const thread = {
    id,
    name: 'post',
    archived: false,
    isThread: () => true,
    send: vi.fn(async (payload: Record<string, unknown>) => {
      const msgId = `msg${++n}`;
      const message: FakeMessage = {
        id: msgId,
        url: `https://discord.com/channels/g/${id}/${msgId}`,
        edit: vi.fn(async (p: Record<string, unknown>) => {
          edited.push({ id: msgId, ...p });
          return message;
        }),
        delete: vi.fn(async () => {
          deleted.push(msgId);
          messages.delete(msgId);
        }),
      };
      messages.set(msgId, message);
      sent.push(payload);
      return message;
    }),
    messages: {
      fetch: vi.fn(async (msgId: string) => {
        const message = messages.get(msgId);
        if (!message) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return message;
      }),
      delete: vi.fn(async (msgId: string) => {
        deleted.push(msgId);
        messages.delete(msgId);
      }),
    },
    setArchived: vi.fn(async () => undefined),
    setName: vi.fn(async () => undefined),
  };
  return { thread, sent, edited, deleted, messages };
}

/**
 * Objet dont chaque méthode est un espion qui résout `undefined` (sauf celles fournies) :
 * pratique pour un service dont on vérifie seulement qu'il n'a PAS été appelé.
 */
export function spyObject<T extends object>(overrides: Partial<Record<keyof T | string, unknown>> = {}): T & { calls: () => string[] } {
  const spies = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({} as T & { calls: () => string[] }, {
    get(_target, prop: string) {
      if (prop === 'calls') return () => [...spies.entries()].filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name);
      if (prop === 'then') return undefined; // pas une promesse
      if (prop in overrides) return overrides[prop];
      if (!spies.has(prop)) spies.set(prop, vi.fn(async () => undefined));
      return spies.get(prop);
    },
  });
}

export type InteractionKind = 'button' | 'modal' | 'select' | 'userSelect';

/** Interaction de serveur (bouton, menu ou formulaire) avec ses réponses enregistrées. */
export function fakeInteraction(opts: {
  kind: InteractionKind;
  customId?: string;
  userId?: string;
  roleIds?: string[];
  /** Permissions du membre (PermissionFlagsBits). */
  permissions?: bigint[];
  values?: string[];
  fields?: Record<string, string>;
  guildId?: string;
  /** Drapeaux du message qui porte le bouton ou le menu (par défaut : message privé). */
  messageFlags?: number;
}) {
  const perms = opts.permissions ?? [];
  const replies: Array<{ how: string; payload: unknown }> = [];
  const interaction = {
    id: 'i1',
    guildId: opts.guildId ?? 'g',
    guild: { id: opts.guildId ?? 'g' },
    channel: null,
    customId: opts.customId ?? '',
    message: { flags: new MessageFlagsBitField(opts.messageFlags ?? MessageFlags.Ephemeral) },
    user: { id: opts.userId ?? 'member' },
    member: { roles: { cache: new Map((opts.roleIds ?? []).map((r) => [r, {}])) } },
    memberPermissions: {
      has: (flag: bigint) => perms.includes(flag) || perms.includes(PermissionFlagsBits.Administrator),
      any: (flags: bigint[]) => flags.some((f) => perms.includes(f)) || perms.includes(PermissionFlagsBits.Administrator),
    },
    values: opts.values ?? [],
    deferred: false,
    replied: false,
    /** Comme discord.js : renseigné par reply/deferReply, laissé à null par deferUpdate. */
    ephemeral: null as boolean | null,
    inCachedGuild: () => true,
    isAutocomplete: () => false,
    isChatInputCommand: () => false,
    isRepliable: () => true,
    isButton: () => opts.kind === 'button',
    isModalSubmit: () => opts.kind === 'modal',
    isStringSelectMenu: () => opts.kind === 'select',
    isAnySelectMenu: () => opts.kind === 'select' || opts.kind === 'userSelect',
    isRoleSelectMenu: () => false,
    isUserSelectMenu: () => opts.kind === 'userSelect',
    isChannelSelectMenu: () => false,
    isMessageComponent: () => opts.kind !== 'modal',
    isFromMessage: () => true,
    fields: {
      getTextInputValue: (id: string) => opts.fields?.[id] ?? '',
      getStringSelectValues: (id: string) => (opts.fields?.[id] ? [opts.fields[id]] : []),
      getSelectedChannels: () => null,
    },
    reply: vi.fn(async (payload: unknown) => {
      interaction.replied = true;
      replies.push({ how: 'reply', payload });
    }),
    deferReply: vi.fn(async (options?: { flags?: number }) => {
      interaction.deferred = true;
      interaction.ephemeral = Boolean((options?.flags ?? 0) & MessageFlags.Ephemeral);
    }),
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    update: vi.fn(async (payload: unknown) => {
      interaction.replied = true;
      replies.push({ how: 'update', payload });
    }),
    editReply: vi.fn(async (payload: unknown) => {
      replies.push({ how: 'editReply', payload });
    }),
    followUp: vi.fn(async (payload: unknown) => {
      replies.push({ how: 'followUp', payload });
    }),
    showModal: vi.fn(async (payload: unknown) => {
      replies.push({ how: 'showModal', payload });
    }),
  };
  /** Texte de la dernière réponse (reply, editReply ou followUp). */
  const lastText = () => {
    const last = replies.filter((r) => r.how !== 'showModal').at(-1)?.payload as { content?: string } | undefined;
    return last?.content ?? '';
  };
  return { interaction, replies, lastText };
}
