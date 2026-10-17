import { describe, expect, it } from 'vitest';
import type { UnitRequest } from '../../src/cad/types';
import { normalizeUtterance, parseVoiceCommand } from '../../src/radio/grammar';

const CASES: readonly (readonly [string, UnitRequest | null])[] = [
  // status (required: "show me 10-8", "show me on scene")
  ['show me 10-8', { kind: 'status', status: 'available' }],
  ['Show me ten eight', { kind: 'status', status: 'available' }],
  ['show me ten-eight.', { kind: 'status', status: 'available' }],
  ['10 8', { kind: 'status', status: 'available' }],
  ['show me in service', { kind: 'status', status: 'available' }],
  ['Twelve, show me available', { kind: 'status', status: 'available' }],
  ['back in service', { kind: 'status', status: 'available' }],
  ['show me on scene', { kind: 'status', status: 'onScene' }],
  ['Show me On-Scene!', { kind: 'status', status: 'onScene' }],
  ['ten twenty three', { kind: 'status', status: 'onScene' }],
  ['show me 10-23', { kind: 'status', status: 'onScene' }],
  ['show me en route', { kind: 'status', status: 'enRoute' }],
  ['show me ten seventy six', { kind: 'status', status: 'enRoute' }],
  ['show me busy', { kind: 'status', status: 'busy' }],
  ['show me 10-6', { kind: 'status', status: 'busy' }],
  ['show me out of service', { kind: 'status', status: 'outOfService' }],
  ['ten seven', { kind: 'status', status: 'outOfService' }],
  ['show me transporting', { kind: 'status', status: 'transporting' }],
  ['ten fifteen', { kind: 'status', status: 'transporting' }],
  // run plate (required: "run plate <plate>")
  ['run plate ABC 1234', { kind: 'runPlate', plate: 'ABC 1234', vehicleId: -1 }],
  ['run plate abc1234', { kind: 'runPlate', plate: 'ABC 1234', vehicleId: -1 }],
  ['Run plate A B C 1 2 3 4', { kind: 'runPlate', plate: 'ABC 1234', vehicleId: -1 }],
  ['run plate Adam Boy Charles one two three four', { kind: 'runPlate', plate: 'ABC 1234', vehicleId: -1 }],
  ['run a plate, Alpha Bravo Charlie, one two three four', { kind: 'runPlate', plate: 'ABC 1234', vehicleId: -1 }],
  ['run the plate X-ray Young Zebra 0 0 0 7', { kind: 'runPlate', plate: 'XYZ 0007', vehicleId: -1 }],
  ['run plate xray yankee zulu zero zero oh seven', { kind: 'runPlate', plate: 'XYZ 0007', vehicleId: -1 }],
  ['run plate for Nora Ocean Paul niner niner eight eight', { kind: 'runPlate', plate: 'NOP 9988', vehicleId: -1 }],
  ['ten twenty eight on King Lincoln Mary twelve thirty four', { kind: 'runPlate', plate: 'KLM 1234', vehicleId: -1 }],
  ['run plate Queen Robert Sam 5 6 7 8', { kind: 'runPlate', plate: 'QRS 5678', vehicleId: -1 }],
  ['run plate Tom Union Victor 1111', { kind: 'runPlate', plate: 'TUV 1111', vehicleId: -1 }],
  ['run plate William Henry Ida 2 2 2 2', { kind: 'runPlate', plate: 'WHI 2222', vehicleId: -1 }],
  ['run plate Juliet Kilo Lima 4 3 2 1', { kind: 'runPlate', plate: 'JKL 4321', vehicleId: -1 }],
  // backup (required: "requesting backup code 3")
  ['requesting backup code 3', { kind: 'backup', code: 3 }],
  ['requesting backup code three', { kind: 'backup', code: 3 }],
  ['requesting backup, code 2', { kind: 'backup', code: 2 }],
  ['need backup', { kind: 'backup', code: 2 }],
  ['send backup, emergency!', { kind: 'backup', code: 3 }],
  ['ten seventy eight', { kind: 'backup', code: 2 }],
  // location (required: "ten-twenty")
  ['ten-twenty', { kind: 'location' }],
  ['10-20', { kind: 'location' }],
  ['what is my location', { kind: 'location' }],
  ["what's my twenty?", { kind: 'location' }],
  ['Ten twenty?', { kind: 'location' }],
  // others
  ['code 4', { kind: 'code4' }],
  ['Code four', { kind: 'code4' }],
  ["I'm OK, all OK", { kind: 'code4' }],
  ['traffic stop', { kind: 'trafficStop' }],
  ['show me on a traffic stop', { kind: 'trafficStop' }],
  ['ten thirty eight', { kind: 'trafficStop' }],
  ['say again', { kind: 'repeat' }],
  ['10-9', { kind: 'repeat' }],
  ['repeat', { kind: 'repeat' }],
  ['accept', { kind: 'status', status: 'enRoute' }],
  ['decline', { kind: 'declineCall', callId: -1 }],
  ['unable', { kind: 'declineCall', callId: -1 }],
  // garbage
  ['', null],
  ['   ', null],
  ['hello there', null],
  ['ten four', null],
  ['the quick brown fox', null],
  ['!!!', null],
];

