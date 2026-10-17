import { describe, expect, it } from 'vitest';
import { TEN_CODES } from '../../src/cad/data';
import { placeholdersOf } from '../../src/cad/data';
import ambientJson from '../../src/data/radio/ambient.json';
import channelsJson from '../../src/data/radio/channels.json';
import commandsJson from '../../src/data/radio/commands.json';
import phoneticJson from '../../src/data/radio/phonetic.json';
import phrasesJson from '../../src/data/radio/phrases.json';
import { UNITS_DATA } from '../../src/dispatch/data';
import {
  AMBIENT,
  PHONETIC,
  PHRASES,
  PHRASE_KINDS,
  RADIO_CONFIG,
  REQUEST_CHANNEL,
  VOICE_COMMANDS,
  validateAmbient,
  validateChannels,
  validateCommands,
  validatePhonetic,
  validatePhrases,
} from '../../src/radio/data';
import { CHANNEL_IDS } from '../../src/radio/types';

const clone = <T>(x: T): T => structuredClone(x);

describe('channels.json', () => {
  it('matches the design table exactly', () => {
    expect(RADIO_CONFIG.channels.map((c) => [c.id, c.label, c.short, c.dispatcher, c.ambientPerMin, c.requests])).toEqual([
      ['dispatch', 'City Dispatch', 'DISP', 'Dispatch', 1.2, true],
      ['tac', 'Tactical 2', 'TAC2', null, 0.3, false],
      ['car', 'Car-to-car', 'CAR', null, 0.4, false],
      ['fireEms', 'Fire / EMS', 'F/EMS', 'Fire Dispatch', 1.0, false],
      ['county', 'County', 'CNTY', 'County', 0.8, false],
      ['state', 'State', 'STATE', 'State Dispatch', 0.5, false],
    ]);
    expect(RADIO_CONFIG.defaultSelected).toBe('dispatch');
    expect(RADIO_CONFIG.defaultScan).toEqual(['dispatch', 'tac', 'fireEms']);
    expect(RADIO_CONFIG).toMatchObject({ wordsPerSecond: 2.6, keyUpS: 0.35, tailS: 0.3, doubleKeyChance: 0.04, scanVolume: 0.7, logSize: 100 });
    expect(REQUEST_CHANNEL).toBe('dispatch');
  });

  it('rejects bad files with the file and field', () => {
    const bad = clone(channelsJson) as Record<string, unknown>;
    bad.version = 2;
    expect(() => validateChannels(bad)).toThrow('channels.json: version');
    const noState = clone(channelsJson);
    noState.channels = noState.channels.filter((c) => c.id !== 'state');
    expect(() => validateChannels(noState)).toThrow(/channels\.json: channels is missing channel "state"/);
    const badId = clone(channelsJson);
    (badId.channels[1] as { id: string }).id = 'police';
    expect(() => validateChannels(badId)).toThrow('channels.json: channels[1].id');
    const twoReq = clone(channelsJson);
    (twoReq.channels[1] as { requests: boolean }).requests = true;
    expect(() => validateChannels(twoReq)).toThrow('channels.json: channels must have exactly one channel');
    const badRate = clone(channelsJson);
    badRate.wordsPerSecond = 0;
    expect(() => validateChannels(badRate)).toThrow('channels.json: wordsPerSecond');
  });
});

describe('phrases.json', () => {
  const required = [
    'assign', 'unitAck', 'enRoute', 'onScene', 'clear', 'dispatchAck', 'offer', 'offerTimeout', 'plateRequest', 'plateClear',
    'plateHit', 'personReturn', 'backupRequest', 'backupDispatch', 'noUnits', 'emergencyAlert', 'emergencyClear', 'statusCheck',
    'statusCheckRepeat', 'statusEscalate', 'locationAsk', 'locationGive', 'locationAnswer', 'trafficStop', 'trafficStopAck',
    'stopClear', 'blocked', 'wrongChannel', 'code4', 'status',
  ];

  it('has every design kind with templates in both modes', () => {
    for (const kind of required) expect(PHRASE_KINDS).toContain(kind);
    for (const kind of PHRASE_KINDS) {
      expect(PHRASES.kinds[kind].tenCode.length, kind).toBeGreaterThanOrEqual(1);
      expect(PHRASES.kinds[kind].plain.length, kind).toBeGreaterThanOrEqual(1);
    }
  });

  it('uses only known ten-code keys', () => {
    for (const kind of PHRASE_KINDS) {
      for (const t of [...PHRASES.kinds[kind].tenCode, ...PHRASES.kinds[kind].plain]) {
        for (const p of placeholdersOf(t)) if (p.startsWith('code:')) expect(Object.hasOwn(TEN_CODES.codes, p.slice(5)), t).toBe(true);
      }
    }
  });

  it('rejects missing kinds, modes, unknown placeholders and codes', () => {
    const noKind = clone(phrasesJson) as { kinds: Record<string, unknown> };
    delete noKind.kinds.statusEscalate;
    expect(() => validatePhrases(noKind)).toThrow('phrases.json: kinds.statusEscalate');
    const noPlain = clone(phrasesJson) as { kinds: Record<string, Record<string, unknown>> };
    delete (noPlain.kinds.offer as Record<string, unknown>).plain;
    expect(() => validatePhrases(noPlain)).toThrow('phrases.json: kinds.offer.plain');
    const empty = clone(phrasesJson) as { kinds: Record<string, Record<string, unknown>> };
    (empty.kinds.offer as Record<string, unknown>).tenCode = [];
    expect(() => validatePhrases(empty)).toThrow('phrases.json: kinds.offer.tenCode');
    const badPh = clone(phrasesJson) as { kinds: Record<string, Record<string, string[]>> };
    (badPh.kinds.assign as Record<string, string[]>).plain = ['{unit}, {street}'];
    expect(() => validatePhrases(badPh)).toThrow('phrases.json: kinds.assign.plain[0] uses unknown placeholder {street}');
    const badCode = clone(phrasesJson) as { kinds: Record<string, Record<string, string[]>> };
    (badCode.kinds.assign as Record<string, string[]>).tenCode = ['{code:nope}'];
    expect(() => validatePhrases(badCode)).toThrow('phrases.json: kinds.assign.tenCode[0] uses unknown ten-code {code:nope}');
    const badTiming = clone(phrasesJson);
    badTiming.timing.dispatchAckChance = 2;
    expect(() => validatePhrases(badTiming)).toThrow('phrases.json: timing.dispatchAckChance');
  });
});

