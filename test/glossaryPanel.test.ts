import { PermissionFlagsBits } from 'discord.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { handleConfigPanel } from '../src/discord/interactions/configPanel.js';
import { glossaryKey, type GlossaryEntry } from '../src/domain/glossary.js';
import { messages } from '../src/i18n/index.js';
import { fakeInteraction } from './helpers/discordFakes.js';

const m = messages('fr');
const t = m.config;

/** /config → Glossaire, avec un glossaire en mémoire. */
function setup(initial: GlossaryEntry[] = []) {
  let nextId = 1;
  let rows = initial.map((e) => ({ id: nextId++, guildId: 'g', key: glossaryKey(e.term), ...e, variants: [...e.variants], updatedBy: 'u', updatedAt: new Date() }));
  const repos = {
    listLlmBackends: async () => [],
    listBackends: async () => [],
    listGlossary: async () => [...rows].sort((a, b) => a.key.localeCompare(b.key)),
    upsertGlossary: async (_g: string, entries: GlossaryEntry[], by: string) => {
      let added = 0;
      for (const e of entries) {
        const key = glossaryKey(e.term);
        const existing = rows.find((r) => r.key === key);
        if (existing) Object.assign(existing, e, { variants: [...e.variants] });
        else (added++, rows.push({ id: nextId++, guildId: 'g', key, ...e, variants: [...e.variants], updatedBy: by, updatedAt: new Date() }));
      }
      return { added, updated: entries.length - added };
    },
    deleteGlossaryTerm: async (_g: string, id: number) => void (rows = rows.filter((r) => r.id !== id)),
  };
  const ctx = {
    config: buildConfig({ discord: { token: 'x' }, database: { url: 'postgres://a@b/c' } }, {}),
    log: pino({ level: 'silent' }),
    owners: { isOwner: () => false },
    settings: { get: async () => ({ guildId: 'g', locale: 'fr' }), messages: async () => m },
    optouts: { list: async () => [] },
    storage: { get: async () => undefined, available: () => [], blockedBySecretKey: () => false },
    repos,
    client: { channels: { fetch: async () => null }, guilds: { cache: new Map() } },
  };
  const run = async (action: string, opts: { arg?: string; kind?: 'button' | 'select' | 'modal'; values?: string[]; fields?: Record<string, string> } = {}) => {
    const { interaction, replies } = fakeInteraction({ kind: opts.kind ?? 'button', permissions: [PermissionFlagsBits.ManageGuild], ...(opts.values ? { values: opts.values } : {}), ...(opts.fields ? { fields: opts.fields } : {}) });
    await handleConfigPanel(ctx as never, interaction as never, action as never, opts.arg);
    return { text: JSON.stringify(replies.at(-1)?.payload), how: replies.at(-1)?.how, payload: replies.at(-1)?.payload };
  };
  return { run, rows: () => rows };
}

describe('/config → Glossaire', () => {
  it('import : termes ajoutés et mis à jour, lignes illisibles signalées par leur numéro', async () => {
    const s = setup([{ term: 'Keg', variants: [], definition: 'tonneau.' }]);
    const r = await s.run('glossaryImportSubmit', { kind: 'modal', fields: { lines: 'Ram Strat (ramstrat) : éperonner.\nkeg : tonneau explosif.\nsans séparateur' } });
    expect(r.text).toContain(t.glossaryImported(1, 1));
    expect(r.text).toContain('3 (pas de « : »)');
    expect(s.rows().map((x) => [x.term, x.definition])).toEqual([
      ['keg', 'tonneau explosif.'],
      ['Ram Strat', 'éperonner.'],
    ]);
  });

  it('choisir un terme affiche sa définition ; supprimer demande confirmation', async () => {
    const s = setup([{ term: 'Ram Strat', variants: ['ramstrat'], definition: 'éperonner avec une chaloupe.' }]);
    const picked = await s.run('glossaryPick', { kind: 'select', values: ['1'], arg: 'gp.0' });
    expect(picked.text).toContain('éperonner avec une chaloupe.');
    expect(picked.text).toContain('ramstrat');
    const ask = await s.run('glossaryDelete', { arg: 'g.1' });
    expect(ask.text).toContain('glossaryDeleteConfirm');
    expect(s.rows()).toHaveLength(1);
    const done = await s.run('glossaryDeleteConfirm', { arg: 'g.1' });
    expect(done.text).toContain(t.glossaryDeleted('Ram Strat'));
    expect(s.rows()).toEqual([]);
  });

  it('plafond de 100 termes : les termes déjà présents sont mis à jour, les nouveaux en trop refusés', async () => {
    const s = setup(Array.from({ length: 99 }, (_, i) => ({ term: `Terme ${i}`, variants: [], definition: 'd.' })));
    const r = await s.run('glossaryImportSubmit', { kind: 'modal', fields: { lines: 'Terme 0 : nouvelle définition.\nNouveau A : a.\nNouveau B : b.' } });
    expect(s.rows()).toHaveLength(100);
    expect(r.text).toContain(t.glossaryImportSkipped(1, 100));
    expect(s.rows().find((x) => x.term === 'Terme 0')!.definition).toBe('nouvelle définition.');
  });

  it('formulaires Ajouter, Modifier et Importer : acceptés par discord.js (limites de longueur des textes)', async () => {
    const s = setup([{ term: 'Ram Strat', variants: ['ramstrat'], definition: 'éperonner.' }]);
    for (const [action, arg] of [['glossaryAdd', undefined], ['glossaryEdit', 'g.1'], ['glossaryImport', undefined]] as const) {
      const r = await s.run(action, arg ? { arg } : {});
      expect(r.how).toBe('showModal');
      expect(() => (r.payload as { toJSON(): unknown }).toJSON()).not.toThrow();
    }
  });

  it('export : fichier relisible par l’import, en message privé', async () => {
    const s = setup([{ term: 'Ram Strat', variants: ['ramstrat'], definition: 'éperonner.' }]);
    const r = await s.run('glossaryExport');
    const file = (r.payload as { files: Array<{ name: string; attachment: Buffer }> }).files[0]!;
    expect(file.name).toBe('glossaire.txt');
    expect(file.attachment.toString('utf8')).toBe('Ram Strat (ramstrat) : éperonner.\n');
    expect(r.how).toBe('reply');
  });
});
