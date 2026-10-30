import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import { AGENDA_DETAIL_MAX, AGENDA_TITLE_MAX, canEditItem, checkAddItem, moveItem } from '../../domain/agenda.js';
import { encode, type Action, type DraftType } from '../../domain/customId.js';
import { NOTE_KINDS, nextPoint, type NoteKind } from '../../domain/markers.js';
import { canReschedule, isOpen } from '../../domain/meeting.js';
import { canCreateMeeting } from '../../domain/permissions.js';
import { messages, type Messages } from '../../i18n/index.js';
import { UserError } from '../../lib/errors.js';
import { truncate } from '../../lib/text.js';
import { actorOf } from '../actor.js';
import { renderAgendaManager } from '../embeds/meetingCard.js';
import { OFF_AGENDA } from '../embeds/recordingControl.js';
import { fetchForum } from '../threads.js';
import { agendaItemModal, duplicateModal, meetingModal, readAgendaItemModal, readDuplicateModal, readMeetingDraft, readMeetingModal, type MeetingDraft } from '../modals.js';
import { renderMeetingManager } from '../embeds/meetingManager.js';
import { inviteSummary, nextInviteState } from '../embeds/invite.js';
import { renderSlotChoice } from '../embeds/datePoll.js';
import { askInvites, handleDraft } from './creation.js';
import { formatWhen } from '../../domain/time.js';
import type { MeetingRow } from '../../db/schema.js';
import { meetingScope, replyEphemeral, replyNotice, requireManager, type MeetingScope } from './common.js';
import { confirmPrompt } from '../ui/buttons.js';
import { noticeContainer, noticeText } from '../ui/notice.js';
import { Accent } from '../ui/palette.js';
import { handleDatePoll, type PollAction } from './datePoll.js';

export type ComponentInteraction =
  | ButtonInteraction<'cached'>
  | StringSelectMenuInteraction<'cached'>
  | RoleSelectMenuInteraction<'cached'>
  | UserSelectMenuInteraction<'cached'>
  | ModalSubmitInteraction<'cached'>;

