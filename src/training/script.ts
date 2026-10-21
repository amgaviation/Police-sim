/**
 * Dispatch scripts (Phase 8 design 7.4): timed lists of calls for the dispatch-only mode. A script is untrusted input
 * (a file the player loads, later a mod): `parseDispatchScript` returns errors and never throws.
 */
import { CALL_TYPES, POI_LOCATION_KINDS } from '../cad/data';
import { CRIME_DISTRICTS } from '../environment/crime';

/** The result of validating untrusted input. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface DispatchScriptStep {
  /** Seconds after the start of the script. */
  atS: number;
  typeId: string;
  /** Priority override, null = the call type's own draw. */
  priority: 1 | 2 | 3 | 4 | null;
  near: { poi: string } | { district: string } | { x: number; z: number };
  narrative: string | null;
  /** Radio line spoken when the call arrives, null = none. */
  radio: string | null;
}

export interface DispatchScript {
  format: 'patrol-dispatch-script';
  version: 1;
  id: string;
  name: string;
  description: string;
  /** Whether the random call generator runs besides the script. */
  generator: 'on' | 'off';
  durationS: number;
  steps: DispatchScriptStep[];
}

/** What a script may reference. */
export interface ScriptContext {
  callTypeIds: ReadonlySet<string>;
  poiKinds: readonly string[];
  districts: readonly string[];
}

/** Call types, point-of-interest kinds and districts of the game. */
export function defaultScriptContext(): ScriptContext {
  return { callTypeIds: new Set(CALL_TYPES.map((t) => t.id)), poiKinds: [...POI_LOCATION_KINDS], districts: [...CRIME_DISTRICTS] };
}

