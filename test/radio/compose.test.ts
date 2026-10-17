import { describe, expect, it } from 'vitest';
import type { PlateReadback, RadioMode } from '../../src/cad/types';
import type { Transmission } from '../../src/radio/types';
import { at, CALL_LOCATION, makeRig, PLAYER, requests, starts, texts, type Rig } from './helpers';

function newCall(rig: Rig, priority: 1 | 2 | 3 | 4 = 2) {
  return rig.cad.createCall(
    {
      typeId: 'trafficHazard',
      priority,
      location: CALL_LOCATION,
      caller: { kind: 'citizen', name: 'Jane Roe', phone: '555-0100', personId: 7 },
      narrative: 'Debris in the road.',
    },
    at(rig.time),
  );
}

const READBACK: PlateReadback = {
  plate: 'ABC 1234',
  found: true,
  description: '2019 black Sedan',
  owner: 'SMITH, JOHN A',
  ownerPersonId: 5,
  hits: [],
  severity: 'clear',
};

/** Steps until the queue is empty and nothing is on the air (or `max` seconds). */
function settle(rig: Rig, max = 60): void {
  const until = rig.time + max;
  rig.run(0.05);
  while (rig.time < until && (rig.radio.queued > 0 || rig.radio.onAir.length > 0)) rig.run(0.25);
}

describe('composer: assignments', () => {
  it.each<[RadioMode, string, string]>([
    ['tenCode', '21, ', 'P2'],
    ['plain', '21, ', 'priority 2'],
  ])('cad:unitAssigned (dispatch) -> dispatcher assignment then the unit ack (%s)', (mode, prefix, prio) => {
    const rig = makeRig({ mode });
    const call = newCall(rig);
    rig.cad.assign(call.id, '21', at(0), 'dispatch');
    settle(rig);
    const s = starts(rig);
    expect(s.map((t) => [t.speaker, t.kind])).toEqual([
      ['Dispatch', 'assign'],
      ['21', 'unitAck'],
    ]);
    const [assign, ack] = s as [Transmission, Transmission];
    expect(assign.text.startsWith(prefix)).toBe(true);
    expect(assign.text).toContain(prio);
    expect(assign.text).toContain('248 N Oak Street');
    expect(assign.text).toContain('Traffic hazard');
    expect(assign.channel).toBe('dispatch');
    expect(ack.text.startsWith('21, ')).toBe(true);
    if (mode === 'tenCode') expect(ack.text).toMatch(/10-4/);
    else expect(ack.text).toMatch(/copy/);
    const gap = ack.start - (assign.start + assign.duration);
    expect(gap).toBeGreaterThanOrEqual(1.5 - 1e-6);
    expect(gap).toBeLessThanOrEqual(3 + 1 / 60 + 1e-6);
    // The automatic "en route" status of the assignment is not announced separately.
    expect(s.some((t) => t.kind === 'enRoute')).toBe(false);
  });

  it('a backup assignment is announced by the backup broadcast only', () => {
    const rig = makeRig();
    const call = newCall(rig);
    rig.cad.assign(call.id, '23', at(0), 'backup');
    settle(rig);
    expect(starts(rig)).toHaveLength(0);
  });
});

describe('composer: AI status lines', () => {
  it('voices automatic status changes in the current mode', () => {
    const rig = makeRig();
    const call = newCall(rig);
    rig.cad.assign(call.id, '21', at(0), 'dispatch');
    settle(rig);
    rig.events.length = 0;
    rig.cad.setUnitStatus('21', 'onScene', at(rig.time), 'auto');
    settle(rig);
    expect(starts(rig)[0]?.text).toMatch(/^21, (show me )?10-23\.$/);
    rig.events.length = 0;
    rig.mode = 'plain';
    rig.cad.closeCall(call.id, 'handled', at(rig.time));
    settle(rig);
    const first = starts(rig)[0];
    expect(first?.speaker).toBe('21');
    expect(first?.kind).toBe('clear');
    expect(first?.text).toMatch(/in service/);
  });

  it('only automatic changes of AI units are voiced', () => {
    const rig = makeRig();
    rig.cad.setUnitStatus('23', 'busy', at(0), 'mdt');
    settle(rig);
    expect(starts(rig)).toHaveLength(0);
  });

  it('the dispatcher acknowledges about half of them', () => {
    const rig = makeRig();
    let acks = 0;
    let lines = 0;
    for (let i = 0; i < 40; i++) {
      rig.events.length = 0;
      rig.cad.setUnitStatus('23', i % 2 === 0 ? 'busy' : 'available', at(rig.time), 'auto');
      settle(rig);
      const s = starts(rig);
      lines += s.filter((t) => t.speaker === '23').length;
      acks += s.filter((t) => t.kind === 'dispatchAck').length;
    }
    expect(lines).toBe(40);
    expect(acks).toBeGreaterThan(8);
    expect(acks).toBeLessThan(32);
  });
});

