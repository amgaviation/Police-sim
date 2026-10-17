import { describe, expect, it } from 'vitest';
import type { UnitRequestEvent } from '../../src/cad/events';
import type { Transmission } from '../../src/radio/types';
import { makeRig, PLAYER, type Rig } from './helpers';

function starts(rig: Rig): Transmission[] {
  return rig.events.filter((e) => e.topic === 'radio:start').map((e) => (e.payload as { tx: Transmission }).tx);
}

function requests(rig: Rig): string[] {
  return rig.events.filter((e) => e.topic === 'unit:request').map((e) => (e.payload as UnitRequestEvent).request.kind);
}

/** A stand-in dispatcher: emergency on/off and simple acks. */
function fakeDispatch(rig: Rig): void {
  rig.bus.on('unit:request', (e) => {
    if (e.request.kind === 'emergency') rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: true, units: ['21'], location: 'Oak Street at 5th Street' });
    if (e.request.kind === 'code4') rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: false, units: [], location: 'Oak Street at 5th Street' });
    if (e.request.kind === 'location') rig.bus.emit('dispatch:location', { callsign: PLAYER, text: 'Oak Street at 5th Street', asked: false });
  });
}

describe('emergency hold', () => {
  it('lets the player key up through the hold: Code 4 by radio clears the emergency and releases the channel', () => {
    const rig = makeRig();
    fakeDispatch(rig);
    rig.radio.emergencyButton();
    rig.run(20);
    expect(rig.radio.isHeld('dispatch')).toBe(true);
    rig.radio.playerRequest({ kind: 'code4' }, 'radio');
    rig.run(60);
    expect(requests(rig)).toEqual(['emergency', 'code4']);
    expect(rig.radio.isHeld('dispatch')).toBe(false);
    expect(starts(rig).map((t) => t.kind)).toContain('emergencyClear');
  });

  it('Code 4 sent while the emergency alert is on the air waits for it instead of being stepped on', () => {
    const rig = makeRig();
    fakeDispatch(rig);
    rig.radio.emergencyButton();
    // Into the dispatcher's emergency alert.
    expect(rig.radio.isHeld('dispatch')).toBe(true);
    let n = 0;
    while (!starts(rig).some((t) => t.kind === 'emergencyAlert') && n++ < 1200) rig.run(1 / 60);
    rig.radio.playerRequest({ kind: 'code4' }, 'radio');
    rig.run(40);
    const code4 = starts(rig).find((t) => t.kind === 'code4');
    expect(code4?.blocked).toBe(false);
    expect(requests(rig)).toEqual(['emergency', 'code4']);
    expect(rig.radio.isHeld('dispatch')).toBe(false);
  });

  it('the emergency line pre-empts a busy channel and is never answered with "you were blocked"', () => {
    const rig = makeRig();
    fakeDispatch(rig);
    rig.radio.say('dispatch', 'a long dispatcher message that is still going on when the unit hits the emergency button');
    rig.run(1);
    rig.radio.emergencyButton();
    rig.run(20);
    rig.radio.playerRequest({ kind: 'code4' }, 'radio');
    rig.run(60);
    const emergency = starts(rig).find((t) => t.kind === 'playerEmergency');
    expect(emergency?.blocked).toBe(false);
    expect(starts(rig).map((t) => t.kind)).not.toContain('blocked');
  });

  it('status checks still go on the air during a hold', () => {
    const rig = makeRig();
    fakeDispatch(rig);
    rig.radio.emergencyButton();
    rig.run(10);
    rig.bus.emit('dispatch:statusCheck', { callsign: PLAYER, attempt: 1, escalated: false, location: '' });
    rig.run(15);
    expect(starts(rig).map((t) => t.kind)).toContain('statusCheck');
  });
});

