import RAPIER from '@dimforge/rapier3d-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { VehicleLook } from '../../src/vehicles/components';
import type { SerializedVehicle } from '../../src/vehicles/drivableVehicle';
import type { VehicleDamagedEvent } from '../../src/vehicles/events';
import { VEHICLE_MODELS, isCraft, restHeight, vehicleModel } from '../../src/vehicles/model';
import { DT, disposeRigs, holdSpeed, makeEnv, makeRig, type Rig } from './harness';

afterEach(() => {
  disposeRigs();
});

const wheeled = VEHICLE_MODELS.filter((m) => m.role === 'police' && m.listOrder === 2 && !isCraft(m));

/** Body roll (rad, + = right side up) of the rig's chassis. */
function roll(rig: Rig): number {
  const q = rig.physics.getBody(rig.vehicle.eid)?.rotation() ?? { x: 0, y: 0, z: 0, w: 1 };
  return Math.asin(Math.max(-1, Math.min(1, 2 * (q.x * q.y + q.w * q.z))));
}

describe('fleet cars and bikes', () => {
  for (const model of wheeled) {
    it(`${model.id} reaches 8 m/s within 20 s on flat asphalt and stops with the brake`, async () => {
      const rig = await makeRig(model);
      expect(rig.vehicle.control).toBe(model.control);
      rig.controls.throttle = 1;
      const t = rig.run(() => rig.vehicle.telemetry.speed >= 8, 20);
      expect(t, 'time to 8 m/s').toBeLessThan(20);
      expect(Math.abs(rig.position().x)).toBeLessThan(2);
      rig.controls.throttle = 0;
      rig.controls.brake = 1;
      const stop = rig.run(() => rig.vehicle.telemetry.speed < 0.05, 20);
      expect(stop, 'time to stop').toBeLessThan(20);
      expect(rig.vehicle.telemetry.airborne).toBe(false);
      expect(rig.vehicle.condition().zones).toEqual([0, 0, 0, 0]);
    });
  }
});

describe('motorcycle and bicycle', () => {
  it('the motorcycle stays upright through a 30 s slalom at 12 m/s and leans with the steering', async () => {
    const rig = await makeRig('police_motorcycle');
    let worstRoll = 0;
    let agree = 0;
    let disagree = 0;
    let leanMax = 0;
    const steps = Math.round(30 / DT);
    for (let n = 0; n < steps; n++) {
      holdSpeed(rig, 12 * 3.6);
      const t = n * DT;
      rig.controls.steer = 0.1 * Math.sin((2 * Math.PI * t) / 4);
      rig.step();
      worstRoll = Math.max(worstRoll, Math.abs(roll(rig)));
      const tel = rig.vehicle.telemetry;
      if (t > 4 && Math.abs(rig.controls.steer) > 0.08 && Math.abs(tel.steer) > 0.05) {
        if (Math.sign(tel.lean) === Math.sign(tel.steer)) agree++;
        else disagree++;
        leanMax = Math.max(leanMax, Math.abs(tel.lean));
      }
    }
    expect(worstRoll).toBeLessThan(0.17);
    expect(rig.vehicle.telemetry.groundSpeed).toBeGreaterThan(8);
    expect(agree).toBeGreaterThan(100);
    expect(disagree).toBe(0);
    expect(leanMax).toBeGreaterThan(0.1);
    expect(leanMax).toBeLessThanOrEqual((vehicleModel('police_motorcycle').bike?.maxLeanDeg ?? 0) * (Math.PI / 180) + 1e-9);
    // The renderer reads the lean from VehicleLook.
    expect(VehicleLook.lean[rig.vehicle.eid]).toBeCloseTo(rig.vehicle.telemetry.lean, 5);
  });

  it('leans right when steering right and left when steering left', async () => {
    for (const [steer, sign] of [[0.1, 1], [-0.1, -1]] as const) {
      const rig = await makeRig('police_motorcycle');
      rig.controls.throttle = 1;
      rig.run(() => rig.vehicle.telemetry.speed >= 12, 15);
      rig.controls.throttle = 0.2;
      rig.controls.steer = steer;
      rig.run(() => false, 1.5);
      expect(Math.sign(rig.vehicle.telemetry.lean)).toBe(sign);
      expect(Math.abs(roll(rig))).toBeLessThan(0.17);
    }
    const car = await makeRig('patrol_sedan');
    car.controls.throttle = 1;
    car.controls.steer = 0.3;
    car.run(() => false, 2);
    expect(car.vehicle.telemetry.lean).toBe(0);
    expect(VehicleLook.lean[car.vehicle.eid]).toBe(0);
  });

  it('rights a motorcycle that is tipped over at rest', async () => {
    const rig = await makeRig('police_motorcycle');
    const body = rig.physics.getBody(rig.vehicle.eid);
    const a = 0.5 / 2;
    // Roll about the forward axis (-Z): right side up by 0.5 rad (past the 24 degree static tipping angle of the narrow track).
    body?.setRotation({ x: 0, y: 0, z: Math.sin(a), w: Math.cos(a) }, true);
    rig.step();
    expect(Math.abs(roll(rig))).toBeGreaterThan(0.3);
    rig.run(() => false, 3);
    expect(Math.abs(roll(rig))).toBeLessThan(0.05);
  });

  it('the bicycle burns no fuel, never stalls and keeps its engine on', async () => {
    const rig = await makeRig('police_bicycle');
    const events: string[] = [];
    rig.bus.on('vehicle:fuelEmpty', () => events.push('fuelEmpty'));
    rig.bus.on('vehicle:engineStalled', () => events.push('stalled'));
    const fuel0 = rig.vehicle.telemetry.fuelL;
    rig.controls.throttle = 1;
    rig.run(() => false, 30);
    expect(rig.vehicle.telemetry.speed).toBeGreaterThan(6);
    expect(rig.vehicle.telemetry.fuelL).toBe(fuel0);
    expect(rig.vehicle.telemetry.engineRunning).toBe(true);
    expect(events).toEqual([]);
    // The motorcycle does burn fuel.
    const moto = await makeRig('police_motorcycle');
    moto.controls.throttle = 1;
    moto.run(() => false, 5);
    expect(moto.vehicle.telemetry.fuelL).toBeLessThan(moto.vehicle.model.fuel.capacityL);
  });
});

