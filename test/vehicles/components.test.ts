import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { createGameWorld, spawn } from '../../src/ecs/world';
import { Drivable, FAULT, LIGHT, VehicleLook, attachDrivable, attachVehicleLook } from '../../src/vehicles/components';

describe('vehicle components', () => {
  it('attachVehicleLook adds the component and resets recycled fields', () => {
    const world = createGameWorld();
    const eid = spawn(world);
    VehicleLook.lights[eid] = LIGHT.head | LIGHT.brake;
    VehicleLook.damage.fill(0.5, eid * 4, eid * 4 + 4);
    attachVehicleLook(world, eid, 3, 0x123456, FAULT.tailOut);
    expect(hasComponent(world, eid, VehicleLook)).toBe(true);
    expect(VehicleLook.model[eid]).toBe(3);
    expect(VehicleLook.color[eid]).toBe(0x123456);
    expect(VehicleLook.faults[eid]).toBe(FAULT.tailOut);
    expect(VehicleLook.lights[eid]).toBe(0);
    expect(Array.from(VehicleLook.damage.subarray(eid * 4, eid * 4 + 4))).toEqual([0, 0, 0, 0]);
  });

  it('attachDrivable tags the entity', () => {
    const world = createGameWorld();
    const eid = spawn(world);
    attachDrivable(world, eid);
    expect(hasComponent(world, eid, Drivable)).toBe(true);
  });
});
