import { describe, expect, it } from 'vitest';
import { CadState } from '../../src/cad/cadState';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import { defaultRadioSave, isRadioSave, type RadioSave } from '../../src/radio/save';
import { at, CALL_LOCATION, makeRig, PLAYER, requests, type Rig } from './helpers';

function script(rig: Rig, phase: number): void {
  const t = at(rig.time);
  switch (phase) {
    case 0: {
      const call = rig.cad.createCall(
        { typeId: 'trafficHazard', priority: 2, location: CALL_LOCATION, caller: { kind: 'citizen', name: 'A', phone: '1', personId: 1 }, narrative: 'x' },
        t,
      );
      rig.cad.assign(call.id, '21', t, 'dispatch');
      rig.radio.playerRequest({ kind: 'runPlate', plate: 'ABC 1234', vehicleId: 4 }, 'radio');
      break;
    }
    case 1:
      rig.cad.setUnitStatus('21', 'onScene', t, 'auto');
      rig.bus.emit('dispatch:statusCheck', { callsign: PLAYER, attempt: 1, escalated: false, location: '' });
      rig.radio.playerRequest({ kind: 'code4' }, 'radio');
      break;
    case 2:
      rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: true, units: ['23'], location: 'Oak Street at 5th Street' });
      rig.radio.toggleScan();
      break;
    case 3:
      rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: false, units: [], location: '' });
      rig.bus.emit('dispatch:ack', { callsign: PLAYER, kind: 'code4', ok: true, text: '' });
      rig.radio.playerRequest({ kind: 'repeat' }, 'radio');
      break;
    default:
      break;
  }
}

function newBus(): EventBus<EventMap> {
  return new EventBus<EventMap>((topic, error) => {
    throw new Error(`${topic}: ${String(error)}`);
  });
}

describe('radio save', () => {
  it('defaultRadioSave is valid and matches the design defaults', () => {
    const rng = createRng(99).stream('radio');
    const s = defaultRadioSave(rng.state());
    expect(isRadioSave(s)).toBe(true);
    expect(s).toMatchObject({ version: 1, selected: 'dispatch', scanning: false, scanList: ['dispatch', 'tac', 'fireEms'], log: [], queue: [], holds: [], ambientNext: {}, lastToPlayer: -1 });
    expect(s.rng).toEqual(rng.state());
    expect(isRadioSave(JSON.parse(JSON.stringify(s)))).toBe(true);
  });

  it('a live save validates (also after JSON) and malformed ones are rejected', () => {
    const rig = makeRig({ quiet: false });
    script(rig, 0);
    rig.run(3);
    const s = rig.radio.serialize();
    expect(s.queue.some((q) => q.start >= 0)).toBe(true);
    expect(isRadioSave(s)).toBe(true);
    const json = JSON.parse(JSON.stringify(s)) as RadioSave;
    expect(isRadioSave(json)).toBe(true);
    const bad = (patch: (x: Record<string, unknown>) => void) => {
      const c = structuredClone(json) as unknown as Record<string, unknown>;
      patch(c);
      return isRadioSave(c);
    };
    expect(isRadioSave(null)).toBe(false);
    expect(bad((c) => (c.version = 2))).toBe(false);
    expect(bad((c) => (c.selected = 'police'))).toBe(false);
    expect(bad((c) => (c.scanList = ['dispatch', 7]))).toBe(false);
    expect(bad((c) => (c.holds = 'dispatch'))).toBe(false);
    expect(bad((c) => (c.log = [{ id: 1 }]))).toBe(false);
    expect(bad((c) => ((c.queue as Record<string, unknown>[])[0] = { ...(c.queue as Record<string, unknown>[])[0], via: 'pager' }))).toBe(false);
    expect(bad((c) => (c.nextId = 0))).toBe(false);
    expect(bad((c) => (c.rng = { seed: 1, s: [1, 2, 3] }))).toBe(false);
    expect(bad((c) => (c.ambientNext = { pager: 3 }))).toBe(false);
    expect(bad((c) => (c.ambientNext = { dispatch: 'soon' }))).toBe(false);
    expect(bad((c) => (c.composer = { pending: 3 }))).toBe(false);
    expect(bad((c) => delete c.lastToPlayer)).toBe(false);
    // optional additions may be absent
    expect(bad((c) => {
      delete c.time;
      delete c.player;
      delete c.composer;
    })).toBe(true);
  });

  it('restore continues identically: two radios fed the same events produce the same logs', () => {
    const a = makeRig({ quiet: false, seed: 31 });
    script(a, 0);
    a.run(1.2); // the player's plate request is on the air, the assignment queued
    // Save A, restore into a fresh radio B on its own bus and CAD.
    const busB = newBus();
    const cadB = new CadState(busB);
    cadB.restore(a.cad.serialize());
    const b = makeRig({ quiet: false, seed: 31, bus: busB, cad: cadB });
    b.radio.restore(JSON.parse(JSON.stringify(a.radio.serialize())) as RadioSave);
    b.time = a.time;
    a.events.length = 0;
    for (let phase = 1; phase <= 4; phase++) {
      a.run(40);
      b.run(40);
      script(a, phase);
      script(b, phase);
    }
    a.run(120);
    b.run(120);
    expect(b.radio.log.length).toBeGreaterThan(20);
    expect(JSON.stringify(b.radio.log)).toBe(JSON.stringify(a.radio.log));
    expect(JSON.stringify(b.radio.serialize())).toBe(JSON.stringify(a.radio.serialize()));
    // The request riding on the transmission that was on the air at save time is delivered by B too.
    expect(requests(b)).toEqual(requests(a));
    expect(requests(b)[0]).toEqual({ callsign: PLAYER, request: { kind: 'runPlate', plate: 'ABC 1234', vehicleId: 4 }, via: 'radio' });
  });

  it('restore keeps holds and the selected channel; emits nothing', () => {
    const a = makeRig();
    a.bus.emit('dispatch:emergency', { callsign: PLAYER, active: true, units: [], location: '' });
    a.radio.selectChannel('county');
    const s = a.radio.serialize();
    const b = makeRig();
    b.events.length = 0;
    b.radio.restore(s);
    expect(b.events).toEqual([]);
    expect(b.radio.isHeld('dispatch')).toBe(true);
    expect(b.radio.selected).toBe('county');
    expect(b.radio.queued).toBe(1);
  });
});
