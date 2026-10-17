/**
 * Display text -> text for TTS (design §9.4): ten-codes ("10-8" -> "ten eight"), "Code 4" -> "code four",
 * "P2" -> "priority two", plates ("ABC 1234" -> "Adam, Boy, Charles, one two three four") and short
 * numbers such as callsigns ("12" -> "twelve"). Everything else is unchanged.
 */
import { PHONETIC } from './data';

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0..999 in words ("76" -> "seventy six", "108" -> "one oh eight"). */
export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) return String(n);
  if (n < 20) return ONES[n] ?? String(n);
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)] ?? '';
    return n % 10 === 0 ? t : `${t} ${ONES[n % 10] ?? ''}`;
  }
  if (n < 1000) {
    const rest = n % 100;
    const head = ONES[Math.floor(n / 100)] ?? '';
    if (rest === 0) return `${head} hundred`;
    return rest < 10 ? `${head} oh ${ONES[rest] ?? ''}` : `${head} ${numberWords(rest)}`;
  }
  return String(n);
}

function digitWords(digits: string): string {
  let out = '';
  for (const d of digits) out += (out === '' ? '' : ' ') + (PHONETIC.digits[d] ?? d);
  return out;
}

function letterWords(letters: string): string {
  let out = '';
  for (const c of letters) out += (out === '' ? '' : ', ') + (PHONETIC.letters[c] ?? c);
  return out;
}

const PLATE_RE = /\b([A-Z]{3}) (\d{4})\b/g;
const TEN_CODE_RE = /\b10-(\d{1,3})\b/g;
const CODE_RE = /\b[Cc]ode (\d)\b/g;
const PRIORITY_RE = /\bP([1-4])\b/g;
/** A standalone 1-2 digit number (not part of a date, time, code or word). */
const SHORT_NUMBER_RE = /(?<![\w/:.-])(\d{1,2})(?![\w/:-]|\.\d)/g;

export function toSpoken(text: string): string {
  return text
    .replace(PLATE_RE, (_m, letters: string, digits: string) => `${letterWords(letters)}, ${digitWords(digits)}`)
    .replace(TEN_CODE_RE, (_m, n: string) => `ten ${numberWords(Number(n))}`)
    .replace(CODE_RE, (_m, n: string) => `code ${numberWords(Number(n))}`)
    .replace(PRIORITY_RE, (_m, n: string) => `priority ${numberWords(Number(n))}`)
    .replace(SHORT_NUMBER_RE, (_m, n: string) => numberWords(Number(n)));
}

/** Word count used for the duration estimate. */
export function wordCount(text: string): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const space = c === 32 || c === 9 || c === 10 || c === 13;
    if (!space && !inWord) n++;
    inWord = !space;
  }
  return n;
}
