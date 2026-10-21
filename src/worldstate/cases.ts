import type { CaseRecord, CaseStatus, OffenderRecord, WorldRequest } from './types';

/** Case register rules (Phase 8 design §6.4). Pure. */

type CaseOpen = Extract<WorldRequest, { kind: 'caseOpen' }>;
type CaseUpdate = Extract<WorldRequest, { kind: 'caseUpdate' }>;

/** 'CS-' + at least four digits: 1 -> 'CS-0001'. */
export function formatCaseId(n: number): string {
  return `CS-${String(n).padStart(4, '0')}`;
}

/** Open and follow-up cases age and can be cleared; cleared and cold cases are done. */
export function isActiveCase(status: CaseStatus): boolean {
  return status === 'open' || status === 'followUp';
}

/** A new open case from a `caseOpen` request. */
export function caseFromRequest(id: string, r: Readonly<CaseOpen>): CaseRecord {
  return {
    id, callId: r.callId, callNumber: r.number, typeId: r.typeId, nature: r.nature, status: 'open', openedGame: r.game,
    lastGame: r.game, shiftsOpen: 0, locationText: r.locationText, x: r.x, z: r.z, suspects: unique(r.suspects),
    witnesses: unique(r.witnesses), evidence: Math.max(0, r.evidence),
  };
}

function unique(ids: readonly number[]): number[] {
  const out: number[] = [];
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/** Applies a `caseUpdate` to `c`; returns true when the status changed. */
export function applyCaseUpdate(c: CaseRecord, r: Readonly<CaseUpdate>): boolean {
  for (const id of r.suspectsAdd ?? []) if (!c.suspects.includes(id)) c.suspects.push(id);
  for (const id of r.witnessesAdd ?? []) if (!c.witnesses.includes(id)) c.witnesses.push(id);
  if (r.evidenceDelta !== undefined) c.evidence = Math.max(0, c.evidence + r.evidenceDelta);
  c.lastGame = r.game;
  if (r.status !== undefined && r.status !== c.status) {
    c.status = r.status;
    return true;
  }
  return false;
}

/** First suspect (case order) who is out of custody, or null. */
export function followUpSuspect(c: Readonly<CaseRecord>, offender: (personId: number) => OffenderRecord | null): OffenderRecord | null {
  for (const id of c.suspects) {
    const o = offender(id);
    if (o !== null && o.custody !== 'jailed') return o;
  }
  return null;
}
