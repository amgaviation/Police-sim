import { describe, expect, it } from 'vitest';
import { vehicleRecord } from '../../src/traffic/registry';
import { TRAFFIC_STATE, type TrafficCarInfo, type TrafficCarSave } from '../../src/traffic/trafficSystem';
import { vehicleModel, VEHICLE_MODELS } from '../../src/vehicles/model';
import { JUNCTION, ROAD_CLASS, laneRef, type RoadGraph } from '../../src/world/roadGraph';
import { DT, NOON, buildGraph, crossGraph, makeHarness, type Harness } from './helpers';

/** The harness seed (`makeHarness` default): registry records, and so models, depend on it. */
const SEED = 7;

function info(): TrafficCarInfo {
  return { lane: 0, s: 0, nextLane: 0, behavior: 0, desiredFactor: 0, headway: 0, lateral: 0, weaveAmp: 0, limitMph: 0, inJunction: false };
}

function car(vehicleId: number, lane: number, s: number, speed: number, nextLane: number, extra: Partial<TrafficCarSave> = {}): TrafficCarSave {
  return {
    vehicleId, lane, s, speed, accel: 0, nextLane, state: TRAFFIC_STATE.driving, behavior: 0, desiredFactor: 1, headway: 1.4,
    weaveAmp: 0, weavePeriod: 1, weavePhase: 0, stopPhase: 0, stopTimer: 0, holding: -1, reported: 0, flags: 0, ...extra,
  };
}

async function restored(graph: RoadGraph, cars: TrafficCarSave[]): Promise<Harness> {
  const h = await makeHarness(graph, SEED);
  h.sys.densityScale = 0;
  h.sys.restore({ version: 1, rng: h.sys.snapshot().rng, spawnSeq: 0, cars });
  return h;
}

/** Penetration depth (m) of two cars' body boxes (separating axis test), <= 0 when apart. */
function penetration(h: Harness, i: number, j: number): number {
  const v = h.sys.view;
  const box = (k: number): [number, number, number, number, number, number] => {
    const m = vehicleModel(vehicleRecord(SEED, v.vehicleId[k] ?? 0).modelId);
    const yaw = v.yaw[k] ?? 0;
    // Forward is (-sin, -cos); right is (cos, -sin).
    return [v.x[k] ?? 0, v.z[k] ?? 0, -Math.sin(yaw), -Math.cos(yaw), m.body.length / 2, m.body.width / 2];
  };
  const a = box(i), b = box(j);
  let depth = Infinity;
  for (const [ax, az] of [[a[2], a[3]], [-a[3], a[2]], [b[2], b[3]], [-b[3], b[2]]] as const) {
    const ra = a[4] * Math.abs(a[2] * ax + a[3] * az) + a[5] * Math.abs(-a[3] * ax + a[2] * az);
    const rb = b[4] * Math.abs(b[2] * ax + b[3] * az) + b[5] * Math.abs(-b[3] * ax + b[2] * az);
    const d = Math.abs((b[0] - a[0]) * ax + (b[1] - a[1]) * az);
    depth = Math.min(depth, ra + rb - d);
  }
  return depth;
}

/** Steps `seconds` (focus unchanged); returns the largest box penetration between any two cars. */
function maxPenetration(h: Harness, seconds: number, each?: (t: number) => void, start = 0): number {
  let worst = -Infinity;
  let t = start;
  for (let n = 0; n < Math.round(seconds / DT); n++) {
    t += DT;
    h.sys.step(DT, t, NOON, h.focus);
    each?.(t);
    const count = h.sys.view.count;
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) worst = Math.max(worst, penetration(h, i, j));
  }
  return worst;
}

