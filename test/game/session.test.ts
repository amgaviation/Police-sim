import RAPIER from '@dimforge/rapier3d-compat';
import { hasComponent } from 'bitecs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { EntityKind, KIND, Player, Transform } from '../../src/ecs/components';
import { entityCount } from '../../src/ecs/world';
import { GameSession, PLAYER_SIZE, headingOf, serializeGame } from '../../src/game/session';
import { initRapier } from '../../src/physics/physics';
import { CAMERA_MODE } from '../../src/player/cameraRig';
import { PLAYER_MODE, driverDoorPoint, exitPoint, type EnterCandidate } from '../../src/player/mode';
import { migrateEnvelope } from '../../src/save/migrations';
import { isSaveGame, type SaveGame } from '../../src/save/schema';
import { Drivable, LIGHT, VehicleLook } from '../../src/vehicles/components';
import type { DamageState } from '../../src/vehicles/damage';
import type { DrivableVehicle } from '../../src/vehicles/drivableVehicle';
import { vehicleModel } from '../../src/vehicles/model';
import type { City } from '../../src/world/city';
import { LANDMARKS } from '../../src/world/data';
import { generateCity } from '../../src/world/generate';
import { laneRef } from '../../src/world/roadGraph';
import { stationLayout } from '../../src/world/stationLayout';
import { MAX_PARKED_OBSTACLES, isFleetVehicleId, type TrafficFocus } from '../../src/traffic/trafficSystem';
import { Harness, roundTrip } from './harness';

const SEED = 42;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

function candidate(vehicle: DrivableVehicle): EnterCandidate {
  const eid = vehicle.eid;
  return {
    eid,
    x: Transform.x[eid] ?? 0,
    z: Transform.z[eid] ?? 0,
    yaw: headingOf(Transform.qx[eid] ?? 0, Transform.qy[eid] ?? 0, Transform.qz[eid] ?? 0, Transform.qw[eid] ?? 1),
    halfWidth: vehicle.model.body.width / 2,
    halfLength: vehicle.model.body.length / 2,
    speed: vehicle.telemetry.speed,
  };
}

/** Moves the on-foot officer's body (and Transform) to (x, z). */
function placeOfficer(session: GameSession, x: number, z: number): void {
  session.physics.getBody(session.player)?.setTranslation({ x, y: PLAYER_SIZE.y / 2, z }, true);
  Transform.x[session.player] = x;
  Transform.z[session.player] = z;
}

/** The station pump (the refuelling tests park around it). */
function stationPump(): { x: number; z: number } {
  const station = city.pois.find((p) => p.kind === 'station');
  const block = station ? city.blocks[station.block] : undefined;
  if (!block) throw new Error('no station block');
  return stationLayout(block, LANDMARKS.station.yaw).pump;
}

/** Moves a vehicle's chassis (and Transform) to (x, z) facing `yaw`, at rest. */
function placeVehicle(session: GameSession, car: DrivableVehicle, x: number, z: number, yaw: number): void {
  const body = session.physics.getBody(car.eid);
  body?.setTranslation({ x, y: Transform.y[car.eid] ?? 1, z }, true);
  body?.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  body?.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body?.setAngvel({ x: 0, y: 0, z: 0 }, true);
  Transform.x[car.eid] = x;
  Transform.z[car.eid] = z;
}

function vehicle(session: GameSession, index: number): DrivableVehicle {
  const v = session.vehicles[index];
  if (!v) throw new Error(`no vehicle ${String(index)}`);
  return v;
}

