import { afterEach, describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../../src/physics/physics';
import { createRng } from '../../src/core/rng';
import { VehicleLook } from '../../src/vehicles/components';
import { DrivableVehicle, type VehicleCondition, type WheelPose } from '../../src/vehicles/drivableVehicle';
import { DEFAULT_WEAR, restHeight, vehicleModel } from '../../src/vehicles/model';
import { DT, brakeTest, disposeRigs, holdSpeed, makeEnv, makeRig } from './harness';

afterEach(() => {
  disposeRigs();
});

const sedan = vehicleModel('patrol_sedan');
const wear = sedan.wear;

describe('wear on a driven vehicle', () => {
  it('a new vehicle has full oil, new tyres and a zero odometer', async () => {
    const rig = await makeRig();
    expect(wear).toEqual(DEFAULT_WEAR);
    const c = rig.vehicle.condition();
    expect(c).toEqual({
      modelId: 'patrol_sedan',
      fuelFraction: expect.closeTo(1, 4) as number,
      fuelL: expect.closeTo(70, 2) as number,
      oilFraction: 1,
      tread: [1, 1, 1, 1],
      flats: [false, false, false, false],
      zones: [0, 0, 0, 0],
      engineHealth: 1,
      engineFailed: false,
      odometerKm: expect.closeTo(0, 2) as number,
    });
    expect(rig.vehicle.telemetry).toMatchObject({ oilFraction: 1, treadMin: 1, altitudeM: 0, lean: 0 });
  });

  it('driving 2 km wears each tyre by about 2 x treadPerKm and reads 2 km on the odometer', async () => {
    const rig = await makeRig();
    let n = 0;
    rig.run(() => {
      holdSpeed(rig, 72);
      n++;
      return rig.vehicle.telemetry.odometerKm >= 2;
    }, 200);
    const t = rig.vehicle.telemetry;
    expect(t.odometerKm).toBeGreaterThanOrEqual(2);
    expect(t.odometerKm).toBeLessThan(2.05);
    expect(rig.odometer() / 1000).toBeCloseTo(t.odometerKm, 1);
    const c = rig.vehicle.condition();
    for (const tread of c.tread) expect(tread).toBeCloseTo(1 - t.odometerKm * wear.treadPerKm, 5);
    expect(t.treadMin).toBeCloseTo(1 - t.odometerKm * wear.treadPerKm, 5);
    expect(n).toBeGreaterThan(1000);
  });

  it('oil drains with engine work', async () => {
    const rig = await makeRig();
    rig.controls.throttle = 1;
    rig.run(() => false, 20);
    const oil = rig.vehicle.telemetry.oilFraction;
    expect(oil).toBeLessThan(1);
    expect(oil).toBeGreaterThan(0.99);
    // 20 s at <= 230 kW: at most 1.3 kWh x 0.004 L/kWh of the 6 L.
    expect(1 - oil).toBeLessThan((230 * 20) / 3600 * wear.oilPerKWh / wear.oilL + 1e-9);
  });

  it('a locked or handbrake-sliding wheel wears faster than a rolling one', async () => {
    const rig = await makeRig();
    rig.controls.throttle = 1;
    rig.run(() => rig.vehicle.telemetry.speed >= 25, 20);
    rig.controls.throttle = 0;
    rig.controls.handbrake = true;
    rig.run(() => rig.vehicle.telemetry.speed < 4, 10);
    const c = rig.vehicle.condition();
    expect(c.tread[2]).toBeLessThan(c.tread[0]);
    expect(c.tread[3]).toBeLessThan(c.tread[1]);
    expect(c.tread[0]).toBeCloseTo(c.tread[1], 6);
  });

  it('worn tyres stop later, and worse in the wet', async () => {
    const dry = makeEnv();
    const wet = makeEnv(0, 1);
    const stop = async (tread: number, env = dry): Promise<number> => {
      const base = await makeRig('patrol_sedan', env);
      const data = base.vehicle.serialize();
      if (data.wear) data.wear.tread = [tread, tread, tread, tread];
      const rig = await makeRig('patrol_sedan', env, 1, data);
      return brakeTest(rig, 100);
    };
    const fresh = await stop(1);
    const bald = await stop(0);
    const baldWet = await stop(0, wet);
    const freshWet = await stop(1, wet);
    expect(bald).toBeGreaterThan(fresh * 1.1);
    expect(baldWet).toBeGreaterThan(bald);
    expect(baldWet).toBeGreaterThan(freshWet * 1.1);
  });

  it('an engine running on empty oil loses health and fails once', async () => {
    const base = await makeRig();
    const data = base.vehicle.serialize();
    if (data.wear) data.wear.oilL = 0;
    data.engineHealth = 0.056;
    const rig = await makeRig('patrol_sedan', makeEnv(), 1, data);
    const failed: string[] = [];
    rig.bus.on('vehicle:engineFailed', () => failed.push('failed'));
    rig.controls.throttle = 0.5;
    expect(rig.vehicle.telemetry.oilFraction).toBe(0);
    rig.run(() => false, 0.5);
    const health = rig.vehicle.telemetry.engineHealth;
    expect(health).toBeLessThan(0.056);
    expect(health).toBeCloseTo(0.056 - 0.5 * wear.oilWearPerS, 3);
    expect(failed).toEqual([]);
    rig.run(() => false, 4);
    expect(failed).toEqual(['failed']);
    expect(rig.vehicle.telemetry.engineRunning).toBe(false);
    expect(rig.vehicle.condition().engineFailed).toBe(true);
    // With oil, the engine does not wear at all.
    const healthy = await makeRig();
    healthy.controls.throttle = 1;
    healthy.run(() => false, 5);
    expect(healthy.vehicle.telemetry.engineHealth).toBe(1);
  });
});

describe('maintenance', () => {
  async function wornRig() {
    const rig = await makeRig();
    const data = rig.vehicle.serialize();
    data.wear = { oilL: 1.5, tread: [0.2, 0.4, 0.6, 0.8], odometerM: 12345 };
    data.zones = [0.5, 0.25, 0, 0.75];
    data.engineHealth = 0.5;
    data.tireFlat = [false, true, false, true];
    data.fuelL = 35;
    rig.vehicle.dispose();
    return makeRig('patrol_sedan', makeEnv(), 1, data);
  }

  it('condition reflects the saved state and round-trips through serialize / restore', async () => {
    const rig = await wornRig();
    const c = rig.vehicle.condition();
    expect(c).toMatchObject({
      modelId: 'patrol_sedan',
      fuelFraction: 0.5,
      fuelL: 35,
      oilFraction: 0.25,
      flats: [false, true, false, true],
      zones: [0.5, 0.25, 0, 0.75],
      engineHealth: 0.5,
      engineFailed: false,
      odometerKm: 12.345,
    });
    expect(c.tread[0]).toBeCloseTo(0.2, 6);
    expect(c.tread[3]).toBeCloseTo(0.8, 6);
    const data = JSON.parse(JSON.stringify(rig.vehicle.serialize())) as ReturnType<DrivableVehicle['serialize']>;
    const again = await makeRig('patrol_sedan', makeEnv(), 1, data);
    expect(again.vehicle.condition()).toEqual(c);
    expect(again.vehicle.telemetry.treadMin).toBeCloseTo(0.2, 6);
  });

  it('condition(out) fills the given object in place', async () => {
    const rig = await wornRig();
    const out: VehicleCondition = rig.vehicle.condition();
    const tread = out.tread;
    const flats = out.flats;
    const zones = out.zones;
    out.modelId = 'x';
    out.oilFraction = 9;
    const back = rig.vehicle.condition(out);
    expect(back).toBe(out);
    expect(out.tread).toBe(tread);
    expect(out.flats).toBe(flats);
    expect(out.zones).toBe(zones);
    expect(out.modelId).toBe('patrol_sedan');
    expect(out.oilFraction).toBe(0.25);
  });

  it('changeOil refills the oil and nothing else', async () => {
    const rig = await wornRig();
    rig.vehicle.changeOil();
    const c = rig.vehicle.condition();
    expect(c.oilFraction).toBe(1);
    expect(rig.vehicle.telemetry.oilFraction).toBe(1);
    expect(c.engineHealth).toBe(0.5);
    expect(c.flats).toEqual([false, true, false, true]);
  });

  it('replaceTires renews all four, or just the given wheels, clearing the flats and restoring the radius', async () => {
    const rig = await wornRig();
    const pose: WheelPose = { x: 0, y: 0, z: 0, steer: 0, spin: 0, radius: 0, inContact: false };
    expect(rig.vehicle.wheelPose(1, pose).radius).toBeLessThan(sedan.tires.radius);
    rig.vehicle.replaceTires([1, 9, -1]);
    let c = rig.vehicle.condition();
    expect(c.tread[1]).toBe(1);
    expect(c.tread[0]).toBeCloseTo(0.2, 6);
    expect(c.flats).toEqual([false, false, false, true]);
    expect(rig.vehicle.wheelPose(1, pose).radius).toBeCloseTo(sedan.tires.radius, 6);
    expect(rig.vehicle.wheelPose(3, pose).radius).toBeLessThan(sedan.tires.radius);
    expect(rig.vehicle.telemetry.tireFlat).toEqual([false, false, false, true]);
    rig.vehicle.replaceTires();
    c = rig.vehicle.condition();
    expect(c.tread).toEqual([1, 1, 1, 1]);
    expect(c.flats).toEqual([false, false, false, false]);
    expect(rig.vehicle.wheelPose(3, pose).radius).toBeCloseTo(sedan.tires.radius, 6);
    expect(rig.vehicle.telemetry.treadMin).toBe(1);
    expect(c.zones).toEqual([0.5, 0.25, 0, 0.75]);
  });

  it('repairBody repairs the hull and engine but keeps the tyres, oil and fuel; repair keeps oil and tread', async () => {
    const rig = await wornRig();
    rig.vehicle.repairBody();
    let c = rig.vehicle.condition();
    expect(c.zones).toEqual([0, 0, 0, 0]);
    expect(c.engineHealth).toBe(1);
    expect(c.engineFailed).toBe(false);
    expect(c.flats).toEqual([false, true, false, true]);
    expect(c.oilFraction).toBe(0.25);
    expect(c.fuelL).toBe(35);
    expect(VehicleLook.damage[4]).toBe(0);
    const worn = await wornRig();
    worn.vehicle.repair();
    c = worn.vehicle.condition();
    expect(c.zones).toEqual([0, 0, 0, 0]);
    expect(c.flats).toEqual([false, false, false, false]);
    expect(c.engineHealth).toBe(1);
    expect(c.oilFraction).toBe(0.25);
    expect(c.tread[0]).toBeCloseTo(0.2, 6);
    expect(c.odometerKm).toBeCloseTo(12.345, 6);
  });

  it('a Phase 1-6 save without wear restores with full oil, new tyres and a zero odometer', async () => {
    const rig = await makeRig();
    const data = rig.vehicle.serialize();
    delete data.wear;
    delete data.pushBar;
    delete data.craft;
    const old = await makeRig('patrol_sedan', makeEnv(), 1, data);
    const c = old.vehicle.condition();
    expect(c.oilFraction).toBe(1);
    expect(c.tread).toEqual([1, 1, 1, 1]);
    expect(c.odometerKm).toBe(0);
    expect(old.vehicle.pushBar).toBe(true);
    expect(old.vehicle.serialize().wear).toEqual({ oilL: 6, tread: [1, 1, 1, 1], odometerM: 0 });
    expect(old.vehicle.serialize().craft).toBeUndefined();
  });

  it('always writes wear and the push bar; crafts also write their state', async () => {
    const car = (await makeRig()).vehicle.serialize();
    expect(car.wear).toEqual({ oilL: 6, tread: [1, 1, 1, 1], odometerM: expect.closeTo(0, 0) as number });
    expect(car.pushBar).toBe(true);
    expect('craft' in car).toBe(false);
    const boat = (await makeRig('patrol_boat')).vehicle.serialize();
    expect(boat.craft).toEqual({ speed: 0, vy: 0, yaw: 0, pitch: 0, roll: 0 });
  });
});

describe('crafts: wheels, tyres and cleanup', () => {
  it('draw no wheels: static hubs out of contact, and tyres cannot burst', async () => {
    const rig = await makeRig('police_helicopter');
    const pose: WheelPose = { x: 9, y: 9, z: 9, steer: 9, spin: 9, radius: 9, inContact: true };
    for (let i = 0; i < 4; i++) {
      rig.vehicle.wheelPose(i, pose);
      expect(pose.inContact).toBe(false);
      expect(pose.spin).toBe(0);
      expect(pose.steer).toBe(0);
      expect(Math.abs(pose.x)).toBeLessThan(vehicleModel('police_helicopter').body.width / 2);
    }
    expect(rig.vehicle.burstTire(0, rig.bus)).toBe(false);
    expect(rig.vehicle.condition().flats).toEqual([false, false, false, false]);
    rig.vehicle.replaceTires();
  });

  it('dispose removes the body and the character controller, and is safe twice or after the world is gone', async () => {
    const physics = await PhysicsWorld.create();
    physics.addGround(100);
    const model = vehicleModel('police_drone');
    const rng = createRng(7).stream('vehicle:0');
    const v = DrivableVehicle.create(physics, 5, model, { x: 0, y: restHeight(model), z: 0, yaw: 0 }, rng);
    expect(physics.has(5)).toBe(true);
    v.setControls({ throttle: 1, brake: 0, steer: 0, handbrake: false, reverse: false });
    v.preStep(DT, makeEnv());
    physics.step();
    v.postStep(DT);
    v.dispose();
    expect(physics.has(5)).toBe(false);
    v.dispose();
    const w = DrivableVehicle.create(physics, 6, model, { x: 3, y: restHeight(model), z: 0, yaw: 0 }, rng);
    physics.dispose();
    w.dispose();
  });

  it('crafts report their control kind, push bar false and no brake heat or ABS', async () => {
    for (const id of ['patrol_boat', 'police_helicopter', 'police_drone']) {
      const rig = await makeRig(id);
      expect(rig.vehicle.control).toBe(vehicleModel(id).control);
      expect(rig.vehicle.pushBar).toBe(false);
      rig.controls.throttle = 1;
      rig.run(() => false, 2);
      expect(rig.vehicle.telemetry.absActive).toBe(false);
      expect(rig.vehicle.telemetry.gear).toBe(1);
    }
  });
});
