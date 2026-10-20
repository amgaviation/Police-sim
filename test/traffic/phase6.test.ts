import { describe, expect, it } from 'vitest';
import { spawn } from '../../src/ecs/world';
import { PULLOVER } from '../../src/traffic/data';
import type { TrafficCollisionEvent, TrafficFleeEndedEvent } from '../../src/traffic/events';
import {
  TRAFFIC_STATE,
  isTrafficSnapshot,
  type Blockade,
  type FleeInfo,
  type TrafficSnapshot,
} from '../../src/traffic/trafficSystem';
import { LIGHT, VehicleLook } from '../../src/vehicles/components';
import { vehicleModel } from '../../src/vehicles/model';
import { MPH } from '../../src/world/constants';
import { generateCity } from '../../src/world/generate';
import { laneRef } from '../../src/world/roadGraph';
import { DT, NOON, lineGraph, makeHarness, runFor, type Harness } from './helpers';

const ID = 77;
const FLEE = PULLOVER.flee;
const SPIKES = PULLOVER.spikes;
const SPIN = PULLOVER.spin;
const BLOCKADE = PULLOVER.blockade;
const POLICE = vehicleModel('patrol_sedan').index;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Runs `fn` with random give-ups switched off, restoring the setting afterwards. */
async function noGiveUp<T>(fn: () => Promise<T>): Promise<T> {
  const flee = FLEE as Mutable<typeof FLEE>;
  const saved = flee.giveUpPerMin;
  flee.giveUpPerMin = 0;
  try {
    return await fn();
  } finally {
    flee.giveUpPerMin = saved;
  }
}

function json<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

async function harness(seed = 7): Promise<Harness> {
  const h = await makeHarness(lineGraph(), seed);
  h.sys.densityScale = 0;
  return h;
}

function info(): FleeInfo {
  return { x: 0, z: 0, yaw: 0, speed: 0, edge: 0, deflated: 0, spinning: false, capMps: 0, tracked: false };
}

/** Keeps the focus `behind` m behind car `id` along x. */
function follow(h: Harness, id: number, behind = 10): () => void {
  return () => {
    const slot = h.sys.slotOfVehicle(id);
    if (slot < 0) return;
    h.focus.x = (h.sys.view.x[slot] ?? 0) - behind;
    h.focus.z = h.sys.view.z[slot] ?? 0;
  };
}

function listenEnded(h: Harness): TrafficFleeEndedEvent[] {
  const ended: TrafficFleeEndedEvent[] = [];
  h.bus.on('traffic:fleeEnded', (e) => ended.push(e));
  return ended;
}

/** A fleeing car on the line road at x = -500 doing 10 m/s eastwards. */
function startFlee(h: Harness, s = 1000): void {
  h.sys.spawnAt(laneRef(0, 0, 0), s, { vehicleId: ID, speed: 10, behavior: 0, desiredFactor: 1 });
  expect(h.sys.flee(ID)).toBe(true);
}

describe('data', () => {
  it('ships 32 fleet cars and the Phase 6 sections', () => {
    expect(PULLOVER.fleet.maxCars).toBe(32);
    expect(SPIKES.speedFactor).toHaveLength(5);
    expect(BLOCKADE.max).toBe(16);
  });
});

describe('fleet cars', () => {
  it('spawns up to 32 and refuses a 33rd index', async () => {
    const h = await harness();
    const look = { modelIndex: POLICE, color: 0xffffff };
    for (let i = 0; i < 32; i++) expect(h.sys.spawnFleetCar(i, -1400 + 85 * i, 1.75, look)).toBeGreaterThan(0);
    expect(h.sys.activeCount).toBe(32);
    expect(h.sys.spawnFleetCar(32, 0, 0, look)).toBe(0);
    runFor(h, 0, 2);
    expect(h.sys.activeCount).toBe(32);
  });
});

