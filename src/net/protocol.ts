/**
 * Co-op wire protocol (Phase 8 §8.1): constants, message types and the validators used by the server (untrusted
 * client input) and by the client (lenient server input). Pure: no DOM, no Node types, no clock, no randomness.
 */

/** Wire protocol version; a hello with another version is rejected with 'version'. */
export const PROTOCOL_VERSION = 1;
export const NET_ROLES = ['patrol', 'dispatcher', 'supervisor'] as const;
export type NetRole = (typeof NET_ROLES)[number];
/** Members per role in one room. */
export const ROLE_LIMITS = { patrol: 4, dispatcher: 1, supervisor: 1 } as const;
/** Equals the cad `UNIT_STATUSES` (checked by a test). */
export const NET_UNIT_STATUSES = ['available', 'enRoute', 'onScene', 'busy', 'outOfService', 'transporting'] as const;
export type NetUnitStatus = (typeof NET_UNIT_STATUSES)[number];
/** Equals the ids of `src/data/cad/dispositions.json` (checked by a test). */
export const NET_DISPOSITIONS = [
  'handled',
  'reportTaken',
  'citationIssued',
  'warningIssued',
  'arrestMade',
  'goneOnArrival',
  'unfounded',
  'referred',
  'cancelled',
  'transported',
  'duplicate',
] as const;
export type NetDisposition = (typeof NET_DISPOSITIONS)[number];
export const ORDER_KINDS = ['respond', 'returnToStation', 'terminatePursuit', 'code4', 'backup'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export const REJECT_CODES = [
  'malformed',
  'version',
  'unknownType',
  'forbidden',
  'notFound',
  'illegalState',
  'invalidValue',
  'rate',
  'full',
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];
export const CALL_ORIGINS = ['dispatcher', 'generator', 'officer'] as const;
export type CallOrigin = (typeof CALL_ORIGINS)[number];
export const RADIO_CHANNELS = ['main', 'tac'] as const;
export type RadioChannel = (typeof RADIO_CHANNELS)[number];
export const LIMITS = {
  messageBytes: 8192,
  name: 24,
  room: 32,
  typeId: 40,
  label: 60,
  address: 80,
  narrative: 280,
  note: 200,
  radio: 160,
  ref: 16,
  worldHalf: 3700,
  maxOpenCalls: 30,
  closedKept: 20,
  notesPerCall: 20,
  maxSpeedMps: 90,
} as const;

export type Priority = 1 | 2 | 3 | 4;

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; role: NetRole; room: string; seed?: number }
  | { t: 'presence'; x: number; z: number; heading: number; speed: number; driving: boolean }
  | { t: 'unitStatus'; status: NetUnitStatus; callId: number | null }
  | {
      t: 'callCreate';
      ref: string;
      typeId: string;
      label: string;
      priority: Priority;
      x: number;
      z: number;
      address: string;
      narrative: string;
      origin: CallOrigin;
    }
  | { t: 'callAssign'; callId: number; unit: string }
  | { t: 'callUnassign'; callId: number; unit: string }
  | { t: 'callPriority'; callId: number; priority: Priority }
  | { t: 'callNote'; callId: number; text: string }
  | { t: 'callClose'; callId: number; disposition: NetDisposition }
  | { t: 'order'; unit: string; order: OrderKind; callId: number | null; text: string }
  | { t: 'partner'; unit: string }
  | { t: 'radio'; channel: RadioChannel; text: string }
  | { t: 'ping'; n: number };

/** One unit in the room (a patrol officer, the dispatcher or the supervisor). */
export interface NetUnit {
  callsign: string;
  role: NetRole;
  name: string;
  status: NetUnitStatus;
  callId: number | null;
  x: number;
  z: number;
  heading: number;
  speed: number;
  driving: boolean;
  partner: string | null;
}
export interface NetNote {
  by: string;
  text: string;
  atMs: number;
}
export interface NetCall {
  id: number;
  ref: string;
  typeId: string;
  label: string;
  priority: Priority;
  x: number;
  z: number;
  address: string;
  narrative: string;
  status: 'pending' | 'active' | 'closed';
  units: string[];
  primary: string | null;
  notes: NetNote[];
  createdBy: string;
  origin: CallOrigin;
  createdAtMs: number;
  disposition: string | null;
}
export interface RoomSnapshot {
  room: string;
  seed: number;
  rev: number;
  host: string;
  units: NetUnit[];
  calls: NetCall[];
}
export type RoomEvent =
  | { k: 'joined'; unit: NetUnit }
  | { k: 'left'; callsign: string }
  | { k: 'host'; callsign: string }
  | { k: 'unitStatus'; callsign: string; status: NetUnitStatus; callId: number | null }
  | { k: 'callCreated'; call: NetCall }
  | { k: 'callAssigned'; callId: number; callsign: string; primary: string | null }
  | { k: 'callUnassigned'; callId: number; callsign: string }
  | { k: 'callPriority'; callId: number; priority: Priority }
  | { k: 'callNote'; callId: number; note: NetNote }
  | { k: 'callClosed'; callId: number; disposition: string }
  | { k: 'order'; to: string; from: string; order: OrderKind; callId: number | null; text: string }
  | { k: 'partnered'; a: string; b: string }
  | { k: 'radio'; from: string; channel: RadioChannel; text: string };
