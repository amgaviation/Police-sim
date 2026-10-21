/**
 * Livery validation, canonical form and import / export (Phase 7 §6.2). User files are untrusted
 * input: `parseLivery` / `importLivery` never throw, they return every error as
 * `"dotted.path[i]: message"`. Pure: no DOM, no THREE, no clock, no randomness.
 */
import { SIREN_TONE_NAMES } from '../police/data';
import { LIGHTBAR_PATTERNS } from '../police/lightbar';
import {
  FINISHES,
  LAYER_TYPES,
  LIGHTBAR_STYLES,
  LIVERY_FACES,
  LIVERY_FONTS,
  LIVERY_FORMAT,
  LIVERY_LIMITS,
  LIVERY_VERSION,
  LIVERY_WEIGHTS,
  SHAPE_KINDS,
  WRAP_KINDS,
  type CheckerLayer,
  type Hex,
  type LiveryDoc,
  type LiveryLayer,
  type LiveryResult,
  type LiverySiren,
  type ShapeLayer,
  type StripeLayer,
  type TextLayer,
} from './types';

type Obj = Record<string, unknown>;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const ITEM_ID_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
/** Printable ASCII plus Latin-1 (0xA0-0xFF). */
const TEXT_RE = /^[\x20-\x7E\xA0-\xFF]+$/;

const TOP_KEYS = ['format', 'version', 'id', 'name', 'author', 'base', 'wrap', 'layers', 'lights', 'equipment', 'loadout'];
const LAYER_KEYS: Readonly<Record<string, readonly string[]>> = {
  stripe: ['type', 'face', 'u0', 'u1', 'v', 'height', 'angleDeg', 'color', 'reflective'],
  shape: ['type', 'face', 'shape', 'u', 'v', 'w', 'h', 'rotationDeg', 'color', 'outline', 'reflective', 'starPoints', 'points'],
  text: ['type', 'face', 'text', 'u', 'v', 'size', 'color', 'outline', 'font', 'weight', 'italic', 'reflective'],
  checker: ['type', 'face', 'v', 'height', 'cells', 'rows', 'colors', 'reflective'],
};

// --- readers ---------------------------------------------------------------------------------

function join(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path === '' ? key : `${path}.${key}`;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) return String(v);
  return Array.isArray(v) ? 'an array' : typeof v;
}

/** The object at `path`, or null after recording an error. */
function asObject(v: unknown, path: string, errs: string[]): Obj | null {
  if (!isObj(v)) {
    errs.push(`${path}: must be an object`);
    return null;
  }
  return v;
}

function checkKeys(o: Obj, path: string, allowed: readonly string[], errs: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errs.push(`${join(path, k)}: unknown key`);
}

/** `o[key]`; records `missing` and returns undefined when absent. */
function need(o: Obj, key: string, path: string, errs: string[]): unknown {
  if (!Object.hasOwn(o, key)) {
    errs.push(`${join(path, key)}: missing`);
    return undefined;
  }
  return o[key];
}

function numberAt(v: unknown, p: string, errs: string[], min: number, max: number, flags?: { int?: boolean; exMin?: boolean }): number | undefined {
  const lo = flags?.exMin ? '(' : '[';
  const range = `${lo}${min}, ${max}]`;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errs.push(`${p}: must be a number in ${range}, got ${show(v)}`);
    return undefined;
  }
  if (flags?.int && !Number.isInteger(v)) {
    errs.push(`${p}: must be an integer in ${range}, got ${v}`);
    return undefined;
  }
  if (v < min || v > max || (flags?.exMin && v <= min)) {
    errs.push(`${p}: must be ${flags?.int ? 'an integer ' : ''}in ${range}, got ${v}`);
    return undefined;
  }
  return v;
}

function readNum(o: Obj, key: string, path: string, errs: string[], min: number, max: number, flags?: { int?: boolean; exMin?: boolean }): number | undefined {
  const v = need(o, key, path, errs);
  return v === undefined && !Object.hasOwn(o, key) ? undefined : numberAt(v, join(path, key), errs, min, max, flags);
}

