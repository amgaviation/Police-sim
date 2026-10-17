import RAPIER, { type Collider, type DynamicRayCastVehicleController, type RigidBody } from '@dimforge/rapier3d-compat';
import type { EntityId } from 'bitecs';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { PhysicsWorld, Vec3 } from '../physics/physics';
import { absModulate, brakeEfficiency, updateBrakeTemp, type AbsResult } from './brakes';
import { LIGHT, VehicleLook } from './components';
import type { DriverControls } from './controls';
import {
  applyImpact,
  cornerWheel,
  createDamageState,
  resetDamageState,
  rollStall,
  ZONE,
  ZONE_NAMES,
  type ImpactResult,
} from './damage';
import './events';
import { fuelBurnLiters } from './fuel';
import { restHeight, vehicleModel, type VehicleModel } from './model';
import { surfaceGrip, surfaceRolling } from './surfaces';

/** What the vehicle needs from the world each step (injected; the integrator adapts city + environment). */
export interface VehicleEnvironment {
  /** Surface id (`SURFACE_NAMES` index) at a world x, z. */
  surfaceAt(x: number, z: number): number;
  /** 0..1 road wetness and snow cover. */
  wetness: number;
  snowCover: number;
  ambientC: number;
}

/** Spawn pose; `y` is the body-box centre (the entity origin), `restHeight(model)` on flat ground. */
export interface VehiclePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Chassis-local wheel centre; `steer` is about +Y (positive = left), `spin` about +X
 * (decreasing when rolling forward, matching the renderer).
 */
export interface WheelPose {
  x: number;
  y: number;
  z: number;
  steer: number;
  spin: number;
  radius: number;
  inContact: boolean;
}

export interface VehicleTelemetry {
  /** Signed forward speed (m/s, + = forwards) and the same in km/h and mph. */
  speed: number;
  speedKmh: number;
  speedMph: number;
  /** Horizontal speed in any direction (m/s, >= 0): also counts sideways sliding. */
  groundSpeed: number;
  rpm: number;
  /** -1 reverse, 1..n. */
  gear: number;
  throttle: number;
  brake: number;
  /** Current front-wheel angle as a fraction of the low-speed maximum, + = right. */
  steer: number;
  absActive: boolean;
  handbrake: boolean;
  fuelL: number;
  fuelFraction: number;
  engineRunning: boolean;
  engineHealth: number;
  /** Hottest axle, and the lowest axle efficiency. */
  brakeTempC: number;
  brakeEfficiency: number;
  /** FL, FR, RL, RR. */
  tireFlat: readonly [boolean, boolean, boolean, boolean];
  /** front, rear, left, right 0..1. */
  damage: readonly [number, number, number, number];
  wheelSurface: readonly [number, number, number, number];
  airborne: boolean;
}

/**
 * Internal integrator state that `serialize` adds so a restored vehicle continues bit-identically.
 * Optional: a save without it restores with defaults (straight wheels, static wheel loads).
 */
export interface VehicleSimState {
  steerAngle: number;
  gear: number;
  stallS: number;
  absTime: number;
  wheelLoad: [number, number, number, number];
}

export interface SerializedVehicle {
  modelId: string;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  fuelL: number;
  brakeTempC: [number, number];
  zones: [number, number, number, number];
  engineHealth: number;
  engineFailed: boolean;
  tireFlat: [boolean, boolean, boolean, boolean];
  headlights: boolean;
  lightbar: boolean;
  reversing: boolean;
  sim?: VehicleSimState;
}

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

const GRAVITY = 9.81;
const MPH = 0.44704;
const WHEELS = 4;
/** Speed (m/s) at which the steering lock has shrunk to `highSpeedFactor`. */
const STEER_FADE_SPEED = 40;
/** Side grip kept by a locked (sliding) wheel. */
const LOCKED_SIDE = 0.1;
/**
 * Flat tyre: radius and grip factors, and extra rolling drag (x wheel load). The drag, plus the brake torque
 * acting on a smaller radius, pulls the car toward the flat side unless the brakes are grip-limited.
 */
