import uniformsJson from '../data/uniform/uniforms.json';
import { fail, readArray, readBoolean, readColor, readNumber, readObject, readOneOf, readString, readVersion } from '../vehicles/json';
import type { JsonObject } from '../vehicles/json';
import { CARRIER_IDS, HAT_IDS, RANK_IDS, UNIFORM_CLASSES } from './types';
import type { BadgeSpec, CarrierId, HatId, PatchSpec, RankId, UniformClass } from './types';

/**
 * Validated uniform tables (design Phase 7 §7.1). The parser throws an Error naming the file and the
 * dotted field path, e.g. `uniforms.json: classes[2].hat must be one of none, peakedCap, ..., got "fez"`.
 */

/** Fleet class ids (design §4.1, owned by `fleet`; literal copy: wave-1 modules do not import each other). */
export const FLEET_CLASS_IDS = [
  'patrol',
  'supervisor',
  'unmarked',
  'traffic',
  'k9',
  'motor',
  'bicycle',
  'atv',
  'swat',
  'armored',
  'transport',
  'command',
  'lab',
  'marine',
  'air',
  'drone',
] as const;

export const BELT_KINDS = ['dress', 'duty', 'plain'] as const;
export type BeltKind = (typeof BELT_KINDS)[number];
export const INSIGNIA_KINDS = ['chevron', 'bar', 'star'] as const;
export type InsigniaKind = (typeof INSIGNIA_KINDS)[number];
export const PATCH_SHAPES = ['shield', 'circle', 'roundedRect', 'arch', 'polygon'] as const;
export const BADGE_SHAPES = ['star', 'shield', 'circle', 'ellipse', 'polygon'] as const;

export interface UniformClassDef {
  readonly id: UniformClass;
  readonly label: string;
  readonly top: number;
  readonly bottom: number;
  readonly accent: number;
  readonly sleeves: 'long' | 'short';
  readonly tie: boolean;
  readonly jacket: boolean;
  readonly hat: HatId;
  readonly carrier: CarrierId;
  readonly belt: BeltKind;
  /** Bare shins (bike patrol). */
  readonly shorts: boolean;
  /** Tall boots on both shins (motor). */
  readonly tallBoots: boolean;
  /** Badge worn on the belt instead of the chest (detective). */
  readonly badgeOnBelt: boolean;
}

export interface RankDef {
  readonly id: RankId;
  readonly label: string;
  readonly insignia: readonly InsigniaKind[];
}

export interface UniformData {
  readonly classes: readonly UniformClassDef[];
  readonly ranks: readonly RankDef[];
  readonly skinTones: readonly number[];
  readonly hairColors: readonly number[];
  /** Fleet class -> the uniform classes allowed in it; fleet classes without a rule allow anything. */
  readonly vehiclePolicy: Readonly<Record<string, readonly UniformClass[]>>;
  readonly department: {
    readonly name: string;
    readonly initials: string;
    readonly patch: PatchSpec;
    readonly badge: BadgeSpec;
  };
}

function readBool(obj: JsonObject, key: string, file: string, path: string, fallback: boolean): boolean {
  return obj[key] === undefined ? fallback : readBoolean(obj[key], file, `${path}.${key}`);
}

function readShortText(value: unknown, file: string, path: string, maxLength: number): string {
  const s = readString(value, file, path);
  if (s.length > maxLength) fail(file, path, `must have at most ${maxLength} characters, got ${s.length}`);
  return s;
}

function readPoints(value: unknown, file: string, path: string): [number, number][] {
  const arr = readArray(value, file, path, 3);
  return arr.map((pt, i) => {
    const pair = readArray(pt, file, `${path}[${i}]`);
    if (pair.length !== 2) fail(file, `${path}[${i}]`, `must be an [x, y] pair, got ${pair.length} items`);
    return [readNumber(pair[0], file, `${path}[${i}][0]`), readNumber(pair[1], file, `${path}[${i}][1]`)];
  });
}

function parseClass(value: unknown, file: string, path: string): UniformClassDef {
  const o = readObject(value, file, path);
  return {
    id: readOneOf(o.id, UNIFORM_CLASSES, file, `${path}.id`),
    label: readString(o.label, file, `${path}.label`),
    top: readColor(o.top, file, `${path}.top`),
    bottom: readColor(o.bottom, file, `${path}.bottom`),
    accent: readColor(o.accent, file, `${path}.accent`),
    sleeves: readOneOf(o.sleeves, ['long', 'short'] as const, file, `${path}.sleeves`),
    tie: readBoolean(o.tie, file, `${path}.tie`),
    jacket: readBoolean(o.jacket, file, `${path}.jacket`),
    hat: readOneOf(o.hat, HAT_IDS, file, `${path}.hat`),
    carrier: readOneOf(o.carrier, CARRIER_IDS, file, `${path}.carrier`),
    belt: readOneOf(o.belt, BELT_KINDS, file, `${path}.belt`),
    shorts: readBool(o, 'shorts', file, path, false),
    tallBoots: readBool(o, 'tallBoots', file, path, false),
    badgeOnBelt: readBool(o, 'badgeOnBelt', file, path, false),
  };
}

