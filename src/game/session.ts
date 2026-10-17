import RAPIER, { type Collider, type KinematicCharacterController, type RigidBody } from '@dimforge/rapier3d-compat';
import type { EntityId } from 'bitecs';
import type { EventMap } from '../core/event-map';
import { EventBus } from '../core/events';
import { createRng, normalizeSeed, rngFromState, type Rng } from '../core/rng';
import { GameClock } from '../core/time';
import { EntityKind, KIND, PhysicsBody, Player, PrevTransform, Transform, copyTransformSlot } from '../ecs/components';
import type { System, SystemRegistry } from '../ecs/systems';
import { advanceTime, despawn, spawn, type GameWorld } from '../ecs/world';
import { Environment } from '../environment/environment';
import { PhysicsWorld, type Vec3 } from '../physics/physics';
import { CAMERA_MODE, type VehicleCameraModeId } from '../player/cameraRig';
import type { DriverInput } from '../player/driverInput';
import { EXIT_MAX_SPEED, PLAYER_MODE, PLAYER_MODE_NAMES, PlayerModeMachine, exitPoint, findEnterable } from '../player/mode';
import type { MeshRegistry } from '../render/meshSync';
import type { SaveEnvelope, SaveGame, SavedVehicle, SavedViolations, SerializedEntity } from '../save/schema';
import type { TrafficViolationEvent, TrafficViolationKind } from '../traffic/events';
import { vehicleRecord } from '../traffic/registry';
import { DENSITY } from '../traffic/data';
import { MAX_PARKED_OBSTACLES, TRAFFIC_STATE, TrafficSystem, type TrafficFocus, type TrafficParked } from '../traffic/trafficSystem';
import { VehicleLook, attachDrivable, attachVehicleLook } from '../vehicles/components';
import { mapDriverInput, type DriverControls } from '../vehicles/controls';
import { DrivableVehicle, type VehicleEnvironment, type VehiclePose } from '../vehicles/drivableVehicle';
import { VEHICLE_MODELS, pickModelColor, restHeight, vehicleModel, type VehicleModel } from '../vehicles/model';
import type { City } from '../world/city';
import { WorldColliders } from '../world/colliders';
import { MPH, WORLD_HALF_SIZE, WORLD_WALL } from '../world/constants';
import { LANDMARKS } from '../world/data';
import { generateCity } from '../world/generate';
import { stationLayout } from '../world/stationLayout';
import { PlayerController, moveVelocity, yawFromQuaternion, yawQuaternion, type MoveInput } from './playerController';
import { BOX_SIZE, layoutDropLattice, nextBoxColor } from './sceneLayout';

/** Engine services a session builds its entities into. */
export interface GameContext {
  world: GameWorld;
  physics: PhysicsWorld;
  meshes: MeshRegistry;
  /** Receives vehicle, traffic, environment and player events; the session makes a private bus without one. */
  bus?: EventBus<EventMap>;
  /** The city for this seed when the caller already has it (`generateCity` is pure); generated otherwise. */
  city?: City;
}

/** Rigid-body motion state restored onto a spawned body (saves). */
export interface BodyMotion {
  linvel: Vec3;
  angvel: Vec3;
  sleeping: boolean;
}

/** A fixed-step system and its `SystemRegistry` order (design §13). */
export interface SessionSystem {
  readonly system: System;
  readonly order: number;
}

/** Outcome of `GameSession.interact()`. */
export type InteractResult = 'none' | 'entered' | 'exited' | 'refuelled' | 'repaired' | 'exitBlocked' | 'tooFast';
/** What `interact` would do right now (HUD prompt). */
export type InteractHint = 'enter' | 'exit' | 'refuel' | 'repair' | null;

/** One ambient traffic car for the `traffic list` command. */
export interface TrafficCarRow {
  vehicleId: number;
  plate: string;
  modelId: string;
  distance: number;
  speedMph: number;
  crashed: boolean;
  /** Violations observed this session, by kind. */
  violations: Partial<Record<TrafficViolationKind, number>>;
  /** Registration flags of the record (stolen, expired, uninsured). */
  flags: string[];
}

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface MutableCandidate {
  eid: number;
  x: number;
  z: number;
  yaw: number;
  halfWidth: number;
  halfLength: number;
  speed: number;
}

export const GRAVITY: Vec3 = { x: 0, y: -9.81, z: 0 };
/** The ground slab reaches a little past the world edge. */
export const GROUND_HALF_SIZE = WORLD_HALF_SIZE + 64;
export const PLAYER_SIZE: Vec3 = { x: 0.8, y: 1.8, z: 0.8 };
export const PLAYER_COLOR = 0x1f3b6f;
/** Within this distance (m) of a fuel pump the officer can refuel the last-driven vehicle (and repair it at the station's) ... */
export const REFUEL_PUMP_DISTANCE = 4;
/** ... when that vehicle is within this distance (m) of the pump. */
export const REFUEL_VEHICLE_DISTANCE = 8;
/** `car spawn` places the new vehicle this far ahead of the officer (on foot) or the driven car (m). */
const SPAWN_AHEAD_ON_FOOT = 6;
const SPAWN_AHEAD_DRIVING = 10;
const BOX_HALF: Vec3 = { x: BOX_SIZE / 2, y: BOX_SIZE / 2, z: BOX_SIZE / 2 };
const BOX_FRICTION = 0.8;
/** Lowest box centre of a `spawnRandomBoxes` drop (clears the player). */
const DROP_MIN_Y = 4;
/** Vertical distance kept between the highest existing box centre and a new drop. */
const DROP_CLEARANCE = 2 * BOX_SIZE;
/** Clearance box tested where the officer would stand after getting out (the ground is excluded by its height). */
const EXIT_CLEARANCE_HALF = { x: 0.4, y: 0.8, z: 0.4 };
const EXIT_CLEARANCE_Y = 0.95;
/** Officer radius as a traffic obstacle (m). */
const OFFICER_RADIUS = 0.5;
/** Gap the officer's character controller keeps from a vehicle (m). */
const OFFICER_SKIN = 0.02;
/**
 * The officer's movement is blocked by the static world (buildings, poles, trunks, walls; not the ground
 * slab) and the drivable vehicles; traffic proxies are kinematic and debug boxes get pushed (`blocksOfficer`).
 */
const OFFICER_FILTER = RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
/** Driver's seat in the vehicle frame, as fractions of the body width and length (matches the cockpit eye). */
const SEAT_X = -0.22;
const SEAT_Z = -0.05;
/** An unoccupied vehicle holds its handbrake. */
const PARKED: DriverInput = { accelerate: 0, brake: 0, steer: 0, handbrake: true };

/** Officer placeholder until a later phase has a character setup screen. */
const DEFAULT_OFFICER = { name: 'Officer Doe', badge: '4071' };