function readBool(o: Obj, key: string, path: string, errs: string[]): boolean | undefined {
  const v = need(o, key, path, errs);
  if (v === undefined && !Object.hasOwn(o, key)) return undefined;
  if (typeof v !== 'boolean') {
    errs.push(`${join(path, key)}: must be true or false, got ${show(v)}`);
    return undefined;
  }
  return v;
}

function hexAt(v: unknown, p: string, errs: string[]): Hex | undefined {
  if (typeof v !== 'string' || !HEX_RE.test(v)) {
    errs.push(`${p}: must be #rrggbb, got ${show(v)}`);
    return undefined;
  }
  return v.toLowerCase();
}

function readHex(o: Obj, key: string, path: string, errs: string[]): Hex | undefined {
  const v = need(o, key, path, errs);
  return v === undefined && !Object.hasOwn(o, key) ? undefined : hexAt(v, join(path, key), errs);
}

/** `#rrggbb` or null. */
function readHexOrNull(o: Obj, key: string, path: string, errs: string[]): Hex | null | undefined {
  if (!Object.hasOwn(o, key)) {
    errs.push(`${join(path, key)}: missing`);
    return undefined;
  }
  return o[key] === null ? null : hexAt(o[key], join(path, key), errs);
}

function readOneOf<T extends string>(o: Obj, key: string, path: string, errs: string[], options: readonly T[]): T | undefined {
  const v = need(o, key, path, errs);
  if (v === undefined && !Object.hasOwn(o, key)) return undefined;
  if (typeof v !== 'string' || !(options as readonly string[]).includes(v)) {
    errs.push(`${join(path, key)}: must be one of ${options.join(', ')}, got ${show(v)}`);
    return undefined;
  }
  return v as T;
}

function readText(o: Obj, key: string, path: string, errs: string[], min: number, max: number): string | undefined {
  const v = need(o, key, path, errs);
  if (v === undefined && !Object.hasOwn(o, key)) return undefined;
  if (typeof v !== 'string' || v.length < min || v.length > max) {
    errs.push(`${join(path, key)}: must be a string of ${min} to ${max} characters, got ${show(v)}`);
    return undefined;
  }
  return v;
}

// --- layers ----------------------------------------------------------------------------------

function readPoints(v: unknown, p: string, errs: string[]): [number, number][] | undefined {
  if (!Array.isArray(v)) {
    errs.push(`${p}: must be an array of ${3} to ${LIVERY_LIMITS.polygonPoints} [x, y] pairs`);
    return undefined;
  }
  const n = v.length;
  let ok = true;
  if (n < 3 || n > LIVERY_LIMITS.polygonPoints) {
    errs.push(`${p}: must have 3 to ${LIVERY_LIMITS.polygonPoints} points, got ${n}`);
    ok = false;
  }
  const out: [number, number][] = [];
  for (let i = 0; i < Math.min(n, LIVERY_LIMITS.polygonPoints); i++) {
    const pt: unknown = v[i];
    const pp = join(p, i);
    if (!Array.isArray(pt) || pt.length !== 2) {
      errs.push(`${pp}: must be [x, y]`);
      ok = false;
      continue;
    }
    const x = numberAt(pt[0], `${pp}[0]`, errs, -1, 1);
    const y = numberAt(pt[1], `${pp}[1]`, errs, -1, 1);
    if (x === undefined || y === undefined) ok = false;
    else out.push([x, y]);
  }
  return ok ? out : undefined;
}

function readStripe(o: Obj, p: string, errs: string[]): StripeLayer {
  const face = readOneOf(o, 'face', p, errs, LIVERY_FACES);
  const u0 = readNum(o, 'u0', p, errs, 0, 1);
  const u1 = readNum(o, 'u1', p, errs, 0, 1);
  if (u0 !== undefined && u1 !== undefined && u0 >= u1) errs.push(`${join(p, 'u1')}: must be greater than u0 (${u0}), got ${u1}`);
  return {
    type: 'stripe',
    face,
    u0,
    u1,
    v: readNum(o, 'v', p, errs, 0, 1),
    height: readNum(o, 'height', p, errs, 0, 1, { exMin: true }),
    angleDeg: readNum(o, 'angleDeg', p, errs, -45, 45),
    color: readHex(o, 'color', p, errs),
    reflective: readBool(o, 'reflective', p, errs),
  } as StripeLayer;
}