function parseRank(value: unknown, file: string, path: string): RankDef {
  const o = readObject(value, file, path);
  const insignia = readArray(o.insignia, file, `${path}.insignia`).map((k, i) =>
    readOneOf(k, INSIGNIA_KINDS, file, `${path}.insignia[${i}]`),
  );
  return { id: readOneOf(o.id, RANK_IDS, file, `${path}.id`), label: readString(o.label, file, `${path}.label`), insignia };
}

function parsePatch(value: unknown, file: string, path: string): PatchSpec {
  const o = readObject(value, file, path);
  const shape = readOneOf(o.shape, PATCH_SHAPES, file, `${path}.shape`);
  const patch: PatchSpec = {
    shape,
    base: readColor(o.base, file, `${path}.base`),
    border: readColor(o.border, file, `${path}.border`),
    accent: readColor(o.accent, file, `${path}.accent`),
    initials: readShortText(o.initials, file, `${path}.initials`, 4),
    text: readShortText(o.text, file, `${path}.text`, 16),
  };
  if (shape === 'polygon' || o.points !== undefined) patch.points = readPoints(o.points, file, `${path}.points`);
  return patch;
}

function parseBadge(value: unknown, file: string, path: string): BadgeSpec {
  const o = readObject(value, file, path);
  const shape = readOneOf(o.shape, BADGE_SHAPES, file, `${path}.shape`);
  const badge: BadgeSpec = {
    shape,
    metal: readColor(o.metal, file, `${path}.metal`),
    enamel: readColor(o.enamel, file, `${path}.enamel`),
    text: readShortText(o.text, file, `${path}.text`, 12),
  };
  if (shape === 'star' || o.starPoints !== undefined) {
    const n = readNumber(o.starPoints, file, `${path}.starPoints`, 3, 12);
    if (!Number.isInteger(n)) fail(file, `${path}.starPoints`, `must be an integer, got ${n}`);
    badge.starPoints = n;
  }
  if (shape === 'polygon' || o.points !== undefined) badge.points = readPoints(o.points, file, `${path}.points`);
  return badge;
}

function readColorList(value: unknown, file: string, path: string, min: number): number[] {
  return readArray(value, file, path, min).map((c, i) => readColor(c, file, `${path}[${i}]`));
}

/** Requires `items` to hold exactly the ids of `all` (each once, any order). */
function requireExactIds(items: readonly { readonly id: string }[], all: readonly string[], file: string, path: string): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.id)) fail(file, `${path}[${i}].id`, `is duplicated, got "${item.id}"`);
    seen.add(item.id);
  });
  for (const id of all) if (!seen.has(id)) fail(file, path, `is missing "${id}"`);
}

/** Validates the uniform data document; throws an Error naming `file` and the dotted path. */
export function parseUniformData(json: unknown, file: string): UniformData {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const classes = readArray(root.classes, file, 'classes', 1).map((c, i) => parseClass(c, file, `classes[${i}]`));
  requireExactIds(classes, UNIFORM_CLASSES, file, 'classes');
  const ranks = readArray(root.ranks, file, 'ranks', 1).map((r, i) => parseRank(r, file, `ranks[${i}]`));
  requireExactIds(ranks, RANK_IDS, file, 'ranks');
  const skinTones = readColorList(root.skinTones, file, 'skinTones', 4);
  const hairColors = readColorList(root.hairColors, file, 'hairColors', 1);

  const policyObj = readObject(root.vehiclePolicy, file, 'vehiclePolicy');
  const vehiclePolicy: Record<string, readonly UniformClass[]> = {};
  for (const key of Object.keys(policyObj)) {
    readOneOf(key, FLEET_CLASS_IDS, file, `vehiclePolicy.${key}`);
    vehiclePolicy[key] = readArray(policyObj[key], file, `vehiclePolicy.${key}`, 1).map((u, i) =>
      readOneOf(u, UNIFORM_CLASSES, file, `vehiclePolicy.${key}[${i}]`),
    );
  }

  const dept = readObject(root.department, file, 'department');
  return {
    classes,
    ranks,
    skinTones,
    hairColors,
    vehiclePolicy,
    department: {
      name: readString(dept.name, file, 'department.name'),
      initials: readShortText(dept.initials, file, 'department.initials', 4),
      patch: parsePatch(dept.patch, file, 'department.patch'),
      badge: parseBadge(dept.badge, file, 'department.badge'),
    },
  };
}

export const UNIFORM_DATA: UniformData = parseUniformData(uniformsJson, 'uniforms.json');

const CLASS_BY_ID: ReadonlyMap<UniformClass, UniformClassDef> = new Map(UNIFORM_DATA.classes.map((c) => [c.id, c]));
const RANK_BY_ID: ReadonlyMap<RankId, RankDef> = new Map(UNIFORM_DATA.ranks.map((r) => [r.id, r]));

/** Class definition by id (the validator guarantees every class exists). */
export function uniformClass(id: UniformClass): UniformClassDef {
  const def = CLASS_BY_ID.get(id);
  if (def === undefined) throw new Error(`uniformClass: unknown class "${id}"`);
  return def;
}

/** Rank definition by id (the validator guarantees every rank exists). */
export function rankDef(id: RankId): RankDef {
  const def = RANK_BY_ID.get(id);
  if (def === undefined) throw new Error(`rankDef: unknown rank "${id}"`);
  return def;
}
