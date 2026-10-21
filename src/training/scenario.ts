/**
 * Sandbox scenario (Phase 8 design 7.5): NPCs, vehicles, evidence and an optional call placed around an anchor, saved
 * and shared as validated JSON (`patrol-scenario` v1). The file is untrusted input: `parseSandboxScenario` returns
 * errors and never throws. `planScenario` turns a scenario into an ordered, deterministic list of spawn operations
 * that the session executes between steps.
 */
import { CALL_TYPES } from '../cad/data';
import { createRng, type Rng } from '../core/rng';
import { WEATHER_KINDS } from '../environment/weather';
import { BEHAVIORS } from '../npc/data';
import { ITEMS } from '../people/data';
import { VEHICLE_MODELS } from '../vehicles/model';
import { WORLD_HALF_M, checkEnum, checkNumber, checkString, unknownKeys, type ParseResult } from './script';

export interface ScenarioNpc {
  x: number;
  z: number;
  yaw: number;
  /** Behaviour profile id. */
  profile: string;
  /** Free role label of 1..24 letters (`suspect`, `victim`). */
  role: string;
  /** Weapon item id, null = unarmed. */
  weapon: string | null;
  hidden: boolean;
}

export interface ScenarioVehicle {
  modelId: string;
  x: number;
  z: number;
  yaw: number;
}

export interface ScenarioEvidence {
  item: string;
  x: number;
  z: number;
  concealed: boolean;
}

export interface SandboxScenario {
  format: 'patrol-scenario';
  version: 1;
  id: string;
  name: string;
  description: string;
  anchor: { x: number; z: number };
  call: { typeId: string; priority: 1 | 2 | 3 | 4 } | null;
  /** At most 24. */
  npcs: ScenarioNpc[];
  /** At most 8. */
  vehicles: ScenarioVehicle[];
  /** At most 24. */
  evidence: ScenarioEvidence[];
  /** Hour 0..23, null = leave the time alone. */
  timeOfDay: number | null;
  /** Weather kind, null = leave it alone. */
  weather: string | null;
}

/** What a scenario may reference. */
export interface ScenarioContext {
  callTypeIds: ReadonlySet<string>;
  profiles: ReadonlySet<string>;
  vehicleModels: ReadonlySet<string>;
  items: ReadonlySet<string>;
  weapons: ReadonlySet<string>;
  weatherKinds: readonly string[];
}

/** Content limits and the radius around the anchor (m) that placed things must stay in. */
export const SCENARIO_LIMITS = { npcs: 24, vehicles: 8, evidence: 24, radiusM: 150 } as const;

