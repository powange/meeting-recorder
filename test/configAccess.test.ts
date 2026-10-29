import { PermissionFlagsBits } from 'discord.js';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { handleBackendPanel } from '../src/discord/interactions/backendPanel.js';
import { handleConfigPanel, openConfigPanel } from '../src/discord/interactions/configPanel.js';
import { TX_ACTIONS, type CfgAction, type TxAction } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';
import { UserError } from '../src/lib/errors.js';
import { fakeInteraction } from './helpers/discordFakes.js';

const m = messages('fr');

/**
 * Contrôle d'accès des panneaux : les adresses que le bot appelle (serveurs de transcription et
 * de résumé) ne sont modifiables que par les propriétaires du bot, pas par les administrateurs
 * d'un serveur (protection contre les requêtes vers le réseau de l'opérateur).
 */
function context(owner: boolean) {
  return {
    config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
    log: pino({ level: 'silent' }),
    owners: { isOwner: () => owner },
    settings: { get: async () => ({ guildId: 'g', locale: 'fr' }), messages: async () => m },
    optouts: { list: async () => [] },
    storage: { get: async () => undefined, available: () => [], blockedBySecretKey: () => false },
    repos: { listLlmBackends: vi.fn(async () => []), listGlossary: vi.fn(async () => []), listBackends: vi.fn(async () => []), updateSettings: vi.fn() },
    client: { channels: { fetch: async () => null } },
  };
}

const interaction = (permissions: bigint[] = [PermissionFlagsBits.ManageGuild], kind: 'button' | 'modal' | 'select' = 'button') =>
  fakeInteraction({ kind, permissions, values: ['qwen3'] }).interaction;
/** Type d'interaction attendu par chaque action (formulaire, menu, sinon bouton). */
const kindOf = (action: string) => (/Submit$/.test(action) ? 'modal' : action === 'llmModel' ? 'select' : 'button');
const refusal = async (run: Promise<unknown>) => run.then(() => null, (err: unknown) => (err instanceof UserError ? err.message : `inattendu : ${String(err)}`));

const LLM_ACTIONS: CfgAction[] = ['llmEdit', 'llmSubmit', 'llmModels', 'llmModel', 'llmUp', 'llmToggleServer', 'llmThinking', 'llmDelete', 'llmDeleteConfirm'];
const READ_ONLY: TxAction[] = ['select', 'test', 'testAll', 'vocab', 'vocabSubmit'];

describe('contrôle d’accès des serveurs d’IA', () => {
  it.each(LLM_ACTIONS)('/config → Résumé « %s » : refusé à un administrateur qui n’est pas propriétaire du bot', async (action) => {
    expect(await refusal(handleConfigPanel(context(false) as never, interaction(undefined, kindOf(action)) as never, action, '1'))).toBe(m.backendPanel.ownersOnly);
  });

  it.each(TX_ACTIONS.filter((a) => !READ_ONLY.includes(a)))('transcription « %s » : refusé à un administrateur qui n’est pas propriétaire', async (action) => {
    expect(await refusal(handleBackendPanel(context(false) as never, interaction(undefined, kindOf(action)) as never, action, 1))).toBe(m.backendPanel.ownersOnly);
  });

  it('sans « Gérer le serveur » : panneau et actions refusés, même en lecture', async () => {
    const member = interaction([]);
    expect(await refusal(openConfigPanel(context(false) as never, member as never))).toBe(m.backendPanel.forbidden);
    expect(await refusal(handleConfigPanel(context(false) as never, member as never, 'home'))).toBe(m.backendPanel.forbidden);
    expect(await refusal(handleBackendPanel(context(false) as never, member as never, 'select', null))).toBe(m.backendPanel.forbidden);
  });

  it('propriétaire du bot : les actions ne sont pas refusées pour une question de droits', async () => {
    const result = await refusal(handleBackendPanel(context(true) as never, interaction([]) as never, 'up', 1));
    expect(result).not.toBe(m.backendPanel.ownersOnly);
    expect(result).not.toBe(m.backendPanel.forbidden);
  });
});
