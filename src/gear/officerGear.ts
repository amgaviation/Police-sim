/** The officer's equipped gear: loadout, validation, presets and what the gear does (design §8.4). */
import { ARMORY_ITEMS } from '../station/data';
import { GEAR_POLICY, gearItem } from './data';
import type { LoadoutValidation, OfficerLoadout, OfficerLoadoutItem } from './types';
import { officerPreset, validateOfficerLoadout } from './validate';

/** Most saved presets. */
export const MAX_GEAR_PRESETS = 8;
const MAX_PRESET_NAME = 24;
const VEST_ID = 'ballisticVest';
const HOLSTER_ID = 'holster';

export interface GearPreset {
  name: string;
  loadout: OfficerLoadout;
}

/** Persisted `OfficerGear` (save v9). Ids are not required to be known so older saves stay loadable. */
export interface GearSave {
  version: 1;
  loadout: OfficerLoadout;
  /** At most `MAX_GEAR_PRESETS`. */
  presets: GearPreset[];
}

function copyLoadout(l: OfficerLoadout): OfficerLoadout {
  return { assignment: l.assignment, items: l.items.map((it) => ({ ...it })) };
}

/** The default gear save: the `patrolStandard` preset, no saved presets. */
export function defaultGearSave(): GearSave {
  return { version: 1, loadout: officerPreset('patrolStandard'), presets: [] };
}

/**
 * The gear a new game starts with: the standard patrol loadout plus the evidence kit (the field kit the Phase 4 work needs),
 * or the plain standard loadout when the kit does not fit. The main-menu creator and the v8 migration start from it too.
 */
export function startingGearSave(): GearSave {
  const save = defaultGearSave();
  const withKit = { assignment: save.loadout.assignment, items: [...save.loadout.items, { id: 'evidenceKit', count: 1 }] };
  return validateOfficerLoadout(withKit, {}).ok ? { ...save, loadout: withKit } : save;
}

function isLoadoutItem(x: unknown): x is OfficerLoadoutItem {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['count'] === 'number' &&
    Number.isInteger(o['count']) &&
    o['count'] >= 0 &&
    (o['retention'] === undefined || o['retention'] === 1 || o['retention'] === 2 || o['retention'] === 3)
  );
}

function isOfficerLoadout(x: unknown): x is OfficerLoadout {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return typeof o['assignment'] === 'string' && Array.isArray(o['items']) && o['items'].every(isLoadoutItem);
}

/** Structural check for saves; item and assignment ids are not required to be known. */
export function isGearSave(x: unknown): x is GearSave {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    s['version'] === 1 &&
    isOfficerLoadout(s['loadout']) &&
    Array.isArray(s['presets']) &&
    s['presets'].length <= MAX_GEAR_PRESETS &&
    s['presets'].every((p: unknown) => {
      if (typeof p !== 'object' || p === null) return false;
      const o = p as Record<string, unknown>;
      return typeof o['name'] === 'string' && isOfficerLoadout(o['loadout']);
    })
  );
}

/** What the officer carries and what it does; the UI edits it, the sim reads `retention`, `protection`, `kitGrants`. */
export class OfficerGear {
  private current: OfficerLoadout;
  private readonly saved: GearPreset[] = [];
  private extraVest = 0;
  private cache: LoadoutValidation | null = null;

  constructor(save?: GearSave) {
    const s = save ?? defaultGearSave();
    this.current = copyLoadout(s.loadout);
    for (const p of s.presets.slice(0, MAX_GEAR_PRESETS)) this.saved.push({ name: p.name, loadout: copyLoadout(p.loadout) });
  }

  get loadout(): Readonly<OfficerLoadout> {
    return this.current;
  }

  /** Validation of the current loadout (cached until the loadout or the carrier bonus changes). */
  get validation(): LoadoutValidation {
    this.cache ??= validateOfficerLoadout(this.current, { extraVestSlots: this.extraVest });
    return this.cache;
  }

  /** Applies the loadout even when invalid (the UI warns); returns its validation. */
  setLoadout(l: OfficerLoadout): LoadoutValidation {
    this.current = copyLoadout(l);
    this.cache = null;
    return this.validation;
  }

