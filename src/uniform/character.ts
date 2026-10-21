import { rankDef } from './data';
import { defaultOutfitSpec } from './outfit';
import { PRONOUN_PRESETS, pronounErrors } from './pronouns';
import { CARRIER_IDS, COLD_IDS, HAIR_STYLES, HAT_IDS, RANK_IDS, UNIFORM_CLASSES } from './types';
import type { BadgeSpec, CharacterProfile, CharacterSave, OutfitSpec, PatchSpec } from './types';

/** Character profile: validation, defaults, legacy conversion (design Phase 7 §7.4). */

type Obj = Record<string, unknown>;

const NAME_PATTERN = /^[\p{L} '.-]+$/u;
const NAME_MAX = 24;
const BADGE_PATTERN = /^[0-9]{3,6}$/;
const DEFAULT_BADGE = '4071';
const DEFAULT_FIRST = 'Alex';
const PATCH_SHAPES: readonly string[] = ['shield', 'circle', 'roundedRect', 'arch', 'polygon'];
const BADGE_SHAPES: readonly string[] = ['star', 'shield', 'circle', 'ellipse', 'polygon'];

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isColor(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 0xffffff;
}

function oneOf(x: unknown, options: readonly string[]): boolean {
  return typeof x === 'string' && options.includes(x);
}

function checkColor(o: Obj, key: string, path: string, errors: string[]): void {
  if (!isColor(o[key])) errors.push(`${path}.${key} must be an integer colour 0..0xffffff`);
}

function checkRange(o: Obj, key: string, path: string, min: number, max: number, errors: string[]): void {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) errors.push(`${path}.${key} must be a number in [${min}, ${max}]`);
}

function checkText(o: Obj, key: string, path: string, maxLength: number, errors: string[]): void {
  const v = o[key];
  if (typeof v !== 'string' || v.length > maxLength) errors.push(`${path}.${key} must be a string of at most ${maxLength} characters`);
}

function checkPoints(o: Obj, path: string, required: boolean, errors: string[]): void {
  const pts = o.points;
  if (pts === undefined && !required) return;
  const ok =
    Array.isArray(pts) &&
    pts.length >= 3 &&
    pts.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)));
  if (!ok) errors.push(`${path}.points must be an array of at least 3 [x, y] pairs`);
}

function patchErrors(x: unknown, path: string, errors: string[]): void {
  if (!isObj(x)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!oneOf(x.shape, PATCH_SHAPES)) errors.push(`${path}.shape must be one of ${PATCH_SHAPES.join(', ')}`);
  checkColor(x, 'base', path, errors);
  checkColor(x, 'border', path, errors);
  checkColor(x, 'accent', path, errors);
  checkText(x, 'initials', path, 4, errors);
  checkText(x, 'text', path, 16, errors);
  checkPoints(x, path, x.shape === 'polygon', errors);
}

function badgeErrors(x: unknown, path: string, errors: string[]): void {
  if (!isObj(x)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!oneOf(x.shape, BADGE_SHAPES)) errors.push(`${path}.shape must be one of ${BADGE_SHAPES.join(', ')}`);
  checkColor(x, 'metal', path, errors);
  checkColor(x, 'enamel', path, errors);
  checkText(x, 'text', path, 12, errors);
  if (x.shape === 'star' || x.starPoints !== undefined) {
    const n = x.starPoints;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 3 || n > 12) errors.push(`${path}.starPoints must be an integer in [3, 12]`);
  }
  checkPoints(x, path, x.shape === 'polygon', errors);
}

function outfitErrors(x: unknown, path: string, errors: string[]): void {
  if (!isObj(x)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!oneOf(x.uniform, UNIFORM_CLASSES)) errors.push(`${path}.uniform must be one of ${UNIFORM_CLASSES.join(', ')}`);
  if (x.hat !== 'default' && !oneOf(x.hat, HAT_IDS)) errors.push(`${path}.hat must be default or one of ${HAT_IDS.join(', ')}`);
  if (x.carrier !== 'default' && !oneOf(x.carrier, CARRIER_IDS)) errors.push(`${path}.carrier must be default or one of ${CARRIER_IDS.join(', ')}`);
  if (!oneOf(x.cold, COLD_IDS)) errors.push(`${path}.cold must be one of ${COLD_IDS.join(', ')}`);
  if (!oneOf(x.hairStyle, HAIR_STYLES)) errors.push(`${path}.hairStyle must be one of ${HAIR_STYLES.join(', ')}`);
  checkColor(x, 'hairColor', path, errors);
  if (typeof x.namePlate !== 'boolean') errors.push(`${path}.namePlate must be true or false`);
  patchErrors(x.patch, `${path}.patch`, errors);
  badgeErrors(x.badge, `${path}.badge`, errors);
  if (x.colors !== null) {
    if (!isObj(x.colors)) errors.push(`${path}.colors must be null or an object`);
    else {
      checkColor(x.colors, 'top', `${path}.colors`, errors);
      checkColor(x.colors, 'bottom', `${path}.colors`, errors);
    }
  }
}

function nameError(value: unknown, path: string): string | null {
  if (typeof value !== 'string') return `${path} must be a string`;
  const s = value.trim();
  if (s.length < 1 || s.length > NAME_MAX) return `${path} must have 1 to ${NAME_MAX} characters`;
  if (!NAME_PATTERN.test(s) || !/\p{L}/u.test(s)) return `${path} may only contain letters, spaces, ' . and - (at least one letter)`;
  return null;
}

