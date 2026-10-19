/**
 * Scene tuning (`src/data/scene/scene.json`), validated at import: distances, tactics, person search and
 * the ambient flee chance of a pulled-over car. Every error names the file and the field.
 */
import sceneJson from '../data/scene/scene.json';
import { fail, readNumber, readObject, readVersion, readArray, type JsonObject } from '../vehicles/json';

export interface SceneConfig {
  readonly distances: {
    readonly materializeM: number;
    readonly arriveM: number;
    readonly actionRangeM: number;
    readonly nearM: number;
    readonly propClearM: number;
    readonly sceneAtM: number;
    readonly hudM: number;
    readonly lightsM: number;
    readonly backupM: number;
    readonly driveAwayM: number;
    readonly vehicleGapM: number;
    readonly forceNearM: number;
    readonly shoutM: number;
  };
  readonly tactics: {
    readonly shoutConeDeg: number;
    readonly taserConeDeg: number;
    readonly disperseShare: number;
    readonly ackDelayS: number;
    readonly revealChance: number;
    readonly foundEscapedChance: number;
    readonly crashFootFleeChance: number;
    readonly standoffResolveS: readonly [number, number];
  };
  readonly people: { readonly pickTries: number; readonly riskMin: number; readonly injuryValue: number };
  readonly ambientFlee: {
    readonly base: number;
    readonly wanted: number;
    readonly stolen: number;
    readonly intoxicated: number;
    readonly contraband: number;
    readonly bacThreshold: number;
  };
  /** Calls bound to a building (Phase 4 design §12). */
  readonly indoor: {
    /** Search radius around the call's door spot for the building (m). */
    readonly bindRadiusM: number;
    /** A resident answers a knock after this long (sim s, drawn from the scene stream). */
    readonly knockAnswerS: readonly [number, number];
    /** A welfare knock nobody answers is exigent after this long (sim s). */
    readonly noAnswerExigencyS: number;
    /** Canvass knocks on a call that count as `canvassed`. */
    readonly canvassHits: number;
  };
  readonly limits: { readonly closedCap: number; readonly propCap: number };
}

const FILE = 'scene.json';

/** Used when a scene.json predates Phase 4 (no `indoor` section). */
const DEFAULT_INDOOR: JsonObject = { bindRadiusM: 60, knockAnswerS: [4, 10], noAnswerExigencyS: 60, canvassHits: 2 };

function section(root: JsonObject, key: string, keys: readonly string[]): JsonObject {
  const obj = readObject(root[key], FILE, key);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) fail(FILE, `${key}.${k}`, `is not one of ${keys.join(', ')}`);
  return obj;
}

function num(o: JsonObject, sec: string, key: string, min: number, max = Infinity): number {
  return readNumber(o[key], FILE, `${sec}.${key}`, min, max);
}

function range(o: JsonObject, sec: string, key: string): readonly [number, number] {
  const a = readArray(o[key], FILE, `${sec}.${key}`, 2);
  if (a.length !== 2) fail(FILE, `${sec}.${key}`, `must have 2 items, got ${a.length}`);
  const lo = readNumber(a[0], FILE, `${sec}.${key}[0]`, 0);
  const hi = readNumber(a[1], FILE, `${sec}.${key}[1]`, 0);
  if (lo > hi) fail(FILE, `${sec}.${key}`, `must be [min, max], got [${lo}, ${hi}]`);
  return [lo, hi];
}