describe('junction conflicts between traffic cars', () => {
  it('major-road cars wait for a stop-sign car that is already crossing', async () => {
    const h = await restored(crossGraph(JUNCTION.minorStop, { major: { roadClass: ROAD_CLASS.arterial, speedMph: 40 } }), [
      car(10, laneRef(0, 0, 0), 989, 0, laneRef(2, 1, 0)), // left-turner yielding to oncoming traffic
      car(11, laneRef(1, 1, 0), 932, 12, laneRef(0, 1, 0)),
      car(12, laneRef(2, 0, 0), 989, 0, laneRef(3, 0, 0)), // minor road, straight across
    ]);
    expect(maxPenetration(h, 20)).toBeLessThan(0);
  });

  it('a left-turner waiting at a signal clears on yellow instead of blocking its lane for whole cycles', async () => {
    const turner = laneRef(0, 0, 0);
    const cars = [car(10, turner, 989, 0, laneRef(2, 1, 0)), car(11, turner, 972, 0, laneRef(1, 0, 0))];
    for (let i = 0; i < 16; i++) cars.push(car(20 + i, laneRef(1, 1, 0), 962 - 22 * i, 11, laneRef(0, 1, 0)));
    const h = await restored(crossGraph(JUNCTION.signal), cars);
    let left = -1;
    const c = info();
    maxPenetration(h, 60, (t) => {
      if (left >= 0) return;
      for (let i = 0; i < h.sys.view.count; i++) {
        if (h.sys.view.vehicleId[i] === 10 && h.sys.inspect(i, c).lane !== turner) left = t;
      }
    });
    // Group 0 turns yellow at t = 20 and red at 24 (CROSS_SIGNAL).
    expect(left).toBeGreaterThan(0);
    // It goes once the oncoming queue has stopped for the red, before the next cycle (t = 71).
    expect(left).toBeLessThan(40);
    // Finishing a turn taken on green is legal, even when the light has changed since.
    expect(h.violations.filter((v) => v.vehicleId === 10)).toEqual([]);
  });

  it('oncoming cars on the same green wait for a slow left-turner that has committed', async () => {
    // Box truck (9) and city bus (35) pull away from the line; the oncoming sedan (10) arrives during the turn.
    for (const id of [9, 35]) {
      const hl = vehicleModel(vehicleRecord(SEED, id).modelId).body.length / 2;
      const graph = crossGraph(JUNCTION.signal, { major: { speedMph: 40 }, minor: { speedMph: 40 } });
      const h = await restored(graph, [
        car(id, laneRef(0, 0, 0), 992 - hl - 0.3, 0, laneRef(2, 1, 0), { holding: 0 }),
        car(10, laneRef(1, 1, 0), 992 - 2.43 - 60 - 0.3, 12, laneRef(0, 1, 0), { desiredFactor: 12 / 17.88 }),
      ]);
      expect(maxPenetration(h, 15)).toBeLessThan(0);
    }
  });

  it('two cars bound for the same exit lane from different approaches do not enter it together', async () => {
    const graph = crossGraph(JUNCTION.minorStop, { major: { roadClass: ROAD_CLASS.arterial, speedMph: 40 } });
    const h = await restored(graph, [
      car(10, laneRef(0, 0, 0), 992, 5, laneRef(2, 1, 0), { holding: 0 }), // left turn, already in the box
      car(11, laneRef(1, 1, 0), 992 - 2.4 - 10, 6.6, laneRef(2, 1, 0)), // right turn into the same lane
    ]);
    const prev = new Map<number, number>();
    let worst = 0;
    expect(maxPenetration(h, 10, () => {
      for (let i = 0; i < h.sys.view.count; i++) {
        const id = h.sys.view.vehicleId[i] ?? 0, v = h.sys.view.speed[i] ?? 0;
        worst = Math.max(worst, ((prev.get(id) ?? v) - v) / DT);
        prev.set(id, v);
      }
    })).toBeLessThan(0);
    expect(worst).toBeLessThan(Math.max(...VEHICLE_MODELS.map((m) => m.traffic.maxDecel)) + 0.5);
  });

  it('a law-abiding left-turner far from the line on yellow stops instead of entering on red', async () => {
    const graph = crossGraph(JUNCTION.signal, { major: { speedMph: 40 }, minor: { speedMph: 40 } });
    const h = await restored(graph, [car(10, laneRef(0, 0, 0), 992 - 2.4 - 55, 17.5, laneRef(2, 1, 0))]);
    const c = info();
    let enteredAt = -1;
    // Group 0 is yellow 20-24 and red from 24; group 1 is green from 25.5.
    maxPenetration(h, 12, (t) => {
      if (enteredAt < 0 && h.sys.inspect(0, c).inJunction) enteredAt = t;
    }, 20);
    expect(h.violations).toEqual([]);
    expect(enteredAt).toBe(-1);
    expect(h.sys.view.speed[0]).toBeLessThan(0.1);
  });

  it('long vehicles cut a tight corner inward instead of sweeping the next lane or a waiting car', async () => {
    let busId = 0;
    while (vehicleRecord(SEED, busId).modelId !== 'city_bus') busId++;
    const graph = crossGraph(JUNCTION.allWayStop, { major: { roadClass: ROAD_CLASS.arterial }, minor: { roadClass: ROAD_CLASS.arterial }, lanes: 2 });
    const bus = car(busId, laneRef(0, 0, 0), 989.6, 0, laneRef(3, 0, 0), { stopPhase: 2 });
    const h2 = await restored(graph, [bus, car(busId + 1, laneRef(0, 0, 1), 989.1, 0, -1, { state: TRAFFIC_STATE.crashed })]);
    expect(maxPenetration(h2, 12)).toBeLessThan(0);
    const one = crossGraph(JUNCTION.allWayStop, { major: { roadClass: ROAD_CLASS.arterial }, minor: { roadClass: ROAD_CLASS.arterial } });
    const h1 = await restored(one, [bus, car(busId + 1, laneRef(3, 1, 0), 989.1, 0, -1, { state: TRAFFIC_STATE.crashed })]);
    expect(maxPenetration(h1, 12)).toBeLessThan(0);
  });
});