/** Traite un bouton, menu ou formulaire dont le customId a été décodé. */
export async function handleAction(
  ctx: AppContext,
  interaction: ComponentInteraction,
  rawAction: Exclude<Action, { type: 'tx' } | { type: 'cfg' } | { type: 'consent.open' } | { type: 'consent.refuse' } | { type: 'consent.accept' }>,
): Promise<void> {
  if (rawAction.type === 'meeting.create') {
    if (!interaction.isButton()) return;
    return showCreateModal(ctx, interaction);
  }
  if (rawAction.type === 'meeting.createSubmit') {
    if (!interaction.isModalSubmit()) return;
    return createSubmit(ctx, interaction);
  }
  if (rawAction.type === 'meeting.createRetry') {
    if (!interaction.isButton()) return;
    return showCreateModal(ctx, interaction, drafts.take(interaction.user.id, 'create'));
  }
  if (rawAction.type.startsWith('poll.')) return handleDatePoll(ctx, interaction, rawAction as PollAction);
  if (rawAction.type.startsWith('draft.')) return handleDraft(ctx, interaction, rawAction as { type: DraftType; draftId: string });

  // Actions portant sur une réunion existante.
  const action = rawAction as Exclude<typeof rawAction, PollAction | { type: DraftType; draftId: string } | { type: 'meeting.create' | 'meeting.createSubmit' | 'meeting.createRetry' }>;
  const scope = await meetingScope(ctx, interaction, action.meetingId);
  const { meeting, m } = scope;

  switch (action.type) {
    case 'rsvp': {
      if (!interaction.isButton()) return;
      if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
      if (meeting.status === 'polling') throw new UserError(m.datePoll.answerFirst);
      // Second clic sur la réponse déjà donnée : elle est retirée.
      const current = (await ctx.repos.listRsvps(meeting.id)).find((r) => r.userId === interaction.user.id)?.status;
      if (current === action.status) await ctx.repos.deleteRsvp(meeting.id, interaction.user.id);
      else await ctx.repos.setRsvp(meeting.id, interaction.user.id, action.status);
      ctx.cards.refresh(meeting.id, ['card']);
      await replyNotice(interaction, 'success', current === action.status ? m.replies.rsvpRemoved : m.replies.rsvpSaved(m.rsvp[action.status]));
      return;
    }

    case 'agenda.add': {
      if (!interaction.isButton()) return;
      if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
      if (meeting.agendaLocked && !scope.canManage) throw new UserError(m.errors.agendaLocked);
      await interaction.showModal(agendaItemModal(m, encode({ type: 'agenda.addSubmit', meetingId: meeting.id })));
      return;
    }

    case 'agenda.addSubmit': {
      if (!interaction.isModalSubmit()) return;
      const input = readAgendaItemModal(interaction);
      const item = await ctx.repos.addAgendaItem(meeting.id, interaction.user.id, (count, locked) => {
        const check = checkAddItem({ ...input, count, locked, meetingOpen: isOpen(meeting.status), actorIsManager: scope.canManage });
        if (!check.ok) throw new UserError(agendaError(scope, check.error));
        return { title: check.title, detail: check.detail };
      });
      ctx.cards.refresh(meeting.id, ['agenda']);
      await replyNotice(interaction, 'success', m.replies.itemAdded(item.title));
      return;
    }

    case 'agenda.manage': {
      if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
      // « Annuler » depuis le panneau privé : le panneau est remis à jour (pas un second message).
      if (interaction.isButton() && interaction.message.flags.has(MessageFlags.Ephemeral)) {
        await updateManager(ctx, interaction, scope, null);
        return;
      }
      // Gestionnaires : tout l'ODJ. Les autres : leurs propres points, tant que l'ODJ est ouvert.
      if (!scope.canManage) {
        if (meeting.agendaLocked) throw new UserError(m.errors.agendaLocked);
        const own = (await ctx.repos.listAgenda(meeting.id)).filter((i) => i.authorId === interaction.user.id);
        if (own.length === 0) throw new UserError(m.agendaManager.noOwnItems);
        await interaction.reply({ ...renderAgendaManager(meeting, own, null, m, 'author'), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
        return;
      }
      const agenda = await ctx.repos.listAgenda(meeting.id);
      await interaction.reply({ ...renderAgendaManager(meeting, agenda, null, m), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      return;
    }

    case 'agenda.read':
    case 'agenda.readSelect': {
      // Lecture d'un point en entier (ordre du jour trop long pour tout afficher) : ouvert à tous, en privé.
      const agenda = await ctx.repos.listAgenda(meeting.id);
      if (agenda.length === 0) throw new UserError(m.card.agendaEmpty);
      const picked = interaction.isStringSelectMenu() ? agenda.findIndex((i) => String(i.id) === interaction.values[0]) : -1;
      const select = new StringSelectMenuBuilder()
        .setCustomId(encode({ type: 'agenda.readSelect', meetingId: meeting.id }))
        .setPlaceholder(m.card.readPick)
        .addOptions(agenda.slice(0, 25).map((item, i) => ({ label: truncate(`${i + 1}. ${item.title}`, 100), value: String(item.id), default: i === picked, ...(item.detail.trim() ? { description: truncate(item.detail.trim().replace(/\s*\n\s*/g, ' '), 100) } : {}) })));
      const item = picked >= 0 ? agenda[picked]! : null;
      const content = item ? m.card.readItem(picked + 1, item.title, item.authorId, item.detail.trim()) : m.card.readPick;
      const panel = new ContainerBuilder()
        .setAccentColor(Accent.brand)
        .addTextDisplayComponents((t) => t.setContent(truncate(`## 📖 ${m.buttons.readItem}\n-# ${truncate(meeting.title, 120)}\n${content}`, 3800)))
        .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
      const payload = { components: [panel.toJSON()], flags: MessageFlags.IsComponentsV2 as const, allowedMentions: { parse: [] } };
      if (interaction.isStringSelectMenu()) await interaction.update(payload);
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      return;
    }

    case 'agenda.select': {
      if (!interaction.isStringSelectMenu()) return;
      const selected = Number(interaction.values[0]);
      await updateManager(ctx, interaction, scope, Number.isInteger(selected) ? selected : null);
      return;
    }

    case 'agenda.edit': {
      if (!interaction.isButton()) return;
      const item = (await ctx.repos.listAgenda(meeting.id)).find((i) => i.id === action.itemId);
      if (!item) throw new UserError(m.errors.agendaItemGone);
      const allowed = canEditItem({ actorIsManager: scope.canManage, isAuthor: item.authorId === interaction.user.id, locked: meeting.agendaLocked, meetingOpen: isOpen(meeting.status) });
      if (!allowed) throw new UserError(meeting.agendaLocked ? m.errors.agendaLocked : m.errors.forbidden);
      await interaction.showModal(agendaItemModal(m, encode({ type: 'agenda.editSubmit', meetingId: meeting.id, itemId: item.id }), item));
      return;
    }

    case 'agenda.editSubmit': {
      if (!interaction.isModalSubmit()) return;
      const item = (await ctx.repos.listAgenda(meeting.id)).find((i) => i.id === action.itemId);
      if (!item) throw new UserError(m.errors.agendaItemGone);
      const allowed = canEditItem({ actorIsManager: scope.canManage, isAuthor: item.authorId === interaction.user.id, locked: meeting.agendaLocked, meetingOpen: isOpen(meeting.status) });
      if (!allowed) throw new UserError(meeting.agendaLocked ? m.errors.agendaLocked : m.errors.forbidden);
      const input = readAgendaItemModal(interaction);
      const title = input.title.trim().slice(0, AGENDA_TITLE_MAX);
      if (!title) throw new UserError(m.errors.agendaEmptyTitle);
      await ctx.repos.updateAgendaItem(meeting.id, item.id, { title, detail: input.detail.trim().slice(0, AGENDA_DETAIL_MAX) });
      ctx.cards.refresh(meeting.id, ['agenda']);
      await replyNotice(interaction, 'success', m.replies.itemUpdated(title));
      return;
    }

    case 'agenda.remove': {
      // Retrait : confirmation d'abord (rien ne permet de récupérer un point retiré).
      if (!interaction.isButton()) return;
      requireManager(scope);
      await updateManager(ctx, interaction, scope, action.itemId, true);
      return;
    }

    case 'agenda.move':
    case 'agenda.removeConfirm': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
      const items = await ctx.repos.listAgenda(meeting.id);
      const ids = items.map((i) => i.id);
      if (!ids.includes(action.itemId)) throw new UserError(m.errors.agendaItemGone);
      if (action.type === 'agenda.move') {
        const next = moveItem(ids, action.itemId, action.direction);
        if (next) await ctx.repos.reorderAgenda(meeting.id, next);
        await updateManager(ctx, interaction, scope, action.itemId);
      } else {
        await ctx.repos.reorderAgenda(
          meeting.id,
          ids.filter((id) => id !== action.itemId),
        );
        const removed = items.find((i) => i.id === action.itemId)!;
        await updateManager(ctx, interaction, scope, null, false, noticeText('success', m.agendaManager.removed(removed.title)));
      }
      ctx.cards.refresh(meeting.id, ['agenda']);
      return;
    }

    case 'agenda.lock': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      const updated = await ctx.repos.updateMeeting(meeting.id, { agendaLocked: action.locked });
      await updateManager(ctx, interaction, { ...scope, meeting: updated ?? meeting }, null);
      ctx.cards.refresh(meeting.id, ['agenda']);
      return;
    }

    case 'report.correct': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'report.correctSubmit', meetingId: meeting.id }))
          .setTitle(m.report.correctModal)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(m.report.correctField)
              .setDescription(m.report.correctHint)
              .setTextInputComponent(new TextInputBuilder().setCustomId('correction').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)),
          ),
      );
      return;
    }

    case 'report.correctSubmit': {
      if (!interaction.isModalSubmit()) return;
      requireManager(scope);
      const correction = interaction.fields.getTextInputValue('correction').trim();
      // Toujours enregistrée, même pendant un traitement (une autre correction en cours) : le
      // résumé en cours est relancé pour tenir compte de toutes les consignes.
      if (!(await ctx.repos.addCorrection(meeting.id, correction))) throw new UserError(m.report.correctNoSummary);
      const outcome = await ctx.pipeline.requestRegeneration(meeting.id, interaction.user.id);
      await replyNotice(interaction, 'success', m.pipeline.correctionNotice(m.pipeline.regeneration[outcome]!));
      return;
    }

    case 'report.regen': {
      // Le compte rendu publié sera remplacé : confirmation d'abord (message privé).
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.reply({
        components: [
          confirmPrompt(
            m.report.regenAsk,
            { id: encode({ type: 'report.regenConfirm', meetingId: meeting.id }), label: m.report.regenConfirm, emoji: '🔄' },
            { id: encode({ type: 'meeting.dismiss', meetingId: meeting.id }), label: m.buttons.cancel },
          ),
        ],
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
      return;
    }

    case 'report.regenConfirm': {
      // Nouveau résumé à partir de la même transcription, sans consigne supplémentaire.
      if (!interaction.isButton()) return;
      requireManager(scope);
      if (ctx.recordings.isRecording(meeting.id)) throw new UserError(m.errors.alreadyRecording);
      const outcome = await ctx.pipeline.requestRegeneration(meeting.id, interaction.user.id);
      await interaction.update({ components: [noticeContainer('success', m.pipeline.regenerationNotice(m.pipeline.regeneration[outcome]!))] });
      return;
    }

    // ---------------------------------------------------------------- organisateur

    case 'meeting.organizer': {
      // Choix du nouvel organisateur (à la place du panneau « Gérer »).
      if (!interaction.isButton()) return;
      requireManager(scope);
      if (meeting.status === 'cancelled') throw new UserError(m.errors.meetingClosed);
      const panel = new ContainerBuilder()
        .setAccentColor(Accent.brand)
        .addTextDisplayComponents((t) => t.setContent(`## 👤 ${m.manage.organizerTitle}\n-# ${truncate(meeting.title, 120)}\n${m.manage.organizerCurrent(meeting.organizerId)}`))
        .addActionRowComponents(
          new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
            new UserSelectMenuBuilder().setCustomId(encode({ type: 'meeting.organizerSelect', meetingId: meeting.id })).setPlaceholder(m.manage.organizerPick).setMinValues(1).setMaxValues(1),
          ),
        )
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(encode({ type: 'meeting.manage', meetingId: meeting.id })).setLabel(m.manage.back).setEmoji('↩️').setStyle(ButtonStyle.Secondary),
          ),
        );
      await interaction.update({ components: [panel.toJSON()], allowedMentions: { parse: [] } });
      return;
    }

    case 'meeting.organizerSelect': {
      if (!interaction.isUserSelectMenu()) return;
      requireManager(scope);
      const chosen = interaction.users.first();
      if (!chosen) return;
      if (chosen.bot) throw new UserError(m.manage.organizerBot);
      if (chosen.id === meeting.organizerId) throw new UserError(m.manage.organizerSame);
      await interaction.update({
        components: [
          confirmPrompt(
            m.manage.organizerAsk(meeting.title, chosen.id),
            { id: encode({ type: 'organizer.confirm', meetingId: meeting.id, userId: chosen.id }), label: m.manage.organizerConfirm, emoji: '👤' },
            { id: encode({ type: 'meeting.manage', meetingId: meeting.id }), label: m.buttons.cancel },
          ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    case 'organizer.confirm': {
      if (!interaction.isButton()) return;
      requireManager(scope); // revérifié : les droits ont pu changer depuis le choix
      const updated = await ctx.meetings.transferOrganizer(meeting.id, action.userId, interaction.user.id);
      await interaction.update({ components: [await managerPanel(ctx, updated, { notice: noticeText('success', m.manage.organizerDone(action.userId)) })], allowedMentions: { parse: [] } });
      return;
    }

    case 'meeting.dismiss': {
      // « Annuler » d'une confirmation : le message privé l'indique, rien n'est fait.
      if (!interaction.isButton()) return;
      await interaction.update({ components: [noticeContainer('info', m.buttons.cancelled)] });
      return;
    }

    case 'report.retry': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await ctx.pipeline.retry(meeting.id);
      await replyNotice(interaction, 'success', m.pipeline.retried); // le message de suivi se met à jour de lui-même
      return;
    }

    case 'report.retryNow': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await ctx.pipeline.retryNow(meeting.id);
      await replyNotice(interaction, 'success', m.pipeline.retriedNow);
      return;
    }

    case 'rec.start': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // la connexion au vocal peut prendre plusieurs secondes
      await ctx.meetings.ensureVoice(meeting.id); // salon temporaire : créé à la demande s'il n'existe pas encore
      await ctx.recordings.start(meeting.id, interaction.user.id);
      await replyNotice(interaction, 'success', m.recording.started_reply);
      return;
    }

    case 'rec.stop': {
      // Couper l'enregistrement en pleine réunion : confirmation d'abord (message privé, ou à la
      // place du panneau « Gérer »).
      if (!interaction.isButton()) return;
      requireManager(scope);
      const prompt = confirmPrompt(
        m.recording.stopAsk,
        { id: encode({ type: 'rec.stopConfirm', meetingId: meeting.id }), label: m.recording.stopConfirm, emoji: '⏹️' },
        { id: encode({ type: 'meeting.dismiss', meetingId: meeting.id }), label: m.buttons.cancel },
      );
      if (interaction.message.flags.has(MessageFlags.Ephemeral)) await interaction.update({ components: [prompt] });
      else await interaction.reply({ components: [prompt], flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      return;
    }

    case 'rec.stopConfirm': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.deferUpdate();
      const stopped = await ctx.recordings.stop(meeting.id, 'manual', interaction.user.id);
      // Déjà arrêté (redémarrage du bot, autre clic) : le message à boutons est remis à jour.
      if (!stopped) await ctx.recordings.syncControl(meeting.id);
      await interaction.editReply({ components: [noticeContainer(stopped ? 'success' : 'info', stopped ? m.recording.stopped_reply : m.recording.alreadyStopped)] });
      return;
    }

    // ---------------------------------------------------------------- repères en direct

    case 'rec.next':
    case 'rec.goto': {
      // Passage au point suivant (ou au point choisi) : réservé à l'animateur (organisateur, gestionnaire).
      if (action.type === 'rec.next' ? !interaction.isButton() : !interaction.isStringSelectMenu()) return;
      requireManager(scope);
      if (!(await ctx.repos.getActiveRecording(meeting.id))) {
        await ctx.recordings.syncControl(meeting.id); // message resté d'avant un arrêt (redémarrage)
        throw new UserError(m.control.notRecording);
      }
      const agenda = await ctx.repos.listAgenda(meeting.id);
      let target: number | null;
      if (interaction.isStringSelectMenu()) {
        const value = interaction.values[0] ?? '';
        target = value === OFF_AGENDA ? null : (agenda.find((a) => String(a.id) === value)?.id ?? null);
      } else {
        target = nextPoint(agenda, await ctx.repos.listMarkers(meeting.id));
      }
      // Le suivi se met à jour sur place : pas d'accusé privé (l'animateur en accumulerait un par point).
      await interaction.deferUpdate();
      await ctx.repos.addMarker({ meetingId: meeting.id, kind: 'agenda', at: new Date(), agendaItemId: target, authorId: interaction.user.id });
      await ctx.recordings.syncControl(meeting.id);
      return;
    }

    case 'rec.note': {
      if (!interaction.isButton()) return;
      if (!(await ctx.repos.getActiveRecording(meeting.id))) {
        await ctx.recordings.syncControl(meeting.id); // message resté d'avant un arrêt (redémarrage)
        throw new UserError(m.control.notRecording);
      }
      const c = m.control;
      const kind = new StringSelectMenuBuilder()
        .setCustomId('kind')
        .addOptions(NOTE_KINDS.map((k) => ({ label: c.noteKinds[k]!, value: k, default: k === 'note' })));
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'rec.noteSubmit', meetingId: meeting.id }))
          .setTitle(c.noteModal)
          .addLabelComponents(
            new LabelBuilder().setLabel(c.noteKind).setStringSelectMenuComponent(kind),
            new LabelBuilder().setLabel(c.noteText).setTextInputComponent(new TextInputBuilder().setCustomId('text').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)),
            new LabelBuilder().setLabel(c.noteWho).setTextInputComponent(new TextInputBuilder().setCustomId('who').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false)),
          ),
      );
      return;
    }

    case 'rec.noteSubmit': {
      if (!interaction.isModalSubmit()) return;
      // Horodatée à l'envoi du formulaire. Une note arrivée juste après l'arrêt est gardée : elle
      // tombe à la fin de la transcription.
      const value = interaction.fields.getStringSelectValues('kind')[0];
      const kind: NoteKind = NOTE_KINDS.includes(value as NoteKind) ? (value as NoteKind) : 'note';
      const who = interaction.fields.getTextInputValue('who').trim();
      await ctx.repos.addMarker({
        meetingId: meeting.id,
        kind,
        at: new Date(),
        text: interaction.fields.getTextInputValue('text').trim(),
        who: kind === 'action' && who ? who : null,
        authorId: interaction.user.id,
      });
      await replyNotice(interaction, 'success', m.control.noteSaved);
      await ctx.recordings.syncControl(meeting.id);
      return;
    }

    // ---------------------------------------------------------------- panneau « Gérer »

    case 'meeting.manage': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      const payload = { components: [await managerPanel(ctx, meeting)] };
      // Ouvert depuis la carte : nouveau message privé ; « Retour » depuis le panneau : mise à jour.
      if (interaction.message.flags.has(MessageFlags.Ephemeral)) await interaction.update(payload);
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      return;
    }

    case 'meeting.roles':
    case 'meeting.everyone':
    case 'meeting.default':
    case 'meeting.none': {
      requireManager(scope);
      if (meeting.status !== 'scheduled' && meeting.status !== 'polling') throw new UserError(m.errors.meetingClosed);
      const verb = action.type.split('.')[1] as 'roles' | 'everyone' | 'default' | 'none';
      if (verb === 'roles' ? !interaction.isRoleSelectMenu() : !interaction.isButton()) return;
      const selected = interaction.isRoleSelectMenu() ? [...interaction.roles.keys()] : [];
      const next = nextInviteState({ roleIds: meeting.targetRoleIds, none: meeting.inviteNone }, interaction.guildId, verb, selected, scope.settings.nudgeRoleId);
      await interaction.deferUpdate();
      await ctx.meetings.inviteRoles(interaction.guild, meeting.id, next.roleIds, next.none);
      const updated = (await ctx.repos.getMeeting(meeting.id)) ?? meeting;
      const summary = inviteSummary(next, interaction.guildId, scope.settings.nudgeRoleId, m);
      await interaction.editReply({ components: [await managerPanel(ctx, updated, { notice: noticeText('success', m.invite.updated(summary)) })], allowedMentions: { parse: [] } });
      return;
    }

    case 'meeting.reslot':
    case 'meeting.reslotSelect': {
      // Réunion issue d'un sondage, date déjà fixée : rebasculer sur un autre créneau proposé.
      requireManager(scope);
      if (meeting.status !== 'scheduled') throw new UserError(m.errors.meetingClosed);
      if (action.type === 'meeting.reslot') {
        if (!interaction.isButton()) return;
        const choices = (await ctx.meetings.slotChoices(meeting)).filter((c) => !c.past).sort((a, b) => b.yes - a.yes || b.maybe - a.maybe);
        if (choices.length === 0) throw new UserError(m.datePoll.allSlotsPast);
        await interaction.update({ components: [renderSlotChoice(meeting, choices, 'reslot', m)], allowedMentions: { parse: [] } });
        return;
      }
      if (!interaction.isStringSelectMenu()) return;
      const slot = (await ctx.repos.listSlots(meeting.id)).find((x) => String(x.id) === interaction.values[0]);
      if (!slot) throw new UserError(m.datePoll.slotGone);
      await interaction.deferUpdate();
      // Même chemin qu'une modification : inscrits prévenus du report, rappels et événement replanifiés.
      const updated = await ctx.meetings.update(
        interaction.guild,
        meeting,
        { title: meeting.title, description: meeting.description, startsAt: slot.startsAt, durationMin: slot.durationMin, voiceChannelId: meeting.voiceChannelId },
        interaction.user.id,
      );
      await interaction.editReply({ components: [await managerPanel(ctx, updated, { notice: m.datePoll.reslotDone })], allowedMentions: { parse: [] } });
      return;
    }

    case 'meeting.autoRecord': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await ctx.meetings.setAutoRecord(meeting.id, !meeting.autoRecord);
      const updated = (await ctx.repos.getMeeting(meeting.id)) ?? meeting;
      await interaction.update({ components: [await managerPanel(ctx, updated, { notice: m.recording.autoSet(updated.autoRecord) })] });
      return;
    }

    case 'meeting.end': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.update({ components: [await managerPanel(ctx, meeting, { confirmEnd: true, notice: m.manage.endAsk })] });
      return;
    }

    case 'meeting.endConfirm': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.deferUpdate();
      const ok = await ctx.meetings.end(meeting.id, interaction.user.id);
      const updated = (await ctx.repos.getMeeting(meeting.id)) ?? meeting;
      await interaction.editReply({ components: [await managerPanel(ctx, updated, { notice: ok ? m.replies.ended : m.errors.meetingClosed })] });
      return;
    }

    case 'meeting.cancel': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(encode({ type: 'meeting.cancelSubmit', meetingId: meeting.id }))
          .setTitle(m.manage.cancelModal)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(m.manage.cancelReason)
              .setDescription(m.manage.cancelReasonHint)
              .setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false)),
          ),
      );
      return;
    }

    case 'meeting.cancelSubmit': {
      if (!interaction.isModalSubmit()) return;
      requireManager(scope);
      const reason = interaction.fields.getTextInputValue('reason').trim() || null;
      const ok = await ctx.meetings.cancel(meeting.id, interaction.user.id, reason);
      await replyNotice(interaction, ok ? 'success' : 'error', ok ? m.replies.cancelled : m.errors.meetingClosed);
      return;
    }

    case 'meeting.duplicate': {
      if (!interaction.isButton()) return;
      if (!canCreateMeeting(scope.actor, scope.settings)) throw new UserError(m.errors.cannotCreate);
      await interaction.showModal(
        duplicateModal(m, {
          customId: encode({ type: 'meeting.duplicateSubmit', meetingId: meeting.id }),
          timezone: scope.settings.timezone,
          locale: scope.settings.locale,
          startsAt: meeting.startsAt,
          durationMin: meeting.durationMin,
          title: meeting.title,
          description: meeting.description,
        }),
      );
      return;
    }

    case 'meeting.duplicateSubmit': {
      if (!interaction.isModalSubmit()) return;
      if (!canCreateMeeting(scope.actor, scope.settings)) throw new UserError(m.errors.cannotCreate);
      const input = readDuplicateModal(interaction, m, scope.settings.timezone, meeting.durationMin);
      await askInvites(ctx, interaction, {
        kind: 'meeting',
        title: input.title,
        when: formatWhen(input.startsAt, scope.settings.timezone, scope.settings.locale, m.format.when),
        create: () =>
          ctx.meetings.create(
            interaction.guild,
            interaction.user.id,
            // Un salon temporaire appartient à la réunion d'origine (il sera supprimé) : la copie ne le reprend pas.
            { title: input.title, description: input.description, startsAt: input.startsAt, durationMin: input.durationMin, voiceChannelId: meeting.voiceTemporary ? null : meeting.voiceChannelId },
            input.copyAgenda ? { copyAgendaFrom: meeting.id } : {},
          ),
      });
      return;
    }

    case 'meeting.regenAll': {
      // Long et coûteux (GPU) : confirmation d'abord.
      if (!interaction.isButton()) return;
      requireManager(scope);
      await interaction.update({ components: [await managerPanel(ctx, meeting, { confirmRegenAll: true, notice: m.manage.regenAllAsk })] });
      return;
    }

    case 'meeting.regen':
    case 'meeting.regenAllConfirm': {
      if (!interaction.isButton()) return;
      requireManager(scope);
      const retranscribe = action.type === 'meeting.regenAllConfirm';
      const recordings = await ctx.repos.listRecordingsForMeeting(meeting.id);
      let notice: string;
      if (recordings.length === 0) notice = m.pipeline.nothing;
      else if (ctx.recordings.isRecording(meeting.id)) notice = m.errors.alreadyRecording;
      // Tout retranscrire pendant un traitement : refusé (la transcription en cours serait refaite).
      else if (retranscribe && ctx.pipeline.isQueued(meeting.id)) notice = m.pipeline.running_reply;
      else if (!retranscribe) notice = m.pipeline.regenerationNotice(m.pipeline.regeneration[await ctx.pipeline.requestRegeneration(meeting.id, interaction.user.id)]!);
      else if (recordings.some((r) => r.purgedAt)) {
        const purged = recordings.find((r) => r.purgedAt)!;
        notice = m.pipeline.purged(formatWhen(purged.purgedAt!, scope.settings.timezone, scope.settings.locale, m.format.when));
      } else {
        await ctx.pipeline.regenerate(meeting.id, retranscribe, interaction.user.id);
        notice = m.pipeline.scheduled;
      }
      await interaction.update({ components: [await managerPanel(ctx, meeting, { notice })] });
      return;
    }

    case 'meeting.edit': {
      if (!interaction.isButton()) return;
      await showEditModal(interaction, scope);
      return;
    }

    case 'meeting.editSubmit': {
      if (!interaction.isModalSubmit()) return;
      requireManager(scope);
      await withDraft(interaction, m, meeting.id, encode({ type: 'meeting.editRetry', meetingId: meeting.id }), async () => {
        const input = readMeetingModal(interaction, m, {
          timezone: scope.settings.timezone,
          defaultDurationMin: scope.settings.defaultDurationMin,
          fixedVoiceChannelId: scope.settings.voiceChannelId,
          autoVoice: scope.settings.autoVoice,
          reschedulable: canReschedule(meeting.status),
          current: meeting,
        });
        await ctx.meetings.update(interaction.guild, meeting, input, interaction.user.id);
        await replyNotice(interaction, 'success', m.replies.updated);
      });
      return;
    }

    case 'meeting.editRetry': {
      if (!interaction.isButton()) return;
      await showEditModal(interaction, scope, drafts.take(interaction.user.id, meeting.id));
      return;
    }
  }
}

