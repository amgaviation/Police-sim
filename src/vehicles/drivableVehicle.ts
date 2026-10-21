import RAPIER, {
  type Collider,
  type DynamicRayCastVehicleController,
  type KinematicCharacterController,
  type RigidBody,
} from '@dimforge/rapier3d-compat';
import type { EntityId } from 'bitecs';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { PhysicsWorld, Vec3 } from '../physics/physics';
import { absModulate, brakeEfficiency, updateBrakeTemp, type AbsResult } from './brakes';
import { LIGHT, VehicleLook } from './components';
import type { DriverControls } from './controls';
import { createCraftState, stepCraft, type CraftEnv, type CraftInput, type CraftKind, type CraftState, type CraftStep } from './craft';
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
import { damageSpecFor, isCraft, restHeight, vehicleModel, type ControlKind, type DamageSpec, type VehicleModel } from './model';
import { surfaceGrip, surfaceRolling } from './surfaces';
import { createWearState, stepWear, treadGrip, type WearInputs, type WearState } from './wear';

/** What the vehicle needs from the world each step (injected; the integrator adapts city + environment). */
export interface VehicleEnvironment {
  /** Surface id (`SURFACE_NAMES` index) at a world x, z. */
  surfaceAt(x: number, z: number): number;
  /** 0..1 road wetness and snow cover. */
  wetness: number;
  snowCover: number;
  ambientC: number;
  /** Boats only: true where there is water at a world x, z (default: nowhere, the boat is not confined). */
  isWater?(x: number, z: number): boolean;
  /** Water surface height (default -0.05) and ground height under crafts (default 0). */
  waterY?: number;
  groundY?: number;
  /** Drone leash anchor (default: the craft's own position, i.e. no leash). */
  anchorX?: number;
  anchorZ?: number;
}

/** Spawn-time build options (from the livery's equipment section). */
export interface VehicleBuild {
  pushBar: boolean;
}