describe('GameSession (city)', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });

  function fresh(boxPoolSize?: number): Harness {
    const h = new Harness(city, boxPoolSize);
    live.push(h);
    return h;
  }

  it('starts on foot at the station door with the patrol cars parked in the lot and traffic around', () => {
    const h = fresh();
    const session = h.start(SEED);
    expect(session.city).toBe(city);
    expect(session.driving).toBe(false);
    expect(hasComponent(h.world, session.player, Player)).toBe(true);
    expect(EntityKind.kind[session.player]).toBe(KIND.Player);
    expect(Transform.x[session.player]).toBeCloseTo(city.spawn.x, 3);
    expect(Transform.z[session.player]).toBeCloseTo(city.spawn.z, 3);
    expect(session.controller.yaw).toBe(city.spawn.yaw);

    expect(session.vehicles.map((v) => v.model.id)).toEqual(['patrol_sedan', 'patrol_suv']);
    session.vehicles.forEach((v, i) => {
      const slot = city.parking[i];
      expect(Transform.x[v.eid]).toBeCloseTo(slot?.x ?? NaN, 3);
      expect(Transform.z[v.eid]).toBeCloseTo(slot?.z ?? NaN, 3);
      expect(EntityKind.kind[v.eid]).toBe(KIND.Vehicle);
      expect(hasComponent(h.world, v.eid, Drivable)).toBe(true);
      expect(VehicleLook.model[v.eid]).toBe(v.model.index);
      expect(v.model.lightbar).toBe(true);
    });
    expect(session.traffic.activeCount).toBeGreaterThan(10);
    expect(session.entityCount).toBe(1 + 2 + session.traffic.activeCount);
    expect(entityCount(h.world)).toBe(session.entityCount);
    // Static colliders around the station are in the world on top of the ground slab.
    expect(h.physics.raw.colliders.len()).toBeGreaterThan(50);
  });

  it('registers its systems in the design order (Phase 1 §13, Phase 2 §15)', () => {
    const h = fresh();
    h.start(SEED);
    expect(h.registry.systems.map((s) => s.name)).toEqual([
      'copyPrevTransform',
      'environment',
      'colliders',
      'dispatch',
      'radio',
      'integrateVelocity',
      'vehicles.pre',
      'traffic',
      'physics',
      'vehicles.post',
    ]);
  });

  it('keeps parked cars still on their handbrake', () => {
    const h = fresh();
    const session = h.start(SEED);
    const before = session.vehicles.map((v) => ({ x: Transform.x[v.eid] ?? 0, y: Transform.y[v.eid] ?? 0, z: Transform.z[v.eid] ?? 0 }));
    h.step(session, 180);
    session.vehicles.forEach((v, i) => {
      const { x, y, z } = before[i] ?? { x: 0, y: 0, z: 0 };
      expect(Math.hypot((Transform.x[v.eid] ?? 0) - x, (Transform.z[v.eid] ?? 0) - z)).toBeLessThan(0.05);
      expect(Math.abs((Transform.y[v.eid] ?? 0) - y)).toBeLessThan(0.05);
      expect(v.telemetry.airborne).toBe(false);
    });
  });

  it('enters at the driver door, drives on the driver input, and gets out beside the car once stopped', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    expect(session.interactHint()).toBeNull();
    expect(session.interact()).toBe('none');

    const door = driverDoorPoint(candidate(car), { x: 0, z: 0 });
    placeOfficer(session, door.x, door.z);
    expect(session.interactHint()).toBe('enter');
    expect(session.interact()).toBe('entered');
    expect(session.modes.mode).toBe(PLAYER_MODE.driving);
    expect(session.drivenVehicle).toBe(car);
    expect(session.physics.has(session.player)).toBe(false);
    expect(h.meshes.has(session.player)).toBe(false);
    expect(Math.hypot((Transform.x[session.player] ?? 0) - (Transform.x[car.eid] ?? 0), (Transform.z[session.player] ?? 0) - (Transform.z[car.eid] ?? 0))).toBeLessThan(1);

    const z0 = Transform.z[car.eid] ?? 0;
    session.driverInput.accelerate = 1;
    h.step(session, 120);
    expect(car.telemetry.speed).toBeGreaterThan(5);
    expect(session.interactHint()).toBeNull();
    expect(session.interact()).toBe('tooFast');
    // Facing north (yaw 0): forward is -Z; the seat follows the car.
    expect(Transform.z[car.eid] ?? 0).toBeLessThan(z0 - 5);
    expect(Math.hypot((Transform.x[session.player] ?? 0) - (Transform.x[car.eid] ?? 0), (Transform.z[session.player] ?? 0) - (Transform.z[car.eid] ?? 0))).toBeLessThan(1);

    // Brake to a stop (held at standstill the brake pedal would engage reverse).
    session.driverInput.accelerate = 0;
    session.driverInput.brake = 1;
    for (let i = 0; i < 180 && car.telemetry.speed > 0.3; i++) h.step(session, 1);
    session.driverInput.brake = 0;
    expect(Math.abs(car.telemetry.speed)).toBeLessThan(0.5);
    expect(session.interactHint()).toBe('exit');
    const c = candidate(car);
    expect(session.interact()).toBe('exited');
    expect(session.driving).toBe(false);
    expect(session.lastVehicle).toBe(car);
    expect(session.physics.has(session.player)).toBe(true);
    expect(h.meshes.has(session.player)).toBe(true);
    const out = exitPoint(c, -1, { x: 0, z: 0 });
    expect(Transform.x[session.player]).toBeCloseTo(out.x, 3);
    expect(Transform.z[session.player]).toBeCloseTo(out.z, 3);
    expect(session.controller.yaw).toBeCloseTo(c.yaw, 6);
    // The empty car holds its handbrake.
    h.step(session, 60);
    expect(car.telemetry.handbrake).toBe(true);
    expect(Math.abs(car.telemetry.speed)).toBeLessThan(0.2);
  });

  it('gets out on the passenger side when the driver side is blocked, and refuses when both are', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    expect(session.enterVehicle(car)).toBe(true);
    h.step(session, 2);
    const c = candidate(car);
    const block = (side: -1 | 1): void => {
      const p = exitPoint(c, side, { x: 0, z: 0 });
      h.physics.raw.createCollider(RAPIER.ColliderDesc.cuboid(0.6, 1.5, 0.6).setTranslation(p.x, 1.5, p.z));
    };
    block(-1);
    h.step(session, 1); // scene queries see new colliders after a step
    expect(session.interact()).toBe('exited');
    const passenger = exitPoint(c, 1, { x: 0, z: 0 });
    expect(Transform.x[session.player]).toBeCloseTo(passenger.x, 3);
    expect(Transform.z[session.player]).toBeCloseTo(passenger.z, 3);

    expect(session.enterVehicle(car)).toBe(true);
    block(1);
    h.step(session, 1);
    expect(session.interact()).toBe('exitBlocked');
    expect(session.driving).toBe(true);
  });

  it('refuels the last-driven car at the station pump', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    expect(session.enterVehicle(car)).toBe(true);
    expect(session.exitVehicle()).toBe('exited');
    const pump = stationPump();
    // Park the car 6 m east of the pump; the officer stands 2 m west of it, away from the car's door.
    session.physics.getBody(car.eid)?.setTranslation({ x: pump.x + 6, y: Transform.y[car.eid] ?? 1, z: pump.z }, true);
    Transform.x[car.eid] = pump.x + 6;
    Transform.z[car.eid] = pump.z;
    placeOfficer(session, pump.x - 2, pump.z);
    car.refuel(-30);
    const low = car.telemetry.fuelL;
    expect(low).toBeLessThan(car.model.fuel.capacityL - 29);
    expect(session.interactHint()).toBe('refuel');
    expect(session.interact()).toBe('refuelled');
    expect(car.telemetry.fuelL).toBe(car.model.fuel.capacityL);
    placeOfficer(session, pump.x - 30, pump.z);
    expect(session.interactHint()).toBeNull();

    // The last-driven car survives an on-foot save and load.
    placeOfficer(session, pump.x - 2, pump.z);
    car.refuel(-30);
    const data = roundTrip(serializeGame(session));
    expect(data.player.lastVehicle).toBe(0);
    h.reset(session);
    const loaded = h.load(data);
    h.step(loaded, 2);
    expect(loaded.lastVehicle).toBe(vehicle(loaded, 0));
    expect(loaded.interactHint()).toBe('refuel');
    expect(loaded.interact()).toBe('refuelled');
    expect(vehicle(loaded, 0).telemetry.fuelL).toBe(car.model.fuel.capacityL);
  });

  it('refuels rather than gets in when the officer stands between the pump and the driver door', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    expect(session.enterVehicle(car)).toBe(true);
    expect(session.exitVehicle()).toBe('exited');
    const pump = stationPump();
    // Facing north (yaw 0) the driver door (left, -x) faces the pump 3 m to the west.
    placeVehicle(session, car, pump.x + 3, pump.z, 0);
    h.step(session, 5);
    placeOfficer(session, pump.x + 1, pump.z);
    expect(driverDoorPoint(candidate(car), { x: 0, z: 0 }).x).toBeLessThan(pump.x + 2.2);
    car.refuel(-30);
    expect(session.interactHint()).toBe('refuel');
    expect(session.interact()).toBe('refuelled');
    expect(car.telemetry.fuelL).toBe(car.model.fuel.capacityL);
    // With a full tank E gets in as usual.
    expect(session.interactHint()).toBe('enter');
    expect(session.interact()).toBe('entered');
  });

  it('stops the officer at a parked car instead of shoving and damaging it', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    let damaged = 0;
    h.bus.on('vehicle:damaged', () => damaged++);
    h.step(session, 10);
    const c = candidate(car);
    // 6 m in front of the car, facing it.
    placeOfficer(session, c.x - Math.sin(c.yaw) * 6, c.z - Math.cos(c.yaw) * 6);
    session.controller.yaw = c.yaw + Math.PI;
    for (let i = 0; i < 4; i++) {
      h.step(session, 60, { forward: 1, strafe: 0, sprint: true });
      h.step(session, 120);
    }
    expect(damaged).toBe(0);
    expect(car.telemetry.damage[0]).toBe(0);
    expect(car.telemetry.engineHealth).toBe(1);
    expect(Math.hypot((Transform.x[car.eid] ?? 0) - c.x, (Transform.z[car.eid] ?? 0) - c.z)).toBeLessThan(0.03);
    // The officer stands at the front bumper.
    const gap = Math.hypot((Transform.x[session.player] ?? 0) - c.x, (Transform.z[session.player] ?? 0) - c.z);
    expect(gap).toBeGreaterThan(c.halfLength);
    expect(gap).toBeLessThan(c.halfLength + 1);
  });

  it('a parked car keeps its engine off (no idle fuel) and drops reverse when left in it', () => {
    const h = fresh();
    const session = h.start(SEED);
    const parked = vehicle(session, 1);
    const fuel = parked.telemetry.fuelL;
    const car = vehicle(session, 0);
    expect(session.enterVehicle(car)).toBe(true);
    expect(car.telemetry.engineRunning).toBe(true);
    session.driverInput.brake = 1;
    h.step(session, 90);
    expect(car.telemetry.speed).toBeLessThan(-3);
    expect(car.telemetry.gear).toBe(-1);
    session.driverInput.brake = 0;
    for (let i = 0; i < 600 && Math.abs(car.telemetry.speed) >= 0.3; i++) h.step(session, 1);
    expect(session.interact()).toBe('exited');
    h.step(session, 600);
    expect((VehicleLook.lights[car.eid] ?? 0) & LIGHT.reverse).toBe(0);
    expect(car.telemetry.gear).toBe(1);
    expect(car.telemetry.engineRunning).toBe(false);
    expect(car.telemetry.rpm).toBe(0);
    expect(parked.telemetry.engineRunning).toBe(false);
    expect(parked.telemetry.fuelL).toBe(fuel);
  });

  it('refuses to get out of, or into, a car sliding sideways (the check uses the ground speed)', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    expect(session.enterVehicle(car)).toBe(true);
    h.step(session, 5);
    const yaw = candidate(car).yaw;
    // 12 m/s to the car's right: no forward component.
    session.physics.getBody(car.eid)?.setLinvel({ x: Math.cos(yaw) * 12, y: 0, z: -Math.sin(yaw) * 12 }, true);
    h.step(session, 1);
    expect(Math.abs(car.telemetry.speed)).toBeLessThan(1);
    expect(car.telemetry.groundSpeed).toBeGreaterThan(10);
    expect(session.interactHint()).toBeNull();
    expect(session.interact()).toBe('tooFast');
    expect(session.driving).toBe(true);

    const other = vehicle(session, 1);
    session.teleport(Transform.x[car.eid] ?? 0, Transform.z[car.eid] ?? 0);
    h.step(session, 30);
    expect(session.interact()).toBe('exited');
    const door = driverDoorPoint(candidate(other), { x: 0, z: 0 });
    placeOfficer(session, door.x, door.z);
    expect(session.interactHint()).toBe('enter');
    const oy = candidate(other).yaw;
    session.physics.getBody(other.eid)?.setLinvel({ x: Math.cos(oy) * 8, y: 0, z: -Math.sin(oy) * 8 }, true);
    h.step(session, 1);
    expect(session.interactHint()).not.toBe('enter');
  });

  it('traffic queues behind the patrol car parked in a lane instead of ramming it', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    let damaged = 0;
    let collisions = 0;
    h.bus.on('vehicle:damaged', (e) => {
      if (e.eid === car.eid) damaged++;
    });
    h.bus.on('traffic:collision', () => collisions++);
    // A busy arterial curb lane (edge 58, see the review repro).
    const lane = laneRef(58, 0, 0);
    const p = city.graph.lanePoint(lane, city.graph.laneLength(lane) / 2, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    expect(session.enterVehicle(car)).toBe(true);
    session.teleport(p.x, p.z, p.yaw);
    h.step(session, 30);
    expect(session.exitVehicle()).toBe('exited');
    // Step 12 m to the side of the car (no teleport, so traffic is not repopulated).
    placeOfficer(session, p.x - p.hz * 12, p.z + p.hx * 12);
    h.step(session, 2400);
    expect(collisions).toBe(0);
    expect(damaged).toBe(0);
    expect(Math.max(...car.telemetry.damage)).toBe(0);
  });

  it('always gives traffic the car the officer left as a parked obstacle, then the nearest others', () => {
    const h = fresh();
    const session = h.start(SEED);
    // Seven more cars in a row on the station's street: nine drivable vehicles, one more than the cap.
    const station = city.pois.find((p) => p.kind === 'station');
    const lane = laneRef(station?.entrance.edge ?? 0, 0, 0);
    const start = city.graph.laneStart(lane);
    const sedan = vehicleModel('sedan');
    for (let i = 0; i < 7; i++) {
      const p = city.graph.lanePoint(lane, start + 4 + 8 * i, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
      session.spawnVehicle(sedan, { x: p.x, y: 1, z: p.z, yaw: p.yaw });
    }
    const last = vehicle(session, 8);
    session.restoreLastVehicle(8);
    h.step(session, 1);
    const focus = (session as unknown as { focus: TrafficFocus }).focus;
    expect(focus.parkedCount).toBe(MAX_PARKED_OBSTACLES);
    const parked = focus.parked ?? [];
    expect(parked[0]?.x).toBeCloseTo(Transform.x[last.eid] ?? NaN, 5);
    expect(parked[0]?.z).toBeCloseTo(Transform.z[last.eid] ?? NaN, 5);
    const d2 = (i: number): number => ((parked[i]?.x ?? 0) - focus.x) ** 2 + ((parked[i]?.z ?? 0) - focus.z) ** 2;
    for (let i = 2; i < MAX_PARKED_OBSTACLES; i++) expect(d2(i)).toBeGreaterThanOrEqual(d2(i - 1));
  });

  it('repairs and refuels the last-driven car at the station pump', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    expect(session.enterVehicle(car)).toBe(true);
    expect(session.exitVehicle()).toBe('exited');
    const pump = stationPump();
    placeVehicle(session, car, pump.x + 6, pump.z, 0);
    h.step(session, 5);
    // Wreck it (as a hard frontal hit and a burst tyre would), with a full tank.
    const damage = (car as unknown as { damage: DamageState }).damage;
    damage.zones.set([1, 0.4, 0, 0]);
    damage.engineHealth = 0;
    damage.engineFailed = true;
    damage.tireFlat[0] = 1;
    const wrecked = car;
    h.step(session, 2);
    expect(wrecked.telemetry.fuelFraction).toBe(1);
    expect(wrecked.needsRepair).toBe(true);
    placeOfficer(session, pump.x - 2, pump.z);
    expect(session.interactHint()).toBe('repair');
    expect(session.interact()).toBe('repaired');
    expect(wrecked.needsRepair).toBe(false);
    h.step(session, 1);
    expect(wrecked.telemetry.damage).toEqual([0, 0, 0, 0]);
    expect(wrecked.telemetry.tireFlat).toEqual([false, false, false, false]);
    expect(wrecked.telemetry.engineHealth).toBe(1);
    expect(session.interactHint()).toBeNull();
  });

  it('stops the officer at the station building instead of walking through it', () => {
    const h = fresh();
    const session = h.start(SEED);
    const station = city.pois.find((p) => p.kind === 'station');
    const block = station ? city.blocks[station.block] : undefined;
    if (!block) throw new Error('no station block');
    const [x0, z0, x1, z1] = stationLayout(block, LANDMARKS.station.yaw).building;
    let inside = 0;
    for (let i = 0; i < 360; i++) {
      // The officer spawns at the door facing out: walking backwards heads into the building.
      h.step(session, 1, { forward: -1, strafe: 0, sprint: false });
      const x = Transform.x[session.player] ?? 0;
      const z = Transform.z[session.player] ?? 0;
      if (x > x0 && x < x1 && z > z0 && z < z1) inside++;
    }
    expect(inside).toBe(0);
    expect(Transform.y[session.player]).toBeCloseTo(PLAYER_SIZE.y / 2, 2);
    // Still free to walk away from it.
    const z = Transform.z[session.player] ?? 0;
    const x = Transform.x[session.player] ?? 0;
    h.step(session, 60, { forward: 1, strafe: 0, sprint: false });
    expect(Math.hypot((Transform.x[session.player] ?? 0) - x, (Transform.z[session.player] ?? 0) - z)).toBeGreaterThan(2);
  });

  it('keeps a box-pool slot for the officer while driving, so getting out and loading still work', () => {
    const h = fresh(4);
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    expect(session.enterVehicle(car)).toBe(true);
    expect(session.boxCapacityLeft).toBe(3);
    const at = { x: (Transform.x[car.eid] ?? 0) + 40, z: Transform.z[car.eid] ?? 0 };
    for (let i = 0; i < 3; i++) session.spawnBox({ x: at.x + 3 * i, y: 0.5, z: at.z });
    expect(() => session.spawnBox({ x: at.x, y: 0.5, z: at.z + 5 })).toThrow(RangeError);
    expect(session.spawnRandomBoxes(5)).toHaveLength(0);
    h.step(session, 2);
    const driving = roundTrip(serializeGame(session));
    expect(session.interact()).toBe('exited');
    expect(h.meshes.has(session.player)).toBe(true);
    const onFoot = roundTrip(serializeGame(session));
    h.reset(session);
    for (const data of [driving, onFoot]) {
      const loaded = h.load(data);
      expect(loaded.boxes).toHaveLength(3);
      h.step(loaded, 2);
      h.reset(loaded);
    }
  });

  it('saves the observed violations with the game', () => {
    const h = fresh();
    const session = h.start(SEED);
    const view = session.traffic.view;
    // The first ambient car (AI patrol units are fleet cars in the same view).
    let slot = 0;
    while (slot < view.count && isFleetVehicleId(view.vehicleId[slot] ?? 0)) slot++;
    const id = view.vehicleId[slot] ?? -1;
    const eid = view.eid[slot] ?? 0;
    h.bus.emit('traffic:violation', { eid, vehicleId: id, kind: 'speeding', x: 0, z: 0, speedMph: 50, limitMph: 35 });
    h.bus.emit('traffic:violation', { eid, vehicleId: id, kind: 'speeding', x: 0, z: 0, speedMph: 50, limitMph: 35 });
    h.bus.emit('traffic:violation', { eid, vehicleId: id, kind: 'redLight', x: 0, z: 0, speedMph: 20, limitMph: 35 });
    const data = roundTrip(serializeGame(session));
    expect(data.violations).toEqual([[id, { speeding: 2, redLight: 1 }]]);
    h.reset(session);
    const loaded = h.load(data);
    const row = loaded.trafficCars(500).find((r) => r.vehicleId === id);
    expect(row?.violations).toEqual({ speeding: 2, redLight: 1 });
  });

  it('switches the driven car headlights with the time of day, and H overrides them until the next switch', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    session.enterVehicle(car);
    h.step(session, 1);
    expect(car.headlights).toBe(session.env.lighting.headlightsOn);
    session.env.setWeatherOverride('clear');
    session.env.setTimeOfDay(12);
    h.step(session, 1);
    expect(car.headlights).toBe(false);
    session.toggleHeadlights();
    h.step(session, 1);
    expect(car.headlights).toBe(true);
    expect((VehicleLook.lights[car.eid] ?? 0) & LIGHT.head).toBe(LIGHT.head);
    session.env.setTimeOfDay(22);
    h.step(session, 1);
    expect(car.headlights).toBe(true);
    session.toggleHeadlights();
    h.step(session, 1);
    expect(car.headlights).toBe(false);
    session.toggleLightbar();
    h.step(session, 1);
    expect((VehicleLook.lights[car.eid] ?? 0) & LIGHT.lightbar).toBe(LIGHT.lightbar);
  });

  it('keeps headlights switched on with H through a save and load until the next automatic switch', () => {
    const h = fresh();
    const session = h.start(SEED);
    session.env.setWeatherOverride('clear');
    session.env.setTimeOfDay(12);
    session.enterVehicle(vehicle(session, 0));
    h.step(session, 1);
    session.toggleHeadlights();
    h.step(session, 1);
    expect(vehicle(session, 0).headlights).toBe(true);
    const data = roundTrip(serializeGame(session));
    h.reset(session);
    const loaded = h.load(data);
    h.step(loaded, 2);
    expect(vehicle(loaded, 0).headlights).toBe(true);
    loaded.env.setTimeOfDay(22);
    h.step(loaded, 1);
    loaded.env.setTimeOfDay(12);
    h.step(loaded, 1);
    expect(vehicle(loaded, 0).headlights).toBe(false);
  });

  it('teleports the driven car, primes colliders there and repopulates traffic around it', () => {
    const h = fresh();
    const live = new Set<number>();
    h.bus.on('traffic:spawned', (e) => live.add(e.eid));
    h.bus.on('traffic:despawned', (e) => live.delete(e.eid));
    const session = h.start(SEED);
    const car = vehicle(session, 1);
    session.enterVehicle(car);
    const target = city.graph.nodes[Math.floor(city.graph.nodes.length / 2)];
    if (!target) throw new Error('empty graph');
    session.teleport(target.x, target.z);
    expect(Transform.x[car.eid]).toBeCloseTo(target.x, 3);
    expect(Transform.z[car.eid]).toBeCloseTo(target.z, 3);
    expect(Math.hypot((Transform.x[session.player] ?? 0) - target.x, (Transform.z[session.player] ?? 0) - target.z)).toBeLessThan(1);
    const view = session.traffic.view;
    expect(view.count).toBeGreaterThan(0);
    // Ambient cars only: the AI units' fleet cars stay where they patrol (and emit no spawn events).
    let ambient = 0;
    for (let i = 0; i < view.count; i++) {
      if (isFleetVehicleId(view.vehicleId[i] ?? 0)) continue;
      ambient++;
      expect(Math.hypot((view.x[i] ?? 0) - target.x, (view.z[i] ?? 0) - target.z)).toBeLessThan(440);
    }
    // Every car dropped by the teleport was reported as despawned.
    expect(live.size).toBe(ambient);
    h.step(session, 60);
    expect(car.telemetry.airborne).toBe(false);
  });

  it('serializes a driving session to a valid v3 save and loads it back where it was', () => {
    // Sessions share the module-level component stores, so only one is alive at a time (as in the app).
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    session.enterVehicle(car);
    session.driverInput.accelerate = 0.6;
    session.driverInput.steer = 0.2;
    h.step(session, 90);
    session.env.setWeatherOverride('rain', 0.7);
    session.env.setTimeOfDay(21);
    session.toggleLightbar();
    session.cameraMode = CAMERA_MODE.cockpit;
    session.spawnRandomBoxes(3);
    h.step(session, 10);

    const data = roundTrip(serializeGame(session));
    expect(isSaveGame(data)).toBe(true);
    expect(data.player).toEqual({ mode: 'driving', vehicle: 0, lastVehicle: 0 });
    expect(data.camera.mode).toBe(CAMERA_MODE.cockpit);
    expect(data.vehicles).toHaveLength(2);
    expect(data.vehicles[0]?.lightbar).toBe(true);
    expect(data.traffic?.cars.length).toBe(session.traffic.activeCount);
    expect(data.environment.override).toEqual({ kind: 'rain', intensity: 0.7 });
    expect(data.world.entities.filter((e) => e.kind === KIND.Prop)).toHaveLength(3);
    const expected = {
      simTime: session.clock.simTime,
      hour: session.env.time.hour,
      traffic: session.traffic.activeCount,
      rng: session.rng.state(),
      input: { ...session.driverInput },
    };
    h.step(session, 60);
    const continued = session.physics.getBody(car.eid)?.translation();
    if (!continued) throw new Error('no chassis');
    const target = { x: continued.x, z: continued.z };
    h.reset(session);

    const loaded = h.load(data);
    expect(loaded.driving).toBe(true);
    expect(loaded.drivenVehicle).toBe(loaded.vehicles[0]);
    expect(loaded.cameraMode).toBe(CAMERA_MODE.cockpit);
    expect(loaded.clock.simTime).toBe(expected.simTime);
    expect(loaded.env.time.hour).toBeCloseTo(expected.hour, 9);
    expect(loaded.env.weather.kind).toBe('rain');
    expect(loaded.traffic.activeCount).toBe(expected.traffic);
    expect(loaded.boxes).toHaveLength(3);
    expect(loaded.rng.state()).toEqual(expected.rng);
    const resaved = roundTrip(serializeGame(loaded));
    expect(resaved.vehicles).toEqual(data.vehicles);
    expect(resaved.traffic).toEqual(data.traffic);
    expect(resaved.environment).toEqual(data.environment);

    // It continues the same way with the same driver input (Rapier's solver caches are not saved: allow a little drift).
    Object.assign(loaded.driverInput, expected.input);
    h.step(loaded, 60);
    const resumed = loaded.physics.getBody(vehicle(loaded, 0).eid)?.translation();
    expect(Math.hypot((resumed?.x ?? NaN) - target.x, (resumed?.z ?? NaN) - target.z)).toBeLessThan(0.05);
  });

  it('loads a migrated Phase 0 (v2) save: officer where saved, patrol cars re-parked, fresh traffic', () => {
    const v2 = {
      seed: SEED,
      rngState: createRng(SEED).state(),
      clock: { simTime: 30, timeScale: 1 },
      officer: { name: 'Old', badge: '1' },
      camera: { pitch: 0.4 },
      world: {
        entities: [
          { kind: KIND.Player, x: 0, y: 0.9, z: 6, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, sleeping: false },
          { kind: KIND.Prop, x: 0, y: 0.5, z: -8, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, sleeping: true },
        ],
      },
    };
    const migrated = migrateEnvelope({ version: 2, createdAt: 1, updatedAt: 1, slot: 'old', data: v2 }).data;
    const h = fresh();
    const session = h.load(migrated);
    expect(session.driving).toBe(false);
    expect(Transform.x[session.player]).toBeCloseTo(0, 3);
    expect(Transform.z[session.player]).toBeCloseTo(6, 3);
    expect(session.controller.pitch).toBe(0.4);
    expect(session.boxes).toHaveLength(1);
    expect(session.vehicles.map((v) => v.model.id)).toEqual(['patrol_sedan', 'patrol_suv']);
    expect(session.traffic.activeCount).toBeGreaterThan(0);
    expect(session.env.serialize()).toEqual({ timeOffset: 0, override: null });
    h.step(session, 30);
  });

  it('keeps traffic flowing around the officer, with violations observed nearby', () => {
    const h = fresh();
    const session = h.start(SEED);
    const seen = new Map<string, number>();
    const off = h.bus.on('traffic:violation', (e) => seen.set(e.kind, (seen.get(e.kind) ?? 0) + 1));
    h.step(session, 60 * 60);
    off();
    const view = session.traffic.view;
    let speed = 0;
    for (let i = 0; i < view.count; i++) speed += view.speed[i] ?? 0;
    expect(view.count).toBeGreaterThan(100);
    expect(speed / view.count).toBeGreaterThan(2);
    expect(session.traffic.stats.spawned).toBeGreaterThan(view.count);
    expect([...seen.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('spawns a vehicle ahead of the officer from its own stream', () => {
    const h = fresh();
    const session = h.start(SEED);
    const before = session.rng.state();
    const van = session.spawnVehicleNearPlayer(vehicleModel('van'));
    expect(session.vehicles).toHaveLength(3);
    expect(session.rng.state()).toEqual(before);
    const yaw = session.controller.yaw;
    expect(Transform.x[van.eid]).toBeCloseTo((Transform.x[session.player] ?? 0) - Math.sin(yaw) * 6, 3);
    expect(Transform.z[van.eid]).toBeCloseTo((Transform.z[session.player] ?? 0) - Math.cos(yaw) * 6, 3);
    const data = serializeGame(session);
    expect(data.vehicles[2]?.modelId).toBe('van');
    expect(data.vehicles[2]?.rng.seed).toBe(createRng(SEED).stream('vehicle:2').seed);
  });

  it('dispose removes every entity, body, collider and mesh so a new game starts clean', () => {
    const h = fresh();
    const first = h.start(SEED);
    first.spawnRandomBoxes(4);
    h.step(first, 10);
    h.reset(first);
    expect(entityCount(h.world)).toBe(0);
    expect(h.meshes.count).toBe(0);
    expect(() => first.spawnBox({ x: 0, y: 1, z: 0 })).toThrow();

    const second = h.start(SEED);
    second.dispose();
    expect(entityCount(h.world)).toBe(0);
    expect(h.physics.bodyCount).toBe(0);
    expect(h.meshes.count).toBe(0);
    expect(h.physics.raw.colliders.len()).toBe(5); // only the ground slab and the four world walls are left
  });

  it('spawnRandomBoxes drops boxes over the officer and stops at the pool capacity', () => {
    const h = fresh(6);
    const session = h.start(SEED);
    const spawned = session.spawnRandomBoxes(50);
    expect(spawned).toHaveLength(5);
    expect(session.boxCapacityLeft).toBe(0);
    expect(session.spawnRandomBoxes(1)).toHaveLength(0);
    const xs = spawned.map((eid) => session.physics.getBody(eid)?.translation().x ?? NaN);
    expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - (Transform.x[session.player] ?? 0))).toBeLessThan(10);
  });

  it('walls the world in just outside the perimeter roads', () => {
    const h = fresh();
    const session = h.start(SEED);
    h.step(session, 1); // scene queries see colliders after a step
    for (const [x, z, dx, dz] of [[-3570, 0, -1, 0], [3570, 0, 1, 0], [0, -3570, 0, -1], [0, 3570, 0, 1]] as const) {
      const hit = session.physics.castRay({ x, y: 1, z }, { x: dx, y: 0, z: dz }, 100);
      expect(hit?.toi).toBeCloseTo(28, 3);
    }
  });

  it('seeds are normalized the same way as createRng', () => {
    const h = fresh();
    const session = h.start('alpha');
    expect(session.seed).toBe(createRng('alpha').seed);
    expect(session.city.seed).toBe(session.seed);
  });

  it('a save of an on-foot session restores the officer pose and camera', () => {
    const h = fresh();
    const session = h.start(SEED);
    h.step(session, 30, { forward: 1, strafe: 0, sprint: false });
    session.controller.lookByMouse(500, -40);
    const data: SaveGame = roundTrip(serializeGame(session));
    expect(data.player).toEqual({ mode: 'onFoot', vehicle: -1, lastVehicle: -1 });
    const { yaw, pitch } = session.controller;
    const x = Transform.x[session.player] ?? NaN;
    const z = Transform.z[session.player] ?? NaN;
    h.reset(session);
    const loaded = h.load(data);
    expect(loaded.controller.yaw).toBeCloseTo(yaw, 6);
    expect(loaded.controller.pitch).toBe(pitch);
    expect(Transform.x[loaded.player]).toBeCloseTo(x, 3);
    expect(Transform.z[loaded.player]).toBeCloseTo(z, 3);
  });
});

