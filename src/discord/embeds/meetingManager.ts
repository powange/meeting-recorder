import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, type APIContainerComponent } from 'discord.js';
import { encode, type Action } from '../../domain/customId.js';
import { isOpen } from '../../domain/meeting.js';
import type { MeetingStatus } from '../../domain/types.js';
import type { Messages } from '../../i18n/index.js';
import { inviteControls, inviteSummary } from './invite.js';
import { Accent } from '../ui/palette.js';

export interface ManagerState {
  /** Une session d'enregistrement existe : le compte rendu peut être régénéré. */
  hasRecording: boolean;
  /** Clôture demandée : bouton de confirmation. */
  confirmEnd?: boolean;
  /** « Tout retranscrire » demandé : bouton de confirmation (long, occupe le serveur de transcription). */
  confirmRegenAll?: boolean;
  /** Enregistrement en cours : bouton Arrêter au lieu d'Enregistrer. */
  recording?: boolean;
  notice?: string | undefined;
  /** Rôle relancé de /config (bouton « Par défaut » des invitations). */
  nudgeRoleId?: string | null;
  /** Réunion issue d'un sondage (plusieurs créneaux) : on peut rebasculer sur un autre créneau. */
  pollSlots?: boolean;
}

type MeetingAction = Extract<Action, { meetingId: string }>['type'];

/** Panneau « Gérer » d'une réunion (organisateur et gestionnaires) : remplace les sous-commandes /reunion. */
export function renderMeetingManager(
  meeting: { id: string; title: string; status: MeetingStatus; autoRecord: boolean; guildId?: string; targetRoleIds?: readonly string[]; inviteNone?: boolean },
  state: ManagerState,
  m: Messages,
): APIContainerComponent {
  const g = m.manage;
  const open = isOpen(meeting.status);
  const button = (type: MeetingAction, label: string, emoji: string, style = ButtonStyle.Secondary) =>
    (emoji ? new ButtonBuilder().setEmoji(emoji) : new ButtonBuilder()).setCustomId(encode({ type, meetingId: meeting.id } as Action)).setLabel(label).setStyle(style);

  const container = new ContainerBuilder()
    .setAccentColor(Accent.brand)
    .addTextDisplayComponents((t) =>
      t.setContent(`## ⚙️ ${g.title}\n-# ${meeting.title} · ${m.status[meeting.status]}${state.notice ? `\n\n${state.notice}` : ''}`),
    );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  // Sondage de date : modifier le texte, fixer la date, gérer les créneaux, annuler.
  if (meeting.status === 'polling') {
    const p = m.datePoll;
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button('poll.fix', p.fixDate, '📅', ButtonStyle.Primary),
        button('poll.add', p.addSlot, '➕'),
        button('poll.remove', p.removeSlot, '➖'),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button('meeting.edit', g.edit, '✏️'),
        button('meeting.organizer', g.organizer, '👤'),
        button('meeting.cancel', g.cancel, '❌', ButtonStyle.Danger),
      ),
    );
    for (const row of rows) container.addActionRowComponents(row);
    addInvites(container, meeting, state, m);
    return container.toJSON();
  }
  const main = new ActionRowBuilder<ButtonBuilder>();
  if (open) main.addComponents(button('meeting.edit', g.edit, '✏️'));
  main.addComponents(button('meeting.duplicate', g.duplicate, '📄'));
  // Passer la main (toute réunion sauf annulée : une réunion close garde son compte rendu à corriger).
  if (meeting.status !== 'cancelled') main.addComponents(button('meeting.organizer', g.organizer, '👤'));
  if (open) main.addComponents(button('meeting.autoRecord', meeting.autoRecord ? g.autoOff : g.autoOn, meeting.autoRecord ? '⏸️' : '🔴'));
  rows.push(main);
  if (open && meeting.status === 'scheduled' && state.pollSlots) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button('meeting.reslot', m.datePoll.reslot, '🗳️')));
  // Enregistrer à tout moment, même avant l'heure ou avant que quelqu'un rejoigne le vocal.
  if (open) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        state.recording ? button('rec.stop', g.recStop, '⏹️', ButtonStyle.Danger) : button('rec.start', g.recStart, '🔴', ButtonStyle.Primary),
      ),
    );
  }

  if (open) {
    rows.push(
      state.confirmEnd
        ? new ActionRowBuilder<ButtonBuilder>().addComponents(
            button('meeting.endConfirm', g.endConfirm, '⏹️', ButtonStyle.Danger),
            button('meeting.manage', m.buttons.cancel, ''),
          )
        : new ActionRowBuilder<ButtonBuilder>().addComponents(button('meeting.end', g.end, '⏹️'), button('meeting.cancel', g.cancel, '❌', ButtonStyle.Danger)),
    );
  }
  if (state.hasRecording) {
    rows.push(
      state.confirmRegenAll
        ? new ActionRowBuilder<ButtonBuilder>().addComponents(
            button('meeting.regenAllConfirm', g.regenAllConfirm, '🔁', ButtonStyle.Danger),
            button('meeting.manage', m.buttons.cancel, ''),
          )
        : new ActionRowBuilder<ButtonBuilder>().addComponents(button('meeting.regen', g.regen, '🔄'), button('meeting.regenAll', g.regenAll, '🔁')),
    );
  }
  for (const row of rows) container.addActionRowComponents(row);
  // Réunion à venir : rôles invités (mentionnés à l'ajout, relancés à chaque rappel).
  if (meeting.status === 'scheduled') addInvites(container, meeting, state, m);
  return container.toJSON();
}

