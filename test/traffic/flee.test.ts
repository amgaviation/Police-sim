import { describe, expect, it } from 'vitest';
import { spawn } from '../../src/ecs/world';
import pulloverJson from '../../src/data/traffic/pullover.json';
import type { CommandContext } from '../../src/debug/console';
import { createTrafficCommands } from '../../src/traffic/commands';
import { PULLOVER, validatePullover } from '../../src/traffic/data';
import type { TrafficCollisionEvent, TrafficFleeEndedEvent, TrafficFleeingEvent, TrafficReleasedEvent } from '../../src/traffic/events';
import { MPH } from '../../src/world/constants';
import {
  BEHAVIOR,
  PULL,
  TRAFFIC_STATE,
  isTrafficSnapshot,
  type FleeState,
} from '../../src/traffic/trafficSystem';
import { LIGHT, VehicleLook } from '../../src/vehicles/components';
import { generateCity } from '../../src/world/generate';
import { JUNCTION, laneEdge, laneRef } from '../../src/world/roadGraph';
import { DT, NOON, carInfo, crossGraph, followCar, gridGraph, lineGraph, makeHarness, runFor, type Harness } from './helpers';

/** The Node pieces the allocation test needs (the project has no Node type definitions). */
declare const process: { memoryUsage(): { heapUsed: number } };
interface NodeModules {
  v8: { setFlagsFromString(flags: string): void };
  vm: { runInNewContext(code: string): unknown };
}

