import type { NpcIdentity } from '../people/types';

/** Default behaviour profile of an ambient person, adjusted by who they are (design §8: identity feeds the state machine). */

/** Profiles handed out when nobody (no scenario) chose one; only these are replaced. */
const AMBIENT_BASES: ReadonlySet<string> = new Set(['bystander', 'driverCooperative', 'driverNervous', 'passenger']);
/** Blood alcohol from which a person behaves as intoxicated. */
export const AMBIENT_DRUNK_BAC = 0.08;

/**
 * The profile of a person promoted from the street or stepping out of a car: `base` when nothing about them stands
 * out, else drunk, in crisis, agitated, evasive, confused or nervous according to temperament, mental health,
 * warrants, dementia and blood alcohol. Scenario role profiles are never replaced.
 */
export function ambientProfile(id: NpcIdentity | null, bac: number, base: string): string {
  if (id === null || !AMBIENT_BASES.has(base)) return base;
  if (bac >= AMBIENT_DRUNK_BAC) return 'subjectIntoxicated';
  const edgy = id.temperament === 'volatile' || id.temperament === 'irritable';
  if (id.mental !== 'none' && edgy) return 'subjectCrisis';
  if (id.temperament === 'volatile' && (id.wanted || id.risk >= 0.5)) return 'suspectAgitated';
  if (id.wanted || (edgy && id.risk >= 0.5)) return 'suspectEvasive';
  if (id.dementia) return 'subjectConfused';
  if (id.temperament === 'timid' || id.mental === 'anxiety' || id.mental === 'ptsd') return base === 'bystander' ? 'witnessReluctant' : 'driverNervous';
  return base;
}
