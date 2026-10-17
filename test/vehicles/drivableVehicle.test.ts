import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../../src/physics/physics';
import { LIGHT, VehicleLook } from '../../src/vehicles/components';
import { mapDriverInput, type DriverControls } from '../../src/vehicles/controls';
import { DrivableVehicle, dragCoefficient, type SerializedVehicle, type WheelPose } from '../../src/vehicles/drivableVehicle';
import type { VehicleDamagedEvent } from '../../src/vehicles/events';
import { restHeight, vehicleModel, type VehicleModel } from '../../src/vehicles/model';
import { SURFACE_NAMES, surfaceRolling } from '../../src/vehicles/surfaces';
import { DT, brakeTest, disposeRigs, holdSpeed, makeEnv, makeRig, vehicleRng, velocityHeading, type Rig } from './harness';

const sedan = vehicleModel('patrol_sedan');
const surface = (name: (typeof SURFACE_NAMES)[number]): number => SURFACE_NAMES.indexOf(name);

afterEach(() => {
  disposeRigs();
});

/** Accelerates to `kmh` (full throttle), then holds `controls` for `seconds`; returns [yaw, heading] change. */
function turnWhile(rig: Rig, kmh: number, controls: Partial<DriverControls>, seconds: number): [number, number] {
  rig.controls.throttle = 1;
  rig.run(() => rig.vehicle.telemetry.speedKmh >= kmh, 30);
  Object.assign(rig.controls, { throttle: 0 }, controls);
  const yaw0 = rig.yaw();
  const heading0 = velocityHeading(rig);
  rig.run(() => rig.vehicle.telemetry.speed < 0.5, seconds);
  return [rig.yaw() - yaw0, velocityHeading(rig) - heading0];
}

function withFlatTyre(rig: Rig, wheel: number): void {
  const data = rig.vehicle.serialize();
  data.tireFlat[wheel] = true;
  rig.vehicle.dispose();
  rig.vehicle = DrivableVehicle.restore(rig.physics, rig.vehicle.eid, data, vehicleRng());
}

