import {
  ChannelType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Channel,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type Guild,
  type Interaction,
} from 'discord.js';
import { noticeText } from '../ui/notice.js';
import { formatGlossaryLine, GLOSSARY_DEFINITION_MAX, GLOSSARY_MAX_TERMS, GLOSSARY_TERM_MAX, glossaryKey, parseGlossaryImport, parseVariants } from '../../domain/glossary.js';
import { IANAZone } from 'luxon';
import type { AppContext } from '../../context.js';
import { pageOf, type ChannelInfo } from '../../domain/channelChoices.js';
import { encode, type CfgAction } from '../../domain/customId.js';
import { DURATION_MAX, DURATION_MIN } from '../../domain/meeting.js';
import type { StorageProvider } from '../../domain/storage.js';
import { formatOffset, parseOffsets } from '../../domain/reminders.js';
import type { Messages } from '../../i18n/index.js';
import { errorMessage, UserError } from '../../lib/errors.js';
import { effectiveLlms, listModels, llmRowToConfig, testLlm, type LlmTest } from '../../services/llmSettings.js';
import { effectiveBackends } from '../../services/transcriptionBackends.js';
import { assertUrlAllowed, hostOf } from '../../lib/hosts.js';
import { CONFIG_SECTIONS, renderConfigHome, renderConfigSection, VOICE_LEADS_MIN, type ConfigContext, type ConfigSection, type VoiceMode } from '../embeds/configPanel.js';
import { ensureStatusTags, missingForumPermissions, postsReserved, setPostsReserved } from '../forum.js';
import { openBackendPanelInPlace } from './backendPanel.js';
import { encryptSecret } from '../../lib/secrets.js';
import { buildInfo } from '../../lib/version.js';

type CfgInteraction = Interaction<'cached'>;
type Section = Exclude<ConfigSection, 'transcription'>;

