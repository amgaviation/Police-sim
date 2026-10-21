/**
 * Combining mods (design §10.3): load order, cross-mod duplicate detection, the merged `ModOverlay` and the pure
 * merge helpers the data loaders use. Free of data-module imports (the loaders import this file).
 */
import { hashString } from '../core/rng';
import type { ModBundle, ModError, ModOverlay, ModRef, VoicePackDef } from './types';

/** Largest vehicle table (`VehicleLook.model` is a Uint8). */
export const MAX_VEHICLE_MODELS = 255;

/**
 * What a bundle is validated against. `defaultModContext()` (schema.ts) wraps the live data modules; tests pass
 * fakes. The `check*` functions return the message(s) of the matching throwing validator, [] when valid.
 */
export interface ModValidationContext {
  baseCallTypeIds: ReadonlySet<string>;
  familyIds: ReadonlySet<string>;
  baseVehicleIds: ReadonlySet<string>;
  baseRulesetIds: ReadonlySet<string>;
  baseStatuteIds: ReadonlySet<string>;
  /** Ids of the shipped dispatch scripts (a mod script with one of them would never be available). */
  baseScriptIds: readonly string[];
  districts: readonly string[];
  uniformClassIds: readonly string[];
  phraseKinds: readonly string[];
  /** validateCatalog + validateCallTypes with the base files and `files`. */
  checkCallTypes(files: readonly { file: string; json: unknown }[]): string[];
  /** parseVehicleModel. */
  checkVehicle(json: unknown, source: string): string[];
  /** parseRuleset. */
  checkRuleset(json: unknown, file: string): string[];
  /** validateStatutes(base + rows). */
  checkStatutes(rows: readonly unknown[]): string[];
  /** parseUniformData(applyUniformPatches(base, patches)). */
  checkUniforms(patches: ModOverlay['uniforms']): string[];
  /** validatePhrases(mergePhrases(base, phrases)). */
  checkPhrases(phrases: VoicePackDef['phrases']): string[];
  /** parseDispatchScript; `extraCallTypeIds` are call types defined by the mod(s) being checked. */
  checkScript(json: unknown, extraCallTypeIds?: readonly string[]): string[];
}

// --- Identity -------------------------------------------------------------------------------------------------

/** JSON with object keys sorted, so equal documents serialise equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(o).sort()) {
      if (o[k] !== undefined) parts.push(`${JSON.stringify(k)}:${canonicalJson(o[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Id, version and an 8-hex FNV-1a hash of the canonical JSON of the bundle. */
export function modRef(m: ModBundle): ModRef {
  return { id: m.id, modVersion: m.modVersion, hash: hashString(canonicalJson(m)).toString(16).padStart(8, '0') };
}

