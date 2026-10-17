/**
 * Fuzzy address matching for Geocoding (AI Phase 2) — pure, in-process, no
 * external service. Built for Indian municipal addresses:
 *
 *  1. normalizeAddress(): Indic scripts (Devanagari, Gujarati, Bengali,
 *     Gurmukhi, Odia, Tamil, Telugu, Kannada, Malayalam) transliterated to
 *     Latin; abbreviations expanded (rd → road, nr → near …); filler words,
 *     house / plot numbers and PIN codes dropped; spelling variants folded
 *     (chowk / chauk, shivaji / sivaji, aa / a, w / v, bh / b …), the same
 *     way on both sides.
 *  2. AddressMatcher: trigram matching weighted by rarity (IDF) over the
 *     reference values, so a distinctive word ("shivaji") outweighs a
 *     generic one ("road"), and a reference value contained in a longer
 *     address ("plot 12 near shivaji chowk ward 5") still matches. An
 *     inverted trigram index keeps it fast for thousands of addresses
 *     against ~100k reference values.
 */

// ----- transliteration -----

/** Every major Indic block mirrors Devanagari's layout (ISCII), 0x80 apart:
 *  Bengali 0980, Gurmukhi 0A00, Gujarati 0A80, Odia 0B00, Tamil 0B80,
 *  Telugu 0C00, Kannada 0C80, Malayalam 0D00. */
const INDIC_START = 0x0900;
const INDIC_END = 0x0d7f;

const VOWELS: Record<number, string> = {
  0x05: 'a', 0x06: 'aa', 0x07: 'i', 0x08: 'ii', 0x09: 'u', 0x0a: 'uu', 0x0b: 'ri',
  0x0d: 'e', 0x0e: 'e', 0x0f: 'e', 0x10: 'ai', 0x11: 'o', 0x12: 'o', 0x13: 'o', 0x14: 'au',
};
const MATRAS: Record<number, string> = {
  0x3e: 'aa', 0x3f: 'i', 0x40: 'ii', 0x41: 'u', 0x42: 'uu', 0x43: 'ri', 0x45: 'e', 0x46: 'e',
  0x47: 'e', 0x48: 'ai', 0x49: 'o', 0x4a: 'o', 0x4b: 'o', 0x4c: 'au',
};
const CONSONANTS: Record<number, string> = {
  0x15: 'k', 0x16: 'kh', 0x17: 'g', 0x18: 'gh', 0x19: 'n', 0x1a: 'ch', 0x1b: 'chh', 0x1c: 'j',
  0x1d: 'jh', 0x1e: 'n', 0x1f: 't', 0x20: 'th', 0x21: 'd', 0x22: 'dh', 0x23: 'n', 0x24: 't',
  0x25: 'th', 0x26: 'd', 0x27: 'dh', 0x28: 'n', 0x29: 'n', 0x2a: 'p', 0x2b: 'ph', 0x2c: 'b',
  0x2d: 'bh', 0x2e: 'm', 0x2f: 'y', 0x30: 'r', 0x31: 'r', 0x32: 'l', 0x33: 'l', 0x34: 'l',
  0x35: 'v', 0x36: 'sh', 0x37: 'sh', 0x38: 's', 0x39: 'h',
  0x58: 'q', 0x59: 'kh', 0x5a: 'g', 0x5b: 'z', 0x5c: 'r', 0x5d: 'rh', 0x5e: 'f', 0x5f: 'y',
};
const VIRAMA = 0x4d;
const SIGNS: Record<number, string> = { 0x01: 'n', 0x02: 'n', 0x03: 'h' };

function indicOffset(cp: number): number | null {
  if (cp < INDIC_START || cp > INDIC_END) return null;
  return (cp - INDIC_START) % 0x80;
}

/** Indic scripts → Latin (simplified Hunterian, inherent "a" dropped at
 *  word end: राम → ram, शिवाजी → shivaajii → folded later). Other text is
 *  passed through unchanged. */
