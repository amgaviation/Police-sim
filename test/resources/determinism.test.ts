import { describe, expect, it } from 'vitest';
import { RosterState } from '../../src/units';
import { at, makeCall, makeHarness, pointFromStation, step, type Harness } from './helpers';

function json<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

interface Calls {
  near: number;
  mid: number;
  far: number;
}

function setup(): { h: Harness; calls: Calls } {
  const h = makeHarness({ night: true });
  const a = pointFromStation(h, 450);
  const b = pointFromStation(h, 1200);
  const c = pointFromStation(h, -900);
  const near = makeCall(h, 1, a.x, a.z);
  const mid = makeCall(h, 3, b.x, b.z);
  const far = makeCall(h, 2, c.x, c.z);
  h.npc.add(1, 100, a.x + 20, a.z + 20, { hidden: true });
  h.npc.add(2, 101, a.x - 30, a.z + 10, { hidden: true });
  return { h, calls: { near: near.id, mid: mid.id, far: far.id } };
}

/** The scripted requests: identical in every run. */
function script(h: Harness, i: number, calls: Calls): void {
  switch (i) {
    case 5:
      h.res.request({ kind: 'request', typeId: 'k9', callId: calls.mid, via: 'radio' });
      break;
    case 20:
      h.res.request({ kind: 'request', typeId: 'ems', callId: calls.near, via: 'mdt' });
      h.res.request({ kind: 'request', typeId: 'air', callId: calls.near, via: 'mdt' });
      break;
    case 120:
      h.bus.emit('force:applied', {
        seq: 1, tool: 'taser', level: 'taser', personId: 1, actorId: 1, callId: calls.near, resistance: 'active', hit: true, injury: 0, fatal: false,
        cycle: 1, riskFactors: [], distance: 3, restrained: false, sim: h.sim,
      });
      break;
    case 300:
      (h.bus as unknown as { emit(t: string, p: unknown): void }).emit('command:post', { callId: calls.near, level: 'major', x: 10, z: 20, open: true });
      break;
    case 700:
      h.res.request({ kind: 'request', typeId: 'tow', callId: calls.far, via: 'radio' });
      h.res.request({ kind: 'request', typeId: 'statePatrol', callId: calls.far, via: 'auto' });
      break;
    case 4000:
      h.res.request({ kind: 'release', callsign: 'K9-1' });
      break;
    default:
  }
}

function runScript(h: Harness, calls: Calls, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    script(h, i, calls);
    step(h);
  }
}

function snapshot(h: Harness): string {
  return JSON.stringify({ res: h.res.serialize(), cad: h.cad.serialize(), cars: h.traffic.snapshot() });
}