describe('deflate', () => {
  it('caps a fleeing car at maxSpeed * speedFactor[deflated] and accumulates up to 4', async () => {
    await noGiveUp(async () => {
      const h = await harness();
      startFlee(h);
      expect(h.sys.deflate(999, 1)).toBe(false);
      expect(h.sys.deflate(ID, 1)).toBe(true);
      expect(h.sys.fleeInfo(ID, info())).toBe(true);
      const out = info();
      h.sys.fleeInfo(ID, out);
      expect(out.deflated).toBe(1);
      expect(out.capMps).toBeCloseTo(FLEE.maxSpeed * (SPIKES.speedFactor[1] ?? 1), 5);
      expect(h.sys.deflate(ID, 1)).toBe(true);
      h.sys.fleeInfo(ID, out);
      expect(out.deflated).toBe(2);
      const cap = FLEE.maxSpeed * (SPIKES.speedFactor[2] ?? 1);
      expect(out.capMps).toBeCloseTo(cap, 5);
      // The unrestricted flee speed on this road is above the cap: a few seconds later it is at or below it.
      expect(40 * MPH * FLEE.speedFactor).toBeGreaterThan(cap);
      runFor(h, 0, 6, follow(h, ID));
      h.sys.fleeInfo(ID, out);
      expect(out.speed).toBeLessThanOrEqual(cap + 0.1);
      expect(out.speed).toBeGreaterThan(cap - 3);
      expect(h.sys.deflate(ID, 9)).toBe(true);
      h.sys.fleeInfo(ID, out);
      expect(out.deflated).toBe(4);
      expect(h.sys.deflate(ID, -1)).toBe(false);
    });
  });

  it('with minTires deflated the flee ends stopped after stopAfterS, with one tyre it does not', async () => {
    await noGiveUp(async () => {
      const h = await harness();
      const ended = listenEnded(h);
      startFlee(h);
      h.sys.deflate(ID, SPIKES.minTires - 1);
      let t = runFor(h, 0, SPIKES.stopAfterS + 4, follow(h, ID));
      expect(ended).toHaveLength(0);
      expect(h.sys.fleeingCount).toBe(1);
      h.sys.deflate(ID, 1);
      t = runFor(h, t, SPIKES.stopAfterS - 1, follow(h, ID));
      expect(ended).toHaveLength(0);
      runFor(h, t, 2, follow(h, ID));
      expect(ended.map((e) => e.reason)).toEqual(['stopped']);
      expect(ended[0]?.vehicleId).toBe(ID);
      expect(h.sys.fleeingCount).toBe(0);
    });
  });

  it('a deflated car that pulled over stops at the curb and stays pinned', async () => {
    await noGiveUp(async () => {
      const h = await harness();
      startFlee(h);
      h.sys.deflate(ID, 2);
      const t = runFor(h, 0, SPIKES.stopAfterS + 40, follow(h, ID));
      const slot = h.sys.slotOfVehicle(ID);
      expect(h.sys.view.speed[slot]).toBe(0);
      h.focus.x = 3000;
      runFor(h, t, 3);
      expect(h.sys.slotOfVehicle(ID)).toBeGreaterThanOrEqual(0);
    });
  });

  it('refuses fleet cars', async () => {
    const h = await harness();
    h.sys.spawnFleetCar(0, 0, 1.75, { modelIndex: POLICE, color: 0 });
    expect(h.sys.deflate(1 << 20, 2)).toBe(false);
  });
});

