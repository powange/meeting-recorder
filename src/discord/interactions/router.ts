import { randomUUID } from 'node:crypto';
import { MessageFlags, type Interaction } from 'discord.js';
import type { AppContext } from '../../context.js';
import { decode } from '../../domain/customId.js';
import { messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { commands } from '../commands/index.js';
import { handleBackendPanel } from './backendPanel.js';
import { handleConfigPanel } from './configPanel.js';
import { handleConsent } from './consent.js';
import { handleAction } from './components.js';
import { replyNotice } from './common.js';

export async function routeInteraction(ctx: AppContext, interaction: Interaction): Promise<void> {
  if (!interaction.inCachedGuild()) return;
  const log = ctx.log.child({ guildId: interaction.guildId, userId: interaction.user.id, interactionId: interaction.id });

  try {
    if (interaction.isAutocomplete()) {
      await commands.get(interaction.commandName)?.autocomplete?.(ctx, interaction);
      return;
    }
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;
      log.debug({ command: interaction.commandName, sub: interaction.options.getSubcommand(false) }, 'Commande');
      await command.execute(ctx, interaction);
      return;
    }
    if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
      const action = decode(interaction.customId);
      if (!action) {
        log.warn({ customId: interaction.customId }, 'customId inconnu');
        return;
      }
      log.debug({ action: action.type }, 'Interaction');
      if (action.type === 'cfg') {
        await handleConfigPanel(ctx, interaction, action.action, action.arg);
        return;
      }
      if (action.type === 'consent.open' || action.type === 'consent.refuse' || action.type === 'consent.accept') {
        if (!interaction.isButton()) return;
        await handleConsent(ctx, interaction, action.type.split('.')[1] as 'open' | 'refuse' | 'accept');
        return;
      }
      if (action.type === 'tx') {
        if (!interaction.isButton() && !interaction.isModalSubmit()) return;
        await handleBackendPanel(ctx, interaction, action.action, action.backendId);
        return;
      }
      if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isRoleSelectMenu() && !interaction.isUserSelectMenu() && !interaction.isModalSubmit()) return;
      // Un formulaire doit être acquitté en moins de 3 s : on le fait avant tout accès à la BDD.
      // Toutes les réponses aux formulaires sont éphémères (replyEphemeral gère l'état « différé »).
      if (interaction.isModalSubmit()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await handleAction(ctx, interaction, action);
    }
  } catch (err) {
    if (interaction.isAutocomplete() || !interaction.isRepliable()) {
      log.error({ err }, 'Interaction en échec');
      return;
    }
    let text: string;
    if (err instanceof UserError) {
      text = err.message;
    } else {
      const ref = randomUUID().slice(0, 8);
      log.error({ err, ref }, 'Interaction en échec');
      const locale = await ctx.settings.get(interaction.guildId).then((s) => s.locale).catch(() => 'fr');
      text = messages(locale).errors.generic(ref);
    }
    await replyNotice(interaction, 'error', text).catch((replyErr) => log.warn({ err: replyErr }, 'Réponse d’erreur impossible'));
  }
}
