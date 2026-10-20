/**
 * Radio data (design §4.7): channels, phrasebook, ambient chatter, phonetic alphabet and voice-command
 * synonyms. Validated at import; every failure names the file and the field.
 */
import { placeholdersOf } from '../cad/data';
import { TEN_CODES } from '../cad/data';
import type { RadioMode, UnitStatus } from '../cad/types';
import { UNIT_STATUSES } from '../cad/types';
import ambientJson from '../data/radio/ambient.json';
import { UNITS_DATA } from '../dispatch/data';
import channelsJson from '../data/radio/channels.json';
import commandsJson from '../data/radio/commands.json';
import phoneticJson from '../data/radio/phonetic.json';
import phrasesJson from '../data/radio/phrases.json';
import { fail, readArray, readBoolean, readNumber, readObject, readOneOf, readString, readVersion, type JsonObject } from '../vehicles/json';
import { CHANNEL_IDS, type ChannelId } from './types';

const MODES: readonly RadioMode[] = ['tenCode', 'plain'];

// --- Channels -------------------------------------------------------------------------------

export interface ChannelDef {
  readonly id: ChannelId;
  readonly label: string;
  readonly short: string;
  /** Dispatcher speaker name, null for unit-only channels. */
  readonly dispatcher: string | null;
  readonly ambientPerMin: number;
  /** Requests transmitted here are acted on (only dispatch). */
  readonly requests: boolean;
}

export interface RadioConfig {
  /** In channel-selector order. */
  readonly channels: readonly ChannelDef[];
  readonly defaultSelected: ChannelId;
  readonly defaultScan: readonly ChannelId[];
  readonly wordsPerSecond: number;
  readonly keyUpS: number;
  readonly tailS: number;
  readonly doubleKeyChance: number;
  readonly scanVolume: number;
  readonly logSize: number;
}

export function validateChannels(data: unknown, file = 'channels.json'): RadioConfig {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const list = readArray(root.channels, file, 'channels', 1);
  const channels: ChannelDef[] = [];
  const seen = new Set<string>();
  list.forEach((v, i) => {
    const path = `channels[${i}]`;
    const o = readObject(v, file, path);
    const id = readOneOf(o.id, CHANNEL_IDS, file, `${path}.id`);
    if (seen.has(id)) fail(file, `${path}.id`, `duplicates "${id}"`);
    seen.add(id);
    const dispatcher = o.dispatcher === null ? null : readString(o.dispatcher, file, `${path}.dispatcher`);
    channels.push({
      id,
      label: readString(o.label, file, `${path}.label`),
      short: readString(o.short, file, `${path}.short`),
      dispatcher,
      ambientPerMin: readNumber(o.ambientPerMin, file, `${path}.ambientPerMin`, 0, 60),
      requests: readBoolean(o.requests, file, `${path}.requests`),
    });
  });
  for (const id of CHANNEL_IDS) if (!seen.has(id)) fail(file, 'channels', `is missing channel "${id}"`);
  const requestChannels = channels.filter((c) => c.requests);
  if (requestChannels.length !== 1) fail(file, 'channels', `must have exactly one channel with requests: true, got ${requestChannels.length}`);
  if (requestChannels[0]?.dispatcher === null) fail(file, 'channels', 'the requests channel needs a dispatcher');
  const defaultScan = readArray(root.defaultScan, file, 'defaultScan').map((v, i) => readOneOf(v, CHANNEL_IDS, file, `defaultScan[${i}]`));
  return {
    channels,
    defaultSelected: readOneOf(root.defaultSelected, CHANNEL_IDS, file, 'defaultSelected'),
    defaultScan: [...new Set(defaultScan)],
    wordsPerSecond: readNumber(root.wordsPerSecond, file, 'wordsPerSecond', 0.5, 10),
    keyUpS: readNumber(root.keyUpS, file, 'keyUpS', 0, 5),
    tailS: readNumber(root.tailS, file, 'tailS', 0, 5),
    doubleKeyChance: readNumber(root.doubleKeyChance, file, 'doubleKeyChance', 0, 1),
    scanVolume: readNumber(root.scanVolume, file, 'scanVolume', 0, 1),
    logSize: Math.floor(readNumber(root.logSize, file, 'logSize', 1, 10000)),
  };
}

