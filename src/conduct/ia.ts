import {
  CAM, RESISTANCE_LEVELS,
  type ForceEvent, type ForceRuling, type IncidentLog, type LegalAssessment,
} from '../legal/types';
import { DISCIPLINE_CONFIG, IA_CONFIG, IA_SEVERITIES, type DisciplineConfig, type IaConfig, type IaRule, type IaSeverity } from './data';
import type { DisciplineAction, IaCase, IaFinding, IaStatement, IaStatementOption, IaTrigger } from './types';

export type { IaStatement, IaStatementOption, IaTrigger } from './types';

const MAX_ACCOUNT_OPTIONS = 4;

/** The more severe of two severities. */
export function maxSeverity(a: IaSeverity, b: IaSeverity): IaSeverity {
  return IA_SEVERITIES.indexOf(a) >= IA_SEVERITIES.indexOf(b) ? a : b;
}

/** "failureToIntervene" -> "Failure to intervene". */
export function ruleLabel(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function forceEvents(log: IncidentLog): ForceEvent[] {
  return log.events.filter((e): e is ForceEvent => e.kind === 'force');
}

function ownRuling(a: LegalAssessment, eventId: number): ForceRuling | undefined {
  return a.force.find((f) => f.eventId === eventId && !f.other);
}

function triggerFor(rule: IaRule, a: LegalAssessment, log: IncidentLog, complaintRoll: number, trust: number, aggressiveLines: number, injuryOf: (personId: number) => number, cfg: IaConfig): number[] | null {
  switch (rule.when) {
    case 'forceVerdict': {
      const ids = a.force.filter((f) => !f.other && f.verdict === rule.verdict).map((f) => f.eventId);
      return ids.length >= rule.minCount ? ids : null;
    }
    case 'forceTool': {
      const ids = forceEvents(log).filter((e) => e.level === rule.level && e.hit).map((e) => e.id);
      return ids.length >= rule.minCount ? ids : null;
    }
    case 'doctrine': {
      const hits = a.determinations.filter((d) => d.doctrine === rule.doctrine && d.outcome === rule.outcome);
      if (hits.length < rule.minCount) return null;
      const ids: number[] = [];
      for (const d of hits) for (const id of d.eventIds) if (!ids.includes(id)) ids.push(id);
      return ids;
    }
    case 'injury': {
      const arrestedAt = new Map<number, number>();
      const ids: number[] = [];
      for (const e of log.events) {
        if (e.kind === 'arrest') {
          if (!arrestedAt.has(e.personId)) arrestedAt.set(e.personId, e.id);
        } else if (e.kind === 'force' && arrestedAt.has(e.personId) && e.hit && e.injury > 0) {
          // An application that hurt the person counts with the injury the person carries in total.
          if (Math.max(e.injury, injuryOf(e.personId)) >= rule.minInjury) ids.push(e.id);
        }
      }
      return ids.length >= rule.minCount ? ids : null;
    }
    case 'complaint':
      return complaintRoll < complaintChance(cfg, trust, aggressiveLines) ? [] : null;
  }
}

/** The probability of a complaint against the officer for an incident. */
export function complaintChance(cfg: IaConfig, trust: number, aggressiveLines: number): number {
  const c = cfg.complaint;
  return Math.min(c.max, Math.max(0, c.base + c.perAggressiveLine * aggressiveLines + Math.max(0, 0.5 - trust) * c.lowTrust));
}

/**
 * One trigger per matching IA rule (design 10.2). `complaintRoll` is the single uniform draw of the incident: a
 * complaint fires when it is below `complaintChance`. `injuryOf` reads a person's total injury.
 */
export function iaTriggers(
  a: LegalAssessment, log: IncidentLog, rules: IaConfig, complaintRoll: number, trust: number, aggressiveLines: number,
  injuryOf: (personId: number) => number,
): IaTrigger[] {
  const out: IaTrigger[] = [];
  for (const rule of rules.rules) {
    const ids = triggerFor(rule, a, log, complaintRoll, trust, aggressiveLines, injuryOf, rules);
    if (ids) out.push({ rule: rule.id, severity: rule.severity, eventIds: ids });
  }
  return out;
}

function words(tool: string): string {
  if (tool === 'none' || tool === 'hands') return 'hands';
  return tool.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * The statements the officer can give: for up to two non-presence force events of the case, "When I used the <tool>,
 * <person> was <level>" for the true resistance and the next higher one; plus acknowledging the violation and
 * having nothing to add.
 */
export function iaStatementOptions(c: IaCase, log: IncidentLog): IaStatementOption[] {
  const out: IaStatementOption[] = [];
  const ids = new Set<number>();
  for (const t of c.triggers) for (const id of t.eventIds) ids.add(id);
  const events = forceEvents(log).filter((e) => ids.has(e.id) && e.level !== 'presence');
  for (const e of events) {
    if (out.length >= MAX_ACCOUNT_OPTIONS) break;
    const who = log.people.find((p) => p.personId === e.personId)?.label ?? 'the subject';
    const rank = RESISTANCE_LEVELS.indexOf(e.resistance);
    for (const r of [e.resistance, RESISTANCE_LEVELS[rank + 1]]) {
      if (r === undefined || out.length >= MAX_ACCOUNT_OPTIONS) continue;
      out.push({
        text: `When I used the ${words(e.tool)}, ${who} was ${r}.`,
        statement: { kind: 'account', claims: [{ eventId: e.id, resistance: r }] },
      });
    }
  }
  out.push({ text: 'I acknowledge the policy violation.', statement: { kind: 'acknowledge' } });
  out.push({ text: 'I have nothing to add.', statement: { kind: 'none' } });
  return out;
}

function recordedOnCamera(log: IncidentLog, eventId: number): boolean {
  const e = log.events.find((x) => x.id === eventId);
  return e !== undefined && (e.cam & CAM.body) !== 0 && (e.cam & CAM.muted) === 0;
}

/** Is this trigger backing a policy violation? */
function violates(t: IaTrigger, rule: IaRule | undefined, a: LegalAssessment): boolean {
  if (!rule) return false;
  switch (rule.when) {
    case 'forceVerdict':
    case 'forceTool':
      return t.eventIds.some((id) => ownRuling(a, id)?.verdict === 'excessive');
    case 'doctrine':
      return rule.outcome === 'unlawful';
    case 'injury':
      return t.eventIds.some((id) => {
        const r = ownRuling(a, id);
        return r !== undefined && r.verdict !== 'justified';
      });
    case 'complaint':
      return false;
  }
}

/**
 * Judges an IA case (design 10.2). Untruthfulness (an account claim about an on-camera force event that differs from the
 * log) sustains the case outright. Otherwise: a complaint alone with a clean assessment is unfounded; no violation is
 * exonerated; a violation the bodycam did not record (not critical, no acknowledgement) is not sustained; the rest is
 * sustained.
 */
export function resolveIa(
  c: IaCase, a: LegalAssessment, log: IncidentLog, statement: IaStatement, rules: IaConfig = IA_CONFIG,
): { finding: IaFinding; untruthful: boolean; reasons: string[]; severity: IaSeverity | null } {
  const reasons: string[] = [];
  let untruthful = false;
  if (statement.kind === 'account') {
    for (const claim of statement.claims) {
      const e = log.events.find((x) => x.id === claim.eventId);
      if (e && e.kind === 'force' && recordedOnCamera(log, e.id) && e.resistance !== claim.resistance) untruthful = true;
    }
  }
  if (untruthful) {
    return { finding: 'sustained', untruthful, reasons: ['untruthfulness', 'The statement contradicts the bodycam recording.'], severity: null };
  }

  const ruleOf = (id: string): IaRule | undefined => rules.rules.find((r) => r.id === id);
  const only = c.triggers.length === 1 ? c.triggers[0] : undefined;
  if (only && ruleOf(only.rule)?.when === 'complaint' && a.summary.unlawful + a.summary.excessiveForce + a.summary.questionableForce === 0) {
    return { finding: 'unfounded', untruthful, reasons: ['The complaint is not supported by the record.'], severity: null };
  }
  const violating = c.triggers.filter((t) => violates(t, ruleOf(t.rule), a));
  if (violating.length === 0) {
    const lethal = c.triggers.some((t) => ruleOf(t.rule)?.when === 'forceTool');
    reasons.push(lethal ? 'The use of deadly force was within policy.' : 'No policy violation was found.');
    return { finding: 'exonerated', untruthful, reasons, severity: null };
  }
  // The log itself proves a recording violation (the camera was off), so it needs no footage; every other violation does.
  const recorded = violating.some((t) => {
    const rule = ruleOf(t.rule);
    if (rule?.when === 'doctrine' && rule.doctrine === 'recording') return true;
    return t.eventIds.some((id) => (log.events.find((x) => x.id === id)?.cam ?? 0) & CAM.body);
  });
  if (!recorded && c.severity !== 'critical' && statement.kind !== 'acknowledge') {
    return { finding: 'notSustained', untruthful, reasons: ['A violation could not be proven: no body camera footage.'], severity: null };
  }
  for (const t of violating) reasons.push(`${ruleLabel(t.rule)} is a policy violation.`);
  if (statement.kind === 'acknowledge') reasons.push('The officer acknowledged the violation.');
  // Discipline is judged by the violations found, not by the most serious thing the case was opened for.
  const severity = violating.reduce<IaSeverity>((m, t) => maxSeverity(m, t.severity), violating[0]?.severity ?? 'minor');
  return { finding: 'sustained', untruthful, reasons, severity };
}

/** Rounds a currency amount to thousands. */
function thousands(v: number): number {
  return Math.round(v / 1000) * 1000;
}

/**
 * Discipline for a finding (design 10.2): only a sustained finding is punished. The ladder entry is chosen by prior
 * sustained cases (the caller applies the acknowledgement mitigation), plus a civil suit for serious injury, plus
 * criminal charges and termination for a death or a serious firearm injury. `caseId` and `game` are filled by the caller.
 */
export function disciplineFor(
  finding: IaFinding, severity: IaSeverity, priorSustained: number, maxInjury: number, fatal: boolean, firearm: boolean,
  cfg: DisciplineConfig = DISCIPLINE_CONFIG,
): DisciplineAction[] {
  if (finding !== 'sustained') return [];
  const out: DisciplineAction[] = [];
  const action = (a: DisciplineAction['action'], hours = 0, amount = 0): void => {
    out.push({ action: a, hours, amount, caseId: '', game: 0 });
  };
  const ladder = cfg.ladder[severity];
  const step = ladder[Math.min(Math.max(0, priorSustained), ladder.length - 1)];
  if (step) action(step.action, step.hours);
  if (maxInjury >= cfg.civilSuit.minInjury) action('civilSuit', 0, thousands(cfg.civilSuit.base + cfg.civilSuit.perInjury * maxInjury));
  const criminal = (cfg.criminal.fatal && fatal) || (firearm && maxInjury >= cfg.criminal.firearmMinInjury);
  if (criminal) {
    action('criminalCharges');
    if (!out.some((d) => d.action === 'termination')) action('termination');
  }
  return out;
}