/** Ouvre le formulaire de modification (panneau « Gérer » → Modifier). */
export async function showEditModal(interaction: ButtonInteraction<'cached'> | ChatInputCommandInteraction<'cached'>, scope: MeetingScope, draft?: MeetingDraft): Promise<void> {
  requireManager(scope);
  const { meeting, m } = scope;
  if (!isOpen(meeting.status)) throw new UserError(m.errors.meetingClosed);
  await interaction.showModal(
    meetingModal(m, {
      customId: encode({ type: 'meeting.editSubmit', meetingId: meeting.id }),
      heading: m.modal.editTitle,
      reschedulable: canReschedule(meeting.status),
      timezone: scope.settings.timezone,
      locale: scope.settings.locale,
      defaultDurationMin: scope.settings.defaultDurationMin,
      fixedVoiceChannelId: scope.settings.voiceChannelId,
      autoVoice: scope.settings.autoVoice,
      defaults: meeting,
      ...(draft ? { draft } : {}),
    }),
  );
}

/** Ouvre le formulaire de création (bouton « Nouvelle réunion » du post épinglé). */
export async function showCreateModal(
  ctx: AppContext,
  interaction: ButtonInteraction<'cached'>,
  draft?: MeetingDraft,
): Promise<void> {
  const settings = await ctx.settings.get(interaction.guildId);
  const m = messages(settings.locale);
  if (!canCreateMeeting(actorOf(interaction), settings)) throw new UserError(m.errors.cannotCreate);
  if (!settings.forumChannelId || !(await fetchForum(ctx.client, settings.forumChannelId))) throw new UserError(m.errors.forumNotConfigured);
  await interaction.showModal(
    meetingModal(m, {
      customId: encode({ type: 'meeting.createSubmit' }),
      heading: m.modal.createTitle,
      reschedulable: true,
      timezone: settings.timezone,
      locale: settings.locale,
      defaultDurationMin: settings.defaultDurationMin,
      fixedVoiceChannelId: settings.voiceChannelId,
      autoVoice: settings.autoVoice,
      defaults: {},
      ...(draft ? { draft } : {}),
    }),
  );
}

