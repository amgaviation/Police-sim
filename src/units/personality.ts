/**
 * Officer personality (design §5.4): names, traits and the mistake model. Everything here is a pure
 * function of the world seed, the callsign and the officer's dynamic state; profiles are never saved.
 */
import { createRng, type Rng } from '../core/rng';
import { NAMES } from '../records/data';
import { ROSTER_CONFIG } from './data';
import type {
  MistakeChances,
  MistakeKind,
  MistakeRolls,
  OfficerDynamic,
  OfficerProfile,
  OfficerTraits,
  Rank,
  RosterConfig,
} from './types';

const SKIN = [0xc68e6b, 0x8d5a3c, 0xe0b48f, 0x6f4430, 0xd2a47c] as const;
const HAIR = [0x2a1d14, 0x1a1410, 0x5a3a22, 0x3a3a3c, 0x7a5a30] as const;
const HEIGHT_RANGE = [1.62, 1.95] as const;

const TRAIT_KEYS = ['aggression', 'discipline', 'experience', 'composure', 'communication'] as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function drawName(rng: Rng, rank: Rank, cfg: RosterConfig): { first: string; last: string; name: string } {
  const male = rng.next() < 0.5;
  const first = rng.pick(male ? NAMES.male : NAMES.female);
  const last = rng.pick(NAMES.last);
  return { first, last, name: `${cfg.rankTitles[rank]} ${first.charAt(0)}. ${last}` };
}

/** Pure: name from `NAMES` with createRng(seed).stream('roster:' + callsign): sex 50/50, first by sex, last; "Officer J. Alvarez". */
export function officerName(seed: number, callsign: string, rank: Rank): { first: string; last: string; name: string } {
  return drawName(createRng(seed).stream('roster:' + callsign), rank, ROSTER_CONFIG);
}

/**
 * Pure: the profile plus the officer's starting loyalty. Draw order on the `roster:<callsign>` stream: sex,
 * first, last, aggression, discipline, experience, composure, communication, skin, hair, height, loyalty.
 */
export function officerStart(
  seed: number,
  callsign: string,
  rank: Rank,
  cfg: RosterConfig = ROSTER_CONFIG,
): { profile: OfficerProfile; loyalty: number } {
  const rng = createRng(seed).stream('roster:' + callsign);
  const n = drawName(rng, rank, cfg);
  const traits = {} as OfficerTraits;
  for (const k of TRAIT_KEYS) traits[k] = rng.nextFloat(cfg.traits[k][0], cfg.traits[k][1]);
  const skin = rng.pick(SKIN);
  const hair = rng.pick(HAIR);
  const height = Math.round(rng.nextFloat(HEIGHT_RANGE[0], HEIGHT_RANGE[1]) * 100) / 100;
  const loyalty = rng.nextFloat(cfg.loyalty.start[0], cfg.loyalty.start[1]);
  return { profile: { callsign, rank, first: n.first, last: n.last, name: n.name, traits, skin, hair, height }, loyalty };
}

/** Pure: officerName + traits uniformly inside the `traits` ranges (draw order: aggression, discipline, experience, composure, communication, skin, hair, height). */
export function officerProfile(seed: number, callsign: string, rank: Rank, cfg: RosterConfig = ROSTER_CONFIG): OfficerProfile {
  return officerStart(seed, callsign, rank, cfg).profile;
}

/**
 * Pure: chance of each mistake kind for this officer now:
 * p = clamp(base + stress*S + fatigue*F + sum(trait_k * w_k) + loyalty*L, 0, maxChance[kind]).
 */
export function mistakeChances(traits: OfficerTraits, dyn: OfficerDynamic, cfg: RosterConfig = ROSTER_CONFIG): MistakeChances {
  const chance = (kind: MistakeKind): number => {
    const w = cfg.mistakes[kind];
    let p = w.base + dyn.stress * w.stress + dyn.fatigue * w.fatigue + dyn.loyalty * w.loyalty;
    for (const k of TRAIT_KEYS) p += traits[k] * w[k];
    return clamp(p, 0, cfg.maxChance[kind]);
  };
  return { lateCallout: chance('lateCallout'), poorPosition: chance('poorPosition'), excessiveForce: chance('excessiveForce') };
}

/**
 * Pure and deterministic per seed: rng = createRng(seed).stream(`mistake:${callsign}:${seq}`); draws in the order
 * lateCallout, poorPosition, excessiveForce; each `rng.next() < chance`. `seq` = the officer's arrival count.
 */
export function rollMistakes(seed: number, callsign: string, seq: number, chances: MistakeChances): MistakeRolls {
  const rng = createRng(seed).stream(`mistake:${callsign}:${seq}`);
  const lateCallout = rng.next() < chances.lateCallout;
  const poorPosition = rng.next() < chances.poorPosition;
  const excessiveForce = rng.next() < chances.excessiveForce;
  return { lateCallout, poorPosition, excessiveForce };
}
