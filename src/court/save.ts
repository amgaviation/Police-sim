import type { RngState } from '../core/rng';
import { ANSWERS, CASE_STATUSES, QUESTION_KINDS, VERDICTS, type CourtCase, type CourtRequest } from './types';

/** Most cases kept in a save; the oldest finished ones are dropped first. */
export const MAX_CASES = 60;

/** Persisted court state (design 11.3). */
export interface CourtSave {
  version: 1;
  rng: RngState;
  nextId: number;
  /** Newest first. */
  cases: CourtCase[];
  /** Game minute of the last per-minute step, -1 before the first step. */
  lastMinute: number;
  queue: CourtRequest[];
}

/** A fresh career: no cases. */
export function emptyCourtSave(rng: RngState): CourtSave {
  return { version: 1, rng, nextId: 1, cases: [], lastMinute: -1, queue: [] };
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

function oneOf(v: unknown, list: readonly string[]): boolean {
  return typeof v === 'string' && list.includes(v);
}

function strings(v: unknown): boolean {
  return Array.isArray(v) && v.every(str);
}

function isRngState(v: unknown): boolean {
  if (!isRecord(v) || !int(v.seed)) return false;
  const s = v.s;
  return Array.isArray(s) && s.length === 4 && s.every((x) => int(x) && x >= 0 && x < 4294967296);
}

function isYesNo(v: unknown): boolean {
  return v === 'yes' || v === 'no';
}

function isQuestion(v: unknown): boolean {
  return (
    isRecord(v) && str(v.id) && oneOf(v.kind, QUESTION_KINDS) && str(v.text) && isYesNo(v.truth) &&
    (v.reportSays === null || isYesNo(v.reportSays)) && int(v.eventId) && typeof v.onCamera === 'boolean' && num(v.weight) &&
    (v.pairOf === null || str(v.pairOf))
  );
}

function isMotion(v: unknown): boolean {
  return isRecord(v) && str(v.text) && typeof v.granted === 'boolean' && strings(v.ruleIds) && typeof v.dismissesCase === 'boolean';
}

function isTestimony(v: unknown): boolean {
  return (
    isRecord(v) && num(v.credibilityDelta) && num(v.score) && int(v.consistent) && int(v.impeached) && int(v.contradictions) &&
    int(v.evasive) && int(v.selfInconsistent) && int(v.reportMismatches) && strings(v.notes)
  );
}

function isCase(v: unknown): boolean {
  return (
    isRecord(v) && str(v.id) && str(v.docId) && (v.docKind === 'booking' || v.docKind === 'citation') && int(v.personId) &&
    str(v.personLabel) && str(v.key) && int(v.callId) && strings(v.statutes) && strings(v.offenses) && num(v.createdGame) &&
    num(v.hearingGame) && oneOf(v.status, CASE_STATUSES) && Array.isArray(v.questions) && v.questions.every(isQuestion) &&
    Array.isArray(v.motions) && v.motions.every(isMotion) && (v.verdict === null || oneOf(v.verdict, VERDICTS)) && str(v.reason) &&
    (v.testimony === null || isTestimony(v.testimony)) && typeof v.reminded === 'boolean'
  );
}

function isRequest(v: unknown): boolean {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case 'open':
      return str(v.docId) && (v.docKind === 'booking' || v.docKind === 'citation') && int(v.personId) && str(v.personLabel) &&
        int(v.callId) && strings(v.statutes);
    case 'attend':
    case 'advance':
      return str(v.caseId);
    case 'testify':
      return str(v.caseId) && Array.isArray(v.answers) && v.answers.every((a) => oneOf(a, ANSWERS));
    default:
      return false;
  }
}

/** Is `x` shaped like a `CourtSave`? */
export function isCourtSave(x: unknown): x is CourtSave {
  return (
    isRecord(x) && x.version === 1 && isRngState(x.rng) && int(x.nextId) && Array.isArray(x.cases) && x.cases.length <= MAX_CASES &&
    x.cases.every(isCase) && int(x.lastMinute) && Array.isArray(x.queue) && x.queue.every(isRequest)
  );
}