describe('composer: voicing rule', () => {
  it('plate results are spoken when asked by radio, silent via mdt or key', () => {
    for (const via of ['radio', 'voice', 'mdt', 'key', 'auto'] as const) {
      const rig = makeRig();
      rig.bus.emit('dispatch:plateResult', { callsign: PLAYER, via, vehicleId: 3, readback: READBACK });
      settle(rig);
      expect(starts(rig).length, via).toBe(via === 'radio' || via === 'voice' ? 1 : 0);
    }
  });

  it('plate readbacks: clear, hit, no record', () => {
    const rig = makeRig();
    rig.bus.emit('dispatch:plateResult', { callsign: PLAYER, via: 'radio', vehicleId: 3, readback: READBACK });
    settle(rig);
    rig.bus.emit('dispatch:plateResult', {
      callsign: PLAYER,
      via: 'radio',
      vehicleId: 3,
      readback: { ...READBACK, hits: ['STOLEN VEHICLE'], severity: 'alert' },
    });
    settle(rig);
    rig.bus.emit('dispatch:plateResult', { callsign: PLAYER, via: 'radio', vehicleId: -1, readback: { ...READBACK, found: false } });
    settle(rig);
    const s = starts(rig);
    expect(s.map((t) => t.kind)).toEqual(['plateClear', 'plateHit', 'plateNotFound']);
    expect(s[0]?.text).toContain('no wants');
    expect(s[0]?.text).toContain('SMITH, JOHN A');
    expect(s[1]?.text).toContain('STOLEN VEHICLE');
    expect(s[0]?.spoken).toContain('Adam, Boy, Charles, one two three four');
  });

  it('a plate run by radio is answered even when the result says mdt', () => {
    const rig = makeRig();
    rig.radio.playerRequest({ kind: 'runPlate', plate: 'ABC 1234', vehicleId: 3 }, 'radio');
    settle(rig);
    expect(requests(rig)).toEqual([{ callsign: PLAYER, request: { kind: 'runPlate', plate: 'ABC 1234', vehicleId: 3 }, via: 'radio' }]);
    rig.bus.emit('dispatch:plateResult', { callsign: PLAYER, via: 'auto', vehicleId: 3, readback: READBACK });
    settle(rig);
    expect(starts(rig).map((t) => t.kind)).toEqual(['plateRequest', 'plateClear']);
  });

  it('a player line waits for the player\'s own transmission instead of stepping on it (integration fix)', () => {
    const rig = makeRig();
    rig.radio.playerRequest({ kind: 'status', status: 'busy' }, 'radio');
    rig.run(0.1);
    // Keyed up again while the first line is still on the air.
    rig.radio.playerRequest({ kind: 'runPlate', plate: 'ABC 1234', vehicleId: 3 }, 'radio');
    settle(rig);
    const own = starts(rig).filter((t) => t.speakerKind === 'player');
    expect(own.map((t) => t.kind)).toEqual(['status', 'plateRequest']);
    expect(own.every((t) => !t.blocked)).toBe(true);
    expect(rig.events.some((e) => e.topic === 'radio:blocked')).toBe(false);
    const [first, second] = own;
    expect((second?.start ?? 0) - ((first?.start ?? 0) + (first?.duration ?? 0))).toBeCloseTo(0.3, 1);
    expect(requests(rig)).toHaveLength(2);
  });

  it('acks of radio requests are spoken once; key requests get silent answers', () => {
    const rig = makeRig();
    rig.radio.playerRequest({ kind: 'code4' }, 'radio');
    settle(rig);
    rig.bus.emit('dispatch:ack', { callsign: PLAYER, kind: 'code4', ok: true, text: 'Code 4' });
    rig.bus.emit('dispatch:ack', { callsign: PLAYER, kind: 'code4', ok: true, text: 'Code 4' });
    settle(rig);
    expect(starts(rig).map((t) => `${t.speaker}:${t.kind}`)).toEqual(['12:code4', 'Dispatch:dispatchAck']);
    rig.events.length = 0;
    rig.radio.playerRequest({ kind: 'code4' }, 'key');
    settle(rig);
    expect(requests(rig)).toEqual([{ callsign: PLAYER, request: { kind: 'code4' }, via: 'key' }]);
    rig.bus.emit('dispatch:ack', { callsign: PLAYER, kind: 'code4', ok: true, text: 'Code 4' });
    settle(rig);
    expect(starts(rig).map((t) => t.kind)).toEqual(['code4']);
  });

  it('a refused radio request gets a spoken reason', () => {
    const rig = makeRig();
    rig.radio.playerRequest({ kind: 'trafficStop' }, 'radio');
    settle(rig);
    rig.bus.emit('dispatch:ack', { callsign: PLAYER, kind: 'trafficStop', ok: false, text: 'No traffic stop.' });
    settle(rig);
    const last = starts(rig).at(-1);
    expect(last?.kind).toBe('refused');
    expect(last?.text).toBe('12, negative, No traffic stop.');
  });

  it('player status changes by radio get a dispatcher ack, automatic ones do not', () => {
    const rig = makeRig();
    rig.radio.playerRequest({ kind: 'status', status: 'busy' }, 'radio');
    settle(rig);
    rig.cad.setUnitStatus(PLAYER, 'busy', at(rig.time), 'radio');
    settle(rig);
    expect(starts(rig).map((t) => t.text)).toEqual(['12, show me 10-6.', expect.stringMatching(/^(12, 10-4\.|10-4, 12, \d\d:\d\d\.)$/)]);
    rig.events.length = 0;
    rig.cad.setUnitStatus(PLAYER, 'available', at(rig.time), 'auto');
    settle(rig);
    expect(starts(rig)).toHaveLength(0);
  });

  it('accepting an offer by radio is answered with the assignment', () => {
    const rig = makeRig();
    const call = newCall(rig);
    rig.cad.offer(call.id, PLAYER, 25, at(0));
    rig.bus.emit('dispatch:offer', { callId: call.id, callsign: PLAYER, expired: false });
    settle(rig);
    rig.radio.playerRequest({ kind: 'acceptCall', callId: call.id }, 'radio');
    settle(rig);
    rig.cad.assign(call.id, PLAYER, at(rig.time), 'dispatch');
    settle(rig);
    expect(starts(rig).map((t) => `${t.speaker}:${t.kind}`)).toEqual(['Dispatch:offer', '12:accept', 'Dispatch:assign']);
    expect(starts(rig)[0]?.kind).toBe('offer');
  });
});

