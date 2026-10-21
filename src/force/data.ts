import forceJson from '../data/force/force.json';
import { fail, readArray, readNumber, readObject, readOneOf, readString, readVersion, type JsonObject } from '../vehicles/json';
import { FORCE_LEVELS, FORCE_TOOLS, type ForceConfig, type ForceToolId, type Range2, type ToolDef } from './types';

export type { ForceConfig, ToolDef } from './types';

/** Tool ids that need a definition row (every tool but `none`). */
const DEFINED_TOOLS = FORCE_TOOLS.filter((t): t is Exclude<ForceToolId, 'none'> => t !== 'none');

function readRange(value: unknown, file: string, path: string, min: number, max: number): Range2 {
  const arr = readArray(value, file, path, 2);
  if (arr.length !== 2) fail(file, path, `must have 2 items, got ${arr.length}`);
  const lo = readNumber(arr[0], file, `${path}[0]`, min, max);
  const hi = readNumber(arr[1], file, `${path}[1]`, min, max);
  if (lo > hi) fail(file, path, `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

function readInt(value: unknown, file: string, path: string, min: number, max: number): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

function onlyKeys(obj: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, path === '' ? key : `${path}.${key}`, 'is not a known field');
  }
}

function section(root: JsonObject, key: string, file: string, keys: readonly string[]): JsonObject {
  const o = readObject(root[key], file, key);
  onlyKeys(o, keys, file, key);
  return o;
}

function nums(o: JsonObject, file: string, path: string, keys: readonly string[], min: number, max: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = readNumber(o[k], file, `${path}.${k}`, min, max);
  return out;
}

function readTool(value: unknown, file: string, path: string): ToolDef {
  const o = readObject(value, file, path);
  onlyKeys(o, ['id', 'label', 'level', 'armory', 'rangeM', 'coneDeg', 'hit', 'incapacitate', 'injury', 'uses', 'rounds'], file, path);
  const id = readOneOf(o.id, DEFINED_TOOLS, file, `${path}.id`);
  const inc = readObject(o.incapacitate, file, `${path}.incapacitate`);
  onlyKeys(inc, ['chance', 'seconds'], file, `${path}.incapacitate`);
  const armory = o.armory === null ? null : readString(o.armory, file, `${path}.armory`);
  const uses = o.uses === undefined ? undefined : readInt(o.uses, file, `${path}.uses`, 1, 1000);
  const rounds = o.rounds === undefined ? undefined : readInt(o.rounds, file, `${path}.rounds`, 1, 1000);
  if (id === 'ocSpray' && uses === undefined) fail(file, `${path}.uses`, 'is required for ocSpray');
  if ((id === 'lessLethal' || id === 'firearm') && rounds === undefined) fail(file, `${path}.rounds`, `is required for ${id}`);
  const tool: ToolDef = {
    id,
    label: readString(o.label, file, `${path}.label`),
    level: readOneOf(o.level, FORCE_LEVELS, file, `${path}.level`),
    armory,
    rangeM: readRange(o.rangeM, file, `${path}.rangeM`, 0, 1000),
    coneDeg: readNumber(o.coneDeg, file, `${path}.coneDeg`, 0.1, 360),
    hit: readNumber(o.hit, file, `${path}.hit`, 0, 1),
    incapacitate: {
      chance: readNumber(inc.chance, file, `${path}.incapacitate.chance`, 0, 1),
      seconds: readNumber(inc.seconds, file, `${path}.incapacitate.seconds`, 0, 3600),
    },
    injury: readRange(o.injury, file, `${path}.injury`, 0, 1),
    ...(uses !== undefined ? { uses } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
  };
  return tool;
}

/** Validates `force.json`; throws an Error naming the file and the dotted path. */
export function parseForceConfig(raw: unknown, file = 'force.json'): ForceConfig {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  onlyKeys(root, ['version', 'tools', 'taser', 'firearm', 'lessLethal', 'modifiers', 'risk', 'retention', 'fellow'], file, '');

  const rows = readArray(root.tools, file, 'tools', 1);
  const tools: ToolDef[] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const tool = readTool(row, file, `tools[${i}]`);
    if (seen.has(tool.id)) fail(file, `tools[${i}].id`, `duplicate tool "${tool.id}"`);
    seen.add(tool.id);
    tools.push(tool);
  });
  for (const id of DEFINED_TOOLS) if (!seen.has(id)) fail(file, 'tools', `is missing the required tool "${id}"`);

  const taserO = section(root, 'taser', file, [
    'cartridges', 'spreadDeg', 'minSpreadM', 'torsoHalfWidthM', 'targetHeightM', 'sigmaDeg', 'movingPenalty', 'runningPenalty',
    'clothingFail', 'coldC', 'nmiSuccess', 'painComply', 'cycleS', 'attachMaxS', 'reattachRangeM',
  ]);
  const taser: ForceConfig['taser'] = {
    cartridges: readInt(taserO.cartridges, file, 'taser.cartridges', 1, 20),
    spreadDeg: readNumber(taserO.spreadDeg, file, 'taser.spreadDeg', 0, 45),
    minSpreadM: readNumber(taserO.minSpreadM, file, 'taser.minSpreadM', 0, 10),
    torsoHalfWidthM: readNumber(taserO.torsoHalfWidthM, file, 'taser.torsoHalfWidthM', 0.01, 5),
    targetHeightM: readNumber(taserO.targetHeightM, file, 'taser.targetHeightM', 0.01, 5),
    sigmaDeg: readNumber(taserO.sigmaDeg, file, 'taser.sigmaDeg', 0.001, 90),
    movingPenalty: readNumber(taserO.movingPenalty, file, 'taser.movingPenalty', 0, 10),
    runningPenalty: readNumber(taserO.runningPenalty, file, 'taser.runningPenalty', 0, 10),
    clothingFail: readNumber(taserO.clothingFail, file, 'taser.clothingFail', 0, 1),
    coldC: readNumber(taserO.coldC, file, 'taser.coldC', -80, 60),
    nmiSuccess: readNumber(taserO.nmiSuccess, file, 'taser.nmiSuccess', 0, 1),
    painComply: readNumber(taserO.painComply, file, 'taser.painComply', 0, 1),
    cycleS: readNumber(taserO.cycleS, file, 'taser.cycleS', 0.1, 600),
    attachMaxS: readNumber(taserO.attachMaxS, file, 'taser.attachMaxS', 0, 3600),
    reattachRangeM: readNumber(taserO.reattachRangeM, file, 'taser.reattachRangeM', 0, 100),
  };

  const fireO = section(root, 'firearm', file, ['sigmaDeg', 'torsoHalfWidthM', 'zoneWeights', 'injury', 'fatal']);
  const zw = readObject(fireO.zoneWeights, file, 'firearm.zoneWeights');
  onlyKeys(zw, ['torso', 'limb', 'head'], file, 'firearm.zoneWeights');
  const zoneWeights = nums(zw, file, 'firearm.zoneWeights', ['torso', 'limb', 'head'], 0, 1) as { torso: number; limb: number; head: number };
  if (!(zoneWeights.torso + zoneWeights.limb + zoneWeights.head > 0)) fail(file, 'firearm.zoneWeights', 'must have at least one positive weight');
  const inj = readObject(fireO.injury, file, 'firearm.injury');
  onlyKeys(inj, ['limb', 'torso', 'head'], file, 'firearm.injury');
  const fat = readObject(fireO.fatal, file, 'firearm.fatal');
  onlyKeys(fat, ['limb', 'torso', 'head'], file, 'firearm.fatal');
  const firearm: ForceConfig['firearm'] = {
    sigmaDeg: readNumber(fireO.sigmaDeg, file, 'firearm.sigmaDeg', 0.001, 90),
    torsoHalfWidthM: readNumber(fireO.torsoHalfWidthM, file, 'firearm.torsoHalfWidthM', 0.01, 5),
    zoneWeights,
    injury: {
      limb: readRange(inj.limb, file, 'firearm.injury.limb', 0, 1),
      torso: readRange(inj.torso, file, 'firearm.injury.torso', 0, 1),
      head: readRange(inj.head, file, 'firearm.injury.head', 0, 1),
    },
    fatal: {
      limb: readNumber(fat.limb, file, 'firearm.fatal.limb', 0, 1),
      torso: readNumber(fat.torso, file, 'firearm.fatal.torso', 0, 1),
      head: readNumber(fat.head, file, 'firearm.fatal.head', 0, 1),
    },
  };

  const llO = section(root, 'lessLethal', file, ['sigmaDeg', 'torsoHalfWidthM', 'minSafeM', 'closeInjury']);
  const lessLethal: ForceConfig['lessLethal'] = {
    sigmaDeg: readNumber(llO.sigmaDeg, file, 'lessLethal.sigmaDeg', 0.001, 90),
    torsoHalfWidthM: readNumber(llO.torsoHalfWidthM, file, 'lessLethal.torsoHalfWidthM', 0.01, 5),
    minSafeM: readNumber(llO.minSafeM, file, 'lessLethal.minSafeM', 0, 100),
    closeInjury: readRange(llO.closeInjury, file, 'lessLethal.closeInjury', 0, 1),
  };

  const modO = section(root, 'modifiers', file, ['officerMoving', 'targetRunning', 'crouched']);
  const modifiers: ForceConfig['modifiers'] = {
    officerMoving: readNumber(modO.officerMoving, file, 'modifiers.officerMoving', -0.8, 10),
    targetRunning: readNumber(modO.targetRunning, file, 'modifiers.targetRunning', -0.8, 10),
    crouched: readNumber(modO.crouched, file, 'modifiers.crouched', -0.8, 10),
  };

  const riskO = section(root, 'risk', file, ['elevatedRoomKinds', 'pregnancyRate', 'pregnancyAge']);
  const risk: ForceConfig['risk'] = {
    elevatedRoomKinds: readArray(riskO.elevatedRoomKinds, file, 'risk.elevatedRoomKinds').map((k, i) => readString(k, file, `risk.elevatedRoomKinds[${i}]`)),
    pregnancyRate: readNumber(riskO.pregnancyRate, file, 'risk.pregnancyRate', 0, 1),
    pregnancyAge: readRange(riskO.pregnancyAge, file, 'risk.pregnancyAge', 0, 120),
  };

  const retO = section(root, 'retention', file, ['drawS', 'grabChance', 'grabRangeM']);
  const triple = (v: unknown, path: string, min: number, max: number): readonly [number, number, number] => {
    const arr = readArray(v, file, path, 3);
    if (arr.length !== 3) fail(file, path, `must have 3 items (retention levels 1..3), got ${arr.length}`);
    return [readNumber(arr[0], file, `${path}[0]`, min, max), readNumber(arr[1], file, `${path}[1]`, min, max), readNumber(arr[2], file, `${path}[2]`, min, max)];
  };
  const retention: ForceConfig['retention'] = {
    drawS: triple(retO.drawS, 'retention.drawS', 0, 10),
    grabChance: triple(retO.grabChance, 'retention.grabChance', 0, 1),
    grabRangeM: readNumber(retO.grabRangeM, file, 'retention.grabRangeM', 0, 50),
  };

  const fellO = section(root, 'fellow', file, ['chance', 'delayS', 'repeatS', 'maxStrikes', 'injury', 'interveneRadiusM']);
  const fellow: ForceConfig['fellow'] = {
    chance: readNumber(fellO.chance, file, 'fellow.chance', 0, 1),
    delayS: readRange(fellO.delayS, file, 'fellow.delayS', 0, 600),
    repeatS: readNumber(fellO.repeatS, file, 'fellow.repeatS', 0.05, 600),
    maxStrikes: readInt(fellO.maxStrikes, file, 'fellow.maxStrikes', 1, 20),
    injury: readNumber(fellO.injury, file, 'fellow.injury', 0, 1),
    interveneRadiusM: readNumber(fellO.interveneRadiusM, file, 'fellow.interveneRadiusM', 0, 1000),
  };

  return { tools, taser, firearm, lessLethal, modifiers, risk, retention, fellow };
}

/** The shipped configuration (`src/data/force/force.json`), validated at import. */
export const FORCE_CONFIG: ForceConfig = parseForceConfig(forceJson);

/** The definition of tool `id` in `cfg`. */
export function toolDef(cfg: ForceConfig, id: Exclude<ForceToolId, 'none'>): ToolDef {
  const def = cfg.tools.find((t) => t.id === id);
  if (!def) throw new Error(`force.json: missing tool "${id}"`);
  return def;
}
