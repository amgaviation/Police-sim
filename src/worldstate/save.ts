import type { RngState } from '../core/rng';
import { CRIME_DISTRICTS } from '../environment/crime';
import { WORLD_CONFIG } from './data';
import { premiseKey } from './premises';
import {
  CASE_STATUSES, OFFENDER_CUSTODY, OFFENSE_CLASSES, PREMISE_FLAGS, VERDICTS,
  type CaseRecord, type NeighborhoodState, type OffenderRecord, type PremiseRecord, type WitnessRecord, type WorldRequest,
} from './types';

/** Persisted world state (Phase 8 design §6.2). */

export interface WorldStateSave {
  version: 1;
  rng: RngState;
  lastEvolveGame: number;
  nextCase: number;
  premises: PremiseRecord[];
  cases: CaseRecord[];
  offenders: OffenderRecord[];
  witnesses: WitnessRecord[];
  neighborhoods: Record<string, NeighborhoodState>;
  /** `[callId, personId]` pairs. */
  bias: [number, number][];
  /** At most `MAX_NEWS`, oldest first. */
  news: { game: number; text: string }[];
  queue: WorldRequest[];
}

/** Longest news log. */
export const MAX_NEWS = 30;
/** Longest bias list (designated suspects waiting for their call). */
export const MAX_BIAS = 64;