export interface PresenceEntry {
  callsign: string;
  x: number;
  z: number;
  heading: number;
  speed: number;
  driving: boolean;
}
export type ServerMsg =
  | { t: 'welcome'; v: number; callsign: string; role: NetRole; snapshot: RoomSnapshot }
  | { t: 'event'; rev: number; ev: RoomEvent }
  | { t: 'presence'; units: PresenceEntry[] }
  | { t: 'reject'; ref: string; code: RejectCode; reason: string }
  | { t: 'pong'; n: number }
  | { t: 'error'; code: RejectCode; reason: string };

export type ClientParse = { ok: true; msg: ClientMsg } | { ok: false; code: RejectCode; reason: string };

/** Exact UTF-8 byte length of a JS string (lone surrogates count as U+FFFD, 3 bytes, as TextEncoder does). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** True when `s` contains a control character U+0000-U+001F or U+007F. */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Serialise a message for the wire. */
export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

// ---------------------------------------------------------------------------------------------------------------------
// Client message validation
// ---------------------------------------------------------------------------------------------------------------------

type Spec =
  | { k: 'str'; min: number; max: number; re?: RegExp; oneOf?: readonly string[]; opt?: boolean }
  | { k: 'num'; min: number; max: number; int?: boolean; nullable?: boolean; opt?: boolean }
  | { k: 'bool' };

const str = (min: number, max: number): Spec => ({ k: 'str', min, max });
const oneOf = (list: readonly string[]): Spec => ({ k: 'str', min: 1, max: 40, oneOf: list });
const int = (min: number, max: number, nullable = false): Spec => ({ k: 'num', min, max, int: true, nullable });
const pos: Spec = { k: 'num', min: -LIMITS.worldHalf, max: LIMITS.worldHalf };
const callId: Spec = int(1, 2147483647);
const unit: Spec = str(1, LIMITS.ref);
const priority: Spec = int(1, 4);
const TYPE_ID = /^[A-Za-z0-9_]{1,40}$/;

