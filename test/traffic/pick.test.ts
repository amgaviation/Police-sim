import { describe, expect, it } from 'vitest';
import { pickTrafficCar, type PickResult } from '../../src/traffic/pick';
import { FLEET_ID_BASE, type TrafficView } from '../../src/traffic/trafficSystem';
import { vehicleModel } from '../../src/vehicles/model';

const SEDAN = vehicleModel('sedan');
const HALF_LEN = SEDAN.body.length / 2;
const HALF_WID = SEDAN.body.width / 2;
/** Yaw of a car travelling +x (forward = (-sin, -cos)). */
const EAST = -Math.PI / 2;

interface Car {
  x: number;
  z: number;
  yaw: number;
  id: number;
}

function view(cars: Car[]): TrafficView {
  const n = cars.length;
  const v = {
    count: n,
    eid: Int32Array.from(cars, (_, i) => 100 + i),
    vehicleId: Int32Array.from(cars, (c) => c.id),
    x: Float32Array.from(cars, (c) => c.x),
    z: Float32Array.from(cars, (c) => c.z),
    yaw: Float32Array.from(cars, (c) => c.yaw),
    speed: new Float32Array(n),
    state: new Uint8Array(n),
    model: new Uint8Array(n).fill(SEDAN.index),
  };
  return v;
}

function result(): PickResult {
  return { slot: -1, vehicleId: -1, eid: -1, distance: -1 };
}

describe('pickTrafficCar', () => {
  it('hits a car straight ahead at its rear bumper', () => {
    const out = result();
    const hit = pickTrafficCar(view([{ x: 20, z: 0, yaw: EAST, id: 5 }]), 0, 0, 1, 0, 50, 0, out);
    expect(hit).toBe(out);
    expect(out.slot).toBe(0);
    expect(out.vehicleId).toBe(5);
    expect(out.eid).toBe(100);
    expect(out.distance).toBeCloseTo(20 - HALF_LEN, 5);
    // A non-unit direction gives the same distance; side-on the box is narrow.
    expect(pickTrafficCar(view([{ x: 20, z: 0, yaw: EAST, id: 5 }]), 0, 0, 7, 0, 50, 0, out)?.distance).toBeCloseTo(20 - HALF_LEN, 5);
    expect(pickTrafficCar(view([{ x: 20, z: 0, yaw: 0, id: 5 }]), 0, 0, 1, 0, 50, 0, out)?.distance).toBeCloseTo(20 - HALF_WID, 5);
  });

  it('misses a car beside the ray and behind the origin', () => {
    const out = result();
    expect(pickTrafficCar(view([{ x: 20, z: HALF_WID + 0.3, yaw: EAST, id: 5 }]), 0, 0, 1, 0, 50, 0, out)).toBeNull();
    expect(pickTrafficCar(view([{ x: -20, z: 0, yaw: EAST, id: 5 }]), 0, 0, 1, 0, 50, 0, out)).toBeNull();
    expect(pickTrafficCar(view([{ x: 20, z: 0, yaw: EAST, id: 5 }]), 0, 0, 0, 0, 50, 0, out)).toBeNull();
  });

  it('assist inflates the box', () => {
    const out = result();
    const cars = view([{ x: 20, z: HALF_WID + 0.3, yaw: EAST, id: 5 }]);
    expect(pickTrafficCar(cars, 0, 0, 1, 0, 50, 0.5, out)?.vehicleId).toBe(5);
    expect(out.distance).toBeCloseTo(20 - HALF_LEN - 0.5, 5);
  });

  it('picks the nearest of two and skips fleet cars', () => {
    const out = result();
    const cars = [
      { x: 40, z: 0, yaw: EAST, id: 1 },
      { x: 15, z: 0.4, yaw: EAST, id: 2 },
      { x: 8, z: 0, yaw: EAST, id: FLEET_ID_BASE + 1 },
    ];
    expect(pickTrafficCar(view(cars), 0, 0, 1, 0, 100, 0, out)?.vehicleId).toBe(2);
    expect(out.slot).toBe(1);
  });

  it('ignores hits beyond maxDistance; the origin inside a box is distance 0', () => {
    const out = result();
    expect(pickTrafficCar(view([{ x: 60, z: 0, yaw: EAST, id: 5 }]), 0, 0, 1, 0, 50, 0, out)).toBeNull();
    expect(pickTrafficCar(view([{ x: 60, z: 0, yaw: EAST, id: 5 }]), 0, 0, 1, 0, 60, 0, out)?.vehicleId).toBe(5);
    expect(pickTrafficCar(view([{ x: 0.5, z: 0, yaw: 0.3, id: 5 }]), 0, 0, 0, 1, 10, 0, out)?.distance).toBe(0);
  });

  it('works on a rotated car (diagonal ray)', () => {
    const out = result();
    // Car heading north-east at (10, 10): forward (-sin, -cos) = (0.707, 0.707) -> yaw = -3 pi / 4.
    const cars = view([{ x: 10, z: 10, yaw: (-3 * Math.PI) / 4, id: 9 }]);
    expect(pickTrafficCar(cars, 0, 0, 1, 1, 50, 0, out)?.distance).toBeCloseTo(Math.hypot(10, 10) - HALF_LEN, 4);
    expect(pickTrafficCar(cars, 0, 0, 1, 0.4, 50, 0, out)).toBeNull();
  });
});