describe('patrol boat', () => {
  it('stops near the shore where isWater ends and can back away', async () => {
    const env = { ...makeEnv(), isWater: (x: number) => x < 50 };
    const rig = await makeRig('patrol_boat', env, 1, undefined, { yaw: -Math.PI / 2 });
    rig.controls.throttle = 1;
    rig.run(() => false, 12);
    const p = rig.position();
    expect(p.x).toBeGreaterThan(40);
    expect(p.x).toBeLessThan(50.01);
    rig.run(() => rig.vehicle.telemetry.speed === 0 && rig.position().x > 49, 15);
    expect(rig.position().x).toBeGreaterThan(49);
    expect(rig.position().x).toBeLessThan(50.01);
    expect(rig.vehicle.telemetry.speed).toBe(0);
    expect(rig.vehicle.telemetry.airborne).toBe(false);
    expect(rig.vehicle.telemetry.altitudeM).toBe(0);
    // Back out into the water.
    rig.controls.throttle = 1;
    rig.controls.reverse = true;
    rig.run(() => false, 3);
    expect(rig.position().x).toBeLessThan(49);
  });

  it('floats at the water level and stops against a quay wall with front damage', async () => {
    const env = { ...makeEnv(), waterY: 0.3 };
    const rig = await makeRig('patrol_boat', env);
    rig.physics.raw.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.5).setTranslation(0, 2, -60));
    rig.physics.step();
    const events: VehicleDamagedEvent[] = [];
    rig.bus.on('vehicle:damaged', (e) => events.push(e));
    rig.controls.throttle = 1;
    rig.run(() => events.length > 0, 20);
    rig.controls.throttle = 0;
    rig.run(() => false, 1);
    const body = rig.physics.getBody(1)?.translation();
    expect(body?.y).toBeCloseTo(0.3 + restHeight(vehicleModel('patrol_boat')), 3);
    expect(events).toHaveLength(1);
    expect(events[0]?.zone).toBe('front');
    expect(events[0]?.impactSpeed).toBeGreaterThan(10);
    expect(rig.position().z).toBeGreaterThan(-60);
    expect(rig.position().z).toBeLessThan(-50);
    expect(rig.vehicle.telemetry.speed).toBe(0);
    expect(rig.vehicle.telemetry.damage[0]).toBeGreaterThan(0);
  });
});

