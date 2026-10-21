import type { RngState } from '../core/rng';
import { IA_SEVERITIES } from './data';
import { newTrustState } from './trust';
import {
  DISCIPLINE_ACTIONS, DUTY_STATUSES, IA_FINDINGS,
  type CareerStats, type Commendation, type ConductRequest, type DisciplineAction, type DutyStatus, type IaCase, type ReportGrade,
} from './types';

/** Persisted conduct state (design 10.3). */
export interface ConductSave {
  version: 1;
  rng: RngState;
  trust: Record<string, number>;
  /** Trust at the last game midnight (trend baseline). */
  trustDayAgo: Record<string, number>;
  /** Game second of the last per-minute step, -1 before the first step. */
  lastDriftGame: number;
  status: DutyStatus;
  /** Game second a suspension ends; -1 when not applicable. */
  statusUntilGame: number;
  statusReason: string;
  points: number;
  credibility: number;
  commendations: Commendation[];
  discipline: DisciplineAction[];
  ia: IaCase[];
  nextIa: number;
  reports: ReportGrade[];
  stats: CareerStats;
  queue: ConductRequest[];
}

export const EMPTY_STATS: Readonly<CareerStats> = {
  incidents: 0, arrests: 0, lawfulArrests: 0, excessiveForce: 0, convictions: 0, dismissals: 0, reportsFiled: 0, avgReport: 0,
};

/** A fresh career: baseline trust, active duty, credibility 0.85. */
export function newConductSave(rng: RngState): ConductSave {
  const trust = newTrustState().values;
  return {
    version: 1,
    rng,
    trust,
    trustDayAgo: { ...trust },
    lastDriftGame: -1,
    status: 'active',
    statusUntilGame: -1,
    statusReason: '',
    points: 0,
    credibility: 0.85,
    commendations: [],
    discipline: [],
    ia: [],
    nextIa: 1,
    reports: [],
    stats: { ...EMPTY_STATS },
    queue: [],
  };
}

// --- Validation --------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function int(v: unknown): v is number {
  return num(v) && Number.isInteger(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

function isRngState(v: unknown): boolean {
  if (!isRecord(v) || !int(v.seed)) return false;
  const s = v.s;
  return Array.isArray(s) && s.length === 4 && s.every((x) => int(x) && x >= 0 && x < 4294967296);
}

function isNumberRecord(v: unknown): v is Record<string, number> {
  return isRecord(v) && Object.values(v).every(num);
}

function oneOf(v: unknown, list: readonly string[]): boolean {
  return typeof v === 'string' && list.includes(v);
}

function isTrigger(v: unknown): boolean {
  return isRecord(v) && str(v.rule) && oneOf(v.severity, IA_SEVERITIES) && Array.isArray(v.eventIds) && v.eventIds.every(int);
}

function isStatement(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (v.kind === 'acknowledge' || v.kind === 'none') return true;
  return v.kind === 'account' && Array.isArray(v.claims) && v.claims.every((c) => isRecord(c) && int(c.eventId) && str(c.resistance));
}

function isDiscipline(v: unknown): boolean {
  return isRecord(v) && oneOf(v.action, DISCIPLINE_ACTIONS) && num(v.hours) && num(v.amount) && str(v.caseId) && num(v.game);
}

function isCase(v: unknown): boolean {
  return (
    isRecord(v) && str(v.id) && str(v.key) && num(v.openedGame) && Array.isArray(v.triggers) && v.triggers.every(isTrigger) &&
    oneOf(v.severity, IA_SEVERITIES) && (v.status === 'open' || v.status === 'closed') &&
    (v.statement === null || isStatement(v.statement)) && (v.finding === null || oneOf(v.finding, IA_FINDINGS)) &&
    typeof v.untruthful === 'boolean' && Array.isArray(v.discipline) && v.discipline.every(isDiscipline) && num(v.closedGame)
  );
}

function isCommendation(v: unknown): boolean {
  return isRecord(v) && str(v.id) && str(v.label) && str(v.key) && num(v.game) && num(v.points);
}

function isGrade(v: unknown): boolean {
  return (
    isRecord(v) && str(v.docId) && str(v.key) && num(v.score) && oneOf(v.letter, ['A', 'B', 'C', 'D', 'F']) && num(v.completeness) &&
    Array.isArray(v.missing) && v.missing.every(str) &&
    Array.isArray(v.contradictions) && v.contradictions.every((c) => isRecord(c) && str(c.text) && typeof c.onCamera === 'boolean') &&
    Array.isArray(v.unsupported) && v.unsupported.every(str) && num(v.game)
  );
}

function isStats(v: unknown): boolean {
  return isRecord(v) && (Object.keys(EMPTY_STATS) as (keyof CareerStats)[]).every((k) => num(v[k]));
}

function isRequest(v: unknown): boolean {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case 'incidentClosed':
      return str(v.key) && num(v.aggressiveLines);
    case 'report':
      return str(v.key) && str(v.docId) && Array.isArray(v.assertions) && v.assertions.every(str);
    case 'iaStatement':
      return str(v.caseId) && isStatement(v.statement);
    case 'verdict':
      return str(v.key) && str(v.caseId) && str(v.verdict) && str(v.reason) && num(v.credibilityDelta) &&
        typeof v.impeached === 'boolean' && typeof v.missed === 'boolean';
    case 'trust':
      return str(v.district) && num(v.delta) && str(v.reason);
    case 'reinstate':
      return true;
    case 'points':
      return num(v.delta) && str(v.reason) && str(v.key);
    default:
      return false;
  }
}

/** Is `x` shaped like a `ConductSave`? */
export function isConductSave(x: unknown): x is ConductSave {
  return (
    isRecord(x) && x.version === 1 && isRngState(x.rng) && isNumberRecord(x.trust) && isNumberRecord(x.trustDayAgo) &&
    num(x.lastDriftGame) && oneOf(x.status, DUTY_STATUSES) && num(x.statusUntilGame) && str(x.statusReason) && num(x.points) &&
    num(x.credibility) && Array.isArray(x.commendations) && x.commendations.every(isCommendation) &&
    Array.isArray(x.discipline) && x.discipline.every(isDiscipline) && Array.isArray(x.ia) && x.ia.every(isCase) &&
    int(x.nextIa) && Array.isArray(x.reports) && x.reports.every(isGrade) && isStats(x.stats) &&
    Array.isArray(x.queue) && x.queue.every(isRequest)
  );
}