export function transliterate(text: string): string {
  const chars = [...text.normalize('NFC')];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0)!;
    const off = indicOffset(cp);
    if (off === null) {
      out += chars[i];
      continue;
    }
    if (off >= 0x66 && off <= 0x6f) {
      out += String(off - 0x66); // Indic digits
    } else if (VOWELS[off]) {
      out += VOWELS[off];
    } else if (CONSONANTS[off]) {
      out += CONSONANTS[off];
      const next = chars[i + 1]?.codePointAt(0);
      const nextOff = next === undefined ? null : indicOffset(next);
      // nukta (0x3c) modifies the consonant — look past it
      const after = nextOff === 0x3c ? chars[i + 2]?.codePointAt(0) : next;
      const afterOff = after === undefined ? null : indicOffset(after);
      const takesMatra = afterOff !== null && (MATRAS[afterOff] !== undefined || afterOff === VIRAMA);
      const wordContinues = afterOff !== null && (CONSONANTS[afterOff] !== undefined || SIGNS[afterOff] !== undefined || VOWELS[afterOff] !== undefined);
      if (!takesMatra && wordContinues) out += 'a';
    } else if (MATRAS[off]) {
      out += MATRAS[off];
    } else if (SIGNS[off]) {
      out += SIGNS[off];
    } else if (off === 0x64 || off === 0x65) {
      out += ' '; // danda
    }
    // virama, nukta, other marks: nothing
  }
  return out;
}

// ----- normalisation -----

const ABBREVIATIONS: Record<string, string> = {
  rd: 'road', st: 'street', ln: 'lane', mg: 'mahatma gandhi', marg: 'road', mrg: 'road', path: 'road',
  chk: 'chowk', chwk: 'chowk', chauk: 'chowk', ngr: 'nagar', nagr: 'nagar', soc: 'society', sco: 'society',
  hsg: 'housing', apt: 'apartment', apts: 'apartment', appt: 'apartment', bldg: 'building', bldng: 'building',
  cplx: 'complex', compl: 'complex', colny: 'colony', clny: 'colony', ext: 'extension', extn: 'extension',
  stn: 'station', rly: 'railway', hosp: 'hospital', sch: 'school', mkt: 'market', mandir: 'temple',
  masjid: 'mosque', sec: 'sector', sect: 'sector', ph: 'phase', blk: 'block', opp: 'opposite', nr: 'near',
  bh: 'behind', bhd: 'behind', govt: 'government', mun: 'municipal', corp: 'corporation', no: 'number',
};
/** Words that locate rather than name ("near", "opposite") or label a
 *  number ("plot 12") — they carry no matching signal. */
const FILLER = new Set([
  'near', 'opposite', 'behind', 'beside', 'next', 'to', 'at', 'of', 'the', 'and', 'in', 'on', 'off', 'from',
  'number', 'plot', 'flat', 'house', 'h', 'room', 'shop', 'floor', 'wing', 'survey', 's', 'cts', 'gat',
  'post', 'po', 'ta', 'tal', 'taluka', 'dist', 'district', 'pin', 'pincode', 'city', 'india', 'c', 'o', 'w',
]);

/** Spelling variants of the same Indian word, folded identically on both
 *  sides (chowk / chauk → chok, shivaji / sivaji → sivaji, …). */
function fold(token: string): string {
  if (/^\d+$/.test(token)) return token;
  let t = token
    .replace(/(au|ow|ou|oa)/g, 'o')
    .replace(/ph/g, 'f')
    .replace(/([bdgjkt])h/g, '$1') // aspirates: bh dh gh jh kh th
    .replace(/sh/g, 's')
    .replace(/ch/g, 'c')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/q/g, 'k')
    .replace(/(ee|ii|ie|ey|y$)/g, 'i')
    .replace(/(oo|uu)/g, 'u')
    .replace(/(.)\1+/g, '$1'); // aa → a, nn → n, ll → l
  if (t.length > 3) t = t.replace(/a$/, ''); // trailing schwa: ganesha → ganesh
  return t;
}

/** Initials written with dots or spaces ("M.G.", "s v") → one token
 *  ("mg", "sv"), so the abbreviation table can expand them. */
function joinInitials(tokens: string[]): string[] {
  const out: string[] = [];
  let run = '';
  for (const t of tokens) {
    if (/^[a-z]$/.test(t)) {
      run += t;
      continue;
    }
    if (run) out.push(run);
    run = '';
    out.push(t);
  }
  if (run) out.push(run);
  return out;
}