describe('10-20 exchange', () => {
  it('a status check answered by another request does not turn the next 10-20 request into an answer', () => {
    const rig = makeRig();
    fakeDispatch(rig);
    rig.bus.on('unit:request', (e) => {
      if (e.request.kind === 'code4') rig.bus.emit('dispatch:ack', { callsign: PLAYER, kind: 'code4', ok: true, text: 'Code 4' });
    });
    rig.bus.emit('dispatch:statusCheck', { callsign: PLAYER, attempt: 2, escalated: false, location: '' });
    rig.bus.emit('dispatch:location', { callsign: PLAYER, text: '', asked: true });
    rig.run(15);
    rig.radio.playerRequest({ kind: 'code4' }, 'radio');
    rig.run(30);
    rig.radio.playerRequest({ kind: 'location' }, 'radio');
    rig.run(20);
    const kinds = starts(rig).map((t) => t.kind);
    const req = kinds.lastIndexOf('locationRequest');
    expect(req).toBeGreaterThan(0);
    expect(kinds.slice(req)).toContain('locationGive');
    expect(kinds).not.toContain('locationAnswer');
  });

  it('asks "what is your 10-20" after the second status check, whatever the seed', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rig = makeRig({ seed });
      rig.bus.emit('dispatch:statusCheck', { callsign: PLAYER, attempt: 2, escalated: false, location: '' });
      rig.bus.emit('dispatch:location', { callsign: PLAYER, text: '', asked: true });
      rig.run(15);
      const kinds = starts(rig).map((t) => t.kind);
      expect(kinds.indexOf('statusCheckRepeat'), `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(kinds.indexOf('locationAsk'), `seed ${seed}`).toBeGreaterThan(kinds.indexOf('statusCheckRepeat'));
    }
  });

  it('an unblocked answer to "what is your 10-20" is acknowledged', () => {
    const rig = makeRig();
    fakeDispatch(rig);
    rig.bus.emit('dispatch:location', { callsign: PLAYER, text: '', asked: true });
    rig.run(10);
    rig.radio.playerRequest({ kind: 'location' }, 'radio');
    rig.run(20);
    const kinds = starts(rig).map((t) => t.kind);
    expect(kinds).toContain('locationAnswer');
    expect(kinds.at(-1)).toBe('dispatchAck');
  });
});

describe('review round 2', () => {
  it('"say again" after being stepped on replays the stepped-on line, not "you were blocked"', () => {
    const rig = makeRig();
    rig.radio.say('dispatch', 'placeholder');
    rig.run(5);
    const call = rig.cad.createCall(
      { typeId: 'alarm', priority: 3, location: { x: 0, z: -250, edge: 0, text: '248 N Oak Street', street: 'Oak Street', cross: '5th Street', near: '200 block of N Oak Street', district: 'Downtown' }, caller: { kind: 'alarm', name: 'Alarm Co', phone: '', personId: -1 }, narrative: 'Alarm', selfInitiated: false },
      { sim: rig.time, game: 50400 },
    );
    rig.bus.emit('dispatch:offer', { callId: call.id, callsign: PLAYER, expired: false });
    while (!starts(rig).some((t) => t.kind === 'offer')) rig.run(0.1);
    rig.run(0.5);
    rig.radio.playerRequest({ kind: 'status', status: 'busy' }, 'voice');
    rig.run(15);
    rig.radio.playerRequest({ kind: 'repeat' }, 'radio');
    rig.run(15);
    const kinds = starts(rig).map((t) => t.kind).filter((k) => k !== 'console');
    expect(kinds).toEqual(['offer', 'status', 'blocked', 'repeatRequest', 'offer']);
    const offers = starts(rig).filter((t) => t.kind === 'offer');
    expect(offers[1]?.text).toBe(offers[0]?.text);
  });

  it('a 10-20 answer sent on a channel without requests leaves the question standing', () => {
    const rig = makeRig();
    fakeDispatch(rig);
    rig.bus.emit('dispatch:location', { callsign: PLAYER, text: '', asked: true });
    rig.run(10);
    rig.radio.selectChannel('fireEms');
    rig.radio.playerRequest({ kind: 'location' }, 'radio');
    rig.run(15);
    rig.radio.selectChannel('dispatch');
    rig.radio.playerRequest({ kind: 'location' }, 'radio');
    rig.run(15);
    const kinds = starts(rig).map((t) => t.kind);
    expect(kinds.filter((k) => k === 'locationAnswer')).toHaveLength(2);
    expect(kinds).not.toContain('locationRequest');
    expect(kinds.at(-1)).toBe('dispatchAck');
  });

  it('radio silence during an emergency: AI status traffic is not queued and "resume normal traffic" goes first', () => {
    const rig = makeRig();
    rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: true, units: ['21'], location: 'Oak Street at 5th Street' });
    rig.run(10);
    for (let i = 0; i < 6; i++) {
      const cs = i % 2 === 0 ? '21' : '23';
      rig.cad.setUnitStatus(cs, i % 4 < 2 ? 'outOfService' : 'available', { sim: rig.time, game: 50400 }, 'auto');
      rig.run(20);
    }
    expect(rig.radio.queued).toBe(0);
    rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: false, units: [], location: '' });
    rig.run(10);
    const after = starts(rig).map((t) => t.kind);
    expect(after.at(-1)).toBe('emergencyClear');
  });

  it('refusals read in the selected radio language, without a doubled "unable"', () => {
    const rig = makeRig({ mode: 'plain' });
    rig.bus.on('unit:request', (e) => {
      if (e.request.kind === 'status') rig.bus.emit('dispatch:ack', { callsign: PLAYER, kind: 'status', ok: false, text: 'Unable: 10-8 AVAILABLE to 10-15 TRANSPORTING' });
    });
    rig.radio.playerRequest({ kind: 'status', status: 'transporting' }, 'voice');
    rig.run(15);
    const refused = starts(rig).find((t) => t.kind === 'refused');
    expect(refused).toBeDefined();
    expect(refused?.text).not.toMatch(/10-/);
    expect(refused?.text.toLowerCase().match(/unable/g)).toHaveLength(1);
  });

  it('a radio-menu request waits for the clear channel instead of stepping on the dispatcher', () => {
    const rig = makeRig();
    rig.radio.say('dispatch', 'all units be advised of a long bulletin about road works on the north side of the city');
    rig.run(0.5);
    rig.radio.say('dispatch', 'a second routine bulletin queued behind the first');
    rig.radio.playerRequest({ kind: 'status', status: 'available' }, 'radio');
    rig.run(30);
    expect(rig.events.filter((e) => e.topic === 'radio:blocked')).toHaveLength(0);
    expect(requests(rig)).toEqual(['status']);
    // The player keys up first when the channel clears.
    expect(starts(rig).map((t) => t.kind).slice(0, 3)).toEqual(['console', 'status', 'console']);
  });

  it('units sent to an officer emergency are named by the broadcast only: no assign lines after Code 4', () => {
    const rig = makeRig();
    rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: true, units: ['21'], location: 'Oak Street at 5th Street' });
    const loc = { x: 0, z: -250, edge: 0, text: '248 N Oak Street', street: 'Oak Street', cross: '5th Street', near: '200 block of N Oak Street', district: 'Downtown' };
    const t = { sim: rig.time, game: 50400 };
    const call = rig.cad.createCall({ typeId: 'officerEmergency', priority: 1, location: loc, caller: { kind: 'officer', name: 'Unit 12', phone: '', personId: -1 }, narrative: 'Emergency', selfInitiated: true }, t);
    rig.cad.assign(call.id, '21', t, 'dispatch');
    rig.run(20);
    rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: false, units: [], location: '' });
    rig.run(20);
    const kinds = starts(rig).map((x) => x.kind);
    expect(kinds).not.toContain('assign');
    expect(kinds).not.toContain('unitAck');
    expect(kinds).toContain('emergencyClear');
  });

  it('the radio language does not change radio timing (durations and request steps)', () => {
    const run = (mode: 'tenCode' | 'plain'): { durations: number[]; requestAt: number[] } => {
      const rig = makeRig({ mode, quiet: false });
      const requestAt: number[] = [];
      rig.bus.on('unit:request', () => requestAt.push(Math.round(rig.time * 60)));
      rig.run(30);
      rig.radio.playerRequest({ kind: 'status', status: 'enRoute' }, 'radio');
      rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: true, units: ['21', '23'], location: '' });
      rig.run(60);
      rig.radio.playerRequest({ kind: 'code4' }, 'radio');
      rig.run(60);
      return { durations: starts(rig).map((t) => t.duration), requestAt };
    };
    const a = run('tenCode');
    const b = run('plain');
    expect(b.durations).toEqual(a.durations);
    expect(b.requestAt).toEqual(a.requestAt);
  });
});
