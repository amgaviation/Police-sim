import { describe, expect, it } from 'vitest';
import { TRAFFIC_STATE, type TrafficCarInfo, type TrafficCarSave } from '../../src/traffic/trafficSystem';
import { JUNCTION, ROAD_CLASS, TURN, laneDir, laneEdge, laneIndex, laneRef, type RoadGraph } from '../../src/world/roadGraph';
import { DT, NOON, crossGraph, lineGraph, makeHarness, type CrossOptions, type Harness } from './helpers';

/** The arms are 1000 m with an 8 m setback: stop lines at s = 992. */
const LINE = 992;
const ARTERIAL_40: CrossOptions = { major: { roadClass: ROAD_CLASS.arterial, speedMph: 40 } };

function info(): TrafficCarInfo {
  return { lane: 0, s: 0, nextLane: 0, behavior: 0, desiredFactor: 0, headway: 0, lateral: 0, weaveAmp: 0, limitMph: 0, inJunction: false };
}

function car(vehicleId: number, lane: number, s: number, speed: number, nextLane: number): TrafficCarSave {
  return {
    vehicleId, lane, s, speed, accel: 0, nextLane, state: TRAFFIC_STATE.driving, behavior: 0, desiredFactor: 1, headway: 1.4,
    weaveAmp: 0, weavePeriod: 1, weavePhase: 0, stopPhase: 0, stopTimer: 0, holding: -1, reported: 0, flags: 0,
  };
}

async function junction(graph: RoadGraph, cars: TrafficCarSave[]): Promise<Harness> {
  const h = await makeHarness(graph);
  h.sys.densityScale = 0;
  h.sys.restore({ version: 1, rng: h.sys.snapshot().rng, spawnSeq: 0, cars });
  return h;
}

/** Steps `seconds` with the focus at the junction; returns the smallest centre distance between the first two cars (3.5 m lanes: passing side by side is 3.5). */
function minDistance(h: Harness, seconds: number): number {
  let min = Infinity;
  let t = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    t += DT;
    h.sys.step(DT, t, NOON, h.focus);
    const v = h.sys.view;
    if (v.count < 2) continue;
    min = Math.min(min, Math.hypot((v.x[0] ?? 0) - (v.x[1] ?? 0), (v.z[0] ?? 0) - (v.z[1] ?? 0)));
  }
  return min;
}

/** The car with `vehicleId` has left `lane` (it crossed the junction). */
function crossed(h: Harness, vehicleId: number, lane: number): boolean {
  const v = h.sys.view;
  for (let i = 0; i < v.count; i++) if (v.vehicleId[i] === vehicleId) return h.sys.inspect(i, info()).lane !== lane;
  return false;
}

describe('junction conflicts', () => {
  it('a major-road left turn at a minor-stop junction yields to the oncoming car', async () => {
    const left = laneRef(0, 0, 0);
    const h = await junction(crossGraph(JUNCTION.minorStop, ARTERIAL_40), [
      car(10, left, 960, 10, laneRef(2, 1, 0)),
      car(11, laneRef(1, 1, 0), 920, 15, laneRef(0, 1, 0)),
    ]);
    expect(minDistance(h, 20)).toBeGreaterThan(3);
    expect(crossed(h, 10, left)).toBe(true);
  });

  it('a major-road car does not enter the junction behind a full exit lane', async () => {
    const exit = laneRef(1, 0, 0);
    const h = await junction(crossGraph(JUNCTION.minorStop, ARTERIAL_40), [
      car(10, laneRef(0, 0, 0), 940, 10, exit),
      { ...car(11, exit, 12, 0, -1), state: TRAFFIC_STATE.crashed },
    ]);
    minDistance(h, 15);
    const a = h.sys.inspect(0, info());
    expect(a.lane).toBe(laneRef(0, 0, 0));
    expect(a.inJunction).toBe(false);
    expect(h.sys.view.speed[0]).toBeLessThan(0.1);
  });

  it('a stop-sign car waits for a fast major-road car that is still beyond the fixed gap distance', async () => {
    const h = await junction(crossGraph(JUNCTION.minorStop, ARTERIAL_40), [
      car(10, laneRef(2, 0, 0), LINE - 3, 0, laneRef(3, 0, 0)),
      car(11, laneRef(0, 0, 0), LINE - 75, 17.9, laneRef(1, 0, 0)),
    ]);
    expect(minDistance(h, 15)).toBeGreaterThan(3);
    expect(crossed(h, 10, laneRef(2, 0, 0))).toBe(true);
  });

  it('a left turn on green waits for a fast oncoming car that is still beyond the fixed yield distance', async () => {
    const all40 = { major: { speedMph: 40 }, minor: { speedMph: 40 } };
    const h = await junction(crossGraph(JUNCTION.signal, all40), [
      car(10, laneRef(0, 0, 0), LINE - 3, 0, laneRef(2, 1, 0)),
      car(11, laneRef(1, 1, 0), LINE - 65, 17.9, laneRef(0, 1, 0)),
    ]);
    expect(minDistance(h, 15)).toBeGreaterThan(3);
    expect(crossed(h, 10, laneRef(0, 0, 0))).toBe(true);
  });
});