export function normalizeAddress(raw: string): string {
  const latin = transliterate(raw ?? '').toLowerCase();
  const tokens = joinInitials(
    latin
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/([a-z])(\d)/g, '$1 $2')
      .split(' ')
      .filter(Boolean),
  )
    .flatMap((t) => (ABBREVIATIONS[t] ?? t).split(' '))
    .filter((t) => !FILLER.has(t))
    .filter((t) => !/^\d{6}$/.test(t)) // PIN code
    .filter((t) => !/^\d+$/.test(t) || t.length <= 3) // long house / survey numbers
    .map(fold)
    .filter(Boolean);
  return tokens.join(' ');
}

// ----- trigram matching -----

/** pg_trgm-style trigrams: each word padded "  word " → "  w", " wo", … */
export function trigrams(normalized: string): string[] {
  const out = new Set<string>();
  for (const word of normalized.split(' ')) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return [...out];
}

export interface ReferenceEntry<T> {
  value: string;
  payload: T;
}

export interface AddressMatch<T> {
  value: string;
  payload: T;
  /** 0..1 — how much of the reference value's (rarity-weighted) trigrams
   *  the address contains, discounted when the address barely overlaps. */
  score: number;
  normalized: string;
}

interface Ref<T> {
  entry: ReferenceEntry<T>;
  grams: string[];
  weight: number;
}

/** Trigrams in more than this share of reference values are too common to
 *  find candidates with (they still count in the scores). */
const COMMON_TRIGRAM_SHARE = 0.2;

export class AddressMatcher<T> {
  private readonly refs: Ref<T>[] = [];
  private readonly idf = new Map<string, number>();
  private readonly postings = new Map<string, number[]>();

  constructor(entries: ReferenceEntry<T>[]) {
    const df = new Map<string, number>();
    const prepared = entries
      .map((entry) => ({ entry, grams: trigrams(normalizeAddress(entry.value)) }))
      .filter((r) => r.grams.length > 0);
    for (const r of prepared) for (const g of r.grams) df.set(g, (df.get(g) ?? 0) + 1);
    const n = Math.max(prepared.length, 1);
    for (const [g, count] of df) this.idf.set(g, Math.log(1 + n / count));
    prepared.forEach((r, index) => {
      const weight = r.grams.reduce((s, g) => s + this.weightOf(g), 0);
      this.refs.push({ ...r, weight });
      for (const g of r.grams) {
        if ((df.get(g) ?? 0) / n > COMMON_TRIGRAM_SHARE && n > 20) continue;
        let list = this.postings.get(g);
        if (!list) this.postings.set(g, (list = []));
        list.push(index);
      }
    });
  }

  get size(): number {
    return this.refs.length;
  }

  /** Unknown trigrams (only in addresses) weigh like the rarest known. */
  private weightOf(gram: string): number {
    return this.idf.get(gram) ?? Math.log(1 + Math.max(this.refs.length, 1));
  }

  match(address: string, minScore = 0.5): AddressMatch<T> | null {
    const normalized = normalizeAddress(address);
    const grams = trigrams(normalized);
    if (!grams.length || !this.refs.length) return null;
    const addrWeight = grams.reduce((s, g) => s + this.weightOf(g), 0);

    const shared = new Map<number, number>();
    for (const g of grams) {
      const list = this.postings.get(g);
      if (!list) continue;
      const w = this.weightOf(g);
      for (const idx of list) shared.set(idx, (shared.get(idx) ?? 0) + w);
    }
    // Candidates came from the rarer trigrams; score them on all of them.
    const gramSet = new Set(grams);

    let best: { ref: Ref<T>; score: number; rank: number } | null = null;
    for (const [idx] of shared) {
      const ref = this.refs[idx];
      let matched = 0;
      for (const g of ref.grams) if (gramSet.has(g)) matched += this.weightOf(g);
      const containment = matched / ref.weight;
      const similarity = matched / (ref.weight + addrWeight - matched);
      // Containment finds "shivaji chowk" inside a long address; the
      // similarity term breaks ties toward the closest whole value and
      // keeps a 1-word reference from beating a fuller one.
      const score = Math.min(1, 0.75 * containment + 0.25 * Math.sqrt(similarity));
      const rank = score * Math.sqrt(matched);
      if (!best || rank > best.rank) best = { ref, score, rank };
    }
    if (!best || best.score < minScore) return null;
    return {
      value: best.ref.entry.value,
      payload: best.ref.entry.payload,
      score: Math.round(best.score * 1000) / 1000,
      normalized,
    };
  }
}
