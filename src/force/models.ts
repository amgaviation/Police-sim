import type { Rng } from '../core/rng';
import { unitHash } from '../records/hash';
import { FORCE_CONFIG } from './data';
import { gauss } from './math';
import type { ForceConfig, ToolDef } from './types';

const DEG = Math.PI / 180;
const PREGNANCY_SALT = 0x50524547;

export interface ShotContext {
  distance: number;
  officerMoving: boolean;
  officerCrouched: boolean;
  targetRunning: boolean;
}

/** Lateral miss distance (m) of an aim error of `errDeg` degrees at `distance` metres. */
function lateralM(distance: number, errDeg: number): number {
  return distance * Math.tan(Math.min(Math.abs(errDeg), 89.9) * DEG);
}

function lerp(range: readonly [number, number], u: number): number {
  return range[0] + (range[1] - range[0]) * u;
}

/** Aim error standard deviation: `base x (1 + moving + running + crouched)`, never below `0.2 x base`. */
export function sigmaDeg(base: number, c: ShotContext, mods: ForceConfig['modifiers']): number {
  const f = 1 + (c.officerMoving ? mods.officerMoving : 0) + (c.targetRunning ? mods.targetRunning : 0) + (c.officerCrouched ? mods.crouched : 0);
  return base * Math.max(0.2, f);
}

export interface TaserShotResult {
  inRange: boolean;
  probes: 0 | 1 | 2;
  spreadM: number;
  nmi: boolean;
  painOnly: boolean;
}

/** Always draws exactly 5 numbers: gauss (2), clothing per probe (2), nmi (1). */
export function taserShot(c: ShotContext & { cold: boolean }, cfg: ForceConfig['taser'], maxRangeM: number, rng: Rng): TaserShotResult {
  const z = gauss(rng);
  const uTop = rng.next();
  const uBottom = rng.next();
  const uNmi = rng.next();
  const inRange = c.distance <= maxRangeM;
  const sigma = sigmaDeg(cfg.sigmaDeg, c, { officerMoving: cfg.movingPenalty, targetRunning: cfg.runningPenalty, crouched: 0 });
  const spreadM = c.distance * Math.tan(cfg.spreadDeg * DEG);
  const topGeo = inRange && lateralM(c.distance, z * sigma) <= cfg.torsoHalfWidthM;
  const bottomGeo = topGeo && spreadM <= cfg.targetHeightM;
  const top = topGeo && !(c.cold && uTop < cfg.clothingFail);
  const bottom = bottomGeo && !(c.cold && uBottom < cfg.clothingFail);
  const probes = ((top ? 1 : 0) + (bottom ? 1 : 0)) as 0 | 1 | 2;
  const nmi = probes === 2 && spreadM >= cfg.minSpreadM && uNmi < cfg.nmiSuccess;
  return { inRange, probes, spreadM, nmi, painOnly: probes >= 1 && !nmi };
}

export interface BallisticResult {
  hit: boolean;
  zone: 'miss' | 'limb' | 'torso' | 'head';
  injury: number;
  fatal: boolean;
}

function pickZone(u: number, w: ForceConfig['firearm']['zoneWeights']): 'limb' | 'torso' | 'head' {
  const sum = w.torso + w.limb + w.head;
  const x = u * sum;
  if (x < w.torso) return 'torso';
  if (x < w.torso + w.limb) return 'limb';
  return 'head';
}

/** Always draws exactly 5 numbers: gauss (2), zone (1), injury (1), fatal (1). `mods` default to the shipped modifiers. */
export function firearmShot(c: ShotContext, cfg: ForceConfig['firearm'], rng: Rng, mods: ForceConfig['modifiers'] = FORCE_CONFIG.modifiers): BallisticResult {
  const z = gauss(rng);
  const uZone = rng.next();
  const uInjury = rng.next();
  const uFatal = rng.next();
  const hit = lateralM(c.distance, z * sigmaDeg(cfg.sigmaDeg, c, mods)) <= cfg.torsoHalfWidthM;
  if (!hit) return { hit: false, zone: 'miss', injury: 0, fatal: false };
  const zone = pickZone(uZone, cfg.zoneWeights);
  return { hit: true, zone, injury: lerp(cfg.injury[zone], uInjury), fatal: uFatal < cfg.fatal[zone] };
}

/** Chance that a beanbag to the head at less than `minSafeM` kills. */
const LESS_LETHAL_FATAL = 0.05;

/**
 * Beanbag: like `firearmShot` with the less-lethal sigma; a head hit or a shot closer than `minSafeM` injures from
 * `closeInjury`; fatal only for a head hit closer than `minSafeM` (5 %). Always draws exactly 5 numbers.
 */
export function lessLethalShot(
  c: ShotContext,
  tool: ToolDef,
  cfg: ForceConfig['lessLethal'],
  rng: Rng,
  mods: ForceConfig['modifiers'] = FORCE_CONFIG.modifiers,
  zones: ForceConfig['firearm']['zoneWeights'] = FORCE_CONFIG.firearm.zoneWeights,
): BallisticResult {
  const z = gauss(rng);
  const uZone = rng.next();
  const uInjury = rng.next();
  const uFatal = rng.next();
  const hit = lateralM(c.distance, z * sigmaDeg(cfg.sigmaDeg, c, mods)) <= cfg.torsoHalfWidthM;
  if (!hit) return { hit: false, zone: 'miss', injury: 0, fatal: false };
  const zone = pickZone(uZone, zones);
  const close = c.distance < cfg.minSafeM;
  const injury = lerp(zone === 'head' || close ? cfg.closeInjury : tool.injury, uInjury);
  return { hit: true, zone, injury, fatal: zone === 'head' && close && uFatal < LESS_LETHAL_FATAL };
}

export interface MeleeResult {
  hit: boolean;
  incapacitated: boolean;
  injury: number;
}

/** hands / baton / ocSpray / k9: exactly 3 draws (hit, incapacitate, injury). OC chance x 0.7 on an impaired target. */
export function meleeApply(tool: ToolDef, targetImpaired: boolean, rng: Rng): MeleeResult {
  const uHit = rng.next();
  const uInc = rng.next();
  const uInjury = rng.next();
  if (!(uHit < tool.hit)) return { hit: false, incapacitated: false, injury: 0 };
  const chance = tool.incapacitate.chance * (tool.id === 'ocSpray' && targetImpaired ? 0.7 : 1);
  return { hit: true, incapacitated: uInc < chance, injury: lerp(tool.injury, uInjury) };
}

/** Hash-based (no draws): female, age in range, `unitHash < rate`. `sex` is 'F' or 'female'. */
export function isPregnant(seed: number, personId: number, sex: string, age: number, cfg: ForceConfig['risk']): boolean {
  const female = sex === 'F' || sex.toLowerCase() === 'female';
  if (!female || age < cfg.pregnancyAge[0] || age > cfg.pregnancyAge[1]) return false;
  return unitHash(seed, PREGNANCY_SALT, personId) < cfg.pregnancyRate;
}

/** Names of the set risk factors, in the order elderly juvenile pregnant elevated running restrained. */
export function riskFactors(i: { elderly: boolean; juvenile: boolean; pregnant: boolean; elevated: boolean; running: boolean; restrained: boolean }): string[] {
  const out: string[] = [];
  if (i.elderly) out.push('elderly');
  if (i.juvenile) out.push('juvenile');
  if (i.pregnant) out.push('pregnant');
  if (i.elevated) out.push('elevated');
  if (i.running) out.push('running');
  if (i.restrained) out.push('restrained');
  return out;
}
