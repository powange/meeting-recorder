import { describe, expect, it } from 'vitest';
import { applyReplacements, correctionReplacements, correctionTerms, parseVocabulary, PROMPT_MAX, transcriptReplacements, whisperPrompt } from '../src/domain/vocabulary.js';

describe('vocabulaire du serveur', () => {
  it('virgules, points-virgules ou retours à la ligne ; doublons et vides retirés', () => {
    expect(parseVocabulary('Pol, Apothicaire ;\n\nLiteLLM, pol ,  Carnets   de l’Apothicaire ')).toEqual(['Pol', 'Apothicaire', 'LiteLLM', 'Carnets de l’Apothicaire']);
  });
});

describe('termes tirés des consignes de correction', () => {
  it('garde le bon terme, jamais celui qui suit une négation', () => {
    expect(correctionTerms(['Pol et non Paul'])).toEqual(['Pol']);
    expect(correctionTerms(['Il faut écrire Kévin, pas Kevin'])).toEqual(['Kévin']);
    expect(correctionTerms(['Apothicaire au lieu de Apoticaire'])).toEqual(['Apothicaire']);
    // « pas » en début de mot n'est pas une négation.
    expect(correctionTerms(['Pascal et non Pascale'])).toEqual(['Pascal']);
    expect(correctionTerms(["Ophélie au lieu d'Ofélie"])).toEqual(['Ophélie']);
  });

  it('termes entre guillemets ; mots courants en début de phrase ignorés', () => {
    expect(correctionTerms(['La série s’appelle « Les Carnets de l’Apothicaire »'])).toEqual(['Les Carnets de l’Apothicaire', 'Carnets', 'Apothicaire']);
    expect(correctionTerms(['La décision était de reporter à janvier'])).toEqual([]);
  });
});

describe('prompt Whisper', () => {
  it('termes du glossaire en dernier (après vocabulaire, participants et ordre du jour)', () => {
    const prompt = whisperPrompt({ vocabulary: ['Apothicaire'], corrections: [], names: ['Pol'], agenda: ['Budget'], glossary: ['Ram Strat', 'ramstrat'] });
    expect(prompt).toBe('Apothicaire, Pol, Budget, Ram Strat, ramstrat');
  });

  it('ordre de priorité : YAML, vocabulaire, corrections, participants, ODJ ; sans doublon', () => {
    const prompt = whisperPrompt({ base: 'Réunion associative.', vocabulary: ['LiteLLM'], corrections: ['Pol et non Paul'], names: ['Emma', 'Pol'], agenda: ['Budget'] });
    expect(prompt).toBe('Réunion associative. LiteLLM, Pol, Emma, Budget');
  });

  it('coupé entre deux termes sous la limite ; rien → undefined', () => {
    const prompt = whisperPrompt({ vocabulary: Array.from({ length: 100 }, (_, i) => `terme-numero-${i}`), corrections: [], names: [], agenda: [] })!;
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(prompt.endsWith(',')).toBe(false);
    expect(prompt.split(', ').every((t) => /^terme-numero-\d+$/.test(t))).toBe(true);
    expect(whisperPrompt({ vocabulary: [], corrections: [], names: [], agenda: [] })).toBeUndefined();
  });
});

describe('remplacements tirés des consignes de correction', () => {
  it('« X et non Y », guillemets, virgule ; la dernière consigne sur un terme l’emporte', () => {
    const r = correctionReplacements(['cor des vents et non corps des vents', '"cors des vents" et pas "corps des vents"', 'Pol, pas Paul', "c'est Kévin et non Kevin"]);
    expect(r).toEqual([
      { wrong: 'corps des vents', right: 'cors des vents' },
      { wrong: 'Paul', right: 'Pol' },
      { wrong: 'Kevin', right: 'Kévin' },
    ]);
  });

  it('consignes libres ou termes sans rapport : laissées au modèle', () => {
    expect(correctionReplacements(['on vote demain et pas aujourd’hui', 'la décision était de reporter à janvier et non de tout annuler', 'il ne faut pas reporter', 'Marie et non Julie'])).toEqual([]);
    expect(correctionReplacements(['« Marie » et non « Julie »'])).toEqual([{ wrong: 'Julie', right: 'Marie' }]);
  });

  it('mots entiers, casse ignorée, majuscule initiale conservée', () => {
    const r = correctionReplacements(['cors des vents et non corps des vents', 'Pol et non Paul']);
    expect(applyReplacements('Corps des vents : deux corps  des vents ? Paul et Paulette, paul.', r)).toBe('Cors des vents : deux cors des vents ? Pol et Paulette, Pol.');
  });
  it('transcription jointe : variantes du glossaire remplacées par le terme, une correction l’emporte', () => {
    const r = transcriptReplacements(['Ram Strat et non ramstrat'], [{ term: 'RamStrat', variants: ['ram strat', 'ramstrat'] }, { term: 'GN', variants: ['gé enne'] }]);
    expect(applyReplacements('le ram strat, la ramstrat et le gé enne', r)).toBe('le RamStrat, la Ram Strat et le GN');
    expect(transcriptReplacements([], [])).toEqual([]);
  });
});