describe('composer: always on the air', () => {
  it('offers and offer timeouts', () => {
    const rig = makeRig({ mode: 'plain' });
    const call = newCall(rig, 3);
    rig.bus.emit('dispatch:offer', { callId: call.id, callsign: PLAYER, expired: false });
    rig.bus.emit('dispatch:offer', { callId: call.id, callsign: '21', expired: false });
    settle(rig);
    rig.bus.emit('dispatch:offer', { callId: call.id, callsign: PLAYER, expired: true });
    settle(rig);
    const s = starts(rig);
    expect(s.map((t) => t.kind)).toEqual(['offer', 'offerTimeout']);
    expect(s[0]?.text).toContain('priority 3');
    expect(s[1]?.text).toContain('C-00001');
  });

  it('emergency: priority alert, holds dispatch, release and clear', () => {
    const rig = makeRig();
    rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: true, units: ['21', '23'], location: 'Oak Street at 5th Street' });
    expect(rig.radio.isHeld('dispatch')).toBe(true);
    rig.radio.say('dispatch', 'routine traffic waits');
    rig.radio.say('county', 'county is not held');
    settle(rig, 10);
    let s = starts(rig);
    expect(s.map((t) => t.kind)).toEqual(['console', 'emergencyAlert']);
    expect(s[1]?.priority).toBe(true);
    expect(s[1]?.text).toBe('All units, 10-33. 12 emergency activation, last known Oak Street at 5th Street. 21 and 23, respond Code 3.');
    rig.run(20);
    expect(starts(rig).some((t) => t.text === 'routine traffic waits')).toBe(false);
    rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: false, units: [], location: '' });
    expect(rig.radio.isHeld('dispatch')).toBe(false);
    settle(rig);
    s = starts(rig);
    expect(s.map((t) => t.kind).slice(2).sort()).toEqual(['console', 'emergencyClear']);
  });

  it('status checks, repeat and escalation', () => {
    const rig = makeRig();
    rig.bus.emit('dispatch:statusCheck', { callsign: PLAYER, attempt: 1, escalated: false, location: '' });
    settle(rig);
    rig.bus.emit('dispatch:statusCheck', { callsign: PLAYER, attempt: 2, escalated: false, location: '' });
    settle(rig);
    rig.bus.emit('dispatch:statusCheck', { callsign: PLAYER, attempt: 3, escalated: true, location: 'Oak Street at 5th Street' });
    settle(rig);
    const s = starts(rig);
    expect(s.map((t) => t.kind)).toEqual(['statusCheck', 'statusCheckRepeat', 'statusEscalate']);
    expect(s[2]?.priority).toBe(true);
    expect(s[2]?.text).toContain('Oak Street at 5th Street');
  });

  it('backup broadcast with the first unit acknowledging; no units', () => {
    const rig = makeRig();
    rig.bus.emit('dispatch:backup', { requester: PLAYER, code: 3, units: ['21', '23'], x: 0, z: 0, location: 'Oak Street at 5th Street' });
    settle(rig);
    rig.bus.emit('dispatch:backup', { requester: PLAYER, code: 2, units: [], x: 0, z: 0, location: '' });
    settle(rig);
    expect(texts(rig)).toEqual([
      'Dispatch: 21 and 23, Code 3 to assist 12, Oak Street at 5th Street.',
      expect.stringMatching(/^21: 21, 10-4/),
      'Dispatch: 12, no units available at this time.',
    ]);
  });

  it('traffic stop: player call-out then dispatcher ack', () => {
    const rig = makeRig();
    const call = rig.cad.createCall(
      { typeId: 'trafficStop', priority: 4, location: CALL_LOCATION, caller: { kind: 'officer', name: '', phone: '', personId: -1 }, narrative: '', selfInitiated: true },
      at(0),
    );
    rig.cad.setTrafficStop(
      {
        callId: call.id, vehicleId: 42, plate: 'KDX 4410', x: 0, z: -250, started: at(0), driverId: -1, trueDriverId: 9,
        plateRun: false, vinChecked: false, vinResult: '', citations: [], outcome: 'active',
      },
      at(0),
    );
    rig.cad.assign(call.id, PLAYER, at(0), 'self');
    settle(rig);
    expect(texts(rig)).toEqual([
      '12: 12, 10-38, KDX 4410, 200 block of N Oak Street.',
      expect.stringMatching(/^Dispatch: 12, 10-4, \d\d:\d\d\.$/),
    ]);
  });
});

