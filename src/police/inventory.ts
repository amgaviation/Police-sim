import { EQUIPMENT_DATA, ITEMS_DATA, type TrunkItem } from './data';

export type { TrunkItem } from './data';

/** Trunk items in `items.json` order. */
export const TRUNK_ITEMS: readonly TrunkItem[] = ITEMS_DATA;

/** Trunk item by id; undefined when unknown. */
export function trunkItem(id: string): TrunkItem | undefined {
  return TRUNK_ITEMS.find((it) => it.id === id);
}

/** Persisted `OfficerKit` (save v4 `officerKit`). */
export interface OfficerKitSave {
  version: 1;
  /** Item id -> count carried. */
  carried: Record<string, number>;
  /** Checked-out rack item id, null for none. */
  longGun: string | null;
}

export function emptyOfficerKit(): OfficerKitSave {
  return { version: 1, carried: {}, longGun: null };
}

function isCountRecord(x: unknown): x is Record<string, number> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  return Object.values(x).every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0);
}

export function isOfficerKitSave(x: unknown): x is OfficerKitSave {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return s.version === 1 && isCountRecord(s.carried) && (s.longGun === null || typeof s.longGun === 'string');
}

/**
 * What the officer carries on foot: trunk items (at most `carryMax` each) and one checked-out long gun.
 * `PatrolEquipment` changes it through `take`/`stow`/`checkOut`/`checkIn`.
 */
export class OfficerKit {
  /** Count per `TRUNK_ITEMS` index. */
  private readonly counts = new Uint16Array(TRUNK_ITEMS.length);
  private gun: string | null = null;

  /** Count carried of `itemId`; 0 for unknown items. */
  carried(itemId: string): number {
    const i = TRUNK_ITEMS.findIndex((it) => it.id === itemId);
    return i < 0 ? 0 : (this.counts[i] ?? 0);
  }

  /** Total items carried. */
  get carriedTotal(): number {
    let n = 0;
    for (const c of this.counts) n += c;
    return n;
  }

  /** Checked-out rack item id, null for none. */
  get longGun(): string | null {
    return this.gun;
  }

  /** Adds `delta` of `itemId` within [0, carryMax]; false (unchanged) when that is not possible. */
  adjust(itemId: string, delta: number): boolean {
    const i = TRUNK_ITEMS.findIndex((it) => it.id === itemId);
    const item = TRUNK_ITEMS[i];
    if (item === undefined) return false;
    const next = (this.counts[i] ?? 0) + delta;
    if (next < 0 || next > item.carryMax) return false;
    this.counts[i] = next;
    return true;
  }

  /** Uses up `n` (>= 1) of `itemId` (a flare lit, a cone placed); false (unchanged) when fewer are carried. */
  consume(itemId: string, n = 1): boolean {
    return Number.isInteger(n) && n >= 1 && this.adjust(itemId, -n);
  }

  /** Sets the carried long gun (`PatrolEquipment` check-out/in). */
  setLongGun(id: string | null): void {
    this.gun = id;
  }

  serialize(): OfficerKitSave {
    const carried: Record<string, number> = {};
    TRUNK_ITEMS.forEach((it, i) => {
      const c = this.counts[i] ?? 0;
      if (c > 0) carried[it.id] = c;
    });
    return { version: 1, carried, longGun: this.gun };
  }

  /** Unknown items and long guns are dropped; counts are clamped to `carryMax`. */
  static restore(s: OfficerKitSave): OfficerKit {
    const kit = new OfficerKit();
    TRUNK_ITEMS.forEach((it, i) => {
      const c = s.carried[it.id];
      if (typeof c === 'number' && Number.isFinite(c)) kit.counts[i] = Math.max(0, Math.min(it.carryMax, Math.floor(c)));
    });
    kit.gun = s.longGun !== null && EQUIPMENT_DATA.rack.items.some((r) => r.id === s.longGun) ? s.longGun : null;
    return kit;
  }
}