// --- Phrases --------------------------------------------------------------------------------

/** Message kinds of design §4.7 plus the player/dispatcher lines this module adds. */
export const PHRASE_KINDS = [
  'assign', 'unitAck', 'enRoute', 'onScene', 'clear', 'dispatchAck', 'offer', 'offerTimeout',
  'plateRequest', 'plateClear', 'plateHit', 'personReturn', 'backupRequest', 'backupDispatch',
  'noUnits', 'emergencyAlert', 'emergencyClear', 'statusCheck', 'statusCheckRepeat', 'statusEscalate',
  'locationAsk', 'locationGive', 'locationAnswer', 'trafficStop', 'trafficStopAck', 'stopClear',
  'blocked', 'wrongChannel', 'code4', 'status',
  // additions
  'plateNotFound', 'personRequest', 'playerEmergency', 'locationRequest', 'accept', 'decline',
  'repeatRequest', 'refused', 'generic',
] as const;
export type PhraseKind = (typeof PHRASE_KINDS)[number];

export const FRAGMENT_KEYS = ['noHits', 'backupCode2', 'backupCode3', 'unknownLocation', 'allUnits', 'noPlate'] as const;
export type FragmentKey = (typeof FRAGMENT_KEYS)[number];

/** Placeholders a phrase template may use (plus `{code:<tenCodes key>}`). */
export const PHRASE_PLACEHOLDERS = [
  'unit', 'player', 'nature', 'address', 'cross', 'near', 'priority', 'plate', 'desc', 'owner', 'hits', 'units',
  'time', 'status', 'call', 'name', 'dob', 'dl', 'dlStatus', 'backupCode', 'reason', 'channel', 'eta',
] as const;

/** Placeholders an ambient template may use (plus `{code:<key>}`). */
export const AMBIENT_PLACEHOLDERS = ['unit', 'other', 'randomPlate', 'randomAddress', 'time'] as const;

export interface PhraseTiming {
  /** A unit's acknowledgement starts this long after the dispatcher's line ends (s). */
  readonly ackGapS: readonly [number, number];
  /** Dispatcher replies to the player start this long after the cause (s). */
  readonly replyGapS: readonly [number, number];
  /** Chance the dispatcher acknowledges an AI unit's status change. */
  readonly dispatchAckChance: number;
  /** A player request sent by radio waits this long for its spoken answer (s). */
  readonly answerWindowS: number;
}

export interface PhraseTable {
  readonly timing: PhraseTiming;
  readonly fragments: Readonly<Record<FragmentKey, Readonly<Record<RadioMode, string>>>>;
  readonly kinds: Readonly<Record<PhraseKind, Readonly<Record<RadioMode, readonly string[]>>>>;
}

function checkTemplate(template: string, allowed: readonly string[], file: string, path: string): void {
  for (const name of placeholdersOf(template)) {
    if (name.startsWith('code:')) {
      const key = name.slice(5);
      if (!Object.hasOwn(TEN_CODES.codes, key)) fail(file, path, `uses unknown ten-code {${name}}`);
    } else if (!allowed.includes(name)) {
      fail(file, path, `uses unknown placeholder {${name}}`);
    }
  }
}

function readTemplates(value: unknown, allowed: readonly string[], file: string, path: string, minLength = 1): string[] {
  return readArray(value, file, path, minLength).map((v, i) => {
    const s = readString(v, file, `${path}[${i}]`);
    checkTemplate(s, allowed, file, `${path}[${i}]`);
    return s;
  });
}

function readRange(value: unknown, file: string, path: string): [number, number] {
  const arr = readArray(value, file, path, 2);
  const lo = readNumber(arr[0], file, `${path}[0]`, 0, 60);
  const hi = readNumber(arr[1], file, `${path}[1]`, lo, 60);
  return [lo, hi];
}