/** Snapshot of a vehicle's maintainable state (allocation-free when `out` is passed to `condition`). */
export interface VehicleCondition {
  modelId: string;
  fuelFraction: number;
  fuelL: number;
  /** oilL / wear.oilL, 0..1. */
  oilFraction: number;
  /** 0..1 per wheel FL FR RL RR. */
  tread: [number, number, number, number];
  flats: [boolean, boolean, boolean, boolean];
  /** 0..1 front rear left right. */
  zones: [number, number, number, number];
  engineHealth: number;
  engineFailed: boolean;
  odometerKm: number;
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
  /** Oil level 0..1 and the lowest tyre tread 0..1. */
  oilFraction: number;
  treadMin: number;
  odometerKm: number;
  /** Crafts: height above the floor (0 for boats and cars). */
  altitudeM: number;
  /** Two-wheeler visual lean (rad, + = leaning right). */
  lean: number;
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
  /** Oil, tyre tread and odometer; absent (old saves) = full oil, new tyres, 0 m. */
  wear?: { oilL: number; tread: [number, number, number, number]; odometerM: number };
  /** Kinematic crafts only: the integrator state; absent = at rest with the yaw of the quaternion. */
  craft?: { speed: number; vy: number; yaw: number; pitch: number; roll: number };
  /** Push bumper built on; absent = the model's own. */
  pushBar?: boolean;
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
const CHARACTER_FILTER = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
/** Craft character-controller skin (m) and the slack (m) a blocked move must exceed to count as a hit. */
const CRAFT_OFFSET = 0.02;
const BLOCKED_SLACK = 0.01;
/** Vertical landing speed (m/s) from which a helicopter or drone is damaged. */
const HARD_LANDING = 4;
/** Altitude (m) above the floor from which a craft counts as airborne. */
const AIRBORNE_ALTITUDE = 0.3;
/** Slip speed (m/s) above which the handbrake locks a rear wheel into a slide. */
const HANDBRAKE_SLIP_SPEED = 3;
/**
 * Share of the front-tip braking limit (`g x wheelbase / 2 / comHeight`) that the service brakes may use: short, tall
 * vehicles (ATV, bicycle) would otherwise pitch over their front wheel when braking hard.
 */
const TIP_BRAKE_SHARE = 0.8;
/** Water surface height used when the environment gives none. */
const DEFAULT_WATER_Y = -0.05;

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
  /** `model.control`. */
  readonly control: ControlKind;
  /** The push bumper is built on (front hits use the bumper's strength). */
  readonly pushBar: boolean;
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
  /** Ray-cast chassis of cars and bikes; null for crafts. */
  private readonly controller: DynamicRayCastVehicleController | null;
  /** Craft collision resolution; null for cars and bikes. */
  private readonly character: KinematicCharacterController | null;
  private readonly collider: Collider;
  private readonly damageSpec: DamageSpec;
  private readonly rng: Rng;
  private readonly tel: VehicleTelemetry;
  private readonly telFlat: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  private readonly telZones: [number, number, number, number] = [0, 0, 0, 0];
  private readonly telSurface: [number, number, number, number] = [0, 0, 0, 0];
  private readonly controls: DriverControls = { throttle: 0, brake: 0, steer: 0, handbrake: false, reverse: false, lift: 0 };
  private readonly damage = createDamageState();
  private readonly wear: WearState;
  private readonly wearIn: WearInputs;
  /** Wheels that slipped this step (locked or sliding under the handbrake), for tyre wear. */
  private readonly slip = new Uint8Array(WHEELS);
  /** Visual lean of a two-wheeler (rad, + = right). */
  private lean = 0;
  /** Bicycle: the engine always runs and never burns fuel. */
  private readonly pedal: boolean;
  /** 1, or less for a vehicle whose brakes could pitch it over the front wheel (see `TIP_BRAKE_SHARE`). */
  private readonly brakeScale: number;
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
  private readonly w: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly torque: Vec3 = { x: 0, y: 0, z: 0 };
  // Craft integrator scratch.
  private readonly craftKind: CraftKind | null;
  private readonly craftState: CraftState = createCraftState(0, 0, 0, 0);
  private readonly craftInput: CraftInput = { forward: 0, steer: 0, lift: 0 };
  private readonly craftEnv: CraftEnv = { groundY: 0, waterY: 0, engineOk: true, anchorX: 0, anchorZ: 0 };
  private readonly craftOut: CraftStep = { dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0, landed: true };
  private readonly desired: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly moved: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly nextRot: Quat = { x: 0, y: 0, z: 0, w: 1 };
  /** Height of the body centre above the floor / water at rest. */
  private readonly clearance: number;
  private craftGroundY = 0;
  /** Engine load 0..1 of the craft's last step (drives fuel burn and rpm). */
  private craftLoad = 0;
  /** Impact of the craft's last step, reported by `postStep` (speed 0 = none). */
  private pendingSpeed = 0;
  private pendingAmount = 0;
  private pendingEngineFail = false;