const scratchVel: Vec3 = { x: 0, y: 0, z: 0 };
const scratchVec: Vec3 = { x: 0, y: 0, z: 0 };
const scratchQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };
const scratchPoint = { x: 0, z: 0 };

/** Heading (yaw about +Y, 0 = facing -Z) of a rotation's forward axis, ignoring pitch and roll. */
export function headingOf(qx: number, qy: number, qz: number, qw: number): number {
  const fx = -2 * (qw * qy + qz * qx);
  const fz = -1 + 2 * (qx * qx + qy * qy);
  return Math.atan2(-fx, -fz);
}

/**
 * A fresh physics world for one session: gravity plus one ground slab covering the city.
 * Rapier does not return to a pristine state after bodies are removed, so every session
 * needs its own world for the same seed to replay identically. Requires `initRapier()`.
 */
export function createScenePhysics(fixedDt: number): PhysicsWorld {
  const physics = PhysicsWorld.createSync(GRAVITY, fixedDt);
  physics.addGround(GROUND_HALF_SIZE, 0);
  // World boundary: a wall on each side just outside the perimeter roads (chunkLayout draws them).
  const c = WORLD_HALF_SIZE + WORLD_WALL.offset;
  const half = WORLD_HALF_SIZE + WORLD_WALL.offset + WORLD_WALL.halfThickness;
  const h = WORLD_WALL.height / 2;
  for (const [x, z, hx, hz] of [[c, 0, WORLD_WALL.halfThickness, half], [-c, 0, WORLD_WALL.halfThickness, half], [0, c, half, WORLD_WALL.halfThickness], [0, -c, half, WORLD_WALL.halfThickness]] as const) {
    physics.raw.createCollider(RAPIER.ColliderDesc.cuboid(hx, h, hz).setTranslation(x, h, z));
  }
  return physics;
}

/**
 * One patrol shift in the generated city: the officer (on foot, or seated in a drivable
 * vehicle), the station's patrol cars, streamed static colliders, ambient traffic, game
 * time and weather. Simulation only: the app renders it. Owns everything it created and
 * removes it in `dispose()`.
 */
export class GameSession {
  readonly seed: number;
  /** Root generator; its state is persisted so spawns continue deterministically after a load. */
  readonly rng: Rng;
  readonly clock: GameClock;
  readonly controller = new PlayerController();
  readonly city: City;
  readonly env: Environment;
  readonly traffic: TrafficSystem;
  readonly modes: PlayerModeMachine;
  readonly bus: EventBus<EventMap>;
  /** Driver input captured each frame; applied to the driven vehicle every fixed step. */
  readonly driverInput: DriverInput = { accelerate: 0, brake: 0, steer: 0, handbrake: false };
  /** Fixed-step systems to register next to the app's (environment, colliders, vehicles, traffic). */
  readonly systems: readonly SessionSystem[];
  /** Camera mode used while driving (saved as `camera.mode`). */
  cameraMode: VehicleCameraModeId = CAMERA_MODE.chase;
  officer: { name: string; badge: string };
  private readonly ctx: GameContext;
  private readonly colliders: WorldColliders;
  private readonly colors: Rng;
  private playerEid: EntityId = 0;
  private readonly boxEids: EntityId[] = [];
  private readonly vehicleList: DrivableVehicle[] = [];
  /** Each vehicle's own `'vehicle:<slot>'` stream (same index as `vehicleList`). */
  private readonly vehicleRngs: Rng[] = [];
  private lastVehicleEid: EntityId = 0;
  /** H toggle; null follows the automatic headlights until they switch. */
  private headlightOverride: boolean | null = null;
  private autoHeadlights: boolean;
  private readonly controls: DriverControls = { throttle: 0, brake: 0, steer: 0, handbrake: true, reverse: false };
  private readonly vehicleEnv: VehicleEnvironment;
  private readonly parked: TrafficParked[] = Array.from({ length: MAX_PARKED_OBSTACLES }, () => ({
    x: 0, z: 0, hx: 0, hz: -1, halfLength: 1, halfWidth: 1,
  }));
  /** Sort key of each `parked` entry: squared distance to the focus, -1 for the car the officer left. */
  private readonly parkedKey = new Float64Array(MAX_PARKED_OBSTACLES);
  private readonly focus: TrafficFocus = {
    x: 0, z: 0, obstacle: false, ox: 0, oz: 0, ovx: 0, ovz: 0, oRadius: OFFICER_RADIUS, oHalfWidth: OFFICER_RADIUS,
    parked: this.parked, parkedCount: 0,
  };
  private readonly candidates: MutableCandidate[] = [];
  private readonly candidate: MutableCandidate = { eid: 0, x: 0, z: 0, yaw: 0, halfWidth: 1, halfLength: 1, speed: 0 };
  /** Fuel pump positions (x, z pairs): the station's pump first, then four per fuel station. */
  private readonly pumps: Float64Array;
  /** How many leading `pumps` entries are the station's (where a car is also repaired). */
  private readonly stationPumps: number;
  private readonly exitShape = new RAPIER.Cuboid(EXIT_CLEARANCE_HALF.x, EXIT_CLEARANCE_HALF.y, EXIT_CLEARANCE_HALF.z);
  private readonly violationLog = new Map<number, Partial<Record<TrafficViolationKind, number>>>();
  /**
   * Moves the officer's kinematic body: it stops at a vehicle instead of shoving it at walking speed
   * (a kinematic body has infinite mass, so every touch was a crash), and at buildings, poles and the
   * world walls (Rapier never stops a kinematic body at fixed colliders). Debug boxes are still pushed.
   */
  private readonly mover: KinematicCharacterController;
  private readonly blocksOfficer: (collider: Collider) => boolean;
  /** The officer body's collider (null while driving); kept so the fixed step does not allocate a wrapper. */
  private officerCollider: Collider | null = null;
  private readonly unsubscribe: () => void;
  private disposed = false;