function readShape(o: Obj, p: string, errs: string[]): ShapeLayer {
  const face = readOneOf(o, 'face', p, errs, LIVERY_FACES);
  const shape = readOneOf(o, 'shape', p, errs, SHAPE_KINDS);
  const layer = {
    type: 'shape',
    face,
    shape,
    u: readNum(o, 'u', p, errs, 0, 1),
    v: readNum(o, 'v', p, errs, 0, 1),
    w: readNum(o, 'w', p, errs, 0, 1, { exMin: true }),
    h: readNum(o, 'h', p, errs, 0, 1, { exMin: true }),
    rotationDeg: readNum(o, 'rotationDeg', p, errs, -180, 180),
    color: readHex(o, 'color', p, errs),
    outline: readHexOrNull(o, 'outline', p, errs),
    reflective: readBool(o, 'reflective', p, errs),
  } as ShapeLayer;
  if (o.starPoints !== undefined) {
    const sp = join(p, 'starPoints');
    if (shape !== 'star') errs.push(`${sp}: only allowed for shape "star"`);
    else layer.starPoints = numberAt(o.starPoints, sp, errs, 3, 12, { int: true });
  }
  if (o.points !== undefined) {
    const pp = join(p, 'points');
    if (shape !== 'polygon') errs.push(`${pp}: only allowed for shape "polygon"`);
    else layer.points = readPoints(o.points, pp, errs);
  } else if (shape === 'polygon') {
    errs.push(`${join(p, 'points')}: missing (required for shape "polygon")`);
  }
  return layer;
}

function readTextLayer(o: Obj, p: string, errs: string[]): TextLayer {
  const text = readText(o, 'text', p, errs, 1, LIVERY_LIMITS.textChars);
  if (text !== undefined && !TEXT_RE.test(text)) errs.push(`${join(p, 'text')}: must use printable characters (0x20-0x7E, 0xA0-0xFF)`);
  return {
    type: 'text',
    face: readOneOf(o, 'face', p, errs, LIVERY_FACES),
    text,
    u: readNum(o, 'u', p, errs, 0, 1),
    v: readNum(o, 'v', p, errs, 0, 1),
    size: readNum(o, 'size', p, errs, 0.05, 1),
    color: readHex(o, 'color', p, errs),
    outline: readHexOrNull(o, 'outline', p, errs),
    font: readOneOf(o, 'font', p, errs, LIVERY_FONTS),
    weight: readOneOf(o, 'weight', p, errs, LIVERY_WEIGHTS),
    italic: readBool(o, 'italic', p, errs),
    reflective: readBool(o, 'reflective', p, errs),
  } as TextLayer;
}

function readChecker(o: Obj, p: string, errs: string[]): CheckerLayer {
  const face = readOneOf(o, 'face', p, errs, LIVERY_FACES);
  const v = readNum(o, 'v', p, errs, 0, 1);
  const height = readNum(o, 'height', p, errs, 0, 1, { exMin: true });
  const cells = readNum(o, 'cells', p, errs, 2, 40, { int: true });
  const rows = readNum(o, 'rows', p, errs, 1, 3, { int: true });
  let colors: [Hex, Hex] | undefined;
  const cv = need(o, 'colors', p, errs);
  if (Object.hasOwn(o, 'colors')) {
    const cp = join(p, 'colors');
    if (!Array.isArray(cv) || cv.length !== 2) errs.push(`${cp}: must be an array of 2 colours`);
    else {
      const a = hexAt(cv[0], `${cp}[0]`, errs);
      const b = hexAt(cv[1], `${cp}[1]`, errs);
      if (a !== undefined && b !== undefined) colors = [a, b];
    }
  }
  return { type: 'checker', face, v, height, cells, rows, colors, reflective: readBool(o, 'reflective', p, errs) } as CheckerLayer;
}