async function createSubmit(ctx: AppContext, interaction: ModalSubmitInteraction<'cached'>): Promise<void> {
  const settings = await ctx.settings.get(interaction.guildId);
  const m = messages(settings.locale);
  await withDraft(interaction, m, 'create', encode({ type: 'meeting.createRetry' }), async () => {
    const input = readMeetingModal(interaction, m, {
      timezone: settings.timezone,
      reschedulable: true,
      defaultDurationMin: settings.defaultDurationMin,
      fixedVoiceChannelId: settings.voiceChannelId,
      autoVoice: settings.autoVoice,
    });
    // Rien n'est créé avant le choix « Qui inviter ? » ; « Modifier la saisie » rouvre le formulaire prérempli.
    drafts.save(interaction.user.id, 'create', readMeetingDraft(interaction));
    await askInvites(ctx, interaction, {
      kind: 'meeting',
      title: input.title,
      when: formatWhen(input.startsAt, settings.timezone, settings.locale, m.format.when),
      retryId: encode({ type: 'meeting.createRetry' }),
      create: () => ctx.meetings.create(interaction.guild, interaction.user.id, input),
    });
  });
}

/** Saisies refusées, gardées 10 minutes par personne pour rouvrir le formulaire tel quel. */
const drafts = new (class {
  private readonly entries = new Map<string, { draft: MeetingDraft; at: number }>();
  save(userId: string, key: string, draft: MeetingDraft): void {
    const now = Date.now();
    for (const [k, v] of this.entries) if (now - v.at > 10 * 60_000) this.entries.delete(k);
    this.entries.set(`${userId}:${key}`, { draft, at: now });
  }
  take(userId: string, key: string): MeetingDraft | undefined {
    const entry = this.entries.get(`${userId}:${key}`);
    return entry && Date.now() - entry.at <= 10 * 60_000 ? entry.draft : undefined;
  }
})();