describe('patrol helicopter', () => {
  it('climbs to 50 m, hovers, and lands gently without damage', async () => {
    const rig = await makeRig('police_helicopter');
    const events: VehicleDamagedEvent[] = [];
    rig.bus.on('vehicle:damaged', (e) => events.push(e));
    expect(rig.vehicle.telemetry.altitudeM).toBeLessThan(0.1);
    expect(VehicleLook.rotor[1]).toBe(1);
    rig.controls.lift = 1;
    const up = rig.run(() => rig.vehicle.telemetry.altitudeM >= 50, 20);
    expect(up).toBeGreaterThan(5);
    expect(up).toBeLessThan(10);
    expect(rig.vehicle.telemetry.airborne).toBe(true);
    rig.controls.lift = 0;
    rig.run(() => false, 3);
    const hover = rig.vehicle.telemetry.altitudeM;
    expect(hover).toBeGreaterThan(50);
    rig.controls.lift = -0.3;
    const down = rig.run(() => rig.vehicle.telemetry.altitudeM < 0.05, 40);
    expect(down).toBeLessThan(40);
    rig.controls.lift = 0;
    rig.run(() => false, 1);
    expect(rig.vehicle.telemetry.airborne).toBe(false);
    expect(rig.vehicle.telemetry.altitudeM).toBeLessThan(0.05);
    expect(events).toEqual([]);
    expect(rig.vehicle.condition().zones).toEqual([0, 0, 0, 0]);
  });

  it('flies forward, banks on turns and burns fuel faster in the air than on the ground', async () => {
    const rig = await makeRig('police_helicopter');
    const idle = rig.vehicle.telemetry.fuelL;
    rig.run(() => false, 10);
    const groundBurn = idle - rig.vehicle.telemetry.fuelL;
    rig.controls.lift = 1;
    rig.run(() => rig.vehicle.telemetry.altitudeM > 20, 10);
    rig.controls.lift = 0;
    rig.controls.throttle = 1;
    const before = rig.vehicle.telemetry.fuelL;
    rig.run(() => false, 10);
    expect(before - rig.vehicle.telemetry.fuelL).toBeGreaterThan(groundBurn);
    expect(rig.vehicle.telemetry.speed).toBeGreaterThan(15);
    expect(rig.position().z).toBeLessThan(-100);
    expect(rig.vehicle.telemetry.rpm).toBeGreaterThan(rig.vehicle.model.engine.idleRpm);
    rig.controls.steer = 1;
    rig.run(() => false, 1);
    const q = rig.physics.getBody(1)?.rotation();
    expect(Math.abs(q?.x ?? 0)).toBeGreaterThan(0.01);
  });

  it('falls at about 6 m/s when the engine dies in the air and is damaged on the front when it lands', async () => {
    const rig = await makeRig('police_helicopter');
    const events: VehicleDamagedEvent[] = [];
    rig.bus.on('vehicle:damaged', (e) => events.push(e));
    rig.controls.lift = 1;
    rig.run(() => rig.vehicle.telemetry.altitudeM >= 30, 10);
    rig.controls.lift = 0;
    rig.vehicle.engineOn = false;
    expect(VehicleLook.rotor[1]).toBe(1);
    rig.run(() => false, 0.1);
    expect(VehicleLook.rotor[1]).toBe(0);
    rig.run(() => rig.vehicle.telemetry.altitudeM < 0.05, 15);
    rig.run(() => false, 0.2);
    expect(events).toHaveLength(1);
    expect(events[0]?.zone).toBe('front');
    expect(events[0]?.impactSpeed).toBeGreaterThan(5.5);
    expect(events[0]?.impactSpeed).toBeLessThan(6.1);
    expect(rig.vehicle.telemetry.damage[0]).toBeGreaterThan(0.1);
  });
});