function readLayer(v: unknown, p: string, errs: string[]): LiveryLayer | undefined {
  const o = asObject(v, p, errs);
  if (o === null) return undefined;
  const type = o.type;
  if (typeof type !== 'string' || !(LAYER_TYPES as readonly string[]).includes(type)) {
    errs.push(`${join(p, 'type')}: must be one of ${LAYER_TYPES.join(', ')}, got ${show(type)}`);
    return undefined;
  }
  checkKeys(o, p, LAYER_KEYS[type] ?? [], errs);
  switch (type) {
    case 'stripe':
      return readStripe(o, p, errs);
    case 'shape':
      return readShape(o, p, errs);
    case 'text':
      return readTextLayer(o, p, errs);
    default:
      return readChecker(o, p, errs);
  }
}

// --- sections --------------------------------------------------------------------------------

function readWrap(v: unknown, errs: string[]): LiveryDoc['wrap'] | undefined {
  if (v === null) return null;
  const o = asObject(v, 'wrap', errs);
  if (o === null) return undefined;
  checkKeys(o, 'wrap', ['kind', 'colors', 'split'], errs);
  const kind = readOneOf(o, 'kind', 'wrap', errs, WRAP_KINDS);
  const split = readNum(o, 'split', 'wrap', errs, 0, 1);
  const cv = need(o, 'colors', 'wrap', errs);
  let colors: Hex[] | undefined;
  if (Object.hasOwn(o, 'colors')) {
    if (!Array.isArray(cv) || cv.length < 1 || cv.length > 3) errs.push('wrap.colors: must be an array of 1 to 3 colours');
    else {
      const list = cv.map((c: unknown, i) => hexAt(c, `wrap.colors[${i}]`, errs));
      if (list.every((c) => c !== undefined)) colors = list;
    }
  }
  return { kind, colors, split } as LiveryDoc['wrap'];
}

function readLoadout(v: unknown, errs: string[]): LiveryDoc['loadout'] | undefined {
  if (v === null) return null;
  const o = asObject(v, 'loadout', errs);
  if (o === null) return undefined;
  checkKeys(o, 'loadout', ['trunk', 'rack'], errs);
  const trunk: Record<string, number> = {};
  const tv = need(o, 'trunk', 'loadout', errs);
  if (Object.hasOwn(o, 'trunk') && asObject(tv, 'loadout.trunk', errs) !== null) {
    const entries = Object.keys(tv as Obj);
    if (entries.length > LIVERY_LIMITS.loadoutEntries) errs.push(`loadout.trunk: at most ${LIVERY_LIMITS.loadoutEntries} entries, got ${entries.length}`);
    for (const k of entries) {
      const kp = join('loadout.trunk', k);
      if (!ITEM_ID_RE.test(k)) {
        errs.push(`${kp}: item id must match [a-zA-Z][a-zA-Z0-9]*`);
        continue;
      }
      const n = numberAt((tv as Obj)[k], kp, errs, 0, 99, { int: true });
      if (n !== undefined) trunk[k] = n;
    }
  }
  const rack: string[] = [];
  const rv = need(o, 'rack', 'loadout', errs);
  if (Object.hasOwn(o, 'rack')) {
    if (!Array.isArray(rv)) errs.push('loadout.rack: must be an array of strings');
    else {
      if (rv.length > 4) errs.push(`loadout.rack: at most 4 entries, got ${rv.length}`);
      rv.slice(0, 4).forEach((s: unknown, i) => {
        if (typeof s === 'string') rack.push(s);
        else errs.push(`loadout.rack[${i}]: must be a string`);
      });
    }
  }
  return { trunk, rack };
}

