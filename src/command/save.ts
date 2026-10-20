import type { RngState } from '../core/rng';
import {
  COMMAND_SWAT_COMMANDS,
  NEGOTIATION_OUTCOMES,
  NEGOTIATION_STAGES,
  NEGOTIATION_TONES,
  TRIAGE_TAGS,
  type CommandRequest,
  type NegState,
  type TriageTag,
} from './types';

/** One victim row as saved (vitals are rebuilt from the seed; `injured` is the scene participant's flag). */
export interface CommandSaveVictim {
  personId: number;
  actorId: number;
  role: string;
  injured: boolean;
  tag: TriageTag | null;
  by: string | null;
  correct: boolean | null;
  trapped: boolean;
  contaminated: boolean;
  transported: boolean;
}

/** Persisted state of the command system (design §11.4; `injured`, `loads` and `declinedCall` are additions). */
export interface CommandSave {
  version: 1;
  rng: RngState;
  post: { callId: number; level: string; x: number; z: number; commander: string } | null;
  victims: CommandSaveVictim[];
  assessing: { personId: number; progress: number } | null;
  /** Callsign, seconds of triage work. */
  emsTimers: [string, number][];
  fireTimer: number;
  /** Seconds until the next automatic ambulance request (absent in older saves: 0). */
  shuttleT?: number;
  /** EMS units loading patients: the reserved person ids and seconds loaded. */
  loads: { callsign: string; personIds: number[]; t: number }[];
  /** Traffic control points as x, z, yaw. */
  tcp: { on: boolean; points: [number, number, number][] };
  evac: { radiusM: number; clearedS: number; buildings: number; x: number; z: number } | null;
  contain: boolean;
  negotiation: (NegState & { open: boolean; subjectPersonId: number }) | null;
  /** Call whose command post the player stood down (no automatic post again), 0 none. */
  declinedCall: number;
  requests: CommandRequest[];
}

/** A fresh state: no post, nothing queued. */
export function emptyCommandSave(rng: RngState): CommandSave {
  return {
    version: 1,
    rng,
    post: null,
    victims: [],
    assessing: null,
    emsTimers: [],
    fireTimer: 0,
    shuttleT: 0,
    loads: [],
    tcp: { on: false, points: [] },
    evac: null,
    contain: false,
    negotiation: null,
    declinedCall: 0,
    requests: [],
  };
}

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

function isRngState(v: unknown): boolean {
  if (!isRecord(v) || !int(v.seed)) return false;
  const s = v.s;
  return Array.isArray(s) && s.length === 4 && s.every((x) => int(x) && x >= 0 && x < 4294967296);
}

function isRequest(v: unknown): boolean {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case 'establish':
      return v.callId === undefined || int(v.callId);
    case 'assess':
    case 'evacuate':
    case 'contain':
    case 'requestNeeds':
    case 'negotiationOpen':
    case 'negotiationClose':
    case 'standDown':
      return true;
    case 'tag':
      return int(v.personId) && oneOf(v.tag, TRIAGE_TAGS);
    case 'tcp':
      return typeof v.on === 'boolean';
    case 'negotiate':
      return str(v.optionId) && oneOf(v.tone, NEGOTIATION_TONES);
    case 'swat':
      return oneOf(v.command, COMMAND_SWAT_COMMANDS) && (v.plan === undefined || isRecord(v.plan));
    default:
      return false;
  }
}

function isVictim(v: unknown): boolean {
  return (
    isRecord(v) && int(v.personId) && int(v.actorId) && str(v.role) && typeof v.injured === 'boolean' &&
    (v.tag === null || oneOf(v.tag, TRIAGE_TAGS)) && (v.by === null || str(v.by)) && (v.correct === null || typeof v.correct === 'boolean') &&
    typeof v.trapped === 'boolean' && typeof v.contaminated === 'boolean' && typeof v.transported === 'boolean'
  );
}

function isNegotiation(v: unknown): boolean {
  return (
    isRecord(v) && num(v.trust) && num(v.agitation) && int(v.turns) && int(v.goodTurns) && oneOf(v.stage, NEGOTIATION_STAGES) &&
    oneOf(v.outcome, NEGOTIATION_OUTCOMES) && str(v.lastReply) && Array.isArray(v.history) && v.history.every(str) &&
    typeof v.open === 'boolean' && int(v.subjectPersonId)
  );
}

/** Is `x` shaped like a `CommandSave`? */
export function isCommandSave(x: unknown): x is CommandSave {
  if (!isRecord(x) || x.version !== 1) return false;
  const p = x.post;
  const a = x.assessing;
  const t = x.tcp;
  const e = x.evac;
  return (
    isRngState(x.rng) &&
    (p === null || (isRecord(p) && int(p.callId) && str(p.level) && num(p.x) && num(p.z) && str(p.commander))) &&
    Array.isArray(x.victims) && x.victims.every(isVictim) &&
    (a === null || (isRecord(a) && int(a.personId) && num(a.progress))) &&
    Array.isArray(x.emsTimers) && x.emsTimers.every((r) => Array.isArray(r) && r.length === 2 && str(r[0]) && num(r[1])) &&
    num(x.fireTimer) && (x.shuttleT === undefined || num(x.shuttleT)) &&
    Array.isArray(x.loads) && x.loads.every((l) => isRecord(l) && str(l.callsign) && Array.isArray(l.personIds) && l.personIds.every(int) && num(l.t)) &&
    isRecord(t) && typeof t.on === 'boolean' && Array.isArray(t.points) && t.points.every((q) => Array.isArray(q) && q.length === 3 && q.every(num)) &&
    (e === null || (isRecord(e) && num(e.radiusM) && num(e.clearedS) && int(e.buildings) && num(e.x) && num(e.z))) &&
    typeof x.contain === 'boolean' &&
    (x.negotiation === null || isNegotiation(x.negotiation)) &&
    int(x.declinedCall) &&
    Array.isArray(x.requests) && x.requests.every(isRequest)
  );
}