const FLAT_RADIUS = 0.85;
const FLAT_GRIP = 0.45;
const FLAT_DRAG = 0.25;
/** Clamp of the load-sensitivity grip factor. */
const LOAD_FACTOR_MIN = 0.7;
const LOAD_FACTOR_MAX = 1.3;
/** Below this speed the brakes just hold (no ABS / locking). */
const ABS_MIN_SPEED = 1.5;
/** Automatic gearbox shift points as fractions of the redline. */
const UPSHIFT = 0.88;
const DOWNSHIFT = 0.45;
const BRAKE_PEDAL_LIGHT = 0.05;
const DEFAULT_AMBIENT_C = 20;
const RAY_FILTER = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Aerodynamic drag factor k (N per (m/s)²) so that `maxPowerKw` exactly balances drag plus asphalt rolling
 * resistance at `maxSpeedKmh`.
 */
export function dragCoefficient(model: VehicleModel): number {
  const vmax = model.engine.maxSpeedKmh / 3.6;
  const rolling = surfaceRolling(0) * model.mass * GRAVITY * vmax;
  return Math.max(0, model.engine.maxPowerKw * 1000 - rolling) / (vmax * vmax * vmax);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * A player-drivable vehicle on Rapier's `DynamicRayCastVehicleController` (design §8). Local -Z is the
 * front; wheels are FL, FR, RL, RR. Call `setControls` + `preStep` before `physics.step()` and
 * `postStep` after it, every fixed step. Both are allocation-free.
 */
export class DrivableVehicle {
  readonly eid: EntityId;
  readonly model: VehicleModel;
  readonly wheelCount = WHEELS;
  /** Same object every step, updated in place by `postStep`. */
  readonly telemetry: Readonly<VehicleTelemetry>;
  headlights = false;
  /** Light bar on (only drawn for models with `lightbar`). */
  lightbar = false;
  /**
   * Ignition. Off, the engine does not run: no drive, no idle fuel burn and no random stalls
   * (the session switches it with the driver getting in and out).
   */
  engineOn = true;

  private readonly physics: PhysicsWorld;
  private readonly body: RigidBody;
  private readonly colliderHandle: number;
  private readonly controller: DynamicRayCastVehicleController;
  private readonly rng: Rng;
  private readonly tel: VehicleTelemetry;
  private readonly telFlat: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private readonly telZones: [number, number, number, number] = [0, 0, 0, 0];
  private readonly telSurface: [number, number, number, number] = [0, 0, 0, 0];
  private readonly controls: DriverControls = { throttle: 0, brake: 0, steer: 0, handbrake: false, reverse: false };
  private readonly damage = createDamageState();
  private readonly brakeTemp = new Float64Array(2);
  private readonly wheelLoad = new Float64Array(WHEELS);
  /** Brake impulse transmitted by each wheel's brake this step (0 when locked); heats the axle. */
  private readonly brakeImpulse = new Float64Array(WHEELS);
  private readonly wheelSurface = new Uint8Array(WHEELS);
  private readonly wheelX = new Float64Array(WHEELS);
  private readonly wheelZ = new Float64Array(WHEELS);
  private readonly driven = new Uint8Array(WHEELS);
  private readonly drivenCount: number;
  /** Chassis-local y of the suspension hard points. */
  private readonly hardPointY: number;
  private readonly staticLoad: number;
  private readonly dragK: number;
  private readonly notOwnChassis: (collider: Collider) => boolean;
  private fuelL: number;
  /** Front-wheel angle in radians, + = right. */
  private steerAngle = 0;
  private gear = 1;
  private stallS = 0;
  private absTime = 0;
  private absActive = false;
  private engineKw = 0;
  private ambientC = DEFAULT_AMBIENT_C;
  private fuelEmptySent = false;
  private disposed = false;
  private vPreX = 0;
  private vPreZ = 0;
  private readonly v: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly q: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly p: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly absOut: AbsResult = { brake: 0, locked: false };
  private readonly impact: ImpactResult = { zone: ZONE.front, amount: 0, tireBurst: -1, engineFailedNow: false };

  private constructor(physics: PhysicsWorld, eid: EntityId, model: VehicleModel, position: Vec3, rotation: Quat, rng: Rng) {
    this.physics = physics;
    this.eid = eid;
    this.model = model;
    this.rng = rng;
    this.fuelL = model.fuel.capacityL;
    this.brakeTemp.fill(DEFAULT_AMBIENT_C);
    this.staticLoad = (model.mass * GRAVITY) / WHEELS;
    this.wheelLoad.fill(this.staticLoad);
    this.dragK = dragCoefficient(model);

    const { body: dims, suspension: susp, tires } = model;
    const raw = physics.raw;
    this.body = raw.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(rotation)
        .setCanSleep(false),
    );
    const m = model.mass;
    const collider = raw.createCollider(
      RAPIER.ColliderDesc.cuboid(dims.width / 2, dims.height / 2, dims.length / 2)
        .setMassProperties(
          m,
          { x: 0, y: model.comHeight - restHeight(model), z: 0 },
          {
            x: (m * (dims.height ** 2 + dims.length ** 2)) / 12,
            y: (m * (dims.width ** 2 + dims.length ** 2)) / 12,
            z: (m * (dims.width ** 2 + dims.height ** 2)) / 12,
          },
          IDENTITY,
        )
        .setFriction(0.4)
        .setRestitution(0.1)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );
    this.colliderHandle = collider.handle;
    physics.registerBody(eid, this.body);
    this.notOwnChassis = (c) => c.handle !== this.colliderHandle;

    // Hard points sit so the static sag (load / (stiffness x mass) per wheel) puts the body at restHeight.
    const sag = GRAVITY / (WHEELS * susp.stiffness);
    this.hardPointY = tires.radius + susp.restLength - sag - restHeight(model);
    const ctl = raw.createVehicleController(this.body);
    ctl.indexUpAxis = 1;
    ctl.setIndexForwardAxis = 2;
    let drivenCount = 0;
    for (let i = 0; i < WHEELS; i++) {
      const front = i < 2;
      this.wheelX[i] = (i % 2 === 0 ? -1 : 1) * (dims.track / 2);
      this.wheelZ[i] = (front ? -1 : 1) * (dims.wheelbase / 2);
      // Axle +X makes the rolling direction (contact normal x axle) point to -Z, the front.
      ctl.addWheel(
        { x: this.wheelX[i] ?? 0, y: this.hardPointY, z: this.wheelZ[i] ?? 0 },
        { x: 0, y: -1, z: 0 },
        { x: 1, y: 0, z: 0 },
        susp.restLength,
        tires.radius,
      );
      ctl.setWheelSuspensionStiffness(i, susp.stiffness);
      ctl.setWheelSuspensionCompression(i, susp.compression);
      ctl.setWheelSuspensionRelaxation(i, susp.relaxation);
      ctl.setWheelMaxSuspensionTravel(i, susp.maxTravel);
      ctl.setWheelMaxSuspensionForce(i, susp.maxForce);
      ctl.setWheelFrictionSlip(i, tires.frictionSlip);
      ctl.setWheelSideFrictionStiffness(i, tires.sideStiffness);
      const isDriven = model.drive === 'awd' || (model.drive === 'fwd') === front;
      this.driven[i] = isDriven ? 1 : 0;
      if (isDriven) drivenCount++;
    }
    this.drivenCount = drivenCount;
    this.controller = ctl;

    this.tel = {
      speed: 0,
      speedKmh: 0,
      speedMph: 0,
      groundSpeed: 0,
      rpm: 0,
      gear: 1,
      throttle: 0,
      brake: 0,
      steer: 0,
      absActive: false,
      handbrake: false,
      fuelL: this.fuelL,
      fuelFraction: 1,
      engineRunning: true,
      engineHealth: 1,
      brakeTempC: DEFAULT_AMBIENT_C,
      brakeEfficiency: 1,
      tireFlat: this.telFlat,
      damage: this.telZones,
      wheelSurface: this.telSurface,
      airborne: false,
    };
    this.telemetry = this.tel;
  }

  /** Builds the chassis, collider and controller and registers the body for `eid`. */
  static create(physics: PhysicsWorld, eid: EntityId, model: VehicleModel, pose: VehiclePose, rng: Rng): DrivableVehicle {
    const half = pose.yaw / 2;
    return new DrivableVehicle(physics, eid, model, pose, { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, rng);
  }

  /** Rebuilds a vehicle from `serialize()` output; `rng` should be the same stream the original used. */
  static restore(physics: PhysicsWorld, eid: EntityId, data: SerializedVehicle, rng: Rng): DrivableVehicle {
    const model = vehicleModel(data.modelId);
    const v = new DrivableVehicle(
      physics,
      eid,
      model,
      { x: data.x, y: data.y, z: data.z },
      { x: data.qx, y: data.qy, z: data.qz, w: data.qw },
      rng,
    );
    v.body.setLinvel({ x: data.vx, y: data.vy, z: data.vz }, true);
    v.body.setAngvel({ x: data.wx, y: data.wy, z: data.wz }, true);
    v.fuelL = clamp(data.fuelL, 0, model.fuel.capacityL);
    v.fuelEmptySent = v.fuelL <= 0;
    v.brakeTemp[0] = data.brakeTempC[0];
    v.brakeTemp[1] = data.brakeTempC[1];
    for (let i = 0; i < 4; i++) {
      v.damage.zones[i] = data.zones[i] ?? 0;
      v.damage.tireFlat[i] = data.tireFlat[i] ? 1 : 0;
    }
    v.damage.engineHealth = data.engineHealth;
    v.damage.engineFailed = data.engineFailed;
    v.applyTyreRadii();
    v.headlights = data.headlights;
    v.lightbar = data.lightbar;
    v.controls.reverse = data.reversing;
    if (data.sim) {
      v.steerAngle = data.sim.steerAngle;
      v.gear = data.sim.gear;
      v.stallS = data.sim.stallS;
      v.absTime = data.sim.absTime;
      for (let i = 0; i < WHEELS; i++) v.wheelLoad[i] = data.sim.wheelLoad[i] ?? v.staticLoad;
    }
    const { qx, qy, qz, qw } = data;
    const back = data.vx * 2 * (qx * qz + qw * qy) + data.vy * 2 * (qy * qz - qw * qx) + data.vz * (1 - 2 * (qx * qx + qy * qy));
    v.refreshTelemetry(-back, Math.hypot(data.vx, data.vz));
    v.writeLook();
    return v;
  }

  /** In reverse (the driver's `mapDriverInput` needs it). */
  get reversing(): boolean {
    return this.controls.reverse;
  }

  setControls(controls: DriverControls): void {
    const c = this.controls;
    c.throttle = clamp(controls.throttle, 0, 1);
    c.brake = clamp(controls.brake, 0, 1);
    c.steer = clamp(controls.steer, -1, 1);
    c.handbrake = controls.handbrake;
    c.reverse = controls.reverse;
  }

  /** Sets steering, drive, brakes and per-wheel grip, then runs the controller. Call before `physics.step()`. */
  preStep(dt: number, env: VehicleEnvironment): void {
    const { model, controls: c, controller: ctl } = this;
    const v = this.body.linvel(this.v);
    const { x: qx, y: qy, z: qz, w: qw } = this.body.rotation(this.q);
    const p = this.body.translation(this.p);
    // Chassis basis columns (x/z parts): right = local +X, up = local +Y, back = local +Z.
    const rx = 1 - 2 * (qy * qy + qz * qz);
    const rz = 2 * (qx * qz - qw * qy);
    const ux = 2 * (qx * qy - qw * qz);
    const uz = 2 * (qy * qz + qw * qx);
    const bx = 2 * (qx * qz + qw * qy);
    const by = 2 * (qy * qz - qw * qx);
    const bz = 1 - 2 * (qx * qx + qy * qy);
    const speed = -(v.x * bx + v.y * by + v.z * bz);
    const absSpeed = Math.abs(speed);
    const running = this.engineRunning();
    this.ambientC = env.ambientC;

    // Speed-dependent, rate-limited steering (+ = right; Rapier's positive steering turns left).
    const st = model.steering;
    const lockFactor = 1 + (st.highSpeedFactor - 1) * Math.min(absSpeed / STEER_FADE_SPEED, 1);
    const target = c.steer * st.maxAngleDeg * (Math.PI / 180) * lockFactor;
    const maxDelta = st.rateDegPerS * (Math.PI / 180) * dt;
    this.steerAngle += clamp(target - this.steerAngle, -maxDelta, maxDelta);

    // Power-limited tractive force, cut at the forward / reverse top speed.
    let drive = 0;
    const vmax = (c.reverse ? model.engine.reverseMaxSpeedKmh : model.engine.maxSpeedKmh) / 3.6;
    if (running && c.throttle > 0 && absSpeed < vmax) {
      drive = c.throttle * Math.min(model.engine.maxForce, (model.engine.maxPowerKw * 1000) / Math.max(absSpeed, 1));
      if (c.reverse) drive = -drive;
    }
    this.engineKw = (Math.abs(drive) * absSpeed) / 1000;
    const dragShare = (this.dragK * speed * speed) / WHEELS;
    const motionSign = speed > 0.05 ? 1 : speed < -0.05 ? -1 : 0;

    const { brakes, tires } = model;
    const frontEff = brakeEfficiency(this.brakeTemp[0] ?? 0, brakes);
    const rearEff = brakeEfficiency(this.brakeTemp[1] ?? 0, brakes);
    this.absTime += dt;
    this.absActive = false;
    for (let i = 0; i < WHEELS; i++) {
      const front = i < 2;
      const lx = this.wheelX[i] ?? 0;
      const lz = this.wheelZ[i] ?? 0;
      const surface = env.surfaceAt(p.x + rx * lx + ux * this.hardPointY + bx * lz, p.z + rz * lx + uz * this.hardPointY + bz * lz);
      this.wheelSurface[i] = surface;
      const grip = surfaceGrip(surface, env.wetness, env.snowCover);
      const flat = this.damage.tireFlat[i] === 1;
      const load = clamp(this.wheelLoad[i] ?? 0, 0, model.suspension.maxForce);
      const loadFactor = clamp(Math.pow(load / this.staticLoad, -tires.loadSensitivity), LOAD_FACTOR_MIN, LOAD_FACTOR_MAX);
      const mu = tires.frictionSlip * grip * loadFactor * (flat ? FLAT_GRIP : 1);
      const limit = mu * load * dt;

      let demand = c.brake * brakes.maxForce * (front ? brakes.frontBias : 1 - brakes.frontBias) * 0.5 * (front ? frontEff : rearEff);
      const handbrake = !front && c.handbrake;
      if (handbrake) demand += brakes.handbrakeForce * 0.5;
      demand *= flat ? dt / FLAT_RADIUS : dt;
      let brake = demand;
      let locked = false;
      // An unloaded wheel (airborne, or the stale zero of the landing step) is not judged for ABS / locking.
      if (demand > 0 && absSpeed >= ABS_MIN_SPEED && load > 0) {
        const abs = brakes.abs && !handbrake;
        absModulate(demand, limit, abs, this.absTime, this.absOut);
        brake = this.absOut.brake;
        locked = this.absOut.locked;
        if (abs && demand > limit) this.absActive = true;
      }
      this.brakeImpulse[i] = locked ? 0 : brake;

      const resist = (surfaceRolling(surface) + (flat ? FLAT_DRAG : 0)) * load + dragShare;
      if (drive !== 0 && this.driven[i] === 1 && demand === 0) {
        ctl.setWheelEngineForce(i, drive / this.drivenCount - motionSign * resist);
        ctl.setWheelBrake(i, 0);
      } else {
        ctl.setWheelEngineForce(i, 0);
        ctl.setWheelBrake(i, brake + resist * dt);
      }
      // A locked wheel slides: its friction follows the chassis, not the steered wheel.
      if (front) ctl.setWheelSteering(i, locked ? 0 : -this.steerAngle);
      ctl.setWheelFrictionSlip(i, mu);
      ctl.setWheelSideFrictionStiffness(i, tires.sideStiffness * grip * (flat ? FLAT_GRIP : 1) * (locked ? LOCKED_SIDE : 1));
    }

    ctl.updateVehicle(dt, RAY_FILTER, undefined, this.notOwnChassis);
    for (let i = 0; i < WHEELS; i++) this.wheelLoad[i] = ctl.wheelSuspensionForce(i) ?? 0;
    // Velocity with the vehicle's own impulses applied: what the physics step changes beyond gravity is impact.
    this.body.linvel(v);
    this.vPreX = v.x;
    this.vPreZ = v.z;
  }

  /** Impacts and damage, engine, fuel, brake temperature, telemetry and `VehicleLook`. Call after `physics.step()`. */
  postStep(dt: number, bus?: EventBus<EventMap>): void {
    const { model, damage } = this;
    const v = this.body.linvel(this.v);
    const { x: qx, y: qy, z: qz, w: qw } = this.body.rotation(this.q);
    const rx = 1 - 2 * (qy * qy + qz * qz);
    const rz = 2 * (qx * qz - qw * qy);
    const bx = 2 * (qx * qz + qw * qy);
    const by = 2 * (qy * qz - qw * qx);
    const bz = 1 - 2 * (qx * qx + qy * qy);
    const speed = -(v.x * bx + v.y * by + v.z * bz);
    const absSpeed = Math.abs(speed);

    const dvx = v.x - this.vPreX;
    const dvz = v.z - this.vPreZ;
    const impactSpeed = Math.hypot(dvx, dvz);
    if (impactSpeed >= model.damage.minImpactSpeed) {
      // The hit comes from the opposite of the velocity change, in chassis axes.
      const hx = -(dvx * rx + dvz * rz);
      const hz = -(dvx * bx + dvz * bz);
      const out = applyImpact(damage, hx, hz, impactSpeed, cornerWheel(hx, hz), model.damage, this.rng, this.impact);
      bus?.emit('vehicle:damaged', { eid: this.eid, zone: ZONE_NAMES[out.zone], amount: out.amount, impactSpeed });
      if (out.tireBurst >= 0) {
        this.applyTyreRadii();
        bus?.emit('vehicle:tireBurst', { eid: this.eid, wheel: out.tireBurst });
      }
      if (out.engineFailedNow) bus?.emit('vehicle:engineFailed', { eid: this.eid });
    }

    if (this.stallS > 0) this.stallS = Math.max(0, this.stallS - dt);
    if (this.engineRunning()) {
      const stall = rollStall(damage, model.damage, dt, this.rng);
      if (stall > 0) {
        this.stallS = stall;
        bus?.emit('vehicle:engineStalled', { eid: this.eid });
      } else {
        this.fuelL = Math.max(0, this.fuelL - fuelBurnLiters(this.engineKw, dt, model.fuel));
        if (this.fuelL === 0 && !this.fuelEmptySent) {
          this.fuelEmptySent = true;
          bus?.emit('vehicle:fuelEmpty', { eid: this.eid });
        }
      }
    }

    for (let axle = 0; axle < 2; axle++) {
      const energyKJ = (((this.brakeImpulse[axle * 2] ?? 0) + (this.brakeImpulse[axle * 2 + 1] ?? 0)) * absSpeed) / 1000;
      this.brakeTemp[axle] = updateBrakeTemp(this.brakeTemp[axle] ?? 0, energyKJ, absSpeed, this.ambientC, dt, model.brakes);
    }

    this.updateGear(absSpeed);
    this.refreshTelemetry(speed, Math.hypot(v.x, v.z));
    this.writeLook();
  }

  /** Chassis-local pose of wheel `i` (FL, FR, RL, RR) for rendering. */
  wheelPose(i: number, out: WheelPose): WheelPose {
    const ctl = this.controller;
    out.x = this.wheelX[i] ?? 0;
    out.y = this.hardPointY - (ctl.wheelSuspensionLength(i) ?? this.model.suspension.restLength);
    out.z = this.wheelZ[i] ?? 0;
    out.steer = i < 2 ? -this.steerAngle : 0;
    out.spin = -(ctl.wheelRotation(i) ?? 0);
    out.radius = ctl.wheelRadius(i) ?? this.model.tires.radius;
    out.inContact = ctl.wheelIsInContact(i);
    return out;
  }

  /** Adds `liters` (default: fills the tank). */
  refuel(liters?: number): void {
    this.fuelL = clamp(this.fuelL + (liters ?? this.model.fuel.capacityL), 0, this.model.fuel.capacityL);
    if (this.fuelL > 0) this.fuelEmptySent = false;
    this.tel.fuelL = this.fuelL;
    this.tel.fuelFraction = this.fuelL / this.model.fuel.capacityL;
  }

  /** True when `repair()` would change anything: body damage, a worn or failed engine, a flat tyre or a stall. */
  get needsRepair(): boolean {
    const d = this.damage;
    if (d.engineHealth < 1 || d.engineFailed || this.stallS > 0) return true;
    for (let i = 0; i < WHEELS; i++) if ((d.zones[i] ?? 0) > 0 || d.tireFlat[i] === 1) return true;
    return false;
  }

  /** Restores body, engine and tyres (debug command / station pump, see `GameSession.interact`). */
  repair(): void {
    resetDamageState(this.damage);
    this.stallS = 0;
    this.applyTyreRadii();
    this.writeLook();
  }

  serialize(): SerializedVehicle {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const d = this.damage;
    return {
      modelId: this.model.id,
      x: t.x,
      y: t.y,
      z: t.z,
      qx: r.x,
      qy: r.y,
      qz: r.z,
      qw: r.w,
      vx: lv.x,
      vy: lv.y,
      vz: lv.z,
      wx: av.x,
      wy: av.y,
      wz: av.z,
      fuelL: this.fuelL,
      brakeTempC: [this.brakeTemp[0] ?? 0, this.brakeTemp[1] ?? 0],
      zones: [d.zones[0] ?? 0, d.zones[1] ?? 0, d.zones[2] ?? 0, d.zones[3] ?? 0],
      engineHealth: d.engineHealth,
      engineFailed: d.engineFailed,
      tireFlat: [d.tireFlat[0] === 1, d.tireFlat[1] === 1, d.tireFlat[2] === 1, d.tireFlat[3] === 1],
      headlights: this.headlights,
      lightbar: this.lightbar,
      reversing: this.controls.reverse,
      sim: {
        steerAngle: this.steerAngle,
        gear: this.gear,
        stallS: this.stallS,
        absTime: this.absTime,
        wheelLoad: [this.wheelLoad[0] ?? 0, this.wheelLoad[1] ?? 0, this.wheelLoad[2] ?? 0, this.wheelLoad[3] ?? 0],
      },
    };
  }

  /** Removes the controller, body and collider (skipped when the physics world is already disposed). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.physics.isDisposed) return;
    this.physics.raw.removeVehicleController(this.controller);
    this.physics.removeBody(this.eid);
  }

  private refreshTelemetry(speed: number, groundSpeed: number): void {
    const { model, controls: c, damage, tel } = this;
    const absSpeed = Math.abs(speed);
    const running = this.engineRunning();
    tel.speed = speed;
    tel.speedKmh = speed * 3.6;
    tel.speedMph = speed / MPH;
    tel.groundSpeed = groundSpeed;
    tel.gear = c.reverse ? -1 : this.gear;
    tel.rpm = running ? clamp(this.rpmAt(c.reverse ? 1 : this.gear, absSpeed), model.engine.idleRpm, model.engine.redlineRpm) : 0;
    tel.throttle = c.throttle;
    tel.brake = c.brake;
    tel.steer = this.steerAngle / (model.steering.maxAngleDeg * (Math.PI / 180));
    tel.absActive = this.absActive;
    tel.handbrake = c.handbrake;
    tel.fuelL = this.fuelL;
    tel.fuelFraction = this.fuelL / model.fuel.capacityL;
    tel.engineRunning = running;
    tel.engineHealth = damage.engineHealth;
    const front = this.brakeTemp[0] ?? 0;
    const rear = this.brakeTemp[1] ?? 0;
    tel.brakeTempC = Math.max(front, rear);
    tel.brakeEfficiency = Math.min(brakeEfficiency(front, model.brakes), brakeEfficiency(rear, model.brakes));
    const { telFlat: flats, telZones: zones, telSurface: surfaces } = this;
    let contact = false;
    for (let i = 0; i < WHEELS; i++) {
      flats[i] = damage.tireFlat[i] === 1;
      zones[i] = damage.zones[i] ?? 0;
      surfaces[i] = this.wheelSurface[i] ?? 0;
      if (this.controller.wheelIsInContact(i)) contact = true;
    }
    tel.airborne = !contact;
  }

  private engineRunning(): boolean {
    return this.engineOn && this.fuelL > 0 && !this.damage.engineFailed && this.stallS <= 0;
  }

  private rpmAt(gear: number, absSpeed: number): number {
    const e = this.model.engine;
    const ratio = e.gearRatios[gear - 1] ?? e.gearRatios[0] ?? 1;
    return (absSpeed / (2 * Math.PI * this.model.tires.radius)) * 60 * ratio * e.finalDrive;
  }

  private updateGear(absSpeed: number): void {
    const e = this.model.engine;
    while (this.gear < e.gearRatios.length && this.rpmAt(this.gear, absSpeed) > UPSHIFT * e.redlineRpm) this.gear++;
    while (this.gear > 1 && this.rpmAt(this.gear - 1, absSpeed) < DOWNSHIFT * e.redlineRpm) this.gear--;
  }

  private applyTyreRadii(): void {
    for (let i = 0; i < WHEELS; i++) {
      this.controller.setWheelRadius(i, this.model.tires.radius * (this.damage.tireFlat[i] === 1 ? FLAT_RADIUS : 1));
    }
  }

  private writeLook(): void {
    const c = this.controls;
    let lights = 0;
    if (this.headlights) lights |= LIGHT.head;
    if (c.brake > BRAKE_PEDAL_LIGHT) lights |= LIGHT.brake;
    if (c.reverse) lights |= LIGHT.reverse;
    if (this.damage.engineFailed) lights |= LIGHT.hazard;
    if (this.lightbar && this.model.lightbar) lights |= LIGHT.lightbar;
    VehicleLook.lights[this.eid] = lights;
    const base = this.eid * 4;
    for (let z = 0; z < 4; z++) VehicleLook.damage[base + z] = this.damage.zones[z] ?? 0;
  }
}