export function validatePhrases(data: unknown, file = 'phrases.json'): PhraseTable {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const t = readObject(root.timing, file, 'timing');
  const timing: PhraseTiming = {
    ackGapS: readRange(t.ackGapS, file, 'timing.ackGapS'),
    replyGapS: readRange(t.replyGapS, file, 'timing.replyGapS'),
    dispatchAckChance: readNumber(t.dispatchAckChance, file, 'timing.dispatchAckChance', 0, 1),
    answerWindowS: readNumber(t.answerWindowS, file, 'timing.answerWindowS', 1, 600),
  };
  const fragObj = readObject(root.fragments, file, 'fragments');
  const fragments = {} as Record<FragmentKey, Record<RadioMode, string>>;
  for (const key of FRAGMENT_KEYS) {
    const o = readObject(fragObj[key], file, `fragments.${key}`);
    fragments[key] = { tenCode: readString(o.tenCode, file, `fragments.${key}.tenCode`), plain: readString(o.plain, file, `fragments.${key}.plain`) };
  }
  const kindsObj = readObject(root.kinds, file, 'kinds');
  const kinds = {} as Record<PhraseKind, Record<RadioMode, string[]>>;
  for (const kind of PHRASE_KINDS) {
    const o = readObject(kindsObj[kind], file, `kinds.${kind}`);
    const entry = {} as Record<RadioMode, string[]>;
    for (const mode of MODES) entry[mode] = readTemplates(o[mode], PHRASE_PLACEHOLDERS, file, `kinds.${kind}.${mode}`);
    kinds[kind] = entry;
  }
  return { timing, fragments, kinds };
}

// --- Ambient --------------------------------------------------------------------------------

export interface AmbientChannel {
  readonly speakerKind: 'officer' | 'agency';
  readonly units: readonly string[];
  /** Lines spoken by one of `units`. */
  readonly templates: readonly string[];
  /** Lines spoken by the channel's dispatcher (empty without one). */
  readonly dispatcherTemplates: readonly string[];
}

/**
 * `reserved`: callsigns of real CAD units (dispatch roster and the player). Made-up chatter may not use
 * them, or the radio would contradict the units' CAD status.
 */
export function validateAmbient(
  data: unknown,
  channels: readonly ChannelDef[],
  file = 'ambient.json',
  reserved: readonly string[] = [],
): Readonly<Record<ChannelId, AmbientChannel>> {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const chObj = readObject(root.channels, file, 'channels');
  const out = {} as Record<ChannelId, AmbientChannel>;
  for (const id of CHANNEL_IDS) {
    const path = `channels.${id}`;
    const o: JsonObject = readObject(chObj[id], file, path);
    const units = readArray(o.units, file, `${path}.units`, 1).map((v, i) => readString(v, file, `${path}.units[${i}]`));
    for (const u of units) if (reserved.includes(u)) fail(file, `${path}.units`, `${JSON.stringify(u)} is a CAD unit callsign`);
    const templates = readTemplates(o.templates, AMBIENT_PLACEHOLDERS, file, `${path}.templates`);
    const dispatcherTemplates =
      o.dispatcherTemplates === undefined ? [] : readTemplates(o.dispatcherTemplates, AMBIENT_PLACEHOLDERS, file, `${path}.dispatcherTemplates`, 0);
    const def = channels.find((c) => c.id === id);
    if (dispatcherTemplates.length > 0 && !def?.dispatcher) fail(file, `${path}.dispatcherTemplates`, 'needs a channel with a dispatcher');
    const usesOther = [...templates, ...dispatcherTemplates].some((s) => s.includes('{other}'));
    if (usesOther && units.length < 2) fail(file, `${path}.units`, 'must have at least 2 units when a template uses {other}');
    out[id] = { speakerKind: readOneOf(o.speakerKind, ['officer', 'agency'] as const, file, `${path}.speakerKind`), units, templates, dispatcherTemplates };
  }
  return out;
}