describe('determinism', () => {
  it('replays a scripted shift (walk, drive, weather, traffic) exactly in a later session of the same page', () => {
    const h = new Harness(city);
    const run = (): string => {
      const session = h.start(SEED);
      // Walk towards the lot for a second, then get into the patrol car and drive a scripted loop.
      h.step(session, 60, { forward: 1, strafe: 0.3, sprint: false });
      session.enterVehicle(vehicle(session, 0));
      for (let step = 0; step < 1140; step++) {
        const d = session.driverInput;
        d.accelerate = step < 400 ? 1 : step < 700 ? 0.4 : 0;
        d.brake = step >= 900 ? 0.8 : 0;
        d.steer = Math.sin(step / 90) * 0.6;
        d.handbrake = step >= 1100;
        if (step === 500) session.env.setWeatherOverride('rain', 0.9);
        h.step(session, 1);
      }
      const data = serializeGame(session);
      h.reset(session);
      return JSON.stringify({ vehicles: data.vehicles, traffic: data.traffic, rng: data.rngState, env: data.environment, world: data.world });
    };
    const first = run();
    const second = run();
    expect(second).toBe(first);
    const parsed = JSON.parse(first) as { traffic: { cars: unknown[] } };
    expect(parsed.traffic.cars.length).toBeGreaterThan(0);
    h.dispose();
  }, 60_000);
});