/** A fresh world: every district at its base crime level, nothing remembered. */
export function newWorldStateSave(
  rng: RngState, baseCrime: Readonly<Record<string, number>> = WORLD_CONFIG.neighborhoods.baseCrime,
): WorldStateSave {
  const neighborhoods: Record<string, NeighborhoodState> = {};
  for (const d of CRIME_DISTRICTS) neighborhoods[d] = { crime: baseCrime[d] ?? 0, trend: 0, history: [] };
  return {
    version: 1, rng: { seed: rng.seed, s: [...rng.s] }, lastEvolveGame: 0, nextCase: 1, premises: [], cases: [], offenders: [],
    witnesses: [], neighborhoods, bias: [], news: [], queue: [],
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

function bool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function oneOf(v: unknown, list: readonly string[]): boolean {
  return typeof v === 'string' && list.includes(v);
}

function ints(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(int);
}

function isRngState(v: unknown): boolean {
  if (!isRecord(v) || !int(v.seed)) return false;
  const s = v.s;
  return Array.isArray(s) && s.length === 4 && s.every((x) => int(x) && x >= 0 && x < 4294967296);
}

function isFlags(v: unknown): boolean {
  return Array.isArray(v) && v.every((f) => oneOf(f, PREMISE_FLAGS));
}

function isEntry(v: unknown): boolean {
  return (
    isRecord(v) && num(v.game) && str(v.callNumber) && str(v.typeId) && str(v.nature) && str(v.disposition) && isFlags(v.flags)
  );
}

function isPremise(v: unknown): boolean {
  return (
    isRecord(v) && str(v.key) && str(v.text) && v.key === premiseKey(v.text) && num(v.x) && num(v.z) && int(v.edge) &&
    str(v.district) && Array.isArray(v.entries) && v.entries.length <= WORLD_CONFIG.premises.entriesPerPremise && v.entries.every(isEntry)
  );
}

function isCase(v: unknown): boolean {
  return (
    isRecord(v) && str(v.id) && /^CS-\d{4,}$/.test(v.id) && int(v.callId) && str(v.callNumber) && str(v.typeId) && str(v.nature) &&
    oneOf(v.status, CASE_STATUSES) && num(v.openedGame) && num(v.lastGame) && int(v.shiftsOpen) && v.shiftsOpen >= 0 &&
    str(v.locationText) && num(v.x) && num(v.z) && ints(v.suspects) && ints(v.witnesses) && int(v.evidence) && v.evidence >= 0
  );
}

function isOffender(v: unknown): boolean {
  return (
    isRecord(v) && int(v.personId) && int(v.arrests) && v.arrests >= 0 && num(v.lastArrestGame) && oneOf(v.custody, OFFENDER_CUSTODY) &&
    num(v.releaseGame) && num(v.risk) && v.risk >= 0 && v.risk <= 1 && str(v.district) && str(v.lastCallNumber) && num(v.x) &&
    num(v.z) && bool(v.juvenile) && oneOf(v.offenseClass, OFFENSE_CLASSES) && bool(v.convicted)
  );
}

function isWitness(v: unknown): boolean {
  return isRecord(v) && int(v.personId) && str(v.caseId) && str(v.addressText) && num(v.movedGame);
}

function isNeighborhood(v: unknown): boolean {
  return isRecord(v) && num(v.crime) && v.crime >= 0 && v.crime <= 1 && num(v.trend) && Array.isArray(v.history) && v.history.every(num);
}

function isCallInfo(v: unknown): boolean {
  return (
    isRecord(v) && int(v.callId) && str(v.number) && str(v.typeId) && str(v.nature) && str(v.category) && num(v.x) && num(v.z) &&
    int(v.edge) && str(v.text) && str(v.district) && str(v.disposition) && isFlags(v.flags) && ints(v.persons) && num(v.game)
  );
}

/** Is `x` a well-formed queued world request? */
export function isWorldRequest(x: unknown): x is WorldRequest {
  if (!isRecord(x)) return false;
  switch (x.kind) {
    case 'callClosed':
      return isCallInfo(x.call);
    case 'arrest':
      return (
        int(x.personId) && str(x.district) && str(x.callNumber) && num(x.x) && num(x.z) && num(x.game) &&
        oneOf(x.offenseClass, OFFENSE_CLASSES) && bool(x.juvenile) && int(x.priors) && x.priors >= 0
      );
    case 'verdict':
      return int(x.personId) && oneOf(x.verdict, VERDICTS) && num(x.game);
    case 'caseOpen':
      return (
        int(x.callId) && str(x.number) && str(x.typeId) && str(x.nature) && num(x.game) && str(x.locationText) && num(x.x) &&
        num(x.z) && ints(x.suspects) && ints(x.witnesses) && int(x.evidence)
      );
    case 'caseUpdate':
      return (
        int(x.callId) && num(x.game) && (x.suspectsAdd === undefined || ints(x.suspectsAdd)) &&
        (x.witnessesAdd === undefined || ints(x.witnessesAdd)) && (x.evidenceDelta === undefined || int(x.evidenceDelta)) &&
        (x.status === undefined || oneOf(x.status, CASE_STATUSES))
      );
    case 'witness':
      return int(x.personId) && int(x.callId) && str(x.addressText);
    default:
      return false;
  }
}

function allUnique(list: readonly unknown[], key: (item: never) => unknown): boolean {
  const seen = new Set<unknown>();
  for (const item of list) {
    const k = key(item as never);
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

/** Full structural validation of a `WorldStateSave` (every field, enum, bound and uniqueness rule). */
export function isWorldStateSave(x: unknown): x is WorldStateSave {
  if (!isRecord(x) || x.version !== 1 || !isRngState(x.rng) || !num(x.lastEvolveGame) || !int(x.nextCase) || x.nextCase < 1) return false;
  const c = WORLD_CONFIG;
  if (!Array.isArray(x.premises) || x.premises.length > c.premises.max || !x.premises.every(isPremise)) return false;
  if (!allUnique(x.premises, (p: PremiseRecord) => p.key)) return false;
  if (!Array.isArray(x.cases) || x.cases.length > c.cases.max || !x.cases.every(isCase)) return false;
  if (!allUnique(x.cases, (k: CaseRecord) => k.id) || !allUnique(x.cases, (k: CaseRecord) => k.callId)) return false;
  if (!Array.isArray(x.offenders) || x.offenders.length > c.offenders.max || !x.offenders.every(isOffender)) return false;
  if (!allUnique(x.offenders, (o: OffenderRecord) => o.personId)) return false;
  if (!Array.isArray(x.witnesses) || x.witnesses.length > c.witnesses.max || !x.witnesses.every(isWitness)) return false;
  if (!allUnique(x.witnesses, (w: WitnessRecord) => w.personId)) return false;
  if (!isRecord(x.neighborhoods) || !Object.values(x.neighborhoods).every(isNeighborhood)) return false;
  if (
    !Array.isArray(x.bias) || x.bias.length > MAX_BIAS ||
    !x.bias.every((b) => Array.isArray(b) && b.length === 2 && int(b[0]) && int(b[1]))
  ) {
    return false;
  }
  if (!Array.isArray(x.news) || x.news.length > MAX_NEWS || !x.news.every((n) => isRecord(n) && num(n.game) && str(n.text))) return false;
  return Array.isArray(x.queue) && x.queue.every(isWorldRequest);
}
