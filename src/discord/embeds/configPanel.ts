import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  RoleSelectMenuBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  type APIContainerComponent,
} from 'discord.js';
import type { GuildSettingsRow } from '../../db/schema.js';
import { channelPage, type ChannelInfo } from '../../domain/channelChoices.js';
import { encode, type CfgAction } from '../../domain/customId.js';
import { GLOSSARY_MAX_TERMS } from '../../domain/glossary.js';
import { formatOffset } from '../../domain/reminders.js';
import type { StorageProvider } from '../../domain/storage.js';
import type { Messages } from '../../i18n/index.js';
import { Accent } from '../ui/palette.js';

export const CONFIG_SECTIONS = ['forum', 'voice', 'roles', 'reminders', 'general', 'recording', 'transcription', 'summary', 'glossary', 'storage', 'alerts'] as const;
export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

export interface ConfigContext {
  settings: GuildSettingsRow;
  /** Salons proposés dans la section ouverte (forum, vocal ou alertes) et page affichée. */
  channels?: { list: readonly ChannelInfo[]; page: number };
  /** Résumé des serveurs de transcription (« 2 actifs : vibe-pc, speaches »). */
  transcription: string;
  /** LLM des résumés effectivement utilisé. */
  llm?: {
    source: 'discord' | 'yaml';
    enabled: boolean;
    /** Serveurs de résumé par priorité (sans id : ceux du fichier de configuration). */
    servers: ReadonlyArray<{ id?: number; name: string; url: string; model: string; enabled: boolean; hasKey: boolean; thinking?: boolean }>;
  };
  /** Serveur de résumé sélectionné (ses actions s'affichent) et suppression demandée. */
  llmSelected?: number | undefined;
  llmConfirmDelete?: boolean;
  /** Modèles proposés par le serveur LLM (après « Choisir le modèle »). */
  models?: readonly string[];
  /** Personnes qui refusent l'enregistrement (section Enregistrement). */
  refusals?: readonly string[];
  /** Propriétaire du bot : peut modifier les adresses appelées par le bot. */
  canEditAi?: boolean;
  /** Désactivation du résumé demandée : bouton de confirmation. */
  confirmLlmDisable?: boolean;
  /** Mode « salon imposé » choisi, salon pas encore désigné. */
  voiceMode?: VoiceMode;
  /** Stockage du serveur : services proposés, celui connecté, connexion en cours. */
  storage?: {
    available: readonly StorageProvider[];
    /** Services configurés mais indisponibles : APP_SECRET_KEY absente. */
    needsSecretKey?: boolean;
    connected?: { provider: StorageProvider; account: string; folder: string; rootUrl?: string | null; lastOkAt: Date | null; lastError: string | null } | undefined;
    /** Connexion par code (Google, OneDrive) ou par lien (Dropbox) en cours. */
    pending?: { provider: StorageProvider; url: string; code?: string } | undefined;
    confirmDisconnect?: boolean;
  };
  /** Forum choisi : la création de posts est-elle réservée au bot ? (undefined : forum introuvable). */
  forumPostsReserved?: boolean | undefined;
  /** Permissions qui manquent au bot sur le forum choisi (vérifiées à chaque ouverture). */
  forumMissing?: readonly string[];
  /** Glossaire du serveur : termes, page du menu, terme choisi, suppression demandée. */
  glossary?: {
    terms: ReadonlyArray<{ id: number; term: string; variants: readonly string[]; definition: string }>;
    page?: number;
    selected?: number | undefined;
    confirmDelete?: boolean;
  };
  /** Version du bot en cours d'exécution (pied de l'accueil). */
  version?: { version: string; commit: string };
  notice?: string | undefined;
}

export type VoiceMode = 'free' | 'fixed' | 'auto';
export const VOICE_LEADS_MIN = [5, 10, 15, 30, 60] as const;

export function voiceModeOf(s: GuildSettingsRow): VoiceMode {
  return s.autoVoice ? 'auto' : s.voiceChannelId ? 'fixed' : 'free';
}

/** Termes par page du menu du glossaire (limite des menus Discord). */
const GLOSSARY_PAGE = 25;