describe('camera drone', () => {
  it('stays within rangeM of its anchor however long it flies away', async () => {
    const env = { ...makeEnv(), anchorX: 0, anchorZ: 0 };
    const rig = await makeRig('police_drone', env);
    const range = rig.vehicle.model.craft?.rangeM ?? 0;
    expect(range).toBe(350);
    rig.controls.lift = 1;
    rig.run(() => rig.vehicle.telemetry.altitudeM > 15, 10);
    rig.controls.lift = 0;
    let worst = 0;
    const watch = (): boolean => {
      const p = rig.position();
      worst = Math.max(worst, Math.hypot(p.x, p.z));
      return false;
    };
    rig.controls.throttle = 1;
    rig.run(watch, 70);
    rig.controls.steer = 0.3;
    rig.run(watch, 40);
    expect(worst).toBeGreaterThan(range - 20);
    expect(worst).toBeLessThanOrEqual(range + 0.01);
  });

  it('flies unleashed when the environment gives no anchor', async () => {
    const rig = await makeRig('police_drone');
    rig.controls.lift = 1;
    rig.run(() => rig.vehicle.telemetry.altitudeM > 10, 10);
    rig.controls.lift = 0;
    rig.controls.throttle = 1;
    rig.run(() => false, 60);
    expect(rig.odometer()).toBeGreaterThan(400);
  });

  it('burns the battery at its idle rate, and falls when the battery is empty', async () => {
    const rig = await makeRig('police_drone');
    rig.controls.lift = 1;
    rig.run(() => rig.vehicle.telemetry.altitudeM > 20, 10);
    rig.controls.lift = 0;
    const f0 = rig.vehicle.telemetry.fuelL;
    rig.run(() => false, 30);
    expect(f0 - rig.vehicle.telemetry.fuelL).toBeCloseTo((3 / 3600) * 30, 3);

    // The same drone with almost no charge left, hovering at 20 m.
    const data = rig.vehicle.serialize();
    data.fuelL = 0.0003;
    rig.vehicle.dispose();
    const low = await makeRig('police_drone', makeEnv(), 1, data);
    const empty: string[] = [];
    const damaged: VehicleDamagedEvent[] = [];
    low.bus.on('vehicle:fuelEmpty', () => empty.push('empty'));
    low.bus.on('vehicle:damaged', (e) => damaged.push(e));
    low.controls.lift = 1;
    expect(low.vehicle.telemetry.engineRunning).toBe(true);
    low.run(() => !low.vehicle.telemetry.engineRunning, 5);
    expect(empty).toEqual(['empty']);
    expect(VehicleLook.rotor[1]).toBe(0);
    const altitude = low.vehicle.telemetry.altitudeM;
    low.run(() => low.vehicle.telemetry.altitudeM < 0.05, 15);
    expect(low.vehicle.telemetry.altitudeM).toBeLessThan(altitude);
    low.run(() => false, 0.5);
    expect(empty).toHaveLength(1);
    expect(damaged).toHaveLength(1);
    expect(damaged[0]?.impactSpeed).toBeGreaterThan(5.5);
    // The fall wrecked the motor; repaired and recharged, it flies again.
    expect(low.vehicle.condition().engineFailed).toBe(true);
    low.vehicle.repairBody();
    low.vehicle.refuel();
    low.controls.lift = 1;
    low.run(() => false, 1);
    expect(low.vehicle.telemetry.altitudeM).toBeGreaterThan(1);
  });
});