  /** Also rewinds the world clock to match `clock` (one world step per fixed step of simulated time). */
  constructor(ctx: GameContext, seed: number, rng: Rng = createRng(seed), clock: GameClock = new GameClock()) {
    this.ctx = ctx;
    this.seed = seed;
    this.rng = rng;
    this.clock = clock;
    this.colors = rng.stream('colors');
    this.officer = { ...DEFAULT_OFFICER };
    this.bus = ctx.bus ?? new EventBus<EventMap>();
    this.city = ctx.city?.seed === seed ? ctx.city : generateCity(seed);
    const time = ctx.world.time;
    time.dt = 0;
    time.elapsed = clock.simTime;
    time.step = Math.round(clock.simTime / ctx.physics.fixedDt);

    this.env = new Environment(seed, this.bus);
    this.env.update(clock.simTime);
    this.autoHeadlights = this.env.lighting.headlightsOn;
    this.modes = new PlayerModeMachine(this.bus);
    this.colliders = new WorldColliders(ctx.physics, this.city);
    this.traffic = new TrafficSystem({
      world: ctx.world,
      physics: ctx.physics,
      graph: this.city.graph,
      city: this.city,
      seed,
      rng: rng.stream('traffic'),
      bus: this.bus,
    });
    const city = this.city;
    this.vehicleEnv = { surfaceAt: (x, z) => city.surfaceAt(x, z), wetness: 0, snowCover: 0, ambientC: 20 };
    const pumps = fuelPumps(city);
    this.pumps = pumps.xz;
    this.stationPumps = pumps.station;
    this.unsubscribe = this.bus.on('traffic:violation', (e) => this.logViolation(e));
    this.mover = ctx.physics.raw.createCharacterController(OFFICER_SKIN);
    this.mover.disableSnapToGround();
    this.mover.setApplyImpulsesToDynamicBodies(false);
    this.blocksOfficer = (collider) => {
      const eid = ctx.physics.eidOfCollider(collider.handle);
      if (eid === undefined) return !ctx.physics.isGround(collider.handle);
      return EntityKind.kind[eid] === KIND.Vehicle;
    };
    this.systems = [
      { order: -900, system: { name: 'environment', run: () => this.env.update(this.clock.simTime) } },
      { order: -800, system: { name: 'colliders', run: () => this.updateColliders() } },
      { order: 40, system: { name: 'vehicles.pre', run: (_world, dt) => this.preStepVehicles(dt) } },
      { order: 50, system: { name: 'traffic', run: (_world, dt) => this.stepTraffic(dt) } },
      { order: 110, system: { name: 'vehicles.post', run: (_world, dt) => this.postStepVehicles(dt) } },
    ];
  }

  get player(): EntityId {
    return this.playerEid;
  }

  /** Box entity ids in spawn order (the order they are serialized in). */
  get boxes(): readonly EntityId[] {
    return this.boxEids;
  }

  /** Drivable vehicles in spawn order (the order they are serialized in). */
  get vehicles(): readonly DrivableVehicle[] {
    return this.vehicleList;
  }

  /** Entities the session owns: the officer, debug boxes, drivable vehicles and traffic cars. */
  get entityCount(): number {
    return (this.playerEid === 0 ? 0 : 1) + this.boxEids.length + this.vehicleList.length + this.traffic.activeCount;
  }

  /** Physics world the session's bodies live in. */
  get physics(): PhysicsWorld {
    return this.ctx.physics;
  }

  get driving(): boolean {
    return this.modes.mode === PLAYER_MODE.driving;
  }

  /** The vehicle the officer is in, null on foot. */
  get drivenVehicle(): DrivableVehicle | null {
    return this.vehicleOf(this.modes.vehicle);
  }

  /** The vehicle the officer drove last (or is driving); refuelling and the headlight spots use it. */
  get lastVehicle(): DrivableVehicle | null {
    return this.vehicleOf(this.lastVehicleEid);
  }

  /** Boxes that can still be spawned before the render pool is full; a slot stays free for the officer while driving. */
  get boxCapacityLeft(): number {
    const reserved = this.playerEid !== 0 && !this.ctx.meshes.has(this.playerEid) ? 1 : 0;
    return Math.max(0, this.ctx.meshes.freeBoxSlots - reserved);
  }

  /** The officer's simulated position (the seat while driving). */
  playerPosition(out: { x: number; z: number }): { x: number; z: number } {
    out.x = Transform.x[this.playerEid] ?? 0;
    out.z = Transform.z[this.playerEid] ?? 0;
    return out;
  }

  /** Registers `systems` in `registry` (design §13 orders); returns a function that removes them again. */
  attachSystems(registry: SystemRegistry): () => void {
    for (const { system, order } of this.systems) registry.register(system, order);
    return () => {
      for (const { system } of this.systems) registry.unregister(system.name);
    };
  }

  /** Creates the officer on foot at `position`, facing `yaw`. */
  spawnPlayer(position: Vec3, yaw = 0, motion?: BodyMotion): EntityId {
    this.assertLive();
    if (this.playerEid !== 0) throw new Error('Player already spawned');
    let eid: EntityId;
    try {
      eid = this.spawnBody(KIND.Player, yawQuaternion(yaw, { x: 0, y: 0, z: 0, w: 1 }), motion, (id) => {
        this.addOfficerBody(id, position);
      });
    } catch (error) {
      this.officerCollider = null;
      throw error;
    }
    this.controller.yaw = yaw;
    this.playerEid = eid;
    return eid;
  }

  /**
   * Spawns one dynamic debug box; the colour comes from the seeded colour stream.
   * Throws `RangeError` (spawning nothing) when the render pool is full.
   */
  spawnBox(position: Vec3, rotation?: Quat, motion?: BodyMotion): EntityId {
    this.assertLive();
    if (this.boxCapacityLeft === 0) {
      throw new RangeError(`Box pool is full (${String(this.ctx.meshes.boxCapacity)} instances)`);
    }
    const eid = this.spawnBody(KIND.Prop, rotation, motion, (id) => {
      this.ctx.physics.addBox(id, position, BOX_HALF, { friction: BOX_FRICTION });
      this.ctx.meshes.addBox(id, { color: nextBoxColor(this.colors) });
    });
    this.boxEids.push(eid);
    return eid;
  }

  /**
   * Drops up to `count` boxes over the officer on a non-overlapping lattice
   * (jittered by the root generator) that starts above every existing box,
   * stopping when the render pool is full. Returns the spawned ids.
   */
  spawnRandomBoxes(count: number): EntityId[] {
    const n = Math.min(count, this.boxCapacityLeft);
    if (n <= 0) return [];
    const at = this.playerPosition(scratchPoint);
    let topY = DROP_MIN_Y - DROP_CLEARANCE;
    for (const eid of this.boxEids) {
      const y = this.ctx.physics.getBody(eid)?.translation().y;
      if (y !== undefined && y > topY) topY = y;
    }
    const placements = layoutDropLattice(this.rng, n, at.x, at.z, topY + DROP_CLEARANCE);
    return placements.map((placement) => this.spawnBox(placement));
  }

  /**
   * Adds a drivable vehicle (entity, chassis, `VehicleLook`) at `pose`. Its colour and random
   * stalls come from its own `'vehicle:<slot>'` stream (slot = spawn order).
   */
  spawnVehicle(model: VehicleModel, pose: VehiclePose): DrivableVehicle {
    this.assertLive();
    const rng = this.rng.stream(`vehicle:${String(this.vehicleList.length)}`);
    const color = pickModelColor(model, rng.next());
    return this.addVehicle(model, color, rng, (eid) => DrivableVehicle.create(this.ctx.physics, eid, model, pose, rng));
  }