/** Limits shared with the scenario format. */
export const WORLD_HALF_M = 3584;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SCRIPT_KEYS = ['format', 'version', 'id', 'name', 'description', 'generator', 'durationS', 'steps'];
const STEP_KEYS = ['atS', 'typeId', 'priority', 'near', 'narrative', 'radio'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shared error helpers: a path prefix and a list. */
export function unknownKeys(o: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${path === '' ? '' : `${path}.`}${k}: unknown field`);
}

function show(v: unknown): string {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  const s = text === undefined ? 'undefined' : text;
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/** A finite number in [min, max]; null (and an error) otherwise. */
export function checkNumber(v: unknown, path: string, min: number, max: number, errors: string[]): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push(`${path}: must be a finite number, got ${show(v)}`);
    return null;
  }
  if (v < min || v > max) {
    errors.push(`${path}: must be in [${min}, ${max}], got ${v}`);
    return null;
  }
  return v;
}

/** A string of `minLen`..`maxLen` characters; null (and an error) otherwise. */
export function checkString(v: unknown, path: string, minLen: number, maxLen: number, errors: string[]): string | null {
  if (typeof v !== 'string') {
    errors.push(`${path}: must be a string, got ${show(v)}`);
    return null;
  }
  if (v.length < minLen || v.length > maxLen) {
    errors.push(`${path}: length must be ${minLen}..${maxLen}, got ${v.length}`);
    return null;
  }
  return v;
}

/** A string that is one of `options`. */
export function checkEnum(v: unknown, path: string, options: readonly string[], label: string, errors: string[]): string | null {
  if (typeof v !== 'string' || !options.includes(v)) {
    errors.push(`${path}: unknown ${label} ${typeof v === 'string' ? `"${v}"` : show(v)}`);
    return null;
  }
  return v;
}

function checkStep(raw: unknown, i: number, durationS: number | null, ctx: ScriptContext, prevAt: number, errors: string[]): DispatchScriptStep | null {
  const p = `steps[${i}]`;
  if (!isRecord(raw)) {
    errors.push(`${p}: must be an object, got ${show(raw)}`);
    return null;
  }
  const before = errors.length;
  unknownKeys(raw, STEP_KEYS, p, errors);
  const atS = checkNumber(raw.atS, `${p}.atS`, 0, durationS ?? 7200, errors);
  if (atS !== null && atS < prevAt) errors.push(`${p}.atS: steps must be sorted by atS, ${atS} is before ${prevAt}`);
  const typeId = checkString(raw.typeId, `${p}.typeId`, 1, 80, errors);
  if (typeId !== null && !ctx.callTypeIds.has(typeId)) errors.push(`${p}.typeId: unknown call type "${typeId}"`);
  let priority: DispatchScriptStep['priority'] = null;
  if (raw.priority !== undefined && raw.priority !== null) {
    if (raw.priority === 1 || raw.priority === 2 || raw.priority === 3 || raw.priority === 4) priority = raw.priority;
    else errors.push(`${p}.priority: must be 1, 2, 3, 4 or null, got ${show(raw.priority)}`);
  }
  let near: DispatchScriptStep['near'] | null = null;
  const nr = raw.near;
  if (!isRecord(nr)) {
    errors.push(`${p}.near: must be an object with poi, district or x and z, got ${show(nr)}`);
  } else if ('poi' in nr) {
    unknownKeys(nr, ['poi'], `${p}.near`, errors);
    const poi = checkEnum(nr.poi, `${p}.near.poi`, ctx.poiKinds, 'point of interest', errors);
    if (poi !== null) near = { poi };
  } else if ('district' in nr) {
    unknownKeys(nr, ['district'], `${p}.near`, errors);
    const district = checkEnum(nr.district, `${p}.near.district`, ctx.districts, 'district', errors);
    if (district !== null) near = { district };
  } else if ('x' in nr || 'z' in nr) {
    unknownKeys(nr, ['x', 'z'], `${p}.near`, errors);
    const x = checkNumber(nr.x, `${p}.near.x`, -WORLD_HALF_M, WORLD_HALF_M, errors);
    const z = checkNumber(nr.z, `${p}.near.z`, -WORLD_HALF_M, WORLD_HALF_M, errors);
    if (x !== null && z !== null) near = { x, z };
  } else {
    errors.push(`${p}.near: must hold poi, district or x and z`);
  }
  let narrative: string | null = null;
  if (raw.narrative !== undefined && raw.narrative !== null) narrative = checkString(raw.narrative, `${p}.narrative`, 0, 280, errors);
  let radio: string | null = null;
  if (raw.radio !== undefined && raw.radio !== null) radio = checkString(raw.radio, `${p}.radio`, 0, 160, errors);
  if (errors.length > before || atS === null || typeId === null || near === null) return null;
  return { atS, typeId, priority, near, narrative, radio };
}

/**
 * Validates an untrusted script (a parsed JSON value). Rules: `format` 'patrol-dispatch-script', `version` 1, id
 * /^[a-z0-9][a-z0-9-]{1,39}$/, name 1..60 characters, description <= 400, generator 'on' | 'off', durationS 60..7200,
 * 1..100 steps sorted by atS (0 <= atS <= durationS), typeId in `ctx.callTypeIds`, `near` one of poi (in
 * `ctx.poiKinds`), district (in `ctx.districts`) or x / z (|x|, |z| <= 3584), narrative <= 280, radio <= 160; unknown
 * fields are errors. Errors read like `steps[3].typeId: unknown call type "barFightt"`. Never throws.
 */
export function parseDispatchScript(json: unknown, ctx: ScriptContext = defaultScriptContext()): ParseResult<DispatchScript> {
  const errors: string[] = [];
  try {
    if (!isRecord(json)) return { ok: false, errors: [`script: must be an object, got ${show(json)}`] };
    unknownKeys(json, SCRIPT_KEYS, '', errors);
    if (json.format !== 'patrol-dispatch-script') errors.push(`format: must be "patrol-dispatch-script", got ${show(json.format)}`);
    if (json.version !== 1) errors.push(`version: must be 1, got ${show(json.version)}`);
    const id = checkString(json.id, 'id', 1, 80, errors);
    if (id !== null && !ID_RE.test(id)) errors.push(`id: must match ${ID_RE.source}, got "${id}"`);
    const name = checkString(json.name, 'name', 1, 60, errors);
    const description = checkString(json.description, 'description', 0, 400, errors);
    const generator = checkEnum(json.generator, 'generator', ['on', 'off'], 'generator setting', errors);
    const durationS = checkNumber(json.durationS, 'durationS', 60, 7200, errors);
    const steps: DispatchScriptStep[] = [];
    if (!Array.isArray(json.steps)) {
      errors.push(`steps: must be an array, got ${show(json.steps)}`);
    } else {
      if (json.steps.length < 1 || json.steps.length > 100) errors.push(`steps: must have 1..100 items, got ${json.steps.length}`);
      let prev = 0;
      const limit = Math.min(json.steps.length, 100);
      for (let i = 0; i < limit; i++) {
        const s = checkStep(json.steps[i], i, durationS, ctx, prev, errors);
        if (s) {
          steps.push(s);
          prev = s.atS;
        } else {
          const at = (json.steps[i] as { atS?: unknown } | undefined)?.atS;
          if (typeof at === 'number' && Number.isFinite(at)) prev = Math.max(prev, at);
        }
      }
    }
    if (errors.length > 0 || id === null || name === null || description === null || generator === null || durationS === null) return { ok: false, errors };
    return { ok: true, value: { format: 'patrol-dispatch-script', version: 1, id, name, description, generator: generator as 'on' | 'off', durationS, steps } };
  } catch (e) {
    errors.push(`script: could not be read (${e instanceof Error ? e.message : 'unknown error'})`);
    return { ok: false, errors };
  }
}

/** Validates one shipped file; throws (the data must be valid at import). */
function builtin(file: string, json: unknown): DispatchScript {
  const r = parseDispatchScript(json);
  if (!r.ok) throw new Error(`${file}: ${r.errors.join('; ')}`);
  return r.value;
}

const SCRIPT_FILES = import.meta.glob<unknown>('../data/training/scripts/*.json', { eager: true, import: 'default' });

/** The shipped scripts (`src/data/training/scripts/*.json`), sorted by file name and validated at import. */
export const BUILTIN_SCRIPTS: readonly DispatchScript[] = Object.keys(SCRIPT_FILES)
  .sort()
  .map((file) => builtin(file, SCRIPT_FILES[file]));

export interface ScriptRunSave {
  scriptId: string;
  /** Sim time the script started (-1 = not started). */
  startSim: number;
  /** Index of the next step to emit. */
  next: number;
}

/** Structural check of a saved run. */
export function isScriptRunSave(x: unknown): x is ScriptRunSave {
  if (!isRecord(x)) return false;
  return (
    typeof x.scriptId === 'string' &&
    typeof x.startSim === 'number' && Number.isFinite(x.startSim) &&
    typeof x.next === 'number' && Number.isInteger(x.next) && x.next >= 0
  );
}

/** Emits the steps of a script as sim time passes. */
export class ScriptRunner {
  readonly script: DispatchScript;
  private startSim = -1;
  private next = 0;

  constructor(script: DispatchScript, save?: ScriptRunSave) {
    this.script = script;
    if (save && save.scriptId === script.id) {
      this.startSim = save.startSim;
      this.next = Math.min(save.next, script.steps.length);
    }
  }

  /** Starts the clock at `sim`. */
  start(sim: number): void {
    this.startSim = sim;
    this.next = 0;
  }

  /** Appends the steps with `startSim + atS <= sim` not yet emitted to `out`; returns how many (no allocation when none). */
  due(sim: number, out: DispatchScriptStep[]): number {
    if (this.startSim < 0) return 0;
    const steps = this.script.steps;
    let n = 0;
    while (this.next < steps.length) {
      const s = steps[this.next];
      if (!s || this.startSim + s.atS > sim) break;
      out.push(s);
      this.next++;
      n++;
    }
    return n;
  }

  /** Started and every step emitted. */
  get finished(): boolean {
    return this.startSim >= 0 && this.next >= this.script.steps.length;
  }

  serialize(): ScriptRunSave {
    return { scriptId: this.script.id, startSim: this.startSim, next: this.next };
  }
}
