/** START triage rules, seeded patient vitals and transport ordering (Phase 6 design §11.2). Pure. */
import { createRng } from '../core/rng';
import type { TransportCandidate, TriageTag, Vitals } from './types';

/** Tag colours (green, yellow, red, black). */
export const TRIAGE_COLORS: Readonly<Record<TriageTag, string>> = {
  minor: '#3a9d4a',
  delayed: '#d8b31a',
  immediate: '#c8322b',
  expectant: '#202020',
};

/** Severity of a role before its injury is added. */
const ROLE_SEVERITY: Readonly<Record<string, number>> = {
  victim: 0.6,
  walkingWounded: 0.2,
  unconscious: 0.85,
  deceased: 1,
  hostage: 0.3,
};
const DEFAULT_SEVERITY = 0.3;

/**
 * START: walking -> minor; not breathing -> (breathesAfterAirway ? immediate : expectant); respRate > 30 -> immediate;
 * no radial pulse or capillary refill > 2 s -> immediate; does not follow commands -> immediate; else delayed.
 */
export function startTriage(v: Vitals): TriageTag {
  if (v.walking) return 'minor';
  if (!v.breathing) return v.breathesAfterAirway ? 'immediate' : 'expectant';
  if (v.respRate > 30) return 'immediate';
  if (!v.radialPulse || v.capRefillS > 2) return 'immediate';
  if (!v.followsCommands) return 'immediate';
  return 'delayed';
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * Vitals of a patient, pure per (seed, personId): `createRng(seed).stream('vitals:' + personId)`, six draws u1..u6 in order.
 * Severity = role base (victim 0.6, walkingWounded 0.2, unconscious 0.85, deceased 1, hostage 0.3) + injured * 0.3, clamped 0..1.
 */
export function victimVitals(seed: number, personId: number, role: string, injured: number, flags: { trapped: boolean; hazmat: boolean }): Vitals {
  const rng = createRng(seed).stream(`vitals:${personId}`);
  const u1 = rng.next();
  const u2 = rng.next();
  const u3 = rng.next();
  const u4 = rng.next();
  const u5 = rng.next();
  const u6 = rng.next();
  const severity = Math.min(1, Math.max(0, (ROLE_SEVERITY[role] ?? DEFAULT_SEVERITY) + injured * 0.3));
  const walking = severity < 0.3 && u1 < 0.9;
  const breathing = role !== 'deceased' && !(severity > 0.9 && u2 < 0.5);
  const breathesAfterAirway = !breathing && role !== 'deceased' && u3 < 0.4;
  return {
    walking,
    breathing,
    breathesAfterAirway,
    respRate: breathing ? Math.round(12 + severity * 24 + u4 * 6) : 0,
    radialPulse: breathing && !(severity > 0.6 && u5 < 0.5),
    capRefillS: round1(1 + severity * 2.5 * u6),
    followsCommands: role !== 'unconscious' && role !== 'deceased' && severity < 0.8,
    trapped: flags.trapped && severity >= 0.4 && u1 >= 0.5,
    contaminated: flags.hazmat,
  };
}

const TAG_RANK: Readonly<Record<TriageTag, number>> = { immediate: 0, delayed: 1, minor: 2, expectant: 3 };

/**
 * Person ids in transport order: tag immediate, delayed, minor (expectant and untagged never), then person id.
 * Patients already transported, trapped or contaminated are skipped.
 */
export function transportOrder(v: readonly TransportCandidate[]): number[] {
  const list = v.filter((c) => c.tag !== null && c.tag !== 'expectant' && !c.transported && !c.trapped && !c.contaminated);
  list.sort((a, b) => TAG_RANK[a.tag as TriageTag] - TAG_RANK[b.tag as TriageTag] || a.personId - b.personId);
  return list.map((c) => c.personId);
}
