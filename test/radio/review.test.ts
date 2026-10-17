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
