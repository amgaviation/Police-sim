/**
 * Character creator state and reducer (Phase 7 §12.2). Pure. The profile is kept as typed (a half-typed name is
 * allowed) and `errors` lists what `parseCharacter` rejects; sliders clamp to the profile ranges; the gear check comes
 * from the host's `validateGear` (passed in), and only warns.
 */
import { GEAR_ITEMS, ASSIGNMENTS, gearItem, officerPreset } from '../../gear';
import type { Assignment, LoadoutValidation, OfficerLoadout } from '../../gear';
import {
  PRONOUN_PRESETS,
  UNIFORM_DATA,
  parseCharacter,
  uniformClass,
  type BadgeSpec,
  type CarrierId,
  type CharacterProfile,
  type ColdId,
  type HairStyle,
  type HatId,
  type PatchSpec,
  type RankId,
  type UniformClass,
} from '../../uniform';
import { defaultPolygon } from '../livery/polygonPad';

export type CreatorTab = 'identity' | 'body' | 'uniform' | 'badge' | 'gear';

export const CREATOR_TABS: readonly CreatorTab[] = ['identity', 'body', 'uniform', 'badge', 'gear'];

export const CREATOR_TAB_LABELS: Readonly<Record<CreatorTab, string>> = {
  identity: 'Identity',
  body: 'Body',
  uniform: 'Uniform',
  badge: 'Badge & patch',
  gear: 'Gear',
};

/** Computes the gear check (the host's `validateGear`). */
export type GearValidator = (loadout: OfficerLoadout, extraVestSlots: number) => LoadoutValidation;

export interface CreatorState {
  profile: CharacterProfile;
  gear: OfficerLoadout;
  tab: CreatorTab;
  /** `parseCharacter` problems of the profile (Done is disabled while any remain). */
  errors: string[];
  /** The gear check, null without a validator. Gear problems only warn. */
  gearCheck: LoadoutValidation | null;
}

export type PronounWord = 'subject' | 'object' | 'possessive' | 'possessivePronoun' | 'reflexive';
export type BodyField = keyof CharacterProfile['body'];

/** Slider ranges of the body fields (the profile limits). */
export const BODY_RANGES: Readonly<Record<BodyField, { min: number; max: number; step: number; label: string }>> = {
  heightM: { min: 1.5, max: 2.05, step: 0.01, label: 'Height' },
  build: { min: 0.8, max: 1.3, step: 0.01, label: 'Build' },
  shoulders: { min: 0.85, max: 1.2, step: 0.01, label: 'Shoulders' },
  hips: { min: 0.85, max: 1.2, step: 0.01, label: 'Hips' },
};

export type CreatorAction =
  | { kind: 'tab'; tab: CreatorTab }
  | { kind: 'setText'; field: 'firstName' | 'lastName' | 'badge'; value: string }
  | { kind: 'setPronounPreset'; preset: 'she' | 'he' | 'they' }
  | { kind: 'setPronounsCustom' }
  | { kind: 'setPronounWord'; word: PronounWord; value: string }
  | { kind: 'setPlural'; plural: boolean }
  | { kind: 'setBody'; field: BodyField; value: number }
  | { kind: 'setSkin'; color: number }
  | { kind: 'setHairStyle'; style: HairStyle }
  | { kind: 'setHairColor'; color: number }
  | { kind: 'setRank'; rank: RankId }
  | { kind: 'setUniform'; uniform: UniformClass }
  | { kind: 'setHat'; hat: HatId | 'default' }
  | { kind: 'setCarrier'; carrier: CarrierId | 'default' }
  | { kind: 'setCold'; cold: ColdId }
  | { kind: 'setNamePlate'; on: boolean }
  | { kind: 'setColors'; colors: { top: number; bottom: number } | null }
  | { kind: 'setBadge'; patch: Partial<BadgeSpec> }
  | { kind: 'setPatch'; patch: Partial<PatchSpec> }
  | { kind: 'setAssignment'; assignment: Assignment }
  | { kind: 'applyPreset'; preset: string }
  | { kind: 'setItem'; id: string; count: number }
  | { kind: 'setRetention'; id: string; level: 1 | 2 | 3 }
  | { kind: 'setGear'; gear: OfficerLoadout };

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** The vest-slot bonus of an external carrier (design §8.4). */
export function extraVestSlots(profile: CharacterProfile): number {
  const o = profile.outfit;
  const carrier = o.carrier === 'default' ? uniformClass(o.uniform).carrier : o.carrier;
  return carrier === 'external' ? 2 : 0;
}

function copyGear(g: OfficerLoadout): OfficerLoadout {
  return { assignment: g.assignment, items: g.items.map((it) => ({ ...it })) };
}