describe('lane choice', () => {
  it('turns right only from the curb lane, left only from the inner lane, and straight on lane to lane', async () => {
    const graph = crossGraph(JUNCTION.signal, { lanes: 2 });
    const h = await makeHarness(graph);
    h.sys.densityScale = 0;
    for (let k = 0; k < 20; k++) {
      h.sys.spawnAt(laneRef(0, 0, 0), 100 + 40 * k, { behavior: 0 });
      h.sys.spawnAt(laneRef(0, 0, 1), 100 + 40 * k, { behavior: 0 });
    }
    const turns = new Set<string>();
    const car = info();
    for (let i = 0; i < h.sys.activeCount; i++) {
      h.sys.inspect(i, car);
      const from = laneIndex(car.lane);
      const conn = graph.connections(laneEdge(car.lane), laneDir(car.lane)).find(
        (c) => c.edge === laneEdge(car.nextLane) && c.dir === laneDir(car.nextLane),
      );
      const to = laneIndex(car.nextLane);
      turns.add(`${String(from)}:${String(conn?.turn)}`);
      if (conn?.turn === TURN.right) expect([from, to]).toEqual([0, 0]);
      else if (conn?.turn === TURN.left) expect([from, to]).toEqual([1, 1]);
      else expect(to).toBe(from);
    }
    // Both lanes go straight; each takes its own turn.
    expect([...turns].sort()).toEqual([`0:${String(TURN.straight)}`, `0:${String(TURN.right)}`, `1:${String(TURN.left)}`, `1:${String(TURN.straight)}`].sort());
  });
});

describe('player obstacle', () => {
  it('oncoming traffic does not brake for the player passing in the opposite lane', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    h.sys.spawnAt(laneRef(0, 1, 0), 1400, { speed: 15, behavior: 0, desiredFactor: 1 });
    const x0 = h.sys.view.x[0] ?? 0;
    const z0 = h.sys.view.z[0] ?? 0;
    // The player's car (2.4 m half length, 0.95 m half width) drives +x in the other lane.
    Object.assign(h.focus, { x: x0, z: z0, obstacle: true, ox: x0 - 70, oz: -z0, ovx: 15, ovz: 0, oRadius: 2.4, oHalfWidth: 0.95 });
    let t = 0;
    for (let i = 0; i < 120; i++) {
      t += DT;
      h.focus.ox += 15 * DT;
      h.sys.step(DT, t, NOON, h.focus);
    }
    expect(h.sys.view.speed[0]).toBeGreaterThan(14);
    // The same obstacle in the car's own lane still stops it.
    Object.assign(h.focus, { ox: (h.sys.view.x[0] ?? 0) - 40, oz: h.sys.view.z[0] ?? 0, ovx: 0 });
    for (let i = 0; i < 600; i++) {
      t += DT;
      h.sys.step(DT, t, NOON, h.focus);
    }
    expect(h.sys.view.speed[0]).toBeLessThan(0.1);
  });
});

describe('clear', () => {
  it('with emit, every traffic:spawned is matched by a traffic:despawned, so listeners keep the live set', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    const live = new Set<number>();
    h.bus.on('traffic:spawned', (e) => live.add(e.eid));
    h.bus.on('traffic:despawned', (e) => live.delete(e.eid));
    for (let k = 0; k < 5; k++) h.sys.spawnAt(laneRef(0, 0, 0), 100 + 50 * k);
    expect(live.size).toBe(5);
    h.sys.clear(true);
    expect(live.size).toBe(0);
    expect(h.sys.stats.despawned).toBe(5);
    for (let k = 0; k < 3; k++) h.sys.spawnAt(laneRef(0, 1, 0), 100 + 50 * k);
    expect(live.size).toBe(h.sys.activeCount);
    h.sys.clear();
    expect(live.size).toBe(3);
    expect(h.sys.stats.despawned).toBe(5);
  });
});