function readDoc(root: unknown, errs: string[]): LiveryDoc | undefined {
  const o = asObject(root, 'livery', errs);
  if (o === null) return undefined;
  checkKeys(o, '', TOP_KEYS, errs);

  if (need(o, 'format', '', errs) !== LIVERY_FORMAT && Object.hasOwn(o, 'format')) errs.push(`format: must be "${LIVERY_FORMAT}"`);
  if (Object.hasOwn(o, 'version')) {
    const ver = o.version;
    if (typeof ver === 'number' && ver > LIVERY_VERSION) errs.push(`version: newer than supported (${LIVERY_VERSION})`);
    else if (ver !== LIVERY_VERSION) errs.push(`version: must be ${LIVERY_VERSION}, got ${show(ver)}`);
  } else errs.push('version: missing');

  let id = need(o, 'id', '', errs);
  if (Object.hasOwn(o, 'id') && (typeof id !== 'string' || !ID_RE.test(id))) {
    errs.push('id: must match [a-zA-Z0-9_-] and be 1 to 40 characters');
    id = undefined;
  }
  const name = readText(o, 'name', '', errs, 1, LIVERY_LIMITS.nameChars);
  const author = readText(o, 'author', '', errs, 0, LIVERY_LIMITS.nameChars);

  let base: LiveryDoc['base'] | undefined;
  const bv = need(o, 'base', '', errs);
  const bo = Object.hasOwn(o, 'base') ? asObject(bv, 'base', errs) : null;
  if (bo !== null) {
    checkKeys(bo, 'base', ['color', 'finish'], errs);
    base = { color: readHex(bo, 'color', 'base', errs), finish: readOneOf(bo, 'finish', 'base', errs, FINISHES) } as LiveryDoc['base'];
  }

  const wrap = Object.hasOwn(o, 'wrap') ? readWrap(o.wrap, errs) : (need(o, 'wrap', '', errs) as undefined);

  const layers: LiveryLayer[] = [];
  const lv = need(o, 'layers', '', errs);
  if (Object.hasOwn(o, 'layers')) {
    if (!Array.isArray(lv)) errs.push('layers: must be an array');
    else {
      if (lv.length > LIVERY_LIMITS.layers) errs.push(`layers: at most ${LIVERY_LIMITS.layers} layers, got ${lv.length}`);
      for (let i = 0; i < Math.min(lv.length, LIVERY_LIMITS.layers); i++) {
        const layer = readLayer(lv[i], join('layers', i), errs);
        if (layer) layers.push(layer);
      }
    }
  }

  let lights: LiveryDoc['lights'] | undefined;
  const lov = need(o, 'lights', '', errs);
  const lo = Object.hasOwn(o, 'lights') ? asObject(lov, 'lights', errs) : null;
  if (lo !== null) {
    checkKeys(lo, 'lights', ['style', 'pattern', 'siren'], errs);
    const patterns = LIGHTBAR_PATTERNS.map((pt) => pt.id);
    lights = {
      style: readOneOf(lo, 'style', 'lights', errs, LIGHTBAR_STYLES),
      pattern: readOneOf(lo, 'pattern', 'lights', errs, patterns),
      siren: readOneOf<LiverySiren>(lo, 'siren', 'lights', errs, SIREN_TONE_NAMES),
    } as LiveryDoc['lights'];
  }

  let equipment: LiveryDoc['equipment'] | undefined;
  const ev = need(o, 'equipment', '', errs);
  const eo = Object.hasOwn(o, 'equipment') ? asObject(ev, 'equipment', errs) : null;
  if (eo !== null) {
    checkKeys(eo, 'equipment', ['pushBar', 'spotlight', 'partition'], errs);
    equipment = {
      pushBar: readBool(eo, 'pushBar', 'equipment', errs),
      spotlight: readBool(eo, 'spotlight', 'equipment', errs),
      partition: readBool(eo, 'partition', 'equipment', errs),
    } as LiveryDoc['equipment'];
  }

  const loadout = Object.hasOwn(o, 'loadout') ? readLoadout(o.loadout, errs) : (need(o, 'loadout', '', errs) as undefined);

  return { format: LIVERY_FORMAT, version: LIVERY_VERSION, id, name, author, base, wrap, layers, lights, equipment, loadout } as LiveryDoc;
}

// --- public API ------------------------------------------------------------------------------

/** Validates untrusted JSON; never throws. The returned doc is canonical (lowercase colours, §6.1 key order). */
export function parseLivery(json: unknown): LiveryResult {
  const errors: string[] = [];
  try {
    const doc = readDoc(json, errors);
    if (errors.length === 0 && doc) return { ok: true, livery: canonicalLivery(doc) };
  } catch {
    errors.push('livery: could not be read');
  }
  return { ok: false, errors: errors.length > 0 ? errors : ['livery: invalid'] };
}