async function loadGc(): Promise<() => void> {
  const names: Record<keyof NodeModules, string> = { v8: 'node:v8', vm: 'node:vm' };
  const v8 = (await import(/* @vite-ignore */ names.v8)) as NodeModules['v8'];
  const vm = (await import(/* @vite-ignore */ names.vm)) as NodeModules['vm'];
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

const FLEE = PULLOVER.flee;
const LIMIT = 40 * MPH;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Runs `fn` with `PULLOVER.flee` fields overridden, restoring them afterwards. */
async function withFlee<T>(overrides: Partial<Mutable<typeof FLEE>>, fn: () => Promise<T>): Promise<T> {
  const flee = FLEE as Mutable<typeof FLEE>;
  const saved = { ...flee };
  Object.assign(flee, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(flee, saved);
  }
}

async function harness(graph = lineGraph(), seed = 7): Promise<Harness> {
  const h = await makeHarness(graph, seed);
  h.sys.densityScale = 0;
  return h;
}

interface Events {
  fleeing: TrafficFleeingEvent[];
  ended: TrafficFleeEndedEvent[];
  released: TrafficReleasedEvent[];
  despawned: number[];
}

function listen(h: Harness): Events {
  const ev: Events = { fleeing: [], ended: [], released: [], despawned: [] };
  h.bus.on('traffic:fleeing', (e) => ev.fleeing.push(e));
  h.bus.on('traffic:fleeEnded', (e) => ev.ended.push(e));
  h.bus.on('traffic:released', (e) => ev.released.push(e));
  h.bus.on('traffic:despawned', (e) => ev.despawned.push(e.vehicleId));
  return ev;
}

/** Keeps the focus `behind` m behind car `id` along x. */
function follow(h: Harness, id: number, behind = 10): (t: number) => void {
  return () => {
    const slot = h.sys.slotOfVehicle(id);
    if (slot < 0) return;
    h.focus.x = (h.sys.view.x[slot] ?? 0) - behind;
    h.focus.z = h.sys.view.z[slot] ?? 0;
  };
}

function fleeState(): FleeState {
  return { x: 0, z: 0, yaw: 0, speed: 0, edge: 0 };
}

const ID = 77;

describe('flee mode', () => {
  it('drives faster than the limit, capped by maxSpeed, and reports its state', async () => {
    const h = await harness();
    h.sys.spawnAt(laneRef(0, 0, 0), 500, { vehicleId: ID, speed: 10, behavior: 0, desiredFactor: 1 });
    const ev = listen(h);
    expect(h.sys.fleeingCount).toBe(0);
    expect(h.sys.fleeState(ID, fleeState())).toBe(false);
    expect(h.sys.flee(ID)).toBe(true);
    expect(h.sys.flee(ID)).toBe(false);
    expect(h.sys.flee(999)).toBe(false);
    expect(ev.fleeing).toEqual([{ eid: h.sys.view.eid[0], vehicleId: ID }]);
    expect(h.sys.fleeingCount).toBe(1);
    runFor(h, 0, 12, follow(h, ID));
    const out = fleeState();
    expect(h.sys.fleeState(ID, out)).toBe(true);
    expect(out.speed).toBeGreaterThan(LIMIT * 1.2);
    expect(out.speed).toBeLessThanOrEqual(Math.min(LIMIT * FLEE.speedFactor, FLEE.maxSpeed) + 0.01);
    expect(out.edge).toBe(0);
    expect(h.sys.view.x[0] ?? 0).toBeGreaterThan(500 - 1500 + 100);
  });

  it('chooses the exit leading away from the focus at junctions', async () => {
    const h = await harness(crossGraph(JUNCTION.none));
    // Focus in the east: the straight-on exit ends 100 m from it, the left and right ones ~1300 m.
    h.focus.x = 900;
    h.focus.z = 0;
    runFor(h, 0, DT);
    let fleeEast = 0;
    let normalEast = 0;
    const trials = 60;
    for (let i = 0; i < trials; i++) {
      for (const flee of [false, true]) {
        h.sys.spawnAt(laneRef(0, 0, 0), 900, { vehicleId: 100 + i, speed: 5, behavior: 0 });
        if (flee) expect(h.sys.flee(100 + i)).toBe(true);
        const info = h.sys.inspect(h.sys.slotOfVehicle(100 + i), carInfo());
        if (laneEdge(info.nextLane) === 1) {
          if (flee) fleeEast++;
          else normalEast++;
        }
        expect(h.sys.removeVehicle(100 + i)).toBe(true);
      }
    }
    // awayBias 0.75: straight-on is only picked in a third of the remaining quarter.
    expect(fleeEast).toBeLessThan(trials * 0.2);
    expect(normalEast).toBeGreaterThan(trials * 0.2);
  });

  it('runs a red signal at crossSpeed once the junction is free, where an ordinary car stops', async () => {
    const crossing = async (flee: boolean): Promise<{ speedAtLine: number; time: number; passed: boolean }> => {
      const h = await harness(crossGraph(JUNCTION.signal));
      h.sys.spawnAt(laneRef(0, 0, 0), 880, { vehicleId: ID, speed: 12, behavior: 0, desiredFactor: 1 });
      if (flee) h.sys.flee(ID);
      // Group 0 is red from 24 s to 51 s.
      let t = 26;
      let speedAtLine = -1;
      let time = 0;
      for (let i = 0; i < 20 * 60 && speedAtLine < 0; i++) {
        t = runFor(h, t, DT);
        const slot = h.sys.slotOfVehicle(ID);
        if (h.sys.inspect(slot, carInfo()).inJunction) {
          speedAtLine = h.sys.view.speed[slot] ?? 0;
          time = t;
        }
      }
      return { speedAtLine, time, passed: speedAtLine >= 0 };
    };
    const fleeing = await crossing(true);
    expect(fleeing.passed).toBe(true);
    expect(fleeing.time).toBeLessThan(51);
    expect(fleeing.speedAtLine).toBeGreaterThan(FLEE.crossSpeed - 1.5);
    expect(fleeing.speedAtLine).toBeLessThan(FLEE.crossSpeed + 1.5);
    const ordinary = await crossing(false);
    // The ordinary car waits for the green (or passes only after 51 s).
    expect(ordinary.passed && ordinary.time < 51).toBe(false);
  });

  it('waits for a car crossing the junction before running the red', async () => {
    const h = await harness(crossGraph(JUNCTION.signal));
    // A cross-street car on its green-to-red edge holds the node; the fleeing car must not enter the box meanwhile.
    h.sys.spawnAt(laneRef(0, 0, 0), 940, { vehicleId: ID, speed: 12, behavior: 0, desiredFactor: 1 });
    h.sys.flee(ID);
    h.sys.spawnAt(laneRef(2, 0, 0), 975, { vehicleId: 88, speed: 8, behavior: 0, desiredFactor: 1 });
    let t = 26;
    // Group 1 (north-south) is green from 25.5 s: car 88 enters and holds the node; car 77 never overlaps it in the box.
    let worst = Infinity;
    for (let i = 0; i < 6 * 60; i++) {
      t = runFor(h, t, DT);
      const a = h.sys.slotOfVehicle(ID), b = h.sys.slotOfVehicle(88);
      if (a < 0 || b < 0) continue;
      const d = Math.hypot((h.sys.view.x[a] ?? 0) - (h.sys.view.x[b] ?? 0), (h.sys.view.z[a] ?? 0) - (h.sys.view.z[b] ?? 0));
      worst = Math.min(worst, d);
    }
    expect(worst).toBeGreaterThan(2);
  });

  it('is never a stop or yield target, and never yields to a siren', async () => {
    const h = await harness();
    h.sys.spawnAt(laneRef(0, 0, 0), 600, { vehicleId: ID, speed: 12, behavior: 0, desiredFactor: 1 });
    h.sys.flee(ID);
    expect(h.sys.forceStop(ID)).toBe(false);
    let yielded = false;
    for (let i = 0; i < 6 * 60; i++) {
      followCar(h, h.sys.slotOfVehicle(ID), 25, true, true);
      runFor(h, i * DT, DT);
      const slot = h.sys.slotOfVehicle(ID);
      if (h.sys.inspect(slot, carInfo()).pull === PULL.yielding) yielded = true;
    }
    expect(yielded).toBe(false);
    expect(h.sys.stopVehicleId).toBe(-1);
    // Light bar only: the stop detector ignores it too.
    for (let i = 0; i < 4 * 60; i++) {
      followCar(h, h.sys.slotOfVehicle(ID), 15, true, false);
      runFor(h, 6 + i * DT, DT);
    }
    expect(h.sys.stopVehicleId).toBe(-1);
  });

  it('escapes after loseS beyond loseDistanceM: fleeEnded then the car despawns', async () => {
    const h = await harness();
    const ev = listen(h);
    h.focus.x = -1000;
    h.sys.spawnAt(laneRef(0, 0, 0), 1000, { vehicleId: ID, speed: 10, behavior: 0, desiredFactor: 1 });
    h.sys.flee(ID);
    // Starts 500 m from the focus (> 450 m) and drives away.
    const t = runFor(h, 0, FLEE.loseS - 1);
    expect(ev.ended).toHaveLength(0);
    expect(h.sys.slotOfVehicle(ID)).toBeGreaterThanOrEqual(0);
    runFor(h, t, 2);
    expect(ev.ended).toHaveLength(1);
    expect(ev.ended[0]?.reason).toBe('escaped');
    expect(ev.ended[0]?.vehicleId).toBe(ID);
    expect(ev.ended[0]?.x ?? 0).toBeGreaterThan(-600);
    expect(h.sys.slotOfVehicle(ID)).toBe(-1);
    expect(ev.despawned).toEqual([ID]);
    expect(h.sys.fleeingCount).toBe(0);
  });

  it('does not escape while it comes back within range', async () => {
    const h = await harness();
    const ev = listen(h);
    h.focus.x = -1000;
    h.sys.spawnAt(laneRef(0, 0, 0), 1000, { vehicleId: ID, speed: 10, behavior: 0, desiredFactor: 1 });
    h.sys.flee(ID);
    let t = runFor(h, 0, FLEE.loseS - 2);
    h.focus.x = (h.sys.view.x[0] ?? 0) - 50;
    t = runFor(h, t, 5);
    h.focus.x = -1000;
    runFor(h, t, FLEE.loseS - 2);
    expect(ev.ended).toHaveLength(0);
    expect(h.sys.fleeingCount).toBe(1);
  });

  it('gives up after minFleeS (seeded): pulls to the curb, parks with hazards, stays pinned', async () => {
    const run = async (): Promise<{ at: TrafficFleeEndedEvent | undefined; pull: number; x: number }> =>
      withFlee({ giveUpPerMin: 3600, minFleeS: 3 }, async () => {
        const h = await harness(lineGraph(), 21);
        const ev = listen(h);
        h.sys.spawnAt(laneRef(0, 0, 0), 300, { vehicleId: ID, speed: 10, behavior: 0, desiredFactor: 1 });
        h.sys.flee(ID);
        const t = runFor(h, 0, 2.5, follow(h, ID));
        expect(ev.ended).toHaveLength(0);
        const t2 = runFor(h, t, 25, follow(h, ID));
        expect(ev.ended).toHaveLength(1);
        expect(ev.ended[0]?.reason).toBe('gaveUp');
        const slot = h.sys.slotOfVehicle(ID);
        const info = h.sys.inspect(slot, carInfo());
        expect(h.sys.view.state[slot]).toBe(TRAFFIC_STATE.parked);
        expect(info.shoulder).toBeGreaterThan(1.5);
        expect((VehicleLook.lights[h.sys.view.eid[slot] ?? 0] ?? 0) & LIGHT.hazard).toBe(LIGHT.hazard);
        expect(h.sys.fleeingCount).toBe(0);
        // Still pinned: the focus leaving keeps it.
        h.focus.x = 3000;
        runFor(h, t2, 3);
        expect(h.sys.slotOfVehicle(ID)).toBeGreaterThanOrEqual(0);
        // The scene turns it into a stop.
        expect(h.sys.forceStop(ID)).toBe(true);
        return { at: ev.ended[0], pull: info.pull ?? -1, x: h.sys.view.x[slot] ?? 0 };
      });
    const a = await run();
    expect(a.pull).toBe(PULL.parked);
    expect(a.at?.x ?? 0).toBeGreaterThan(300 - 1500 + 3 * 10);
    const b = await run();
    expect(b).toEqual(a);
  });

  it('never gives up before minFleeS', async () => {
    await withFlee({ giveUpPerMin: 3600, minFleeS: 6 }, async () => {
      const h = await harness();
      const ev = listen(h);
      h.sys.spawnAt(laneRef(0, 0, 0), 300, { vehicleId: ID, speed: 10, behavior: 0, desiredFactor: 1 });
      h.sys.flee(ID);
      runFor(h, 0, 5.9, follow(h, ID));
      expect(ev.ended).toHaveLength(0);
      runFor(h, 5.9, 1.2, follow(h, ID));
      expect(ev.ended.map((e) => e.reason)).toEqual(['gaveUp']);
    });
  });

  it('stopFlee pulls to the curb and stops (reason stopped), still pinned', async () => {
    const h = await harness();
    const ev = listen(h);
    expect(h.sys.stopFlee(ID)).toBe(false);
    h.sys.spawnAt(laneRef(0, 0, 0), 300, { vehicleId: ID, speed: 10, behavior: 0, desiredFactor: 1 });
    h.sys.flee(ID);
    const t = runFor(h, 0, 4, follow(h, ID));
    expect(h.sys.stopFlee(ID)).toBe(true);
    expect(h.sys.stopFlee(ID)).toBe(false);
    expect(ev.ended.map((e) => e.reason)).toEqual(['stopped']);
    runFor(h, t, 30, follow(h, ID));
    const slot = h.sys.slotOfVehicle(ID);
    expect(h.sys.inspect(slot, carInfo()).pull).toBe(PULL.parked);
    expect(h.sys.view.speed[slot]).toBe(0);
    h.focus.x = 3000;
    runFor(h, 34, 3);
    expect(h.sys.slotOfVehicle(ID)).toBeGreaterThanOrEqual(0);
  });

  it('survives a physics contact (collision with fleeing: true); crashCar then ends it crashed', async () => {
    const city = generateCity(99);
    const h = await makeHarness(city.graph, 99, city);
    h.sys.densityScale = 0;
    h.physics.addGround(4000);
    h.focus.x = 256;
    h.focus.z = -512;
    const eid = h.sys.spawnSubjectCar(ID, 256, -512, { mode: 'driving' });
    expect(eid).toBeGreaterThan(0);
    expect(h.sys.flee(ID)).toBe(true);
    const ev = listen(h);
    const hits: TrafficCollisionEvent[] = [];
    h.bus.on('traffic:collision', (e) => hits.push(e));
    let t = 0;
    const stepOnce = (): void => {
      const slot = h.sys.slotOfVehicle(ID);
      h.focus.x = h.sys.view.x[slot] ?? 0;
      h.focus.z = h.sys.view.z[slot] ?? 0;
      t += DT;
      h.sys.step(DT, t, NOON, h.focus);
      h.physics.step();
    };
    for (let i = 0; i < 60; i++) stepOnce();
    expect(h.physics.has(eid)).toBe(true);
    const slot = h.sys.slotOfVehicle(ID);
    const box = spawn(h.world);
    h.physics.addBox(box, { x: h.sys.view.x[slot] ?? 0, y: 1.2, z: h.sys.view.z[slot] ?? 0 }, { x: 0.8, y: 0.5, z: 0.8 }, { mass: 1500 });
    for (let i = 0; i < 90; i++) stepOnce();
    // The contact is reported, but the pursuit module decides: the car is still fleeing.
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.fleeing).toBe(true);
    expect(hits[0]?.vehicleId).toBe(ID);
    expect(ev.ended).toHaveLength(0);
    expect(h.sys.view.state[h.sys.slotOfVehicle(ID)]).not.toBe(TRAFFIC_STATE.crashed);
    expect(h.sys.fleeingCount).toBe(1);
    expect(h.sys.crashCar(ID)).toBe(true);
    expect(ev.ended).toHaveLength(1);
    expect(ev.ended[0]?.reason).toBe('crashed');
    expect(h.sys.view.state[h.sys.slotOfVehicle(ID)]).toBe(TRAFFIC_STATE.crashed);
    expect(h.sys.fleeingCount).toBe(0);
    // The wreck stays for the scene (pinned) until it removes it.
    expect(h.sys.removeVehicle(ID)).toBe(true);
    h.physics.dispose();
  });

  it('a fleeing stop target ends the stop with released fled and drives off', async () => {
    const h = await harness();
    const ev = listen(h);
    h.sys.spawnAt(laneRef(0, 0, 0), 300, { vehicleId: ID, speed: 12, behavior: 0, desiredFactor: 1 });
    expect(h.sys.forceStop(ID)).toBe(true);
    const t = runFor(h, 0, 1.5, follow(h, ID));
    expect(h.sys.stopVehicleId).toBe(ID);
    expect(h.sys.flee(ID)).toBe(true);
    expect(ev.released).toEqual([{ eid: h.sys.view.eid[0], vehicleId: ID, reason: 'fled' }]);
    expect(h.sys.stopVehicleId).toBe(-1);
    expect(h.sys.releaseStop()).toBe(false);
    runFor(h, t, 15, follow(h, ID));
    const slot = h.sys.slotOfVehicle(ID);
    expect(h.sys.inspect(slot, carInfo()).pull).toBe(PULL.none);
    expect(h.sys.view.speed[slot]).toBeGreaterThan(LIMIT);
  });

  it('a fleeing car that had pulled over (stopped at the curb) merges back and flees', async () => {
    const h = await harness();
    const ev = listen(h);
    h.sys.spawnAt(laneRef(0, 0, 0), 300, { vehicleId: ID, speed: 12, behavior: 0, desiredFactor: 1 });
    expect(h.sys.forceStop(ID)).toBe(true);
    let pulled = 0;
    h.bus.on('traffic:pulledOver', () => pulled++);
    const t = runFor(h, 0, 30, follow(h, ID));
    expect(pulled).toBe(1);
    expect(h.sys.inspect(h.sys.slotOfVehicle(ID), carInfo()).pull).toBe(PULL.stopped);
    expect(h.sys.flee(ID)).toBe(true);
    expect(ev.released.map((e) => e.reason)).toEqual(['fled']);
    runFor(h, t, 12, follow(h, ID));
    const slot = h.sys.slotOfVehicle(ID);
    expect(h.sys.inspect(slot, carInfo()).pull).toBe(PULL.none);
    expect(h.sys.view.speed[slot]).toBeGreaterThan(LIMIT);
  });

  it('a parked subject car can flee', async () => {
    const h = await harness();
    h.sys.spawnSubjectCar(ID, 0, 0, { mode: 'parked', behavior: BEHAVIOR.dui });
    expect(h.sys.flee(ID)).toBe(true);
    runFor(h, 0, 15, follow(h, ID));
    const slot = h.sys.slotOfVehicle(ID);
    expect(h.sys.view.speed[slot]).toBeGreaterThan(LIMIT);
    expect(h.sys.view.state[slot]).toBe(TRAFFIC_STATE.driving);
  });

  it('refuses a crashed car and a fleet car', async () => {
    const h = await harness();
    h.sys.spawnSubjectCar(ID, 0, 0, { mode: 'crashed' });
    expect(h.sys.flee(ID)).toBe(false);
    expect(h.sys.spawnFleetCar(0, 300, 0, { modelIndex: 0, color: 0 })).toBeGreaterThan(0);
    expect(h.sys.flee(1 << 20)).toBe(false);
  });
});