/** Choix personnel d'enregistrement (message éphémère). */
export function renderConsent(state: { refused: boolean; notice?: string | undefined }, m: Messages): APIContainerComponent {
  const c = m.consent;
  const container = new ContainerBuilder().setAccentColor(state.refused ? Accent.muted : Accent.brand);
  container.addTextDisplayComponents((t) =>
    t.setContent(`## 🎙️ ${c.title}\n${state.refused ? c.statusRefused : c.statusAccepted}\n-# ${c.explain}${state.notice ? `\n\n${state.notice}` : ''}`),
  );
  container.addActionRowComponents((row: ActionRowBuilder<ButtonBuilder>) =>
    row.addComponents(
      // Choix actif marqué ✓ et désactivé ; refuser n'a rien de destructif (pas de rouge).
      new ButtonBuilder()
        .setCustomId(encode({ type: 'consent.accept' }))
        .setLabel(state.refused ? c.accept : `✓ ${c.accept}`)
        .setEmoji('🎙️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!state.refused),
      new ButtonBuilder()
        .setCustomId(encode({ type: 'consent.refuse' }))
        .setLabel(state.refused ? `✓ ${c.refuse}` : c.refuse)
        .setEmoji('🔇')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.refused),
    ),
  );
  return container.toJSON();
}

/** Bouton d'accès au choix d'enregistrement (post épinglé, avertissements). */
export function consentButton(m: Messages): ButtonBuilder {
  return new ButtonBuilder().setCustomId(encode({ type: 'consent.open' })).setLabel(m.consent.open).setEmoji('🎙️').setStyle(ButtonStyle.Secondary);
}

/** Qui inviter (réunion à venir ou sondage) : choix actuel, sélecteur de rôles, Tout le monde / Par défaut / Personne. */
function addInvites(
  container: ContainerBuilder,
  meeting: { id: string; guildId?: string; targetRoleIds?: readonly string[]; inviteNone?: boolean },
  state: ManagerState,
  m: Messages,
): void {
  const guildId = meeting.guildId ?? '';
  const invite = { roleIds: meeting.targetRoleIds ?? [], none: meeting.inviteNone ?? false };
  const id = (type: 'meeting.roles' | 'meeting.everyone' | 'meeting.default' | 'meeting.none') => encode({ type, meetingId: meeting.id });
  container.addTextDisplayComponents((t) => t.setContent(m.invite.manage(inviteSummary(invite, guildId, state.nudgeRoleId ?? null, m))));
  for (const row of inviteControls({ roles: id('meeting.roles'), everyone: id('meeting.everyone'), default: id('meeting.default'), none: id('meeting.none') }, guildId, invite, state.nudgeRoleId ?? null, m)) {
    container.addActionRowComponents(row);
  }
}