/** Call types, behaviour profiles, vehicle models, item ids, weapon item ids and weather kinds of the game. */
export function defaultScenarioContext(): ScenarioContext {
  return {
    callTypeIds: new Set(CALL_TYPES.map((t) => t.id)),
    profiles: new Set(BEHAVIORS.map((b) => b.id)),
    vehicleModels: new Set(VEHICLE_MODELS.map((m) => m.id)),
    items: new Set(ITEMS.map((i) => i.id)),
    weapons: new Set(ITEMS.filter((i) => i.weapon).map((i) => i.id)),
    weatherKinds: [...WEATHER_KINDS],
  };
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ROLE_RE = /^[a-zA-Z]{1,24}$/;
const ROOT_KEYS = ['format', 'version', 'id', 'name', 'description', 'anchor', 'call', 'npcs', 'vehicles', 'evidence', 'timeOfDay', 'weather'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

function member(ctx: ReadonlySet<string>, v: unknown, path: string, label: string, errors: string[]): string | null {
  if (typeof v !== 'string' || !ctx.has(v)) {
    errors.push(`${path}: unknown ${label} ${typeof v === 'string' ? `"${v}"` : show(v)}`);
    return null;
  }
  return v;
}

/** x / z / yaw of a placed thing; the position must be within the radius of the anchor. */
function place(o: Record<string, unknown>, path: string, anchor: { x: number; z: number } | null, errors: string[], withYaw: boolean): { x: number; z: number; yaw: number } | null {
  const x = checkNumber(o.x, `${path}.x`, -WORLD_HALF_M, WORLD_HALF_M, errors);
  const z = checkNumber(o.z, `${path}.z`, -WORLD_HALF_M, WORLD_HALF_M, errors);
  const yaw = withYaw ? checkNumber(o.yaw, `${path}.yaw`, -100, 100, errors) : 0;
  if (x === null || z === null || yaw === null) return null;
  if (anchor && Math.hypot(x - anchor.x, z - anchor.z) > SCENARIO_LIMITS.radiusM) {
    errors.push(`${path}: must be within ${SCENARIO_LIMITS.radiusM} m of the anchor, is ${Math.round(Math.hypot(x - anchor.x, z - anchor.z))} m away`);
    return null;
  }
  return { x, z, yaw };
}

function bool(v: unknown, path: string, errors: string[]): boolean | null {
  if (typeof v !== 'boolean') {
    errors.push(`${path}: must be true or false, got ${show(v)}`);
    return null;
  }
  return v;
}

function list(v: unknown, path: string, max: number, errors: string[]): unknown[] {
  if (!Array.isArray(v)) {
    errors.push(`${path}: must be an array, got ${show(v)}`);
    return [];
  }
  if (v.length > max) {
    errors.push(`${path}: at most ${max} items, got ${v.length}`);
    return [];
  }
  return v;
}

/**
 * Validates an untrusted scenario. Rules: `format` 'patrol-scenario', `version` 1, id /^[a-z0-9][a-z0-9-]{1,39}$/,
 * name 1..60, description <= 400, anchor |x|, |z| <= 3584; at most 24 NPCs, 8 vehicles and 24 evidence items, each
 * within 150 m of the anchor, referencing known profiles, vehicle models, items (weapons: weapon items), a role of
 * 1..24 letters; the call's type must exist and its priority be 1..4; timeOfDay 0..23 or null; weather a known kind
 * or null; unknown fields are errors. Errors read like `npcs[2].profile: unknown profile "x"`. Never throws.
 */
export function parseSandboxScenario(json: unknown, ctx: ScenarioContext = defaultScenarioContext()): ParseResult<SandboxScenario> {
  const errors: string[] = [];
  try {
    if (!isRecord(json)) return { ok: false, errors: [`scenario: must be an object, got ${show(json)}`] };
    unknownKeys(json, ROOT_KEYS, '', errors);
    if (json.format !== 'patrol-scenario') errors.push(`format: must be "patrol-scenario", got ${show(json.format)}`);
    if (json.version !== 1) errors.push(`version: must be 1, got ${show(json.version)}`);
    const id = checkString(json.id, 'id', 1, 80, errors);
    if (id !== null && !ID_RE.test(id)) errors.push(`id: must match ${ID_RE.source}, got "${id}"`);
    const name = checkString(json.name, 'name', 1, 60, errors);
    const description = checkString(json.description, 'description', 0, 400, errors);
    let anchor: { x: number; z: number } | null = null;
    if (isRecord(json.anchor)) {
      unknownKeys(json.anchor, ['x', 'z'], 'anchor', errors);
      const p = place(json.anchor, 'anchor', null, errors, false);
      if (p) anchor = { x: p.x, z: p.z };
    } else {
      errors.push(`anchor: must be an object with x and z, got ${show(json.anchor)}`);
    }
    let call: SandboxScenario['call'] = null;
    if (json.call !== null && json.call !== undefined) {
      if (isRecord(json.call)) {
        unknownKeys(json.call, ['typeId', 'priority'], 'call', errors);
        const typeId = member(ctx.callTypeIds, json.call.typeId, 'call.typeId', 'call type', errors);
        const pr = json.call.priority;
        if (pr !== 1 && pr !== 2 && pr !== 3 && pr !== 4) errors.push(`call.priority: must be 1, 2, 3 or 4, got ${show(pr)}`);
        else if (typeId !== null) call = { typeId, priority: pr };
      } else {
        errors.push(`call: must be an object or null, got ${show(json.call)}`);
      }
    }
    const npcs: ScenarioNpc[] = [];
    list(json.npcs, 'npcs', SCENARIO_LIMITS.npcs, errors).forEach((raw, i) => {
      const p = `npcs[${i}]`;
      if (!isRecord(raw)) {
        errors.push(`${p}: must be an object, got ${show(raw)}`);
        return;
      }
      const before = errors.length;
      unknownKeys(raw, ['x', 'z', 'yaw', 'profile', 'role', 'weapon', 'hidden'], p, errors);
      const at = place(raw, p, anchor, errors, true);
      const profile = member(ctx.profiles, raw.profile, `${p}.profile`, 'profile', errors);
      const role = checkString(raw.role, `${p}.role`, 1, 24, errors);
      if (role !== null && !ROLE_RE.test(role)) errors.push(`${p}.role: must be 1..24 letters, got "${role}"`);
      let weapon: string | null = null;
      if (raw.weapon !== null && raw.weapon !== undefined) weapon = member(ctx.weapons, raw.weapon, `${p}.weapon`, 'weapon', errors);
      const hidden = bool(raw.hidden, `${p}.hidden`, errors);
      if (errors.length === before && at && profile !== null && role !== null && hidden !== null) {
        npcs.push({ x: at.x, z: at.z, yaw: at.yaw, profile, role, weapon, hidden });
      }
    });
    const vehicles: ScenarioVehicle[] = [];
    list(json.vehicles, 'vehicles', SCENARIO_LIMITS.vehicles, errors).forEach((raw, i) => {
      const p = `vehicles[${i}]`;
      if (!isRecord(raw)) {
        errors.push(`${p}: must be an object, got ${show(raw)}`);
        return;
      }
      const before = errors.length;
      unknownKeys(raw, ['modelId', 'x', 'z', 'yaw'], p, errors);
      const at = place(raw, p, anchor, errors, true);
      const modelId = member(ctx.vehicleModels, raw.modelId, `${p}.modelId`, 'vehicle model', errors);
      if (errors.length === before && at && modelId !== null) vehicles.push({ modelId, x: at.x, z: at.z, yaw: at.yaw });
    });
    const evidence: ScenarioEvidence[] = [];
    list(json.evidence, 'evidence', SCENARIO_LIMITS.evidence, errors).forEach((raw, i) => {
      const p = `evidence[${i}]`;
      if (!isRecord(raw)) {
        errors.push(`${p}: must be an object, got ${show(raw)}`);
        return;
      }
      const before = errors.length;
      unknownKeys(raw, ['item', 'x', 'z', 'concealed'], p, errors);
      const at = place(raw, p, anchor, errors, false);
      const item = member(ctx.items, raw.item, `${p}.item`, 'item', errors);
      const concealed = bool(raw.concealed, `${p}.concealed`, errors);
      if (errors.length === before && at && item !== null && concealed !== null) evidence.push({ item, x: at.x, z: at.z, concealed });
    });
    let timeOfDay: number | null = null;
    if (json.timeOfDay !== null && json.timeOfDay !== undefined) timeOfDay = checkNumber(json.timeOfDay, 'timeOfDay', 0, 23, errors);
    let weather: string | null = null;
    if (json.weather !== null && json.weather !== undefined) weather = checkEnum(json.weather, 'weather', ctx.weatherKinds, 'weather', errors);
    if (errors.length > 0 || id === null || name === null || description === null || anchor === null) return { ok: false, errors };
    return {
      ok: true,
      value: { format: 'patrol-scenario', version: 1, id, name, description, anchor, call, npcs, vehicles, evidence, timeOfDay, weather },
    };
  } catch (e) {
    errors.push(`scenario: could not be read (${e instanceof Error ? e.message : 'unknown error'})`);
    return { ok: false, errors };
  }
}

/** Canonical JSON: keys in declaration order, 2-space indent (the file the editor saves and `parseSandboxScenario` reads). */
export function exportScenario(s: SandboxScenario): string {
  const canonical = {
    format: s.format,
    version: s.version,
    id: s.id,
    name: s.name,
    description: s.description,
    anchor: { x: s.anchor.x, z: s.anchor.z },
    call: s.call === null ? null : { typeId: s.call.typeId, priority: s.call.priority },
    npcs: s.npcs.map((n) => ({ x: n.x, z: n.z, yaw: n.yaw, profile: n.profile, role: n.role, weapon: n.weapon, hidden: n.hidden })),
    vehicles: s.vehicles.map((v) => ({ modelId: v.modelId, x: v.x, z: v.z, yaw: v.yaw })),
    evidence: s.evidence.map((e) => ({ item: e.item, x: e.x, z: e.z, concealed: e.concealed })),
    timeOfDay: s.timeOfDay,
    weather: s.weather,
  };
  return JSON.stringify(canonical, null, 2);
}

export type SpawnOp =
  | { op: 'call'; typeId: string; priority: 1 | 2 | 3 | 4; x: number; z: number }
  | { op: 'actor'; index: number; personId: number; x: number; z: number; yaw: number; profile: string; role: string; weapon: string | null; hidden: boolean }
  | { op: 'vehicle'; modelId: string; x: number; z: number; yaw: number }
  | { op: 'evidence'; item: string; x: number; z: number; concealed: boolean }
  | { op: 'environment'; hour: number | null; weather: string | null };

/**
 * Deterministic spawn plan: the environment first (only when the scenario sets the time or the weather), then the call
 * at the anchor, the vehicles, the actors (one `pickPerson(rng)` per actor, `rng = createRng(seed).stream("sandbox:<id>")`)
 * and the evidence.
 */
export function planScenario(s: SandboxScenario, seed: number, pickPerson: (rng: Rng) => number): SpawnOp[] {
  const ops: SpawnOp[] = [];
  if (s.timeOfDay !== null || s.weather !== null) ops.push({ op: 'environment', hour: s.timeOfDay, weather: s.weather });
  if (s.call) ops.push({ op: 'call', typeId: s.call.typeId, priority: s.call.priority, x: s.anchor.x, z: s.anchor.z });
  for (const v of s.vehicles) ops.push({ op: 'vehicle', modelId: v.modelId, x: v.x, z: v.z, yaw: v.yaw });
  const rng = createRng(seed).stream(`sandbox:${s.id}`);
  s.npcs.forEach((n, index) => {
    ops.push({ op: 'actor', index, personId: pickPerson(rng), x: n.x, z: n.z, yaw: n.yaw, profile: n.profile, role: n.role, weapon: n.weapon, hidden: n.hidden });
  });
  for (const e of s.evidence) ops.push({ op: 'evidence', item: e.item, x: e.x, z: e.z, concealed: e.concealed });
  return ops;
}

function sample(file: string, json: unknown): SandboxScenario {
  const r = parseSandboxScenario(json);
  if (!r.ok) throw new Error(`${file}: ${r.errors.join('; ')}`);
  return r.value;
}

const SAMPLE_FILES = import.meta.glob<unknown>('../data/training/scenarios/*.json', { eager: true, import: 'default' });

/** The shipped scenarios (`abandoned-car`, `parking-lot-fight`; `src/data/training/scenarios/*.json`, sorted, validated at import). */
export const SAMPLE_SCENARIOS: readonly SandboxScenario[] = Object.keys(SAMPLE_FILES)
  .sort()
  .map((file) => sample(file, SAMPLE_FILES[file]));

/** Structural check of a scenario inside a save. */
export function isSandboxScenario(x: unknown): x is SandboxScenario {
  return parseSandboxScenario(x).ok;
}