function json<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('flee snapshot', () => {
  it('round trips mid-flee and both continue identically', async () => {
    await withFlee({ giveUpPerMin: 0 }, async () => {
      const graph = gridGraph(JUNCTION.allWayStop);
      const make = async (): Promise<Harness> => {
        const h = await harness(graph, 11);
        h.focus.x = 100;
        h.focus.z = 100;
        return h;
      };
      const a = await make();
      a.sys.spawnAt(laneRef(0, 0, 0), 60, { vehicleId: ID, speed: 8, behavior: 0 });
      a.sys.spawnAt(laneRef(1, 0, 0), 90, { vehicleId: 78, speed: 6 });
      expect(a.sys.flee(ID)).toBe(true);
      const t = runFor(a, 0, 10);
      expect(a.sys.fleeingCount).toBe(1);
      const snap = a.sys.snapshot();
      const saved = snap.cars.find((c) => c.vehicleId === ID);
      expect(saved?.flee).toBe(1);
      expect(saved?.fleeTimer).toBeCloseTo(10, 1);
      expect(saved?.pinned).toBe(1);
      expect(snap.cars.find((c) => c.vehicleId === 78)?.flee).toBeUndefined();
      const copy = json(snap);
      expect(isTrafficSnapshot(copy)).toBe(true);
      const b = await make();
      b.sys.restore(copy);
      expect(b.sys.fleeingCount).toBe(1);
      expect(b.sys.fleeState(ID, fleeState())).toBe(true);
      runFor(a, t, 20);
      runFor(b, t, 20);
      expect(json(b.sys.snapshot())).toEqual(json(a.sys.snapshot()));
    });
  });

  it('validates the optional fields and accepts snapshots without them', async () => {
    const h = await harness();
    h.sys.spawnAt(laneRef(0, 0, 0), 500, { vehicleId: ID, speed: 10 });
    h.sys.flee(ID);
    const snap = json(h.sys.snapshot());
    expect(isTrafficSnapshot(snap)).toBe(true);
    const bad = json(snap);
    (bad.cars[0] as unknown as Record<string, unknown>).fleeTimer = 'x';
    expect(isTrafficSnapshot(bad)).toBe(false);
    const old = json(snap);
    delete old.cars[0]?.flee;
    delete old.cars[0]?.fleeTimer;
    delete old.cars[0]?.fleeLost;
    expect(isTrafficSnapshot(old)).toBe(true);
    const h2 = await harness();
    h2.sys.restore(old);
    expect(h2.sys.fleeingCount).toBe(0);
  });
});

