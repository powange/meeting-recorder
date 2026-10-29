import { describe, expect, it } from 'vitest';
import { formatGlossaryLine, glossaryBlock, glossaryFor, glossaryKey, parseGlossaryImport, parseVariants } from '../src/domain/glossary.js';

describe('glossaire : import et export', () => {
  it('« terme (variantes) : définition », lignes vides et commentaires ignorés, erreurs numérotées', () => {
    const { entries, errors } = parseGlossaryImport(
      [
        '# Sea of Thieves',
        'Cors des vents (cor des vents, corne des vents) : objet qui accélère un navire.',
        '',
        'Ram Strat : éperonner un navire ennemi avec une chaloupe.',
        'ligne sans séparateur',
        ' : définition sans terme',
        'Keg :',
      ].join('\n'),
    );
    expect(entries).toEqual([
      { term: 'Cors des vents', variants: ['cor des vents', 'corne des vents'], definition: 'objet qui accélère un navire.' },
      { term: 'Ram Strat', variants: [], definition: 'éperonner un navire ennemi avec une chaloupe.' },
    ]);
    expect(errors).toEqual([
      { line: 5, reason: 'separator' },
      { line: 6, reason: 'term' },
      { line: 7, reason: 'definition' },
    ]);
  });

  it('terme répété : la dernière ligne l’emporte (casse et accents ignorés) ; l’export se relit', () => {
    const { entries } = parseGlossaryImport('Keg : tonneau.\nkég : tonneau explosif.');
    expect(entries).toEqual([{ term: 'kég', variants: [], definition: 'tonneau explosif.' }]);
    const line = formatGlossaryLine({ term: 'Ram Strat', variants: ['ramstrat', 'R-Strat'], definition: 'éperonner.' });
    expect(line).toBe('Ram Strat (ramstrat, R-Strat) : éperonner.');
    expect(parseGlossaryImport(line).entries[0]).toEqual({ term: 'Ram Strat', variants: ['ramstrat', 'R-Strat'], definition: 'éperonner.' });
  });

  it('variantes : sans doublon ni le terme lui-même', () => {
    expect(parseVariants('ramstrat, Ram Strat, RAMSTRAT ; ram-strat', 'Ram Strat')).toEqual(['ramstrat']);
    expect(glossaryKey('Ram-Strat !')).toBe('ram strat');
  });
});

describe('glossaire : termes envoyés au modèle', () => {
  const glossary = [
    { term: 'Cors des vents', variants: ['cor des vents'], definition: 'objet qui accélère un navire.' },
    { term: 'Ram Strat', variants: ['ramstrat'], definition: 'éperonner avec une chaloupe.' },
    { term: 'Keg', variants: [], definition: 'tonneau explosif.' },
  ];

  it('seulement les termes présents (mots entiers, casse, accents, variantes), les plus cités d’abord', () => {
    const chunk = '[18:00] Alice : on prend le COR des vents ? [18:01] Bob : la ramstrat marche, la ramstrat encore. Pas de kegs.';
    expect(glossaryFor(chunk, glossary).map((e) => e.term)).toEqual(['Ram Strat', 'Cors des vents']);
    expect(glossaryFor('rien à voir', glossary)).toEqual([]);
  });

  it('plafond de place par passe : les moins cités sont laissés', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ term: `Terme${i}`, variants: [], definition: 'définition assez longue pour compter. '.repeat(4) }));
    const text = long.map((e, i) => `${e.term} `.repeat(30 - i)).join(' ');
    const kept = glossaryFor(text, long, 200);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(30);
    expect(kept[0]!.term).toBe('Terme0');
  });

  it('bloc de consigne : vide sans terme', () => {
    expect(glossaryBlock([])).toBe('');
    expect(glossaryBlock([glossary[2]!])).toContain('- Keg : tonneau explosif.');
  });
});