describe('lane choice at a 2-lane bend', () => {
  it('side-by-side cars keep distinct target lanes and never overlap', async () => {
    const graph = buildGraph([[-300, 0], [0, 0], [0, -300]], [{ from: 0, to: 1, lanes: 2 }, { from: 1, to: 2, lanes: 2 }]);
    const h = await makeHarness(graph, SEED);
    h.sys.densityScale = 0;
    h.sys.spawnAt(laneRef(0, 0, 0), 250, { vehicleId: 10, speed: 8, behavior: 0, desiredFactor: 1 });
    h.sys.spawnAt(laneRef(0, 0, 1), 250, { vehicleId: 11, speed: 8, behavior: 0, desiredFactor: 1 });
    const a = h.sys.inspect(0, info()).nextLane;
    const b = h.sys.inspect(1, info()).nextLane;
    expect(a).not.toBe(b);
    expect(maxPenetration(h, 20)).toBeLessThan(0);
  });

  it('a true lane drop merges behind the sibling lane instead of through it', async () => {
    // Two lanes each way into one lane each way: lane 1 has no exit of its own.
    const graph = buildGraph([[-300, 0], [0, 0], [300, 0]], [{ from: 0, to: 1, lanes: 2 }, { from: 1, to: 2, lanes: 1 }]);
    const h = await makeHarness(graph, SEED);
    h.sys.densityScale = 0;
    h.sys.spawnAt(laneRef(0, 0, 0), 250, { vehicleId: 10, speed: 8, behavior: 0, desiredFactor: 1 });
    h.sys.spawnAt(laneRef(0, 0, 1), 250, { vehicleId: 11, speed: 8, behavior: 0, desiredFactor: 1 });
    expect(h.sys.inspect(0, info()).nextLane).toBe(h.sys.inspect(1, info()).nextLane);
    expect(maxPenetration(h, 20)).toBeLessThan(0);
  });
});

describe('parked player vehicles', () => {
  it('traffic stops behind a parked player car in its lane and ignores one in the next lane', async () => {
    const graph = buildGraph([[-1500, 0], [1500, 0]], [{ from: 0, to: 1, speedMph: 40 }]);
    const h = await makeHarness(graph, SEED);
    h.sys.densityScale = 0;
    h.sys.spawnAt(laneRef(0, 0, 0), 1400, { speed: 15, behavior: 0, desiredFactor: 1 });
    h.sys.spawnAt(laneRef(0, 1, 0), 1300, { speed: 15, behavior: 0, desiredFactor: 1 });
    const p = graph.lanePoint(laneRef(0, 0, 0), 1500, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    // Parked at an angle across the lane (the officer pulled over badly).
    const yaw = 0.2;
    h.focus.parked = [{ x: p.x, z: p.z, hx: Math.cos(yaw), hz: Math.sin(yaw), halfLength: 2.45, halfWidth: 0.95 }];
    h.focus.parkedCount = 1;
    h.focus.x = p.x;
    h.focus.z = p.z;
    let t = 0;
    for (let i = 0; i < 20 / DT; i++) h.sys.step(DT, (t += DT), NOON, h.focus);
    const ahead = h.sys.inspect(0, info());
    expect(h.sys.view.speed[0]).toBeLessThan(0.05);
    // Front bumper short of the parked car's rotated footprint (2.45 cos + 0.95 sin along the lane).
    const reach = 2.45 * Math.cos(yaw) + 0.95 * Math.sin(yaw);
    expect(ahead.s).toBeLessThan(1500 - reach - 2.2);
    expect(ahead.s).toBeGreaterThan(1500 - reach - 12);
    // The oncoming car in the other lane drove past.
    expect(h.sys.view.speed[1]).toBeGreaterThan(14);
  });
});

describe('spawning', () => {
  it('a car spawned behind a stopped car can stop with the model braking (no instant stops)', async () => {
    const graph = buildGraph([[-1500, 0], [1500, 0]], [{ from: 0, to: 1, speedMph: 45 }]);
    const crashed: TrafficCarSave[] = [];
    for (let k = 0; k < 12; k++) {
      crashed.push(car(100 + k, laneRef(0, (k % 2) as 0 | 1, 0), 400 + 200 * k, 0, -1, { state: TRAFFIC_STATE.crashed }));
    }
    const h = await restored(graph, crashed);
    h.sys.densityScale = 6;
    h.sys.populate(h.focus, NOON);
    expect(h.sys.activeCount).toBeGreaterThan(30);
    const before = new Map<number, number>();
    const record = (): void => {
      for (let i = 0; i < h.sys.view.count; i++) before.set(h.sys.view.vehicleId[i] ?? 0, h.sys.view.speed[i] ?? 0);
    };
    record();
    const maxDecel = Math.max(...VEHICLE_MODELS.map((m) => m.traffic.maxDecel));
    let worst = 0;
    let t = 0;
    h.sys.densityScale = 0;
    for (let n = 0; n < 3 / DT; n++) {
      h.sys.step(DT, (t += DT), NOON, h.focus);
      for (let i = 0; i < h.sys.view.count; i++) {
        const prev = before.get(h.sys.view.vehicleId[i] ?? 0);
        if (prev !== undefined) worst = Math.max(worst, (prev - (h.sys.view.speed[i] ?? 0)) / DT);
      }
      record();
    }
    expect(worst).toBeLessThan(maxDecel + 0.5);
  });
});
