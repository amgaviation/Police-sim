import linesJson from '../data/uniform/lines.json';
import { fail, readObject, readString, readVersion } from '../vehicles/json';
import type { PronounSet } from './types';

/** Pronoun presets and the template engine for radio lines and reports (design Phase 7 §7.6). */

export const PRONOUN_PRESETS: Readonly<Record<'she' | 'he' | 'they', PronounSet>> = {
  she: { id: 'she', subject: 'she', object: 'her', possessive: 'her', possessivePronoun: 'hers', reflexive: 'herself', plural: false },
  he: { id: 'he', subject: 'he', object: 'him', possessive: 'his', possessivePronoun: 'his', reflexive: 'himself', plural: false },
  they: { id: 'they', subject: 'they', object: 'them', possessive: 'their', possessivePronoun: 'theirs', reflexive: 'themself', plural: true },
};

const WORD_FIELDS = ['subject', 'object', 'possessive', 'possessivePronoun', 'reflexive'] as const;
const WORD_PATTERN = /^\p{L}{1,12}$/u;

/** 'she/her', 'they/them', custom 'xe/xem'. */
export function pronounLabel(p: PronounSet): string {
  return `${p.subject}/${p.object}`;
}

/** Human-readable problems of a pronoun set (empty = valid); `path` prefixes each message. */
export function pronounErrors(x: unknown, path: string): string[] {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return [`${path} must be an object`];
  const o = x as Record<string, unknown>;
  const errors: string[] = [];
  const id = o.id;
  if (id !== 'she' && id !== 'he' && id !== 'they' && id !== 'custom') {
    errors.push(`${path}.id must be one of she, he, they, custom`);
  }
  for (const key of WORD_FIELDS) {
    const w = o[key];
    if (typeof w !== 'string' || !WORD_PATTERN.test(w)) errors.push(`${path}.${key} must be 1 to 12 letters`);
  }
  if (typeof o.plural !== 'boolean') errors.push(`${path}.plural must be true or false`);
  if (errors.length === 0 && id !== 'custom') {
    const preset = PRONOUN_PRESETS[id as 'she' | 'he' | 'they'];
    if (WORD_FIELDS.some((key) => o[key] !== preset[key]) || o.plural !== preset.plural) {
      errors.push(`${path} must match the "${String(id)}" preset`);
    }
  }
  return errors;
}

/** A preset exactly as defined, or a custom set whose five words are 1..12 letters each. */
export function isPronounSet(x: unknown): x is PronounSet {
  return pronounErrors(x, 'pronouns').length === 0;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Replaces `{token}` placeholders; unknown tokens stay as written. */
const TOKEN = /\{([A-Za-z]+)\}/g;

function resolve(key: string, p: PronounSet, vars: Readonly<Record<string, string>>): string | undefined {
  const lower = key.charAt(0).toLowerCase() + key.slice(1);
  const caps = key !== lower;
  let value: string | undefined;
  switch (lower) {
    case 'they':
      value = p.subject;
      break;
    case 'them':
      value = p.object;
      break;
    case 'their':
      value = p.possessive;
      break;
    case 'theirs':
      value = p.possessivePronoun;
      break;
    case 'themself':
      value = p.reflexive;
      break;
    case 'are':
      value = p.plural ? 'are' : 'is';
      break;
    case 'were':
      value = p.plural ? 'were' : 'was';
      break;
    case 'have':
      value = p.plural ? 'have' : 'has';
      break;
    case 's':
      // Only the lowercase verb suffix exists.
      return caps ? undefined : p.plural ? '' : 's';
    default:
      return Object.hasOwn(vars, key) ? vars[key] : undefined;
  }
  return caps ? capitalize(value) : value;
}

/**
 * Fills a template: `{they} {them} {their} {theirs} {themself}` (capitalised variants `{They}` ...), the verb
 * tokens `{are}` (is / are), `{were}`, `{have}` and `{s}` ('s' for singular, '' for plural, e.g. "report{s}"),
 * and every key of `vars` (`{name}`, `{callsign}`, `{pronouns}` ...). Unknown tokens are left as written.
 */
export function applyPronouns(template: string, p: PronounSet, vars: Readonly<Record<string, string>>): string {
  return template.replace(TOKEN, (match, key: string) => resolve(key, p, vars) ?? match);
}

/** Lines every `lines.json` must define. */
export const REQUIRED_LINES = ['officerDown', 'vestStopped', 'damageReport', 'reportHeader', 'inspection'] as const;

/** Validates the lines document; throws an Error naming `file` and the dotted path. */
export function parseCharacterLines(json: unknown, file: string): Readonly<Record<string, string>> {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const lines = readObject(root.lines, file, 'lines');
  const out: Record<string, string> = {};
  for (const key of Object.keys(lines)) out[key] = readString(lines[key], file, `lines.${key}`);
  for (const key of REQUIRED_LINES) if (out[key] === undefined) fail(file, `lines.${key}`, 'is missing');
  return out;
}

/** Radio and report line templates (`applyPronouns` input). */
export const CHARACTER_LINES: Readonly<Record<string, string>> = parseCharacterLines(linesJson, 'lines.json');