// --- Phonetic alphabet ----------------------------------------------------------------------

export interface PhoneticTable {
  /** "A" -> "Adam". */
  readonly letters: Readonly<Record<string, string>>;
  /** "0" -> "zero". */
  readonly digits: Readonly<Record<string, string>>;
  /** Extra spellings accepted by voice commands ("A" -> ["alpha", "alfa"]). */
  readonly nato: Readonly<Record<string, readonly string[]>>;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function validatePhonetic(data: unknown, file = 'phonetic.json'): PhoneticTable {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const lo = readObject(root.letters, file, 'letters');
  const letters: Record<string, string> = {};
  for (const c of LETTERS) letters[c] = readString(lo[c], file, `letters.${c}`);
  const dob = readObject(root.digits, file, 'digits');
  const digits: Record<string, string> = {};
  for (let d = 0; d <= 9; d++) digits[String(d)] = readString(dob[String(d)], file, `digits.${d}`);
  const nato: Record<string, string[]> = {};
  if (root.nato !== undefined) {
    const no = readObject(root.nato, file, 'nato');
    for (const [key, v] of Object.entries(no)) {
      if (!LETTERS.includes(key) || key.length !== 1) fail(file, `nato.${key}`, 'must be a capital letter A-Z');
      nato[key] = readArray(v, file, `nato.${key}`, 1).map((w, i) => readString(w, file, `nato.${key}[${i}]`));
    }
  }
  return { letters, digits, nato };
}

// --- Voice-command synonyms -----------------------------------------------------------------

export const COMMAND_GROUPS = ['accept', 'decline', 'runPlate', 'backup', 'location', 'code4', 'trafficStop', 'repeat', 'emergencyWords'] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface CommandTable {
  readonly status: Readonly<Record<UnitStatus, readonly string[]>>;
  readonly groups: Readonly<Record<CommandGroup, readonly string[]>>;
}

function readPhrases(value: unknown, file: string, path: string): string[] {
  return readArray(value, file, path, 1).map((v, i) => readString(v, file, `${path}[${i}]`));
}

export function validateCommands(data: unknown, file = 'commands.json'): CommandTable {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const so = readObject(root.status, file, 'status');
  const status = {} as Record<UnitStatus, string[]>;
  for (const s of UNIT_STATUSES) status[s] = readPhrases(so[s], file, `status.${s}`);
  const groups = {} as Record<CommandGroup, string[]>;
  for (const g of COMMAND_GROUPS) groups[g] = readPhrases(root[g], file, g);
  return { status, groups };
}

// --- Loaded tables --------------------------------------------------------------------------

export const RADIO_CONFIG: RadioConfig = validateChannels(channelsJson);
export const PHRASES: PhraseTable = validatePhrases(phrasesJson);
export const AMBIENT: Readonly<Record<ChannelId, AmbientChannel>> = validateAmbient(ambientJson, RADIO_CONFIG.channels, 'ambient.json', [
  UNITS_DATA.player.callsign,
  ...UNITS_DATA.units.map((u) => u.callsign),
]);
export const PHONETIC: PhoneticTable = validatePhonetic(phoneticJson);
export const VOICE_COMMANDS: CommandTable = validateCommands(commandsJson);

const CHANNEL_BY_ID: ReadonlyMap<ChannelId, ChannelDef> = new Map(RADIO_CONFIG.channels.map((c) => [c.id, c]));

/** Channel definition by id (every id exists: the validator checks it). A map lookup: called per frame. */
export function channelDef(id: ChannelId): ChannelDef {
  const c = CHANNEL_BY_ID.get(id);
  if (!c) throw new Error(`Unknown radio channel "${id}"`);
  return c;
}

/** The channel whose requests are acted on (dispatch). */
export const REQUEST_CHANNEL: ChannelId = (RADIO_CONFIG.channels.find((c) => c.requests) as ChannelDef).id;

export function isChannelId(x: unknown): x is ChannelId {
  return typeof x === 'string' && (CHANNEL_IDS as readonly string[]).includes(x);
}
