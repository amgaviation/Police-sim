import type { AdvisoryEvent, Offense, PursuitEndEvent, PursuitRuling, PursuitSampleEvent, PursuitStartEvent, Ruleset } from './types';

/** Everything the pursuit policy needs about one vehicle pursuit. */
export interface PursuitInput {
  start: PursuitStartEvent;
  samples: readonly PursuitSampleEvent[];
  end: PursuitEndEvent | null;
  /** The first `terminatePursuit` advisory. */
  advisory: AdvisoryEvent | null;
  offense: Offense | null;
  /** Used as the end time when `end` is null. */
  nowT: number;
}

/** Speed (mph) over the limit allowed in `district`, reduced by `wetFactor` / `nightFactor`. */
export function allowedOverMph(rs: Ruleset, district: string, wet: boolean, night: boolean): number {
  const table = rs.pursuit.maxOverLimitMph;
  let over = table[district] ?? table.default ?? 0;
  if (wet) over *= rs.pursuit.wetFactor;
  if (night) over *= rs.pursuit.nightFactor;
  return over;
}

interface Checks {
  ruling: PursuitRuling;
  /** Reasons and rule ids without the ignored-advisory rule. */
  problems: { ruleId: string; reason: string }[];
}

function run(p: PursuitInput, rs: Ruleset): Checks {
  const pol = rs.pursuit;
  const startAllowed = p.offense !== null && pol.allowedOffenses.includes(p.offense);
  let overLimitS = 0;
  let prevT = -1;
  let lightsSirenOk = true;
  for (const s of p.samples) {
    const dt = prevT < 0 ? 1 : s.t - prevT;
    prevT = s.t;
    if (s.speedMph > s.limitMph + allowedOverMph(rs, s.district, s.wet, s.night)) overLimitS += dt;
    if (pol.requireLightsSiren && !(s.lights && s.siren)) lightsSirenOk = false;
  }
  const endT = p.end ? p.end.t : p.nowT;
  const durationS = endT - p.start.t;
  const terminated = p.end?.reason === 'terminated';
  const advisoryIgnoredS = p.advisory ? Math.max(0, endT - p.advisory.t) : 0;

  const problems: { ruleId: string; reason: string }[] = [];
  if (!startAllowed) {
    const label = p.offense !== null ? rs.offenses[p.offense].label : 'an unknown offense';
    problems.push({ ruleId: pol.ruleId, reason: `Pursuit initiated for ${label}` });
  }
  if (overLimitS > pol.maxOverS) {
    problems.push({ ruleId: pol.speedRuleId, reason: `Speed stayed above the allowed margin for ${Math.round(overLimitS)} s (limit ${pol.maxOverS} s)` });
  }
  if (!lightsSirenOk) problems.push({ ruleId: pol.equipmentRuleId, reason: 'Emergency lights and siren were not active throughout' });
  if (durationS > pol.maxDurationS && !terminated) {
    problems.push({ ruleId: pol.terminateRuleId, reason: `Pursuit ran ${Math.round(durationS)} s past the ${pol.maxDurationS} s limit without being terminated` });
  }

  const reasons = problems.map((x) => x.reason);
  const ruleIds = problems.map((x) => x.ruleId);
  if (advisoryIgnoredS > pol.terminateGraceS) {
    reasons.push(`Termination advisory ignored for ${Math.round(advisoryIgnoredS)} s`);
    ruleIds.push(pol.terminateRuleId);
  }
  const unique = [...new Set(ruleIds)];
  const ruling: PursuitRuling = {
    startEventId: p.start.id, personId: p.start.personId, offense: p.offense, startAllowed, overLimitS, lightsSirenOk,
    advisoryIgnoredS, durationS, terminated, outcome: reasons.length > 0 ? 'unlawful' : 'lawful', ruleIds: unique, reasons,
  };
  return { ruling, problems };
}

/** Judges one vehicle pursuit (design §5.7). */
export function evaluatePursuit(p: PursuitInput, rs: Ruleset): PursuitRuling {
  return run(p, rs).ruling;
}

/** Live check for the recorder: the first policy problem so far (excluding the advisory rule), null when none. */
export function pursuitAdvisory(p: PursuitInput, rs: Ruleset): string | null {
  return run(p, rs).problems[0]?.reason ?? null;
}
