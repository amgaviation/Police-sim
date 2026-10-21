/**
 * Boot-time mod loading (design §10.4). Imports only the registry, the store, the combiner and types (plus core
 * log / rng): it runs before the app (and with it the data modules) is imported, so it must not pull them in.
 */
import { log } from '../core/log';
import { buildOverlay, formatModErrors, modRef, resolveActiveMods } from './combine';
import { emptyOverlay, setActiveOverlay } from './registry';
import { ModStore } from './store';
import type { ModBundle, ModRef } from './types';

export const SAFE_MODE_KEY = 'patrol-mods-safe';

export interface BootResult {
  active: ModRef[];
  errors: string[];
  safeMode: boolean;
}

function flag(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(SAFE_MODE_KEY);
  } catch {
    return null;
  }
}

/** True when the safe-mode flag is set (mods were disabled after a failed start). */
export function isSafeMode(): boolean {
  return flag() === '1';
}

/** Sets the 'patrol-mods-safe' flag; `main.ts` calls it when importing the app failed with mods active. */
export function enterSafeMode(): void {
  try {
    localStorage.setItem(SAFE_MODE_KEY, '1');
  } catch {
    // no storage: the next start tries the mods again
  }
}

/** Clears the safe-mode flag (the mod manager does, when the player re-enables mods). */
export function leaveSafeMode(): void {
  try {
    localStorage.removeItem(SAFE_MODE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Unless `skip` (URL `?nomods`) or the safe-mode flag: reads the installed mods and the enabled order, resolves the
 * load order and installs the overlay. Never throws: any failure leaves the empty overlay.
 */
export async function bootMods(opts: { skip?: boolean; store?: ModStore } = {}): Promise<BootResult> {
  const safeMode = isSafeMode();
  if (opts.skip === true || safeMode) {
    setActiveOverlay(emptyOverlay());
    return { active: [], errors: [], safeMode };
  }
  const store = opts.store ?? new ModStore();
  try {
    const order = store.enabled();
    if (order.length === 0) {
      setActiveOverlay(emptyOverlay());
      return { active: [], errors: [], safeMode: false };
    }
    const installed = await store.list();
    const bundles: ModBundle[] = installed.map((s) => s.bundle);
    const { active, errors } = resolveActiveMods(bundles, order);
    const overlay = buildOverlay(active);
    setActiveOverlay(overlay);
    const messages = formatModErrors(errors);
    for (const m of messages) log.warn(`mods: ${m}`);
    return { active: active.map(modRef), errors: messages, safeMode: false };
  } catch (e) {
    setActiveOverlay(emptyOverlay());
    const message = e instanceof Error ? e.message : String(e);
    log.warn(`mods: could not load installed mods (${message})`);
    return { active: [], errors: [`Could not read installed mods: ${message}`], safeMode: false };
  } finally {
    store.close();
  }
}
