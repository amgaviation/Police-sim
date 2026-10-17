/** Radio save block (design §9.7, SaveGameV4.radio) and its structural validator. */
import type { RngState } from '../core/rng';
import { isOneOf } from '../cad/guards';
import { REQUEST_VIAS } from '../cad/types';
import type { ComposerSave } from './compose';
import { RADIO_CONFIG, isChannelId } from './data';
import { CHANNEL_IDS, SPEAKER_KINDS, type ChannelId, type QueuedTransmission, type Transmission } from './types';

export interface RadioSave {
  version: 1;
  selected: ChannelId;
  scanning: boolean;
  scanList: ChannelId[];
  log: Transmission[];
  /** Pending transmissions and, with `start >= 0`, those on the air (with their attached request). */
  queue: QueuedTransmission[];
  nextId: number;
  holds: ChannelId[];
  ambientNext: Partial<Record<ChannelId, number>>;
  rng: RngState;
  /** Id of the last dispatcher transmission to the player (`repeat`), -1 none. */
  lastToPlayer: number;
  /** Additions (optional): last step time, player position and composer bookkeeping. */
  time?: { sim: number; game: number };
  player?: { x: number; z: number };
  composer?: ComposerSave;
}

export function defaultRadioSave(rngState: RngState): RadioSave {
  return {
    version: 1,
    selected: RADIO_CONFIG.defaultSelected,
    scanning: false,
    scanList: [...RADIO_CONFIG.defaultScan],
    log: [],
    queue: [],
    nextId: 1,
    holds: [],
    ambientNext: {},
    rng: { seed: rngState.seed, s: [...rngState.s] as unknown as RngState['s'] },
    lastToPlayer: -1,
  };
}

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x);
}

function isStr(x: unknown): x is string {
  return typeof x === 'string';
}

function isBool(x: unknown): x is boolean {
  return typeof x === 'boolean';
}

function isUint32(x: unknown): boolean {
  return isInt(x) && x >= 0 && x < 4294967296;
}

function isRngState(x: unknown): x is RngState {
  return isObj(x) && isUint32(x.seed) && Array.isArray(x.s) && x.s.length === 4 && x.s.every(isUint32);
}

function isChannelList(x: unknown): x is ChannelId[] {
  return Array.isArray(x) && x.every(isChannelId);
}

function isTransmission(x: unknown): x is Transmission {
  return (
    isObj(x) &&
    isInt(x.id) &&
    isChannelId(x.channel) &&
    isStr(x.speaker) &&
    isOneOf(x.speakerKind, SPEAKER_KINDS) &&
    isStr(x.text) &&
    isStr(x.spoken) &&
    isNum(x.start) &&
    isNum(x.duration) &&
    isBool(x.blocked) &&
    isBool(x.priority) &&
    isStr(x.kind) &&
    isStr(x.clock) &&
    isBool(x.audible)
  );
}

/** Structural check of an attached request: a kind plus primitive fields. */
function isRequestLike(x: unknown): boolean {
  if (x === null) return true;
  if (!isObj(x) || !isStr(x.kind)) return false;
  return Object.values(x).every((v) => isStr(v) || isNum(v));
}

function isQueued(x: unknown): x is QueuedTransmission {
  return (
    isObj(x) &&
    isInt(x.id) &&
    isChannelId(x.channel) &&
    isStr(x.speaker) &&
    isOneOf(x.speakerKind, SPEAKER_KINDS) &&
    isStr(x.text) &&
    isStr(x.spoken) &&
    isStr(x.kind) &&
    isBool(x.priority) &&
    isNum(x.duration) &&
    isNum(x.earliest) &&
    isBool(x.waitClear) &&
    isInt(x.follows) &&
    isNum(x.gap) &&
    isStr(x.to) &&
    isBool(x.ambient) &&
    isRequestLike(x.request) &&
    (x.via === null || isOneOf(x.via, REQUEST_VIAS)) &&
    isNum(x.start) &&
    isBool(x.blocked) &&
    isStr(x.clock) &&
    isBool(x.audible)
  );
}

function isPendingList(x: unknown): boolean {
  return Array.isArray(x) && x.every((p) => isObj(p) && isStr(p.kind) && isNum(p.at));
}

function isComposerSave(x: unknown): x is ComposerSave {
  return (
    isObj(x) &&
    isPendingList(x.pending) &&
    isPendingList(x.answered) &&
    isBool(x.expectLocation) &&
    isBool(x.answeringLocation) &&
    isInt(x.pulling)
  );
}

export function isRadioSave(x: unknown): x is RadioSave {
  if (!isObj(x) || x.version !== 1) return false;
  if (!isChannelId(x.selected) || !isBool(x.scanning) || !isChannelList(x.scanList) || !isChannelList(x.holds)) return false;
  if (!Array.isArray(x.log) || !x.log.every(isTransmission)) return false;
  if (!Array.isArray(x.queue) || !x.queue.every(isQueued)) return false;
  if (!isInt(x.nextId) || x.nextId < 1 || !isInt(x.lastToPlayer) || !isRngState(x.rng)) return false;
  if (!isObj(x.ambientNext)) return false;
  for (const [k, v] of Object.entries(x.ambientNext)) if (!(CHANNEL_IDS as readonly string[]).includes(k) || !isNum(v)) return false;
  if (x.time !== undefined && !(isObj(x.time) && isNum(x.time.sim) && isNum(x.time.game))) return false;
  if (x.player !== undefined && !(isObj(x.player) && isNum(x.player.x) && isNum(x.player.z))) return false;
  if (x.composer !== undefined && !isComposerSave(x.composer)) return false;
  return true;
}