/**
 * Formulaire refusé (date illisible, salon manquant…) : au lieu de tout faire ressaisir, on
 * garde la saisie et on propose de rouvrir le formulaire prérempli.
 */
async function withDraft(interaction: ModalSubmitInteraction<'cached'>, m: Messages, key: string, retryId: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    drafts.save(interaction.user.id, key, readMeetingDraft(interaction));
    const retry = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(retryId).setLabel(m.modal.retry).setEmoji('✏️').setStyle(ButtonStyle.Primary));
    const payload = { content: noticeText('error', err.message), components: [retry], allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

/** Panneau « Gérer » d'une réunion. */
async function managerPanel(ctx: AppContext, meeting: MeetingRow, state: { confirmEnd?: boolean; confirmRegenAll?: boolean; notice?: string } = {}) {
  const m = await ctx.settings.messages(meeting.guildId);
  const hasRecording = (await ctx.repos.listRecordingsForMeeting(meeting.id)).length > 0;
  const nudgeRoleId = (await ctx.settings.get(meeting.guildId)).nudgeRoleId;
  const pollSlots = meeting.status === 'scheduled' && (await ctx.repos.listSlots(meeting.id)).length > 1;
  return renderMeetingManager(meeting, { hasRecording, recording: ctx.recordings.isRecording(meeting.id), nudgeRoleId, pollSlots, ...state }, m);
}

async function updateManager(
  ctx: AppContext,
  interaction: ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'>,
  scope: MeetingScope,
  selectedId: number | null,
  confirmRemove = false,
  notice?: string,
): Promise<void> {
  const all = await ctx.repos.listAgenda(scope.meeting.id);
  const agenda = scope.canManage ? all : all.filter((i) => i.authorId === interaction.user.id);
  await interaction.update({
    ...renderAgendaManager(scope.meeting, agenda, selectedId, scope.m, scope.canManage ? 'manager' : 'author', confirmRemove, notice),
    allowedMentions: { parse: [] },
  });
}

function agendaError(scope: MeetingScope, error: 'locked' | 'full' | 'empty' | 'closed'): string {
  const e = scope.m.errors;
  return { locked: e.agendaLocked, full: e.agendaFull, empty: e.agendaEmptyTitle, closed: e.meetingClosed }[error];
}