describe('parseVoiceCommand', () => {
  it('has at least 40 phrasings', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  for (const [text, expected] of CASES) {
    it(`"${text}"`, () => {
      expect(parseVoiceCommand(text)).toEqual(expected);
    });
  }

  it('falls back to the target / stopped plate when none is spoken', () => {
    expect(parseVoiceCommand('run plate', { fallbackPlate: 'KDX 4410', fallbackVehicleId: 77 })).toEqual({
      kind: 'runPlate',
      plate: 'KDX 4410',
      vehicleId: 77,
    });
    expect(parseVoiceCommand('run a plate please', { fallbackPlate: 'KDX 4410' })).toEqual({ kind: 'runPlate', plate: 'KDX 4410', vehicleId: -1 });
    expect(parseVoiceCommand('run plate Adam')).toBeNull();
    expect(parseVoiceCommand('run plate')).toBeNull();
  });

  it('keeps the fallback vehicle id when the spoken plate is the fallback plate', () => {
    expect(parseVoiceCommand('run plate Adam Boy Charles 1 2 3 4', { fallbackPlate: 'ABC 1234', fallbackVehicleId: 5 })).toEqual({
      kind: 'runPlate',
      plate: 'ABC 1234',
      vehicleId: 5,
    });
    expect(parseVoiceCommand('run plate Adam Boy David 1 2 3 4', { fallbackPlate: 'ABC 1234', fallbackVehicleId: 5 })).toEqual({
      kind: 'runPlate',
      plate: 'ABD 1234',
      vehicleId: -1,
    });
  });

  it('accept / decline use the offered call id', () => {
    expect(parseVoiceCommand('accept', { offerCallId: 9 })).toEqual({ kind: 'acceptCall', callId: 9 });
    expect(parseVoiceCommand("I'll take it", { offerCallId: 9 })).toEqual({ kind: 'acceptCall', callId: 9 });
    expect(parseVoiceCommand('decline', { offerCallId: 9 })).toEqual({ kind: 'declineCall', callId: 9 });
  });
});

describe('normalizeUtterance', () => {
  it('turns number words into digits and ten-codes', () => {
    expect(normalizeUtterance('Ten-Eight')).toEqual(['10-8']);
    expect(normalizeUtterance('ten twenty')).toEqual(['10-20']);
    expect(normalizeUtterance('ten twenty eight')).toEqual(['10-28']);
    expect(normalizeUtterance('code three')).toEqual(['code', '3']);
    expect(normalizeUtterance('niner oh one')).toEqual(['9', '0', '1']);
    expect(normalizeUtterance("What's my 20?")).toEqual(['whats', 'my', '20']);
  });
});