describe('flee performance', () => {
  it('does not allocate in step with fleeing cars in a city', async () => {
    // The step boxes doubles (hypot, lane points) at a steady rate, so garbage is compared with the same scene
    // without fleeing cars; nobody escapes or gives up and no car spawns or despawns.
    const gc = await loadGc();
    const city = generateCity(99);
    const garbage = async (fleeing: number): Promise<number> =>
      withFlee({ giveUpPerMin: 0, loseDistanceM: 10000 }, async () => {
        const h = await makeHarness(city.graph, 99, city);
        h.focus.x = 256;
        h.focus.z = -512;
        h.sys.populate(h.focus, NOON);
        h.sys.densityScale = 0;
        for (let i = 0; i < h.sys.activeCount; i++) h.sys.pin(h.sys.view.vehicleId[i] ?? 0, true);
        let n = 0;
        for (let i = 0; i < h.sys.activeCount && n < fleeing; i++) if (h.sys.flee(h.sys.view.vehicleId[i] ?? 0)) n++;
        expect(h.sys.fleeingCount).toBe(fleeing);
        let t = 0;
        const run = (steps: number): void => {
          for (let i = 0; i < steps; i++) {
            t += DT;
            h.sys.step(DT, t, NOON, h.focus);
          }
        };
        run(600);
        // A scavenge inside a window only lowers its delta: the largest of several short windows is the estimate.
        let worst = 0;
        for (let k = 0; k < 8; k++) {
          gc();
          const before = process.memoryUsage().heapUsed;
          run(100);
          worst = Math.max(worst, process.memoryUsage().heapUsed - before);
        }
        expect(h.sys.fleeingCount).toBe(fleeing);
        h.physics.dispose();
        return worst;
      });
    const base = await garbage(0);
    const fleeing = await garbage(24);
    expect(base).toBeGreaterThan(0);
    expect(fleeing / base).toBeLessThan(1.25);
  }, 60000);
});