function copyProfile(p: CharacterProfile): CharacterProfile {
  return {
    ...p,
    pronouns: { ...p.pronouns },
    body: { ...p.body },
    outfit: {
      ...p.outfit,
      patch: { ...p.outfit.patch, ...(p.outfit.patch.points ? { points: p.outfit.patch.points.map(([x, y]): [number, number] => [x, y]) } : {}) },
      badge: { ...p.outfit.badge, ...(p.outfit.badge.points ? { points: p.outfit.badge.points.map(([x, y]): [number, number] => [x, y]) } : {}) },
      colors: p.outfit.colors === null ? null : { ...p.outfit.colors },
    },
  };
}

/** `parseCharacter` problems of `profile` (empty when valid). */
export function profileErrors(profile: CharacterProfile): string[] {
  const r = parseCharacter(profile);
  return r.ok ? [] : r.errors;
}

/** A fresh, trimmed copy of the profile when it is valid (what `done` hands to the host), else null. */
export function creatorProfile(s: CreatorState): CharacterProfile | null {
  const r = parseCharacter(s.profile);
  return r.ok ? r.profile : null;
}

/** The opening state; `validateGear` (the host's) fills `gearCheck`. */
export function createCreatorState(start: { profile: CharacterProfile; gear: OfficerLoadout }, validateGear?: GearValidator, tab: CreatorTab = 'identity'): CreatorState {
  const profile = copyProfile(start.profile);
  const gear = copyGear(start.gear);
  return { profile, gear, tab, errors: profileErrors(profile), gearCheck: validateGear ? validateGear(gear, extraVestSlots(profile)) : null };
}

/** Sets the count of one gear item (clamped to 0..max; a holster-style item starts at retention 2). */
export function withItemCount(gear: OfficerLoadout, id: string, count: number): OfficerLoadout {
  const def = gearItem(id);
  if (def === undefined) return gear;
  const n = clamp(Math.trunc(Number.isFinite(count) ? count : 0), 0, def.max);
  const copy = gear.items.map((it) => ({ ...it }));
  if (n === 0) return { assignment: gear.assignment, items: copy.filter((it) => it.id !== id) };
  const existing = copy.find((it) => it.id === id);
  if (existing) {
    existing.count = n;
    if (def.retention && existing.retention === undefined) existing.retention = 2;
  } else {
    copy.push(def.retention ? { id, count: n, retention: 2 } : { id, count: n });
  }
  return { assignment: gear.assignment, items: copy };
}

/** Sets a holster retention level (only on items that take one and are in the loadout). */
export function withRetention(gear: OfficerLoadout, id: string, level: 1 | 2 | 3): OfficerLoadout {
  return { assignment: gear.assignment, items: gear.items.map((it) => (it.id === id && gearItem(id)?.retention === true ? { ...it, retention: level } : { ...it })) };
}

function withProfile(s: CreatorState, profile: CharacterProfile, validateGear?: GearValidator, gear: OfficerLoadout = s.gear): CreatorState {
  return { ...s, profile, gear, errors: profileErrors(profile), gearCheck: validateGear ? validateGear(gear, extraVestSlots(profile)) : s.gearCheck };
}

