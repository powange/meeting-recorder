import { ComponentType, type APIContainerComponent } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { renderHub } from '../src/discord/embeds/hub.js';
import { renderConsent, renderMeetingManager } from '../src/discord/embeds/meetingManager.js';
import { decode } from '../src/domain/customId.js';
import { messages } from '../src/i18n/index.js';

const m = messages('fr');
const id = '3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b';
const meeting = { id, title: 'Bureau', status: 'scheduled' as const, autoRecord: false };

function actions(c: APIContainerComponent): string[] {
  const out: string[] = [];
  const walk = (x: { type: number; custom_id?: string; components?: unknown[] }) => {
    if (x.type === ComponentType.Button && x.custom_id) {
      const a = decode(x.custom_id);
      out.push(a ? a.type : '?');
    }
    for (const y of (x.components as never[]) ?? []) walk(y);
  };
  walk(c as never);
  return out;
}

describe('panneau « Gérer »', () => {
  it('réunion à venir : toutes les actions, sans régénération tant que rien n’est enregistré', () => {
    expect(actions(renderMeetingManager(meeting, { hasRecording: false }, m))).toEqual([
      'meeting.edit',
      'meeting.duplicate',
      'meeting.organizer',
      'meeting.autoRecord',
      'rec.start',
      'meeting.end',
      'meeting.cancel',
      'meeting.everyone', // + sélecteur des rôles invités ; « Par défaut » seulement avec un rôle relancé dans /config
      'meeting.none',
    ]);
  });
  it('réunion issue d’un sondage : bouton « Autre créneau du sondage »', () => {
    expect(actions(renderMeetingManager(meeting, { hasRecording: false, pollSlots: true }, m))).toContain('meeting.reslot');
    expect(actions(renderMeetingManager(meeting, { hasRecording: false }, m))).not.toContain('meeting.reslot');
  });

  it('enregistrement : Enregistrer maintenant, ou Arrêter s’il tourne', () => {
    expect(actions(renderMeetingManager(meeting, { hasRecording: true, recording: true }, m))).toContain('rec.stop');
    expect(actions(renderMeetingManager(meeting, { hasRecording: true, recording: true }, m))).not.toContain('rec.start');
  });
  it('tout retranscrire : confirmation demandée', () => {
    const view = actions(renderMeetingManager({ ...meeting, status: 'ended' }, { hasRecording: true, confirmRegenAll: true }, m));
    expect(view).toContain('meeting.regenAllConfirm');
    expect(view).not.toContain('meeting.regenAll');
  });
  it('clôture : confirmation demandée', () => {
    expect(actions(renderMeetingManager(meeting, { hasRecording: false, confirmEnd: true }, m))).toContain('meeting.endConfirm');
  });
  it('réunion close et enregistrée : dupliquer, changer d’organisateur et régénérer seulement ; annulée : pas de changement d’organisateur', () => {
    expect(actions(renderMeetingManager({ ...meeting, status: 'ended' }, { hasRecording: true }, m))).toEqual(['meeting.duplicate', 'meeting.organizer', 'meeting.regen', 'meeting.regenAll']);
    expect(actions(renderMeetingManager({ ...meeting, status: 'cancelled' }, { hasRecording: false }, m))).not.toContain('meeting.organizer');
  });
});

describe('choix d’enregistrement', () => {
  it('accepte : choix actif marqué ✓, bouton Refuser actif, aucun bouton rouge', () => {
    const c = renderConsent({ refused: false }, m);
    expect(actions(c)).toEqual(['consent.accept', 'consent.refuse']);
    expect(JSON.stringify(c)).toContain(`✓ ${m.consent.accept}`);
    expect(JSON.stringify(c)).not.toContain('"style":4');
    expect(JSON.stringify(c)).toContain('**acceptez**');
  });
  it('refuse : statut affiché, bouton Accepter actif', () => {
    const c = renderConsent({ refused: true, notice: m.consent.refused }, m);
    expect(JSON.stringify(c)).toContain('**refusez**');
    expect(JSON.stringify(c)).toContain('vous ne serez plus enregistré');
  });
  it('accessible depuis le post épinglé', () => {
    const hub = renderHub([], m);
    expect(hub.components[0]!.components.map((b) => decode((b as { custom_id: string }).custom_id)?.type)).toEqual(['meeting.create', 'poll.create', 'consent.open']);
  });
});

describe('charte : couleurs centralisées', () => {
  it('aucune couleur hexadécimale en dur dans src/discord en dehors de la palette', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const files = (await readdir('src/discord', { recursive: true })).filter((f) => f.endsWith('.ts') && !f.endsWith('palette.ts'));
    const offenders = [];
    for (const f of files) if (/0x[0-9a-f]{6}\b/i.test(await readFile(join('src/discord', f), 'utf8'))) offenders.push(f);
    expect(offenders).toEqual([]);
  });
});