describe('player requests', () => {
  it('transmits at once; unit:request only after the line ends unblocked', () => {
    const rig = makeRig();
    rig.radio.playerRequest({ kind: 'status', status: 'available' }, 'radio');
    rig.run(1 / 60);
    expect(rig.radio.transmitting).toBe(true);
    expect(rig.radio.busy).toBe(true);
    const tx = starts(rig)[0] as Transmission;
    expect(tx.text).toBe('12, show me 10-8.');
    expect(tx.speakerKind).toBe('player');
    expect(requests(rig)).toHaveLength(0);
    rig.runUntil(tx.start + tx.duration - 0.05);
    expect(requests(rig)).toHaveLength(0);
    rig.run(0.1);
    expect(rig.radio.transmitting).toBe(false);
    expect(requests(rig)).toEqual([{ callsign: PLAYER, request: { kind: 'status', status: 'available' }, via: 'radio' }]);
  });

  it.each<[string, Parameters<Rig['radio']['playerRequest']>[0], string]>([
    ['status', { kind: 'status', status: 'onScene' }, '12, show me 10-23.'],
    ['accept', { kind: 'acceptCall', callId: 1 }, '12, 10-4, show me 10-76.'],
    ['decline', { kind: 'declineCall', callId: 1 }, '12, unable, 10-6.'],
    ['runPlate', { kind: 'runPlate', plate: 'ABC 1234', vehicleId: -1 }, '12, 10-28 on ABC 1234.'],
    ['backup', { kind: 'backup', code: 3 }, '12, 10-78, Code 3, Oak Street at 5th Street.'],
    ['location', { kind: 'location' }, '12, 10-20?'],
    ['code4', { kind: 'code4' }, '12, Code 4.'],
    ['repeat', { kind: 'repeat' }, '12, 10-9.'],
  ])('player line for %s', (_name, request, text) => {
    const rig = makeRig();
    rig.radio.playerRequest(request, 'radio');
    rig.run(0.1);
    expect(starts(rig)[0]?.text).toBe(text);
  });

  it('blocked: no request, the dispatcher asks to say again', () => {
    const rig = makeRig();
    rig.radio.say('dispatch', 'all units be advised of a long bulletin about road works on the north side of the city');
    rig.run(0.5);
    // Voice PTT keys up at once (a radio-menu request would wait for the clear channel).
    rig.radio.playerRequest({ kind: 'status', status: 'available' }, 'voice');
    settle(rig);
    expect(rig.events.filter((e) => e.topic === 'radio:blocked')).toHaveLength(1);
    expect(requests(rig)).toHaveLength(0);
    const last = starts(rig).at(-1);
    expect(last?.kind).toBe('blocked');
    expect(last?.text).toBe('12, you were blocked, 10-9.');
  });

  it('wrong channel: no request; that channel dispatcher answers when it has one', () => {
    const rig = makeRig();
    rig.radio.selectChannel('tac');
    rig.radio.playerRequest({ kind: 'status', status: 'available' }, 'radio');
    settle(rig);
    expect(requests(rig)).toHaveLength(0);
    expect(starts(rig).map((t) => t.kind)).toEqual(['status']);
    rig.radio.selectChannel('fireEms');
    rig.radio.playerRequest({ kind: 'code4' }, 'radio');
    settle(rig);
    expect(requests(rig)).toHaveLength(0);
    const last = starts(rig).at(-1);
    expect(last?.speaker).toBe('Fire Dispatch');
    expect(last?.channel).toBe('fireEms');
    expect(last?.text).toContain('Fire / EMS');
  });

  it('say again re-queues the last dispatcher line to the player without a request', () => {
    const rig = makeRig();
    rig.bus.emit('dispatch:statusCheck', { callsign: PLAYER, attempt: 1, escalated: false, location: '' });
    settle(rig);
    const check = starts(rig)[0] as Transmission;
    rig.radio.playerRequest({ kind: 'repeat' }, 'radio');
    settle(rig);
    expect(requests(rig)).toHaveLength(0);
    const s = starts(rig);
    expect(s.map((t) => t.kind)).toEqual(['statusCheck', 'repeatRequest', 'statusCheck']);
    expect(s[2]?.text).toBe(check.text);
    expect(s[2]?.id).not.toBe(check.id);
  });

  it('location: asks when dispatch did not, answers when dispatch asked', () => {
    const rig = makeRig();
    rig.radio.playerRequest({ kind: 'location' }, 'radio');
    settle(rig);
    rig.bus.emit('dispatch:location', { callsign: PLAYER, text: 'Oak Street at 5th Street', asked: false });
    settle(rig);
    expect(texts(rig)).toEqual(['12: 12, 10-20?', 'Dispatch: 12, your 10-20 is Oak Street at 5th Street.']);
    rig.events.length = 0;
    rig.bus.emit('dispatch:location', { callsign: PLAYER, text: '', asked: true });
    settle(rig);
    rig.radio.playerRequest({ kind: 'location' }, 'radio');
    settle(rig);
    rig.bus.emit('dispatch:location', { callsign: PLAYER, text: 'Oak Street at 5th Street', asked: false });
    settle(rig);
    expect(texts(rig)).toEqual([
      "Dispatch: 12, what's your 10-20?",
      '12: 12, 10-20 is Oak Street at 5th Street.',
      expect.stringMatching(/^Dispatch: (12, 10-4\.|10-4, 12, \d\d:\d\d\.)$/),
    ]);
  });

  it('emergency button: immediate request via key and a priority player line', () => {
    const rig = makeRig();
    rig.radio.emergencyButton();
    expect(requests(rig)).toEqual([{ callsign: PLAYER, request: { kind: 'emergency' }, via: 'key' }]);
    settle(rig);
    const tx = starts(rig)[0];
    expect(tx?.priority).toBe(true);
    expect(tx?.kind).toBe('playerEmergency');
    expect(tx?.text).toBe('12, 10-33! Oak Street at 5th Street!');
    expect(requests(rig)).toHaveLength(1);
    // works on any channel
    rig.radio.selectChannel('state');
    rig.radio.emergencyButton();
    expect(requests(rig)).toHaveLength(2);
  });
});