  private constructor(
    physics: PhysicsWorld,
    eid: EntityId,
    model: VehicleModel,
    position: Vec3,
    rotation: Quat,
    rng: Rng,
    build: VehicleBuild,
  ) {
    this.physics = physics;
    this.eid = eid;
    this.model = model;
    this.control = model.control;
    this.pedal = model.bike?.pedal === true;
    const tipDecel = (TIP_BRAKE_SHARE * GRAVITY * (model.body.wheelbase / 2)) / Math.max(model.comHeight, 0.01);
    this.brakeScale = Math.min(1, tipDecel / (model.brakes.maxForce / model.mass));
    this.pushBar = build.pushBar && model.equipment?.pushBumper != null;
    this.damageSpec = damageSpecFor(model, this.pushBar);
    this.rng = rng;
    this.fuelL = model.fuel.capacityL;
    this.brakeTemp.fill(DEFAULT_AMBIENT_C);
    this.staticLoad = (model.mass * GRAVITY) / WHEELS;
    this.wheelLoad.fill(this.staticLoad);
    this.dragK = dragCoefficient(model);
    this.wear = createWearState(model.wear);
    this.wearIn = { engineKw: 0, dt: 0, distanceM: 0, running: false, slipping: this.slip };
    this.clearance = restHeight(model);

    const { body: dims, suspension: susp, tires } = model;
    const raw = physics.raw;
    if (isCraft(model)) {
      this.craftKind = model.control as CraftKind;
      this.body = raw.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(position.x, position.y, position.z)
          .setRotation(rotation)
          .setCanSleep(false),
      );
      this.collider = raw.createCollider(
        RAPIER.ColliderDesc.cuboid(dims.width / 2, dims.height / 2, dims.length / 2).setActiveEvents(
          RAPIER.ActiveEvents.COLLISION_EVENTS,
        ),
        this.body,
      );
      this.colliderHandle = this.collider.handle;
      physics.registerBody(eid, this.body);
      this.notOwnChassis = (c) => c.handle !== this.colliderHandle && !physics.isGround(c.handle);
      const character = raw.createCharacterController(CRAFT_OFFSET);
      character.disableSnapToGround();
      character.setSlideEnabled(true);
      character.setApplyImpulsesToDynamicBodies(false);
      this.character = character;
      this.controller = null;
      this.hardPointY = 0;
      for (let i = 0; i < WHEELS; i++) {
        this.wheelX[i] = (i % 2 === 0 ? -1 : 1) * (dims.track / 2);
        this.wheelZ[i] = (i < 2 ? -1 : 1) * (dims.wheelbase / 2);
      }
      this.drivenCount = 0;
      this.tel = this.makeTelemetry();
      this.telemetry = this.tel;
      return;
    }
    this.craftKind = null;
    this.character = null;
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
    this.collider = collider;
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
    this.tel = this.makeTelemetry();
    this.telemetry = this.tel;
  }

  private makeTelemetry(): VehicleTelemetry {
    return {
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
      oilFraction: 1,
      treadMin: 1,
      odometerKm: 0,
      altitudeM: 0,
      lean: 0,
    };
  }

  /** Builds the chassis, collider and controller and registers the body for `eid`. */
  static create(
    physics: PhysicsWorld,
    eid: EntityId,
    model: VehicleModel,
    pose: VehiclePose,
    rng: Rng,
    build: VehicleBuild = { pushBar: model.equipment?.pushBumper != null },
  ): DrivableVehicle {
    const half = pose.yaw / 2;
    const v = new DrivableVehicle(physics, eid, model, pose, { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, rng, build);
    if (v.craftKind !== null) {
      v.craftState.x = pose.x;
      v.craftState.y = pose.y;
      v.craftState.z = pose.z;
      v.craftState.yaw = pose.yaw;
      v.refreshTelemetry(0, 0);
      v.writeLook();
    }
    return v;
  }

  /**
   * Rebuilds a vehicle from `serialize()` output; `rng` should be the same stream the original used. `build` defaults
   * to the saved `pushBar` (the model's own when absent).
   */
  static restore(physics: PhysicsWorld, eid: EntityId, data: SerializedVehicle, rng: Rng, build?: VehicleBuild): DrivableVehicle {
    const model = vehicleModel(data.modelId);
    const v = new DrivableVehicle(
      physics,
      eid,
      model,
      { x: data.x, y: data.y, z: data.z },
      { x: data.qx, y: data.qy, z: data.qz, w: data.qw },
      rng,
      build ?? { pushBar: data.pushBar ?? model.equipment?.pushBumper != null },
    );
    if (v.craftKind === null) {
      v.body.setLinvel({ x: data.vx, y: data.vy, z: data.vz }, true);
      v.body.setAngvel({ x: data.wx, y: data.wy, z: data.wz }, true);
    }
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
    if (data.wear) {
      v.wear.oilL = clamp(data.wear.oilL, 0, model.wear.oilL);
      for (let i = 0; i < WHEELS; i++) v.wear.tread[i] = clamp(data.wear.tread[i] ?? 1, 0, 1);
      v.wear.odometerM = Math.max(0, data.wear.odometerM);
    }
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
    if (v.craftKind !== null) {
      const cs = v.craftState;
      cs.x = data.x;
      cs.y = data.y;
      cs.z = data.z;
      cs.yaw = data.craft?.yaw ?? Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz));
      cs.speed = data.craft?.speed ?? 0;
      cs.vy = data.craft?.vy ?? 0;
      cs.pitch = data.craft?.pitch ?? 0;
      cs.roll = data.craft?.roll ?? 0;
      v.refreshTelemetry(cs.speed, Math.abs(cs.speed));
      v.writeLook();
      return v;
    }
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
    c.lift = clamp(controls.lift ?? 0, -1, 1);
  }

  /** Sets steering, drive, brakes and per-wheel grip, then runs the controller. Call before `physics.step()`. */
  preStep(dt: number, env: VehicleEnvironment): void {
    const { model, controls: c, controller: ctl } = this;
    if (ctl === null) {
      this.preStepCraft(dt, env);
      return;
    }
    const v = this.body.linvel(this.v);
    const { x: qx, y: qy, z: qz, w: qw } = this.body.rotation(this.q);
    const p = this.body.translation(this.p);
    // Chassis basis columns (x/z parts): right = local +X, up = local +Y, back = local +Z.
    const rx = 1 - 2 * (qy * qy + qz * qz);
    const ry = 2 * (qx * qy + qw * qz);
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
      const mu = tires.frictionSlip * grip * loadFactor * (flat ? FLAT_GRIP : 1) * treadGrip(this.wear.tread[i] ?? 1, env.wetness, model.wear);
      const limit = mu * load * dt;

      let demand = c.brake * brakes.maxForce * this.brakeScale * (front ? brakes.frontBias : 1 - brakes.frontBias) * 0.5 * (front ? frontEff : rearEff);
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
      this.slip[i] = locked || (handbrake && absSpeed > HANDBRAKE_SLIP_SPEED) ? 1 : 0;

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
    if (model.bike !== null) this.uprightAssist(model.bike.uprightStiffness, model.bike.uprightDamping, ry, bx, by, bz, dt);
    // Velocity with the vehicle's own impulses applied: what the physics step changes beyond gravity is impact.
    this.body.linvel(v);
    this.vPreX = v.x;
    this.vPreZ = v.z;
  }

  /** Impacts and damage, engine, fuel, brake temperature, telemetry and `VehicleLook`. Call after `physics.step()`. */
  postStep(dt: number, bus?: EventBus<EventMap>): void {
    if (this.character !== null) {
      this.postStepCraft(dt, bus);
      return;
    }
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
    if (impactSpeed >= this.damageSpec.minImpactSpeed) {
      // The hit comes from the opposite of the velocity change, in chassis axes.
      const hx = -(dvx * rx + dvz * rz);
      const hz = -(dvx * bx + dvz * bz);
      const out = applyImpact(damage, hx, hz, impactSpeed, cornerWheel(hx, hz), this.damageSpec, this.rng, this.impact);
      bus?.emit('vehicle:damaged', { eid: this.eid, zone: ZONE_NAMES[out.zone], amount: out.amount, impactSpeed });
      if (out.tireBurst >= 0) {
        this.applyTyreRadii();
        bus?.emit('vehicle:tireBurst', { eid: this.eid, wheel: out.tireBurst });
      }
      if (out.engineFailedNow) bus?.emit('vehicle:engineFailed', { eid: this.eid });
    }

    if (this.stallS > 0) this.stallS = Math.max(0, this.stallS - dt);
    if (this.engineRunning() && !this.pedal) {
      const stall = rollStall(damage, this.damageSpec, dt, this.rng);
      if (stall > 0) {
        this.stallS = stall;
        bus?.emit('vehicle:engineStalled', { eid: this.eid });
      } else {
        this.burnFuel(dt, bus);
      }
    }
    this.wearStep(dt, absSpeed * dt, this.engineKw, bus);

    for (let axle = 0; axle < 2; axle++) {
      const energyKJ = (((this.brakeImpulse[axle * 2] ?? 0) + (this.brakeImpulse[axle * 2 + 1] ?? 0)) * absSpeed) / 1000;
      this.brakeTemp[axle] = updateBrakeTemp(this.brakeTemp[axle] ?? 0, energyKJ, absSpeed, this.ambientC, dt, model.brakes);
    }

    const bike = model.bike;
    if (bike !== null) {
      // Lean into the turn: tan(lean) = v² tan(steer) / (wheelbase g), + = right.
      const maxLean = bike.maxLeanDeg * (Math.PI / 180);
      this.lean = clamp(Math.atan((speed * speed * Math.tan(this.steerAngle)) / (model.body.wheelbase * GRAVITY)), -maxLean, maxLean);
    }
    this.updateGear(absSpeed);
    this.refreshTelemetry(speed, Math.hypot(v.x, v.z));
    this.writeLook();
  }

  /** Burns fuel for one step of a running engine and reports an empty tank once. */
  private burnFuel(dt: number, bus?: EventBus<EventMap>): void {
    this.fuelL = Math.max(0, this.fuelL - fuelBurnLiters(this.engineKw, dt, this.model.fuel));
    if (this.fuelL === 0 && !this.fuelEmptySent) {
      this.fuelEmptySent = true;
      bus?.emit('vehicle:fuelEmpty', { eid: this.eid });
    }
  }

  /** Oil, tread and odometer for one step; an engine running on empty oil loses health and may fail. */
  private wearStep(dt: number, distanceM: number, engineKw: number, bus?: EventBus<EventMap>): void {
    const wi = this.wearIn;
    wi.engineKw = engineKw;
    wi.dt = dt;
    wi.distanceM = distanceM;
    wi.running = this.engineRunning();
    const engineWear = stepWear(this.wear, this.model.wear, wi);
    if (engineWear <= 0) return;
    const d = this.damage;
    d.engineHealth = Math.max(0, d.engineHealth - engineWear);
    if (!d.engineFailed && d.engineHealth < this.damageSpec.failBelow) {
      d.engineFailed = true;
      bus?.emit('vehicle:engineFailed', { eid: this.eid });
    }
  }

  /**
   * Bike upright assist: a torque impulse about the forward axis `f` = (-bx, -by, -bz) that rolls the chassis back
   * to vertical. `ry` is the y of the chassis right vector (+ = right side up), so a positive torque about `f`
   * (right side down) restores it; the angular velocity about `f` is damped.
   */
  private uprightAssist(stiffness: number, damping: number, ry: number, bx: number, by: number, bz: number, dt: number): void {
    const phi = Math.asin(clamp(ry, -1, 1));
    const av = this.body.angvel(this.w);
    const omega = -(av.x * bx + av.y * by + av.z * bz);
    const tau = (stiffness * phi - damping * omega) * this.model.mass * dt;
    const t = this.torque;
    t.x = -bx * tau;
    t.y = -by * tau;
    t.z = -bz * tau;
    this.body.applyTorqueImpulse(t, true);
  }

  /** Records a craft impact of `speed` m/s on the front zone; `postStep` reports it. */
  private craftImpact(speed: number): void {
    const out = applyImpact(this.damage, 0, -1, speed, -1, this.damageSpec, this.rng, this.impact);
    if (out.amount <= 0) return;
    if (speed > this.pendingSpeed) this.pendingSpeed = speed;
    this.pendingAmount += out.amount;
    if (out.engineFailedNow) this.pendingEngineFail = true;
  }

  /**
   * Boat, helicopter or drone: the pure integrator (`stepCraft`) gives the wanted move, the character controller
   * slides it along buildings, and the kinematic body is moved to the result.
   */
  private preStepCraft(dt: number, env: VehicleEnvironment): void {
    const { model, character, craftKind: kind, controls: c, craftState: cs, craftInput: ci, craftEnv: ce, craftOut: out } = this;
    const spec = model.craft;
    if (character === null || kind === null || spec === null) return;
    const p = this.body.translation(this.p);
    cs.x = p.x;
    cs.y = p.y;
    cs.z = p.z;
    const engineOk = this.engineRunning();
    this.craftGroundY = env.groundY ?? 0;
    ce.groundY = this.craftGroundY;
    ce.waterY = env.waterY ?? DEFAULT_WATER_Y;
    ce.engineOk = engineOk;
    ce.anchorX = env.anchorX ?? cs.x;
    ce.anchorZ = env.anchorZ ?? cs.z;
    ci.forward = c.reverse ? -c.throttle : c.throttle - c.brake;
    ci.steer = c.steer;
    ci.lift = c.lift ?? 0;
    const vyBefore = cs.vy;
    stepCraft(kind, spec, this.clearance, cs, ci, dt, ce, out);

    if (kind === 'boat' && env.isWater !== undefined && !env.isWater(cs.x + out.dx, cs.z + out.dz)) {
      out.dx = 0;
      out.dz = 0;
      cs.speed = 0;
    }
    const desired = this.desired;
    desired.x = out.dx;
    desired.y = out.dy;
    desired.z = out.dz;
    character.computeColliderMovement(this.collider, desired, CHARACTER_FILTER, undefined, this.notOwnChassis);
    const mv = character.computedMovement(this.moved);
    if (character.numComputedCollisions() > 0 && Math.hypot(out.dx, out.dz) >= Math.hypot(mv.x, mv.z) + BLOCKED_SLACK) {
      // Blocked by a building or a vehicle: front-zone damage at the speed it was going, then stop.
      const hit = Math.abs(cs.speed);
      if (hit >= this.damageSpec.minImpactSpeed) this.craftImpact(hit);
      cs.speed = 0;
    }
    if (out.landed && kind !== 'boat' && vyBefore < -HARD_LANDING) this.craftImpact(-vyBefore);

    // Engine load: boat by throttle, helicopter by lift and throttle (idle on the ground), drone constant.
    let load = 0.5;
    if (kind === 'boat') load = Math.abs(ci.forward);
    else if (kind === 'helicopter') load = out.landed ? 0.15 : 0.5 + 0.5 * Math.max(Math.abs(ci.forward), Math.max(ci.lift, 0));
    this.craftLoad = engineOk ? load : 0;
    this.engineKw = model.engine.maxPowerKw * this.craftLoad;

    mv.x += p.x;
    mv.y += p.y;
    mv.z += p.z;
    cs.x = mv.x;
    cs.y = mv.y;
    cs.z = mv.z;
    this.body.setNextKinematicTranslation(mv);
    // Orientation: yaw about Y, then pitch about X, then roll about Z (q = qy * qx * qz).
    const sy = Math.sin(out.yaw / 2);
    const cy = Math.cos(out.yaw / 2);
    const sx = Math.sin(out.pitch / 2);
    const cx = Math.cos(out.pitch / 2);
    const sz = Math.sin(out.roll / 2);
    const cz = Math.cos(out.roll / 2);
    const x1 = cy * sx;
    const y1 = sy * cx;
    const z1 = -sy * sx;
    const w1 = cy * cx;
    const q = this.nextRot;
    q.x = x1 * cz + y1 * sz;
    q.y = -x1 * sz + y1 * cz;
    q.z = w1 * sz + z1 * cz;
    q.w = w1 * cz - z1 * sz;
    this.body.setNextKinematicRotation(q);
  }

  /** Craft impacts, fuel, oil, odometer, telemetry and `VehicleLook`. */
  private postStepCraft(dt: number, bus?: EventBus<EventMap>): void {
    const cs = this.craftState;
    if (this.pendingSpeed > 0) {
      bus?.emit('vehicle:damaged', {
        eid: this.eid,
        zone: ZONE_NAMES[ZONE.front],
        amount: this.pendingAmount,
        impactSpeed: this.pendingSpeed,
      });
      if (this.pendingEngineFail) bus?.emit('vehicle:engineFailed', { eid: this.eid });
      this.pendingSpeed = 0;
      this.pendingAmount = 0;
      this.pendingEngineFail = false;
    }
    if (this.engineRunning()) this.burnFuel(dt, bus);
    // The drone has no oil; tyres are not used by crafts (distance only counts on the odometer).
    this.wearStep(dt, 0, this.craftKind === 'drone' ? 0 : this.engineKw, bus);
    this.wear.odometerM += Math.abs(cs.speed) * dt;
    this.refreshTelemetry(cs.speed, Math.abs(cs.speed));
    this.writeLook();
  }

  /** Chassis-local pose of wheel `i` (FL, FR, RL, RR) for rendering. */
  wheelPose(i: number, out: WheelPose): WheelPose {
    const ctl = this.controller;
    if (ctl === null) {
      // Crafts draw no wheels: a static hub.
      out.x = this.wheelX[i] ?? 0;
      out.y = this.model.tires.radius - this.clearance;
      out.z = this.wheelZ[i] ?? 0;
      out.steer = 0;
      out.spin = 0;
      out.radius = this.model.tires.radius;
      out.inContact = false;
      return out;
    }
    out.x = this.wheelX[i] ?? 0;
    out.y = this.hardPointY - (ctl.wheelSuspensionLength(i) ?? this.model.suspension.restLength);
    out.z = this.wheelZ[i] ?? 0;
    out.steer = i < 2 ? -this.steerAngle : 0;
    out.spin = -(ctl.wheelRotation(i) ?? 0);
    out.radius = ctl.wheelRadius(i) ?? this.model.tires.radius;
    out.inContact = ctl.wheelIsInContact(i);
    return out;
  }

  /**
   * Bursts tyre `wheel` (0 FL, 1 FR, 2 RL, 3 RR) as a Phase 1 impact burst does (`damage.tireFlat`, smaller radius,
   * lower grip), emitting 'vehicle:tireBurst' on `bus`. False when the tyre is already flat or `wheel` is not 0..3.
   */
  burstTire(wheel: number, bus?: EventBus<EventMap>): boolean {
    if (this.controller === null || !Number.isInteger(wheel) || wheel < 0 || wheel >= WHEELS || this.damage.tireFlat[wheel] === 1) return false;
    this.damage.tireFlat[wheel] = 1;
    this.applyTyreRadii();
    bus?.emit('vehicle:tireBurst', { eid: this.eid, wheel });
    return true;
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

  /** Restores body, engine and tyres (debug command / station pump, see `GameSession.interact`). Oil and tread are untouched. */
  repair(): void {
    resetDamageState(this.damage);
    this.stallS = 0;
    this.applyTyreRadii();
    this.writeLook();
  }

  /** Oil change: oil back to capacity. */
  changeOil(): void {
    this.wear.oilL = this.model.wear.oilL;
    this.tel.oilFraction = 1;
  }

  /** New tyres on `wheels` (default all four): tread 1, flat cleared, radius restored. */
  replaceTires(wheels?: readonly number[]): void {
    if (wheels === undefined) {
      this.wear.tread.fill(1);
      this.damage.tireFlat.fill(0);
    } else {
      for (const w of wheels) {
        if (!Number.isInteger(w) || w < 0 || w >= WHEELS) continue;
        this.wear.tread[w] = 1;
        this.damage.tireFlat[w] = 0;
      }
    }
    this.applyTyreRadii();
    this.tel.treadMin = this.treadMin();
    for (let i = 0; i < WHEELS; i++) this.telFlat[i] = this.damage.tireFlat[i] === 1;
  }

  /** Body zones and engine (health 1, not failed, no stall); keeps tyres, oil and fuel. */
  repairBody(): void {
    const d = this.damage;
    d.zones.fill(0);
    d.engineHealth = 1;
    d.engineFailed = false;
    this.stallS = 0;
    this.writeLook();
  }

  /** Fills `out` (or a new object) with the maintainable state. */
  condition(out?: VehicleCondition): VehicleCondition {
    const c =
      out ??
      ({
        modelId: '',
        fuelFraction: 0,
        fuelL: 0,
        oilFraction: 0,
        tread: [0, 0, 0, 0],
        flats: [false, false, false, false],
        zones: [0, 0, 0, 0],
        engineHealth: 0,
        engineFailed: false,
        odometerKm: 0,
      } satisfies VehicleCondition);
    const d = this.damage;
    c.modelId = this.model.id;
    c.fuelL = this.fuelL;
    c.fuelFraction = this.fuelL / this.model.fuel.capacityL;
    c.oilFraction = this.wear.oilL / this.model.wear.oilL;
    for (let i = 0; i < WHEELS; i++) {
      c.tread[i] = this.wear.tread[i] ?? 1;
      c.flats[i] = d.tireFlat[i] === 1;
      c.zones[i] = d.zones[i] ?? 0;
    }
    c.engineHealth = d.engineHealth;
    c.engineFailed = d.engineFailed;
    c.odometerKm = this.wear.odometerM / 1000;
    return c;
  }

  serialize(): SerializedVehicle {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const d = this.damage;
    const cs = this.craftState;
    const craft = this.craftKind !== null;
    return {
      modelId: this.model.id,
      x: t.x,
      y: t.y,
      z: t.z,
      qx: r.x,
      qy: r.y,
      qz: r.z,
      qw: r.w,
      // A kinematic craft reports its own velocity (the body has none the simulation owns).
      vx: craft ? -Math.sin(cs.yaw) * cs.speed : lv.x,
      vy: craft ? cs.vy : lv.y,
      vz: craft ? -Math.cos(cs.yaw) * cs.speed : lv.z,
      wx: craft ? 0 : av.x,
      wy: craft ? 0 : av.y,
      wz: craft ? 0 : av.z,
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
      wear: {
        oilL: this.wear.oilL,
        tread: [this.wear.tread[0] ?? 1, this.wear.tread[1] ?? 1, this.wear.tread[2] ?? 1, this.wear.tread[3] ?? 1],
        odometerM: this.wear.odometerM,
      },
      ...(craft ? { craft: { speed: cs.speed, vy: cs.vy, yaw: cs.yaw, pitch: cs.pitch, roll: cs.roll } } : {}),
      pushBar: this.pushBar,
    };
  }

  /** Removes the controller, body and collider (skipped when the physics world is already disposed). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.physics.isDisposed) return;
    if (this.controller !== null) this.physics.raw.removeVehicleController(this.controller);
    if (this.character !== null) this.physics.raw.removeCharacterController(this.character);
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
    const e = model.engine;
    if (this.craftKind !== null) {
      tel.gear = 1;
      tel.rpm = running ? e.idleRpm + (e.redlineRpm - e.idleRpm) * this.craftLoad : 0;
      tel.steer = c.steer;
    } else {
      tel.gear = c.reverse ? -1 : this.gear;
      tel.rpm = running ? clamp(this.rpmAt(c.reverse ? 1 : this.gear, absSpeed), e.idleRpm, e.redlineRpm) : 0;
      tel.steer = this.steerAngle / (model.steering.maxAngleDeg * (Math.PI / 180));
    }
    tel.throttle = c.throttle;
    tel.brake = c.brake;
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
      if (this.controller?.wheelIsInContact(i) === true) contact = true;
    }
    if (this.craftKind === null) {
      tel.airborne = !contact;
      tel.altitudeM = 0;
    } else {
      const altitude = this.craftKind === 'boat' ? 0 : Math.max(0, this.craftState.y - this.craftGroundY - this.clearance);
      tel.altitudeM = altitude;
      tel.airborne = altitude > AIRBORNE_ALTITUDE;
    }
    tel.oilFraction = this.wear.oilL / model.wear.oilL;
    tel.treadMin = this.treadMin();
    tel.odometerKm = this.wear.odometerM / 1000;
    tel.lean = this.lean;
  }

  private treadMin(): number {
    const t = this.wear.tread;
    return Math.min(t[0] ?? 1, t[1] ?? 1, t[2] ?? 1, t[3] ?? 1);
  }

  private engineRunning(): boolean {
    if (this.pedal) return this.engineOn;
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
    const ctl = this.controller;
    if (ctl === null) return;
    for (let i = 0; i < WHEELS; i++) {
      ctl.setWheelRadius(i, this.model.tires.radius * (this.damage.tireFlat[i] === 1 ? FLAT_RADIUS : 1));
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
    VehicleLook.lean[this.eid] = this.lean;
    const rotors = this.craftKind === 'helicopter' || this.craftKind === 'drone';
    VehicleLook.rotor[this.eid] = rotors && this.engineRunning() ? 1 : 0;
  }
}