describe('DrivableVehicle on dry asphalt', () => {
  it('settles at rest height and drives toward local -Z with positive speed', async () => {
    const rig = await makeRig();
    const body = rig.physics.getBody(1);
    expect(body?.translation().y).toBeCloseTo(restHeight(sedan), 1);
    expect(rig.vehicle.telemetry.airborne).toBe(false);
    rig.controls.throttle = 1;
    rig.run(() => false, 2);
    const p = rig.position();
    expect(p.z).toBeLessThan(-5);
    expect(Math.abs(p.x)).toBeLessThan(0.05);
    expect(rig.vehicle.telemetry.speed).toBeGreaterThan(5);
    expect(rig.vehicle.telemetry.speedKmh).toBeCloseTo(rig.vehicle.telemetry.speed * 3.6, 6);
    expect(rig.vehicle.telemetry.engineRunning).toBe(true);
    expect(rig.vehicle.telemetry.rpm).toBeGreaterThan(sedan.engine.idleRpm);
  });

  it('patrol sedan does 0-100 km/h in 6.5-9.5 s', async () => {
    const rig = await makeRig();
    rig.controls.throttle = 1;
    const t = rig.run(() => rig.vehicle.telemetry.speedKmh >= 100, 20);
    expect(t).toBeGreaterThan(6.5);
    expect(t).toBeLessThan(9.5);
    expect(rig.vehicle.telemetry.gear).toBeGreaterThan(1);
  });

  it('steer +1 turns right (yaw decreases)', async () => {
    const rig = await makeRig();
    const [yaw] = turnWhile(rig, 40, { throttle: 0.3, steer: 1 }, 2);
    expect(yaw).toBeLessThan(-0.3);
    const left = await makeRig();
    expect(turnWhile(left, 40, { throttle: 0.3, steer: -1 }, 2)[0]).toBeGreaterThan(0.3);
  });

  it('stops from 100 km/h with ABS in 38-48 m', async () => {
    const rig = await makeRig();
    const d = brakeTest(rig, 100);
    expect(d).toBeGreaterThan(38);
    expect(d).toBeLessThan(48);
  });

  it('without ABS the wheels lock: >= 10 % longer stop and no steering while locked', async () => {
    const noAbs: VehicleModel = { ...sedan, brakes: { ...sedan.brakes, abs: false } };
    const withAbs = brakeTest(await makeRig(sedan), 100);
    const locked = brakeTest(await makeRig(noAbs), 100);
    expect(locked).toBeGreaterThanOrEqual(withAbs * 1.1);

    const absRig = await makeRig(sedan);
    const [, absTurn] = turnWhile(absRig, 100, { brake: 1, steer: 1 }, 1.2);
    expect(absRig.vehicle.telemetry.absActive).toBe(true);
    const lockRig = await makeRig(noAbs);
    const [, lockTurn] = turnWhile(lockRig, 100, { brake: 1, steer: 1 }, 1.2);
    expect(lockRig.vehicle.telemetry.absActive).toBe(false);
    expect(absTurn).toBeLessThan(-0.2);
    expect(Math.abs(lockTurn)).toBeLessThan(Math.abs(absTurn) * 0.25);
  });

  it('wet, snow and loose surfaces lengthen the stop', async () => {
    const dry = brakeTest(await makeRig(), 100);
    expect(brakeTest(await makeRig(sedan, makeEnv(0, 1, 0)), 100)).toBeGreaterThanOrEqual(dry * 1.2);
    expect(brakeTest(await makeRig(sedan, makeEnv(0, 0, 1)), 100)).toBeGreaterThanOrEqual(dry * 2);
    expect(brakeTest(await makeRig(sedan, makeEnv(surface('gravel'))), 100)).toBeGreaterThanOrEqual(dry * 1.4);
    expect(brakeTest(await makeRig(sedan, makeEnv(surface('grass'))), 100)).toBeGreaterThanOrEqual(dry * 1.4);
  });

  it('brakes fade after repeated hard stops and recover after cooling', async () => {
    const rig = await makeRig();
    const stops: number[] = [];
    for (let i = 0; i < 6; i++) stops.push(brakeTest(rig, 130));
    const t = rig.vehicle.telemetry;
    expect(t.brakeTempC).toBeGreaterThan(sedan.brakes.fadeStartC);
    expect(t.brakeEfficiency).toBeLessThan(1);
    expect(stops[5]).toBeGreaterThanOrEqual((stops[0] ?? 0) * 1.15);

    rig.run(() => {
      holdSpeed(rig, 50);
      return false;
    }, 120);
    expect(t.speedKmh).toBeGreaterThan(45);
    expect(t.brakeTempC).toBeLessThan(sedan.brakes.fadeStartC);
    expect(t.brakeEfficiency).toBe(1);
  });

  it('burns fuel at 90 km/h within the range derived from the data', async () => {
    const rig = await makeRig();
    rig.run(() => {
      holdSpeed(rig, 90);
      return false;
    }, 15);
    const start = rig.vehicle.telemetry.fuelL;
    rig.run(() => {
      holdSpeed(rig, 90);
      return false;
    }, 600);
    const used = start - rig.vehicle.telemetry.fuelL;
    // Road load at 25 m/s: drag (derived from max power and top speed) plus asphalt rolling resistance.
    const v = 25;
    const kw = ((dragCoefficient(sedan) * v * v + surfaceRolling(0) * sedan.mass * 9.81) * v) / 1000;
    const expected = ((sedan.fuel.idleLph + sedan.fuel.litersPerKWh * kw) * 600) / 3600;
    expect(used).toBeGreaterThan(expected * 0.85);
    expect(used).toBeLessThan(expected * 1.2);
    expect(rig.vehicle.telemetry.fuelFraction).toBeCloseTo(rig.vehicle.telemetry.fuelL / sedan.fuel.capacityL, 10);
  });

  it('reverses when the brake is held at a standstill', async () => {
    const rig = await makeRig();
    const controls: DriverControls = { throttle: 0, brake: 0, steer: 0, handbrake: false, reverse: false };
    rig.run(() => {
      mapDriverInput({ accelerate: 0, brake: 1, steer: 0, handbrake: false }, rig.vehicle.telemetry.speed, rig.vehicle.reversing, controls);
      Object.assign(rig.controls, controls);
      return false;
    }, 3);
    expect(rig.vehicle.reversing).toBe(true);
    expect(rig.vehicle.telemetry.gear).toBe(-1);
    expect(rig.vehicle.telemetry.speed).toBeLessThan(-2);
    expect(rig.vehicle.telemetry.speedKmh).toBeGreaterThanOrEqual(-sedan.engine.reverseMaxSpeedKmh - 1);
    expect(rig.position().z).toBeGreaterThan(2);
    expect((VehicleLook.lights[1] ?? 0) & LIGHT.reverse).toBe(LIGHT.reverse);
  });
});