describe('ambient chatter', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = makeRig({ quiet: false, seed: 7 });
    const b = makeRig({ quiet: false, seed: 7 });
    const c = makeRig({ quiet: false, seed: 8 });
    a.run(180);
    b.run(180);
    c.run(180);
    expect(texts(a).length).toBeGreaterThan(5);
    expect(texts(a)).toEqual(texts(b));
    expect(texts(a)).not.toEqual(texts(c));
    expect(a.radio.log.map((t) => t.start)).toEqual(b.radio.log.map((t) => t.start));
  });

  it('fills plates and addresses, follows the channel cast', () => {
    const rig = makeRig({ quiet: false, seed: 11 });
    rig.run(600);
    const s = starts(rig);
    for (const tx of s) {
      expect(tx.kind).toBe('ambient');
      expect(tx.text).not.toMatch(/[{}]/);
    }
    expect(s.some((t) => /[A-Z]{3} \d{4}/.test(t.text))).toBe(true);
    expect(s.some((t) => /\d+ [NSEW] (Oak|5th) Street/.test(t.text))).toBe(true);
    const fire = s.filter((t) => t.channel === 'fireEms' && t.speakerKind !== 'dispatcher');
    expect(fire.length).toBeGreaterThan(0);
    expect(fire.every((t) => /^(Engine|Medic|Truck|Battalion) \d$/.test(t.speaker) && t.speakerKind === 'agency')).toBe(true);
    // about 4.2 lines a minute over all channels
    expect(s.length).toBeGreaterThan(20);
    expect(s.length).toBeLessThan(80);
  });

  it('is suppressed on a held channel', () => {
    const rig = makeRig({ quiet: false, seed: 3 });
    rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: true, units: [], location: '' });
    rig.run(600);
    const s = starts(rig);
    expect(s.filter((t) => t.channel === 'dispatch').map((t) => t.kind)).toEqual(['emergencyAlert']);
    expect(s.filter((t) => t.channel !== 'dispatch').length).toBeGreaterThan(5);
  });

  it('only selected or scanned channels are audible', () => {
    const rig = makeRig({ quiet: false, seed: 5 });
    rig.run(300);
    for (const tx of rig.radio.log) expect(tx.audible).toBe(tx.channel === 'dispatch');
    rig.radio.toggleScan();
    const from = rig.radio.log.length;
    rig.run(300);
    for (const tx of rig.radio.log.slice(from)) expect(tx.audible).toBe(['dispatch', 'tac', 'fireEms'].includes(tx.channel));
  });
});

describe('channels', () => {
  it('select, step and scan emit radio:channel', () => {
    const rig = makeRig();
    rig.radio.selectChannel('county');
    rig.radio.selectChannel('county');
    rig.radio.stepChannel(1);
    rig.radio.stepChannel(1);
    rig.radio.stepChannel(-1);
    rig.radio.toggleScan();
    expect(rig.radio.selected).toBe('state');
    expect(rig.radio.scanning).toBe(true);
    expect(rig.radio.scanList).toEqual(['dispatch', 'tac', 'fireEms']);
    expect(rig.events.filter((e) => e.topic === 'radio:channel').map((e) => e.payload)).toEqual([
      { selected: 'county', scanning: false },
      { selected: 'state', scanning: false },
      { selected: 'dispatch', scanning: false },
      { selected: 'state', scanning: false },
      { selected: 'state', scanning: true },
    ]);
  });
});