const cfg = (action: CfgAction, arg?: string) => encode(arg === undefined ? { type: 'cfg', action } : { type: 'cfg', action, arg });
const btn = (action: CfgAction, label: string, emoji: string, style = ButtonStyle.Secondary) =>
  (emoji ? new ButtonBuilder().setEmoji(emoji) : new ButtonBuilder()).setCustomId(cfg(action)).setLabel(label).setStyle(style);

function role(id: string | null, m: Messages): string {
  return id ? `<@&${id}>` : `*${m.config.none}*`;
}

/** Valeur courante de chaque section, en une ligne (accueil et en-tête des sections). */
export function sectionSummary(section: ConfigSection, c: ConfigContext, m: Messages): string {
  const s = c.settings;
  const t = m.config;
  switch (section) {
    case 'forum':
      return s.forumChannelId ? `<#${s.forumChannelId}>` : `*${t.none}*`;
    case 'voice':
      if (s.autoVoice) return t.voiceAutoSummary(s.autoVoiceLeadMin, s.autoVoiceCategoryId);
      return s.voiceChannelId ? `<#${s.voiceChannelId}> · ${t.voiceImposed}` : `*${t.voiceFree}*`;
    case 'roles':
      return `${t.managerRole} ${s.managerRoleIds.length ? s.managerRoleIds.map((id) => `<@&${id}>`).join(' ') : `*${t.none}*`} · ${t.nudgeRole} ${s.nudgeRoleId === s.guildId ? t.everyone : role(s.nudgeRoleId, m)}`;
    case 'reminders':
      return s.reminderOffsetsMin.length ? s.reminderOffsetsMin.map(formatOffset).join(', ') : `*${t.none}*`;
    case 'general':
      return `${s.timezone} · ${m.card.minutes(s.defaultDurationMin)} · ${s.creatorsRestricted ? t.creatorsManagers : t.creatorsAll}`;
    case 'recording':
      return `${s.autoRecordDefault ? t.autoOn : t.autoOff} · ${t.refusals(c.refusals?.length ?? 0)}`;
    case 'transcription':
      return c.transcription;
    case 'glossary':
      return c.glossary?.terms.length ? t.glossaryCount(c.glossary.terms.length) : `*${t.none}*`;
    case 'alerts':
      return s.alertChannelId ? `<#${s.alertChannelId}>` : `*${t.none}*`;
    case 'storage': {
      const st = c.storage;
      if (st?.connected) return t.storageSummary(t.storageProviders[st.connected.provider]!, st.connected.account, st.connected.folder);
      return st?.available.length ? `*${t.storageNone}*` : `*${st?.needsSecretKey ? t.storageNeedsKey : t.storageUnavailable}*`;
    }
    case 'summary': {
      const l = c.llm;
      if (!l || !l.enabled) return t.summaryOff;
      const active = l.servers.filter((sv) => sv.enabled);
      if (active.length === 0) return t.summaryNone;
      // Ordre de bascule : le premier répond, les suivants prennent le relais.
      return `${active.map((sv) => `${sv.model} (${sv.name})`).join(' → ')}${l.source === 'yaml' ? ` *(${t.fromYaml})*` : ''}`;
    }
  }
}