  /** The uniform's external carrier bonus to the vest slot (0 for none). */
  setExtraVestSlots(n: number): void {
    const v = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    if (v === this.extraVest) return;
    this.extraVest = v;
    this.cache = null;
  }

  /** Adds or removes the ballistic vest (the locker's Vest row). */
  setVest(on: boolean): void {
    const has = this.has(VEST_ID);
    if (on === has) return;
    this.current = {
      assignment: this.current.assignment,
      items: on ? [...this.current.items, { id: VEST_ID, count: 1 }] : this.current.items.filter((it) => it.id !== VEST_ID),
    };
    this.cache = null;
  }

  has(id: string): boolean {
    return this.current.items.some((it) => it.id === id && it.count > 0);
  }

  /** Holster retention level; 1 without a holster. */
  retention(): 1 | 2 | 3 {
    const h = this.current.items.find((it) => it.id === HOLSTER_ID && it.count > 0);
    return h?.retention ?? 1;
  }

  /** Strongest worn protection (the vest's share of torso rounds it stops); 0 without. */
  protection(): number {
    let p = 0;
    for (const it of this.current.items) {
      if (it.count > 0) p = Math.max(p, gearItem(it.id)?.protection ?? 0);
    }
    return p;
  }

  /** Trunk-item counts the officer carries at shift start (sum of kit x count). */
  kitGrants(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const it of this.current.items) {
      const def = gearItem(it.id);
      if (def === undefined || it.count < 1) continue;
      for (const [trunk, n] of Object.entries(def.kit)) out[trunk] = (out[trunk] ?? 0) + n * it.count;
    }
    return out;
  }

  /** Armory item ids of the loadout, in `ARMORY_ITEMS` order. */
  armoryItems(): string[] {
    const wanted = new Set<string>();
    for (const it of this.current.items) {
      const armory = it.count > 0 ? gearItem(it.id)?.armory : null;
      if (armory) wanted.add(armory);
    }
    return ARMORY_ITEMS.filter((a) => wanted.has(a.id)).map((a) => a.id);
  }

  /** Saves the current loadout under `name` (trimmed; replaces a preset of that name). False when there is no room or the name is empty. */
  savePreset(name: string): boolean {
    const n = name.trim().slice(0, MAX_PRESET_NAME);
    if (n === '') return false;
    const i = this.saved.findIndex((p) => p.name === n);
    if (i >= 0) {
      this.saved[i] = { name: n, loadout: copyLoadout(this.current) };
      return true;
    }
    if (this.saved.length >= MAX_GEAR_PRESETS) return false;
    this.saved.push({ name: n, loadout: copyLoadout(this.current) });
    return true;
  }

  deletePreset(name: string): void {
    const i = this.saved.findIndex((p) => p.name === name);
    if (i >= 0) this.saved.splice(i, 1);
  }

  presets(): readonly GearPreset[] {
    return this.saved;
  }

  serialize(): GearSave {
    return { version: 1, loadout: copyLoadout(this.current), presets: this.saved.map((p) => ({ name: p.name, loadout: copyLoadout(p.loadout) })) };
  }

  static restore(s: GearSave): OfficerGear {
    return new OfficerGear(s);
  }
}

/**
 * What a round fired at the officer does (pure). `u1` and `u2` are two draws in [0, 1). Beyond the maximum range or
 * with `u1 >= hitChance` it misses; a torso hit (`u2 < torsoShare`) is `stopped` with a vest in proportion to its
 * protection, else `wounded`; a limb hit is `wounded`.
 */
export function officerHit(u1: number, u2: number, protection: number, distanceM: number): 'miss' | 'stopped' | 'wounded' {
  const b = GEAR_POLICY.ballistics;
  if (distanceM > b.maxRangeM || u1 >= b.hitChance) return 'miss';
  if (u2 < b.torsoShare) return protection > 0 && u2 < b.torsoShare * protection ? 'stopped' : 'wounded';
  return 'wounded';
}