describe('spinOut', () => {
  it('yaws by yawDeg over durationS, slides along its heading, then crashes and ends the flee crashed', async () => {
    const h = await harness();
    const ended = listenEnded(h);
    startFlee(h);
    runFor(h, 0, 3, follow(h, ID));
    const slot = h.sys.slotOfVehicle(ID);
    const yaw0 = h.sys.view.yaw[slot] ?? 0;
    const x0 = h.sys.view.x[slot] ?? 0;
    const z0 = h.sys.view.z[slot] ?? 0;
    const v0 = h.sys.view.speed[slot] ?? 0;
    expect(h.sys.spinOut(999, 1)).toBe(false);
    expect(h.sys.spinOut(ID, 1)).toBe(true);
    expect(h.sys.spinOut(ID, -1)).toBe(false);
    // Halfway: spinning, half the yaw, decelerating, no sideways drift.
    let t = runFor(h, 3, SPIN.durationS / 2, follow(h, ID));
    const out = info();
    expect(h.sys.fleeInfo(ID, out)).toBe(true);
    expect(out.spinning).toBe(true);
    expect(out.yaw - yaw0).toBeCloseTo((SPIN.yawDeg / 2) * (Math.PI / 180), 1);
    expect(out.speed).toBeLessThan(v0 - SPIN.slideDecel * SPIN.durationS * 0.4);
    expect(ended).toHaveLength(0);
    t = runFor(h, t, SPIN.durationS / 2 + 0.1, follow(h, ID));
    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason).toBe('crashed');
    const s2 = h.sys.slotOfVehicle(ID);
    expect(h.sys.view.state[s2]).toBe(TRAFFIC_STATE.crashed);
    expect(h.sys.view.speed[s2]).toBe(0);
    expect(Math.abs((h.sys.view.yaw[s2] ?? 0) - yaw0)).toBeCloseTo(SPIN.yawDeg * (Math.PI / 180), 2);
    expect(h.sys.view.x[s2] ?? 0).toBeGreaterThan(x0 + 5);
    expect(Math.abs((h.sys.view.z[s2] ?? 0) - z0)).toBeLessThan(0.01);
    expect((VehicleLook.lights[h.sys.view.eid[s2] ?? 0] ?? 0) & LIGHT.hazard).toBe(LIGHT.hazard);
    expect(h.sys.fleeingCount).toBe(0);
    // The wreck keeps its spun yaw and stays where it is.
    const x1 = h.sys.view.x[s2] ?? 0;
    const yaw1 = h.sys.view.yaw[s2] ?? 0;
    runFor(h, t, 2);
    expect(h.sys.view.x[h.sys.slotOfVehicle(ID)]).toBeCloseTo(x1, 5);
    expect(h.sys.view.yaw[h.sys.slotOfVehicle(ID)]).toBeCloseTo(yaw1, 5);
    expect(h.sys.spinOut(ID, 1)).toBe(false);
  });

  it('spins the other way with dir -1 and also works on an ordinary car', async () => {
    const h = await harness();
    h.focus.x = -500;
    h.sys.spawnAt(laneRef(0, 0, 0), 1000, { vehicleId: ID, speed: 12, behavior: 0, desiredFactor: 1 });
    runFor(h, 0, 1);
    const slot = h.sys.slotOfVehicle(ID);
    const yaw0 = h.sys.view.yaw[slot] ?? 0;
    expect(h.sys.spinOut(ID, -1)).toBe(true);
    runFor(h, 1, SPIN.durationS + 0.2);
    const s2 = h.sys.slotOfVehicle(ID);
    expect(h.sys.view.state[s2]).toBe(TRAFFIC_STATE.crashed);
    expect((h.sys.view.yaw[s2] ?? 0) - yaw0).toBeCloseTo(-SPIN.yawDeg * (Math.PI / 180), 2);
  });

  it('is deterministic', async () => {
    const run = async (): Promise<unknown> => {
      const h = await harness(21);
      startFlee(h);
      runFor(h, 0, 3, follow(h, ID));
      h.sys.spinOut(ID, 1);
      runFor(h, 3, 3, follow(h, ID));
      return json(h.sys.snapshot());
    };
    expect(await run()).toEqual(await run());
  });
});

describe('crashCar', () => {
  it('crashes a fleeing car at once and ends the flee crashed', async () => {
    const h = await harness();
    const ended = listenEnded(h);
    startFlee(h);
    runFor(h, 0, 2, follow(h, ID));
    expect(h.sys.crashCar(999)).toBe(false);
    expect(h.sys.crashCar(ID)).toBe(true);
    const slot = h.sys.slotOfVehicle(ID);
    expect(h.sys.view.state[slot]).toBe(TRAFFIC_STATE.crashed);
    expect(h.sys.view.speed[slot]).toBe(0);
    expect((VehicleLook.lights[h.sys.view.eid[slot] ?? 0] ?? 0) & LIGHT.hazard).toBe(LIGHT.hazard);
    expect(ended.map((e) => e.reason)).toEqual(['crashed']);
    expect(h.sys.fleeingCount).toBe(0);
    expect(h.sys.crashCar(ID)).toBe(false);
    runFor(h, 2, 1, follow(h, ID));
    expect(ended).toHaveLength(1);
  });

  it('crashes an ordinary car and refuses a fleet car', async () => {
    const h = await harness();
    h.sys.spawnAt(laneRef(0, 0, 0), 1000, { vehicleId: ID, speed: 12 });
    expect(h.sys.crashCar(ID)).toBe(true);
    expect(h.sys.view.state[h.sys.slotOfVehicle(ID)]).toBe(TRAFFIC_STATE.crashed);
    h.sys.spawnFleetCar(0, 300, 1.75, { modelIndex: POLICE, color: 0 });
    expect(h.sys.crashCar(1 << 20)).toBe(false);
  });
});