/** `"<mod>: <path>: <message>"` for each error. */
export function formatModErrors(errors: readonly ModError[]): string[] {
  return errors.map((e) => `${e.mod}: ${e.path}: ${e.message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function idOf(x: unknown): string | null {
  return isRecord(x) && typeof x.id === 'string' ? x.id : null;
}

// --- Check messages -> ModError -------------------------------------------------------------------------------

/**
 * Turns the message of a throwing validator ("<file>: <path> <problem>" or "<file>: <path>: <problem>") into an error
 * whose path is `prefix` followed by the validator's own path. Unparseable messages keep `prefix` as the path.
 */
export function checkError(mod: string, prefix: string, message: string): ModError {
  let rest = message;
  const file = /^\S*\.json: /.exec(rest);
  if (file) rest = rest.slice(file[0].length);
  // "<path>: <problem>" or "<path> <problem>" where the problem starts with a verb the validators use.
  const m = /^(\(root\)|[A-Za-z_][\w.[\]-]*)(?::\s|\s(?=(?:must|is|are|has|references|duplicates|shadows|uses|cannot|needs)\b))(.*)$/s.exec(rest);
  if (m?.[1] === undefined || m[2] === undefined) return { mod, path: prefix, message: rest };
  const own = m[1] === '(root)' ? '' : m[1];
  return { mod, path: own === '' ? prefix : prefix === '' ? own : `${prefix}.${own}`, message: m[2] };
}

/** `checkError` for each message. */
export function checkErrors(mod: string, prefix: string, messages: readonly string[]): ModError[] {
  return messages.map((m) => checkError(mod, prefix, m));
}

// --- Content ids ----------------------------------------------------------------------------------------------

type IdKind = 'callTypes' | 'statutes' | 'rulesets' | 'vehicles' | 'dispatchScripts';

interface ContentId {
  kind: IdKind;
  id: string;
  path: string;
}

/** Ids a mod defines that must be unique across mods (a uniform / district patch is not an id). */
function contentIds(m: ModBundle): ContentId[] {
  const out: ContentId[] = [];
  const c = m.content;
  (c.callTypes ?? []).forEach((f, i) =>
    f.types.forEach((t, j) => {
      const id = idOf(t);
      if (id !== null) out.push({ kind: 'callTypes', id, path: `callTypes[${i}].types[${j}].id` });
    }),
  );
  const flat: [IdKind, unknown[] | undefined][] = [
    ['statutes', c.statutes],
    ['rulesets', c.rulesets],
    ['vehicles', c.vehicles],
    ['dispatchScripts', c.dispatchScripts],
  ];
  for (const [kind, list] of flat) {
    (list ?? []).forEach((x, i) => {
      const id = idOf(x);
      if (id !== null) out.push({ kind, id, path: `${kind}[${i}].id` });
    });
  }
  return out;
}

/** Errors for ids defined by a later mod that an earlier mod already defines (the later mod is the one named). */
function duplicateErrors(mods: readonly ModBundle[]): ModError[] {
  const seen = new Map<string, string>();
  const errors: ModError[] = [];
  for (const m of mods) {
    const mine = new Set<string>();
    for (const { kind, id, path } of contentIds(m)) {
      const key = `${kind}:${id}`;
      const other = seen.get(key);
      if (other !== undefined && other !== m.id) {
        errors.push({ mod: m.id, path, message: `${JSON.stringify(id)} is already defined by mod "${other}"` });
      }
      if (other === undefined) mine.add(key);
    }
    for (const key of mine) seen.set(key, m.id);
  }
  return errors;
}

// --- Load order -----------------------------------------------------------------------------------------------

/**
 * The enabled mods in load order `order` (ids; unknown ids are ignored, repeats count once). A mod that defines a
 * content id an earlier active mod already defines is excluded with an error naming both.
 */
export function resolveActiveMods(mods: readonly ModBundle[], order: readonly string[]): { active: ModBundle[]; errors: ModError[] } {
  const byId = new Map<string, ModBundle>();
  for (const m of mods) byId.set(m.id, m);
  const active: ModBundle[] = [];
  const errors: ModError[] = [];
  const done = new Set<string>();
  for (const id of order) {
    const m = byId.get(id);
    if (m === undefined || done.has(id)) continue;
    done.add(id);
    const dups = duplicateErrors([...active, m]).filter((e) => e.mod === m.id);
    if (dups.length > 0) {
      for (const e of dups) errors.push({ ...e, message: `${e.message}; "${m.id}" was not loaded` });
      continue;
    }
    active.push(m);
  }
  return { active, errors };
}

// --- Overlay --------------------------------------------------------------------------------------------------

/** Merges the active mods (already in load order) into the overlay the loaders apply. */
export function buildOverlay(active: readonly ModBundle[]): ModOverlay {
  const overlay: ModOverlay = {
    refs: [], callTypes: [], statutes: [], rulesets: [], vehicles: [], uniforms: [], districts: {}, voicePack: null, dispatchScripts: [],
  };
  for (const m of active) {
    overlay.refs.push(modRef(m));
    const c = m.content;
    (c.callTypes ?? []).forEach((f, n) => {
      overlay.callTypes.push({ file: `mod:${m.id}:${n}.json`, json: { version: 1, family: f.family, types: f.types } });
    });
    if (c.statutes) overlay.statutes.push(...c.statutes);
    for (const r of c.rulesets ?? []) overlay.rulesets.push({ file: `${idOf(r) ?? m.id}.json`, json: r });
    for (const v of c.vehicles ?? []) overlay.vehicles.push({ file: `${idOf(v) ?? m.id}.json`, json: v });
    if (c.uniforms) overlay.uniforms.push({ classes: c.uniforms.classes ?? [], department: c.uniforms.department ?? null });
    if (c.districts) for (const [d, patch] of Object.entries(c.districts)) overlay.districts[d] = patch;
    const packs = c.voicePacks ?? [];
    const last = packs[packs.length - 1];
    if (last !== undefined) overlay.voicePack = last;
    if (c.dispatchScripts) overlay.dispatchScripts.push(...c.dispatchScripts);
  }
  return overlay;
}

/**
 * Cross-checks the whole enabled set: duplicate ids across mods, the vehicle table limit, then the merged content
 * through the context validators (errors with mod "(combination)" cannot be tied to one mod).
 */
export function validateCombination(active: readonly ModBundle[], ctx: ModValidationContext): ModError[] {
  const dups = duplicateErrors(active);
  if (dups.length > 0) return dups;
  const overlay = buildOverlay(active);
  const errors: ModError[] = [];
  const mod = '(combination)';
  const total = ctx.baseVehicleIds.size + overlay.vehicles.length;
  if (total > MAX_VEHICLE_MODELS) {
    errors.push({ mod, path: 'vehicles', message: `${total} vehicle models in total; the limit is ${MAX_VEHICLE_MODELS}` });
  }
  if (overlay.callTypes.length > 0) errors.push(...checkErrors(mod, 'callTypes', ctx.checkCallTypes(overlay.callTypes)));
  if (overlay.statutes.length > 0) errors.push(...checkErrors(mod, '', ctx.checkStatutes(overlay.statutes)));
  if (overlay.uniforms.length > 0) errors.push(...checkErrors(mod, 'uniforms', ctx.checkUniforms(overlay.uniforms)));
  if (overlay.voicePack?.phrases) errors.push(...checkErrors(mod, 'voicePacks', ctx.checkPhrases(overlay.voicePack.phrases)));
  const typeIds: string[] = [];
  for (const m of active) for (const f of m.content.callTypes ?? []) for (const t of f.types) typeIds.push(idOf(t) ?? '');
  for (const m of active) {
    (m.content.dispatchScripts ?? []).forEach((s, i) => {
      errors.push(...checkErrors(m.id, `dispatchScripts[${i}]`, ctx.checkScript(s, typeIds)));
    });
  }
  return errors;
}

// --- Loader helpers (pure) ------------------------------------------------------------------------------------

/** Shallow merge, one level deeper for keys that are objects on both sides (`department.patch`, `department.badge`). */
function mergeDeep2(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const b = out[k];
    out[k] = isRecord(b) && isRecord(v) ? { ...b, ...v } : v;
  }
  return out;
}

/**
 * The uniform document with the patches applied: each patched class replaces the listed keys of the class with the
 * same id (shallow); `department` is merged (`patch` and `badge` key by key). `base` is not modified; with no
 * patches `base` itself is returned.
 */
export function applyUniformPatches(base: unknown, patches: ModOverlay['uniforms']): unknown {
  if (patches.length === 0 || !isRecord(base)) return base;
  const out: Record<string, unknown> = { ...base };
  if (Array.isArray(base.classes)) {
    const classes = (base.classes as unknown[]).map((c) => (isRecord(c) ? { ...c } : c));
    for (const p of patches) {
      for (const patch of p.classes) {
        const i = classes.findIndex((c) => idOf(c) === patch.id);
        const cur = classes[i];
        if (i >= 0 && isRecord(cur)) classes[i] = { ...cur, ...patch };
      }
    }
    out.classes = classes;
  }
  let dept = isRecord(base.department) ? base.department : null;
  for (const p of patches) if (p.department && dept) dept = mergeDeep2(dept, p.department);
  if (dept) out.department = dept;
  return out;
}

/**
 * The phrase document with `phrases[kind].tenCode / plain` replacing the arrays of that kind. `base` is not
 * modified; without phrases `base` itself is returned.
 */
export function mergePhrases(base: unknown, phrases: VoicePackDef['phrases'] | undefined): unknown {
  if (!phrases || !isRecord(base) || !isRecord(base.kinds)) return base;
  const kinds: Record<string, unknown> = { ...base.kinds };
  for (const [kind, lines] of Object.entries(phrases)) {
    const cur = kinds[kind];
    if (!isRecord(cur)) continue;
    const next: Record<string, unknown> = { ...cur };
    if (lines.tenCode) next.tenCode = lines.tenCode;
    if (lines.plain) next.plain = lines.plain;
    kinds[kind] = next;
  }
  return { ...base, kinds };
}

/** The statute document with `rows` appended to `statutes`. `base` is returned itself when there are no rows. */
export function mergeStatutes(base: unknown, rows: readonly unknown[]): unknown {
  if (rows.length === 0 || !isRecord(base) || !Array.isArray(base.statutes)) return base;
  return { ...base, statutes: [...(base.statutes as unknown[]), ...rows] };
}