function cloneOutfit(o: OutfitSpec): OutfitSpec {
  const patch: PatchSpec = { ...o.patch };
  if (o.patch.points !== undefined) patch.points = o.patch.points.map(([px, py]) => [px, py]);
  const badge: BadgeSpec = { ...o.badge };
  if (o.badge.points !== undefined) badge.points = o.badge.points.map(([px, py]) => [px, py]);
  return { ...o, patch, badge, colors: o.colors === null ? null : { ...o.colors } };
}

/**
 * Validates untrusted JSON (a saved or imported profile) and returns a fresh, trimmed copy or every
 * problem found as a dotted-path message.
 */
export function parseCharacter(json: unknown): { ok: true; profile: CharacterProfile } | { ok: false; errors: string[] } {
  if (!isObj(json)) return { ok: false, errors: ['character must be an object'] };
  const errors: string[] = [];
  if (json.version !== 1) errors.push('version must be 1');
  for (const key of ['firstName', 'lastName'] as const) {
    const e = nameError(json[key], key);
    if (e !== null) errors.push(e);
  }
  if (typeof json.badge !== 'string' || !BADGE_PATTERN.test(json.badge)) errors.push('badge must be 3 to 6 digits');
  errors.push(...pronounErrors(json.pronouns, 'pronouns'));
  const body = json.body;
  if (!isObj(body)) errors.push('body must be an object');
  else {
    checkRange(body, 'heightM', 'body', 1.5, 2.05, errors);
    checkRange(body, 'build', 'body', 0.8, 1.3, errors);
    checkRange(body, 'shoulders', 'body', 0.85, 1.2, errors);
    checkRange(body, 'hips', 'body', 0.85, 1.2, errors);
  }
  checkColor(json, 'skin', '', errors);
  if (!oneOf(json.hairStyle, HAIR_STYLES)) errors.push(`hairStyle must be one of ${HAIR_STYLES.join(', ')}`);
  checkColor(json, 'hairColor', '', errors);
  if (!oneOf(json.rank, RANK_IDS)) errors.push(`rank must be one of ${RANK_IDS.join(', ')}`);
  outfitErrors(json.outfit, 'outfit', errors);
  if (errors.length > 0) return { ok: false, errors: errors.map((e) => e.replace(/^\./, '')) };

  const p = json as unknown as CharacterProfile;
  const profile: CharacterProfile = {
    version: 1,
    firstName: p.firstName.trim(),
    lastName: p.lastName.trim(),
    badge: p.badge,
    pronouns: { ...p.pronouns },
    body: { heightM: p.body.heightM, build: p.body.build, shoulders: p.body.shoulders, hips: p.body.hips },
    skin: p.skin,
    hairStyle: p.hairStyle,
    hairColor: p.hairColor,
    rank: p.rank,
    outfit: cloneOutfit(p.outfit),
  };
  return { ok: true, profile };
}

/** Whether `x` is a `CharacterSave` wrapping a valid profile. */
export function isCharacterSave(x: unknown): x is CharacterSave {
  return isObj(x) && x.version === 1 && parseCharacter(x.profile).ok;
}

/** "Jordan Doe", badge 4071, they/them, 1.75 m, average build, skin #c68e6b, short #2a1d14 hair, officer, class B. */
export function defaultCharacter(): CharacterProfile {
  return {
    version: 1,
    firstName: 'Jordan',
    lastName: 'Doe',
    badge: DEFAULT_BADGE,
    pronouns: { ...PRONOUN_PRESETS.they },
    body: { heightM: 1.75, build: 1, shoulders: 1, hips: 1 },
    skin: 0xc68e6b,
    hairStyle: 'short',
    hairColor: 0x2a1d14,
    rank: 'officer',
    outfit: defaultOutfitSpec('classB'),
  };
}

/**
 * From a pre-v9 `officer { name, badge }`: strips a leading "Officer ", splits first / last at the first space
 * (a single word becomes the last name, first name "Alex"), keeps the badge when it is 3-6 digits.
 */
export function characterFromLegacy(name: string, badge: string): CharacterProfile {
  const profile = defaultCharacter();
  const cleaned = name
    .replace(/[^\p{L} '.-]/gu, '')
    .replace(/^\s*officer(\s+|$)/i, '')
    .trim()
    .replace(/\s+/g, ' ');
  if (/\p{L}/u.test(cleaned)) {
    const space = cleaned.indexOf(' ');
    if (space < 0) {
      profile.firstName = DEFAULT_FIRST;
      profile.lastName = cleaned.slice(0, NAME_MAX);
    } else {
      profile.firstName = cleaned.slice(0, space).slice(0, NAME_MAX);
      profile.lastName = cleaned.slice(space + 1).slice(0, NAME_MAX).trim();
    }
  }
  // A name that still fails the profile rules (e.g. punctuation only) falls back to the default.
  const fallback = defaultCharacter();
  if (nameError(profile.firstName, 'firstName') !== null) profile.firstName = fallback.firstName;
  if (nameError(profile.lastName, 'lastName') !== null) profile.lastName = fallback.lastName;
  if (BADGE_PATTERN.test(badge)) profile.badge = badge;
  return profile;
}

/** `Officer First Last`; a higher rank shows its label instead of "Officer". */
export function displayName(p: CharacterProfile): string {
  return `${rankDef(p.rank).label} ${p.firstName} ${p.lastName}`;
}