  /** @internal After a load: the vehicle the officer drove last (`vehicles` index, -1 for none). */
  restoreLastVehicle(index: number): void {
    this.lastVehicleEid = this.vehicleList[index]?.eid ?? 0;
  }

  /** @internal After a load: the violations observed so far (traffic only reports each once per edge). */
  restoreViolations(saved: SavedViolations): void {
    this.violationLog.clear();
    for (const [vehicleId, counts] of saved) this.violationLog.set(vehicleId, { ...counts });
  }

  /** `car spawn`: a vehicle of `model` parked ahead of the officer (or of the driven car). */
  spawnVehicleNearPlayer(model: VehicleModel): DrivableVehicle {
    const driven = this.drivenVehicle;
    const at = this.playerPosition(scratchPoint);
    const yaw = driven ? this.yawOf(driven.eid) : this.controller.yaw;
    const ahead = driven ? SPAWN_AHEAD_DRIVING : SPAWN_AHEAD_ON_FOOT;
    const x = at.x - Math.sin(yaw) * ahead;
    const z = at.z - Math.cos(yaw) * ahead;
    return this.spawnVehicle(model, { x, y: restHeight(model), z, yaw });
  }

  /** The station's patrol cars (every police model, in id order) in the first parking slots. */
  parkPatrolCars(): void {
    const police = VEHICLE_MODELS.filter((m) => m.role === 'police');
    const slots = this.city.parking;
    for (let i = 0; i < police.length && i < slots.length; i++) {
      const model = police[i] as VehicleModel;
      const slot = slots[i] as (typeof slots)[number];
      this.spawnVehicle(model, { x: slot.x, y: restHeight(model), z: slot.z, yaw: slot.yaw });
    }
  }

  /**
   * Advances the session by one fixed step of simulated time (clock and world
   * time) and drives the officer's kinematic body (none while driving). Call
   * before the systems run.
   */
  fixedUpdate(input: MoveInput): void {
    const dt = this.ctx.physics.fixedDt;
    advanceTime(this.ctx.world, dt);
    this.clock.addSimTime(dt);
    const body = this.ctx.physics.getBody(this.playerEid);
    const collider = this.officerCollider;
    if (!body || !collider) return;
    const yaw = this.controller.yaw;
    const v = moveVelocity(input, yaw, scratchVel);
    scratchVec.x = v.x * dt;
    scratchVec.y = 0;
    scratchVec.z = v.z * dt;
    this.mover.computeColliderMovement(collider, scratchVec, OFFICER_FILTER, undefined, this.blocksOfficer);
    const m = this.mover.computedMovement(scratchVec);
    v.x = m.x / dt;
    v.z = m.z / dt;
    body.setLinvel(v, true);
    body.setRotation(yawQuaternion(yaw, scratchQuat), true);
  }

  /** What `interact` would do now; cheap enough for the HUD. */
  interactHint(): InteractHint {
    const driven = this.drivenVehicle;
    if (driven) return driven.telemetry.groundSpeed <= EXIT_MAX_SPEED ? 'exit' : null;
    const service = this.pumpService();
    if (service) return service;
    return this.enterableVehicle() ? 'enter' : null;
  }

  /**
   * The `interact` action: get out, refuel at a pump or repair and refuel at the station's pump
   * (first, since the driver door is often beside the pump), or get in at a driver door.
   */
  interact(): InteractResult {
    this.assertLive();
    if (this.driving) return this.exitVehicle();
    const service = this.pumpService();
    const target = this.lastVehicle;
    if (service && target) {
      if (service === 'repair') target.repair();
      target.refuel();
      return service === 'repair' ? 'repaired' : 'refuelled';
    }
    const vehicle = this.enterableVehicle();
    if (vehicle) return this.enterVehicle(vehicle) ? 'entered' : 'none';
    return 'none';
  }

  /** Seats the officer in `vehicle` (no distance check: scripts, loads); false unless on foot. */
  enterVehicle(vehicle: DrivableVehicle): boolean {
    if (!this.vehicleList.includes(vehicle) || !this.modes.enter(vehicle.eid)) return false;
    this.removeOfficerBody();
    this.lastVehicleEid = vehicle.eid;
    vehicle.engineOn = true;
    this.headlightOverride = null;
    this.clearDriverInput();
    this.syncSeat();
    copyTransformSlot(Transform, PrevTransform, this.playerEid);
    return true;
  }

  /** Gets out beside the driver door, else the passenger door; refused while moving or when both are blocked. */
  exitVehicle(): InteractResult {
    const vehicle = this.drivenVehicle;
    if (!vehicle) return 'none';
    // Horizontal speed in any direction: a car sliding sideways reads ~0 forward speed.
    const speed = vehicle.telemetry.groundSpeed;
    if (!(speed <= EXIT_MAX_SPEED)) return 'tooFast';
    const c = this.candidateOf(vehicle, this.candidate);
    const body = this.ctx.physics.getBody(vehicle.eid);
    for (const side of [-1, 1] as const) {
      const p = exitPoint(c, side, scratchPoint);
      if (!this.isClear(p.x, p.z, c.yaw, body)) continue;
      // Body and mesh first: if that throws, the officer is still in the car (mode unchanged).
      this.addOfficerBody(this.playerEid, { x: p.x, y: PLAYER_SIZE.y / 2, z: p.z });
      if (!this.modes.exit(speed)) {
        this.removeOfficerBody();
        return 'tooFast';
      }
      vehicle.engineOn = false;
      this.controller.yaw = c.yaw;
      this.clearDriverInput();
      this.writeInitialTransform(this.playerEid);
      return 'exited';
    }
    return 'exitBlocked';
  }

  /** H: overrides the automatic headlights of the driven vehicle until they switch on or off by themselves. */
  toggleHeadlights(): void {
    const vehicle = this.drivenVehicle;
    if (!vehicle) return;
    this.headlightOverride = !vehicle.headlights;
    vehicle.headlights = this.headlightOverride;
  }

  /** L: the driven vehicle's light bar (drawn only for models that have one). */
  toggleLightbar(): void {
    const vehicle = this.drivenVehicle;
    if (vehicle) vehicle.lightbar = !vehicle.lightbar;
  }