describe('craft persistence', () => {
  function script(rig: Rig, n: number, id: string): void {
    const t = n * DT;
    const c = rig.controls;
    if (id === 'patrol_boat') {
      c.throttle = n < 200 ? 1 : 0.4;
      c.steer = Math.sin(t * 0.8);
    } else {
      c.lift = n < 120 ? 1 : n < 200 ? 0 : -0.2;
      c.throttle = n > 60 ? 0.7 : 0;
      c.steer = Math.sin(t * 1.3) * 0.8;
    }
  }

  for (const id of ['patrol_boat', 'police_helicopter', 'police_drone']) {
    it(`${id} serializes and restores bit-identically mid-run`, async () => {
      const model = vehicleModel(id);
      const env = { ...makeEnv(), isWater: () => true, anchorX: 0, anchorZ: 0 };
      const a = await makeRig(model, env);
      let snapshot: SerializedVehicle | null = null;
      for (let n = 0; n < 300; n++) {
        if (n === 150) snapshot = JSON.parse(JSON.stringify(a.vehicle.serialize())) as SerializedVehicle;
        script(a, n, id);
        a.step();
      }
      expect(snapshot).not.toBeNull();
      expect(snapshot?.craft).toBeDefined();
      expect(snapshot?.pushBar).toBe(false);
      const b = await makeRig(model, env, 1, snapshot ?? undefined);
      for (let n = 150; n < 300; n++) {
        script(b, n, id);
        b.step();
      }
      const sa = a.vehicle.serialize();
      const sb = b.vehicle.serialize();
      expect(sb).toEqual(sa);
      expect(sb.craft?.speed).not.toBe(0);
      expect(b.vehicle.telemetry).toEqual(a.vehicle.telemetry);
      expect(b.vehicle.condition()).toEqual(a.vehicle.condition());
    });
  }

  it('an old craft save without the craft block restores at rest with the yaw of the quaternion', async () => {
    const rig = await makeRig('police_drone', makeEnv(), 1, undefined, { yaw: 1 });
    const data = rig.vehicle.serialize();
    delete data.craft;
    delete data.wear;
    delete data.pushBar;
    const again = await makeRig('police_drone', makeEnv(), 1, data);
    expect(again.vehicle.telemetry.speed).toBe(0);
    expect(again.vehicle.condition().oilFraction).toBe(1);
    again.controls.throttle = 1;
    again.run(() => false, 1);
    // Facing yaw 1: forward is (-sin 1, -cos 1).
    const p = again.position();
    expect(p.x).toBeLessThan(0);
    expect(p.z).toBeLessThan(0);
  });
});

describe('push bar', () => {
  async function frontHit(pushBar: boolean): Promise<VehicleDamagedEvent> {
    const rig = await makeRig('patrol_sedan', makeEnv(), 1, undefined, { build: { pushBar } });
    expect(rig.vehicle.pushBar).toBe(pushBar);
    rig.physics.raw.createCollider(RAPIER.ColliderDesc.cuboid(10, 2, 0.5).setTranslation(0, 2, -40));
    rig.physics.step();
    const events: VehicleDamagedEvent[] = [];
    rig.bus.on('vehicle:damaged', (e) => events.push(e));
    rig.run(() => {
      rig.controls.throttle = rig.vehicle.telemetry.speed < 10 ? 1 : 0;
      return events.length > 0;
    }, 20);
    const first = events[0];
    if (!first) throw new Error('no impact');
    return first;
  }

  it('without it front hits use the base zone strength', async () => {
    const withBar = await frontHit(true);
    const bare = await frontHit(false);
    const m = vehicleModel('patrol_sedan');
    expect(withBar.zone).toBe('front');
    expect(bare.zone).toBe('front');
    // Same approach, same rng draw: the damage differs by exactly the bumper's strength.
    expect(withBar.impactSpeed).toBeCloseTo(bare.impactSpeed, 6);
    expect(bare.amount / withBar.amount).toBeCloseTo((m.damage.frontZoneStrength ?? 0) / m.damage.zoneStrength, 6);
    expect(bare.amount).toBeGreaterThan(withBar.amount);
  });

  it('is restored from the saved flag and defaults to the model equipment', async () => {
    const rig = await makeRig('patrol_sedan', makeEnv(), 1, undefined, { build: { pushBar: false } });
    const data = rig.vehicle.serialize();
    expect(data.pushBar).toBe(false);
    const restored = await makeRig('patrol_sedan', makeEnv(), 1, data);
    expect(restored.vehicle.pushBar).toBe(false);
    const forced = await makeRig('patrol_sedan', makeEnv(), 1, data, { build: { pushBar: true } });
    expect(forced.vehicle.pushBar).toBe(true);
    delete data.pushBar;
    expect((await makeRig('patrol_sedan', makeEnv(), 1, data)).vehicle.pushBar).toBe(true);
    // A model without a push bumper never reports one.
    expect((await makeRig('unmarked_sedan', makeEnv(), 1, undefined, { build: { pushBar: true } })).vehicle.pushBar).toBe(false);
    expect((await makeRig('patrol_sedan')).vehicle.pushBar).toBe(true);
  });
});
