import type { Intoxication, NpcIdentity } from '../people/types';
import type { BehaviorProfile } from './data';
import type { CommandContext, NpcCommand } from './types';

/** Pure command-response formulas (design §8.4). */

const SIMPLE: readonly NpcCommand[] = ['stop', 'handsUp', 'getDown', 'comeHere', 'stayBack', 'showHands', 'dropWeapon'];
const GESTURE: readonly NpcCommand[] = ['stop', 'handsUp', 'getDown', 'comeHere', 'stayBack', 'showHands', 'dropWeapon'];

const WEAPON_BONUS = { none: 0, sidearm: 0.2, taser: 0.15 } as const;
const TONE_BONUS = { polite: 0, neutral: 0, commanding: 0.1, shout: 0.1, aggressive: 0.05 } as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Chance that a person obeys `cmd`. `profile.compliance` plus the officer's weapon (x1.5 against a hostile
 * demeanor), backup, lights, rapport and tone, minus stress, intoxication, a warrant and a bad attitude;
 * juveniles add 0.05. Clamped to [0.02, 0.98]. `release` and `returnToVehicle` are internal and always
 * succeed (0.98). `id` null (an animal) skips the identity terms.
 */
export function complianceChance(
  p: BehaviorProfile,
  id: NpcIdentity | null,
  intox: Intoxication,
  stress: number,
  ctx: CommandContext,
  cmd: NpcCommand,
): number {
  if (cmd === 'release' || cmd === 'returnToVehicle') return 0.98;
  let weapon = WEAPON_BONUS[ctx.weapon] ?? 0;
  if (p.demeanor === 'hostile') weapon *= 1.5;
  let v = p.compliance + weapon;
  v += 0.08 * Math.min(Math.max(ctx.backup, 0), 3);
  if (ctx.lights) v += 0.05;
  v += 0.2 * ctx.rapport;
  v -= 0.25 * stress;
  v -= 0.2 * intox.level;
  v += TONE_BONUS[ctx.tone] ?? 0;
  if (id) {
    if (id.wanted) v -= 0.15;
    v -= Math.max(0, -id.attitude) * 0.15;
    if (id.juvenile) v += 0.05;
  }
  return clamp(v, 0.02, 0.98);
}

/**
 * Probability (0..1) that the person understands `cmd` given the way it is communicated. Deaf people only
 * get written text or gestures (gestures cover the simple commands at 0.9), hard of hearing people 0.6 of
 * verbal commands; non-English speakers 0.6 / 0.1 (none) or 0.8 / 0.5 (limited) for simple / other commands
 * unless an interpreter or translation app is used; dementia halves the result. `id` null (an animal) is 1.
 */
export function understands(id: NpcIdentity | null, commMode: string, cmd: NpcCommand): number {
  if (id === null) return 1;
  if (cmd === 'release' || cmd === 'returnToVehicle') return 1;
  const simple = SIMPLE.includes(cmd);
  const aided = commMode === 'interpreter' || commMode === 'translationApp';
  let u = 1;
  if (id.hearing === 'deaf') {
    if (commMode === 'gesture') u = GESTURE.includes(cmd) ? 0.9 : 0;
    else if (commMode === 'written') u = 1;
    else return 0;
  } else if (id.hearing === 'hardOfHearing' && (commMode === 'verbal' || aided)) {
    u *= 0.6;
  }
  if (u > 0 && !aided) {
    const eng = id.language.english;
    if (eng === 'none') {
      const base = simple ? 0.6 : 0.1;
      u *= commMode === 'gesture' && simple ? 1 : base;
    } else if (eng === 'limited') {
      u *= simple ? 0.8 : 0.5;
    }
  }
  if (id.dementia) u *= 0.5;
  return clamp(u, 0, 1);
}