const SPECS: Readonly<Record<ClientMsg['t'], Readonly<Record<string, Spec>>>> = {
  hello: {
    v: int(0, 1000),
    name: str(1, LIMITS.name),
    role: oneOf(NET_ROLES),
    room: str(1, LIMITS.room),
    seed: { k: 'num', min: 0, max: 4294967295, int: true, opt: true },
  },
  presence: {
    x: pos,
    z: pos,
    heading: { k: 'num', min: -1e6, max: 1e6 },
    speed: { k: 'num', min: 0, max: 120 },
    driving: { k: 'bool' },
  },
  unitStatus: { status: oneOf(NET_UNIT_STATUSES), callId: int(1, 2147483647, true) },
  callCreate: {
    ref: str(1, LIMITS.ref),
    typeId: { k: 'str', min: 1, max: LIMITS.typeId, re: TYPE_ID },
    label: str(1, LIMITS.label),
    priority,
    x: pos,
    z: pos,
    address: str(0, LIMITS.address),
    narrative: str(0, LIMITS.narrative),
    origin: oneOf(CALL_ORIGINS),
  },
  callAssign: { callId, unit },
  callUnassign: { callId, unit },
  callPriority: { callId, priority },
  callNote: { callId, text: str(1, LIMITS.note) },
  callClose: { callId, disposition: oneOf(NET_DISPOSITIONS) },
  order: { unit, order: oneOf(ORDER_KINDS), callId: int(1, 2147483647, true), text: str(0, LIMITS.note) },
  partner: { unit },
  radio: { channel: oneOf(RADIO_CHANNELS), text: str(1, LIMITS.radio) },
  ping: { n: int(0, Number.MAX_SAFE_INTEGER) },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shape pass: field present, right primitive type, no unknown fields. Returns a 'malformed' reason or null. */
function shapeError(t: string, o: Record<string, unknown>, spec: Readonly<Record<string, Spec>>): string | null {
  for (const key of Object.keys(o)) {
    if (key !== 't' && !Object.hasOwn(spec, key)) return `${t}: unknown field '${key}'`;
  }
  for (const key of Object.keys(spec)) {
    const s = spec[key] as Spec;
    const v = o[key];
    const absent = !Object.hasOwn(o, key) || v === undefined;
    if (absent) {
      if (s.k !== 'bool' && s.opt) continue;
      return `${t}: missing field '${key}'`;
    }
    if (s.k === 'str' && typeof v !== 'string') return `${t}.${key}: expected a string`;
    if (s.k === 'bool' && typeof v !== 'boolean') return `${t}.${key}: expected a boolean`;
    if (s.k === 'num' && !(typeof v === 'number' || (s.nullable === true && v === null))) {
      return `${t}.${key}: expected a number${s.nullable === true ? ' or null' : ''}`;
    }
  }
  return null;
}

/** Value pass: ranges, lengths, enums, patterns, control characters. Returns an 'invalidValue' reason or null. */
function valueError(t: string, o: Record<string, unknown>, spec: Readonly<Record<string, Spec>>): string | null {
  for (const key of Object.keys(spec)) {
    const s = spec[key] as Spec;
    const v = o[key];
    if (s.k === 'bool' || v === undefined) continue;
    if (s.k === 'num') {
      if (v === null) continue;
      const n = v as number;
      if (!Number.isFinite(n)) return `${t}.${key}: not a finite number`;
      if (s.int === true && !Number.isInteger(n)) return `${t}.${key}: expected an integer`;
      if (n < s.min || n > s.max) return `${t}.${key}: out of range ${s.min}..${s.max}`;
      continue;
    }
    const text = v as string;
    if (text.length < s.min || text.length > s.max) return `${t}.${key}: length must be ${s.min}..${s.max}`;
    if (s.oneOf && !s.oneOf.includes(text)) return `${t}.${key}: '${text.slice(0, 24)}' is not allowed`;
    if (s.re && !s.re.test(text)) return `${t}.${key}: invalid characters`;
    if (hasControlChars(text)) return `${t}.${key}: control characters are not allowed`;
  }
  return null;
}

/** Validate an already-parsed value as a client message (everything `parseClientMsg` does after the JSON step).
 *  The room also runs it on every handled message so a caller cannot bypass the value rules. Never throws. */
export function validateClientMsg(value: unknown): ClientParse {
  if (!isPlainObject(value)) return { ok: false, code: 'malformed', reason: 'message must be a JSON object' };
  const t = value.t;
  if (typeof t !== 'string' || !Object.hasOwn(SPECS, t)) {
    return { ok: false, code: 'unknownType', reason: 'unknown message type' };
  }
  const spec = SPECS[t as ClientMsg['t']];
  if (t === 'hello') {
    if (typeof value.v !== 'number') return { ok: false, code: 'malformed', reason: 'hello: missing version' };
    if (value.v !== PROTOCOL_VERSION) {
      return { ok: false, code: 'version', reason: `protocol version ${PROTOCOL_VERSION} required` };
    }
  }
  const shape = shapeError(t, value, spec);
  if (shape !== null) return { ok: false, code: 'malformed', reason: shape };
  const bad = valueError(t, value, spec);
  if (bad !== null) return { ok: false, code: 'invalidValue', reason: bad };
  return { ok: true, msg: value as unknown as ClientMsg };
}

/** Parse one raw text message from an untrusted client. Check order: size (utf8Length) -> JSON -> known type ->
 *  version -> field types and shape ('malformed') -> ranges, lengths, enums, control characters ('invalidValue').
 *  Text is never rewritten. Never throws. */
export function parseClientMsg(raw: string): ClientParse {
  if (typeof raw !== 'string') return { ok: false, code: 'malformed', reason: 'message must be text' };
  if (utf8Length(raw) > LIMITS.messageBytes) {
    return { ok: false, code: 'malformed', reason: `message larger than ${LIMITS.messageBytes} bytes` };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'malformed', reason: 'invalid JSON' };
  }
  return validateClientMsg(value);
}

// ---------------------------------------------------------------------------------------------------------------------
// Server message parsing (client side, lenient)
// ---------------------------------------------------------------------------------------------------------------------

const MAX_SERVER_BYTES = 1 << 20;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrOrNull = (v: unknown): boolean => v === null || isStr(v);
const isNumOrNull = (v: unknown): boolean => v === null || isNum(v);
const isIn = (list: readonly string[]) => (v: unknown): boolean => isStr(v) && list.includes(v);
const isPriority = (v: unknown): boolean => v === 1 || v === 2 || v === 3 || v === 4;
const isStatus = isIn(NET_UNIT_STATUSES);
const isRole = isIn(NET_ROLES);

