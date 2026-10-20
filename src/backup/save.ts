/** Saved backup state (design §9.6). */
import type { RngState } from '../core/rng';
import type { SwatSave } from './swat';
import {
  BACKUP_COMMANDS,
  BACKUP_ROLES,
  BACKUP_STATES,
  POST_KINDS,
  SWAT_COMMANDS,
  SWAT_PHASES,
  type BackupRequest,
  type BackupRole,
  type BackupState,
  type PostKind,
} from './types';

export interface BackupPostSave {
  id: string;
  x: number;
  z: number;
  yaw: number;
  kind: PostKind;
}

export interface BackupOfficerSave {
  callsign: string;
  callId: number;
  fsm: { state: BackupState; role: BackupRole; timer: number };
  x: number;
  z: number;
  yaw: number;
  building: number;
  seq: number;
  /** lateCallout, poorPosition, excessiveForce. */
  mistakes: [boolean, boolean, boolean];
  targetActor: number;
  post: BackupPostSave | null;
  sideSign: 1 | -1;
  /** Sim time of the next observation scan. */
  nextCallout: number;
  /** Callout and stress memory: actor id, kind, sim time. */
  calledOut: [number, string, number][];
  flags: number;
  /** Runtime state saved so a load continues exactly (optional: older or hand-made saves recompute it). */
  rt?: {
    /** Goal x, z, yaw. */
    goal: [number, number, number];
    /** goalT, cmdT, cuffT, detainT, farT. */
    timers: [number, number, number, number, number];
    cmdIdx: number;
    threat: boolean;
    /** Cover reference: player x, z and subject x, z; null without a cover target. */
    cover: [number, number, number, number] | null;
  };
}

export interface PendingCalloutSave {
  callsign: string;
  kind: string;
  text: string;
  dueSim: number;
  priority: boolean;
  /** Delayed by the lateCallout mistake (absent = false). */
  late?: boolean;
}

export interface BackupSave {
  version: 1;
  rng: RngState;
  officers: BackupOfficerSave[];
  pendingCallouts: PendingCalloutSave[];
  swat: SwatSave | null;
  requests: BackupRequest[];
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => isNum(x) && Number.isInteger(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const oneOf = (list: readonly string[], x: unknown): boolean => typeof x === 'string' && list.includes(x);

function isRng(x: unknown): x is RngState {
  return isObj(x) && isNum(x['seed']) && Array.isArray(x['s']) && x['s'].length === 4 && x['s'].every(isNum);
}

function isPost(x: unknown): boolean {
  return isObj(x) && isStr(x['id']) && isNum(x['x']) && isNum(x['z']) && isNum(x['yaw']) && oneOf(POST_KINDS, x['kind']);
}

const isNums = (x: unknown, n: number): boolean => Array.isArray(x) && x.length === n && x.every(isNum);

function isRuntime(x: unknown): boolean {
  return isObj(x) && isNums(x['goal'], 3) && isNums(x['timers'], 5) && isInt(x['cmdIdx']) && typeof x['threat'] === 'boolean' && (x['cover'] === null || isNums(x['cover'], 4));
}

function isOfficer(x: unknown): boolean {
  if (!isObj(x)) return false;
  const f = x['fsm'];
  const m = x['mistakes'];
  const c = x['calledOut'];
  return (
    isStr(x['callsign']) && x['callsign'] !== '' && isInt(x['callId']) &&
    isObj(f) && oneOf(BACKUP_STATES, f['state']) && oneOf(BACKUP_ROLES, f['role']) && isNum(f['timer']) &&
    isNum(x['x']) && isNum(x['z']) && isNum(x['yaw']) && isInt(x['building']) && isInt(x['seq']) &&
    Array.isArray(m) && m.length === 3 && m.every((b) => typeof b === 'boolean') &&
    isInt(x['targetActor']) && (x['post'] === null || isPost(x['post'])) && (x['sideSign'] === 1 || x['sideSign'] === -1) &&
    isNum(x['nextCallout']) && isInt(x['flags']) &&
    Array.isArray(c) && c.every((e) => Array.isArray(e) && e.length === 3 && isInt(e[0]) && isStr(e[1]) && isNum(e[2])) &&
    (x['rt'] === undefined || isRuntime(x['rt']))
  );
}

function isPending(x: unknown): boolean {
  return isObj(x) && isStr(x['callsign']) && isStr(x['kind']) && isStr(x['text']) && isNum(x['dueSim']) && typeof x['priority'] === 'boolean' && (x['late'] === undefined || typeof x['late'] === 'boolean');
}

function isPlan(x: unknown): boolean {
  return isObj(x) && (x['entry'] === 'front' || x['entry'] === 'rear') && (x['tempo'] === 'deliberate' || x['tempo'] === 'dynamic') && typeof x['lessLethal'] === 'boolean';
}

function isSwat(x: unknown): boolean {
  if (!isObj(x)) return false;
  const ops = x['ops'];
  return (
    isInt(x['callId']) && oneOf(SWAT_PHASES, x['phase']) && isPlan(x['plan']) && isInt(x['building']) && isInt(x['door']) &&
    Array.isArray(x['rooms']) && x['rooms'].every(isInt) && isInt(x['roomIdx']) && isNum(x['timer']) &&
    Array.isArray(ops) && ops.every((o) => Array.isArray(o) && o.length === 4 && o.every(isNum))
  );
}

function isRequest(x: unknown): boolean {
  if (!isObj(x)) return false;
  switch (x['kind']) {
    case 'command':
      return isStr(x['callsign']) && oneOf(BACKUP_COMMANDS, x['command']) && (x['targetPersonId'] === undefined || isInt(x['targetPersonId']));
    case 'post':
      return isStr(x['id']) && isNum(x['x']) && isNum(x['z']) && isNum(x['yaw']) && oneOf(POST_KINDS, x['postKind']);
    case 'clearPosts':
      return x['postKind'] === undefined || oneOf(POST_KINDS, x['postKind']);
    case 'swat':
      return isInt(x['callId']) && oneOf(SWAT_COMMANDS, x['command']) && (x['plan'] === undefined || isObj(x['plan']));
    default:
      return false;
  }
}

/** Structural check of a saved backup state. */
export function isBackupSave(x: unknown): x is BackupSave {
  if (!isObj(x)) return false;
  return (
    x['version'] === 1 &&
    isRng(x['rng']) &&
    Array.isArray(x['officers']) && x['officers'].every(isOfficer) &&
    Array.isArray(x['pendingCallouts']) && x['pendingCallouts'].every(isPending) &&
    (x['swat'] === null || isSwat(x['swat'])) &&
    Array.isArray(x['requests']) && x['requests'].every(isRequest)
  );
}

/** A fresh backup state: nobody on foot. */
export function emptyBackupSave(rng: RngState): BackupSave {
  return { version: 1, rng, officers: [], pendingCallouts: [], swat: null, requests: [] };
}
