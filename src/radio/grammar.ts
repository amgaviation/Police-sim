/**
 * Voice-command grammar (design §9.5): normalises a recognised utterance (case, punctuation, number
 * words <-> digits, ten-codes) and matches the synonyms of commands.json. Pure.
 */
import type { UnitRequest, UnitStatus } from '../cad/types';
import { UNIT_STATUSES } from '../cad/types';
import { COMMAND_GROUPS, PHONETIC, VOICE_COMMANDS, type CommandGroup } from './data';

export interface VoiceContext {
  /** Plate of the targeted / stopped car, used when no plate is spoken. */
  readonly fallbackPlate?: string | null;
  /** Vehicle id of the fallback plate (-1 / absent: unknown). */
  readonly fallbackVehicleId?: number;
  /** The call currently offered to the player (-1 / absent: none). */
  readonly offerCallId?: number;
}

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9,
};
const TEENS: Readonly<Record<string, number>> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** Homophones recognisers produce for digits. */
const DIGIT_ALIASES: Readonly<Record<string, string>> = { to: '2', too: '2', for: '4', won: '1', ate: '8' };

/** Lower case, apostrophes dropped, everything but letters/digits becomes a space. */
function clean(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t !== '');
}

/** Number words -> digits ("twenty eight" -> "28", "niner" -> "9"); "10 8" -> "10-8". */
function numbersToDigits(tokens: readonly string[], aliasDigits: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    const next = tokens[i + 1];
    const tens = TENS[t];
    if (tens !== undefined) {
      const unit = next !== undefined ? UNITS[next] : undefined;
      if (unit !== undefined && unit > 0 && next !== 'o' && next !== 'oh') {
        out.push(String(tens + unit));
        i++;
      } else {
        out.push(String(tens));
      }
      continue;
    }
    const teen = TEENS[t];
    if (teen !== undefined) {
      out.push(String(teen));
      continue;
    }
    // A lone "o" is a letter (plates); "oh" is zero.
    const unit = t === 'o' ? undefined : UNITS[t];
    if (unit !== undefined) {
      out.push(String(unit));
      continue;
    }
    if (aliasDigits && DIGIT_ALIASES[t] !== undefined) {
      out.push(DIGIT_ALIASES[t]);
      continue;
    }
    out.push(t);
  }
  // Ten-codes: "10" followed by a number.
  const joined: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const t = out[i] as string;
    const next = out[i + 1];
    if (t === '10' && next !== undefined && /^\d{1,3}$/.test(next)) {
      joined.push(`10-${next}`);
      i++;
    } else {
      joined.push(t);
    }
  }
  return joined;
}

/** Normalised token list of an utterance (exported for tests and the console). */
export function normalizeUtterance(text: string): string[] {
  return numbersToDigits(clean(text), false);
}

interface Synonym {
  readonly tokens: readonly string[];
  readonly group: CommandGroup | 'status';
  readonly status: UnitStatus | null;
}

/** Match order on equal length: earlier wins. */
const GROUP_ORDER: readonly (CommandGroup | 'status')[] = [
  'runPlate', 'backup', 'trafficStop', 'location', 'code4', 'repeat', 'accept', 'decline', 'status',
];

let synonyms: Synonym[] | null = null;

function synonymTable(): Synonym[] {
  if (synonyms) return synonyms;
  const list: Synonym[] = [];
  for (const g of COMMAND_GROUPS) {
    if (g === 'emergencyWords') continue;
    for (const p of VOICE_COMMANDS.groups[g]) list.push({ tokens: normalizeUtterance(p), group: g, status: null });
  }
  for (const s of UNIT_STATUSES) for (const p of VOICE_COMMANDS.status[s]) list.push({ tokens: normalizeUtterance(p), group: 'status', status: s });
  synonyms = list.filter((s) => s.tokens.length > 0);
  return synonyms;
}

