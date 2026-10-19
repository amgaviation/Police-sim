/** The armory sign-out log (design §11.1). Pure: serials derive from the seed. */
import { hash3 } from '../records/hash';
import { ARMORY_ITEMS, type ArmoryItemDef } from './data';

export type { ArmoryItemDef } from './data';
export { ARMORY_ITEMS } from './data';

export interface ArmoryEntry {
  /** Index in the log (0, 1, 2, ... with no gaps). */
  seq: number;
  item: string;
  serial: string;
  action: 'out' | 'in';
  officer: string;
  sim: number;
  game: number;
}

/** The definition of armory item `id`, undefined when unknown. */
export function armoryItem(id: string): ArmoryItemDef | undefined {
  return ARMORY_ITEMS.find((d) => d.id === id);
}

/** Who has what: an append-only log of sign-outs and returns; an item is out after its last entry was `out`. */
export class ArmoryLog {
  private readonly seed: number;
  private readonly log: ArmoryEntry[] = [];
  private readonly outSet = new Set<string>();

  constructor(seed: number) {
    this.seed = seed;
  }

  /** Signs `item` out; null when it is unknown or already out. */
  signOut(item: string, officer: string, sim: number, game: number): ArmoryEntry | null {
    return this.record(item, 'out', officer, sim, game);
  }

  /** Returns `item`; null when it is unknown or not out. */
  signIn(item: string, officer: string, sim: number, game: number): ArmoryEntry | null {
    return this.record(item, 'in', officer, sim, game);
  }

  /** True while `item` is signed out. */
  has(item: string): boolean {
    return this.outSet.has(item);
  }

  /** Ids of the items signed out, in item order. */
  out(): readonly string[] {
    return ARMORY_ITEMS.filter((d) => this.outSet.has(d.id)).map((d) => d.id);
  }

  entries(): readonly ArmoryEntry[] {
    return this.log;
  }

  /** `${prefix}-${1000 + hash3(seed, 0x7a11, index) % 9000}` where index is the item's position in the item list; '' when unknown. */
  serial(item: string): string {
    const index = ARMORY_ITEMS.findIndex((d) => d.id === item);
    const def = ARMORY_ITEMS[index];
    if (def === undefined) return '';
    return `${def.serialPrefix}-${String(1000 + (hash3(this.seed, 0x7a11, index) % 9000))}`;
  }

  /** Replaces the log (save load); serials are re-derived from the seed. */
  restore(entries: readonly ArmoryEntry[]): void {
    this.log.length = 0;
    this.outSet.clear();
    for (const e of entries) {
      if (armoryItem(e.item) === undefined) continue;
      this.log.push({ ...e, seq: this.log.length, serial: this.serial(e.item) });
      if (e.action === 'out') this.outSet.add(e.item);
      else this.outSet.delete(e.item);
    }
  }

  private record(item: string, action: 'out' | 'in', officer: string, sim: number, game: number): ArmoryEntry | null {
    if (armoryItem(item) === undefined) return null;
    if (this.outSet.has(item) === (action === 'out')) return null;
    const entry: ArmoryEntry = { seq: this.log.length, item, serial: this.serial(item), action, officer, sim, game };
    this.log.push(entry);
    if (action === 'out') this.outSet.add(item);
    else this.outSet.delete(item);
    return entry;
  }
}
