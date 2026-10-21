import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { createGameWorld, spawn } from '../../src/ecs/world';
import { Drivable, FAULT, LIGHT, TRIM, VehicleLook, attachDrivable, attachVehicleLook, trimBits } from '../../src/vehicles/components';
import { vehicleModel } from '../../src/vehicles/model';

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

  it('attachVehicleLook resets lean and rotor and defaults the trim to the model equipment', () => {
    const world = createGameWorld();
    const eid = spawn(world);
    VehicleLook.lean[eid] = 0.3;
    VehicleLook.rotor[eid] = 1;
    VehicleLook.trim[eid] = 255;
    attachVehicleLook(world, eid, vehicleModel('patrol_sedan').index, 0x123456);
    expect(VehicleLook.lean[eid]).toBe(0);
    expect(VehicleLook.rotor[eid]).toBe(0);
    expect(VehicleLook.trim[eid]).toBe(TRIM.pushBar | TRIM.spotlight);
    attachVehicleLook(world, eid, vehicleModel('sedan').index, 0x123456);
    expect(VehicleLook.trim[eid]).toBe(0);
    attachVehicleLook(world, eid, 250, 0);
    expect(VehicleLook.trim[eid]).toBe(0);
  });

  it('trimBits follows the model equipment and the light-bar style', () => {
    expect(TRIM).toEqual({ pushBar: 1, spotlight: 2, hiddenBar: 4, noBar: 8 });
    const sedan = vehicleModel('patrol_sedan');
    expect(trimBits(sedan, true, true, 'roof')).toBe(3);
    expect(trimBits(sedan, false, true, 'roof')).toBe(TRIM.spotlight);
    expect(trimBits(sedan, true, false, 'hidden')).toBe(TRIM.pushBar | TRIM.hiddenBar);
    expect(trimBits(sedan, false, false, 'none')).toBe(TRIM.noBar);
    // No push bumper or spotlight on the model: those bits never turn on.
    const unmarked = vehicleModel('unmarked_sedan');
    expect(trimBits(unmarked, true, true, 'hidden')).toBe(TRIM.spotlight | TRIM.hiddenBar);
    expect(trimBits(vehicleModel('police_motorcycle'), true, true, 'roof')).toBe(0);
  });
});
