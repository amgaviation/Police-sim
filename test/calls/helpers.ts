import actionsJson from '../../src/data/calls/actions.json';
import familiesJson from '../../src/data/calls/families.json';
import legacyJson from '../../src/data/calls/legacy.json';
import servicesJson from '../../src/data/calls/services.json';
import variantsJson from '../../src/data/calls/variants.json';
import { DISPOSITIONS } from '../../src/cad/data';
import { validateCatalog, type CatalogContext } from '../../src/calls/catalog';
import { CRIME_CATEGORIES } from '../../src/environment/crime';
import { TRUNK_ITEMS } from '../../src/police/inventory';

/** Untyped JSON for fixture mutation (tests break the shipped files on purpose). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export const CTX: CatalogContext = {
  dispositions: DISPOSITIONS.map((d) => d.id),
  crimeCategories: CRIME_CATEGORIES,
  trunkItems: TRUNK_ITEMS.map((t) => t.id),
};

const typeModules = import.meta.glob<unknown>('../../src/data/calls/types/*.json', { eager: true, import: 'default' });

/** The catalog files as untyped, mutable JSON (every `types/*.json`, Phase 6 `massCasualty` included). */
export interface Raw {
  families: Json;
  types: { file: string; json: Json }[];
  actions: Json;
  services: Json;
  variants: Json;
  legacy: Json;
}

/** A deep copy of the shipped catalog files, ready to be broken by a test. */
export function rawInput(): Raw {
  return {
    families: clone(familiesJson),
    types: Object.keys(typeModules)
      .sort()
      .map((p) => ({ file: `types/${p.slice(p.lastIndexOf('/') + 1)}`, json: clone(typeModules[p]) as Json })),
    actions: clone(actionsJson),
    services: clone(servicesJson),
    variants: clone(variantsJson),
    legacy: clone(legacyJson),
  };
}

export function family(raw: Raw, id: string): Json {
  const f = (raw.families.families as Json[]).find((x) => x.id === id);
  if (!f) throw new Error(`no family ${id}`);
  return f;
}

export function familyIndex(raw: Raw, id: string): number {
  return (raw.families.families as Json[]).findIndex((x) => x.id === id);
}

export function validateRaw(raw: Raw): ReturnType<typeof validateCatalog> {
  return validateCatalog(raw, CTX);
}