/** `/config` : ouvre le panneau de configuration (message éphémère). */
export async function openConfigPanel(ctx: AppContext, interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  const m = await ctx.settings.messages(interaction.guildId);
  // Même contrôle que les actions : la permission par défaut de la commande peut être élargie
  // par un admin (Intégrations), le panneau montrerait alors refus d'enregistrement et stockage.
  if (!ctx.owners.isOwner(interaction.user.id) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError(m.backendPanel.forbidden);
  }
  await interaction.reply({
    components: [renderConfigHome(await context(ctx, interaction.guildId, m, undefined, interaction.user.id), m)],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}

/** Types de salon proposés par section. */
const CHANNEL_TYPES: Partial<Record<ConfigSection, ChannelType>> = {
  forum: ChannelType.GuildForum,
  voice: ChannelType.GuildVoice,
  alerts: ChannelType.GuildText,
};

function channelsOf(guild: Guild, type: ChannelType): ChannelInfo[] {
  return [...guild.channels.cache.values()]
    .filter((c) => c.type === type)
    .map((c) => ({
      id: c.id,
      name: c.name,
      position: 'rawPosition' in c ? c.rawPosition : 0,
      category: c.parent ? { name: c.parent.name, position: c.parent.rawPosition } : null,
    }));
}

async function context(ctx: AppContext, guildId: string, m: Messages, notice?: string, userId?: string): Promise<ConfigContext> {
  const settings = await ctx.settings.get(guildId);
  const llm = await effectiveLlms(ctx.repos, settings, ctx.config);
  const rows = llm.source === 'discord' ? await ctx.repos.listLlmBackends(guildId) : [];
  const { source, backends } = await effectiveBackends(ctx.repos, ctx.config, guildId);
  const names = backends.map((b) => b.name).join(', ');
  const transcription = source === 'yaml' && backends.length ? m.config.fromYamlSummary(names) : m.config.transcriptionSummary(backends.length, names);
  return {
    settings,
    transcription,
    notice,
    llm: {
      source: llm.source,
      enabled: llm.enabled,
      servers:
        llm.source === 'discord'
          ? rows.map((r) => ({ id: r.id, name: r.name, url: r.url, model: r.model, enabled: r.enabled, hasKey: Boolean(r.apiKey), thinking: r.thinking }))
          : llm.servers.map((sv) => ({ name: sv.name, url: sv.config.baseUrl ?? '', model: sv.config.model, enabled: true, hasKey: Boolean(sv.config.apiKey), thinking: sv.config.thinking })),
    },
    canEditAi: userId ? ctx.owners.isOwner(userId) : false,
    refusals: await ctx.optouts.list(guildId),
    storage: await storageView(ctx, guildId),
    glossary: { terms: (await ctx.repos.listGlossary(guildId)).map((g) => ({ id: g.id, term: g.term, variants: g.variants, definition: g.definition })) },
    ...forumState(ctx, guildId, settings.forumChannelId),
    version: BUILD,
  };
}

/** Version du bot, lue une fois (package.json, ou APP_VERSION et GIT_SHA de l'image). */
const BUILD = buildInfo();

/** Forum choisi : création de posts réservée ou non, et permissions qui manquent au bot. */
function forumState(ctx: AppContext, guildId: string, forumId: string | null): Pick<ConfigContext, 'forumPostsReserved' | 'forumMissing'> {
  const forum = forumId ? ctx.client.guilds.cache.get(guildId)?.channels.cache.get(forumId) : undefined;
  if (forum?.type !== ChannelType.GuildForum) return {};
  return { forumPostsReserved: postsReserved(forum as ForumChannel), forumMissing: missingForumPermissions(forum as ForumChannel) };
}

async function storageView(ctx: AppContext, guildId: string): Promise<ConfigContext['storage']> {
  const row = await ctx.storage.get(guildId);
  return {
    available: ctx.storage.available(),
    needsSecretKey: ctx.storage.blockedBySecretKey(),
    connected: row ? { provider: row.provider, account: row.account, folder: row.folder, rootUrl: row.rootUrl, lastOkAt: row.lastOkAt, lastError: row.lastError } : undefined,
  };
}

type ShowExtra = Partial<Pick<ConfigContext, 'models' | 'confirmLlmDisable' | 'voiceMode' | 'llmSelected' | 'llmConfirmDelete'>> & {
  page?: number;
  glossary?: { page?: number; selected?: number | undefined; confirmDelete?: boolean };
  storagePending?: NonNullable<ConfigContext['storage']>['pending'];
  storageConfirm?: boolean;
};

/** Serveurs de résumé au plus (limite raisonnable des composants du panneau). */
const MAX_LLM_SERVERS = 5;

function formatTest(result: LlmTest, t: Messages['config']): string {
  return result.ok ? t.llmTestOk(result.ms!, result.model!) : t.llmTestKo(result.error!);
}

/** Actions du panneau. Réservé à « Gérer le serveur » (ou aux propriétaires du bot). */
export async function handleConfigPanel(ctx: AppContext, interaction: CfgInteraction, action: CfgAction, arg?: string): Promise<void> {
  const guildId = interaction.guildId;
  const m = await ctx.settings.messages(guildId);
  const t = m.config;
  const isOwner = ctx.owners.isOwner(interaction.user.id);
  if (!isOwner && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new UserError(m.backendPanel.forbidden);
  }

  const show = async (section: Section | 'home', notice?: string, extra: ShowExtra = {}) => {
    const { page, storagePending, storageConfirm, glossary, ...state } = extra;
    const c = { ...(await context(ctx, guildId, m, notice, interaction.user.id)), ...state };
    if (c.glossary && glossary) c.glossary = { ...c.glossary, ...glossary };
    if (c.storage) c.storage = { ...c.storage, pending: storagePending, confirmDisconnect: storageConfirm ?? false };
    const type = section === 'home' ? undefined : CHANNEL_TYPES[section];
    if (type !== undefined) {
      const list = channelsOf(interaction.guild, type);
      const current = { forum: c.settings.forumChannelId, voice: c.settings.voiceChannelId, alerts: c.settings.alertChannelId }[section as 'forum' | 'voice' | 'alerts'];
      c.channels = { list, page: page ?? pageOf(list, current) };
      if (list.length === 0) c.notice = [notice, t.noChannel].filter(Boolean).join('\n');
    }
    const payload = { components: [section === 'home' ? renderConfigHome(c, m) : renderConfigSection(section, c, m)], allowedMentions: { parse: [] } };
    if (interaction.isRepliable() && (interaction.deferred || interaction.replied)) await interaction.editReply(payload);
    else if (interaction.isMessageComponent()) await interaction.update(payload);
    else if (interaction.isModalSubmit() && interaction.isFromMessage()) await interaction.update(payload);
  };

  // Terme du glossaire visé (« g.<id> ») et page du menu (« gp.<page> »).
  const termId = arg?.startsWith('g.') ? Number(arg.slice(2)) : Number.NaN;
  const glossaryPage = arg?.startsWith('gp.') ? Number(arg.slice(3)) : 0;
  const term = async () => {
    const row = (await ctx.repos.listGlossary(guildId)).find((r) => r.id === termId);
    if (!row) throw new UserError(t.glossaryGone);
    return row;
  };
  /** Page du menu où se trouve le terme (25 par page, ordre alphabétique). */
  const pageOfTerm = async (id = termId) => Math.max(0, Math.floor((await ctx.repos.listGlossary(guildId)).findIndex((r) => r.id === id) / 25));

  // Serveur de résumé visé (« s.<id> » dans l'identifiant du bouton).
  const serverId = arg?.startsWith('s.') ? Number(arg.slice(2)) : Number.NaN;
  const server = async () => {
    const row = (await ctx.repos.listLlmBackends(guildId)).find((r) => r.id === serverId);
    if (!row) throw new UserError(t.llmGone);
    return row;
  };

  switch (action) {
    case 'home':
      return show('home');

    case 'section': {
      if (!interaction.isStringSelectMenu()) return;
      const section = interaction.values[0] as ConfigSection;
      if (!CONFIG_SECTIONS.includes(section)) return;
      if (section === 'transcription') return openBackendPanelInPlace(ctx, interaction);
      return show(section);
    }

    case 'page': {
      const [section, page] = (arg ?? '').split('.');
      if (section !== 'forum' && section !== 'voice' && section !== 'alerts') return;
      return show(section, undefined, { page: Number(page) });
    }

    case 'forum': {
      if (!interaction.isStringSelectMenu()) return;
      const forum = interaction.guild.channels.cache.get(interaction.values[0] ?? '');
      if (!forum || forum.type !== ChannelType.GuildForum) return show('forum');
      const missing = missingForumPermissions(forum as ForumChannel);
      if (missing.length > 0) return show('forum', noticeText('error', m.errors.forumPermissions(missing.join(', '))));
      await interaction.deferUpdate(); // tags et post épinglé : quelques secondes
      const tagIds = await ensureStatusTags(forum as ForumChannel, m);
      await ctx.repos.updateSettings(guildId, { forumChannelId: forum.id, tagIds });
      const hubId = await ctx.hub.ensure(forum as ForumChannel, m);
      await ctx.hub.refreshNow(guildId);
      return show('forum', t.forumReady(forum.id, hubId));
    }

    case 'forumPosts': {
      if (!interaction.isButton()) return;
      const forumId = (await ctx.settings.get(guildId)).forumChannelId;
      const forum = forumId ? interaction.guild.channels.cache.get(forumId) : undefined;
      if (!forum || forum.type !== ChannelType.GuildForum) return show('forum');
      const reserve = !postsReserved(forum as ForumChannel);
      const ok = await setPostsReserved(forum as ForumChannel, reserve, `/config par ${interaction.user.tag}`);
      return show('forum', ok ? (reserve ? t.postsReservedDone : t.postsOpenDone) : noticeText('error', t.postsNeedPermission));
    }

    case 'voice': {
      if (!interaction.isStringSelectMenu()) return;
      const voice = interaction.guild.channels.cache.get(interaction.values[0] ?? '');
      if (!voice || voice.type !== ChannelType.GuildVoice) return show('voice');
      await ctx.repos.updateSettings(guildId, { voiceChannelId: voice.id, autoVoice: false });
      return show('voice', t.saved);
    }
    case 'voiceClear':
      await ctx.repos.updateSettings(guildId, { voiceChannelId: null });
      return show('voice', t.saved);
    case 'voiceMode': {
      if (!interaction.isStringSelectMenu()) return;
      const mode = interaction.values[0];
      if (mode === 'free') await ctx.repos.updateSettings(guildId, { voiceChannelId: null, autoVoice: false });
      else if (mode === 'auto') {
        await ctx.repos.updateSettings(guildId, { voiceChannelId: null, autoVoice: true });
        await ctx.meetings.replanGuild(guildId);
        const settings = await ctx.settings.get(guildId);
        const problem = voiceCategoryProblem(interaction.guild, settings.autoVoiceCategoryId ?? forumParent(interaction.guild, settings.forumChannelId), m);
        return show('voice', problem ? `${t.saved}\n${problem}` : t.saved);
      }
      // « Imposé » : le salon reste à choisir dans la liste qui apparaît.
      else if (mode === 'fixed') return show('voice', t.pickVoiceNow, { voiceMode: 'fixed' });
      await ctx.meetings.replanGuild(guildId); // tâche de création du salon (ajoutée ou retirée)
      return show('voice', t.saved);
    }
    case 'voiceCategory': {
      if (!interaction.isChannelSelectMenu()) return;
      const categoryId = interaction.values[0] ?? null;
      const settings = await ctx.settings.get(guildId);
      // Catégorie où le bot ne peut pas créer de salon : refusée, plutôt qu'un échec le jour de la réunion.
      const problem = voiceCategoryProblem(interaction.guild, categoryId ?? forumParent(interaction.guild, settings.forumChannelId), m);
      if (problem && categoryId) return show('voice', problem);
      await ctx.repos.updateSettings(guildId, { autoVoiceCategoryId: categoryId });
      return show('voice', problem ? `${t.saved}\n${problem}` : t.saved);
    }
    case 'voiceLead': {
      if (!interaction.isStringSelectMenu()) return;
      const lead = Number(interaction.values[0]);
      if (!VOICE_LEADS_MIN.includes(lead as (typeof VOICE_LEADS_MIN)[number])) return;
      await ctx.repos.updateSettings(guildId, { autoVoiceLeadMin: lead });
      await ctx.meetings.replanGuild(guildId);
      return show('voice', t.saved);
    }

    case 'roleManager': {
      if (!interaction.isRoleSelectMenu()) return;
      await ctx.repos.updateSettings(guildId, { managerRoleIds: [...interaction.roles.keys()].slice(0, 5) });
      return show('roles', t.saved);
    }
    case 'roleNudgeEveryone': {
      // Le rôle @everyone a l'identifiant du serveur.
      const settings = await ctx.settings.get(guildId);
      await ctx.repos.updateSettings(guildId, { nudgeRoleId: settings.nudgeRoleId === guildId ? null : guildId });
      return show('roles', t.saved);
    }
    case 'roleNudge': {
      if (!interaction.isRoleSelectMenu()) return;
      await ctx.repos.updateSettings(guildId, { nudgeRoleId: interaction.roles.first()?.id ?? null });
      return show('roles', t.saved);
    }

    case 'remindersEdit': {
      if (!interaction.isButton()) return;
      const settings = await ctx.settings.get(guildId);
      const input = new TextInputBuilder()
        .setCustomId('offsets')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true)
        .setValue(settings.reminderOffsetsMin.length ? settings.reminderOffsetsMin.map(formatOffset).join(', ') : 'aucun');
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'cfg', action: 'remindersSubmit' }))
          .setTitle(t.remindersModal)
          .addLabelComponents(new LabelBuilder().setLabel(t.remindersField).setDescription(t.remindersHint).setTextInputComponent(input)),
      );
      return;
    }
    case 'remindersSubmit': {
      if (!interaction.isModalSubmit()) return;
      const raw = interaction.fields.getTextInputValue('offsets').trim().replace(/\s+j\b/g, 'j').replace(/\s+h\b/g, 'h');
      const offsets = /^(aucun|non|0)$/i.test(raw) ? [] : parseOffsets(raw);
      if (!offsets) return show('reminders', noticeText('error', m.errors.offsets(raw.slice(0, 100))));
      await ctx.repos.updateSettings(guildId, { reminderOffsetsMin: offsets });
      await ctx.meetings.replanGuild(guildId);
      return show('reminders', t.saved);
    }

    case 'generalEdit': {
      if (!interaction.isButton()) return;
      const settings = await ctx.settings.get(guildId);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'cfg', action: 'generalSubmit' }))
          .setTitle(t.generalModal)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(t.timezoneField)
              .setDescription(t.timezoneHint)
              .setTextInputComponent(new TextInputBuilder().setCustomId('timezone').setStyle(TextInputStyle.Short).setMaxLength(60).setRequired(true).setValue(settings.timezone)),
            new LabelBuilder()
              .setLabel(t.durationField)
              .setTextInputComponent(
                new TextInputBuilder().setCustomId('duration').setStyle(TextInputStyle.Short).setMaxLength(4).setRequired(true).setValue(String(settings.defaultDurationMin)),
              ),
          ),
      );
      return;
    }
    case 'generalSubmit': {
      if (!interaction.isModalSubmit()) return;
      const timezone = interaction.fields.getTextInputValue('timezone').trim();
      const duration = Number(interaction.fields.getTextInputValue('duration').trim());
      if (!IANAZone.isValidZone(timezone)) return show('general', noticeText('error', m.errors.timezone));
      if (!Number.isInteger(duration) || duration < DURATION_MIN || duration > DURATION_MAX) return show('general', noticeText('error', m.errors.duration(DURATION_MIN, DURATION_MAX)));
      await ctx.repos.updateSettings(guildId, { timezone, defaultDurationMin: duration });
      return show('general', t.saved);
    }
    case 'toggleCreators': {
      const settings = await ctx.settings.get(guildId);
      await ctx.repos.updateSettings(guildId, { creatorsRestricted: !settings.creatorsRestricted });
      return show('general', t.saved);
    }

    case 'alerts': {
      if (!interaction.isStringSelectMenu()) return;
      const channel = interaction.guild.channels.cache.get(interaction.values[0] ?? '');
      if (!channel || channel.type !== ChannelType.GuildText) return show('alerts');
      await ctx.repos.updateSettings(guildId, { alertChannelId: channel.id });
      return show('alerts', canPost(channel) ? t.saved : `${t.saved}\n⚠️ ${m.errors.alertChannel}`);
    }
    case 'alertsClear':
      await ctx.repos.updateSettings(guildId, { alertChannelId: null });
      return show('alerts', t.saved);
    case 'alertsTest': {
      const channelId = (await ctx.settings.get(guildId)).alertChannelId;
      if (!channelId) return show('alerts');
      const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
      // isSendable() ne regarde que le type de salon : un salon réservé aux modérateurs passe,
      // puis l'envoi échoue (Missing Access). On vérifie les permissions, et l'envoi lui-même.
      const sent =
        channel?.isSendable() &&
        canPost(channel) &&
        (await channel.send({ content: `🚨 ${t.alertsTestMessage}`, allowedMentions: { parse: [] } }).then(
          () => true,
          (err) => (ctx.log.warn({ guildId, channelId, err: errorMessage(err) }, 'Alerte de test impossible à poster'), false),
        ));
      return show('alerts', sent ? t.alertsTestSent(channelId) : noticeText('error', m.errors.alertChannel));
    }

    // ---------------------------------------------------------------- stockage
    case 'storageConnect': {
      const provider = arg?.startsWith('p.') ? (arg.slice(2) as StorageProvider) : null;
      if (!interaction.isButton()) return;
      if (!provider || !ctx.storage.available().includes(provider)) return show('storage');
      if (provider === 'dropbox') {
        ctx.storage.cancel(guildId);
        return show('storage', undefined, { storagePending: { provider, url: ctx.storage.dropboxLink(guildId, interaction.user.id) } });
      }
      await interaction.deferUpdate();
      const name = t.storageProviders[provider]!;
      const start = await ctx.storage.startDevice(guildId, interaction.user.id, provider, (result) => {
        // Le panneau éphémère est mis à jour à la validation (ou à l'expiration du code).
        const notice = result.ok
          ? t.storageConnected(name, result.row.account)
          : result.reason === 'expired'
            ? `⌛ ${t.storageExpired}`
            : t.storageDenied(result.detail ?? result.reason);
        void show('storage', notice).catch((err) => ctx.log.debug({ err: errorMessage(err) }, 'Panneau de stockage non mis à jour'));
      });
      return show('storage', undefined, { storagePending: { provider, url: start.verificationUrl, code: start.userCode } });
    }
    case 'storageCode': {
      if (!interaction.isButton()) return;
      const input = new TextInputBuilder().setCustomId('code').setStyle(TextInputStyle.Short).setMinLength(10).setMaxLength(200).setRequired(true);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'cfg', action: 'storageCodeSubmit' }))
          .setTitle(t.storageCodeModal)
          .addLabelComponents(new LabelBuilder().setLabel(t.storageCodeField).setTextInputComponent(input)),
      );
      return;
    }
    case 'storageCodeSubmit': {
      if (!interaction.isModalSubmit()) return;
      try {
        const row = await ctx.storage.dropboxFinish(guildId, interaction.user.id, interaction.fields.getTextInputValue('code'));
        if (!row) return show('storage', `⌛ ${t.storageCodeExpired}`);
        return show('storage', t.storageConnected(t.storageProviders.dropbox!, row.account));
      } catch (err) {
        return show('storage', t.storageDenied(errorMessage(err)));
      }
    }
    case 'storageCancel':
      ctx.storage.cancel(guildId);
      return show('storage');
    case 'storageTest': {
      if (!interaction.isButton()) return;
      await interaction.deferUpdate();
      const result = await ctx.storage.test(guildId);
      return show('storage', result.ok ? t.storageTestOk(result.account) : t.storageTestKo(result.error));
    }
    case 'storageFolder': {
      if (!interaction.isButton()) return;
      const current = (await ctx.storage.get(guildId))?.folder ?? '';
      const input = new TextInputBuilder().setCustomId('folder').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true).setValue(current);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'cfg', action: 'storageFolderSubmit' }))
          .setTitle(t.storageFolderModal)
          .addLabelComponents(new LabelBuilder().setLabel(t.storageFolderField).setDescription(t.storageFolderHint).setTextInputComponent(input)),
      );
      return;
    }
    case 'storageFolderSubmit': {
      if (!interaction.isModalSubmit()) return;
      if (!(await ctx.storage.get(guildId))) return show('storage');
      await ctx.storage.setFolder(guildId, interaction.fields.getTextInputValue('folder'));
      return show('storage', t.saved);
    }
    case 'storageDisconnect':
      return show('storage', undefined, { storageConfirm: true });
    case 'storageDisconnectConfirm':
      await ctx.storage.disconnect(guildId);
      return show('storage', t.storageDisconnected);

    // ---------------------------------------------------------------- glossaire
    case 'glossaryPick': {
      if (!interaction.isStringSelectMenu()) return;
      return show('glossary', undefined, { glossary: { page: glossaryPage, selected: Number(interaction.values[0]) } });
    }
    case 'glossaryPage':
      return show('glossary', undefined, { glossary: { page: Math.max(0, glossaryPage) } });
    case 'glossaryCancel':
      return show('glossary', undefined, { glossary: { selected: termId, page: await pageOfTerm() } });
    case 'glossaryAdd':
    case 'glossaryEdit':
    case 'glossaryImport': {
      if (!interaction.isButton()) return;
      if (action === 'glossaryImport') {
        const lines = new TextInputBuilder().setCustomId('lines').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true).setPlaceholder('Cors des vents (cor des vents) : objet qui accélère un navire.');
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(encode({ type: 'cfg', action: 'glossaryImportSubmit' }))
            .setTitle(t.glossaryModalImport)
            .addLabelComponents(new LabelBuilder().setLabel(t.glossaryImportField).setDescription(t.glossaryImportHint).setTextInputComponent(lines)),
        );
        return;
      }
      const editing = action === 'glossaryEdit' ? await term() : null;
      const termInput = new TextInputBuilder().setCustomId('term').setStyle(TextInputStyle.Short).setMaxLength(GLOSSARY_TERM_MAX).setRequired(true);
      const variants = new TextInputBuilder().setCustomId('variants').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false);
      const definition = new TextInputBuilder().setCustomId('definition').setStyle(TextInputStyle.Paragraph).setMaxLength(GLOSSARY_DEFINITION_MAX).setRequired(true);
      if (editing) {
        termInput.setValue(editing.term);
        if (editing.variants.length) variants.setValue(editing.variants.join(', '));
        definition.setValue(editing.definition);
      }
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(editing ? encode({ type: 'cfg', action: 'glossaryEditSubmit', arg: `g.${editing.id}` }) : encode({ type: 'cfg', action: 'glossaryAddSubmit' }))
          .setTitle(editing ? t.glossaryModalEdit : t.glossaryModalAdd)
          .addLabelComponents(
            new LabelBuilder().setLabel(t.glossaryTermField).setTextInputComponent(termInput),
            new LabelBuilder().setLabel(t.glossaryVariantsField).setDescription(t.glossaryVariantsHint).setTextInputComponent(variants),
            new LabelBuilder().setLabel(t.glossaryDefinitionField).setDescription(t.glossaryDefinitionHint).setTextInputComponent(definition),
          ),
      );
      return;
    }
    case 'glossaryAddSubmit':
    case 'glossaryEditSubmit': {
      if (!interaction.isModalSubmit()) return;
      const name = interaction.fields.getTextInputValue('term').trim();
      const definition = interaction.fields.getTextInputValue('definition').trim().replace(/\s*\n\s*/g, ' ');
      if (!name || !glossaryKey(name) || !definition) return show('glossary', noticeText('error', t.glossaryInvalid(GLOSSARY_TERM_MAX, GLOSSARY_DEFINITION_MAX)));
      const entry = { term: name, variants: parseVariants(interaction.fields.getTextInputValue('variants'), name), definition };
      const terms = await ctx.repos.listGlossary(guildId);
      if (action === 'glossaryEditSubmit') {
        const current = await term();
        if (!(await ctx.repos.updateGlossaryTerm(guildId, current.id, entry, interaction.user.id))) return show('glossary', noticeText('error', t.glossaryClash(name)), { glossary: { selected: current.id, page: await pageOfTerm() } });
        return show('glossary', noticeText('success', t.glossaryUpdated(name)), { glossary: { selected: current.id, page: await pageOfTerm() } });
      }
      if (terms.some((x) => x.key === glossaryKey(name))) return show('glossary', noticeText('error', t.glossaryClash(name)));
      if (terms.length >= GLOSSARY_MAX_TERMS) return show('glossary', noticeText('error', t.glossaryFull(GLOSSARY_MAX_TERMS)));
      await ctx.repos.upsertGlossary(guildId, [entry], interaction.user.id);
      const added = (await ctx.repos.listGlossary(guildId)).find((x) => x.key === glossaryKey(name));
      return show('glossary', noticeText('success', t.glossaryAdded(name)), { glossary: { selected: added?.id, page: added ? await pageOfTerm(added.id) : 0 } });
    }
    case 'glossaryImportSubmit': {
      if (!interaction.isModalSubmit()) return;
      const { entries, errors } = parseGlossaryImport(interaction.fields.getTextInputValue('lines'));
      // Plafond : les termes déjà présents sont toujours mis à jour ; les nouveaux, dans la limite.
      const known = new Set((await ctx.repos.listGlossary(guildId)).map((x) => x.key));
      let room = GLOSSARY_MAX_TERMS - known.size;
      const accepted = entries.filter((e) => known.has(glossaryKey(e.term)) || room-- > 0);
      const result = await ctx.repos.upsertGlossary(guildId, accepted, interaction.user.id);
      const lines = [noticeText('success', t.glossaryImported(result.added, result.updated))];
      if (accepted.length < entries.length) lines.push(noticeText('warn', t.glossaryImportSkipped(entries.length - accepted.length, GLOSSARY_MAX_TERMS)));
      if (errors.length) lines.push(noticeText('warn', t.glossaryImportErrors(errors.slice(0, 10).map((e) => `${e.line} (${t.glossaryImportReasons[e.reason]})`).join(', ') + (errors.length > 10 ? '…' : ''))));
      return show('glossary', lines.join('\n'));
    }
    case 'glossaryDelete': {
      const current = await term();
      return show('glossary', t.glossaryDeleteAsk(current.term), { glossary: { selected: current.id, confirmDelete: true, page: await pageOfTerm() } });
    }
    case 'glossaryDeleteConfirm': {
      const current = await term();
      await ctx.repos.deleteGlossaryTerm(guildId, current.id);
      return show('glossary', noticeText('success', t.glossaryDeleted(current.term)), { glossary: { page: await pageOfTerm() } });
    }
    case 'glossaryExport': {
      if (!interaction.isButton()) return;
      const terms = await ctx.repos.listGlossary(guildId);
      const text = terms.map((g) => formatGlossaryLine({ term: g.term, variants: g.variants, definition: g.definition })).join('\n');
      await interaction.reply({
        content: noticeText('success', t.glossaryExportReady(terms.length)),
        files: [{ attachment: Buffer.from(`${text}\n`, 'utf8'), name: 'glossaire.txt' }],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // ---------------------------------------------------------------- serveurs de résumé
    case 'llmPick': {
      if (!interaction.isStringSelectMenu()) return;
      return show('summary', undefined, { llmSelected: Number(interaction.values[0]) });
    }
    case 'llmCancel':
      return show('summary', undefined, { llmSelected: serverId });
    case 'llmAdd':
    case 'llmEdit': {
      if (!interaction.isButton()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const editing = action === 'llmEdit' ? await server() : null;
      if (!editing && (await ctx.repos.listLlmBackends(guildId)).length >= MAX_LLM_SERVERS) return show('summary', t.llmFull(MAX_LLM_SERVERS));
      const name = new TextInputBuilder().setCustomId('name').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true).setPlaceholder('pc-salon');
      const url = new TextInputBuilder().setCustomId('url').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true).setPlaceholder('http://192.168.0.11:1234/v1');
      const model = new TextInputBuilder().setCustomId('model').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false);
      const key = new TextInputBuilder().setCustomId('key').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false);
      if (editing) {
        name.setValue(editing.name);
        url.setValue(editing.url);
        model.setValue(editing.model);
      }
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(editing ? encode({ type: 'cfg', action: 'llmSubmit', arg: `s.${editing.id}` }) : encode({ type: 'cfg', action: 'llmAddSubmit' }))
          .setTitle(editing ? t.llmModalEdit : t.llmModalAdd)
          .addLabelComponents(
            new LabelBuilder().setLabel(t.llmNameField).setTextInputComponent(name),
            new LabelBuilder().setLabel(t.llmUrlField).setDescription(t.llmUrlHint).setTextInputComponent(url),
            new LabelBuilder().setLabel(t.llmModelField).setDescription(t.llmModelHint).setTextInputComponent(model),
            new LabelBuilder().setLabel(t.llmKeyField).setDescription(editing ? t.llmKeyHint : t.llmKeyNewHint).setTextInputComponent(key),
          ),
      );
      return;
    }
    case 'llmAddSubmit':
    case 'llmSubmit': {
      if (!interaction.isModalSubmit()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const editing = action === 'llmSubmit' ? await server() : null;
      const name = interaction.fields.getTextInputValue('name').trim();
      const url = interaction.fields.getTextInputValue('url').trim().replace(/\/+$/, '');
      const model = interaction.fields.getTextInputValue('model').trim();
      const keyInput = interaction.fields.getTextInputValue('key').trim();
      if (!name) return show('summary', noticeText('error', m.errors.titleRequired));
      if (!/^https?:\/\/[^\s/]+/.test(url)) return show('summary', noticeText('error', m.transcriptionConfig.badUrl));
      try {
        await assertUrlAllowed(url, ctx.config.ai.allowedHosts);
      } catch (err) {
        return show('summary', noticeText('error', err instanceof Error ? err.message : String(err)));
      }
      const others = (await ctx.repos.listLlmBackends(guildId)).filter((r) => r.id !== editing?.id);
      if (others.some((r) => r.name === name)) return show('summary', noticeText('error', t.llmExists(name)));
      // Clé chiffrée en base ; changer d'hôte sans ressaisir la clé l'efface (elle ne part pas vers un autre serveur).
      const sameHost = editing !== null && hostOf(editing.url) === hostOf(url);
      const apiKey = keyInput && keyInput !== '-' ? encryptSecret(keyInput) : keyInput !== '-' && sameHost ? editing.apiKey : null;
      await interaction.deferUpdate();
      const yaml = ctx.config.guild(guildId).llm;
      let row = editing;
      if (editing) await ctx.repos.updateLlmBackend(guildId, editing.id, { name, url, model: model || editing.model, apiKey });
      else row = await ctx.repos.addLlmBackend({ guildId, name, url, model: model || yaml.model, apiKey });
      row = (await ctx.repos.listLlmBackends(guildId)).find((r) => r.id === row!.id)!;
      // La liste des modèles s'affiche d'emblée : un formulaire ne peut pas la proposer.
      const llm = llmRowToConfig(row, yaml);
      let models: string[] = [];
      let listError: string | undefined;
      try {
        models = await listModels(llm, ctx.config.ai.allowedHosts);
      } catch (err) {
        listError = err instanceof Error ? err.message : String(err);
      }
      if (!model) return show('summary', `${t.saved}\n${listError ? t.llmTestKo(listError) : models.length ? t.pickModelNow : t.noModels}`, { llmSelected: row.id, models });
      const result = await testLlm(llm, ctx.config.ai.allowedHosts);
      return show('summary', `${t.saved}\n${result.ok ? t.llmTestOk(result.ms!, result.model!) : t.llmTestKo(result.error!)}`, { llmSelected: row.id, models });
    }
    case 'llmModels': {
      if (!interaction.isButton()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      await interaction.deferUpdate();
      try {
        const models = await listModels(llmRowToConfig(row, ctx.config.guild(guildId).llm), ctx.config.ai.allowedHosts);
        return show('summary', models.length ? undefined : t.noModels, { llmSelected: row.id, models });
      } catch (err) {
        return show('summary', noticeText('error', err instanceof Error ? err.message : String(err)), { llmSelected: row.id });
      }
    }
    case 'llmModel': {
      if (!interaction.isStringSelectMenu()) return;
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      await ctx.repos.updateLlmBackend(guildId, row.id, { model: interaction.values[0] ?? row.model });
      return show('summary', t.saved, { llmSelected: row.id });
    }
    case 'llmUp': {
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      const ids = (await ctx.repos.listLlmBackends(guildId)).map((r) => r.id);
      const at = ids.indexOf(row.id);
      if (at > 0) await ctx.repos.reorderLlmBackends(guildId, [...ids.slice(0, at - 1), row.id, ids[at - 1]!, ...ids.slice(at + 1)]);
      return show('summary', t.saved, { llmSelected: row.id });
    }
    case 'llmToggleServer': {
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      await ctx.repos.updateLlmBackend(guildId, row.id, { enabled: !row.enabled });
      return show('summary', t.saved, { llmSelected: row.id });
    }
    case 'llmThinking': {
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      await ctx.repos.updateLlmBackend(guildId, row.id, { thinking: !row.thinking });
      return show('summary', row.thinking ? t.llmThinkingOff(row.name) : t.llmThinkingOn(row.name), { llmSelected: row.id });
    }
    case 'llmDelete': {
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      return show('summary', t.llmDeleteAsk(row.name), { llmSelected: row.id, llmConfirmDelete: true });
    }
    case 'llmDeleteConfirm': {
      if (!isOwner) throw new UserError(m.backendPanel.ownersOnly);
      const row = await server();
      await ctx.repos.removeLlmBackend(guildId, row.id);
      const left = await ctx.repos.listLlmBackends(guildId);
      return show('summary', left.length ? t.llmDeleted(row.name) : `${t.llmDeleted(row.name)}\n${t.llmBackToYaml}`);
    }
    case 'llmTest':
    case 'llmTestAll': {
      if (!interaction.isButton()) return;
      await interaction.deferUpdate();
      const yaml = ctx.config.guild(guildId).llm;
      const rows = await ctx.repos.listLlmBackends(guildId);
      const targets = action === 'llmTest' && Number.isFinite(serverId) ? rows.filter((r) => r.id === serverId) : rows.filter((r) => r.enabled);
      if (targets.length === 0) {
        // Pas de liste dans /config : le serveur du fichier de configuration.
        const { servers } = await effectiveLlms(ctx.repos, await ctx.settings.get(guildId), ctx.config);
        const lines = await Promise.all(servers.map(async (sv) => `**${sv.name}** · ${formatTest(await testLlm(sv.config, ctx.config.ai.allowedHosts), t)}`));
        return show('summary', lines.join('\n') || t.summaryNone);
      }
      const lines = await Promise.all(targets.map(async (r) => `**${r.name}** · ${formatTest(await testLlm(llmRowToConfig(r, yaml), ctx.config.ai.allowedHosts), t)}`));
      return show('summary', lines.join('\n'), Number.isFinite(serverId) ? { llmSelected: serverId } : {});
    }
    case 'llmToggle': {
      const settings = await ctx.settings.get(guildId);
      if (settings.llmEnabled) return show('summary', t.llmDisableAsk, { confirmLlmDisable: true });
      await ctx.repos.updateSettings(guildId, { llmEnabled: true });
      return show('summary', t.saved);
    }
    case 'llmDisableConfirm': {
      await ctx.repos.updateSettings(guildId, { llmEnabled: false });
      return show('summary', t.saved);
    }
    case 'llmReset':
      // Ancien bouton (un seul serveur) : la liste le remplace.
      return show('summary');

    case 'toggleAutoRecord': {
      const settings = await ctx.settings.get(guildId);
      await ctx.repos.updateSettings(guildId, { autoRecordDefault: !settings.autoRecordDefault });
      return show('recording', t.saved);
    }
  }
}