/** Index of the first occurrence of `needle` in `hay` as whole tokens, -1 when absent. */
function findTokens(hay: readonly string[], needle: readonly string[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

let letterWords: Map<string, string> | null = null;

/** Phonetic word (APCO and NATO, lower case) -> capital letter. */
function phoneticLetters(): Map<string, string> {
  if (letterWords) return letterWords;
  const m = new Map<string, string>();
  const add = (word: string, letter: string): void => {
    const key = clean(word).join(' ');
    if (key !== '') m.set(key, letter);
  };
  for (const [letter, word] of Object.entries(PHONETIC.letters)) add(word, letter);
  for (const [letter, words] of Object.entries(PHONETIC.nato)) for (const w of words) add(w, letter);
  letterWords = m;
  return m;
}

/** Words a speaker puts around a plate that are not letters. */
const FILLERS = new Set(['a', 'an', 'the', 'for', 'on', 'of', 'please', 'plate', 'number', 'me', 'its', 'is', 'this', 'that', 'my', 'license', 'tag']);

/** "ABC 1234" from the tokens after "run plate"; null when no complete plate was spoken. */
function readPlate(raw: readonly string[]): string | null {
  const words = phoneticLetters();
  let letters = '';
  let digits = '';
  for (let i = 0; i < raw.length && digits.length < 4; i++) {
    const t = raw[i] as string;
    const pair = i + 1 < raw.length ? `${t} ${raw[i + 1] as string}` : '';
    if (letters.length < 3 && digits.length === 0 && pair !== '' && words.has(pair)) {
      letters += words.get(pair) as string;
      i++;
      continue;
    }
    const letter = words.get(t);
    if (letter !== undefined && letters.length < 3 && digits.length === 0) {
      letters += letter;
      continue;
    }
    if (/^\d+$/.test(t)) {
      if (letters.length === 3) digits += t;
      continue;
    }
    const mixed = /^([a-z]{1,3})(\d{1,4})$/.exec(t);
    if (mixed && digits.length === 0 && letters.length + (mixed[1] as string).length <= 3) {
      letters += (mixed[1] as string).toUpperCase();
      if (letters.length === 3) digits += mixed[2] as string;
      continue;
    }
    // Single letters are always letters ("a b c"); short words only when they are not fillers ("abc").
    if (/^[a-z]{1,3}$/.test(t) && digits.length === 0 && (t.length === 1 || !FILLERS.has(t)) && letters.length + t.length <= 3) {
      letters += t.toUpperCase();
      continue;
    }
  }
  if (letters.length !== 3 || digits.length !== 4) return null;
  return `${letters} ${digits}`;
}

function wantsCode3(tokens: readonly string[]): boolean {
  const code = tokens.indexOf('code');
  if (code >= 0 && tokens[code + 1] === '3') return true;
  if (code >= 0 && tokens[code + 1] === '2') return false;
  for (const p of VOICE_COMMANDS.groups.emergencyWords) {
    const t = normalizeUtterance(p);
    if (t.length > 0 && !(t[0] === 'code') && findTokens(tokens, t) >= 0) return true;
  }
  return false;
}

/**
 * Parses a recognised utterance into a request; null when nothing matches (or "run plate" without a
 * plate and no fallback).
 */
export function parseVoiceCommand(text: string, ctx: VoiceContext = {}): UnitRequest | null {
  const tokens = normalizeUtterance(text);
  if (tokens.length === 0) return null;
  let best: Synonym | null = null;
  let bestAt = -1;
  for (const s of synonymTable()) {
    const at = findTokens(tokens, s.tokens);
    if (at < 0) continue;
    if (
      best === null ||
      s.tokens.length > best.tokens.length ||
      (s.tokens.length === best.tokens.length && GROUP_ORDER.indexOf(s.group) < GROUP_ORDER.indexOf(best.group))
    ) {
      best = s;
      bestAt = at;
    }
  }
  if (best === null) return null;
  const offer = ctx.offerCallId ?? -1;
  switch (best.group) {
    case 'status':
      return { kind: 'status', status: best.status ?? 'available' };
    case 'accept':
      return offer >= 0 ? { kind: 'acceptCall', callId: offer } : { kind: 'status', status: 'enRoute' };
    case 'decline':
      return { kind: 'declineCall', callId: offer };
    case 'runPlate': {
      const after = numbersToDigits(clean(text), true);
      // Re-find the phrase in the digit-aliased tokens ("run plate for ..." keeps its words).
      const start = findTokens(after, best.tokens);
      const rest = after.slice(start >= 0 ? start + best.tokens.length : bestAt + best.tokens.length);
      const plate = readPlate(rest);
      const fallback = ctx.fallbackPlate ?? null;
      if (plate !== null) {
        const vehicleId = fallback !== null && plate === fallback.trim().toUpperCase() ? (ctx.fallbackVehicleId ?? -1) : -1;
        return { kind: 'runPlate', plate, vehicleId };
      }
      if (fallback !== null && fallback !== '') return { kind: 'runPlate', plate: fallback, vehicleId: ctx.fallbackVehicleId ?? -1 };
      return null;
    }
    case 'backup':
      return { kind: 'backup', code: wantsCode3(tokens) ? 3 : 2 };
    case 'location':
      return { kind: 'location' };
    case 'code4':
      return { kind: 'code4' };
    case 'trafficStop':
      return { kind: 'trafficStop' };
    case 'repeat':
      return { kind: 'repeat' };
    default:
      return null;
  }
}
