/**
 * Scenario library (Phase 8 design 12.2): up to 32 scenarios in `localStorage['patrol-scenarios']`. Storage can be
 * missing, full or blocked, and the stored text is untrusted: every access is wrapped, a broken entry is skipped.
 */
import {
  defaultScenarioContext,
  exportScenario,
  parseSandboxScenario,
  type SandboxScenario,
  type ScenarioContext,
} from '../../training/scenario';

export const LIBRARY_KEY = 'patrol-scenarios';
export const LIBRARY_LIMIT = 32;

/** The part of `Storage` the library needs. */
export type LibraryStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** `localStorage` when it is usable, else null. */
export function browserLibraryStorage(): LibraryStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readRaw(storage: LibraryStorage | null): unknown[] {
  if (!storage) return [];
  try {
    const text = storage.getItem(LIBRARY_KEY);
    if (text === null) return [];
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function idAndName(x: unknown): { id: string; name: string } | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as { id?: unknown; name?: unknown };
  return typeof o.id === 'string' && typeof o.name === 'string' ? { id: o.id, name: o.name } : null;
}

/** Ids and names of the stored scenarios, in the order they were first saved. */
export function libraryList(storage: LibraryStorage | null): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const raw of readRaw(storage)) {
    const e = idAndName(raw);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Stores `doc` (replacing the entry with the same id). Returns an error text, or null when saved: "full" at 32 other
 * scenarios, or storage that refused the write.
 */
export function librarySave(storage: LibraryStorage | null, doc: SandboxScenario): string | null {
  if (!storage) return 'Storage is not available in this browser';
  const raw = readRaw(storage).filter((x) => idAndName(x) !== null);
  const at = raw.findIndex((x) => idAndName(x)?.id === doc.id);
  const entry: unknown = JSON.parse(exportScenario(doc));
  if (at >= 0) raw[at] = entry;
  else if (raw.length >= LIBRARY_LIMIT) return `The library is full (${String(LIBRARY_LIMIT)} scenarios). Delete one first`;
  else raw.push(entry);
  try {
    storage.setItem(LIBRARY_KEY, JSON.stringify(raw));
    return null;
  } catch {
    return 'Could not write to browser storage (full or blocked)';
  }
}

/** The stored scenario `id`, validated again (null when missing or no longer valid). */
export function libraryLoad(storage: LibraryStorage | null, id: string, ctx: ScenarioContext = defaultScenarioContext()): SandboxScenario | null {
  for (const raw of readRaw(storage)) {
    if (idAndName(raw)?.id !== id) continue;
    const r = parseSandboxScenario(raw, ctx);
    return r.ok ? r.value : null;
  }
  return null;
}

/** Deletes scenario `id`; true when something was removed. */
export function libraryRemove(storage: LibraryStorage | null, id: string): boolean {
  if (!storage) return false;
  const raw = readRaw(storage);
  const kept = raw.filter((x) => idAndName(x)?.id !== id);
  if (kept.length === raw.length) return false;
  try {
    storage.setItem(LIBRARY_KEY, JSON.stringify(kept));
    return true;
  } catch {
    return false;
  }
}