describe('contacts with a fleeing car', () => {
  it('emits traffic:collision with fleeing: true and leaves the car fleeing', async () => {
    const city = generateCity(99);
    const h = await makeHarness(city.graph, 99, city);
    h.sys.densityScale = 0;
    h.physics.addGround(4000);
    h.focus.x = 256;
    h.focus.z = -512;
    const eid = h.sys.spawnSubjectCar(ID, 256, -512, { mode: 'driving' });
    expect(eid).toBeGreaterThan(0);
    expect(h.sys.flee(ID)).toBe(true);
    const ended = listenEnded(h);
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
    const hits: TrafficCollisionEvent[] = [];
    h.bus.on('traffic:collision', (e) => hits.push(e));
    const slot = h.sys.slotOfVehicle(ID);
    const box = spawn(h.world);
    h.physics.addBox(box, { x: h.sys.view.x[slot] ?? 0, y: 1.2, z: h.sys.view.z[slot] ?? 0 }, { x: 0.8, y: 0.5, z: 0.8 }, { mass: 1500 });
    for (let i = 0; i < 90; i++) stepOnce();
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.fleeing).toBe(true);
    expect(hits[0]?.other).toBe(box);
    expect(hits[0]?.eid).toBe(eid);
    expect(ended).toHaveLength(0);
    expect(h.sys.fleeingCount).toBe(1);
    expect(h.sys.view.state[h.sys.slotOfVehicle(ID)]).not.toBe(TRAFFIC_STATE.crashed);
    expect(h.sys.fleeInfo(ID, info())).toBe(true);
    h.physics.dispose();
  });
});

describe('setFleeSpeedCap', () => {
  it('clamps the desired speed and Infinity clears the cap', async () => {
    await noGiveUp(async () => {
      const h = await harness();
      expect(h.sys.setFleeSpeedCap(ID, 10)).toBe(false);
      startFlee(h);
      expect(h.sys.setFleeSpeedCap(ID, 9)).toBe(true);
      const out = info();
      let t = runFor(h, 0, 6, follow(h, ID));
      h.sys.fleeInfo(ID, out);
      expect(out.capMps).toBe(9);
      expect(out.speed).toBeLessThanOrEqual(9.1);
      expect(out.speed).toBeGreaterThan(5);
      expect(h.sys.setFleeSpeedCap(ID, Infinity)).toBe(true);
      t = runFor(h, t, 8, follow(h, ID));
      h.sys.fleeInfo(ID, out);
      expect(out.capMps).toBe(Infinity);
      expect(out.speed).toBeGreaterThan(40 * MPH * 1.2);
      expect(h.sys.setFleeSpeedCap(ID, Number.NaN)).toBe(false);
      expect(t).toBeGreaterThan(0);
    });
  });

  it('keeps the deflation cap when the explicit cap is cleared', async () => {
    await noGiveUp(async () => {
      const h = await harness();
      startFlee(h);
      h.sys.deflate(ID, 3);
      h.sys.setFleeSpeedCap(ID, 5);
      const out = info();
      h.sys.fleeInfo(ID, out);
      expect(out.capMps).toBe(5);
      h.sys.setFleeSpeedCap(ID, Infinity);
      h.sys.fleeInfo(ID, out);
      expect(out.capMps).toBeCloseTo(FLEE.maxSpeed * (SPIKES.speedFactor[3] ?? 1), 5);
    });
  });
});