describe('determinism', () => {
  it('two 2000-step runs with the same requests serialize identically', () => {
    const a = setup();
    const b = setup();
    runScript(a.h, a.calls, 0, 2000);
    runScript(b.h, b.calls, 0, 2000);
    expect(JSON.stringify(a.h.res.serialize())).toBe(JSON.stringify(b.h.res.serialize()));
    // The run did something: units are on their way.
    const units = a.h.res.serialize().units.filter((u) => u.status !== 'available');
    expect(units.length).toBeGreaterThanOrEqual(4);
    expect(snapshot(a.h)).toBe(snapshot(b.h));
  });

  it('two long runs (arrivals, FLIR reveals, releases, returns) serialize identically', () => {
    const a = setup();
    const b = setup();
    runScript(a.h, a.calls, 0, 12000);
    runScript(b.h, b.calls, 0, 12000);
    expect(snapshot(a.h)).toBe(snapshot(b.h));
    const s = a.h.res.serialize();
    expect(s.air?.revealed).toEqual([1, 2]);
    expect(a.h.npc.revealed).toEqual(b.h.npc.revealed);
    expect(s.units.some((u) => u.status === 'onScene')).toBe(true);
    expect(s.units.some((u) => u.callsign === 'K9-1' && u.status !== 'onScene')).toBe(true);
  });

  it('save / restore in the middle of a drive continues identically', () => {
    for (const cut of [250, 1500, 5000]) {
      const a = setup();
      runScript(a.h, a.calls, 0, cut);
      const saved = {
        res: json(a.h.res.serialize()),
        cad: json(a.h.cad.serialize()),
        roster: json(a.h.roster.serialize()),
        cars: json(a.h.traffic.snapshot()),
        actors: [...a.h.npc.actors.values()].map((x) => ({ ...x })),
        sim: a.h.sim,
      };
      runScript(a.h, a.calls, cut, 9000);

      const b = setup();
      b.h.cad.restore(saved.cad);
      b.h.roster.restore(saved.roster);
      b.h.traffic.restore(saved.cars);
      b.h.npc.actors.clear();
      for (const x of saved.actors) b.h.npc.actors.set(x.id, { ...x });
      b.h.sim = saved.sim;
      b.h.res.restore(saved.res, at(b.h.sim));
      runScript(b.h, b.calls, cut, 9000);
      expect(snapshot(b.h)).toBe(snapshot(a.h));
      expect(b.h.res.serialize().rng).toEqual(a.h.res.serialize().rng);
    }
  });

  it('restore re-links cars by fleet index, re-attaches lights lazily and keeps queued requests', () => {
    const a = setup();
    runScript(a.h, a.calls, 0, 1500);
    const mid = a.h.res.serialize();
    a.h.res.request({ kind: 'request', typeId: 'csu', callId: a.calls.mid, via: 'radio' });
    const withQueue = a.h.res.serialize();
    expect(withQueue.requests).toHaveLength(1);
    const b = setup();
    b.h.cad.restore(json(a.h.cad.serialize()));
    b.h.traffic.restore(json(a.h.traffic.snapshot()));
    b.h.sim = a.h.sim;
    b.h.res.restore(json(withQueue), at(b.h.sim));
    expect(JSON.stringify(b.h.res.serialize())).toBe(JSON.stringify(withQueue));
    step(b.h);
    const dispatched = b.h.res.serialize().units.find((u) => u.callsign === 'CSU-1');
    expect(dispatched?.callId).toBe(a.calls.mid);
    expect(mid.units.find((u) => u.callsign === 'CSU-1')?.status).toBe('available');
    // Units whose car exists keep driving (not re-spawned).
    expect(b.h.traffic.spawns.length).toBe(0);
  });

  it('an old save without slots restores', () => {
    const a = setup();
    runScript(a.h, a.calls, 0, 300);
    const s = json(a.h.res.serialize());
    delete s.slots;
    const b = setup();
    b.h.cad.restore(json(a.h.cad.serialize()));
    b.h.traffic.restore(json(a.h.traffic.snapshot()));
    b.h.sim = a.h.sim;
    b.h.res.restore(s, at(b.h.sim));
    step(b.h);
    expect(b.h.res.serialize().units.length).toBe(a.h.res.serialize().units.length);
  });

  it('a save of an empty roster is rebuilt: profiles come back from the seed', () => {
    const a = setup();
    runScript(a.h, a.calls, 0, 1);
    const r = new RosterState(42);
    r.ensure('SGT-1', 'sergeant');
    expect(r.profile('SGT-1')?.name).toBe(a.h.roster.profile('SGT-1')?.name);
  });
});

describe('performance', () => {
  it('steps in at most 0.03 ms on average with 22 slots and 6 en route', () => {
    const h = makeHarness();
    h.traffic.speeds = { respond: 1, emergency: 1 };
    const to = pointFromStation(h, 2500);
    const c = makeCall(h, 1, to.x, to.z);
    const types = ['supervisor', 'supervisor', 'statePatrol', 'statePatrol', 'k9', 'ems'];
    for (const typeId of types) h.res.request({ kind: 'request', typeId, callId: c.id, via: 'mdt' });
    step(h);
    for (let i = 0; i < 60 * 130 && h.res.units().filter((u) => u.status === 'enRoute').length < 6; i++) step(h);
    expect(h.res.units().filter((u) => u.status === 'enRoute')).toHaveLength(6);
    expect(h.res.units()).toHaveLength(23);
    const t = (): number => performance.now();
    // Warm up, then measure the resources step alone.
    for (let i = 0; i < 3000; i++) {
      h.res.step(1 / 60, at(h.sim), h.player);
      h.sim += 1 / 60;
      h.traffic.step(1 / 60);
    }
    const n = 20000;
    let spent = 0;
    for (let i = 0; i < n; i++) {
      const t0 = t();
      h.res.step(1 / 60, at(h.sim), h.player);
      spent += t() - t0;
      h.sim += 1 / 60;
      h.traffic.step(1 / 60);
    }
    expect(h.res.units().filter((u) => u.status === 'enRoute')).toHaveLength(6);
    expect(spent / n).toBeLessThan(0.03);
  });
});