function byteLength(text: string): number {
  if (text.length > LIVERY_LIMITS.fileBytes) return text.length;
  if (text.length * 3 <= LIVERY_LIMITS.fileBytes) return text.length;
  return new TextEncoder().encode(text).length;
}

/** Parses a `.json` file's text: size limit, JSON syntax, then `parseLivery`. */
export function importLivery(text: string): LiveryResult {
  if (typeof text !== 'string') return { ok: false, errors: ['file: not valid JSON'] };
  if (byteLength(text) > LIVERY_LIMITS.fileBytes) return { ok: false, errors: ['file: larger than 64 KiB'] };
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, errors: ['file: not valid JSON'] };
  }
  return parseLivery(json);
}

const lower = (c: Hex): Hex => c.toLowerCase();
/** Normalises -0 to 0 so a JSON round trip is exact. */
const num = (n: number): number => n + 0;

function canonicalLayer(l: LiveryLayer): LiveryLayer {
  switch (l.type) {
    case 'stripe':
      return {
        type: 'stripe',
        face: l.face,
        u0: num(l.u0),
        u1: num(l.u1),
        v: num(l.v),
        height: num(l.height),
        angleDeg: num(l.angleDeg),
        color: lower(l.color),
        reflective: l.reflective,
      };
    case 'shape': {
      const out: ShapeLayer = {
        type: 'shape',
        face: l.face,
        shape: l.shape,
        u: num(l.u),
        v: num(l.v),
        w: num(l.w),
        h: num(l.h),
        rotationDeg: num(l.rotationDeg),
        color: lower(l.color),
        outline: l.outline === null ? null : lower(l.outline),
        reflective: l.reflective,
      };
      if (l.starPoints !== undefined) out.starPoints = num(l.starPoints);
      if (l.points !== undefined) out.points = l.points.map(([x, y]): [number, number] => [num(x), num(y)]);
      return out;
    }
    case 'text':
      return {
        type: 'text',
        face: l.face,
        text: l.text,
        u: num(l.u),
        v: num(l.v),
        size: num(l.size),
        color: lower(l.color),
        outline: l.outline === null ? null : lower(l.outline),
        font: l.font,
        weight: l.weight,
        italic: l.italic,
        reflective: l.reflective,
      };
    case 'checker':
      return {
        type: 'checker',
        face: l.face,
        v: num(l.v),
        height: num(l.height),
        cells: num(l.cells),
        rows: num(l.rows),
        colors: [lower(l.colors[0]), lower(l.colors[1])],
        reflective: l.reflective,
      };
  }
}

/** Deep copy with keys in the §6.1 declaration order, lowercase colours, optional keys omitted when undefined. */
export function canonicalLivery(doc: LiveryDoc): LiveryDoc {
  return {
    format: LIVERY_FORMAT,
    version: LIVERY_VERSION,
    id: doc.id,
    name: doc.name,
    author: doc.author,
    base: { color: lower(doc.base.color), finish: doc.base.finish },
    wrap: doc.wrap ? { kind: doc.wrap.kind, colors: doc.wrap.colors.map(lower), split: num(doc.wrap.split) } : null,
    layers: doc.layers.map(canonicalLayer),
    lights: { style: doc.lights.style, pattern: doc.lights.pattern, siren: doc.lights.siren },
    equipment: { pushBar: doc.equipment.pushBar, spotlight: doc.equipment.spotlight, partition: doc.equipment.partition },
    loadout: doc.loadout ? { trunk: { ...doc.loadout.trunk }, rack: [...doc.loadout.rack] } : null,
  };
}

/** Canonical JSON text of a livery (what the export button saves). */
export function exportLivery(doc: LiveryDoc): string {
  return JSON.stringify(canonicalLivery(doc), null, 2) + '\n';
}

/** A free id derived from `base`: its slug (`[a-zA-Z0-9_-]`, at most 32 chars), then `-2`, `-3`, ... until unused. */
export function newLiveryId(base: string, taken: readonly string[]): string {
  const slug =
    base
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'livery';
  if (!taken.includes(slug)) return slug;
  for (let n = 2; ; n++) {
    const id = `${slug}-${n}`;
    if (!taken.includes(id)) return id;
  }
}