/** Accueil : tous les réglages en un coup d'œil, et le choix de la section à modifier. */
export function renderConfigHome(c: ConfigContext, m: Messages): APIContainerComponent {
  const t = m.config;
  const lines = CONFIG_SECTIONS.map((sec) => `${t.sections[sec].emoji} **${t.sections[sec].label}** · ${sectionSummary(sec, c, m)}`);
  const select = new StringSelectMenuBuilder()
    .setCustomId(cfg('section'))
    .setPlaceholder(t.pick)
    .addOptions(CONFIG_SECTIONS.map((sec) => ({ label: t.sections[sec].label, value: sec, emoji: t.sections[sec].emoji, description: t.sections[sec].hint })));
  // Ce qui manque pour que le bot serve vraiment, dans l'ordre où le faire.
  const s = c.settings;
  const todo = [
    !s.forumChannelId && t.todo.forum,
    !s.alertChannelId && t.todo.alerts,
    s.managerRoleIds.length === 0 && t.todo.managers,
  ].filter((x): x is string => Boolean(x));
  const container = new ContainerBuilder()
    .setAccentColor(todo.length && !s.forumChannelId ? Accent.pending : Accent.brand)
    .addTextDisplayComponents((x) => x.setContent(`## ⚙️ ${t.title}${c.notice ? `\n${c.notice}` : ''}`));
  if (todo.length) container.addTextDisplayComponents((x) => x.setContent(`**${t.todo.title}**\n${todo.map((line, i) => `${i + 1}. ${line}`).join('\n')}`));
  container
    .addSeparatorComponents((x) => x.setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents((x) => x.setContent(lines.join('\n')))
    .addActionRowComponents((row: ActionRowBuilder<StringSelectMenuBuilder>) => row.addComponents(select));
  if (c.version) container.addTextDisplayComponents((x) => x.setContent(`-# ${t.version(c.version!.version, c.version!.commit)}`));
  return container.toJSON();
}

/** Vue d'une section : explication, valeur actuelle, contrôles, retour. */
export function renderConfigSection(section: Exclude<ConfigSection, 'transcription'>, c: ConfigContext, m: Messages): APIContainerComponent {
  const t = m.config;
  const s = c.settings;
  const meta = t.sections[section];
  const container = new ContainerBuilder()
    .setAccentColor(Accent.brand)
    .addTextDisplayComponents((x) =>
      x.setContent(`## ${meta.emoji} ${meta.label}\n${meta.help.split('\n').map((line) => `-# ${line}`).join('\n')}\n\n${t.current} : ${sectionSummary(section, c, m)}${c.notice ? `\n\n${c.notice}` : ''}`),
    )
    .addSeparatorComponents((x) => x.setSpacing(SeparatorSpacingSize.Small));
  if (section === 'recording' && c.refusals?.length) {
    container.addTextDisplayComponents((x) => x.setContent(`${t.refusalsList}\n${c.refusals!.slice(0, 60).map((id) => `<@${id}>`).join(' ')}`));
  }

  const rows: Array<
    ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<RoleSelectMenuBuilder> | ActionRowBuilder<ChannelSelectMenuBuilder>
  > = [];

  /** Liste « Catégorie › #salon » (les homonymes se distinguent), paginée par 25. */
  function channelRows(action: 'forum' | 'voice' | 'alerts', current: string | null, placeholder: string, prefix: string) {
    const page = channelPage(c.channels?.list ?? [], c.channels?.page ?? 0, prefix);
    const out: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [];
    if (page.options.length === 0) return out;
    out.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(cfg(action))
          .setPlaceholder(page.pages > 1 ? `${placeholder} (${t.page(page.page + 1, page.pages)})` : placeholder)
          .addOptions(page.options.map((o) => ({ ...o, default: o.value === current }))),
      ),
    );
    if (page.pages > 1) {
      out.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          btn('page', t.previous, '◀️').setCustomId(cfg('page', `${action}.${Math.max(0, page.page - 1)}`)).setDisabled(page.page === 0),
          btn('page', t.next, '▶️').setCustomId(cfg('page', `${action}.${Math.min(page.pages - 1, page.page + 1)}`)).setDisabled(page.page >= page.pages - 1),
        ),
      );
    }
    return out;
  }
  switch (section) {
    case 'forum':
      rows.push(...channelRows('forum', s.forumChannelId, t.pickForum, '#'));
      if (c.forumMissing?.length) container.addTextDisplayComponents((x) => x.setContent(`⚠️ ${m.errors.forumPermissions(c.forumMissing!.join(', '))}`));
      if (s.forumChannelId && c.forumPostsReserved !== undefined) {
        container.addTextDisplayComponents((x) => x.setContent(c.forumPostsReserved ? t.postsReserved : t.postsOpen));
        rows.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            c.forumPostsReserved ? btn('forumPosts', t.postsOpenButton, '🔓') : btn('forumPosts', t.postsReserveButton, '🔒', ButtonStyle.Primary),
          ),
        );
      }
      break;
    case 'voice': {
      const mode = c.voiceMode ?? voiceModeOf(s);
      rows.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(cfg('voiceMode'))
            .addOptions(
              { label: t.voiceModes.free, value: 'free', emoji: '🔓', default: mode === 'free' },
              { label: t.voiceModes.fixed, value: 'fixed', emoji: '📌', default: mode === 'fixed' },
              { label: t.voiceModes.auto, value: 'auto', emoji: '🪄', description: t.voiceModes.autoHint, default: mode === 'auto' },
            ),
        ),
      );
      if (mode === 'fixed') rows.push(...channelRows('voice', s.voiceChannelId, t.pickVoice, '🔊 '));
      if (mode === 'auto') {
        const category = new ChannelSelectMenuBuilder()
          .setCustomId(cfg('voiceCategory'))
          .setChannelTypes(ChannelType.GuildCategory)
          .setPlaceholder(t.pickVoiceCategory)
          .setMinValues(0)
          .setMaxValues(1);
        if (s.autoVoiceCategoryId) category.setDefaultChannels(s.autoVoiceCategoryId);
        rows.push(
          new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(category),
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(cfg('voiceLead'))
              .addOptions(VOICE_LEADS_MIN.map((min) => ({ label: t.voiceLead(min), value: String(min), default: min === s.autoVoiceLeadMin }))),
          ),
        );
      }
      break;
    }
    case 'roles': {
      const roleSelect = (action: CfgAction, current: readonly string[], placeholder: string, max: number) => {
        const select = new RoleSelectMenuBuilder().setCustomId(cfg(action)).setPlaceholder(placeholder).setMinValues(0).setMaxValues(max);
        if (current.length) select.setDefaultRoles(...current);
        return new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select);
      };
      // @everyone n'est jamais proposé par les sélecteurs de Discord : bouton à part pour la relance
      // (seuls ceux qui n'ont pas répondu sont mentionnés, un par un).
      const everyone = s.nudgeRoleId === s.guildId;
      rows.push(
        roleSelect('roleManager', s.managerRoleIds, t.pickManager, 5),
        roleSelect('roleNudge', s.nudgeRoleId && !everyone ? [s.nudgeRoleId] : [], t.pickNudge, 1),
        new ActionRowBuilder<ButtonBuilder>().addComponents(btn('roleNudgeEveryone', everyone ? t.nudgeEveryoneOff : t.nudgeEveryoneOn, '📣')),
      );
      break;
    }
    case 'reminders':
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(btn('remindersEdit', t.editReminders, '✏️', ButtonStyle.Primary)));
      break;
    case 'general':
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          btn('generalEdit', t.editGeneral, '✏️', ButtonStyle.Primary),
          btn('toggleCreators', s.creatorsRestricted ? t.openCreation : t.restrictCreation, s.creatorsRestricted ? '🔓' : '🔒'),
        ),
      );
      break;
    case 'alerts': {
      rows.push(...channelRows('alerts', s.alertChannelId, t.pickAlerts, '#'));
      if (s.alertChannelId) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(btn('alertsTest', t.alertsTest, '🧪'), btn('alertsClear', t.alertsClear, '🔕')));
      }
      break;
    }
    case 'storage': {
      const st = c.storage;
      if (st?.pending) {
        const name = t.storageProviders[st.pending.provider]!;
        container.addTextDisplayComponents((x) => x.setContent(st.pending!.code ? t.storageDevice(name, st.pending!.url, st.pending!.code) : t.storageDropbox));
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(st.pending.url).setLabel(t.storageOpenPage).setEmoji('🌐'));
        if (!st.pending.code) row.addComponents(btn('storageCode', t.storageEnterCode, '🔑', ButtonStyle.Primary));
        row.addComponents(btn('storageCancel', t.storageCancel, ''));
        rows.push(row);
        break;
      }
      if (st?.connected) {
        const movable = st.connected.provider !== 'dropbox';
        container.addTextDisplayComponents((x) =>
          x.setContent(`${t.storageStatus(st.connected!.folder, st.connected!.lastOkAt, st.connected!.lastError)}${movable ? `\n-# ${t.storageMoveHint}` : ''}`),
        );
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(btn('storageTest', t.storageTest, '🧪'), btn('storageFolder', t.storageFolder, '📁'));
        if (st.connected.rootUrl?.startsWith('https://')) {
          rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(st.connected.rootUrl).setLabel(t.storageOpenFolder).setEmoji('📂')));
        }
        if (st.confirmDisconnect) {
          container.addTextDisplayComponents((x) => x.setContent(`⚠️ ${t.storageDisconnectAsk}`));
          row.addComponents(btn('storageDisconnectConfirm', t.storageDisconnectConfirm, '🔌', ButtonStyle.Danger));
        } else {
          row.addComponents(btn('storageDisconnect', t.storageDisconnect, '🔌'));
        }
        rows.push(row);
        break;
      }
      if (st?.needsSecretKey) container.addTextDisplayComponents((x) => x.setContent(`⚠️ ${t.storageNeedsKey}`));
      if (st?.available.length) {
        container.addTextDisplayComponents((x) => x.setContent(t.storagePickHint));
        rows.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            st.available.map((p) =>
              new ButtonBuilder()
                .setCustomId(cfg('storageConnect', `p.${p}`))
                .setLabel(t.storageConnect(t.storageProviders[p]!))
                .setEmoji(t.storageEmoji[p]!)
                .setStyle(ButtonStyle.Primary),
            ),
          ),
        );
      }
      break;
    }
    case 'summary': {
      const l = c.llm;
      const canEdit = c.canEditAi ?? false;
      const servers = l?.servers ?? [];
      const list = servers.length
        ? servers.map((sv, i) => `${sv.enabled ? '🟢' : '⚪'} **${i + 1}. ${sv.name}** · ${sv.model}${sv.hasKey ? ' · 🔑' : ''}${sv.thinking ? ` · 🧠 ${t.llmThinkingShort}` : ''}${canEdit ? `\n-# \`${sv.url.slice(0, 120)}\`` : ''}`).join('\n')
        : t.llmNoServer;
      container.addTextDisplayComponents((x) => x.setContent(`${list}${l?.source === 'yaml' && servers.length ? `\n-# ${t.llmFromYaml}` : ''}`));
      const listed = servers.filter((sv): sv is typeof sv & { id: number } => sv.id !== undefined);
      const selected = listed.find((sv) => sv.id === c.llmSelected);
      if (listed.length) {
        rows.push(
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(cfg('llmPick'))
              .setPlaceholder(t.llmPick)
              .addOptions(listed.map((sv, i) => ({ label: `${i + 1}. ${sv.name}`.slice(0, 100), value: String(sv.id), description: sv.model.slice(0, 100), default: sv.id === selected?.id }))),
          ),
        );
      }
      if (selected) {
        const arg = `s.${selected.id}`;
        const at = listed.indexOf(selected);
        if (c.llmConfirmDelete) {
          rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              btn('llmDeleteConfirm', t.llmDeleteConfirm, '🗑️', ButtonStyle.Danger).setCustomId(cfg('llmDeleteConfirm', arg)),
              btn('llmCancel', t.llmCancel, '').setCustomId(cfg('llmCancel', arg)),
            ),
          );
        } else {
          const actions = new ActionRowBuilder<ButtonBuilder>();
          if (canEdit) {
            actions.addComponents(
              btn('llmEdit', t.llmEdit, '✏️', ButtonStyle.Primary).setCustomId(cfg('llmEdit', arg)),
              btn('llmUp', t.llmUp, '⬆️').setCustomId(cfg('llmUp', arg)).setDisabled(at === 0),
              btn('llmToggleServer', selected.enabled ? t.llmServerOff : t.llmServerOn, selected.enabled ? '⏸️' : '▶️').setCustomId(cfg('llmToggleServer', arg)),
            );
          }
          actions.addComponents(btn('llmTest', t.llmTest, '🧪').setCustomId(cfg('llmTest', arg)));
          if (canEdit) actions.addComponents(btn('llmDelete', t.llmDelete, '🗑️', ButtonStyle.Danger).setCustomId(cfg('llmDelete', arg)));
          rows.push(actions);
          if (canEdit) {
            // Réflexion du modèle (qwen3…) : désactivée par défaut, plus rapide pour un résumé.
            rows.push(
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                btn('llmThinking', selected.thinking ? t.llmThinkingDisable : t.llmThinkingEnable, '🧠').setCustomId(cfg('llmThinking', arg)),
              ),
            );
            if (c.models?.length) {
              rows.push(
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                  new StringSelectMenuBuilder()
                    .setCustomId(cfg('llmModel', arg))
                    .setPlaceholder(t.pickModel)
                    .addOptions(c.models.slice(0, 25).map((id) => ({ label: id.slice(0, 100), value: id.slice(0, 100), default: id === selected.model }))),
                ),
              );
            } else {
              rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(btn('llmModels', t.llmModels, '📋').setCustomId(cfg('llmModels', arg))));
            }
          }
        }
      }
      const general = new ActionRowBuilder<ButtonBuilder>();
      if (canEdit) general.addComponents(btn('llmAdd', t.llmAdd, '➕', ButtonStyle.Success).setDisabled(listed.length >= 5));
      if (servers.length) general.addComponents(btn('llmTestAll', t.llmTestAll, '🧪'));
      // Désactiver le résumé se confirme (les prochains comptes rendus n'auront plus que l'audio et la transcription).
      if (c.confirmLlmDisable) general.addComponents(btn('llmDisableConfirm', t.llmDisableConfirm, '⏸️', ButtonStyle.Danger));
      else general.addComponents(btn('llmToggle', l?.enabled === false ? t.llmEnable : t.llmDisable, l?.enabled === false ? '▶️' : '⏸️'));
      rows.push(general);
      break;
    }
    case 'glossary': {
      const g = c.glossary;
      const terms = g?.terms ?? [];
      const pages = Math.max(1, Math.ceil(terms.length / GLOSSARY_PAGE));
      const page = Math.min(g?.page ?? 0, pages - 1);
      const selected = terms.find((x) => x.id === g?.selected);
      if (selected) {
        container.addTextDisplayComponents((x) =>
          x.setContent(`**${selected.term}**\n${selected.definition}${selected.variants.length ? `\n-# ${t.glossaryVariantsField.replace(/ \(.*\)$/, '')} : ${selected.variants.join(', ')}` : ''}`),
        );
      }
      if (terms.length) {
        const shown = terms.slice(page * GLOSSARY_PAGE, (page + 1) * GLOSSARY_PAGE);
        rows.push(
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(cfg('glossaryPick', `gp.${page}`))
              .setPlaceholder(pages > 1 ? t.glossaryPickPage(page + 1, pages) : t.glossaryPick)
              .addOptions(shown.map((x) => ({ label: x.term.slice(0, 100), value: String(x.id), description: x.definition.slice(0, 100), default: x.id === selected?.id }))),
          ),
        );
        if (pages > 1) {
          rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              btn('glossaryPage', t.previous, '◀️').setCustomId(cfg('glossaryPage', `gp.${Math.max(0, page - 1)}`)).setDisabled(page === 0),
              btn('glossaryPage', t.next, '▶️').setCustomId(cfg('glossaryPage', `gp.${page + 1}`)).setDisabled(page >= pages - 1),
            ),
          );
        }
      }
      if (selected) {
        const arg = `g.${selected.id}`;
        rows.push(
          g?.confirmDelete
            ? new ActionRowBuilder<ButtonBuilder>().addComponents(
                btn('glossaryDeleteConfirm', t.glossaryDeleteConfirm, '🗑️', ButtonStyle.Danger).setCustomId(cfg('glossaryDeleteConfirm', arg)),
                btn('glossaryCancel', m.buttons.cancel, '').setCustomId(cfg('glossaryCancel', arg)),
              )
            : new ActionRowBuilder<ButtonBuilder>().addComponents(
                btn('glossaryEdit', t.glossaryEdit, '✏️').setCustomId(cfg('glossaryEdit', arg)),
                btn('glossaryDelete', t.glossaryDelete, '🗑️', ButtonStyle.Danger).setCustomId(cfg('glossaryDelete', arg)),
              ),
        );
      }
      const general = new ActionRowBuilder<ButtonBuilder>().addComponents(
        btn('glossaryAdd', t.glossaryAdd, '➕', ButtonStyle.Primary).setDisabled(terms.length >= GLOSSARY_MAX_TERMS),
        btn('glossaryImport', t.glossaryImport, '📥'),
      );
      if (terms.length) general.addComponents(btn('glossaryExport', t.glossaryExport, '📤'));
      rows.push(general);
      break;
    }
    case 'recording':
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          btn('toggleAutoRecord', s.autoRecordDefault ? t.disableAuto : t.enableAuto, s.autoRecordDefault ? '⏸️' : '🔴', s.autoRecordDefault ? ButtonStyle.Secondary : ButtonStyle.Primary),
        ),
      );
      break;
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(btn('home', t.back, '↩️')));
  for (const row of rows) container.addActionRowComponents(row as ActionRowBuilder<ButtonBuilder>);
  return container.toJSON();
}