describe('flee data and command', () => {
  it('loads the flee block of pullover.json and names the file and field on errors', () => {
    expect(PULLOVER.flee).toEqual({
      speedFactor: 1.45,
      maxSpeed: 34,
      crossSpeed: 7,
      loseDistanceM: 450,
      loseS: 20,
      giveUpPerMin: 0.12,
      minFleeS: 20,
      awayBias: 0.75,
    });
    const bad = json(pulloverJson) as unknown as Record<string, Record<string, unknown>>;
    expect(() => validatePullover(bad)).not.toThrow();
    const flee = bad.flee as Record<string, unknown>;
    flee.awayBias = 1.5;
    expect(() => validatePullover(bad)).toThrow(/pullover\.json: flee\.awayBias/);
    flee.awayBias = 0.5;
    delete flee.loseS;
    expect(() => validatePullover(bad)).toThrow(/pullover\.json: flee\.loseS/);
    delete bad.flee;
    expect(() => validatePullover(bad)).toThrow(/pullover\.json: flee/);
  });

  it('the flee console command sends the nearest ambient car off and stops every pursuit', async () => {
    const h = await harness();
    h.sys.spawnAt(laneRef(0, 0, 0), 1040, { vehicleId: 11, speed: 10, behavior: 0 });
    h.sys.spawnAt(laneRef(0, 0, 0), 1080, { vehicleId: 12, speed: 10, behavior: 0 });
    const cmds = createTrafficCommands({ traffic: () => h.sys, playerPosition: () => ({ x: -450, z: 0 }) });
    const run = (args: string[] = []): unknown => cmds.find((c) => c.name === 'flee')?.run(args, {} as CommandContext);
    expect(run()).toMatch(/Vehicle 11 fleeing \(10 m\)/);
    expect(h.sys.fleeState(11, fleeState())).toBe(true);
    expect(run()).toMatch(/Vehicle 12 fleeing/);
    expect(run()).toMatch(/No car within 100 m/);
    expect(run(['stop'])).toBe('2 cars pulling over');
    expect(run(['stop'])).toBe('No fleeing car');
    expect(() => run(['x'])).toThrow(/Usage/);
    const none = createTrafficCommands({ traffic: () => null, playerPosition: () => null });
    expect(() => none.find((c) => c.name === 'flee')?.run([], {} as CommandContext)).toThrow(/not available/);
  });
});