describe('DrivableVehicle damage, fuel and lights', () => {
  it('a 15 m/s frontal hit into a wall damages the front and the engine and emits vehicle:damaged', async () => {
    const rig = await makeRig();
    rig.physics.raw.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.5).setTranslation(0, 2, -60));
    const events: VehicleDamagedEvent[] = [];
    rig.bus.on('vehicle:damaged', (e) => events.push(e));
    let impact = 0;
    rig.run(() => {
      rig.controls.throttle = rig.vehicle.telemetry.speed < 15 ? 1 : 0;
      impact = Math.max(impact, rig.vehicle.telemetry.speed);
      return events.length > 0;
    }, 20);
    rig.controls.throttle = 0;
    rig.run(() => false, 1);
    expect(impact).toBeGreaterThan(14.5);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.zone).toBe('front');
    expect(events[0]?.eid).toBe(1);
    const t = rig.vehicle.telemetry;
    expect(t.damage[0]).toBeGreaterThan(0.3);
    expect(t.damage[1]).toBe(0);
    expect(t.engineHealth).toBeLessThan(1);
    expect(VehicleLook.damage[4]).toBe(t.damage[0]);

    rig.vehicle.repair();
    expect(rig.vehicle.serialize().zones).toEqual([0, 0, 0, 0]);
    expect(VehicleLook.damage[4]).toBe(0);
  });

  it('normal driving, cornering and hard braking register no impacts', async () => {
    const rig = await makeRig();
    let damaged = 0;
    rig.bus.on('vehicle:damaged', () => damaged++);
    turnWhile(rig, 80, { throttle: 0.5, steer: 1 }, 3);
    brakeTest(rig, 120);
    expect(damaged).toBe(0);
  });

  it('a flat front-left tyre pulls left under braking', async () => {
    const pull = async (flat: boolean): Promise<[number, number]> => {
      const rig = await makeRig();
      rig.controls.throttle = 1;
      rig.run(() => rig.vehicle.telemetry.speedKmh >= 60, 20);
      if (flat) withFlatTyre(rig, 0);
      const x0 = rig.position().x;
      const [yaw] = turnWhile(rig, 0, { brake: 0.3 }, 6);
      return [yaw, rig.position().x - x0];
    };
    const [yaw, dx] = await pull(true);
    const [healthyYaw, healthyDx] = await pull(false);
    expect(yaw).toBeGreaterThan(0.005);
    expect(dx).toBeLessThan(-0.05);
    expect(Math.abs(healthyYaw)).toBeLessThan(0.001);
    expect(Math.abs(healthyDx)).toBeLessThan(0.01);
  });

  it('a flat tyre has a smaller radius; the burst is reported in telemetry', async () => {
    const rig = await makeRig();
    withFlatTyre(rig, 0);
    rig.step();
    const pose: WheelPose = { x: 0, y: 0, z: 0, steer: 0, spin: 0, radius: 0, inContact: false };
    expect(rig.vehicle.wheelPose(0, pose).radius).toBeCloseTo(sedan.tires.radius * 0.85, 5);
    expect(rig.vehicle.wheelPose(1, pose).radius).toBeCloseTo(sedan.tires.radius, 5);
    expect(rig.vehicle.telemetry.tireFlat).toEqual([true, false, false, false]);
  });

  it('runs out of fuel once, then refuels', async () => {
    const rig = await makeRig();
    const data = rig.vehicle.serialize();
    data.fuelL = 0.0005;
    rig.vehicle.dispose();
    rig.vehicle = DrivableVehicle.restore(rig.physics, 1, data, vehicleRng());
    let empty = 0;
    rig.bus.on('vehicle:fuelEmpty', () => empty++);
    rig.controls.throttle = 1;
    rig.run(() => false, 3);
    expect(empty).toBe(1);
    expect(rig.vehicle.telemetry.engineRunning).toBe(false);
    expect(rig.vehicle.telemetry.fuelL).toBe(0);
    rig.vehicle.refuel(10);
    rig.step();
    expect(rig.vehicle.telemetry.engineRunning).toBe(true);
    expect(rig.vehicle.telemetry.fuelL).toBeGreaterThan(9.9);
  });

  it('writes light bits to VehicleLook every step', async () => {
    const rig = await makeRig();
    rig.vehicle.headlights = true;
    rig.vehicle.lightbar = true;
    rig.controls.brake = 1;
    rig.step();
    expect(VehicleLook.lights[1]).toBe(LIGHT.head | LIGHT.brake | LIGHT.lightbar);
    rig.vehicle.headlights = false;
    rig.controls.brake = 0;
    rig.step();
    expect(VehicleLook.lights[1]).toBe(LIGHT.lightbar);
    // Civilian models have no light bar to switch on.
    const civ = await makeRig('sedan', makeEnv(), 2);
    civ.vehicle.lightbar = true;
    civ.step();
    expect(VehicleLook.lights[2]).toBe(0);
  });
});