function hasFields(o: Record<string, unknown>, checks: Readonly<Record<string, (v: unknown) => boolean>>): boolean {
  for (const key of Object.keys(checks)) {
    if (!(checks[key] as (v: unknown) => boolean)(o[key])) return false;
  }
  return true;
}
const isObj = (check: Readonly<Record<string, (v: unknown) => boolean>>) => (v: unknown): boolean =>
  isPlainObject(v) && hasFields(v, check);

const UNIT_CHECK = {
  callsign: isStr,
  role: isRole,
  name: isStr,
  status: isStatus,
  callId: isNumOrNull,
  x: isNum,
  z: isNum,
  heading: isNum,
  speed: isNum,
  driving: isBool,
  partner: isStrOrNull,
} as const;
const NOTE_CHECK = { by: isStr, text: isStr, atMs: isNum } as const;
const isUnit = isObj(UNIT_CHECK);
const isNote = isObj(NOTE_CHECK);
const isCall = isObj({
  id: isNum,
  ref: isStr,
  typeId: isStr,
  label: isStr,
  priority: isPriority,
  x: isNum,
  z: isNum,
  address: isStr,
  narrative: isStr,
  status: isIn(['pending', 'active', 'closed']),
  units: (v) => Array.isArray(v) && v.every(isStr),
  primary: isStrOrNull,
  notes: (v) => Array.isArray(v) && v.every(isNote),
  createdBy: isStr,
  origin: isIn(CALL_ORIGINS),
  createdAtMs: isNum,
  disposition: isStrOrNull,
});
const isSnapshot = isObj({
  room: isStr,
  seed: isNum,
  rev: isNum,
  host: isStr,
  units: (v) => Array.isArray(v) && v.every(isUnit),
  calls: (v) => Array.isArray(v) && v.every(isCall),
});
const isPresenceEntry = isObj({ callsign: isStr, x: isNum, z: isNum, heading: isNum, speed: isNum, driving: isBool });

const EVENT_CHECKS: Readonly<Record<RoomEvent['k'], Readonly<Record<string, (v: unknown) => boolean>>>> = {
  joined: { unit: isUnit },
  left: { callsign: isStr },
  host: { callsign: isStr },
  unitStatus: { callsign: isStr, status: isStatus, callId: isNumOrNull },
  callCreated: { call: isCall },
  callAssigned: { callId: isNum, callsign: isStr, primary: isStrOrNull },
  callUnassigned: { callId: isNum, callsign: isStr },
  callPriority: { callId: isNum, priority: isPriority },
  callNote: { callId: isNum, note: isNote },
  callClosed: { callId: isNum, disposition: isStr },
  order: { to: isStr, from: isStr, order: isIn(ORDER_KINDS), callId: isNumOrNull, text: isStr },
  partnered: { a: isStr, b: isStr },
  radio: { from: isStr, channel: isIn(RADIO_CHANNELS), text: isStr },
};
const isEvent = (v: unknown): boolean =>
  isPlainObject(v) && isStr(v.k) && Object.hasOwn(EVENT_CHECKS, v.k) && hasFields(v, EVENT_CHECKS[v.k as RoomEvent['k']]);

const SERVER_CHECKS: Readonly<Record<ServerMsg['t'], Readonly<Record<string, (v: unknown) => boolean>>>> = {
  welcome: { v: isNum, callsign: isStr, role: isRole, snapshot: isSnapshot },
  event: { rev: isNum, ev: isEvent },
  presence: { units: (v) => Array.isArray(v) && v.every(isPresenceEntry) },
  reject: { ref: isStr, code: isIn(REJECT_CODES), reason: isStr },
  pong: { n: isNum },
  error: { code: isIn(REJECT_CODES), reason: isStr },
};

/** Parse one raw server message (client side). Lenient: unknown extra fields are ignored; a missing or mistyped
 *  field, an unknown type or invalid JSON fails with a reason. Never throws. */
export function parseServerMsg(raw: string): { ok: true; msg: ServerMsg } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw.length > MAX_SERVER_BYTES) return { ok: false, reason: 'message too large' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }
  if (!isPlainObject(value)) return { ok: false, reason: 'not an object' };
  const t = value.t;
  if (typeof t !== 'string' || !Object.hasOwn(SERVER_CHECKS, t)) return { ok: false, reason: 'unknown server message' };
  if (!hasFields(value, SERVER_CHECKS[t as ServerMsg['t']])) return { ok: false, reason: `invalid ${t} message` };
  return { ok: true, msg: value as unknown as ServerMsg };
}
