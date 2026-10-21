/**
 * The Phase 2 CAD call-type rows of the Phase 3 catalog (design §6.1): every type row of
 * `data/calls/types/*.json`, merged over its family's `defaults`. Imports JSON only (no `src/cad/**`:
 * `cad/data.ts` imports this file, so a dependency back would be a cycle); `cad/data.ts` validates the rows.
 */
import familiesJson from '../data/calls/families.json';
import { modOverlay } from '../mods/registry';

type Json = Record<string, unknown>;

/** Phase 2 CAD keys a catalog row carries. */
const CAD_KEYS = [
  'id', 'label', 'codeKey', 'category', 'generated', 'weight', 'priority', 'location', 'districts', 'units', 'onSceneS',
  'callers', 'narratives', 'fill', 'dispositions',
] as const;

function isObject(x: unknown): x is Json {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Type files sorted by path (generation order must not depend on the file system). */
function sortedFiles(modules: Readonly<Record<string, unknown>>): { file: string; json: unknown }[] {
  return Object.keys(modules)
    .sort()
    .map((path) => ({ file: path.slice(path.lastIndexOf('/') + 1), json: modules[path] }));
}

/** Outcome dispositions of a family, unique, in outcome order. */
function outcomeDispositions(family: Json): string[] {
  const out: string[] = [];
  const outcomes = Array.isArray(family.outcomes) ? (family.outcomes as unknown[]) : [];
  for (const o of outcomes) {
    if (isObject(o) && typeof o.disposition === 'string' && !out.includes(o.disposition)) out.push(o.disposition);
  }
  return out;
}

/**
 * Merges the rows of `files` over `families` defaults (shallow per key, the row wins). Fallbacks when
 * neither gives a key: `codeKey` null, `fill` {}, `districts` { water: 0 }, `callers` { citizen 0.8,
 * anonymous 0.2 }, `units` [1, 1], `onSceneS` [180, 420], `dispositions` = the family's outcome dispositions.
 */
export function mergeCadRows(families: unknown, files: readonly { file: string; json: unknown }[]): unknown[] {
  const byId = new Map<string, Json>();
  const list = isObject(families) && Array.isArray(families.families) ? (families.families as unknown[]) : [];
  for (const f of list) if (isObject(f) && typeof f.id === 'string') byId.set(f.id, f);

  const out: unknown[] = [];
  for (const { file, json } of files) {
    if (!isObject(json) || typeof json.family !== 'string') throw new Error(`types/${file}: family must be a family id`);
    const family = byId.get(json.family);
    if (!family) throw new Error(`types/${file}: family references unknown family "${json.family}"`);
    const defaults = isObject(family.defaults) ? family.defaults : {};
    const fallbacks: Json = {
      codeKey: null,
      fill: {},
      districts: { water: 0 },
      callers: { citizen: 0.8, anonymous: 0.2 },
      units: [1, 1],
      onSceneS: [180, 420],
      dispositions: outcomeDispositions(family),
    };
    const types = Array.isArray(json.types) ? (json.types as unknown[]) : [];
    for (const row of types) {
      if (!isObject(row)) {
        out.push(row);
        continue;
      }
      const merged: Json = {};
      for (const key of CAD_KEYS) {
        const value = row[key] !== undefined ? row[key] : defaults[key] !== undefined ? defaults[key] : fallbacks[key];
        if (value !== undefined) merged[key] = value;
      }
      out.push(merged);
    }
  }
  return out;
}

/** Rows for `CALL_TYPES` (`cad/data.ts`): untyped; `validateCallTypes` checks them (all `types/*.json`, Phase 6 `massCasualty` included). */
export function catalogCadRows(): unknown[] {
  return mergeCadRows(familiesJson, [
    ...sortedFiles(import.meta.glob<unknown>('../data/calls/types/*.json', { eager: true, import: 'default' })),
    ...modOverlay().callTypes,
  ]);
}
