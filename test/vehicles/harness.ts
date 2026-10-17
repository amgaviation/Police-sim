import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../../src/physics/physics';
import type { DriverControls } from '../../src/vehicles/controls';
import { DrivableVehicle, type SerializedVehicle, type VehicleEnvironment } from '../../src/vehicles/drivableVehicle';
import { restHeight, vehicleModel, type VehicleModel } from '../../src/vehicles/model';

export const DT = 1 / 60;
/** Half-size of the test ground is 500 m; cars are shifted back by this much when they pass it. */
const WRAP = 400;

export interface Rig {
  physics: PhysicsWorld;
  vehicle: DrivableVehicle;
  env: VehicleEnvironment;
  controls: DriverControls;
  /** Receives the vehicle's events. */
  bus: EventBus<EventMap>;
  /** One fixed step with the current `controls`. */
  step(): void;
  /** Steps until `until()` is true or `maxSeconds` pass; returns the elapsed seconds. */
  run(until: () => boolean, maxSeconds: number): number;
  position(): { x: number; z: number };
  /** Distance travelled (m), unaffected by the wrap-around. */
  odometer(): number;
  yaw(): number;
}

export function makeEnv(surface = 0, wetness = 0, snowCover = 0): VehicleEnvironment {
  return { surfaceAt: () => surface, wetness, snowCover, ambientC: 20 };
}

/** The vehicle RNG stream every rig uses. */
export function vehicleRng(): ReturnType<typeof createRng> {
  return createRng(42).stream('vehicle:0');
}

/**
 * Physics world with a 500 m ground and one vehicle: a new one at the origin facing -Z (yaw 0), settled
 * on its wheels for 1 s, or `restoreFrom` restored as-is.
 */
export async function makeRig(
  model: VehicleModel | string = 'patrol_sedan',
  env = makeEnv(),
  eid = 1,
  restoreFrom?: SerializedVehicle,
): Promise<Rig> {
  const physics = await PhysicsWorld.create();
  physics.addGround(500);
  const m = typeof model === 'string' ? vehicleModel(model) : model;
  // Rapier ray casts see the broad-phase of the last step: let the ground in before restoring a moving car.
  if (restoreFrom) physics.step();
  const vehicle = restoreFrom
    ? DrivableVehicle.restore(physics, eid, restoreFrom, vehicleRng())
    : DrivableVehicle.create(physics, eid, m, { x: 0, y: restHeight(m), z: 0, yaw: 0 }, vehicleRng());
  const controls: DriverControls = { throttle: 0, brake: 0, steer: 0, handbrake: false, reverse: false };
  const bus = new EventBus<EventMap>();
  let odometer = 0;
  const bodyOf = (): RigidBody => {
    const body = physics.getBody(rig.vehicle.eid);
    if (!body) throw new Error('vehicle body not registered');
    return body;
  };
  const step = (): void => {
    const v = rig.vehicle;
    const body = bodyOf();
    const p0 = body.translation();
    v.setControls(controls);
    v.preStep(DT, env);
    physics.step();
    v.postStep(DT, bus);
    const p = body.translation();
    odometer += Math.hypot(p.x - p0.x, p.z - p0.z);
    // Long runs leave the 500 m ground: shift the car back (velocity and orientation are kept).
    if (Math.abs(p.x) > WRAP || Math.abs(p.z) > WRAP) {
      body.setTranslation({ x: p.x - Math.trunc(p.x / WRAP) * WRAP, y: p.y, z: p.z - Math.trunc(p.z / WRAP) * WRAP }, true);
    }
  };
  const rig: Rig = {
    physics,
    vehicle,
    env,
    controls,
    bus,
    step,
    run(until, maxSeconds) {
      let t = 0;
      while (!until() && t < maxSeconds) {
        step();
        t += DT;
      }
      return t;
    },
    position() {
      const p = bodyOf().translation();
      return { x: p.x, z: p.z };
    },
    odometer: () => odometer,
    yaw() {
      const q = bodyOf().rotation();
      return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
    },
  };
  if (!restoreFrom) rig.run(() => false, 1);
  worlds.push(physics);
  return rig;
}

const worlds: PhysicsWorld[] = [];

/** Frees every rig's physics world (call from `afterEach`). */
export function disposeRigs(): void {
  for (const world of worlds.splice(0)) world.dispose();
}

/** Simple speed hold for scripted runs: proportional throttle, coasting above the target. */
export function holdSpeed(rig: Rig, kmh: number): void {
  rig.controls.brake = 0;
  rig.controls.throttle = Math.max(0, Math.min(1, (kmh - rig.vehicle.telemetry.speedKmh) * 0.3));
}

/** Heading of the velocity (yaw convention: 0 = -Z, + = counter-clockwise). */
export function velocityHeading(rig: Rig): number {
  const v = rig.physics.getBody(rig.vehicle.eid)?.linvel() ?? { x: 0, z: -1 };
  return Math.atan2(-v.x, -v.z);
}

/** Accelerates to `kmh`, then brakes fully; returns the stopping distance from the moment the brake is applied. */
export function brakeTest(rig: Rig, kmh: number): number {
  const c = rig.controls;
  c.brake = 0;
  c.throttle = 1;
  rig.run(() => rig.vehicle.telemetry.speedKmh >= kmh, 60);
  c.throttle = 0;
  c.brake = 1;
  const start = rig.odometer();
  rig.run(() => rig.vehicle.telemetry.speed < 0.05, 30);
  c.brake = 0;
  return rig.odometer() - start;
}
