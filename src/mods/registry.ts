/**
 * The active mod overlay (design §10.2). Dependency-free on purpose: the data loaders call `modOverlay()` while
 * their module evaluates, so `setActiveOverlay` must run before the app is imported (`bootMods`, `src/main.ts`).
 */
import type { ModOverlay, ModRef } from './types';

/** An overlay that changes nothing. */
export function emptyOverlay(): ModOverlay {
  return { refs: [], callTypes: [], statutes: [], rulesets: [], vehicles: [], uniforms: [], districts: {}, voicePack: null, dispatchScripts: [] };
}

let active: ModOverlay = emptyOverlay();

/** Installs the overlay (null = empty). Only `main.ts` (via `bootMods`) and tests call this. */
export function setActiveOverlay(o: ModOverlay | null): void {
  active = o ?? emptyOverlay();
}

/** The overlay in force (never null). */
export function modOverlay(): Readonly<ModOverlay> {
  return active;
}

/** Identity of every enabled mod, in load order. */
export function activeModRefs(): readonly ModRef[] {
  return active.refs;
}

/** The overlay label of a district (matched ignoring case: 'Harbor' finds 'harbor'), or the district name itself. */
export function districtLabel(district: string): string {
  const exact = Object.hasOwn(active.districts, district) ? active.districts[district]?.label : undefined;
  if (exact !== undefined) return exact;
  const lower = district.toLowerCase();
  for (const key in active.districts) {
    if (key.toLowerCase() === lower) return active.districts[key]?.label ?? district;
  }
  return district;
}
