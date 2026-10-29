import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { handleConfigPanel } from '../src/discord/interactions/configPanel.js';
import { messages } from '../src/i18n/index.js';
import { fakeInteraction } from './helpers/discordFakes.js';

const m = messages('fr');

/** Salon d'alertes simulé : le bot le voit et peut y écrire, ou non. */
function setup(opts: { canPost: boolean; sendFails?: boolean }) {
  const send = vi.fn(async () => {
    if (opts.sendFails) throw Object.assign(new Error('Missing Access'), { code: 50001 });
  });
  const me = { id: 'bot' };
  const channel = {
    id: '555',
    name: 'moderator-only',
    type: ChannelType.GuildText,
    rawPosition: 0,
    parent: null,
    guild: { members: { me } },
    isSendable: () => true,
    permissionsFor: () => ({ has: () => opts.canPost }),
    send,
  };
  let settings = { guildId: 'g', locale: 'fr', alertChannelId: null as string | null };
  const ctx = {
    config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
    log: pino({ level: 'silent' }),
    owners: { isOwner: () => false },
    settings: { get: async () => settings, messages: async () => m },
    optouts: { list: async () => [] },
    storage: { get: async () => undefined, available: () => [], blockedBySecretKey: () => false },
    repos: {
      listLlmBackends: async () => [],
      listGlossary: async () => [],
      listBackends: async () => [],
      updateSettings: vi.fn(async (_g: string, patch: Partial<typeof settings>) => {
        settings = { ...settings, ...patch };
      }),
    },
    client: { channels: { fetch: async () => channel } },
  };
  const guild = { id: 'g', members: { me }, channels: { cache: new Map([['555', channel]]) } };
  const click = async (action: 'alerts' | 'alertsTest') => {
    const { interaction, replies } = fakeInteraction({ kind: action === 'alerts' ? 'select' : 'button', values: ['555'], permissions: [PermissionFlagsBits.ManageGuild] });
    Object.assign(interaction, { guild });
    await handleConfigPanel(ctx as never, interaction as never, action);
    return JSON.stringify(replies.at(-1)?.payload);
  };
  return { click, send };
}

describe('/config → Alertes', () => {
  it('salon où le bot peut écrire : enregistré, alerte de test envoyée', async () => {
    const { click, send } = setup({ canPost: true });
    expect(await click('alerts')).not.toContain(m.errors.alertChannel);
    expect(await click('alertsTest')).toContain('Alerte de test envoyée');
    expect(send).toHaveBeenCalledOnce();
  });

  it('salon réservé où le bot ne peut pas écrire : avertissement au choix, test refusé sans erreur inattendue', async () => {
    const { click, send } = setup({ canPost: false });
    expect(await click('alerts')).toContain(m.errors.alertChannel);
    expect(await click('alertsTest')).toContain(m.errors.alertChannel);
    expect(send).not.toHaveBeenCalled();
  });

  it('envoi refusé par Discord malgré les permissions : message clair au lieu d’une erreur inattendue', async () => {
    const { click } = setup({ canPost: true, sendFails: true });
    await click('alerts');
    expect(await click('alertsTest')).toContain(m.errors.alertChannel);
  });
});