describe('ambient.json', () => {
  it('has units and templates for every channel', () => {
    for (const id of CHANNEL_IDS) {
      expect(AMBIENT[id].units.length, id).toBeGreaterThan(0);
      expect(AMBIENT[id].templates.length, id).toBeGreaterThan(0);
    }
    expect(AMBIENT.fireEms.units).toContain('Engine 4');
    expect(AMBIENT.fireEms.units).toContain('Medic 2');
    expect(AMBIENT.county.units).toContain('County 31');
    expect(AMBIENT.state.units).toContain('Trooper 12');
    expect(AMBIENT.tac.dispatcherTemplates).toEqual([]);
  });

  it('rejects bad entries', () => {
    const missing = clone(ambientJson) as { channels: Record<string, unknown> };
    delete missing.channels.car;
    expect(() => validateAmbient(missing, RADIO_CONFIG.channels)).toThrow('ambient.json: channels.car');
    const disp = clone(ambientJson) as { channels: Record<string, Record<string, unknown>> };
    (disp.channels.tac as Record<string, unknown>).dispatcherTemplates = ['{unit}, go.'];
    expect(() => validateAmbient(disp, RADIO_CONFIG.channels)).toThrow('ambient.json: channels.tac.dispatcherTemplates needs a channel with a dispatcher');
    const ph = clone(ambientJson) as { channels: Record<string, Record<string, unknown>> };
    (ph.channels.car as Record<string, unknown>).templates = ['{unit} at {nature}'];
    expect(() => validateAmbient(ph, RADIO_CONFIG.channels)).toThrow('ambient.json: channels.car.templates[0] uses unknown placeholder {nature}');
    const one = clone(ambientJson) as { channels: Record<string, Record<string, unknown>> };
    (one.channels.car as Record<string, unknown>).units = ['26'];
    expect(() => validateAmbient(one, RADIO_CONFIG.channels)).toThrow('ambient.json: channels.car.units must have at least 2 units');
    expect(() => validateAmbient(ambientJson, RADIO_CONFIG.channels, 'ambient.json', ['34'])).toThrow('ambient.json: channels.dispatch.units "34" is a CAD unit callsign');
  });

  it('never uses the callsign of a CAD unit (the radio would contradict its CAD status)', () => {
    const roster = new Set([UNITS_DATA.player.callsign, ...UNITS_DATA.units.map((u) => u.callsign)]);
    for (const id of CHANNEL_IDS) for (const u of AMBIENT[id].units) expect(roster.has(u), `${id}: ${u}`).toBe(false);
  });
});

describe('phonetic.json', () => {
  it('is the APCO alphabet plus digit words', () => {
    expect(Object.values(PHONETIC.letters)).toEqual([
      'Adam', 'Boy', 'Charles', 'David', 'Edward', 'Frank', 'George', 'Henry', 'Ida', 'John', 'King', 'Lincoln', 'Mary',
      'Nora', 'Ocean', 'Paul', 'Queen', 'Robert', 'Sam', 'Tom', 'Union', 'Victor', 'William', 'X-ray', 'Young', 'Zebra',
    ]);
    expect(Object.keys(PHONETIC.letters).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(PHONETIC.digits['0']).toBe('zero');
    expect(PHONETIC.digits['9']).toBe('nine');
    expect(PHONETIC.nato.A).toContain('alpha');
  });

  it('rejects a missing letter or digit', () => {
    const noQ = clone(phoneticJson) as { letters: Record<string, string> };
    delete noQ.letters.Q;
    expect(() => validatePhonetic(noQ)).toThrow('phonetic.json: letters.Q');
    const noDigit = clone(phoneticJson) as { digits: Record<string, string> };
    delete noDigit.digits['7'];
    expect(() => validatePhonetic(noDigit)).toThrow('phonetic.json: digits.7');
  });
});

describe('commands.json', () => {
  it('has synonyms for every status and command', () => {
    expect(VOICE_COMMANDS.status.available).toContain('10-8');
    expect(VOICE_COMMANDS.groups.runPlate).toContain('run plate');
    expect(VOICE_COMMANDS.groups.location).toContain('10-20');
  });

  it('rejects a missing group', () => {
    const bad = clone(commandsJson) as Record<string, unknown>;
    delete bad.code4;
    expect(() => validateCommands(bad)).toThrow('commands.json: code4');
    const badStatus = clone(commandsJson) as { status: Record<string, unknown> };
    delete badStatus.status.busy;
    expect(() => validateCommands(badStatus)).toThrow('commands.json: status.busy');
  });
});