/** Catégorie du forum des réunions (emplacement par défaut des salons temporaires). */
function forumParent(guild: Guild, forumId: string | null): string | null {
  return (forumId && guild.channels.cache.get(forumId)?.parentId) || null;
}

/** Le bot peut-il écrire dans ce salon (voir le salon, y envoyer des messages) ? */
function canPost(channel: Channel): boolean {
  if (!('guild' in channel) || !('permissionsFor' in channel)) return true;
  const me = channel.guild.members.me;
  return !me || channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
}

/** Permissions qui manquent au bot pour créer des salons dans la catégorie (ou à la racine du serveur). */
function voiceCategoryProblem(guild: Guild, categoryId: string | null, m: Messages): string | null {
  const me = guild.members.me;
  const category = categoryId ? guild.channels.cache.get(categoryId) : null;
  const perms = category && me ? category.permissionsFor(me) : (me?.permissions ?? null);
  const needed = { ManageChannels: PermissionFlagsBits.ManageChannels, ViewChannel: PermissionFlagsBits.ViewChannel };
  const missing = Object.entries(needed)
    .filter(([, flag]) => !perms?.has(flag))
    .map(([name]) => name);
  if (missing.length === 0) return null;
  const where = category ? `<#${category.id}>` : m.config.voiceCategoryForum;
  return m.config.voiceCategoryPermissions(where, missing.join(', '));
}