  /**
   * Moves the officer (or the driven vehicle, stopped and upright) to (x, z), facing `yaw`
   * (default: the current heading), loads the colliders there at once and repopulates
   * traffic around the new spot.
   */
  teleport(x: number, z: number, yaw?: number): void {
    this.assertLive();
    const vehicle = this.drivenVehicle;
    const eid = vehicle ? vehicle.eid : this.playerEid;
    const body = this.ctx.physics.getBody(eid);
    const heading = yaw ?? (vehicle ? this.yawOf(eid) : this.controller.yaw);
    if (!vehicle) this.controller.yaw = heading;
    if (body) {
      const y = vehicle ? restHeight(vehicle.model) : PLAYER_SIZE.y / 2;
      body.setTranslation({ x, y, z }, true);
      body.setRotation(yawQuaternion(heading, scratchQuat), true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.writeInitialTransform(eid);
    }
    if (vehicle) {
      this.syncSeat();
      copyTransformSlot(Transform, PrevTransform, this.playerEid);
    }
    this.colliders.prime(x, z);
    this.traffic.clear(true);
    this.updateFocus();
    this.traffic.populate(this.focus, this.env.time);
  }

  /** Traffic cars nearest the officer first, with their registry record and observed violations. */
  trafficCars(limit: number): TrafficCarRow[] {
    const view = this.traffic.view;
    const at = this.playerPosition(scratchPoint);
    const slots = Array.from({ length: view.count }, (_, i) => i);
    const dist = (i: number): number => Math.hypot((view.x[i] ?? 0) - at.x, (view.z[i] ?? 0) - at.z);
    slots.sort((a, b) => dist(a) - dist(b));
    return slots.slice(0, Math.max(0, limit)).map((i) => {
      const id = view.vehicleId[i] ?? 0;
      const record = vehicleRecord(this.seed, id);
      const flags: string[] = [];
      if (record.stolen) flags.push('stolen');
      if (record.registrationExpired) flags.push('expired registration');
      if (!record.insured) flags.push('uninsured');
      return {
        vehicleId: id,
        plate: record.plate,
        modelId: record.modelId,
        distance: dist(i),
        speedMph: (view.speed[i] ?? 0) / MPH,
        crashed: view.state[i] === TRAFFIC_STATE.crashed,
        violations: { ...this.violationLog.get(id) },
        flags,
      };
    });
  }

  /** Snapshot of the session (v3 save): officer, vehicles, traffic, environment, clock and RNG. */
  serialize(): SaveGame {
    const clock = this.clock.toJSON();
    const entities: SerializedEntity[] = [];
    if (this.playerEid !== 0) entities.push(this.serializeOfficer());
    for (const eid of this.boxEids) entities.push(serializeEntity(this.ctx.physics, eid));
    const driven = this.vehicleList.indexOf(this.drivenVehicle as DrivableVehicle);
    return {
      seed: this.seed,
      rngState: this.rng.state(),
      clock: { simTime: clock.simTime, timeScale: clock.timeScale },
      officer: { ...this.officer },
      camera: { pitch: this.controller.pitch, mode: this.cameraMode },
      world: { entities },
      player: {
        mode: PLAYER_MODE_NAMES[this.modes.mode] ?? 'onFoot',
        vehicle: this.driving ? driven : -1,
        lastVehicle: this.vehicleList.indexOf(this.lastVehicle as DrivableVehicle),
      },
      vehicles: this.vehicleList.map((v, i) => ({
        ...v.serialize(),
        color: VehicleLook.color[v.eid] ?? 0,
        rng: (this.vehicleRngs[i] as Rng).state(),
      })),
      traffic: this.traffic.snapshot(),
      violations: [...this.violationLog].map(([id, counts]) => [id, { ...counts }]),
      environment: this.env.serialize(),
    };
  }

  /** Removes every entity, body, collider and vehicle the session created. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.traffic.dispose();
    if (!this.ctx.physics.isDisposed) this.ctx.physics.raw.removeCharacterController(this.mover);
    for (const vehicle of this.vehicleList) {
      vehicle.dispose();
      despawn(this.ctx.world, vehicle.eid);
    }
    this.vehicleList.length = 0;
    this.vehicleRngs.length = 0;
    if (!this.ctx.physics.isDisposed) this.colliders.dispose();
    const all = this.playerEid === 0 ? this.boxEids : [this.playerEid, ...this.boxEids];
    for (const eid of all) this.removeEntity(eid);
    this.boxEids.length = 0;
    this.playerEid = 0;
    this.officerCollider = null;
  }

  // --- loading (module functions below) ----------------------------------------------

  /** @internal Restores a saved vehicle with its colour and RNG stream. */
  restoreVehicle(saved: SavedVehicle): DrivableVehicle {
    this.assertLive();
    const model = vehicleModel(saved.modelId);
    const rng = rngFromState(saved.rng);
    return this.addVehicle(model, saved.color, rng, (eid) => DrivableVehicle.restore(this.ctx.physics, eid, saved, rng));
  }

  /**
   * @internal After a load: saved headlights of the driven vehicle that differ from the
   * automatic state were switched with H, so they stay that way until the next automatic switch.
   */
  restoreHeadlightOverride(): void {
    this.autoHeadlights = this.env.lighting.headlightsOn;
    const vehicle = this.drivenVehicle;
    this.headlightOverride = vehicle && vehicle.headlights !== this.autoHeadlights ? vehicle.headlights : null;
  }

  /** @internal Loads the colliders around the officer at once (session start, load). */
  primeColliders(): void {
    const at = this.playerPosition(scratchPoint);
    this.colliders.prime(at.x, at.z);
  }

  /** @internal Fills traffic around the officer (session start, a load without traffic). */
  populateTraffic(): void {
    this.updateFocus();
    this.traffic.populate(this.focus, this.env.time);
  }

  // --- fixed-step systems -----------------------------------------------------------

  private updateColliders(): void {
    const at = this.playerPosition(scratchPoint);
    this.colliders.update(at.x, at.z);
  }

  private preStepVehicles(dt: number): void {
    const w = this.env.weather;
    const env = this.vehicleEnv;
    env.wetness = w.wetness;
    env.snowCover = w.snowCover;
    env.ambientC = w.temperatureC;
    const auto = this.env.lighting.headlightsOn;
    if (auto !== this.autoHeadlights) {
      this.autoHeadlights = auto;
      this.headlightOverride = null;
    }
    const driven = this.modes.vehicle;
    for (const vehicle of this.vehicleList) {
      const isDriven = vehicle.eid === driven;
      if (isDriven) vehicle.headlights = this.headlightOverride ?? auto;
      // A parked car drops reverse (no reverse lamps or gear -1 for a car left in reverse).
      const t = vehicle.telemetry;
      mapDriverInput(isDriven ? this.driverInput : PARKED, t.speed, t.groundSpeed, isDriven && vehicle.reversing, this.controls);
      vehicle.setControls(this.controls);
      vehicle.preStep(dt, env);
    }
  }

  private stepTraffic(dt: number): void {
    this.traffic.setHeadlights(this.env.lighting.headlightsOn);
    this.updateFocus();
    this.traffic.step(dt, this.clock.simTime, this.env.time, this.focus);
  }

  private postStepVehicles(dt: number): void {
    for (const vehicle of this.vehicleList) vehicle.postStep(dt, this.bus);
    if (this.driving) this.syncSeat();
  }

  // --- helpers ----------------------------------------------------------------------

  private vehicleOf(eid: EntityId): DrivableVehicle | null {
    if (eid === 0) return null;
    for (const vehicle of this.vehicleList) if (vehicle.eid === eid) return vehicle;
    return null;
  }

  private yawOf(eid: EntityId): number {
    return headingOf(Transform.qx[eid] ?? 0, Transform.qy[eid] ?? 0, Transform.qz[eid] ?? 0, Transform.qw[eid] ?? 1);
  }

  /** The vehicle whose driver door the officer stands at, if any. */
  private enterableVehicle(): DrivableVehicle | null {
    const list = this.candidates;
    while (list.length < this.vehicleList.length) list.push({ eid: 0, x: 0, z: 0, yaw: 0, halfWidth: 1, halfLength: 1, speed: 0 });
    list.length = this.vehicleList.length;
    for (let i = 0; i < list.length; i++) this.candidateOf(this.vehicleList[i] as DrivableVehicle, list[i] as MutableCandidate);
    const at = this.playerPosition(scratchPoint);
    const index = findEnterable(at.x, at.z, list);
    return index < 0 ? null : (this.vehicleList[index] ?? null);
  }

  private candidateOf(vehicle: DrivableVehicle, out: MutableCandidate): MutableCandidate {
    const eid = vehicle.eid;
    out.eid = eid;
    out.x = Transform.x[eid] ?? 0;
    out.z = Transform.z[eid] ?? 0;
    out.yaw = this.yawOf(eid);
    out.halfWidth = vehicle.model.body.width / 2;
    out.halfLength = vehicle.model.body.length / 2;
    out.speed = vehicle.telemetry.groundSpeed;
    return out;
  }

  /**
   * What the pump the officer (on foot) stands at would do for the last-driven vehicle parked near it:
   * repair (and refuel) a damaged car at the station's pump, refuel one that is not full, else nothing.
   */
  private pumpService(): 'repair' | 'refuel' | null {
    const vehicle = this.lastVehicle;
    if (!vehicle || this.driving) return null;
    const refuel = vehicle.telemetry.fuelFraction < 1;
    const repair = vehicle.needsRepair;
    if (!refuel && !repair) return null;
    const at = this.playerPosition(scratchPoint);
    const vx = Transform.x[vehicle.eid] ?? 0;
    const vz = Transform.z[vehicle.eid] ?? 0;
    const pumps = this.pumps;
    for (let i = 0; i + 1 < pumps.length; i += 2) {
      const px = pumps[i] ?? 0;
      const pz = pumps[i + 1] ?? 0;
      if (Math.hypot(at.x - px, at.z - pz) > REFUEL_PUMP_DISTANCE) continue;
      if (Math.hypot(vx - px, vz - pz) > REFUEL_VEHICLE_DISTANCE) continue;
      if (repair && i < this.stationPumps * 2) return 'repair';
      if (refuel) return 'refuel';
    }
    return null;
  }

  /** True when an officer-sized box at (x, z) touches no collider except `exclude`'s (the car being left). */
  private isClear(x: number, z: number, yaw: number, exclude: RigidBody | undefined): boolean {
    scratchVec.x = x;
    scratchVec.y = EXIT_CLEARANCE_Y;
    scratchVec.z = z;
    const hit = this.ctx.physics.raw.intersectionWithShape(
      scratchVec,
      yawQuaternion(yaw, scratchQuat),
      this.exitShape,
      undefined,
      undefined,
      undefined,
      exclude,
    );
    return hit === null;
  }

  /** Writes the driver's seat pose of the driven vehicle into the officer's Transform. */
  private syncSeat(): void {
    const vehicle = this.drivenVehicle;
    const p = this.playerEid;
    if (!vehicle || p === 0) return;
    const v = vehicle.eid;
    const qx = Transform.qx[v] ?? 0;
    const qy = Transform.qy[v] ?? 0;
    const qz = Transform.qz[v] ?? 0;
    const qw = Transform.qw[v] ?? 1;
    const lx = vehicle.model.body.width * SEAT_X;
    const lz = vehicle.model.body.length * SEAT_Z;
    // Seat offset rotated into the world: v' = v + w c + q x c with c = 2 (q x v), v = (lx, 0, lz).
    const cx = 2 * (qy * lz);
    const cy = 2 * (qz * lx - qx * lz);
    const cz = 2 * (-qy * lx);
    Transform.x[p] = (Transform.x[v] ?? 0) + lx + qw * cx + (qy * cz - qz * cy);
    Transform.y[p] = (Transform.y[v] ?? 0) + qw * cy + (qz * cx - qx * cz);
    Transform.z[p] = (Transform.z[v] ?? 0) + lz + qw * cz + (qx * cy - qy * cx);
    Transform.qx[p] = qx;
    Transform.qy[p] = qy;
    Transform.qz[p] = qz;
    Transform.qw[p] = qw;
  }

  /**
   * The player as traffic sees it: streaming centre, the driven car or the officer as an obstacle, and
   * the other drivable vehicles near the focus as parked obstacles: the car the officer got out of
   * first, then the nearest others (sorted insertion into the fixed `parked` slots, no allocation).
   */
  private updateFocus(): void {
    const f = this.focus;
    const at = this.playerPosition(scratchPoint);
    f.x = at.x;
    f.z = at.z;
    const vehicle = this.drivenVehicle;
    const last = this.lastVehicle;
    const r2 = DENSITY.radii.despawn * DENSITY.radii.despawn;
    const parked = this.parked;
    const keys = this.parkedKey;
    let n = 0;
    for (const v of this.vehicleList) {
      if (v === vehicle) continue;
      const eid = v.eid;
      const x = Transform.x[eid] ?? 0;
      const z = Transform.z[eid] ?? 0;
      const d2 = (x - at.x) * (x - at.x) + (z - at.z) * (z - at.z);
      if (d2 > r2) continue;
      const key = v === last ? -1 : d2;
      // When full, this one replaces the farthest entry if it is nearer.
      let i: number;
      if (n < MAX_PARKED_OBSTACLES) i = n++;
      else if (key < (keys[MAX_PARKED_OBSTACLES - 1] ?? 0)) i = MAX_PARKED_OBSTACLES - 1;
      else continue;
      const p = parked[i] as TrafficParked;
      while (i > 0 && (keys[i - 1] ?? 0) > key) {
        parked[i] = parked[i - 1] as TrafficParked;
        keys[i] = keys[i - 1] ?? 0;
        i--;
      }
      parked[i] = p;
      keys[i] = key;
      const yaw = this.yawOf(eid);
      p.x = x;
      p.z = z;
      p.hx = -Math.sin(yaw);
      p.hz = -Math.cos(yaw);
      p.halfLength = v.model.body.length / 2;
      p.halfWidth = v.model.body.width / 2;
    }
    f.parkedCount = n;
    const body = this.ctx.physics.getBody(vehicle ? vehicle.eid : this.playerEid);
    f.obstacle = body !== undefined;
    if (!body) return;
    const t = body.translation(scratchVec);
    f.ox = t.x;
    f.oz = t.z;
    const v = body.linvel(scratchVel);
    f.ovx = v.x;
    f.ovz = v.z;
    f.oRadius = vehicle ? vehicle.model.body.length / 2 : OFFICER_RADIUS;
    f.oHalfWidth = vehicle ? vehicle.model.body.width / 2 : OFFICER_RADIUS;
  }

  private clearDriverInput(): void {
    const d = this.driverInput;
    d.accelerate = 0;
    d.brake = 0;
    d.steer = 0;
    d.handbrake = false;
  }

  private logViolation(e: TrafficViolationEvent): void {
    const counts = this.violationLog.get(e.vehicleId) ?? {};
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    this.violationLog.set(e.vehicleId, counts);
  }

  /** The officer's save entity: its body on foot, the seat pose (at rest) while driving. */
  private serializeOfficer(): SerializedEntity {
    const eid = this.playerEid;
    if (!this.ctx.physics.has(eid)) {
      return {
        kind: KIND.Player,
        x: Transform.x[eid] ?? 0,
        y: Transform.y[eid] ?? 0,
        z: Transform.z[eid] ?? 0,
        qx: Transform.qx[eid] ?? 0,
        qy: Transform.qy[eid] ?? 0,
        qz: Transform.qz[eid] ?? 0,
        qw: Transform.qw[eid] ?? 1,
        vx: 0,
        vy: 0,
        vz: 0,
        wx: 0,
        wy: 0,
        wz: 0,
        sleeping: false,
      };
    }
    // The camera can turn while no fixed step runs (time scale 0, console pause), so the facing
    // comes from the controller, not the body; the next fixed step writes the same rotation anyway.
    const officer = serializeEntity(this.ctx.physics, eid);
    const q = yawQuaternion(this.controller.yaw, { x: 0, y: 0, z: 0, w: 1 });
    return { ...officer, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
  }

  /** Kinematic officer body and box mesh at `position` (spawn and getting out); nothing is left if it throws. */
  private addOfficerBody(eid: EntityId, position: Vec3): void {
    const half = { x: PLAYER_SIZE.x / 2, y: PLAYER_SIZE.y / 2, z: PLAYER_SIZE.z / 2 };
    const body = this.ctx.physics.addBox(eid, position, half, { kinematic: true, friction: 0.2 });
    try {
      this.ctx.meshes.addBox(eid, { size: PLAYER_SIZE, color: PLAYER_COLOR });
    } catch (error) {
      this.ctx.physics.removeBody(eid);
      throw error;
    }
    this.officerCollider = body.collider(0);
  }

  private removeOfficerBody(): void {
    this.ctx.physics.removeBody(this.playerEid);
    this.ctx.meshes.remove(this.playerEid);
    this.officerCollider = null;
  }

  /** Entity + `VehicleLook` + `Drivable`, then the chassis from `create`; nothing is left behind if it throws. */
  private addVehicle(model: VehicleModel, color: number, rng: Rng, create: (eid: EntityId) => DrivableVehicle): DrivableVehicle {
    const world = this.ctx.world;
    const eid = spawn(world, Transform, PrevTransform, PhysicsBody);
    let vehicle: DrivableVehicle;
    try {
      EntityKind.kind[eid] = KIND.Vehicle;
      attachVehicleLook(world, eid, model.index, color);
      attachDrivable(world, eid);
      vehicle = create(eid);
    } catch (error) {
      this.ctx.physics.removeBody(eid);
      despawn(world, eid);
      throw error;
    }
    // Parked with the engine off until the officer gets in (no idle burn or stalls while empty).
    vehicle.engineOn = false;
    this.vehicleList.push(vehicle);
    this.vehicleRngs.push(rng);
    this.writeInitialTransform(eid);
    return vehicle;
  }

  /**
   * Creates the entity, then `attach` adds its body and mesh. Either all of
   * it exists afterwards or, if any step throws, none of it does.
   */
  private spawnBody(kind: number, rotation: Quat | undefined, motion: BodyMotion | undefined, attach: (eid: EntityId) => void): EntityId {
    const { world, physics } = this.ctx;
    const eid =
      kind === KIND.Player
        ? spawn(world, Transform, PrevTransform, Player, PhysicsBody)
        : spawn(world, Transform, PrevTransform, PhysicsBody);
    try {
      EntityKind.kind[eid] = kind;
      attach(eid);
      const body = physics.getBody(eid);
      if (!body) throw new Error(`Entity ${String(eid)} has no physics body`);
      if (rotation) body.setRotation(rotation, true);
      if (motion) {
        body.setLinvel(motion.linvel, true);
        body.setAngvel(motion.angvel, true);
        if (motion.sleeping) body.sleep();
      }
    } catch (error) {
      this.removeEntity(eid);
      throw error;
    }
    this.writeInitialTransform(eid);
    return eid;
  }

  private removeEntity(eid: EntityId): void {
    this.ctx.physics.removeBody(eid);
    this.ctx.meshes.remove(eid);
    despawn(this.ctx.world, eid);
  }

  /** Copies the body pose into Transform and PrevTransform (no interpolation streak). */
  private writeInitialTransform(eid: EntityId): void {
    const body = this.ctx.physics.getBody(eid);
    if (!body) return;
    const t = body.translation();
    const r = body.rotation();
    Transform.x[eid] = t.x;
    Transform.y[eid] = t.y;
    Transform.z[eid] = t.z;
    Transform.qx[eid] = r.x;
    Transform.qy[eid] = r.y;
    Transform.qz[eid] = r.z;
    Transform.qw[eid] = r.w;
    copyTransformSlot(Transform, PrevTransform, eid);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('GameSession has been disposed');
  }
}

/** Fuel pumps of the city: the station's own pump (counted in `station`) first, then the four around each fuel POI. */
function fuelPumps(city: City): { xz: Float64Array; station: number } {
  const out: number[] = [];
  for (const poi of city.pois) {
    const block = city.blocks[poi.block];
    if (poi.kind !== 'station' || !block) continue;
    const pump = stationLayout(block, LANDMARKS.station.yaw).pump;
    out.push(pump.x, pump.z);
  }
  const station = out.length / 2;
  for (const poi of city.pois) {
    if (poi.kind !== 'fuel') continue;
    // Same offsets as the fuel station block in chunkLayout.
    for (const [dx, dz] of [[-4, -3], [4, -3], [-4, 3], [4, 3]] as const) out.push(poi.x + dx, poi.z + dz);
  }
  return { xz: Float64Array.from(out), station };
}

/** Reads the entity's state from its rigid body (the per-world source of truth). */
function serializeEntity(physics: PhysicsWorld, eid: EntityId): SerializedEntity {
  const kind = EntityKind.kind[eid] ?? KIND.None;
  const body = physics.getBody(eid);
  if (!body) throw new Error(`Entity ${String(eid)} has no physics body`);
  const t = body.translation();
  const r = body.rotation();
  const v = body.linvel();
  const w = body.angvel();
  return {
    kind,
    x: t.x,
    y: t.y,
    z: t.z,
    qx: r.x,
    qy: r.y,
    qz: r.z,
    qw: r.w,
    vx: v.x,
    vy: v.y,
    vz: v.z,
    wx: w.x,
    wy: w.y,
    wz: w.z,
    sleeping: body.isSleeping(),
  };
}

/** Snapshot of the session as a v3 save (see `GameSession.serialize`). */
export function serializeGame(session: GameSession): SaveGame {
  return session.serialize();
}

function motionOf(e: SerializedEntity): BodyMotion {
  return { linvel: { x: e.vx, y: e.vy, z: e.vz }, angvel: { x: e.wx, y: e.wy, z: e.wz }, sleeping: e.sleeping };
}

/**
 * Rapier wakes both bodies of every new contact pair, a freshly built world has no pairs
 * yet, and its scene queries (vehicle wheel rays) only see colliders after a step. One
 * uncounted step without gravity, with every body held still, builds the pairs and the
 * query structures; then each body's state is put back exactly: awake bodies get their
 * pose and velocities, sleeping ones the same without waking, then sleep.
 */
function primeContacts(physics: PhysicsWorld, bodies: ReadonlyArray<readonly [EntityId, SerializedEntity]>): void {
  const raw = physics.raw;
  const gravity = raw.gravity;
  raw.gravity = { x: 0, y: 0, z: 0 };
  for (const [eid] of bodies) {
    const body = physics.getBody(eid);
    body?.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body?.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }
  raw.step(); // no event queue: these contacts began before the save
  raw.gravity = gravity;
  for (const [eid, e] of bodies) {
    const body = physics.getBody(eid);
    if (!body) continue;
    const linvel = { x: e.vx, y: e.vy, z: e.vz };
    const angvel = { x: e.wx, y: e.wy, z: e.wz };
    const wake = !e.sleeping;
    body.setTranslation({ x: e.x, y: e.y, z: e.z }, wake);
    body.setRotation({ x: e.qx, y: e.qy, z: e.qz, w: e.qw }, wake);
    body.setLinvel(linvel, wake);
    body.setAngvel(angvel, wake);
    if (e.sleeping) body.sleep();
  }
}

/** The current state of every body the session owns, for `primeContacts`. */
function sessionBodies(session: GameSession): Array<readonly [EntityId, SerializedEntity]> {
  const ids = [session.player, ...session.boxes, ...session.vehicles.map((v) => v.eid)];
  return ids.filter((eid) => session.physics.has(eid)).map((eid) => [eid, serializeEntity(session.physics, eid)] as const);
}

/**
 * Starts a shift for `seed`: the officer on foot at the station door, the patrol cars in
 * the station lot, colliders around the station and traffic around it. The same seed
 * always yields the same city and the same run for the same inputs.
 */
export function startNewGame(ctx: GameContext, seed: number | string): GameSession {
  const normalized = normalizeSeed(seed);
  const session = new GameSession(ctx, normalized);
  try {
    const spawnAt = session.city.spawn;
    session.spawnPlayer({ x: spawnAt.x, y: PLAYER_SIZE.y / 2, z: spawnAt.z }, spawnAt.yaw);
    session.parkPatrolCars();
    session.primeColliders();
    session.populateTraffic();
    primeContacts(ctx.physics, sessionBodies(session));
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
}

/**
 * Rebuilds a session from a v3 save into `ctx` (use a fresh physics world, see
 * `createScenePhysics`): the city is regenerated from the seed, bodies and vehicles get
 * their saved state, traffic and the environment continue where they were (an empty
 * vehicle list re-parks the patrol cars, missing traffic is populated afresh). Nothing
 * is left behind if it throws.
 */
export function loadGame(ctx: GameContext, envelope: SaveEnvelope<SaveGame>): GameSession {
  const data = envelope.data;
  const clock = new GameClock().fromJSON({ simTime: data.clock.simTime, timeScale: data.clock.timeScale, paused: false });
  const session = new GameSession(ctx, normalizeSeed(data.seed), rngFromState(data.rngState), clock);
  try {
    session.officer = { ...data.officer };
    session.controller.pitch = data.camera.pitch;
    if (data.camera.mode === CAMERA_MODE.chase || data.camera.mode === CAMERA_MODE.hood || data.camera.mode === CAMERA_MODE.cockpit) {
      session.cameraMode = data.camera.mode;
    }
    session.env.restore(data.environment);
    session.env.update(clock.simTime);
    for (const e of data.world.entities) {
      const position = { x: e.x, y: e.y, z: e.z };
      const rotation = { x: e.qx, y: e.qy, z: e.qz, w: e.qw };
      if (e.kind === KIND.Player) {
        if (session.player === 0) session.spawnPlayer(position, yawFromQuaternion(rotation), motionOf(e));
      } else if (e.kind === KIND.Prop) {
        session.spawnBox(position, rotation, motionOf(e));
      }
    }
    if (session.player === 0) {
      const spawnAt = session.city.spawn;
      session.spawnPlayer({ x: spawnAt.x, y: PLAYER_SIZE.y / 2, z: spawnAt.z }, spawnAt.yaw);
    }
    if (data.vehicles.length === 0) session.parkPatrolCars();
    for (const saved of data.vehicles) session.restoreVehicle(saved);
    const driven = data.player.mode === 'driving' ? session.vehicles[data.player.vehicle] : undefined;
    session.restoreLastVehicle(data.player.lastVehicle ?? -1);
    if (driven) session.enterVehicle(driven);
    session.restoreViolations(data.violations ?? []);
    session.restoreHeadlightOverride();
    session.primeColliders();
    if (data.traffic) session.traffic.restore(data.traffic);
    else session.populateTraffic();
    // Every body was just created with its saved state, so reading them back gives exactly that state.
    primeContacts(ctx.physics, sessionBodies(session));
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
}
