/** Saved tactical state (design §7.6). */
import type { RngState } from '../core/rng';
import { isPartnerMode, type PartnerSave } from './partner';
import { SOUND_KINDS, type SoundKind } from './sound';
import type { TacticalRequest } from './types';

export interface PendingSoundSave {
  kind: SoundKind;
  x: number;
  z: number;
  building: number;
  level: number;
}

export interface TacticalSave {
  version: 1;
  rng: RngState;
  crouched: boolean;
  lean: -1 | 0 | 1;
  leanAmount: number;
  flashlight: boolean;
  footTimer: number;
  noticeTimer: number;
  noise: number;
  partner: PartnerSave;
  queue: TacticalRequest[];
  pendingSounds: PendingSoundSave[];
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isSoundKind = (x: unknown): x is SoundKind => typeof x === 'string' && (SOUND_KINDS as readonly string[]).includes(x);
const COMMANDS = ['follow', 'stack', 'hold', 'clear', 'dismiss', 'summon'];

function isRngState(x: unknown): x is RngState {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return isNum(o['seed']) && Array.isArray(o['s']) && o['s'].length === 4 && o['s'].every(isNum);
}

function isRequest(x: unknown): x is TacticalRequest {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  switch (o['kind']) {
    case 'crouch':
    case 'flashlight':
      return true;
    case 'partner':
      return typeof o['command'] === 'string' && COMMANDS.includes(o['command']);
    case 'sound':
      return isSoundKind(o['source']) && isNum(o['x']) && isNum(o['z']) && isNum(o['building']) && (o['level'] === undefined || isNum(o['level']));
    default:
      return false;
  }
}

function isPending(x: unknown): x is PendingSoundSave {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return isSoundKind(o['kind']) && isNum(o['x']) && isNum(o['z']) && isNum(o['building']) && isNum(o['level']);
}

function isPartnerSave(x: unknown): x is PartnerSave {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return isPartnerMode(o['mode']) && isNum(o['building']) && isNum(o['x']) && isNum(o['z']) && isNum(o['yaw']) && isNum(o['door']) && isNum(o['room']) && isNum(o['timer']);
}

/** Structural check of a saved tactical state. */
export function isTacticalSave(x: unknown): x is TacticalSave {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o['version'] === 1 &&
    isRngState(o['rng']) &&
    typeof o['crouched'] === 'boolean' &&
    (o['lean'] === -1 || o['lean'] === 0 || o['lean'] === 1) &&
    isNum(o['leanAmount']) &&
    typeof o['flashlight'] === 'boolean' &&
    isNum(o['footTimer']) &&
    isNum(o['noticeTimer']) &&
    isNum(o['noise']) &&
    isPartnerSave(o['partner']) &&
    Array.isArray(o['queue']) &&
    o['queue'].every(isRequest) &&
    Array.isArray(o['pendingSounds']) &&
    o['pendingSounds'].every(isPending)
  );
}

/** A fresh tactical state: standing, light off, the partner away. */
export function defaultTacticalSave(rng: RngState): TacticalSave {
  return {
    version: 1,
    rng,
    crouched: false,
    lean: 0,
    leanAmount: 0,
    flashlight: false,
    footTimer: 0,
    noticeTimer: 0,
    noise: 0,
    partner: { mode: 'away', building: -1, x: 0, z: 0, yaw: 0, door: -1, room: -1, timer: -1 },
    queue: [],
    pendingSounds: [],
  };
}