export function parseSceneConfig(json: unknown): SceneConfig {
  const root = readObject(json, FILE, '');
  readVersion(root, FILE);
  for (const k of Object.keys(root)) if (!['version', 'distances', 'tactics', 'people', 'ambientFlee', 'indoor', 'limits'].includes(k)) fail(FILE, k, 'is not a known section');
  const d = section(root, 'distances', ['materializeM', 'arriveM', 'actionRangeM', 'nearM', 'propClearM', 'sceneAtM', 'hudM', 'lightsM', 'backupM', 'driveAwayM', 'vehicleGapM', 'forceNearM', 'shoutM']);
  const t = section(root, 'tactics', ['shoutConeDeg', 'taserConeDeg', 'disperseShare', 'ackDelayS', 'revealChance', 'foundEscapedChance', 'crashFootFleeChance', 'standoffResolveS']);
  const p = section(root, 'people', ['pickTries', 'riskMin', 'injuryValue']);
  const f = section(root, 'ambientFlee', ['base', 'wanted', 'stolen', 'intoxicated', 'contraband', 'bacThreshold']);
  const l = section(root, 'limits', ['closedCap', 'propCap']);
  const ind = root.indoor === undefined ? DEFAULT_INDOOR : section(root, 'indoor', ['bindRadiusM', 'knockAnswerS', 'noAnswerExigencyS', 'canvassHits']);
  const dist = (k: string): number => num(d, 'distances', k, 0.1, 100000);
  const prob = (o: JsonObject, sec: string, k: string): number => num(o, sec, k, 0, 1);
  const materializeM = dist('materializeM');
  const arriveM = dist('arriveM');
  if (arriveM > materializeM) fail(FILE, 'distances.arriveM', `must not exceed distances.materializeM (${materializeM}), got ${arriveM}`);
  return {
    distances: {
      materializeM,
      arriveM,
      actionRangeM: dist('actionRangeM'),
      nearM: dist('nearM'),
      propClearM: dist('propClearM'),
      sceneAtM: dist('sceneAtM'),
      hudM: dist('hudM'),
      lightsM: dist('lightsM'),
      backupM: dist('backupM'),
      driveAwayM: dist('driveAwayM'),
      vehicleGapM: dist('vehicleGapM'),
      forceNearM: dist('forceNearM'),
      shoutM: dist('shoutM'),
    },
    tactics: {
      shoutConeDeg: num(t, 'tactics', 'shoutConeDeg', 1, 180),
      taserConeDeg: num(t, 'tactics', 'taserConeDeg', 1, 180),
      disperseShare: prob(t, 'tactics', 'disperseShare'),
      ackDelayS: num(t, 'tactics', 'ackDelayS', 0, 600),
      revealChance: prob(t, 'tactics', 'revealChance'),
      foundEscapedChance: prob(t, 'tactics', 'foundEscapedChance'),
      crashFootFleeChance: prob(t, 'tactics', 'crashFootFleeChance'),
      standoffResolveS: range(t, 'tactics', 'standoffResolveS'),
    },
    people: {
      pickTries: Math.floor(num(p, 'people', 'pickTries', 1, 10000)),
      riskMin: prob(p, 'people', 'riskMin'),
      injuryValue: prob(p, 'people', 'injuryValue'),
    },
    ambientFlee: {
      base: prob(f, 'ambientFlee', 'base'),
      wanted: prob(f, 'ambientFlee', 'wanted'),
      stolen: prob(f, 'ambientFlee', 'stolen'),
      intoxicated: prob(f, 'ambientFlee', 'intoxicated'),
      contraband: prob(f, 'ambientFlee', 'contraband'),
      bacThreshold: num(f, 'ambientFlee', 'bacThreshold', 0, 1),
    },
    indoor: {
      bindRadiusM: num(ind, 'indoor', 'bindRadiusM', 1, 1000),
      knockAnswerS: range(ind, 'indoor', 'knockAnswerS'),
      noAnswerExigencyS: num(ind, 'indoor', 'noAnswerExigencyS', 0, 3600),
      canvassHits: Math.floor(num(ind, 'indoor', 'canvassHits', 1, 100)),
    },
    limits: { closedCap: Math.floor(num(l, 'limits', 'closedCap', 1, 100000)), propCap: Math.floor(num(l, 'limits', 'propCap', 1, 4096)) },
  };
}

export const SCENE_CONFIG: SceneConfig = parseSceneConfig(sceneJson);
