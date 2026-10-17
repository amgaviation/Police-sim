import { describe, expect, it } from 'vitest';
import { PULLOVER } from '../../src/traffic/data';
import { PULL } from '../../src/traffic/trafficSystem';
import { laneRef } from '../../src/world/roadGraph';
import { carInfo, followCar, lineGraph, makeHarness, runFor, slotOf, type Harness } from './helpers';

const EAST = laneRef(0, 0, 0);
const WEST = laneRef(0, 1, 0);

async function road(): Promise<{ h: Harness; ahead: number[]; oncoming: number }> {
  const h = await makeHarness(lineGraph());
  h.sys.densityScale = 0;
  h.sys.spawnAt(EAST, 1000, { speed: 12, behavior: 0, desiredFactor: 1 });
  h.sys.spawnAt(EAST, 1030, { speed: 12, behavior: 0, desiredFactor: 1 });
  h.sys.spawnAt(WEST, 1900, { speed: 12, behavior: 0, desiredFactor: 1 });
  const v = h.sys.view;
  return { h, ahead: [v.vehicleId[0] ?? 0, v.vehicleId[1] ?? 0], oncoming: v.vehicleId[2] ?? 0 };
}

/** The player car 20 m behind the first car (x = -500 - 20 at the start), driving at `speed`. */
function player(h: Harness, x: number, speed: number, siren: boolean): void {
  const f = h.focus;
  f.obstacle = true;
  f.ox = x;
  f.oz = 1.75;
  f.ovx = speed;
  f.ovz = 0;
  f.x = x;
  f.z = 1.75;
  f.heading = -Math.PI / 2; // travelling +x
  f.lights = true;
  f.siren = siren;
}

describe('yielding to emergency vehicles', () => {
  it('cars ahead of lights and siren move to the curb and stop, then merge back once it has passed', async () => {
    const { h, ahead, oncoming } = await road();
    let x = -520;
    let t = runFor(h, 0, 12, () => player(h, (x += 4 / 60), 4, true));
    // The car right ahead (inside the stop window) is pulled over; the one further on yields.
    for (const id of ahead) {
      const slot = slotOf(h, id);
      const info = h.sys.inspect(slot, carInfo());
      expect(info.pull).toBe(id === ahead[0] ? PULL.stopped : PULL.yielding);
      expect(info.shoulder).toBeGreaterThan(2);
      expect(h.sys.view.speed[slot]).toBeLessThan(0.01);
    }
    expect(h.sys.stopVehicleId).toBe(ahead[0]);
    expect(h.sys.inspect(slotOf(h, oncoming), carInfo()).pull).toBe(PULL.none);
    // Drive past them at 15 m/s: they merge back and drive on.
    t = runFor(h, t, 12, () => player(h, (x += 15 / 60), 15, true));
    t = runFor(h, t, 8, () => player(h, (x += 15 / 60), 15, false));
    for (const id of ahead) {
      const slot = slotOf(h, id);
      const info = h.sys.inspect(slot, carInfo());
      expect(info.pull).toBe(PULL.none);
      expect(info.shoulder).toBe(0);
      expect(h.sys.view.speed[slot]).toBeGreaterThan(3);
    }
    expect(t).toBeGreaterThan(30);
  });

  it('lights without the siren do not make traffic yield', async () => {
    const { h, ahead } = await road();
    let x = -560;
    runFor(h, 0, 10, () => player(h, (x += 10 / 60), 10, false));
    for (const id of ahead) {
      const info = h.sys.inspect(slotOf(h, id), carInfo());
      expect(info.pull === PULL.none || info.pull === PULL.pulling || info.pull === PULL.stopped).toBe(true);
      expect(info.pull).not.toBe(PULL.yielding);
    }
  });

  it('a yielding car merges back after timeoutS and does not yield again at once', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    h.sys.spawnAt(EAST, 1000, { speed: 12, behavior: 0, desiredFactor: 1 });
    const id = h.sys.view.vehicleId[0] ?? 0;
    // The source keeps 45 m behind (beyond the stop window), slowing with the car: it never passes.
    let t = runFor(h, 0, 2, () => followCar(h, slotOf(h, id), 45, true, true));
    expect(h.sys.inspect(0, carInfo()).pull).toBe(PULL.yielding);
    t = runFor(h, t, PULLOVER.yield.timeoutS, () => followCar(h, slotOf(h, id), 45, true, true));
    expect(h.sys.inspect(0, carInfo()).pull).toBe(PULL.merging);
    // Within the cooldown it never yields again (with the light bar on it may become a stop target).
    let yielded = false;
    runFor(h, t, 8, () => {
      followCar(h, slotOf(h, id), 45, true, true);
      if (h.sys.inspect(0, carInfo()).pull === PULL.yielding) yielded = true;
    });
    expect(yielded).toBe(false);
  });
});