describe('DrivableVehicle determinism and lifecycle', () => {
  /** Scripted input: accelerate, weave, brake hard, handbrake turn. */
  function script(rig: Rig, step: number): void {
    const c = rig.controls;
    c.throttle = step < 240 ? 1 : step < 420 ? 0.4 : 0;
    c.steer = step < 120 ? 0 : Math.sin(step / 25);
    c.brake = step >= 420 && step < 520 ? 1 : 0;
    c.handbrake = step >= 480 && step < 540;
  }

  it('two identical scripted runs are bit-identical', async () => {
    const a = await makeRig();
    const b = await makeRig();
    for (let i = 0; i < 600; i++) {
      script(a, i);
      script(b, i);
      a.step();
      b.step();
    }
    expect(a.vehicle.serialize()).toEqual(b.vehicle.serialize());
    expect(a.vehicle.telemetry).toEqual(b.vehicle.telemetry);
  });

  it('serialize -> restore continues identically for 120 steps', async () => {
    const a = await makeRig();
    for (let i = 0; i < 300; i++) {
      script(a, i);
      a.step();
    }
    const saved = JSON.parse(JSON.stringify(a.vehicle.serialize())) as SerializedVehicle;
    const b = await makeRig(sedan, makeEnv(), 1, saved);
    expect(b.vehicle.serialize()).toEqual(saved);
    for (let i = 300; i < 420; i++) {
      script(a, i);
      script(b, i);
      a.step();
      b.step();
    }
    expect(b.vehicle.serialize()).toEqual(a.vehicle.serialize());
  });

  it('dispose removes the controller, body and collider', async () => {
    const physics = await PhysicsWorld.create();
    physics.addGround(50);
    const bodies = physics.bodyCount;
    const colliders = physics.raw.colliders.len();
    const v = DrivableVehicle.create(physics, 5, sedan, { x: 0, y: restHeight(sedan), z: 0, yaw: 0.5 }, vehicleRng());
    expect(physics.bodyCount).toBe(bodies + 1);
    expect(physics.getBody(5)).toBeDefined();
    v.dispose();
    v.dispose();
    expect(physics.bodyCount).toBe(bodies);
    expect(physics.raw.colliders.len()).toBe(colliders);
    expect(physics.raw.bodies.len()).toBe(0);
    physics.step();
    // Disposing after the world is gone is a no-op.
    const late = DrivableVehicle.create(physics, 6, sedan, { x: 0, y: 1, z: 0, yaw: 0 }, vehicleRng());
    physics.dispose();
    expect(() => {
      late.dispose();
    }).not.toThrow();
  });

  it('pre+post step stays within the 0.1 ms per-step budget', async () => {
    const rig = await makeRig();
    rig.controls.throttle = 1;
    rig.controls.steer = 0.3;
    rig.run(() => false, 5); // JIT warm-up
    let spent = 0;
    const steps = 1200;
    for (let i = 0; i < steps; i++) {
      rig.vehicle.setControls(rig.controls);
      const t0 = performance.now();
      rig.vehicle.preStep(DT, rig.env);
      spent += performance.now() - t0;
      rig.physics.step();
      const t1 = performance.now();
      rig.vehicle.postStep(DT);
      spent += performance.now() - t1;
    }
    expect(spent / steps).toBeLessThan(0.1);
  });
});