/** Pure reducer. `validateGear` is the host's check; without it `gearCheck` stays as it was. */
export function creatorReducer(s: CreatorState, a: CreatorAction, validateGear?: GearValidator): CreatorState {
  const p = copyProfile(s.profile);
  switch (a.kind) {
    case 'tab':
      return s.tab === a.tab ? s : { ...s, tab: a.tab };
    case 'setText':
      p[a.field] = a.value;
      return withProfile(s, p, validateGear);
    case 'setPronounPreset':
      p.pronouns = { ...PRONOUN_PRESETS[a.preset] };
      return withProfile(s, p, validateGear);
    case 'setPronounsCustom':
      p.pronouns = { ...p.pronouns, id: 'custom' };
      return withProfile(s, p, validateGear);
    case 'setPronounWord':
      p.pronouns = { ...p.pronouns, [a.word]: a.value, id: 'custom' };
      return withProfile(s, p, validateGear);
    case 'setPlural':
      p.pronouns = { ...p.pronouns, plural: a.plural, id: 'custom' };
      return withProfile(s, p, validateGear);
    case 'setBody': {
      const r = BODY_RANGES[a.field];
      if (!Number.isFinite(a.value)) return s;
      p.body[a.field] = clamp(a.value, r.min, r.max);
      return withProfile(s, p, validateGear);
    }
    case 'setSkin':
      p.skin = a.color & 0xffffff;
      return withProfile(s, p, validateGear);
    case 'setHairStyle':
      p.hairStyle = a.style;
      p.outfit.hairStyle = a.style;
      return withProfile(s, p, validateGear);
    case 'setHairColor':
      p.hairColor = a.color & 0xffffff;
      p.outfit.hairColor = p.hairColor;
      return withProfile(s, p, validateGear);
    case 'setRank':
      p.rank = a.rank;
      return withProfile(s, p, validateGear);
    case 'setUniform':
      p.outfit.uniform = a.uniform;
      return withProfile(s, p, validateGear);
    case 'setHat':
      p.outfit.hat = a.hat;
      return withProfile(s, p, validateGear);
    case 'setCarrier':
      p.outfit.carrier = a.carrier;
      return withProfile(s, p, validateGear);
    case 'setCold':
      p.outfit.cold = a.cold;
      return withProfile(s, p, validateGear);
    case 'setNamePlate':
      p.outfit.namePlate = a.on;
      return withProfile(s, p, validateGear);
    case 'setColors':
      p.outfit.colors = a.colors === null ? null : { top: a.colors.top & 0xffffff, bottom: a.colors.bottom & 0xffffff };
      return withProfile(s, p, validateGear);
    case 'setBadge': {
      const b: BadgeSpec = { ...p.outfit.badge, ...a.patch };
      if (b.shape === 'star') b.starPoints ??= 5;
      else delete b.starPoints;
      if (b.shape === 'polygon') b.points ??= defaultPolygon();
      else delete b.points;
      p.outfit.badge = b;
      return withProfile(s, p, validateGear);
    }
    case 'setPatch': {
      const q: PatchSpec = { ...p.outfit.patch, ...a.patch };
      if (q.shape === 'polygon') q.points ??= defaultPolygon();
      else delete q.points;
      p.outfit.patch = q;
      return withProfile(s, p, validateGear);
    }
    case 'setAssignment':
      if (!ASSIGNMENTS.includes(a.assignment)) return s;
      return withProfile(s, p, validateGear, { assignment: a.assignment, items: s.gear.items.map((it) => ({ ...it })) });
    case 'applyPreset': {
      let loadout: OfficerLoadout;
      try {
        loadout = officerPreset(a.preset);
      } catch {
        return s;
      }
      return withProfile(s, p, validateGear, loadout);
    }
    case 'setItem':
      return withProfile(s, p, validateGear, withItemCount(s.gear, a.id, a.count));
    case 'setRetention':
      return withProfile(s, p, validateGear, withRetention(s.gear, a.id, a.level));
    case 'setGear':
      return withProfile(s, p, validateGear, copyGear(a.gear));
  }
}

/** Gear messages for display: errors first, then warnings. */
export function gearMessages(check: LoadoutValidation | null): { errors: string[]; warnings: string[] } {
  return check ? { errors: check.errors.map((e) => e.message), warnings: check.warnings.map((w) => w.message) } : { errors: [], warnings: [] };
}

/** Every gear item in catalog order (the Gear tab's rows). */
export const GEAR_ROWS = GEAR_ITEMS;

/** 'patrolStandard' -> 'Patrol standard'. */
export function presetLabel(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// --- Skin tones ------------------------------------------------------------------------------

const lerpChannel = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);

/** Colour at position `t` (0..1) along the skin-tone ramp: a linear blend of the two neighbouring tones. */
export function skinAt(t: number, tones: readonly number[] = UNIFORM_DATA.skinTones): number {
  const n = tones.length;
  if (n === 0) return 0;
  const x = clamp(Number.isFinite(t) ? t : 0, 0, 1) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  if (n === 1) return tones[0] ?? 0;
  const f = x - i;
  const c0 = tones[i] ?? 0;
  const c1 = tones[i + 1] ?? c0;
  const r = lerpChannel((c0 >> 16) & 255, (c1 >> 16) & 255, f);
  const g = lerpChannel((c0 >> 8) & 255, (c1 >> 8) & 255, f);
  const b = lerpChannel(c0 & 255, c1 & 255, f);
  return (r << 16) | (g << 8) | b;
}

/** Position on the ramp (0..1) whose colour is nearest to `color`: the fine slider's value. */
export function skinPosition(color: number, tones: readonly number[] = UNIFORM_DATA.skinTones): number {
  const steps = 200;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k <= steps; k++) {
    const c = skinAt(k / steps, tones);
    const d = ((c >> 16) - (color >> 16)) ** 2 + (((c >> 8) & 255) - ((color >> 8) & 255)) ** 2 + ((c & 255) - (color & 255)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k / steps;
    }
  }
  return best;
}
