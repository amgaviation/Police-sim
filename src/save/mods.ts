import type { ModRef } from '../mods/types';

/** Thrown by the app when a save cannot be loaded and was made with other mods than the ones active now. */
export class SaveModsError extends Error {
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[]) {
    super(message);
    this.name = 'SaveModsError';
    this.missing = missing;
  }
}

function isRef(x: unknown): x is ModRef {
  return typeof x === 'object' && x !== null && typeof (x as ModRef).id === 'string' && typeof (x as ModRef).modVersion === 'string' && typeof (x as ModRef).hash === 'string';
}

/**
 * Compares the mod refs a save recorded with the refs active now (design §16). Returns a sentence naming the mods the save
 * was made with when they differ (missing, changed or extra), null when they are the same set. `saved` is unvalidated
 * save data: anything that is not a list of refs counts as "no mods".
 */
export function describeModMismatch(saved: unknown, active: readonly ModRef[]): string | null {
  const refs = Array.isArray(saved) ? saved.filter(isRef) : [];
  const label = (r: ModRef): string => `${r.id} ${r.modVersion}`;
  const missing = refs.filter((r) => !active.some((a) => a.id === r.id));
  const changed = refs.filter((r) => active.some((a) => a.id === r.id && (a.hash !== r.hash || a.modVersion !== r.modVersion)));
  const extra = active.filter((a) => !refs.some((r) => r.id === a.id));
  if (missing.length === 0 && changed.length === 0 && extra.length === 0) return null;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.map(label).join(', ')}`);
  if (changed.length > 0) parts.push(`changed: ${changed.map(label).join(', ')}`);
  if (extra.length > 0) parts.push(`not in the save: ${extra.map(label).join(', ')}`);
  const made = refs.length === 0 ? 'no mods' : refs.map(label).join(', ');
  return `This save was made with mods: ${made} (${parts.join('; ')})`;
}
