import { afterEach, describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { vehicleModel } from '../../src/vehicles/model';
import type { WheelPose } from '../../src/vehicles/drivableVehicle';
import { disposeRigs, makeRig } from './harness';

afterEach(disposeRigs);

type TireBurst = EventMap['vehicle:tireBurst'];

describe('DrivableVehicle.burstTire', () => {
  it('flattens the tyre once and emits vehicle:tireBurst once', async () => {
    const rig = await makeRig();
    const bursts: TireBurst[] = [];
    rig.bus.on('vehicle:tireBurst', (e) => bursts.push(e));
    expect(rig.vehicle.needsRepair).toBe(false);
    expect(rig.vehicle.burstTire(1, rig.bus)).toBe(true);
    expect(bursts).toEqual([{ eid: rig.vehicle.eid, wheel: 1 }]);
    // Already flat: nothing changes, nothing is emitted.
    expect(rig.vehicle.burstTire(1, rig.bus)).toBe(false);
    expect(bursts).toHaveLength(1);
    rig.step();
    expect(rig.vehicle.telemetry.tireFlat).toEqual([false, true, false, false]);
    expect(rig.vehicle.needsRepair).toBe(true);
    // Same effects as an impact burst: smaller radius on that wheel only.
    const pose: WheelPose = { x: 0, y: 0, z: 0, steer: 0, spin: 0, radius: 0, inContact: false };
    const radius = vehicleModel('patrol_sedan').tires.radius;
    expect(rig.vehicle.wheelPose(1, pose).radius).toBeCloseTo(radius * 0.85, 5);
    expect(rig.vehicle.wheelPose(0, pose).radius).toBeCloseTo(radius, 5);
  });

  it('refuses a wheel out of range and works without a bus', async () => {
    const rig = await makeRig();
    const bursts: TireBurst[] = [];
    rig.bus.on('vehicle:tireBurst', (e) => bursts.push(e));
    for (const wheel of [-1, 4, 0.5, Number.NaN]) expect(rig.vehicle.burstTire(wheel, rig.bus)).toBe(false);
    expect(bursts).toHaveLength(0);
    expect(rig.vehicle.needsRepair).toBe(false);
    expect(rig.vehicle.burstTire(3)).toBe(true);
    expect(bursts).toHaveLength(0);
    rig.step();
    expect(rig.vehicle.telemetry.tireFlat).toEqual([false, false, false, true]);
  });

  it('repair restores burst tyres, which can burst again', async () => {
    const rig = await makeRig();
    rig.vehicle.burstTire(0, rig.bus);
    rig.vehicle.burstTire(1, rig.bus);
    rig.step();
    expect(rig.vehicle.telemetry.tireFlat).toEqual([true, true, false, false]);
    rig.vehicle.repair();
    rig.step();
    expect(rig.vehicle.telemetry.tireFlat).toEqual([false, false, false, false]);
    expect(rig.vehicle.burstTire(0, rig.bus)).toBe(true);
  });

  it('survives a save: the flat tyre is serialized', async () => {
    const rig = await makeRig();
    rig.vehicle.burstTire(2, rig.bus);
    expect(rig.vehicle.serialize().tireFlat).toEqual([false, false, true, false]);
  });
});
