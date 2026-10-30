import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, ThreadAutoArchiveDuration, type Client, type Guild, type ThreadChannel, type VoiceBasedChannel } from 'discord.js';
import type { AppConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import type { GuildSettingsRow, MeetingRow } from '../db/schema.js';
import { applyStatusTag, ensureStatusTags, ensureUnarchived } from '../discord/forum.js';
import { ScheduledEvents, type EventData } from '../discord/scheduledEvent.js';
import { fetchForum, fetchThread } from '../discord/threads.js';
import { canReschedule, isOpen, pollThreadName, threadName } from '../domain/meeting.js';
import { bestSlot, respondents, slotLabel, tallySlots, type SlotInput } from '../domain/datePoll.js';
import { planJobs, planPollJobs } from '../domain/reminders.js';
import { formatWhen } from '../domain/time.js';
import { loadMembers } from '../discord/members.js';
import { displayName, joinVoiceRows, MAX_INDIVIDUAL_MENTIONS, roleMention, sendNudge, sendWithMentions, voiceName } from '../discord/notify.js';
import { renderPollResults } from '../discord/embeds/meetingCard.js';
import { nudgeRoles, reminderTargets } from '../domain/rsvp.js';
import type { MeetingStatus } from '../domain/types.js';
import { messages, type Messages } from '../i18n/index.js';
import { discordErrorCode, errorMessage, UserError } from '../lib/errors.js';
import { encode } from '../domain/customId.js';
import type { Logger } from '../lib/logger.js';
import { truncate } from '../lib/text.js';
import type { CardService } from './cards.js';
import type { SettingsService } from './settings.js';

const UNKNOWN_CHANNEL = 10003;

export interface MeetingHooks {
  /** Réunion passée « En cours » (démarrage auto de l'enregistrement). */
  afterStart(meeting: MeetingRow): Promise<unknown>;
  /** Avant clôture ou annulation (arrêt de l'enregistrement, bilan avant le message de fin). */
  beforeClose(meetingId: string): Promise<unknown>;
  /** Après la clôture (pas l'annulation) : lancement du compte rendu. */
  afterEnd(meetingId: string): Promise<unknown>;
}

export interface MeetingInput {
  title: string;
  description: string;
  startsAt: Date;
  durationMin: number;
  /** Null en mode « salon créé automatiquement » : il est créé peu avant le début. */
  voiceChannelId: string | null;
}

/**
 * Orchestration des réunions : BDD (source de vérité) puis répercussion sur Discord
 * (post, tags, carte, événement natif). Les échecs Discord secondaires sont loggés sans
 * annuler l'opération ; seule la création du post est transactionnelle.
 */
export class MeetingService {
  private readonly events: ScheduledEvents;
  /** Créations de salon temporaire en cours (rappel, début et enregistrement peuvent la demander ensemble). */
  private readonly creatingVoice = new Map<string, Promise<MeetingRow | undefined>>();
  /** Réunions dont l'échec de création du salon a déjà été signalé dans le post (une fois suffit). */
  private readonly voiceFailureNotified = new Set<string>();
  /** Échecs de suppression d'un salon temporaire, par réunion : au-delà de 10, on abandonne. */
  private readonly deleteFailures = new Map<string, number>();
  private alert: (guildId: string, cause: string, message: string) => Promise<unknown> = async () => undefined;
  /** Branchements de l'enregistrement (phase 2), renseignés au démarrage. */
  hooks: MeetingHooks = { afterStart: async () => undefined, beforeClose: async () => undefined, afterEnd: async () => undefined };

  constructor(
    private readonly config: AppConfig,
    private readonly client: Client,
    private readonly repos: Repositories,
    private readonly settings: SettingsService,
    private readonly cards: CardService,
    private readonly log: Logger,
    /** Appelé après tout changement visible dans la liste des réunions (post épinglé). */
    private readonly onChange: (guildId: string) => void = () => undefined,
  ) {
    this.events = new ScheduledEvents(log);
  }

  setAlert(fn: (guildId: string, cause: string, message: string) => Promise<unknown>): void {
    this.alert = fn;
  }

  async create(guild: Guild, organizerId: string, input: MeetingInput, options: { copyAgendaFrom?: string } = {}): Promise<MeetingRow> {
    const settings = await this.settings.get(guild.id);
    const m = messages(settings.locale);
    const forum = await fetchForum(this.client, settings.forumChannelId);
    if (!forum) throw new UserError(m.errors.forumNotConfigured);
    if (!settings.tagIds) throw new UserError(m.errors.tagsMissing);
    input = await this.applyVoiceMode(settings, input, m);

    let meeting = await this.repos.insertMeeting({
      guildId: guild.id,
      organizerId,
      autoRecord: settings.autoRecordDefault,
      ...input,
    });
    let thread: ThreadChannel | null = null;
    try {
      if (options.copyAgendaFrom) await this.repos.copyAgenda(options.copyAgendaFrom, meeting.id);
      const card = await this.cards.renderCard(meeting);
      thread = await forum.threads.create({
        name: threadName(input.title, input.startsAt, settings.timezone, settings.locale),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        appliedTags: [settings.tagIds.upcoming],
        message: { ...card, allowedMentions: { parse: [] } },
        reason: `Réunion créée par ${organizerId}`,
      });
      const agenda = await thread.send({
        ...(await this.cards.renderAgenda(meeting)),
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressNotifications,
      });
      meeting = (await this.repos.updateMeeting(meeting.id, { threadId: thread.id, agendaMessageId: agenda.id }))!;
    } catch (err) {
      await this.repos.deleteMeeting(meeting.id);
      await thread?.delete().catch(() => undefined);
      throw err;
    }

    const eventId = await this.events.create(guild, this.eventData(meeting, thread.url, m, settings));
    if (eventId) meeting = (await this.repos.updateMeeting(meeting.id, { scheduledEventId: eventId }))!;
    await this.replan(meeting, settings);
    this.onChange(guild.id);
    this.log.info({ guildId: guild.id, meetingId: meeting.id, threadId: thread.id }, 'Réunion créée');
    return meeting;
  }

  /**
   * Sondage de date : le post est créé tout de suite (ordre du jour utilisable), avec la grille
   * de disponibilités à la place des inscriptions. Pas d'événement ni de rappel avant que la
   * date soit fixée ; la date provisoire est celle du premier créneau.
   */
  async createPoll(
    guild: Guild,
    organizerId: string,
    input: { title: string; description: string; voiceChannelId: string | null; slots: readonly SlotInput[]; closesAt: Date },
  ): Promise<MeetingRow> {
    const settings = await this.settings.get(guild.id);
    const m = messages(settings.locale);
    const forum = await fetchForum(this.client, settings.forumChannelId);
    if (!forum) throw new UserError(m.errors.forumNotConfigured);
    if (!settings.tagIds) throw new UserError(m.errors.tagsMissing);
    // Forum configuré avant les sondages : le tag « Date à choisir » est ajouté au premier.
    let tagIds = settings.tagIds;
    if (!tagIds.polling) {
      tagIds = await ensureStatusTags(forum, m);
      await this.repos.updateSettings(guild.id, { tagIds });
    }
    const first = input.slots[0]!;
    let meeting = await this.repos.insertMeeting({
      guildId: guild.id,
      organizerId,
      autoRecord: settings.autoRecordDefault,
      title: input.title,
      description: input.description,
      startsAt: first.startsAt,
      durationMin: first.durationMin,
      voiceChannelId: input.voiceChannelId,
      // Inséré directement en sondage : jamais visible un instant comme une réunion « À venir ».
      status: 'polling',
      pollClosesAt: input.closesAt,
    });
    let thread: ThreadChannel | null = null;
    try {
      await this.repos.insertSlots(meeting.id, input.slots);
      const card = await this.cards.renderCard(meeting);
      thread = await forum.threads.create({
        name: pollThreadName(input.title),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        ...(tagIds.polling ? { appliedTags: [tagIds.polling] } : {}),
        message: { ...card, allowedMentions: { parse: [] } },
        reason: `Sondage de date créé par ${organizerId}`,
      });
      const agenda = await thread.send({ ...(await this.cards.renderAgenda(meeting)), allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications });
      meeting = (await this.repos.updateMeeting(meeting.id, { threadId: thread.id, agendaMessageId: agenda.id }))!;
    } catch (err) {
      await this.repos.deleteMeeting(meeting.id);
      await thread?.delete().catch(() => undefined);
      throw err;
    }
    await this.replan(meeting, settings);
    this.onChange(guild.id);
    this.log.info({ guildId: guild.id, meetingId: meeting.id, slots: input.slots.length }, 'Sondage de date créé');
    return meeting;
  }

  /**
   * Rôles invités à une réunion ou à un sondage : enregistrés (ils remplacent le rôle de relance du
   * serveur pour la relance), et les nouveaux mentionnés dans le post. Un rôle que le bot ne peut
   * pas mentionner (non mentionnable, sans la permission « Mentionner @everyone ») : ses membres
   * sont mentionnés un par un.
   */
  /**
   * Organisation transmise à `userId` (droits et notifications d'organisateur) par `by`
   * (organisateur ou gestionnaire). Toute réunion sauf annulée, close comprise (correction du
   * compte rendu). Annoncé dans le post, le nouvel organisateur y est mentionné.
   */
  async transferOrganizer(meetingId: string, userId: string, by: string): Promise<MeetingRow> {
    const meeting = await this.repos.getMeeting(meetingId);
    const m = await this.settings.messages(meeting?.guildId ?? '');
    if (!meeting || meeting.status === 'cancelled') throw new UserError(m.errors.meetingClosed);
    if (meeting.organizerId === userId) throw new UserError(m.manage.organizerSame);
    const updated = (await this.repos.updateMeeting(meetingId, { organizerId: userId }))!;
    this.cards.refresh(meetingId);
    this.onChange(meeting.guildId);
    const thread = await fetchThread(this.client, meeting.threadId).catch(() => null);
    if (thread) {
      await ensureUnarchived(thread).catch(() => undefined);
      const byName = (await displayName(this.client, meeting.guildId, by)) ?? '?';
      await thread
        .send({ content: m.manage.organizerChanged(meeting.title, userId, byName), allowedMentions: { users: [userId] } })
        .catch((err) => this.warn(updated, 'Annonce du nouvel organisateur impossible', err));
    }
    this.log.info({ meetingId, from: meeting.organizerId, to: userId, by }, 'Organisateur changé');
    return updated;
  }

  async inviteRoles(guild: Guild, meetingId: string, roleIds: readonly string[], none = false): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting || (meeting.status !== 'scheduled' && meeting.status !== 'polling')) {
      throw new UserError((await this.settings.messages(guild.id)).errors.meetingClosed);
    }
    const added = none ? [] : roleIds.filter((id) => !meeting.targetRoleIds.includes(id));
    await this.repos.updateMeeting(meetingId, { targetRoleIds: none ? [] : [...roleIds], inviteNone: none });
    if (added.length === 0) return;
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!thread) return;
    const m = await this.settings.messages(guild.id);
    const canMentionAll = guild.members.me?.permissions.has(PermissionFlagsBits.MentionEveryone) ?? false;
    // @everyone (identifiant du serveur) : une vraie mention seulement avec la permission « Mentionner @everyone ».
    const pingable = added.filter((id) => canMentionAll || (id !== guild.id && guild.roles.cache.get(id)?.mentionable));
    const others = added.filter((id) => !pingable.includes(id));
    let members: string[] = [];
    if (others.length) {
      await loadMembers(guild).catch((err) => this.log.warn({ meetingId, err: errorMessage(err) }, 'Membres des rôles invités introuvables'));
      members = [...new Set(others.flatMap((id) => [...(guild.roles.cache.get(id)?.members.filter((mb) => !mb.user.bot).keys() ?? [])]))];
    }
    await ensureUnarchived(thread);
    const roles = (ids: readonly string[]) => ids.map((id) => roleMention(id, guild.id)).join(' ');
    const invite = meeting.status === 'polling' ? m.datePoll.invite : m.invite.meeting;
    if (pingable.length) {
      const everyone = pingable.includes(guild.id);
      await thread.send({
        content: invite(roles(pingable)),
        allowedMentions: { roles: pingable.filter((id) => id !== guild.id), ...(everyone ? { parse: ['everyone' as const] } : {}) },
      });
    }
    // Rôles non mentionnables : le message les nomme, et leurs membres sont mentionnés un par un
    // (au-delà du plafond, le message donne seulement leur nombre).
    if (others.length) {
      if (members.length <= MAX_INDIVIDUAL_MENTIONS) await sendWithMentions(thread, invite(roles(others)), m.datePoll.invitedMembers, members);
      else await thread.send({ content: `${invite(roles(others))}\n${m.invite.manyMembers(members.length)}`, allowedMentions: { parse: [] } });
    }
  }

  /** Créneau ajouté à un sondage en cours. */
  async addSlot(meetingId: string, slot: SlotInput): Promise<void> {
    const meeting = await this.requirePolling(meetingId);
    const slots = await this.repos.listSlots(meeting.id);
    const m = await this.settings.messages(meeting.guildId);
    if (slots.length >= 10) throw new UserError(m.datePoll.tooManySlots);
    if (slots.some((s) => s.startsAt.getTime() === slot.startsAt.getTime())) throw new UserError(m.datePoll.duplicateSlot);
    await this.repos.insertSlots(meeting.id, [slot]);
    await this.replan(meeting, await this.settings.get(meeting.guildId)); // relance et fin du sondage suivent les créneaux
    await this.cards.refreshNow(meeting.id);
  }

  /** Créneau retiré d'un sondage (ses réponses avec) ; il en reste toujours au moins un. */
  async removeSlot(meetingId: string, slotId: number): Promise<void> {
    const meeting = await this.requirePolling(meetingId);
    const m = await this.settings.messages(meeting.guildId);
    if ((await this.repos.listSlots(meeting.id)).length <= 1) throw new UserError(m.datePoll.lastSlot);
    await this.repos.deleteSlot(meeting.id, slotId);
    await this.replan(meeting, await this.settings.get(meeting.guildId));
    await this.cards.refreshNow(meeting.id);
  }

  /**
   * Date fixée : la réunion devient une réunion ordinaire (« À venir ») au créneau choisi. Les
   * réponses deviennent des inscriptions (disponible → Présent, si nécessaire → Peut-être), et
   * ceux qui ont répondu sont prévenus. `by` = null quand la clôture est automatique.
   */
  async fixDate(guild: Guild, meetingId: string, slotId: number, by: string | null): Promise<MeetingRow> {
    const settings = await this.settings.get(guild.id);
    const m = messages(settings.locale);
    const slots = await this.repos.listSlots(meetingId);
    const slot = slots.find((s) => s.id === slotId);
    if (!slot) throw new UserError(m.datePoll.slotGone);
    // Un créneau passé lancerait aussitôt la réunion (mentions, salon) sans événement Discord.
    if (slot.startsAt.getTime() <= Date.now()) throw new UserError(m.datePoll.slotPast);
    const tally = tallySlots(slots, await this.repos.listVotes(meetingId));
    const chosen = tally.find((t) => t.slotId === slotId)!;
    const current = await this.requirePolling(meetingId);
    const voice = await this.applyVoiceMode(settings, { title: current.title, description: current.description, startsAt: slot.startsAt, durationMin: slot.durationMin, voiceChannelId: current.voiceChannelId }, m, current).catch(() => null);
    let meeting = await this.repos.transitionMeeting(meetingId, ['polling'], 'scheduled', {
      startsAt: slot.startsAt,
      durationMin: slot.durationMin,
      pollClosesAt: null,
      ...(voice ? { voiceChannelId: voice.voiceChannelId } : {}),
    });
    if (!meeting) throw new UserError(m.datePoll.notPolling);
    for (const id of chosen.yes) await this.repos.setRsvp(meeting.id, id, 'yes');
    for (const id of chosen.maybe) await this.repos.setRsvp(meeting.id, id, 'maybe');

    const thread = await fetchThread(this.client, meeting.threadId).catch(() => null);
    const eventId = await this.events.create(guild, this.eventData(meeting, thread?.url ?? '', m, settings));
    if (eventId) meeting = (await this.repos.updateMeeting(meeting.id, { scheduledEventId: eventId }))!;
    await this.replan(meeting, settings);
    if (thread) {
      await ensureUnarchived(thread).catch(() => undefined);
      await thread.setName(threadName(meeting.title, meeting.startsAt, settings.timezone, settings.locale)).catch((err) => this.warn(meeting!, 'Renommage du post impossible', err));
      if (settings.tagIds) await applyStatusTag(thread, settings.tagIds, 'scheduled').catch((err) => this.warn(meeting!, 'Mise à jour du tag impossible', err));
      // Historique : la grille figée (créneau retenu marqué), la carte redevenant une carte de réunion.
      const results = renderPollResults(meeting.title, tally.map((t) => ({ ...t, label: slotLabel(t, settings.timezone, settings.locale) })), slotId, m);
      await thread.send({ ...results, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications }).catch((err) => this.warn(meeting!, 'Résultat du sondage non publié', err));
      const when = formatWhen(meeting.startsAt, settings.timezone, settings.locale, m.format.when);
      const byName = by ? await displayName(this.client, meeting.guildId, by) : null;
      const people = [...respondents(tally)];
      await sendWithMentions(thread, m.datePoll.fixed(meeting.title, when, byName), m.thread.responders, people, joinVoiceRows(meeting.guildId, meeting.voiceChannelId, m)).catch((err) =>
        this.warn(meeting!, 'Annonce de la date impossible', err),
      );
      // Invités (rôles de la réunion, à défaut rôle de relance) qui n'ont pas répondu au sondage :
      // prévenus aussi, pour qu'ils indiquent s'ils viennent.
      const missing = await this.silentMembers(guild, nudgeRoles(meeting, settings), new Set(people), meeting.organizerId).catch((err) => {
        this.warn(meeting!, 'Invités sans réponse introuvables', err);
        return [];
      });
      if (missing.length) await sendNudge(thread, guild, nudgeRoles(meeting, settings), m.datePoll.fixedAsk, m.thread.nudge, missing, m).catch((err) => this.warn(meeting!, 'Relance après la date fixée impossible', err));
    }
    await this.cards.refreshNow(meeting.id);
    this.onChange(meeting.guildId);
    this.log.info({ meetingId, slotId, by }, 'Date du sondage fixée');
    return meeting;
  }

  /**
   * Fin des réponses (échéance) : la date est fixée s'il y a un meilleur créneau net ; sinon
   * (égalité, aucune réponse) l'organisateur est mentionné pour trancher.
   */
  async closePoll(meetingId: string): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting || meeting.status !== 'polling') return;
    // La date n'est jamais fixée toute seule : le créneau le plus disponible n'est pas forcément le
    // bon. Résultats publiés, meilleur créneau suggéré (⭐), et l'organisateur choisit parmi tous.
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    const tally = tallySlots(await this.repos.listSlots(meetingId), await this.repos.listVotes(meetingId));
    const best = bestSlot(tally);
    const slots = tally.map((t) => ({ ...t, label: slotLabel(t, settings.timezone, settings.locale) }));
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!thread) return;
    await ensureUnarchived(thread);
    const results = renderPollResults(meeting.title, slots, null, m, best?.slotId ?? null);
    const fix = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(encode({ type: 'poll.fix', meetingId })).setLabel(m.datePoll.fixDate).setEmoji('📅').setStyle(ButtonStyle.Primary),
    );
    await thread.send({
      content: m.datePoll.closed(meeting.organizerId, best ? slots.find((x) => x.slotId === best.slotId)!.label : null),
      embeds: results.embeds,
      components: [fix.toJSON()],
      allowedMentions: { users: [meeting.organizerId] },
    });
    // Suite si personne ne tranche : relance de l'organisateur, puis annulation (planPollJobs).
    await this.replan(meeting, settings);
  }

  /** Veille du premier créneau à venir, date toujours pas fixée : l'organisateur est relancé. */
  async remindPoll(meetingId: string): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting || meeting.status !== 'polling') return;
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    const next = (await this.repos.listSlots(meetingId)).filter((s) => s.startsAt.getTime() > Date.now()).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!next || !thread) return;
    await ensureUnarchived(thread);
    const fix = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(encode({ type: 'poll.fix', meetingId })).setLabel(m.datePoll.fixDate).setEmoji('📅').setStyle(ButtonStyle.Primary),
    );
    await thread.send({
      content: m.datePoll.remindOrganizer(meeting.organizerId, formatWhen(next.startsAt, settings.timezone, settings.locale, m.format.when)),
      components: [fix.toJSON()],
      allowedMentions: { users: [meeting.organizerId] },
    });
  }

  /** Dernier créneau passé sans date fixée : le sondage est annulé (il ne reste plus ouvert indéfiniment). */
  async expirePoll(meetingId: string): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting || meeting.status !== 'polling') return;
    const settings = await this.settings.get(meeting.guildId);
    // Créneau ajouté entre-temps : l'échéance suit le nouveau dernier créneau.
    if ((await this.repos.listSlots(meetingId)).some((s) => s.startsAt.getTime() > Date.now())) return this.replan(meeting, settings);
    const m = messages(settings.locale);
    await this.cancel(meetingId, this.client.user?.id ?? meeting.organizerId, m.datePoll.expired);
  }

  /** Relance : membres du rôle configuré qui n'ont répondu à aucun créneau. */
  async nudgePoll(meetingId: string): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting || meeting.status !== 'polling') return;
    const settings = await this.settings.get(meeting.guildId);
    const roleIds = nudgeRoles(meeting, settings);
    if (roleIds.length === 0) return;
    const m = messages(settings.locale);
    const guild = await this.guild(meeting);
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!guild || !thread) return;
    const answered = respondents(tallySlots(await this.repos.listSlots(meetingId), await this.repos.listVotes(meetingId)));
    const missing = await this.silentMembers(guild, roleIds, answered, meeting.organizerId);
    if (missing.length === 0) return;
    await ensureUnarchived(thread);
    const closes = formatWhen(meeting.pollClosesAt ?? meeting.startsAt, settings.timezone, settings.locale, m.format.when);
    await sendNudge(thread, guild, roleIds, m.datePoll.nudge(meeting.title, closes), m.thread.nudge, missing, m);
  }

  /** Membres des rôles (hors bots et organisateur) qui ne figurent pas parmi ceux qui ont répondu. */
  private async silentMembers(guild: Guild, roleIds: readonly string[], answered: ReadonlySet<string>, organizerId: string): Promise<string[]> {
    if (roleIds.length === 0) return [];
    await loadMembers(guild); // nécessite l'intent privilégié GuildMembers
    const ids = roleIds.flatMap((id) => [...(guild.roles.cache.get(id)?.members.filter((mb) => !mb.user.bot && !answered.has(mb.id) && mb.id !== organizerId).keys() ?? [])]);
    return [...new Set(ids)];
  }

  /** Libellés des créneaux d'un sondage, dans le fuseau du serveur. */
  async slotChoices(meeting: MeetingRow): Promise<Array<{ id: number; label: string; yes: number; maybe: number; no: number; past: boolean }>> {
    const settings = await this.settings.get(meeting.guildId);
    const tally = tallySlots(await this.repos.listSlots(meeting.id), await this.repos.listVotes(meeting.id));
    const now = Date.now();
    return tally.map((t) => ({ id: t.slotId, label: slotLabel(t, settings.timezone, settings.locale), yes: t.yes.length, maybe: t.maybe.length, no: t.no.length, past: t.startsAt.getTime() <= now }));
  }

  private async requirePolling(meetingId: string): Promise<MeetingRow> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting || meeting.status !== 'polling') {
      const m = await this.settings.messages(meeting?.guildId ?? '');
      throw new UserError(m.datePoll.notPolling);
    }
    return meeting;
  }

  async update(guild: Guild, meeting: MeetingRow, input: MeetingInput, by: string): Promise<MeetingRow> {
    const settings = await this.settings.get(guild.id);
    const m = messages(settings.locale);
    if (canReschedule(meeting.status)) input = await this.applyVoiceMode(settings, input, m, meeting);
    const rescheduled =
      input.startsAt.getTime() !== meeting.startsAt.getTime() ||
      input.durationMin !== meeting.durationMin ||
      input.voiceChannelId !== meeting.voiceChannelId;
    if (rescheduled && !canReschedule(meeting.status)) throw new UserError(m.errors.cannotReschedule);
    // Nouvelle date dans le passé (« Autre créneau » choisi trop tard) : la réunion démarrerait aussitôt.
    if (input.startsAt.getTime() !== meeting.startsAt.getTime() && input.startsAt.getTime() <= Date.now()) throw new UserError(m.errors.datePast);

    // Salon remplacé (changement de mode, autre salon choisi) : il n'est plus temporaire, et
    // l'ancien salon temporaire est supprimé. Sinon le nouveau, permanent, le serait en fin de réunion.
    const voiceChanged = input.voiceChannelId !== meeting.voiceChannelId;
    // Seuls les champs du formulaire : jamais statut, messages ou dates de fin lus avant la saisie.
    const fields = { title: input.title, description: input.description, startsAt: input.startsAt, durationMin: input.durationMin, voiceChannelId: input.voiceChannelId };
    const patch = voiceChanged && meeting.voiceTemporary ? { ...fields, voiceTemporary: false, voiceDeletedAt: null } : fields;
    let updated = (await this.repos.updateMeeting(meeting.id, patch))!;
    // Échéances et événement d'abord : un échec Discord plus bas (post verrouillé, permission)
    // ne doit pas laisser rappels et début à l'ancienne heure.
    if (rescheduled) await this.replan(updated, settings);
    if (voiceChanged && meeting.voiceTemporary && meeting.voiceChannelId) await this.dropReplacedVoice(meeting, meeting.voiceChannelId);
    const thread = await fetchThread(this.client, updated.threadId).catch(() => null);
    if (updated.status === 'scheduled') {
      const eventId = await this.events.update(guild, updated.scheduledEventId, this.eventData(updated, thread?.url ?? '', m, settings));
      if (eventId !== updated.scheduledEventId) updated = (await this.repos.updateMeeting(updated.id, { scheduledEventId: eventId }))!;
    }
    if (thread) await this.announceUpdate(thread, meeting, updated, settings, m).catch((err) => this.warn(updated, 'Message de modification impossible', err));
    await this.cards.refreshNow(updated.id);
    this.onChange(updated.guildId);
    this.log.info({ meetingId: updated.id, by, rescheduled }, 'Réunion modifiée');
    return updated;
  }

  /** Passage « En cours » (heure de début atteinte). */
  async start(meetingId: string): Promise<boolean> {
    await this.ensureVoice(meetingId).catch((err) => this.log.warn({ meetingId, err: errorMessage(err) }, 'Création du salon vocal impossible'));
    const meeting = await this.repos.transitionMeeting(meetingId, ['scheduled'], 'live', { startedAt: new Date() });
    if (!meeting) return false;
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    await this.replan(meeting, settings);
    const voice = await voiceName(this.client, meeting.voiceChannelId, m);
    const attendees = reminderTargets(await this.repos.listRsvps(meeting.id));
    await this.afterStatusChange(meeting, settings, (thread) =>
      sendWithMentions(thread, m.thread.started(meeting.title, voice), m.thread.reminderTargets, attendees, joinVoiceRows(meeting.guildId, meeting.voiceChannelId, m)),
    );
    const guild = await this.guild(meeting);
    if (guild) await this.events.start(guild, meeting.scheduledEventId);
    this.onChange(meeting.guildId);
    await this.hooks.afterStart(meeting).catch((err) => this.warn(meeting, 'Démarrage auto de l’enregistrement impossible', err));
    return true;
  }

  /** Clôture (manuelle ou automatique). `by` = null pour une clôture automatique. */
  async end(meetingId: string, by: string | null): Promise<boolean> {
    const meeting = await this.repos.transitionMeeting(meetingId, ['scheduled', 'live'], 'ended', {
      endedAt: new Date(),
      agendaLocked: true,
    });
    if (!meeting) return false;
    await this.hooks.beforeClose(meeting.id).catch((err) => this.warn(meeting, 'Arrêt de l’enregistrement impossible', err));
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    await this.repos.cancelPendingJobs(meeting.id);
    const byName = by ? ((await displayName(this.client, meeting.guildId, by)) ?? null) : null;
    await this.afterStatusChange(meeting, settings, (thread) =>
      thread.send({ content: m.thread.ended(byName), allowedMentions: { parse: [] }, flags: MessageFlags.SuppressNotifications }),
    );
    const guild = await this.guild(meeting);
    if (guild) await this.events.complete(guild, meeting.scheduledEventId);
    this.onChange(meeting.guildId);
    this.log.info({ meetingId, by }, 'Réunion close');
    await this.hooks.afterEnd(meeting.id).catch((err) => this.warn(meeting, 'Lancement du compte rendu impossible', err));
    return true;
  }

  async cancel(meetingId: string, by: string, reason: string | null, options: { silent?: boolean } = {}): Promise<boolean> {
    const meeting = await this.repos.transitionMeeting(meetingId, ['polling', 'scheduled', 'live'], 'cancelled', { endedAt: new Date() });
    if (!meeting) return false;
    await this.hooks.beforeClose(meeting.id).catch((err) => this.warn(meeting, 'Arrêt de l’enregistrement impossible', err));
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    await this.repos.cancelPendingJobs(meeting.id);
    const guild = await this.guild(meeting);
    if (guild) await this.events.cancel(guild, meeting.scheduledEventId);
    if (!options.silent) {
      await this.afterStatusChange(meeting, settings, async (thread) => {
        const byName = await displayName(this.client, meeting.guildId, by);
        // Ceux qui avaient répondu sont prévenus (comme pour un report), avant l'archivage du post.
        const responders = (await this.repos.listRsvps(meeting.id)).map((r) => r.userId);
        await sendWithMentions(thread, m.thread.cancelled(meeting.title, byName, reason), m.thread.responders, responders);
        await thread.setArchived(true, 'Réunion annulée');
      });
    }
    this.onChange(meeting.guildId);
    this.log.info({ meetingId, by }, 'Réunion annulée');
    return true;
  }

  /**
   * Post supprimé à la main : le bot l'oublie (plus de lien dans le post épinglé, plus de compte
   * rendu à y publier), et une réunion encore ouverte est annulée sans rien publier.
   */
  async onThreadDeleted(threadId: string): Promise<void> {
    const meeting = await this.repos.getMeetingByThread(threadId);
    if (!meeting) return;
    // D'abord : l'arrêt d'un enregistrement en cours ne lance alors pas de compte rendu sans post.
    await this.repos.updateMeeting(meeting.id, { threadId: null, agendaMessageId: null, controlMessageId: null, liveMessageId: null });
    this.log.info({ meetingId: meeting.id, threadId }, 'Post de réunion supprimé');
    if (!(await this.cancel(meeting.id, this.client.user?.id ?? 'system', null, { silent: true }))) this.onChange(meeting.guildId);
  }

  /**
   * Au démarrage : posts supprimés pendant que le bot était éteint (Discord ne renvoie pas
   * l'événement). Réunions ouvertes, ou closes depuis moins de 30 jours (liste des comptes rendus).
   */
  async checkDeletedThreads(): Promise<number> {
    let removed = 0;
    for (const meeting of await this.repos.listMeetingsWithThread(30)) {
      try {
        if (await fetchThread(this.client, meeting.threadId)) continue;
      } catch {
        continue; // erreur passagère (réseau, droits) : on ne conclut rien
      }
      await this.onThreadDeleted(meeting.threadId!);
      removed++;
    }
    return removed;
  }

  /** Active ou désactive l'enregistrement automatique d'une réunion. */
  async setAutoRecord(meetingId: string, autoRecord: boolean): Promise<void> {
    const meeting = await this.repos.updateMeeting(meetingId, { autoRecord });
    if (!meeting) return;
    await this.replan(meeting, await this.settings.get(meeting.guildId));
    this.cards.refresh(meetingId, ['card']);
  }

  /** Recalcule les échéances des réunions à venir ou en cours (après un changement des rappels). */
  async replanGuild(guildId: string): Promise<void> {
    const settings = await this.settings.get(guildId);
    for (const meeting of await this.repos.listMeetings(guildId, ['scheduled', 'live'])) await this.replan(meeting, settings);
  }

  /**
   * Salon vocal d'une réunion qui n'en a pas encore (mode « créé automatiquement ») : il est créé
   * dans la catégorie choisie (à défaut celle du forum). Recréé s'il a été supprimé à la main avant
   * la fin. Sans effet si la réunion a déjà son salon ou est terminée.
   */
  async ensureVoice(meetingId: string): Promise<MeetingRow | undefined> {
    const pending = this.creatingVoice.get(meetingId);
    if (pending) return pending;
    const task = this.doEnsureVoice(meetingId)
      .catch(async (err) => {
        await this.reportVoiceFailure(meetingId, err).catch(() => undefined);
        throw err;
      })
      .finally(() => this.creatingVoice.delete(meetingId));
    this.creatingVoice.set(meetingId, task);
    return task;
  }

  /** Supprime le salon temporaire d'une réunion finie, une fois vide. Renvoie vrai si c'est fait. */
  async deleteTemporaryVoice(meeting: MeetingRow): Promise<boolean> {
    if (!meeting.voiceTemporary || meeting.voiceDeletedAt || isOpen(meeting.status)) return false;
    // Jamais le salon imposé par /config, même si l'indicateur était resté faux d'une ancienne version.
    const settings = await this.settings.get(meeting.guildId);
    if (meeting.voiceChannelId && meeting.voiceChannelId !== settings.voiceChannelId) {
      const found = await this.fetchVoice(meeting.voiceChannelId);
      if (found === 'unknown') return false; // erreur passagère : on réessaiera
      if (found !== 'missing') {
        if (found.members.filter((mb) => !mb.user.bot).size > 0) return false;
        try {
          await found.delete(`Fin de la réunion « ${meeting.title} »`);
        } catch (err) {
          if (discordErrorCode(err) !== UNKNOWN_CHANNEL) {
            // Permission retirée… : on réessaie au passage suivant, puis on abandonne au bout de 10 échecs.
            const failures = (this.deleteFailures.get(meeting.id) ?? 0) + 1;
            this.deleteFailures.set(meeting.id, failures);
            this.warn(meeting, 'Suppression du salon temporaire impossible', err);
            if (failures < 10) return false;
            await this.alert(meeting.guildId, 'voice-delete', messages(settings.locale).alerts.voiceDeleteFailed(meeting.voiceChannelId));
          }
        }
      }
    }
    this.deleteFailures.delete(meeting.id);
    await this.repos.updateMeeting(meeting.id, { voiceDeletedAt: new Date() });
    this.cards.refresh(meeting.id, ['card']);
    this.log.info({ meetingId: meeting.id, channelId: meeting.voiceChannelId }, 'Salon vocal temporaire supprimé');
    return true;
  }

  // ---------------------------------------------------------------- interne

  private async doEnsureVoice(meetingId: string): Promise<MeetingRow | undefined> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting || !isOpen(meeting.status)) return meeting;
    if (meeting.voiceChannelId) {
      if (!meeting.voiceTemporary) return meeting;
      // Recréé seulement s'il a vraiment disparu : une erreur passagère ne doit pas créer de doublon.
      if ((await this.fetchVoice(meeting.voiceChannelId)) !== 'missing') return meeting;
    }
    const guild = await this.guild(meeting);
    if (!guild) return meeting;
    const settings = await this.settings.get(meeting.guildId);
    const m = messages(settings.locale);
    const parent = settings.autoVoiceCategoryId ?? (await fetchForum(this.client, settings.forumChannelId))?.parentId ?? null;
    const create = (withParent: boolean) =>
      guild.channels.create({
        name: truncate(meeting.title, 100),
        type: ChannelType.GuildVoice,
        ...(withParent && parent ? { parent } : {}),
        reason: `Réunion « ${meeting.title} »`,
      });
    // Catégorie supprimée ou interdite au bot : le salon est créé hors catégorie plutôt que pas du tout.
    const channel = await create(true).catch((err) => {
      if (!parent) throw err;
      this.warn(meeting, 'Création du salon dans la catégorie impossible', err);
      return create(false);
    });
    let updated = (await this.repos.updateMeeting(meeting.id, { voiceChannelId: channel.id, voiceTemporary: true, voiceDeletedAt: null }))!;
    if (updated.status === 'scheduled') {
      const thread = await fetchThread(this.client, updated.threadId);
      const eventId = await this.events.update(guild, updated.scheduledEventId, this.eventData(updated, thread?.url ?? '', m, settings));
      if (eventId !== updated.scheduledEventId) updated = (await this.repos.updateMeeting(updated.id, { scheduledEventId: eventId }))!;
    }
    await this.cards.refreshNow(updated.id).catch((err) => this.warn(updated, 'Mise à jour de la carte impossible', err));
    this.voiceFailureNotified.delete(updated.id);
    this.log.info({ meetingId: updated.id, channelId: channel.id }, 'Salon vocal temporaire créé');
    return updated;
  }

  /** Post renommé et, si la date change, message à tous ceux qui ont répondu. */
  private async announceUpdate(thread: ThreadChannel, before: MeetingRow, updated: MeetingRow, settings: GuildSettingsRow, m: Messages): Promise<void> {
    await ensureUnarchived(thread);
    const name = updated.status === 'polling' ? pollThreadName(updated.title) : threadName(updated.title, updated.startsAt, settings.timezone, settings.locale);
    if (thread.name !== name) await thread.setName(name).catch((err) => this.warn(updated, 'Renommage du post impossible', err));
    if (updated.startsAt.getTime() === before.startsAt.getTime()) return;
    const when = formatWhen(updated.startsAt, settings.timezone, settings.locale, m.format.when);
    const startsIn = m.format.startsIn(Math.round((updated.startsAt.getTime() - Date.now()) / 60_000));
    // Tous ceux qui ont répondu sont prévenus, y compris les absents (la nouvelle date leur convient peut-être).
    // Ce message tient lieu des rappels qu'un avancement de l'heure aurait fait sauter.
    const responders = (await this.repos.listRsvps(updated.id)).map((r) => r.userId);
    await sendWithMentions(thread, m.thread.rescheduled(updated.title, when, startsIn), m.thread.responders, responders);
  }

  /** Salon vocal : trouvé, introuvable (supprimé), ou inconnu (erreur passagère de Discord). */
  private async fetchVoice(channelId: string): Promise<VoiceBasedChannel | 'missing' | 'unknown'> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      return channel?.isVoiceBased() ? channel : 'missing';
    } catch (err) {
      return discordErrorCode(err) === UNKNOWN_CHANNEL ? 'missing' : 'unknown';
    }
  }

  /** Ancien salon temporaire remplacé : supprimé s'il est vide (sinon laissé, et signalé). */
  private async dropReplacedVoice(meeting: MeetingRow, channelId: string): Promise<void> {
    const found = await this.fetchVoice(channelId);
    if (found === 'missing' || found === 'unknown') return;
    if (found.members.filter((mb) => !mb.user.bot).size > 0) {
      this.log.warn({ meetingId: meeting.id, channelId }, 'Ancien salon temporaire occupé : non supprimé');
      return;
    }
    await found.delete(`Salon de la réunion « ${meeting.title} » remplacé`).catch((err) => this.warn(meeting, 'Suppression de l’ancien salon temporaire impossible', err));
  }

  /** Échec de création du salon : alerte (limitée par l'AlertService) et, une seule fois, message dans le post. */
  private async reportVoiceFailure(meetingId: string, err: unknown): Promise<void> {
    const meeting = await this.repos.getMeeting(meetingId);
    if (!meeting) return;
    const m = messages((await this.settings.get(meeting.guildId)).locale);
    this.warn(meeting, 'Création du salon vocal impossible', err);
    await this.alert(meeting.guildId, 'voice-create', m.alerts.voiceCreateFailed(meeting.title, errorMessage(err)));
    if (this.voiceFailureNotified.has(meeting.id)) return;
    this.voiceFailureNotified.add(meeting.id);
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!thread) return;
    await ensureUnarchived(thread);
    await thread.send({ content: m.thread.voiceCreateFailed(meeting.organizerId), allowedMentions: { users: [meeting.organizerId] } });
  }

  /**
   * Salon imposé par /config : il remplace celui saisi, et doit toujours exister. En mode « créé
   * automatiquement », la réunion garde le salon déjà créé, sinon elle n'en a pas encore.
   */
  private async applyVoiceMode(settings: GuildSettingsRow, input: MeetingInput, m: Messages, current?: MeetingRow): Promise<MeetingInput> {
    if (settings.autoVoice) return { ...input, voiceChannelId: current?.voiceChannelId ?? null };
    if (!settings.voiceChannelId) {
      if (!input.voiceChannelId) throw new UserError(m.errors.voiceRequired);
      if (input.voiceChannelId !== current?.voiceChannelId && (await this.fetchVoice(input.voiceChannelId)) === 'missing') throw new UserError(m.errors.voiceInvalid);
      return input;
    }
    const channel = await this.client.channels.fetch(settings.voiceChannelId).catch(() => null);
    if (!channel?.isVoiceBased()) throw new UserError(m.errors.fixedVoiceMissing);
    return { ...input, voiceChannelId: settings.voiceChannelId };
  }

  private async replan(meeting: MeetingRow, settings: GuildSettingsRow): Promise<void> {
    if (meeting.status === 'polling') {
      const slots = (await this.repos.listSlots(meeting.id)).map((s) => s.startsAt);
      await this.repos.replaceJobs(meeting.id, meeting.pollClosesAt ? planPollJobs(meeting.pollClosesAt, new Date(), slots) : []);
      return;
    }
    const lead = this.config.guild(meeting.guildId).recording.autoJoinLeadMin;
    await this.repos.replaceJobs(meeting.id, planJobs(meeting, settings.reminderOffsetsMin, new Date(), lead, settings.autoVoiceLeadMin, settings.timezone));
  }

  /** Carte, tag et message dans le post après un changement de statut. */
  private async afterStatusChange(
    meeting: MeetingRow,
    settings: GuildSettingsRow,
    announce: (thread: ThreadChannel) => Promise<unknown>,
  ): Promise<void> {
    const thread = await fetchThread(this.client, meeting.threadId);
    if (!thread) return;
    await this.cards.refreshNow(meeting.id).catch((err) => this.warn(meeting, 'Mise à jour de la carte impossible', err));
    try {
      await ensureUnarchived(thread);
      if (settings.tagIds) await applyStatusTag(thread, settings.tagIds, meeting.status as MeetingStatus);
    } catch (err) {
      this.warn(meeting, 'Mise à jour du tag impossible', err);
    }
    await announce(thread).catch((err) => this.warn(meeting, 'Message dans le post impossible', err));
  }

  private eventData(meeting: MeetingRow, threadUrl: string, m: Messages, settings: GuildSettingsRow): EventData {
    return {
      title: meeting.title,
      description: m.event.description(threadUrl, meeting.description),
      startsAt: meeting.startsAt,
      durationMin: meeting.durationMin,
      voiceChannelId: meeting.voiceChannelId,
      location: m.event.voiceLater(settings.autoVoiceLeadMin),
    };
  }

  private async guild(meeting: MeetingRow): Promise<Guild | null> {
    return this.client.guilds.fetch(meeting.guildId).catch(() => null);
  }

  private warn(meeting: MeetingRow, msg: string, err: unknown): void {
    this.log.warn({ meetingId: meeting.id, err: errorMessage(err) }, msg);
  }
}

