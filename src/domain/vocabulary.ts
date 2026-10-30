/** Taille du prompt de vocabulaire envoyé à Whisper (il n'en lit de toute façon que ~224 tokens). */
export const PROMPT_MAX = 800;
export const VOCABULARY_MAX_TERMS = 100;
const TERM_MAX = 60;

/** « Pol, Apothicaire ; Tabac\nLiteLLM » → termes uniques, dans l'ordre. */
export function parseVocabulary(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,;\n]+/)) {
    const term = raw.trim().replace(/\s+/g, ' ').slice(0, TERM_MAX);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out.slice(0, VOCABULARY_MAX_TERMS);
}

/** Mots capitalisés courants en début de phrase : ce ne sont pas des noms propres. */
const STOPWORDS = new Set(
  (
    "le la les l un une des du de d au aux il elle ils elles on nous vous je j tu ce c cet cette ces ça " +
    'mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs et ou mais donc or ni car si ne pas non oui ' +
    'dans pour par avec sans sur sous chez vers entre lors quand comme puis alors ensuite enfin aussi très plus moins ' +
    "contrairement attention remplacer remplace corriger corrige écrire écris écrit mettre mets dire dit c'est il y a " +
    'personne décision action point sujet réunion résumé transcription'
  ).split(' '),
);

/**
 * Termes à soumettre à Whisper tirés des consignes de correction (« Pol et non Paul ») : noms
 * propres et termes entre guillemets, sauf ceux qui suivent une négation — c'est l'erreur à éviter,
 * l'ajouter au vocabulaire la renforcerait.
 */
export function correctionTerms(corrections: readonly string[]): string[] {
  const terms: string[] = [];
  for (const correction of corrections) {
    // Retire « et non Paul », « pas Paul », « au lieu de Paul », « plutôt que Paul » (mot suivant compris).
    const kept = correction.replace(/\b(?:(?:et non|non pas|et pas|pas|au lieu de|plutôt que)\s+|(?:au lieu d|plutôt qu)['’]\s*)[«"“]?\s*[\p{L}\p{N}'’-]+(?:\s*[»"”])?/giu, ' ');
    for (const [, quoted] of kept.matchAll(/[«"“]\s*([^»"”]{2,60}?)\s*[»"”]/gu)) terms.push(quoted!);
    for (const [word] of kept.matchAll(/\p{Lu}[\p{L}\p{N}'’-]{2,}/gu)) {
      if (!STOPWORDS.has(word.toLowerCase().replace(/['’].*$/, ''))) terms.push(word);
    }
  }
  return parseVocabulary(terms.join('\n'));
}

/**
 * Prompt de vocabulaire pour Whisper, du plus au moins prioritaire : texte du YAML, vocabulaire du
 * serveur, termes des corrections, participants, ordre du jour, termes du glossaire. Coupé entre deux termes.
 */
export function whisperPrompt(parts: {
  base?: string | undefined;
  vocabulary: readonly string[];
  corrections: readonly string[];
  names: readonly string[];
  agenda: readonly string[];
  /** Termes du glossaire et leurs variantes (sans définition), en dernier. */
  glossary?: readonly string[];
}): string | undefined {
  const terms = parseVocabulary([...parts.vocabulary, ...correctionTerms(parts.corrections), ...parts.names, ...parts.agenda, ...(parts.glossary ?? [])].join('\n'));
  let prompt = parts.base?.trim() ?? '';
  for (const term of terms) {
    const next = prompt ? `${prompt}${prompt === parts.base?.trim() ? ' ' : ', '}${term}` : term;
    if (next.length > PROMPT_MAX) break;
    prompt = next;
  }
  return prompt.slice(0, PROMPT_MAX) || undefined;
}

export interface Replacement {
  wrong: string;
  right: string;
}

const QUOTES = /^[«"“'‘\s]+|[»"”'’\s.!]+$/gu;
const QUOTED = /^\s*[«"“].*[»"”][\s.!]*$/u;
const NEGATION = /^(.+?)(?:\s*,\s*(?:et non|et pas|mais pas|pas|non)|\s+(?:et non|et pas|non pas|mais pas|au lieu de|plutôt que))\s+(.+)$/iu;
const LEAD = /^(?:c['’]est|il s['’]agit de|il faut écrire|on écrit|écrire|écrit)\s+/iu;

/** Ressemblance de 0 à 1 (distance d'édition rapportée à la longueur). */
function similarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length]! / Math.max(x.length, y.length, 1);
}

/**
 * Remplacements sûrs tirés des consignes de la forme « Pol et non Paul », « "cors des vents" et
 * pas "corps des vents" » : quelques mots de chaque côté, proches l'un de l'autre (faute
 * d'orthographe ou de transcription) ou cités tous les deux. Le reste (« on vote demain et pas
 * aujourd'hui ») est laissé au modèle. La dernière consigne sur un même terme l'emporte.
 */
export function correctionReplacements(corrections: readonly string[]): Replacement[] {
  const byWrong = new Map<string, Replacement>();
  const short = (s: string) => s.length >= 2 && s.length <= 60 && s.split(/\s+/).length <= 5 && !/[,;:?]/.test(s);
  for (const correction of corrections) {
    const match = NEGATION.exec(correction.trim());
    if (!match) continue;
    const left = match[1]!.replace(LEAD, '');
    const right = left.replace(QUOTES, '').trim();
    const wrong = match[2]!.replace(QUOTES, '').trim();
    if (!short(right) || !short(wrong) || right.toLowerCase() === wrong.toLowerCase()) continue;
    // Faute d'orthographe ou de transcription (termes proches), ou termes cités tous les deux.
    if (similarity(right, wrong) < 0.5 && !(QUOTED.test(left) && QUOTED.test(match[2]!))) continue;
    byWrong.set(wrong.toLowerCase(), { wrong, right });
  }
  return [...byWrong.values()];
}

/**
 * Applique les remplacements (mots entiers, casse ignorée ; majuscule initiale conservée), en un
 * seul passage : un texte remplacé n'est pas remplacé de nouveau, le terme le plus long l'emporte.
 */
export function applyReplacements(text: string, replacements: readonly Replacement[]): string {
  if (replacements.length === 0) return text;
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
  const byWrong = new Map(replacements.map((r) => [key(r.wrong), r.right]));
  const patterns = [...replacements]
    .sort((a, b) => b.wrong.length - a.wrong.length)
    .map(({ wrong }) => wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${patterns.join('|')})(?![\\p{L}\\p{N}])`, 'giu'), (found) => {
    const right = byWrong.get(key(found)) ?? found;
    return /^\p{Lu}/u.test(found) && /^\p{Ll}/u.test(right) ? right[0]!.toUpperCase() + right.slice(1) : right;
  });
}

/**
 * Remplacements de la transcription jointe au compte rendu : variantes d'écriture du glossaire
 * remplacées par le terme officiel, et consignes « Pol et non Paul » (prioritaires sur un même terme).
 */
export function transcriptReplacements(corrections: readonly string[], glossary: readonly { term: string; variants: readonly string[] }[]): Replacement[] {
  const byWrong = new Map<string, Replacement>();
  for (const { term, variants } of glossary) for (const wrong of variants) byWrong.set(wrong.toLowerCase(), { wrong, right: term });
  for (const r of correctionReplacements(corrections)) byWrong.set(r.wrong.toLowerCase(), r);
  return [...byWrong.values()];
}