describe('setFleeTracked', () => {
  it('suspends the lose timer: a tracked car does not escape past loseS, an untracked one does', async () => {
    await noGiveUp(async () => {
      const h = await harness();
      const ended = listenEnded(h);
      h.focus.x = -1000;
      startFlee(h);
      expect(h.sys.setFleeTracked(999, true)).toBe(false);
      expect(h.sys.setFleeTracked(ID, true)).toBe(true);
      const out = info();
      expect(h.sys.fleeInfo(ID, out)).toBe(true);
      expect(out.tracked).toBe(true);
      // 500+ m from the focus the whole time.
      const t = runFor(h, 0, FLEE.loseS + 10);
      expect(ended).toHaveLength(0);
      expect(h.sys.fleeingCount).toBe(1);
      expect(h.sys.setFleeTracked(ID, false)).toBe(true);
      const t2 = runFor(h, t, FLEE.loseS - 1);
      expect(ended).toHaveLength(0);
      runFor(h, t2, 2);
      expect(ended.map((e) => e.reason)).toEqual(['escaped']);
      expect(h.sys.slotOfVehicle(ID)).toBe(-1);
    });
  });
});

describe('blockades', () => {
  const BLOCK: Blockade = { x: 0, z: 0, radius: 6 };

  it('copies at most blockade.max entries and exposes the count', async () => {
    const h = await harness();
    expect(h.sys.blockadeCount).toBe(0);
    const many: Blockade[] = [];
    for (let i = 0; i < BLOCKADE.max + 5; i++) many.push({ x: i * 50, z: 0, radius: 5 });
    h.sys.setBlockades(many);
    expect(h.sys.blockadeCount).toBe(BLOCKADE.max);
    h.sys.setBlockades([BLOCK]);
    expect(h.sys.blockadeCount).toBe(1);
    h.sys.setBlockades([]);
    expect(h.sys.blockadeCount).toBe(0);
  });

  it('stops an ambient car short of the blockade and keeps it while the player is near', async () => {
    const h = await harness();
    h.sys.setBlockades([BLOCK]);
    h.focus.x = 0;
    h.sys.spawnAt(laneRef(0, 0, 0), 1100, { vehicleId: ID, speed: 15, behavior: 0, desiredFactor: 1 });
    // Without the blockade the car would drive straight through x = 0.
    runFor(h, 0, BLOCKADE.waitS + 15);
    const slot = h.sys.slotOfVehicle(ID);
    expect(slot).toBeGreaterThanOrEqual(0);
    const x = h.sys.view.x[slot] ?? 0;
    expect(x).toBeLessThan(-BLOCK.radius);
    expect(x).toBeGreaterThan(-BLOCK.radius - 15);
    expect(h.sys.view.speed[slot]).toBe(0);
  });

  it('a car on the other carriageway stops short of it too', async () => {
    const h = await harness();
    h.sys.setBlockades([BLOCK]);
    h.focus.x = 0;
    h.sys.spawnAt(laneRef(0, 1, 0), 1100, { vehicleId: ID, speed: 15, behavior: 0, desiredFactor: 1 });
    runFor(h, 0, 40);
    const slot = h.sys.slotOfVehicle(ID);
    expect(slot).toBeGreaterThanOrEqual(0);
    const x = h.sys.view.x[slot] ?? 0;
    expect(x).toBeGreaterThan(BLOCK.radius);
    expect(x).toBeLessThan(BLOCK.radius + 15);
  });

  it('a blockade beside the road does not stop traffic', async () => {
    const h = await harness();
    h.sys.setBlockades([{ x: 0, z: 40, radius: 6 }]);
    h.focus.x = 0;
    h.sys.spawnAt(laneRef(0, 1, 0), 1100, { vehicleId: ID, speed: 15, behavior: 0, desiredFactor: 1 });
    runFor(h, 0, 30);
    const slot = h.sys.slotOfVehicle(ID);
    expect(h.sys.view.x[slot] ?? 0).toBeLessThan(-50);
    expect(h.sys.view.speed[slot] ?? 0).toBeGreaterThan(5);
  });

  it('a car heading away from the blockade is not stopped by it', async () => {
    const h = await harness();
    h.sys.setBlockades([BLOCK]);
    h.focus.x = 0;
    h.sys.spawnAt(laneRef(0, 0, 0), 1520, { vehicleId: ID, speed: 15, behavior: 0, desiredFactor: 1 });
    runFor(h, 0, 15);
    const slot = h.sys.slotOfVehicle(ID);
    expect(h.sys.view.x[slot] ?? 0).toBeGreaterThan(100);
    expect(h.sys.view.speed[slot] ?? 0).toBeGreaterThan(5);
  });

  it('a car that waited waitS turns around once farther than 30 m from the focus', async () => {
    const h = await harness();
    h.sys.setBlockades([BLOCK]);
    h.focus.x = -100;
    h.sys.spawnAt(laneRef(0, 0, 0), 1440, { vehicleId: ID, speed: 15, behavior: 0, desiredFactor: 1 });
    const despawned: number[] = [];
    h.bus.on('traffic:despawned', (e) => despawned.push(e.vehicleId));
    const t = runFor(h, 0, 12);
    // Waiting for a while now, still there.
    expect(h.sys.slotOfVehicle(ID)).toBeGreaterThanOrEqual(0);
    expect(h.sys.view.speed[h.sys.slotOfVehicle(ID)]).toBeLessThan(0.5);
    runFor(h, t, BLOCKADE.waitS + 2);
    expect(h.sys.slotOfVehicle(ID)).toBe(-1);
    expect(despawned).toEqual([ID]);
  });

  it('the cars behind a blockade queue up', async () => {
    const h = await harness();
    h.sys.setBlockades([BLOCK]);
    h.focus.x = 0;
    h.sys.spawnAt(laneRef(0, 0, 0), 1200, { vehicleId: ID, speed: 12, behavior: 0, desiredFactor: 1 });
    h.sys.spawnAt(laneRef(0, 0, 0), 1150, { vehicleId: ID + 1, speed: 12, behavior: 0, desiredFactor: 1 });
    runFor(h, 0, 40);
    const a = h.sys.slotOfVehicle(ID), b = h.sys.slotOfVehicle(ID + 1);
    expect(h.sys.view.x[a] ?? 0).toBeLessThan(-BLOCK.radius);
    expect(h.sys.view.x[b] ?? 0).toBeLessThan((h.sys.view.x[a] ?? 0) - 3);
    expect(h.sys.view.speed[b]).toBeLessThan(0.1);
  });

  it('no car spawns within radius + noSpawnM of a blockade', async () => {
    const city = generateCity(99);
    const radius = 8;
    const reach = radius + BLOCKADE.noSpawnM;
    /** Streams spawns for 4 s at double density; returns where each new car appeared. */
    const spawnPoints = async (blockade: Blockade | null, seedPoint?: { x: number; z: number }): Promise<{ x: number; z: number }[]> => {
      const h = await makeHarness(city.graph, 99, city);
      h.focus.x = 256;
      h.focus.z = -512;
      if (blockade) h.sys.setBlockades([blockade]);
      h.sys.populate(h.focus, NOON);
      h.sys.densityScale = 2;
      const fresh = new Set<number>();
      h.bus.on('traffic:spawned', (e) => fresh.add(e.eid));
      const points: { x: number; z: number }[] = [];
      let t = 0;
      for (let i = 0; i < 240; i++) {
        t += DT;
        fresh.clear();
        h.sys.step(DT, t, NOON, h.focus);
        for (const eid of fresh) {
          const slot = h.sys.slotOfEntity(eid);
          if (slot >= 0) points.push({ x: h.sys.view.x[slot] ?? 0, z: h.sys.view.z[slot] ?? 0 });
        }
      }
      expect(seedPoint === undefined || h.sys.activeCount > 20).toBe(true);
      h.physics.dispose();
      return points;
    };
    const plain = await spawnPoints(null);
    expect(plain.length).toBeGreaterThan(5);
    const p = plain[0] ?? { x: 0, z: 0 };
    const nearP = (q: { x: number; z: number }): boolean => Math.hypot(q.x - p.x, q.z - p.z) < reach;
    expect(plain.filter(nearP).length).toBeGreaterThanOrEqual(1);
    const blocked = await spawnPoints({ x: p.x, z: p.z, radius }, p);
    expect(blocked.length).toBeGreaterThan(5);
    expect(blocked.filter(nearP)).toEqual([]);
  });

  it('a fleet car and a fleeing car drive through it', async () => {
    const h = await harness();
    h.sys.setBlockades([BLOCK]);
    h.focus.x = 0;
    h.sys.spawnFleetCar(0, -500, 1.75, { modelIndex: POLICE, color: 0xffffff });
    expect(h.sys.setFleetDestination(0, 1000, 1.75, 'respond')).toBe(true);
    // The stuck ambient car is on the other carriageway.
    h.sys.spawnAt(laneRef(0, 1, 0), 1100, { vehicleId: ID, speed: 12, behavior: 0, desiredFactor: 1 });
    // A fleeing car on this carriageway behind the fleet car.
    h.sys.spawnAt(laneRef(0, 0, 0), 800, { vehicleId: ID + 1, speed: 12, behavior: 0, desiredFactor: 1 });
    h.sys.flee(ID + 1);
    runFor(h, 0, 40);
    const st = { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol' as const, arrived: false, parked: false, routeLeftM: 0 };
    expect(h.sys.fleetState(0, st)).not.toBeNull();
    expect(st.x).toBeGreaterThan(BLOCK.radius + 20);
    const fleeing = info();
    if (h.sys.fleeInfo(ID + 1, fleeing)) expect(fleeing.x).toBeGreaterThan(BLOCK.radius);
    // The ambient one queued on the east side.
    const slot = h.sys.slotOfVehicle(ID);
    expect(h.sys.view.x[slot] ?? 0).toBeGreaterThan(BLOCK.radius);
  });
});

describe('snapshot', () => {
  /** A fleeing car with a deflated tyre, a cap and tracking, a car mid-spin, a finished wreck and two blockades. */
  async function scenario(): Promise<{ h: Harness; t: number }> {
    const h = await harness(11);
    h.focus.x = 0;
    h.sys.spawnAt(laneRef(0, 0, 0), 1000, { vehicleId: ID, speed: 10, behavior: 0, desiredFactor: 1 });
    h.sys.flee(ID);
    h.sys.deflate(ID, 1);
    h.sys.setFleeSpeedCap(ID, 14);
    h.sys.setFleeTracked(ID, true);
    h.sys.spawnAt(laneRef(0, 1, 0), 1400, { vehicleId: ID + 1, speed: 12, behavior: 0, desiredFactor: 1 });
    h.sys.spawnAt(laneRef(0, 1, 0), 1480, { vehicleId: ID + 2, speed: 12, behavior: 0, desiredFactor: 1 });
    h.sys.setBlockades([{ x: 900, z: 0, radius: 6 }, { x: -900, z: 4, radius: 5 }]);
    let t = runFor(h, 0, 2);
    h.sys.spinOut(ID + 2, -1);
    t = runFor(h, t, SPIN.durationS + 0.2);
    h.sys.spinOut(ID + 1, 1);
    t = runFor(h, t, 0.5);
    return { h, t };
  }

  it('writes the Phase 6 fields only when set', async () => {
    const { h } = await scenario();
    const snap = h.sys.snapshot();
    const byId = (id: number): NonNullable<TrafficSnapshot['cars'][number]> => {
      const car = snap.cars.find((c) => c.vehicleId === id);
      if (!car) throw new Error(`no car ${id}`);
      return car;
    };
    expect(byId(ID).deflated).toBe(1);
    expect(byId(ID).cap).toBe(14);
    expect(byId(ID).tracked).toBe(1);
    expect(byId(ID).deflateT).toBeUndefined();
    expect(byId(ID).spin).toBeUndefined();
    expect(byId(ID + 1).spin?.[1]).toBe(1);
    expect(byId(ID + 1).spin?.[0]).toBeGreaterThan(0.4);
    expect(byId(ID + 2).spin?.[1]).toBe(-1);
    expect(byId(ID + 2).spin?.[0]).toBeGreaterThanOrEqual(SPIN.durationS);
    expect(byId(ID + 1).cap).toBeUndefined();
    expect(byId(ID + 1).deflated).toBeUndefined();
    expect(byId(ID + 1).tracked).toBeUndefined();
    expect(snap.blockades).toEqual([[900, 0, 6], [-900, 4, 5]]);
    // A plain system writes none of them.
    const plain = await harness();
    plain.sys.spawnAt(laneRef(0, 0, 0), 1000, { vehicleId: ID, speed: 10 });
    const ps = plain.sys.snapshot();
    expect(ps.blockades).toBeUndefined();
    expect(Object.keys(ps.cars[0] ?? {})).not.toContain('cap');
    expect(Object.keys(ps.cars[0] ?? {})).not.toContain('spin');
  });

  it('round trips through JSON and both continue identically', async () => {
    await noGiveUp(async () => {
      const { h: a, t } = await scenario();
      const snap = json(a.sys.snapshot());
      expect(isTrafficSnapshot(snap)).toBe(true);
      const b = await harness(11);
      b.focus.x = 0;
      b.sys.restore(snap);
      expect(json(b.sys.snapshot())).toEqual(snap);
      expect(b.sys.blockadeCount).toBe(2);
      const oa = info(), ob = info();
      expect(b.sys.fleeInfo(ID, ob)).toBe(true);
      a.sys.fleeInfo(ID, oa);
      expect(ob).toEqual(oa);
      expect(ob.deflated).toBe(1);
      expect(ob.capMps).toBe(14);
      expect(ob.tracked).toBe(true);
      // The wreck kept its spun yaw, the spinning car its progress.
      for (const id of [ID + 1, ID + 2]) {
        expect(b.sys.view.yaw[b.sys.slotOfVehicle(id)]).toBe(a.sys.view.yaw[a.sys.slotOfVehicle(id)]);
      }
      for (let k = 0; k < 10; k++) {
        runFor(a, t + k, 1);
        runFor(b, t + k, 1);
        expect(json(b.sys.snapshot())).toEqual(json(a.sys.snapshot()));
      }
      expect(b.sys.view.state[b.sys.slotOfVehicle(ID + 1)]).toBe(TRAFFIC_STATE.crashed);
    });
  });

  it('a restore replaces the blockades of the system, an older snapshot clears them', async () => {
    const { h } = await scenario();
    const snap = json(h.sys.snapshot());
    delete snap.blockades;
    expect(isTrafficSnapshot(snap)).toBe(true);
    h.sys.restore(snap);
    expect(h.sys.blockadeCount).toBe(0);
  });

  it('isTrafficSnapshot accepts the new fields and rejects wrong types', async () => {
    const { h } = await scenario();
    const good = json(h.sys.snapshot());
    expect(isTrafficSnapshot(good)).toBe(true);
    const bad = (mutate: (s: TrafficSnapshot) => void): boolean => {
      const s = json(good);
      mutate(s);
      return isTrafficSnapshot(s);
    };
    const car = (s: TrafficSnapshot, id: number): Record<string, unknown> => {
      const c = s.cars.find((x) => x.vehicleId === id);
      if (!c) throw new Error('no car');
      return c as unknown as Record<string, unknown>;
    };
    expect(bad((s) => (car(s, ID).deflated = '1'))).toBe(false);
    expect(bad((s) => (car(s, ID).cap = Number.NaN))).toBe(false);
    expect(bad((s) => (car(s, ID).cap = 'fast'))).toBe(false);
    expect(bad((s) => (car(s, ID).tracked = true))).toBe(false);
    expect(bad((s) => (car(s, ID + 1).spin = [0.1, 1]))).toBe(false);
    expect(bad((s) => (car(s, ID + 1).spin = [0.1, 2, 0]))).toBe(false);
    expect(bad((s) => (car(s, ID + 1).spin = 'x'))).toBe(false);
    expect(bad((s) => (car(s, ID + 1).spin = [0.1, 1, Number.NaN]))).toBe(false);
    expect(bad((s) => ((s as unknown as Record<string, unknown>).blockades = 'x'))).toBe(false);
    expect(bad((s) => ((s as unknown as Record<string, unknown>).blockades = [[1, 2]]))).toBe(false);
    expect(bad((s) => ((s as unknown as Record<string, unknown>).blockades = [[1, 2, 0]]))).toBe(false);
    expect(bad((s) => ((s as unknown as Record<string, unknown>).blockades = [[1, 2, 'r']]))).toBe(false);
    expect(bad((s) => ((s as unknown as Record<string, unknown>).blockades = [[1, 2, 5]]))).toBe(true);
  });
});
