import { estimateTokens } from './transcript.js';

/** Termes au plus par serveur. */
export const GLOSSARY_MAX_TERMS = 100;
export const GLOSSARY_TERM_MAX = 60;
export const GLOSSARY_DEFINITION_MAX = 300;
/** Variantes d'écriture au plus par terme. */
export const GLOSSARY_VARIANTS_MAX = 5;
/** Place du glossaire dans une passe de résumé : au-delà, les termes les moins cités sont laissés. */
export const GLOSSARY_PASS_TOKENS = 600;

export interface GlossaryEntry {
  term: string;
  variants: readonly string[];
  definition: string;
}

/** Forme de comparaison : casse, accents et ponctuation ignorés (« Ram-Strat » = « ram strat »). */
export function glossaryKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Variantes saisies (« ramstrat, ram-strat ») : nettoyées, sans doublon ni le terme lui-même. */
export function parseVariants(text: string, term: string): string[] {
  const seen = new Set([glossaryKey(term)]);
  const out: string[] = [];
  for (const raw of text.split(/[,;\n]/)) {
    const v = raw.trim().slice(0, GLOSSARY_TERM_MAX);
    const key = glossaryKey(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.slice(0, GLOSSARY_VARIANTS_MAX);
}

export type ImportError = { line: number; reason: 'separator' | 'term' | 'definition' };

/**
 * Lignes d'import « terme (variante, variante) : définition » ; les variantes sont facultatives.
 * Lignes vides et commentaires (« # ») ignorés ; une ligne illisible est signalée par son numéro.
 * Un terme répété dans l'import : la dernière ligne l'emporte.
 */
export function parseGlossaryImport(text: string): { entries: GlossaryEntry[]; errors: ImportError[] } {
  const byKey = new Map<string, GlossaryEntry>();
  const errors: ImportError[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const sep = line.indexOf(':');
    if (sep < 0) return void errors.push({ line: i + 1, reason: 'separator' });
    const head = line.slice(0, sep).trim();
    const definition = line.slice(sep + 1).trim();
    const match = /^(.*?)\s*(?:\(([^()]*)\))?$/.exec(head);
    const term = (match?.[1] ?? head).trim();
    if (!term || term.length > GLOSSARY_TERM_MAX || !glossaryKey(term)) return void errors.push({ line: i + 1, reason: 'term' });
    if (!definition || definition.length > GLOSSARY_DEFINITION_MAX) return void errors.push({ line: i + 1, reason: 'definition' });
    byKey.set(glossaryKey(term), { term, variants: parseVariants(match?.[2] ?? '', term), definition });
  });
  return { entries: [...byKey.values()], errors };
}

/** Une ligne d'export, relisible par l'import. */
export function formatGlossaryLine(entry: GlossaryEntry): string {
  return `${entry.term}${entry.variants.length ? ` (${entry.variants.join(', ')})` : ''} : ${entry.definition.replace(/\s*\n\s*/g, ' ')}`;
}

/** Nombre d'occurrences du terme ou de ses variantes dans un texte (mots entiers). */
function occurrences(entry: GlossaryEntry, haystack: string): number {
  let n = 0;
  for (const form of [entry.term, ...entry.variants]) {
    const key = glossaryKey(form);
    if (!key) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(` ${key} `, from);
      if (at < 0) break;
      n++;
      from = at + key.length + 1;
    }
  }
  return n;
}

/**
 * Termes du glossaire présents dans un texte (morceau de transcription, résumés à fusionner),
 * les plus cités d'abord, dans la limite de `maxTokens` : seuls ceux-là sont envoyés au modèle.
 */
export function glossaryFor(text: string, glossary: readonly GlossaryEntry[], maxTokens = GLOSSARY_PASS_TOKENS): GlossaryEntry[] {
  if (glossary.length === 0) return [];
  const haystack = ` ${glossaryKey(text)} `;
  const found = glossary
    .map((entry, index) => ({ entry, index, n: occurrences(entry, haystack) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.index - b.index);
  const kept: GlossaryEntry[] = [];
  let used = 0;
  for (const { entry } of found) {
    const cost = estimateTokens(formatGlossaryLine(entry)) + 1;
    if (used + cost > maxTokens) continue;
    kept.push(entry);
    used += cost;
  }
  return kept;
}

/** Bloc de consigne du glossaire (vide sans terme). */
export function glossaryBlock(entries: readonly GlossaryEntry[]): string {
  if (entries.length === 0) return '';
  return `\n\nGlossaire (sens des termes propres à ce serveur, à utiliser pour comprendre et rédiger) :\n${entries.map((e) => `- ${formatGlossaryLine(e)}`).join('\n')}`;
}
