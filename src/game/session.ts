import RAPIER, { type Collider, type KinematicCharacterController, type RigidBody } from '@dimforge/rapier3d-compat';
import type { EntityId } from 'bitecs';
import { addressAt, addressOnEdge } from '../cad/address';
import { CadState, callNumber } from '../cad/cadState';
import '../cad/events';
import { ContactManager } from '../contact';
import '../contact/events';
import type { RadioMode } from '../cad/types';
import type { EventMap } from '../core/event-map';
import { EventBus } from '../core/events';
import { createRng, normalizeSeed, rngFromState, type Rng } from '../core/rng';
import { GameClock } from '../core/time';
import { Dispatcher, type PlayerUnitState } from '../dispatch/dispatcher';
import type { ConductState } from '../conduct';
import type { CourtState } from '../court';
import type { ForceOfficer, ForceSystem } from '../force';
import type { IncidentSystem, DashProbe, OfficerProbe, PursuitProbe } from '../incidents';
import { RECORDING } from '../recording';
import { Phase5 } from './phase5';
import { EntityKind, KIND, PhysicsBody, Player, PrevTransform, Transform, copyTransformSlot } from '../ecs/components';
import type { System, SystemRegistry } from '../ecs/systems';
import { advanceTime, despawn, spawn, type GameWorld } from '../ecs/world';
import { Environment } from '../environment/environment';
import {
  InteriorSystem,
  isOpenAt,
  hourOf,
  residentPerson,
  type InteriorInteractable,
  type OccupantSpawn,
  type OfficerAt,
} from '../indoors';
import type { InteriorDoorEvent, InteriorMoveOfficerEvent } from '../indoors/events';
import { InvestigationSystem, type InvestigationOfficer, type InvestigationPorts, type NoGoZone } from '../investigation';
import { levelY } from '../interior/constants';
import { lineOfSight } from '../interior/los';
import { roomAt } from '../interior/nav';
import { StationState, beyondFurniture, migratedStationSave, newShiftStationSave, type ShiftStep } from '../station';
import { TacticalSystem, type OfficerPose, type SoundKind } from '../tactical';
import { ACTOR_STATE, NpcSystem, type ActorInfo, type NpcFocus, type PersonPick } from '../npc';
import { Population, describePerson } from '../people';
import { PhysicsWorld, type Vec3 } from '../physics/physics';
import { CAMERA_MODE, type VehicleCameraModeId } from '../player/cameraRig';
import type { DriverInput } from '../player/driverInput';
import { EXIT_MAX_SPEED, PLAYER_MODE, PLAYER_MODE_NAMES, PlayerModeMachine, driverDoorPoint, exitPoint, findEnterable } from '../player/mode';
import { attachPoliceLights } from '../police/components';
import { PatrolEquipment, type EquipmentSave } from '../police/equipment';
import { OfficerKit, type OfficerKitSave } from '../police/inventory';
import { RadioSystem } from '../radio/radioSystem';
import { epochDayOfGameSeconds } from '../records/calendar';
import { RecordsDb, homeEdgesOf } from '../records/db';
import { mountedPlate } from '../records/vehicle';
import type { MeshRegistry } from '../render/meshSync';
import '../scene/events';
import { SceneDirector } from '../scene';
import type { SaveEnvelope, SaveGame, SavedSpeeding, SavedVehicle, SavedViolations, SerializedEntity } from '../save/schema';
import type { TrafficViolationEvent, TrafficViolationKind } from '../traffic/events';
import { vehicleRecord } from '../traffic/registry';
import { DENSITY } from '../traffic/data';
import {
  MAX_PARKED_OBSTACLES,
  TRAFFIC_STATE,
  TrafficSystem,
  isFleetVehicleId,
  type StopState,
  type TrafficFocus,
  type TrafficParked,
} from '../traffic/trafficSystem';
import { VehicleLook, attachDrivable, attachVehicleLook } from '../vehicles/components';
import { mapDriverInput, type DriverControls } from '../vehicles/controls';
import { DrivableVehicle, type VehicleEnvironment, type VehiclePose } from '../vehicles/drivableVehicle';
import { VEHICLE_MODELS, pickModelColor, restHeight, vehicleModel, type VehicleModel } from '../vehicles/model';
import type { City } from '../world/city';
import { WorldColliders } from '../world/colliders';
import { MPH, WORLD_HALF_SIZE, WORLD_WALL } from '../world/constants';
import { LANDMARKS } from '../world/data';
import { generateCity } from '../world/generate';
import { BuildingIndex } from '../world/buildings';
import type { RoadHit } from '../world/roadGraph';
import { DISTRICT_NAMES } from '../world/ids';
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
  /** Radio language (settings `audio.radioMode`), read when the radio composes; ten-codes without it. */
  radioMode?: () => RadioMode;
  /** Calls bind to real building interiors (Phase 4); false keeps the Phase 3 outdoor scenes (older tests). Default true. */
  indoorScenes?: boolean;
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

/**
 * Outcome of `GameSession.interact()`. `trunk` and `contact` ask the caller to open the trunk panel of
 * `trunkVehicle()` or the traffic-stop driver contact panel (design §13.4).
 */
export type InteractResult =
  | 'none'
  | 'entered'
  | 'exited'
  | 'refuelled'
  | 'repaired'
  | 'exitBlocked'
  | 'tooFast'
  | 'trunk'
  | 'contact'
  | 'talk'
  | 'cage'
  | 'interior'
  | 'doorPanel'
  | 'collect'
  | 'locker'
  | 'briefing'
  | 'armory'
  | 'evidence'
  | 'reportDesk'
  | 'interview'
  | 'cell';
/** What `interact` would do right now (HUD prompt). */
export type InteractHint =
  | 'enter'
  | 'exit'
  | 'refuel'
  | 'repair'
  | 'trunk'
  | 'driver'
  | 'talk'
  | 'cage'
  | 'enterBuilding'
  | 'exitBuilding'
  | 'door'
  | 'locked'
  | 'switch'
  | 'locker'
  | 'briefing'
  | 'armory'
  | 'evidence'
  | 'reportDesk'
  | 'interview'
  | 'cell'
  | 'collect'
  | null;

/** The door `interact` / the door panel acts on (an exterior door from outside, or an interior door). */
export interface DoorTarget {
  buildingId: number;
  door: number;
  /** An exterior door seen from outdoors. */
  outdoors: boolean;
  locked: boolean;
}

/** Options of `startNewGame`. */
export interface NewGameOptions {
  /** The shift starts in the station's locker room (default); false starts outdoors at the station door (Phase 1-3 tests). */
  inStation?: boolean;
  /** Ruleset id of the legal engine (main menu / console), `generic` by default (Phase 5). */
  jurisdiction?: string;
}

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
  /** Plate anomaly (cloned / mismatched / stolenPlate, naming the registry plate) and registration flags of the record (stolen, expired, uninsured). */
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
/** The officer's pool box is scaled to this edge (m): invisible; the humanoid figure replaces it. */
const OFFICER_MESH_SIZE: Vec3 = { x: 0.001, y: 0.001, z: 0.001 };
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
/** On foot within this distance (m) of a patrol car's rear centre: the trunk (design §13.4). */
export const TRUNK_DISTANCE = 1.6;
/** On foot within this distance (m) of the stopped car's driver window: driver contact. */
export const DRIVER_CONTACT_DISTANCE = 1.8;
/** On foot within this distance (m) of a patrol car's driver door: its MDT. */
export const MDT_REACH_DISTANCE = 3;
/** On foot: a person within this distance (m) and inside the cone below can be talked to (design §20). */
export const TALK_DISTANCE = 2.2;
/** Cosine of the talk cone's half angle (60 degrees in total). */
const TALK_CONE_COS = Math.cos(Math.PI / 6);
/** An escorted prisoner must be within this distance (m) of the officer to be caged ... */
export const CAGE_PRISONER_DISTANCE = 4;
/** ... and the officer within this distance (m) of the patrol car's rear door. */
export const CAGE_DOOR_DISTANCE = 1.8;
/** An arrest needs a patrol car with an empty cage within this distance (m). */
export const ARREST_CAR_DISTANCE = 40;
/** The station counts from this far outside its block (m) (booking). */
const STATION_MARGIN = 8;
/** Below this speed (m/s) the driven car counts as stopped (rack lock). */
export const STOPPED_SPEED = 0.5;

/** Officer placeholder until a later phase has a character setup screen. */
const DEFAULT_OFFICER = { name: 'Officer Doe', badge: '4071' };

const scratchVel: Vec3 = { x: 0, y: 0, z: 0 };
const scratchVec: Vec3 = { x: 0, y: 0, z: 0 };
const scratchQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };
const scratchPoint = { x: 0, z: 0 };
const scratchIds: number[] = [];
const scratchSeat = { x: 0, z: 0 };
const scratchDoor = { x: 0, z: 0 };
const scratchPick: PersonPick = { kind: 'ped', id: 0, seat: -1, personId: -1, distance: 0 };
const scratchActor: ActorInfo = {
  id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false,
  following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
};
const scratchOfficerAt: OfficerAt = { x: 0, z: 0, yaw: 0, building: -1, onFoot: true };
const scratchMove: MoveInput = { forward: 0, strafe: 0, sprint: false };
const scratchSlice = { vx: 0, vz: 0, yaw: 0 };
/** Door events that make a sound (`TacticalSystem` `sound` request source). */
const DOOR_SOUND: Readonly<Partial<Record<InteriorDoorEvent['action'], SoundKind>>> = {
  open: 'doorOpen',
  close: 'doorClose',
  knock: 'knock',
  kick: 'kick',
  ram: 'ram',
  announce: 'announce',
  breached: 'kick',
};
/** Canvass residents stay at their door this long (sim s). */
const CANVASS_STAY_S = 90;
/** Default reach for the report-desk MDT (m). */
const DESK_REACH = 2.5;
/** Reach for depositing evidence at the evidence room's point (m). */
const EVIDENCE_REACH = 3;
/** Reach for collecting a found item (m). */
const COLLECT_REACH = 1.5;
/** The door panel stays open while the door is within this distance (m). */
const DOOR_PANEL_REACH = 3;
/** Where an ambient occupant answering a canvass stood before; they go back there afterwards. */
interface CanvassHome { building: number; x: number; z: number; yaw: number }
interface CanvassStay { id: number; until: number; home: CanvassHome | null }
/** Occupant states in which a resident can come to the door (not asleep, hiding, restrained or fleeing). */
const CANVASS_MOVABLE = new Set<number>([ACTOR_STATE.idle, ACTOR_STATE.wander, ACTOR_STATE.hold, ACTOR_STATE.sit, ACTOR_STATE.seated, ACTOR_STATE.walkTo]);
/** A canvass needs the player's call anchor within this distance (m). */
const CANVASS_CALL_REACH = 150;
/** The prisoner stands this far beyond the interview point (m). */
/** Distance (m) the interviewee stands beyond the far edge of the interview table. */
const INTERVIEW_BEYOND = 0.5;
/** What a new shift's officer carries at the start (item, count). */
const FIELD_KIT: readonly (readonly [string, number])[] = [['evidenceMarkers', 8], ['evidenceBags', 8], ['camera', 1], ['fingerprintKit', 1], ['sceneTape', 1]];
/** The officer counts as moving for the force hit model above this speed (m/s). */
const FORCE_MOVING_SPEED = 0.5;
/** Pursuit policy: the road under the car is the nearest centreline within this distance (m). */
const PURSUIT_ROAD_RADIUS = 40;
/** Wetness above which the road counts as wet, night factor above which it is night (pursuit policy). */
const WET_ROAD = 0.3;
const NIGHT_FACTOR = 0.5;
const NO_VIOLATIONS: Readonly<Partial<Record<string, number>>> = {};
const scratchStop: StopState = { vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 };

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
  /** Calls, units (AVL), documents and the traffic-stop context (design §6). */
  readonly cad: CadState;
  /** Persons, registrations, plates and BOLOs (design §5). */
  readonly records: RecordsDb;
  /** Call generator, AI units, requests, status checks (design §8); fixed step -700. */
  readonly dispatcher: Dispatcher;
  /** Channels, composer, ambient chatter (design §9); fixed step -650. */
  readonly radio: RadioSystem;
  /** Touched persons over the deterministic base identities (Phase 3 §5). */
  readonly people: Population;
  /** Pedestrians, scene actors and car occupants; fixed step 60. */
  readonly npc: NpcSystem;
  /** Conversations, field actions, statements; fixed step -680. */
  readonly contact: ContactManager;
  /** Scenarios of the calls: materialization, tactics, services, pursuits; fixed step -690. */
  readonly scene: SceneDirector;
  /** Building ids, kinds and entrances (Phase 4). */
  readonly buildings: BuildingIndex;
  /** Interiors: residency, doors, lights, the officer's level; fixed step -810. */
  readonly interiors: InteriorSystem;
  /** Stance, flashlight, sound field, notice, partner; fixed step -640. */
  readonly tactical: TacticalSystem;
  /** Markers, photos, custody ledger, dusting, tape, canvass, K9; fixed step -675. */
  readonly investigation: InvestigationSystem;
  /** Shift flow, armory log, loadout, holding cells; fixed step -670. */
  readonly station: StationState;
  /** Phase 5 (law, procedure, consequences): force, incident recorder, conduct, court and their bridges. */
  readonly phase5: Phase5;
  /** Driver input captured each frame; applied to the driven vehicle every fixed step. */
  readonly driverInput: DriverInput = { accelerate: 0, brake: 0, steer: 0, handbrake: false };
  /** Air horn / manual wind-up held this frame (police input); applied to the driven patrol car every fixed step. */
  readonly sirenHeld = { horn: false, manual: false };
  /** The player as the dispatcher sees it (updated every fixed step). */
  readonly playerUnit: PlayerUnitState = { x: 0, z: 0, speed: 0, inPoliceVehicle: false };
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
  /** Patrol equipment of each vehicle (same index as `vehicleList`; null for a model without `equipment`). */
  private readonly equipmentList: (PatrolEquipment | null)[] = [];
  /** What the officer carries (trunk items, a checked-out long gun). */
  private kit = new OfficerKit();
  /** Sim and game time of the current fixed step (dispatch, radio). */
  private readonly cadTime = { sim: 0, game: 0 };
  /** The officer as the NPC system and the scene see them (updated in place every step). */
  private readonly npcFocus: NpcFocus = { x: 0, z: 0, yaw: 0, speed: 0, onFoot: true, weapon: 'none', lights: false, backup: 0 };
  /** Patrol cars with equipment for the scene's presence scan (reused). */
  private readonly patrolInfo: { eid: number; lightbar: boolean; siren: boolean }[] = [];
  /** Last speeding reading per vehicle id (citation prefill). */
  private readonly speedLog = new Map<number, { speedMph: number; limitMph: number }>();
  /** The station's block, grown by `STATION_MARGIN` (booking); null without a station. */
  private readonly stationRect: readonly [number, number, number, number] | null;
  private lastVehicleEid: EntityId = 0;
  private readonly roadHit: RoadHit = { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
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
  /** Last line each person said (statement text for the case file). */
  private readonly lastLine = new Map<number, string>();
  /** Canvass residents (actor id, sim second they leave). */
  private readonly canvassActors: CanvassStay[] = [];
  /** Prisoner moved to the interview room: the cell they return to is `HoldingCells.cellOf`. */
  private interviewActor = 0;
  /** Level of the officer before the last `interior:moveOfficer` (-1 outdoors). */
  private levelBefore = -1;
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
    const graph = city.graph;
    // Phase 2 (design §21): CAD first, then records, the dispatcher and the radio on top of it.
    this.cad = new CadState(this.bus);
    const districtOf = (x: number, z: number): string => DISTRICT_NAMES[city.districtAt(x, z)] ?? '';
    this.records = new RecordsDb(seed, {
      homeEdges: homeEdgesOf(city),
      // `t` is a 0..1 fraction along the edge; the address formatter takes metres.
      formatAddress: (edge, t) => addressOnEdge(graph, edge, t * (graph.edges[edge]?.length ?? 0), districtOf).text,
      today: () => epochDayOfGameSeconds(this.env.time.totalSeconds),
    });
    this.dispatcher = new Dispatcher({
      seed,
      city,
      cad: this.cad,
      records: this.records,
      traffic: this.traffic,
      world: ctx.world,
      bus: this.bus,
      rng: rng.stream('dispatch'),
    });
    const radioMode = ctx.radioMode ?? ((): RadioMode => 'tenCode');
    this.radio = new RadioSystem({
      seed,
      rng: rng.stream('radio'),
      bus: this.bus,
      cad: this.cad,
      graph,
      playerCallsign: this.dispatcher.playerCallsign,
      mode: radioMode,
    });
    this.people = new Population({ seed, records: this.records, now: () => this.env.time.totalSeconds });
    this.npc = new NpcSystem({
      seed,
      rng: rng.stream('npc'),
      city,
      people: this.people,
      traffic: this.traffic,
      world: ctx.world,
      bus: this.bus,
      now: () => this.env.time.totalSeconds,
    });
    // Phase 4 (design §20): buildings, interiors (the officer's level), the station.
    this.buildings = new BuildingIndex(city, { addressAt: (x, z) => addressAt(graph, x, z, districtOf)?.text ?? '' });
    this.interiors = new InteriorSystem({
      seed,
      city,
      physics: ctx.physics,
      bus: this.bus,
      rng: rng.stream('interior'),
      buildings: this.buildings,
      occupants: {
        spawn: (spec) => this.spawnOccupant(spec),
        remove: (id) => this.npc.removeActor(id),
        busy: (id) => this.occupantBusy(id),
        sceneOwns: (b) => this.scene.ownsBuilding(b),
      },
      now: () => this.env.time.totalSeconds,
      kit: () => ({ carried: (item) => this.kit.carried(item) }),
    });
    this.npc.setIndoorNav(this.interiors.navPort());
    this.station = new StationState(seed, () => this.officer, this.bus);
    this.contact = new ContactManager({
      seed,
      bus: this.bus,
      cad: this.cad,
      records: this.records,
      people: this.people,
      npc: this.npc,
      rng: rng.stream('contact'),
      playerCallsign: this.dispatcher.playerCallsign,
      request: (r) => this.dispatcher.request(this.dispatcher.playerCallsign, r, 'auto'),
      officer: () => this.officer,
      presence: () => this.scene.presence,
      officerPosition: (out) => {
        const f = this.syncFocus();
        out.x = f.x;
        out.z = f.z;
        out.yaw = f.yaw;
        out.building = this.interiors.officerBuilding;
      },
      premises: (personId) => this.premisesOf(personId),
      trustAt: (x, z) => this.phase5.conduct.trust(districtOf(x, z)),
      districtOf,
      stopVehicleId: () => this.traffic.stopVehicleId,
      interpreterAvailable: (callId) => this.scene.interpreterAvailable(callId),
      vehiclePosition: (vehicleId, out) => {
        const slot = this.traffic.slotOfVehicle(vehicleId);
        if (slot < 0) return false;
        out.x = this.traffic.view.x[slot] ?? 0;
        out.z = this.traffic.view.z[slot] ?? 0;
        return true;
      },
    });
    this.investigation = new InvestigationSystem({
      seed,
      bus: this.bus,
      rng: rng.stream('investigation'),
      ports: this.investigationPorts(districtOf),
      officer: (out) => this.fillInvestigationOfficer(out),
    });
    this.tactical = new TacticalSystem({
      seed,
      bus: this.bus,
      rng: rng.stream('tactical'),
      city,
      interiors: this.interiors,
      listeners: this.npc,
      officer: (out) => this.fillTacticalOfficer(out),
      radioEarpiece: () => this.station.loadout.radioAudio === 'earpiece',
      nightFactor: () => this.env.lighting.nightFactor,
    });
    this.scene = new SceneDirector({
      seed,
      city,
      bus: this.bus,
      cad: this.cad,
      records: this.records,
      people: this.people,
      npc: this.npc,
      traffic: this.traffic,
      dispatcher: this.dispatcher,
      contact: this.contact,
      rng: rng.stream('scene'),
      kit: () => ({ carried: (item) => this.kit.carried(item), use: (item, n) => this.kit.consume(item, n) }),
      patrolCars: () => this.patrolCars(),
      ...(ctx.indoorScenes === false ? {} : { interiors: this.interiors, buildings: this.buildings, evidence: this.investigation }),
      weaponsAvailable: () => this.station.weaponsAvailable(),
      trustAt: (x, z) => this.phase5.conduct.effects(districtOf(x, z)).cooperation,
      errorScaleAt: (x, z) => this.phase5.conduct.effects(districtOf(x, z)).errorScale,
      hostilityAt: (x, z) => this.phase5.conduct.effects(districtOf(x, z)).hostility,
    });
    this.contact.setResolver(this.scene);
    // Phase 5: force, incidents, conduct and court over the objects above (design 20).
    this.phase5 = new Phase5(this.phase5Host());
    this.dispatcher.setCrimeFactor((d) => this.phase5.conduct.effects(d).crimeFactor);
    this.stationRect = stationRectOf(city);
    this.vehicleEnv = { surfaceAt: (x, z) => city.surfaceAt(x, z), wetness: 0, snowCover: 0, ambientC: 20 };
    const pumps = fuelPumps(city);
    this.pumps = pumps.xz;
    this.stationPumps = pumps.station;
    const offViolation = this.bus.on('traffic:violation', (e) => this.logViolation(e));
    // The prisoner is seated when the contact module cages them (the escort ends at a rear door), not on the arrest itself.
    const offCaged = this.bus.on('contact:caged', (e) => {
      this.equipmentList[e.vehicleIndex]?.seatPrisoner(e.personId);
    });
    // The scene's dispatch lines go out on the radio, from the dispatcher or (a request line) from the player.
    const offRadio = this.bus.on('scene:radio', (e) => {
      this.radio.say(e.channel, e.text, e.speaker ?? undefined);
    });
    // A completed booking puts the person in jail (the contact module records the booking fact itself) and in a cell.
    const offBooking = this.bus.on('cad:documentSaved', (e) => {
      if (e.kind !== 'booking' || !e.final) return;
      const doc = this.cad.docs.get(e.id);
      if (doc?.kind !== 'booking' || doc.personId < 0) return;
      this.people.setCustody(doc.personId, 'jailed');
      this.station.request({ kind: 'hold', personId: doc.personId });
    });
    const offBridges = this.wireBridges();
    this.unsubscribe = () => {
      offViolation();
      offCaged();
      offRadio();
      offBooking();
      offBridges();
    };
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
      { order: -810, system: { name: 'interiors', run: (_world, dt) => this.stepInteriors(dt) } },
      { order: -800, system: { name: 'colliders', run: () => this.updateColliders() } },
      { order: -700, system: { name: 'dispatch', run: (_world, dt) => this.stepDispatch(dt) } },
      { order: -690, system: { name: 'scene', run: (_world, dt) => this.stepScene(dt) } },
      { order: -685, system: { name: 'force', run: (_world, dt) => this.phase5.stepForce(dt, this.syncCadTime()) } },
      { order: -680, system: { name: 'contact', run: (_world, dt) => this.contact.step(dt, this.syncCadTime()) } },
      { order: -675, system: { name: 'investigation', run: (_world, dt) => this.investigation.step(dt, this.syncCadTime()) } },
      { order: -670, system: { name: 'station', run: (_world, dt) => this.station.step(dt, this.syncCadTime()) } },
      { order: -660, system: { name: 'incidents', run: (_world, dt) => this.phase5.stepIncidents(dt, this.syncCadTime()) } },
      { order: -658, system: { name: 'conduct', run: (_world, dt) => this.phase5.stepConduct(dt, this.syncCadTime()) } },
      { order: -656, system: { name: 'court', run: (_world, dt) => this.phase5.stepCourt(dt, this.syncCadTime()) } },
      { order: -650, system: { name: 'radio', run: (_world, dt) => this.stepRadio(dt) } },
      // Phase 1-3 compatibility mode (`indoorScenes: false`, older tests) leaves the tactical awareness off: it draws on the npc streams.
      { order: -640, system: { name: 'tactical', run: (_world, dt) => { if (ctx.indoorScenes !== false) this.tactical.step(dt, this.syncCadTime()); } } },
      { order: 40, system: { name: 'vehicles.pre', run: (_world, dt) => this.preStepVehicles(dt) } },
      { order: 50, system: { name: 'traffic', run: (_world, dt) => this.stepTraffic(dt) } },
      { order: 60, system: { name: 'npc', run: (_world, dt) => this.npc.step(dt, this.clock.simTime, this.syncFocus()) } },
      { order: 110, system: { name: 'vehicles.post', run: (_world, dt) => this.postStepVehicles(dt) } },
    ];
  }

  get player(): EntityId {
    return this.playerEid;
  }

  /** Use of force: tools, TASER, fellow-officer episodes (fixed step -685). */
  get force(): ForceSystem {
    return this.phase5.force;
  }

  /** Incident recorder and legal assessments (fixed step -660). */
  get incidents(): IncidentSystem {
    return this.phase5.incidents;
  }

  /** Report grades, IA, discipline, commendations and community trust (fixed step -658). */
  get conduct(): ConductState {
    return this.phase5.conduct;
  }

  /** Cases, subpoenas and hearings (fixed step -656). */
  get court(): CourtState {
    return this.phase5.court;
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

  /** What the officer carries on foot (trunk items, a checked-out long gun). */
  get officerKit(): OfficerKit {
    return this.kit;
  }

  /** Patrol equipment of `vehicle`, null for a model without `equipment` (or a vehicle of another session). */
  equipmentOf(vehicle: DrivableVehicle | null): PatrolEquipment | null {
    if (!vehicle) return null;
    const i = this.vehicleList.indexOf(vehicle);
    return i < 0 ? null : (this.equipmentList[i] ?? null);
  }

  /** Equipment of the driven patrol car, null on foot or in a car without equipment. */
  get drivenEquipment(): PatrolEquipment | null {
    return this.equipmentOf(this.drivenVehicle);
  }

  /** Equipment of the driven (else the last-driven) patrol car: console commands, HUD, panels. */
  get lastEquipment(): PatrolEquipment | null {
    return this.equipmentOf(this.drivenVehicle ?? this.lastVehicle);
  }

  /** The driven car is a patrol car (its model has `equipment`). */
  get inPatrolCar(): boolean {
    return this.drivenVehicle?.model.equipment != null;
  }

  /** Sim and game time now (CAD timestamps). */
  now(): { sim: number; game: number } {
    return { sim: this.clock.simTime, game: this.env.time.totalSeconds };
  }

  /** Last speeding reading the player observed for `vehicleId` (citation prefill), null when none. */
  observedSpeed(vehicleId: number): { speedMph: number; limitMph: number } | null {
    const s = this.speedLog.get(vehicleId);
    return s ? { speedMph: s.speedMph, limitMph: s.limitMph } : null;
  }

  /** Violations the player observed for `vehicleId`: kind -> count. */
  observedViolations(vehicleId: number): Partial<Record<TrafficViolationKind, number>> {
    return { ...this.violationLog.get(vehicleId) };
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
    return this.addVehicle(model, color, rng, null, (eid) => DrivableVehicle.create(this.ctx.physics, eid, model, pose, rng));
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
    const tactical = this.tactical;
    const px = Transform.x[this.playerEid] ?? 0;
    const pz = Transform.z[this.playerEid] ?? 0;
    const v = scratchVel;
    if (tactical.sliceMove(px, pz, input.forward, input.strafe, dt, scratchSlice)) {
      // Door slicing: a slow pie around the frame, facing where the officer is stepping.
      v.x = scratchSlice.vx;
      v.y = 0;
      v.z = scratchSlice.vz;
      this.controller.yaw = scratchSlice.yaw;
    } else {
      scratchMove.forward = input.forward;
      scratchMove.strafe = input.strafe;
      scratchMove.sprint = input.sprint && !tactical.stance.crouched;
      moveVelocity(scratchMove, this.controller.yaw, v);
      const factor = tactical.speedFactor();
      v.x *= factor;
      v.z *= factor;
    }
    const yaw = this.controller.yaw;
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
    // Indoors the level is a copy of the footprint below the street: nothing outdoors is within reach.
    const indoors = this.interiors.officerBuilding >= 0;
    if (!indoors) {
      // An escorted prisoner at a rear door comes first: the door is often within reach of the driver door.
      if (this.cageCarIndex() >= 0) return 'cage';
      const service = this.pumpService();
      if (service) return service;
      if (this.enterableVehicle()) return 'enter';
      if (this.atStoppedDriver()) return 'driver';
    }
    if (this.talkTarget() !== null) return 'talk';
    if (this.collectTarget() !== null) return 'collect';
    const target = this.interiorTarget();
    const interior = target ? this.interiorHint(target) : null;
    if (interior) return interior;
    return !indoors && this.trunkVehicle() ? 'trunk' : null;
  }

  /**
   * The `interact` action: get out, refuel at a pump or repair and refuel at the station's pump
   * (first, since the driver door is often beside the pump), get in at a driver door, or ask the
   * caller to open the stopped driver's contact panel or a patrol car's trunk panel.
   */
  interact(): InteractResult {
    this.assertLive();
    if (this.driving) return this.exitVehicle();
    const indoors = this.interiors.officerBuilding >= 0;
    if (!indoors) {
      const cage = this.cageCarIndex();
      if (cage >= 0) {
        this.contact.request({ kind: 'cage', vehicleIndex: cage });
        return 'cage';
      }
      const service = this.pumpService();
      const target = this.lastVehicle;
      if (service && target) {
        if (service === 'repair') target.repair();
        target.refuel();
        return service === 'repair' ? 'repaired' : 'refuelled';
      }
      const vehicle = this.enterableVehicle();
      if (vehicle) return this.enterVehicle(vehicle) ? 'entered' : 'none';
      const stop = this.cad.trafficStop;
      if (stop && this.atStoppedDriver()) {
        // The driver (seat 0) of the stopped car; the dialogue opens when the contact module's next step applies this.
        this.contact.request({ kind: 'open', target: { kind: 'occupant', vehicleId: stop.vehicleId, seat: 0 } });
        return 'contact';
      }
    }
    const pick = this.talkTarget();
    if (pick) {
      this.contact.request({ kind: 'open', target: pickTarget(pick) });
      return 'talk';
    }
    const item = this.collectTarget();
    if (item !== null) {
      this.investigation.request({ kind: 'collect', itemId: item });
      return 'collect';
    }
    const interior = this.interiorTarget();
    if (interior) {
      const result = this.interactInterior(interior);
      if (result !== 'none') return result;
    }
    return !indoors && this.trunkVehicle() ? 'trunk' : 'none';
  }

  /** On foot: the person in front of the officer within `TALK_DISTANCE` (scratch, valid until the next call); null when none. */
  talkTarget(): PersonPick | null {
    if (this.driving || this.playerEid === 0) return null;
    const f = this.syncFocus();
    return this.npc.nearestPerson(f.x, f.z, f.yaw, TALK_DISTANCE, TALK_CONE_COS, scratchPick, f.building ?? -1);
  }

  /**
   * The index (into `vehicles`) of the patrol car whose empty cage the escorted prisoner can be put into: the
   * prisoner follows within `CAGE_PRISONER_DISTANCE` and the officer stands within `CAGE_DOOR_DISTANCE` of a
   * rear door. -1 when nobody is escorted or no car qualifies.
   */
  cageCarIndex(): number {
    if (this.driving || this.playerEid === 0) return -1;
    const id = this.contact.escorting();
    if (id <= 0) return -1;
    const actor = this.npc.actor(id, scratchActor);
    if (!actor) return -1;
    const at = this.playerPosition(scratchPoint);
    if (Math.hypot(actor.x - at.x, actor.z - at.z) > CAGE_PRISONER_DISTANCE) return -1;
    for (let i = 0; i < this.vehicleList.length; i++) {
      const eq = this.equipmentList[i];
      if (!eq || !eq.spec.partition || eq.prisoner >= 0) continue;
      const v = this.vehicleList[i] as DrivableVehicle;
      const eid = v.eid;
      const yaw = this.yawOf(eid);
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      // Rear doors: just behind the centre, on both sides (local +Z is the rear, +X the right).
      const back = v.model.body.length * 0.15;
      const side = v.model.body.width / 2 + 0.2;
      const cx = (Transform.x[eid] ?? 0) + sin * back;
      const cz = (Transform.z[eid] ?? 0) + cos * back;
      for (const sign of [-1, 1] as const) {
        const dx = cx + cos * side * sign;
        const dz = cz - sin * side * sign;
        if (Math.hypot(at.x - dx, at.z - dz) <= CAGE_DOOR_DISTANCE) return i;
      }
    }
    return -1;
  }

  // --- patrol interactions (design §13.4) -----------------------------------------------

  /** On foot within `TRUNK_DISTANCE` of the rear centre of a patrol car with a trunk: that car. */
  trunkVehicle(): DrivableVehicle | null {
    if (this.driving) return null;
    const at = this.playerPosition(scratchPoint);
    let best: DrivableVehicle | null = null;
    let bestD = TRUNK_DISTANCE;
    for (let i = 0; i < this.vehicleList.length; i++) {
      const v = this.vehicleList[i] as DrivableVehicle;
      if (!this.equipmentList[i]?.spec.trunk) continue;
      const eid = v.eid;
      const yaw = this.yawOf(eid);
      const half = v.model.body.length / 2;
      // Local +Z is the rear: (x, z) + half * (sin yaw, cos yaw).
      const rx = (Transform.x[eid] ?? 0) + half * Math.sin(yaw);
      const rz = (Transform.z[eid] ?? 0) + half * Math.cos(yaw);
      const d = Math.hypot(at.x - rx, at.z - rz);
      if (d <= bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  /** On foot at the stopped car's driver window (the car is stopped at the curb, the CAD stop is active). */
  atStoppedDriver(): boolean {
    if (this.driving) return false;
    const stop = this.cad.trafficStop;
    if (!stop || stop.outcome !== 'active') return false;
    const st = this.traffic.stopState(scratchStop);
    if (!st || st.phase !== 'stopped' || st.vehicleId !== stop.vehicleId) return false;
    const model = VEHICLE_MODELS[VehicleLook.model[st.eid] ?? 0];
    if (!model) return false;
    const c = this.candidate;
    c.eid = st.eid;
    c.x = st.x;
    c.z = st.z;
    c.yaw = st.yaw;
    c.halfWidth = model.body.width / 2;
    c.halfLength = model.body.length / 2;
    c.speed = 0;
    const window = driverDoorPoint(c, scratchDoor);
    const at = this.playerPosition(scratchPoint);
    return Math.hypot(at.x - window.x, at.z - window.z) <= DRIVER_CONTACT_DISTANCE;
  }

  /** The MDT is in reach: driving a patrol car with one, or on foot within `MDT_REACH_DISTANCE` of such a car's driver door. */
  mdtReachable(): boolean {
    const driven = this.drivenVehicle;
    if (driven) return this.equipmentOf(driven)?.spec.mdt === true;
    if (this.nearStationPoint('reportDesk', DESK_REACH)) return true;
    if (this.interiors.officerBuilding >= 0) return false;
    const at = this.playerPosition(scratchPoint);
    for (let i = 0; i < this.vehicleList.length; i++) {
      if (this.equipmentList[i]?.spec.mdt !== true) continue;
      const door = driverDoorPoint(this.candidateOf(this.vehicleList[i] as DrivableVehicle, this.candidate), scratchDoor);
      if (Math.hypot(at.x - door.x, at.z - door.z) <= MDT_REACH_DISTANCE) return true;
    }
    return false;
  }

  /**
   * The patrol car an arrested person is seated in: the last-driven car when its cage is free and it is
   * within `ARREST_CAR_DISTANCE`, else the nearest such car; null when none.
   */
  arrestVehicle(): DrivableVehicle | null {
    const at = this.playerPosition(scratchPoint);
    const usable = (v: DrivableVehicle, i: number): number => {
      const eq = this.equipmentList[i];
      if (!eq || !eq.spec.partition || eq.prisoner >= 0) return Infinity;
      const d = Math.hypot((Transform.x[v.eid] ?? 0) - at.x, (Transform.z[v.eid] ?? 0) - at.z);
      return d <= ARREST_CAR_DISTANCE ? d : Infinity;
    };
    const last = this.lastVehicle;
    if (last && usable(last, this.vehicleList.indexOf(last)) < Infinity) return last;
    let best: DrivableVehicle | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.vehicleList.length; i++) {
      const v = this.vehicleList[i] as DrivableVehicle;
      const d = usable(v, i);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  /** `dispatch:arrest`: seats `personId` in `arrestVehicle()`'s cage; false when no car can take them. */
  seatPrisoner(personId: number): boolean {
    return this.equipmentOf(this.arrestVehicle())?.seatPrisoner(personId) ?? false;
  }

  /** The person in a patrol car's cage (the last-driven car first), -1 when every cage is empty. */
  prisoner(): number {
    const last = this.equipmentOf(this.lastVehicle);
    if (last && last.prisoner >= 0) return last.prisoner;
    for (const eq of this.equipmentList) if (eq && eq.prisoner >= 0) return eq.prisoner;
    return -1;
  }

  /** Booking completed: releases `personId` from the cage holding them (any prisoner when -1); returns who was released, -1 none. */
  releasePrisoner(personId = -1): number {
    for (const eq of this.equipmentList) {
      if (!eq || eq.prisoner < 0) continue;
      if (personId >= 0 && eq.prisoner !== personId) continue;
      return eq.releasePrisoner();
    }
    return -1;
  }

  /** The officer is at the police station (its block, with a small margin): bookings can be completed. */
  atStation(): boolean {
    const r = this.stationRect;
    if (!r) return false;
    const at = this.playerPosition(scratchPoint);
    return at.x >= r[0] && at.x <= r[2] && at.z >= r[1] && at.z <= r[3];
  }

  /** The driven car is (nearly) standing still (rack lock); true on foot. */
  get stopped(): boolean {
    const v = this.drivenVehicle;
    return !v || v.telemetry.groundSpeed < STOPPED_SPEED;
  }

  /** @internal New game, or a save without dispatcher state: roster into CAD, fleet cars at their beats (before traffic populate). */
  startDispatch(): void {
    this.syncPlayerUnit();
    this.dispatcher.start(this.syncCadTime(), this.playerUnit);
  }

  /** @internal After a load: the officer's kit. */
  restoreOfficerKit(save: OfficerKitSave): void {
    this.kit = OfficerKit.restore(save);
  }

  /** @internal After a load: the last speeding readings. */
  restoreSpeeding(saved: SavedSpeeding): void {
    this.speedLog.clear();
    for (const [id, speedMph, limitMph] of saved) this.speedLog.set(id, { speedMph, limitMph });
  }

  /** Seats the officer in `vehicle` (no distance check: scripts, loads); false unless on foot. */
  enterVehicle(vehicle: DrivableVehicle): boolean {
    if (!this.vehicleList.includes(vehicle) || !this.modes.enter(vehicle.eid)) return false;
    // A script or the console seats the officer from anywhere: the officer is outdoors again.
    if (this.interiors.officerBuilding >= 0) {
      this.interiors.leaveBuilding();
      this.levelBefore = -1;
    }
    this.removeOfficerBody();
    this.lastVehicleEid = vehicle.eid;
    // Getting into a patrol car completes the garage step of the shift flow.
    if (this.station.flow.step !== 'onPatrol' && vehicle.model.equipment !== null) this.station.request({ kind: 'complete', step: 'garage' });
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
    // A teleport puts the officer outdoors first (the console never leaves them on an interior level).
    if (this.interiors.officerBuilding >= 0) {
      this.interiors.leaveBuilding();
      this.levelBefore = -1;
      this.npc.transferFollowers(-1, x, z, heading);
    }
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
    this.npc.clearPeds();
    this.updateFocus();
    this.traffic.populate(this.focus, this.env.time);
  }

  /** Ambient traffic cars (not the AI patrol units) nearest the officer first, with their registry record and observed violations. */
  trafficCars(limit: number): TrafficCarRow[] {
    const view = this.traffic.view;
    const at = this.playerPosition(scratchPoint);
    const slots: number[] = [];
    for (let i = 0; i < view.count; i++) if (!isFleetVehicleId(view.vehicleId[i] ?? 0)) slots.push(i);
    const dist = (i: number): number => Math.hypot((view.x[i] ?? 0) - at.x, (view.z[i] ?? 0) - at.z);
    slots.sort((a, b) => dist(a) - dist(b));
    return slots.slice(0, Math.max(0, limit)).map((i) => {
      const id = view.vehicleId[i] ?? 0;
      const record = vehicleRecord(this.seed, id);
      // The plate an officer sees is the mounted one (a donor's for a plate anomaly).
      const mp = mountedPlate(this.seed, id);
      const flags: string[] = [];
      if (mp.anomaly !== 'none') flags.push(`${mp.anomaly} plate (registry ${record.plate})`);
      if (record.stolen) flags.push('stolen');
      if (record.registrationExpired) flags.push('expired registration');
      if (!record.insured) flags.push('uninsured');
      return {
        vehicleId: id,
        plate: mp.plate,
        modelId: record.modelId,
        distance: dist(i),
        speedMph: (view.speed[i] ?? 0) / MPH,
        crashed: view.state[i] === TRAFFIC_STATE.crashed,
        violations: { ...this.violationLog.get(id) },
        flags,
      };
    });
  }

  /**
   * Snapshot of the session (v5 save): officer, vehicles and their equipment, traffic, environment, CAD, dispatch, records,
   * radio, clock and RNG, plus the touched people, pedestrians and actors, open contacts and the scene block.
   */
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
      cad: this.cad.serialize(),
      dispatch: this.dispatcher.serialize(),
      records: this.records.serialize(),
      radio: this.radio.serialize(),
      equipment: this.equipmentList.map((eq) => eq?.serialize() ?? null),
      officerKit: this.kit.serialize(),
      speeding: [...this.speedLog].map(([id, s]): [number, number, number] => [id, s.speedMph, s.limitMph]),
      people: this.people.serialize(),
      npc: this.npc.serialize(),
      contacts: this.contact.serialize(),
      scenes: this.scene.serialize(),
      interiors: this.interiors.serialize(),
      tactical: this.tactical.serialize(),
      investigation: this.investigation.serialize(),
      station: this.station.serialize(),
      ...this.phase5.serialize(),
    };
  }

  /** Removes every entity, body, collider and vehicle the session created. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.phase5.dispose();
    this.investigation.dispose();
    this.tactical.dispose();
    this.contact.dispose();
    this.scene.dispose();
    this.npc.dispose();
    this.interiors.dispose();
    this.radio.dispose();
    this.dispatcher.dispose();
    this.traffic.dispose();
    if (!this.ctx.physics.isDisposed) this.ctx.physics.raw.removeCharacterController(this.mover);
    for (const vehicle of this.vehicleList) {
      vehicle.dispose();
      despawn(this.ctx.world, vehicle.eid);
    }
    this.vehicleList.length = 0;
    this.vehicleRngs.length = 0;
    this.equipmentList.length = 0;
    if (!this.ctx.physics.isDisposed) this.colliders.dispose();
    const all = this.playerEid === 0 ? this.boxEids : [this.playerEid, ...this.boxEids];
    for (const eid of all) this.removeEntity(eid);
    this.boxEids.length = 0;
    this.playerEid = 0;
    this.officerCollider = null;
  }

  // --- loading (module functions below) ----------------------------------------------

  /** @internal Restores a saved vehicle with its colour, RNG stream and patrol equipment (new-car equipment when null). */
  restoreVehicle(saved: SavedVehicle, equipment: EquipmentSave | null = null): DrivableVehicle {
    this.assertLive();
    const model = vehicleModel(saved.modelId);
    const rng = rngFromState(saved.rng);
    return this.addVehicle(model, saved.color, rng, equipment, (eid) => DrivableVehicle.restore(this.ctx.physics, eid, saved, rng));
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

  // --- Phase 5: law, procedure, consequences (design 20) -----------------------------------

  /** The reads the Phase 5 systems make of this session. */
  private phase5Host(): import('./phase5').Phase5Host {
    return {
      seed: this.seed,
      rng: this.rng,
      bus: this.bus,
      cad: this.cad,
      dispatcher: this.dispatcher,
      scene: this.scene,
      npc: this.npc,
      people: this.people,
      records: this.records,
      investigation: this.investigation,
      station: this.station,
      interiors: this.interiors,
      tactical: this.tactical,
      contact: this.contact,
      env: this.env,
      radio: this.radio,
      simNow: () => this.clock.simTime,
      observedViolations: (vehicleId) => this.violationLog.get(vehicleId) ?? NO_VIOLATIONS,
      forceOfficer: (out) => this.fillForceOfficer(out),
      officerProbe: (out) => this.fillOfficerProbe(out),
      dashProbe: (out) => this.fillDashProbe(out),
      pursuitProbe: (out) => this.fillPursuitProbe(out),
    };
  }

  private fillForceOfficer(out: ForceOfficer): ForceOfficer {
    const f = this.syncFocus();
    out.x = f.x;
    out.z = f.z;
    out.yaw = f.yaw;
    out.building = f.building ?? -1;
    out.onFoot = f.onFoot;
    out.moving = f.speed > FORCE_MOVING_SPEED;
    out.crouched = this.tactical.stance.crouched;
    out.callId = this.cad.unit(this.dispatcher.playerCallsign)?.callId ?? 0;
    return out;
  }

  private fillOfficerProbe(out: OfficerProbe): void {
    const at = this.playerPosition(scratchPoint);
    out.x = at.x;
    out.z = at.z;
    out.building = this.interiors.officerBuilding;
    out.inVehicle = this.driving;
    out.weapon = this.scene.officerWeapon;
  }

  private fillDashProbe(out: DashProbe): void {
    const v = this.lastVehicle;
    out.lights = v !== null && v.lightbar;
    if (!v) {
      out.nearCar = false;
      return;
    }
    const at = this.playerPosition(scratchPoint);
    out.nearCar = this.driving || Math.hypot(at.x - (Transform.x[v.eid] ?? 0), at.z - (Transform.z[v.eid] ?? 0)) <= RECORDING.dashRangeM;
  }

  /** The driven patrol car's speed, the posted limit under it, conditions and lights (pursuit policy). */
  private fillPursuitProbe(out: PursuitProbe): boolean {
    const v = this.drivenVehicle;
    if (!v || !this.inPatrolCar) return false;
    const at = this.playerPosition(scratchPoint);
    out.speedMph = v.telemetry.groundSpeed / MPH;
    const graph = this.city.graph;
    const hit = graph.nearestEdge(at.x, at.z, PURSUIT_ROAD_RADIUS, this.roadHit);
    out.limitMph = hit ? graph.effectiveSpeedLimitMph(hit.edge, this.env.time) : 0;
    out.district = DISTRICT_NAMES[this.city.districtAt(at.x, at.z)] ?? '';
    out.wet = this.env.weather.wetness > WET_ROAD;
    out.night = this.env.lighting.nightFactor > NIGHT_FACTOR;
    out.lights = v.lightbar;
    out.siren = this.equipmentOf(v)?.sirenOn ?? false;
    return true;
  }

  // --- Phase 4: interiors, tactical, investigation, station (design §20) -------------------

  /** Building the officer is in, -1 outdoors. */
  get officerBuilding(): number {
    return this.interiors.officerBuilding;
  }

  /** @internal After the interiors restored: the officer's level bookkeeping follows the restored building. */
  syncLevel(): void {
    this.levelBefore = this.interiors.officerBuilding;
  }

  /** Room index of the officer in their building, -1 outdoors. */
  officerRoom(): number {
    const b = this.interiors.officerBuilding;
    if (b < 0) return -1;
    const layout = this.interiors.layout(b);
    if (!layout) return -1;
    const at = this.playerPosition(scratchPoint);
    return roomAt(layout, at.x, at.z);
  }

  /** Fixed step -810. */
  private stepInteriors(dt: number): void {
    // In a car nothing indoors is within reach: no residency churn (colliders, ambient occupants) while driving past buildings.
    if (this.driving) return;
    const at = this.playerPosition(scratchPoint);
    const o = scratchOfficerAt;
    o.x = at.x;
    o.z = at.z;
    o.yaw = this.controller.yaw;
    o.building = this.interiors.officerBuilding;
    o.onFoot = !this.driving;
    this.interiors.step(dt, o);
    if (this.canvassActors.length > 0) this.stepCanvassActors();
  }

  private fillInvestigationOfficer(out: InvestigationOfficer): InvestigationOfficer {
    const b = this.interiors.officerBuilding;
    const at = this.playerPosition(scratchPoint);
    out.x = at.x;
    out.y = levelY(b);
    out.z = at.z;
    out.yaw = this.controller.yaw;
    out.pitch = this.controller.pitch;
    out.building = b;
    const layout = b >= 0 ? this.interiors.layout(b) : null;
    out.room = layout ? roomAt(layout, at.x, at.z) : -1;
    out.onFoot = !this.driving;
    out.badge = this.officer.badge;
    out.flashlight = this.tactical.flashlightOn;
    return out;
  }

  private fillTacticalOfficer(out: OfficerPose): OfficerPose {
    const at = this.playerPosition(scratchPoint);
    out.x = at.x;
    out.z = at.z;
    out.yaw = this.controller.yaw;
    out.pitch = this.controller.pitch;
    out.building = this.interiors.officerBuilding;
    const v = this.driving ? null : this.ctx.physics.getBody(this.playerEid)?.linvel(scratchVel);
    out.speed = v ? Math.hypot(v.x, v.z) : 0;
    out.onFoot = !this.driving;
    return out;
  }

  /** `OccupantPort.spawn`: an ambient actor in the building; residents get the building's address. */
  private spawnOccupant(spec: OccupantSpawn): number {
    const id = this.npc.spawnActor({
      personId: spec.personId,
      x: spec.x,
      z: spec.z,
      yaw: spec.yaw,
      profile: spec.profile,
      role: spec.role,
      callId: 0,
      hidden: false,
      body: 'human',
      weapon: null,
      vehicleId: -1,
      pose: spec.pose,
      building: spec.buildingId,
    });
    if (id > 0 && spec.role === 'resident') {
      const address = this.buildings.building(spec.buildingId)?.address ?? '';
      if (address !== '') this.records.setAddress(spec.personId, address);
    }
    return id;
  }

  /** In a contact, cuffed, escorted, on a call or a prisoner: never removed when the building unloads. */
  private occupantBusy(actorId: number): boolean {
    const a = this.npc.actor(actorId, scratchActor);
    if (!a) return false;
    return a.cuffed || a.following || a.callId > 0 || a.role === 'prisoner' || this.contact.contactOfPerson(a.personId) >= 0;
  }

  /** `ContactDeps.premises`: scene people first, else an ambient resident or staff member of the building the officer is in. */
  private premisesOf(personId: number): { buildingId: number; authority: boolean; room: number } | null {
    const fromScene = this.scene.premises(personId);
    if (fromScene) return fromScene;
    const b = this.interiors.officerBuilding;
    if (b < 0) return null;
    const id = this.npc.actorOfPerson(personId);
    const a = id > 0 ? this.npc.actor(id, scratchActor) : null;
    if (!a || a.building !== b) return null;
    return { buildingId: b, authority: a.role === 'resident' || a.role === 'staff', room: this.officerRoom() };
  }

  /** Ports of the investigation system over the scene, CAD, npc, interiors, kit and station loadout. */
  private investigationPorts(districtOf: (x: number, z: number) => string): InvestigationPorts {
    const graph = this.city.graph;
    const ids: number[] = [];
    const doorOpen = (building: number) => (door: number): boolean => {
      const st = this.interiors.doorState(building, door);
      return st === 'open' || st === 'broken';
    };
    return {
      callContext: (id) => (id <= 0 ? null : this.scene.callContext(id)),
      currentCall: () => this.cad.unit(this.dispatcher.playerCallsign)?.callId ?? 0,
      incidentOf: (id) => (id <= 0 ? '' : callNumber(id)),
      spawnResident: (building, personId, callId, role) => this.spawnCanvassResident(building, personId, callId, role),
      trunkLocker: () => this.trunkLocker(),
      residentOf: (building, index) => residentPerson(this.seed, building, index),
      hiddenActors: (building, out) => {
        this.npc.actorsInBuilding(building, ids);
        let n = 0;
        for (const id of ids) {
          if (n >= out.length) break;
          const a = this.npc.actor(id, scratchActor);
          if (!a?.hidden) continue;
          const slot = out[n] as { actorId: number; x: number; z: number };
          slot.actorId = a.id;
          slot.x = a.x;
          slot.z = a.z;
          n++;
        }
        return n;
      },
      setNoGoZones: (zones: readonly NoGoZone[]) => this.npc.setNoGoZones(zones),
      kit: () => ({
        carried: (item) => this.kit.carried(item),
        use: (item, n) => this.kit.consume(item, n),
        give: (item, n) => this.kit.adjust(item, n),
      }),
      bodycamWorn: () => this.station.loadout.bodycamMount !== 'none',
      nightFactor: () => this.env.lighting.nightFactor,
      lineOfSight: (building, ax, ay, az, bx, by, bz, ignore) => {
        if (building < 0) return true;
        const layout = this.interiors.layout(building);
        return layout === null || lineOfSight(layout, doorOpen(building), ax, ay, az, bx, by, bz, ignore);
      },
      roomLit: (building, room) => this.interiors.roomLit(building, room),
      businessOpen: (building) => {
        const layout = this.interiors.layout(building);
        return layout !== null && !layout.residential && isOpenAt(layout.occupants.openHours, hourOf(this.env.time.totalSeconds));
      },
      layout: (building) => (building < 0 ? null : this.interiors.layout(building)),
      addressOf: (building) => (building < 0 ? '' : (this.buildings.building(building)?.address ?? '')),
      describeDirection: (fx, fz, tx, tz) => {
        const dx = tx - fx;
        const dz = tz - fz;
        const dir = Math.abs(dz) >= Math.abs(dx) ? (dz < 0 ? 'north' : 'south') : dx > 0 ? 'east' : 'west';
        const street = addressAt(graph, tx, tz, districtOf)?.street ?? '';
        return street === '' ? dir : `${dir} on ${street}`;
      },
      describePerson: (personId) => {
        const d = describePerson(this.people.identity(personId));
        return `${d.sex === 'M' ? 'man' : 'woman'} ${d.ageBand}, ${d.top} top, ${d.bottom}, ${d.hair}, ${d.heightText}`;
      },
      doorBuilding: (x, z) => {
        const b = this.buildings.nearestEntrance(x, z, 4);
        const exit = b ? this.interiors.layout(b.id)?.doors.find((d) => d.main)?.exit : undefined;
        return b && exit && Math.hypot(x - exit.x, z - exit.z) <= 1.8 ? b.id : -1;
      },
    };
  }

  /**
   * Canvass: the resident comes to the door (a witness is registered with the scene for the call). A resident who is
   * already an ambient occupant of the building is walked out to the door and back inside afterwards; one who is
   * asleep, hiding or otherwise busy does not answer.
   */
  private spawnCanvassResident(building: number, personId: number, callId: number, role: 'witness' | 'resident'): number {
    const exit = this.interiors.layout(building)?.doors.find((d) => d.main)?.exit;
    if (!exit || personId < 0) return 0;
    let id = this.npc.actorOfPerson(personId);
    let home: CanvassHome | null = null;
    if (id > 0) {
      const a = this.npc.actor(id, scratchActor);
      if (!a || !CANVASS_MOVABLE.has(a.state) || a.cuffed || a.following || a.callId > 0 || this.contact.contactOfPerson(personId) >= 0) return 0;
      const at = a.building ?? -1;
      if (at >= 0) home = { building: at, x: a.x, z: a.z, yaw: a.yaw };
      this.npc.setActorPosition(id, -1, exit.x, exit.z, exit.yaw);
      this.npc.forceState(id, 'hold');
    } else {
      id = this.npc.spawnActor({
        personId,
        x: exit.x,
        z: exit.z,
        yaw: exit.yaw,
        profile: 'bystander',
        role,
        callId: 0,
        hidden: false,
        body: 'human',
        weapon: null,
        vehicleId: -1,
        building: -1,
      });
    }
    if (id <= 0) return 0;
    if (role === 'witness') this.scene.addWitness(callId, personId);
    const address = this.buildings.building(building)?.address ?? '';
    if (address !== '') this.records.setAddress(personId, address);
    this.canvassActors.push({ id, until: this.clock.simTime + CANVASS_STAY_S, home });
    return id;
  }

  /**
   * After a load: re-derives the session-only links that are not saved. The interviewee is the station's saved
   * interview person; a resident or witness left standing at a door (outdoors, in `hold`, on no call) was a canvass
   * contact whose home is lost, so they leave the area as soon as the officer is not talking to them.
   */
  restoreTransients(): void {
    const sid = this.station.interviewing;
    this.interviewActor = sid >= 0 ? this.npc.actorOfPerson(sid) : 0;
    this.canvassActors.length = 0;
    const ids = this.npc.actorIds(scratchIds);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as number;
      const a = this.npc.actor(id, scratchActor);
      if (!a || (a.building ?? -1) >= 0 || a.callId > 0 || a.state !== ACTOR_STATE.hold) continue;
      if (a.role !== 'resident' && a.role !== 'witness') continue;
      this.canvassActors.push({ id, until: this.clock.simTime, home: null });
    }
  }

  /** Canvass residents leave their door after `CANVASS_STAY_S` unless the officer is talking to them. */
  private stepCanvassActors(): void {
    const list = this.canvassActors;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i] as CanvassStay;
      if (this.clock.simTime < c.until) continue;
      const a = this.npc.actor(c.id, scratchActor);
      if (a && this.contact.contactOfPerson(a.personId) >= 0) continue;
      if (a && c.home !== null) {
        // An occupant walks home (a teleport inside, like the move to the door); anyone else leaves the area.
        this.npc.setActorPosition(c.id, c.home.building, c.home.x, c.home.z, c.home.yaw);
        this.npc.forceState(c.id, 'idle');
      } else if (a) this.npc.forceState(c.id, 'leave');
      list.splice(i, 1);
    }
  }

  /** Custodian id of the patrol car trunk within reach (`locker:<car index>`), '' when none. */
  trunkLocker(): string {
    const v = this.trunkVehicle();
    return v === null ? '' : `locker:${String(this.vehicleList.indexOf(v))}`;
  }

  /** G on foot: the officer's shout also goes out as a sound (85 dB) that actors in other rooms and outdoors can hear. */
  shout(): void {
    if (this.playerEid === 0 || this.driving) return;
    const at = this.playerPosition(scratchPoint);
    this.tactical.request({ kind: 'sound', source: 'voiceShout', x: at.x, z: at.z, building: this.interiors.officerBuilding });
  }

  /** The station block's interior point of `kind` (first one), null without a station layout. */
  stationPoint(kind: string, nth = 0): { x: number; z: number; yaw: number } | null {
    const st = this.buildings.station();
    const layout = st ? this.interiors.layout(st.id) : null;
    if (!layout) return null;
    let n = 0;
    for (const p of layout.points) {
      if (p.kind !== kind) continue;
      if (n++ === nth) return p;
    }
    return null;
  }

  /** The officer is inside the station within `reach` of a point of `kind`. */
  private nearStationPoint(kind: string, reach: number): boolean {
    const st = this.buildings.station();
    if (!st || this.interiors.officerBuilding !== st.id) return false;
    const p = this.stationPoint(kind);
    if (!p) return false;
    const at = this.playerPosition(scratchPoint);
    return Math.hypot(at.x - p.x, at.z - p.z) <= reach;
  }

  /** The officer is inside the station within reach of the evidence room's deposit point. */
  nearEvidenceRoom(): boolean {
    return this.nearStationPoint('evidence', EVIDENCE_REACH);
  }

  /** The nearest found item within reach of the officer: its id (scratch-free), null when none. */
  collectTarget(): string | null {
    if (this.driving || this.playerEid === 0) return null;
    const at = this.playerPosition(scratchPoint);
    const it = this.investigation.nearestItem(at.x, at.z, this.interiors.officerBuilding, COLLECT_REACH);
    return it !== null && it.state === 'found' ? it.id : null;
  }

  /** Nearest interior interactable at the officer (scratch object, valid until the next call). */
  private interiorTarget(): InteriorInteractable | null {
    if (this.driving || this.playerEid === 0) return null;
    const at = this.playerPosition(scratchPoint);
    return this.interiors.nearestInteractable(at.x, at.z, this.controller.yaw, this.interiors.officerBuilding);
  }

  private interiorHint(t: InteriorInteractable): InteractHint {
    switch (t.kind) {
      case 'entrance':
        return this.interiors.doorState(t.buildingId, t.door) === 'locked' ? 'locked' : 'enterBuilding';
      case 'exit':
        return 'exitBuilding';
      case 'door':
        return t.state === 'locked' ? 'locked' : 'door';
      case 'switch':
        return 'switch';
      case 'point':
        switch (t.pointKind) {
          case 'locker':
            return 'locker';
          case 'briefing':
            return 'briefing';
          case 'armory':
            return 'armory';
          case 'evidence':
            return 'evidence';
          case 'reportDesk':
          case 'booking':
            return 'reportDesk';
          case 'interview':
            return 'interview';
          case 'cell':
            return 'cell';
          default:
            return null;
        }
    }
  }

  /** The door the officer is at, for the door panel (an exterior door from outdoors, or any door indoors). */
  doorTarget(): DoorTarget | null {
    const t = this.interiorTarget();
    if (!t) return null;
    if (t.kind === 'entrance') return { buildingId: t.buildingId, door: t.door, outdoors: true, locked: this.interiors.doorState(t.buildingId, t.door) === 'locked' };
    if (t.kind === 'door') return { buildingId: t.buildingId, door: t.door, outdoors: false, locked: t.state === 'locked' };
    if (t.kind === 'exit') return { buildingId: t.buildingId, door: t.door, outdoors: false, locked: this.interiors.doorState(t.buildingId, t.door) === 'locked' };
    return null;
  }

  /** The door panel's door is still within reach (3 m of its opening, or of its outside pose from outdoors). */
  doorStillThere(t: DoorTarget): boolean {
    if (this.driving || this.playerEid === 0) return false;
    const d = this.interiors.layout(t.buildingId)?.doors[t.door];
    if (!d) return false;
    const at = this.playerPosition(scratchPoint);
    if (t.outdoors) return this.interiors.officerBuilding < 0 && d.exit !== null && Math.hypot(at.x - d.exit.x, at.z - d.exit.z) <= DOOR_PANEL_REACH;
    return this.interiors.officerBuilding === t.buildingId && Math.hypot(at.x - d.x, at.z - d.z) <= DOOR_PANEL_REACH;
  }

  /** A neighbour can be canvassed at `buildingId`: the player's call is bound elsewhere and within 150 m. */
  canvassAllowed(buildingId: number): boolean {
    const callId = this.cad.unit(this.dispatcher.playerCallsign)?.callId ?? 0;
    const call = callId > 0 ? this.scene.callContext(callId) : null;
    if (!call || call.buildingId === buildingId) return false;
    const at = this.playerPosition(scratchPoint);
    return Math.hypot(at.x - call.anchorX, at.z - call.anchorZ) <= CANVASS_CALL_REACH;
  }

  private interactInterior(t: InteriorInteractable): InteractResult {
    switch (t.kind) {
      case 'entrance':
        if (this.interiors.doorState(t.buildingId, t.door) === 'locked') return 'doorPanel';
        this.interiors.request({ kind: 'enter', buildingId: t.buildingId, door: t.door });
        return 'interior';
      case 'exit':
        this.interiors.request({ kind: 'exit', door: t.door });
        return 'interior';
      case 'door':
        if (t.state === 'locked') return 'doorPanel';
        this.interiors.request({ kind: 'door', buildingId: t.buildingId, door: t.door, action: 'toggle' });
        return 'interior';
      case 'switch':
        this.interiors.request({ kind: 'switch', buildingId: t.buildingId, room: t.room });
        return 'interior';
      case 'point':
        switch (t.pointKind) {
          case 'locker':
            return 'locker';
          case 'briefing':
            return 'briefing';
          case 'armory':
            return 'armory';
          case 'evidence':
            this.investigation.request({ kind: 'deposit' });
            return 'evidence';
          case 'reportDesk':
          case 'booking':
            return 'reportDesk';
          case 'interview':
            return 'interview';
          case 'cell': {
            const id = this.contact.escorting();
            const a = id > 0 ? this.npc.actor(id, scratchActor) : null;
            if (a) this.station.request({ kind: 'hold', personId: a.personId });
            return 'cell';
          }
          default:
            return 'none';
        }
    }
  }

  /** A new shift: the officer in the station's locker room, flow `locker`, the unit out of service until the garage step. */
  beginShiftInStation(): boolean {
    const st = this.buildings.station();
    const locker = this.stationPoint('locker');
    if (!st || !locker) return false;
    this.interiors.placeOfficerInside(st.id, locker);
    if (this.interiors.officerBuilding !== st.id) return false;
    this.station.restore(newShiftStationSave());
    // The field kit: markers, bags, camera, dust kit and tape; the ram stays in the trunk.
    for (const [item, n] of FIELD_KIT) this.kit.adjust(item, n);
    this.dispatcher.request(this.dispatcher.playerCallsign, { kind: 'status', status: 'outOfService' }, 'auto');
    return true;
  }

  /** `interior:moveOfficer`: teleports the body to the level, keeps followers and the partner with the officer. */
  private onMoveOfficer(e: InteriorMoveOfficerEvent): void {
    const prev = this.levelBefore;
    this.levelBefore = e.buildingId;
    if (this.playerEid === 0 || this.driving) return;
    const body = this.ctx.physics.getBody(this.playerEid);
    if (body) {
      const y = (e.buildingId >= 0 ? e.y : 0) + PLAYER_SIZE.y / 2;
      body.setTranslation({ x: e.x, y, z: e.z }, true);
      body.setRotation(yawQuaternion(e.yaw, scratchQuat), true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.writeInitialTransform(this.playerEid);
    }
    this.controller.yaw = e.yaw;
    this.npc.transferFollowers(e.buildingId, e.x, e.z, e.yaw);
    this.tactical.teleportPartner(e.buildingId, e.x, e.z, e.yaw);
    // Leaving the station through the garage door completes the garage step.
    const st = this.buildings.station();
    if (e.buildingId < 0 && st && prev === st.id && this.station.flow.step !== 'onPatrol') {
      const wide = this.interiors.layout(st.id)?.doors.find((d) => d.kind === 'wide' && d.exit && Math.abs(d.exit.x - e.x) < 0.05 && Math.abs(d.exit.z - e.z) < 0.05);
      if (wide) this.station.request({ kind: 'complete', step: 'garage' });
    }
  }

  private onStationStep(step: ShiftStep): void {
    if (step === 'onPatrol') this.dispatcher.request(this.dispatcher.playerCallsign, { kind: 'status', status: 'available' }, 'auto');
  }

  /** A prisoner placed in a cell (or released): the actor sits in the cell. */
  private onHolding(e: { personId: number; cell: number; placed: boolean }): void {
    const existing = this.npc.actorOfPerson(e.personId);
    if (existing > 0) this.npc.removeActor(existing);
    if (!e.placed) return;
    const st = this.buildings.station();
    const p = this.stationPoint('cell', e.cell) ?? this.stationPoint('cell');
    if (!st || !p) return;
    this.npc.spawnActor({
      personId: e.personId, x: p.x, z: p.z, yaw: p.yaw, profile: 'suspectCalm', role: 'prisoner', callId: 0,
      hidden: false, body: 'human', weapon: null, vehicleId: -1, pose: 'sit', building: st.id,
    });
  }

  /** The interview room: the prisoner is brought to the table and the conversation opens; ended, they return to their cell. */
  private onInterview(personId: number): void {
    const st = this.buildings.station();
    if (!st) return;
    if (this.interviewActor > 0) {
      const back = this.npc.actor(this.interviewActor, scratchActor);
      const cell = back ? this.station.holding.cellOf(back.personId) : -1;
      const p = cell >= 0 ? (this.stationPoint('cell', cell) ?? this.stationPoint('cell')) : null;
      if (back && p) this.npc.setActorPosition(this.interviewActor, st.id, p.x, p.z, p.yaw);
      this.interviewActor = 0;
    }
    if (personId < 0) return;
    const id = this.npc.actorOfPerson(personId);
    const layout = this.interiors.layout(st.id);
    const spot = layout?.points.find((q) => q.kind === 'interview');
    if (id <= 0 || !layout || !spot) return;
    // Across the table: the point is the officer's stand position 0.6 m before it.
    const seat = beyondFurniture(layout.furniture[spot.furniture], spot, INTERVIEW_BEYOND, scratchSeat);
    this.npc.setActorPosition(id, st.id, seat.x, seat.z, spot.yaw + Math.PI);
    this.interviewActor = id;
    this.contact.request({ kind: 'open', target: { kind: 'actor', actorId: id } });
  }

  /** The cross-system bridges of design §14 (synchronous, inside the emitting step); returns the unsubscribe. */
  private wireBridges(): () => void {
    const bus = this.bus;
    const offs: (() => void)[] = [
      bus.on('interior:moveOfficer', (e) => this.onMoveOfficer(e)),
      bus.on('interior:door', (e) => {
        const source = DOOR_SOUND[e.action];
        if (source !== undefined) this.tactical.request({ kind: 'sound', source, x: e.x, z: e.z, building: e.buildingId });
        this.scene.onDoorEvent(e);
      }),
      bus.on('contact:consent', (e) => {
        const premises = e.kind === 'entry' || e.kind === 'searchPremises' || e.kind === 'searchRoom';
        this.investigation.recordConsent({
          callId: e.callId,
          personId: e.personId,
          kind: e.kind,
          granted: e.granted,
          valid: e.valid,
          authority: premises ? (this.premisesOf(e.personId)?.authority ?? false) : true,
          buildingId: e.buildingId,
          room: e.room,
          vehicleId: -1,
          sim: e.sim,
          revokedSim: -1,
        });
      }),
      bus.on('contact:line', (e) => {
        if (e.speaker === 'subject') this.lastLine.set(e.personId, e.text);
      }),
      bus.on('contact:event', (e) => {
        if (e.flag === 'statement') {
          this.investigation.recordStatement(e.callId, { personId: e.personId, role: e.role, text: this.lastLine.get(e.personId) ?? 'Gave a statement.', sim: this.clock.simTime });
        } else if (e.flag === 'custody') {
          this.investigation.recordArrest(e.callId, e.personId, this.interiors.officerBuilding, this.officerRoom(), this.clock.simTime);
        }
      }),
      bus.on('scene:service', (e) => {
        if (e.kind === 'k9' && e.phase === 'arrived') this.investigation.startK9(e.callId);
      }),
      bus.on('investigation:photo', (e) => this.scene.onInvestigation('investigation:photo', e)),
      bus.on('investigation:collected', (e) => this.scene.onInvestigation('investigation:collected', e)),
      bus.on('investigation:canvass', (e) => this.scene.onInvestigation('investigation:canvass', e)),
      bus.on('investigation:tape', (e) => this.scene.onInvestigation('investigation:tape', e)),
      bus.on('investigation:plainView', (e) => this.scene.onInvestigation('investigation:plainView', e)),
      bus.on('investigation:custodyComplete', (e) => this.scene.onInvestigation('investigation:custodyComplete', e)),
      bus.on('investigation:k9Alert', (e) => this.scene.onInvestigation('investigation:k9Alert', e)),
      bus.on('investigation:radio', (e) => this.radio.say('dispatch', e.text, 'K-9')),
      bus.on('npc:aware', (e) => this.scene.onNpcAware(e)),
      bus.on('station:step', (e) => this.onStationStep(e.step)),
      bus.on('station:holding', (e) => this.onHolding(e)),
      bus.on('station:interview', (e) => this.onInterview(e.personId)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }

  // --- fixed-step systems -----------------------------------------------------------

  private updateColliders(): void {
    const at = this.playerPosition(scratchPoint);
    this.colliders.update(at.x, at.z);
  }

  /** Sim and game time of this step into the reused `cadTime` (nothing stores the reference; CAD copies times). */
  private syncCadTime(): { sim: number; game: number } {
    const t = this.cadTime;
    t.sim = this.clock.simTime;
    t.game = this.env.time.totalSeconds;
    return t;
  }

  /** The player as the dispatcher sees it: position (the seat while driving), speed, in a patrol car. */
  private syncPlayerUnit(): void {
    const at = this.playerPosition(scratchPoint);
    const p = this.playerUnit;
    p.x = at.x;
    p.z = at.z;
    const driven = this.drivenVehicle;
    p.speed = driven ? driven.telemetry.groundSpeed : 0;
    p.inPoliceVehicle = driven !== null && driven.model.equipment !== null;
  }

  /** The officer as the NPC system and the scene see them (updated in place): position, heading, speed, weapon, lights, backup. */
  private syncFocus(): NpcFocus {
    const f = this.npcFocus;
    const at = this.playerPosition(scratchPoint);
    f.x = at.x;
    f.z = at.z;
    f.building = this.interiors.officerBuilding;
    const driven = this.drivenVehicle;
    f.onFoot = driven === null;
    if (driven) {
      f.yaw = this.yawOf(driven.eid);
      f.speed = driven.telemetry.groundSpeed;
    } else {
      f.yaw = this.controller.yaw;
      const v = this.ctx.physics.getBody(this.playerEid)?.linvel(scratchVel);
      f.speed = v ? Math.hypot(v.x, v.z) : 0;
    }
    const presence = this.scene.presence;
    f.weapon = this.scene.officerWeapon;
    f.lights = presence.lights;
    f.backup = presence.backup;
    return f;
  }

  /** The station's patrol cars with equipment (the scene's presence scan); one reused list. */
  private patrolCars(): readonly { eid: number; lightbar: boolean; siren: boolean }[] {
    const out = this.patrolInfo;
    let n = 0;
    for (let i = 0; i < this.vehicleList.length; i++) {
      const eq = this.equipmentList[i];
      if (!eq) continue;
      const v = this.vehicleList[i] as DrivableVehicle;
      let e = out[n];
      if (!e) {
        e = { eid: 0, lightbar: false, siren: false };
        out.push(e);
      }
      e.eid = v.eid;
      e.lightbar = v.lightbar;
      e.siren = eq.sirenOn;
      n++;
    }
    out.length = n;
    return out;
  }

  private stepScene(dt: number): void {
    this.scene.step(dt, this.syncCadTime(), this.syncFocus());
  }

  private stepDispatch(dt: number): void {
    this.syncPlayerUnit();
    this.dispatcher.step(dt, this.syncCadTime(), this.playerUnit);
  }

  private stepRadio(dt: number): void {
    this.radio.step(dt, this.syncCadTime(), this.playerUnit);
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
    const list = this.vehicleList;
    for (let i = 0; i < list.length; i++) {
      const vehicle = list[i] as DrivableVehicle;
      const isDriven = vehicle.eid === driven;
      if (isDriven) vehicle.headlights = this.headlightOverride ?? auto;
      // A parked car drops reverse (no reverse lamps or gear -1 for a car left in reverse).
      const t = vehicle.telemetry;
      mapDriverInput(isDriven ? this.driverInput : PARKED, t.speed, t.groundSpeed, isDriven && vehicle.reversing, this.controls);
      vehicle.setControls(this.controls);
      vehicle.preStep(dt, env);
      const eq = this.equipmentList[i];
      if (eq) {
        // Horn and manual wind-up are held by the driver only.
        eq.horn = isDriven && this.sirenHeld.horn;
        eq.manual = isDriven && this.sirenHeld.manual;
        eq.writeLook(vehicle.eid, vehicle.lightbar);
      }
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
    // Traffic stops and yielding follow the driven patrol car's heading, light bar and siren (design §7.2-7.3).
    if (vehicle) {
      f.heading = this.yawOf(vehicle.eid);
      f.lights = vehicle.model.lightbar && vehicle.lightbar;
      f.siren = this.equipmentOf(vehicle)?.sirenOn ?? false;
    } else {
      f.heading = this.controller.yaw;
      f.lights = false;
      f.siren = false;
    }
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
    if (e.kind === 'speeding') this.speedLog.set(e.vehicleId, { speedMph: e.speedMph, limitMph: e.limitMph });
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
    // A cylinder: the footprint stays 0.8 m wide whatever the facing (a yawed box needs a 1.13 m gap at 45 degrees).
    const body = this.ctx.physics.addCylinder(eid, position, PLAYER_SIZE.y / 2, PLAYER_SIZE.x / 2, { kinematic: true, friction: 0.2 });
    try {
      // The officer is drawn as a humanoid figure (PeopleRenderer); the pool box is a hidden placeholder for the pool slot.
      this.ctx.meshes.addBox(eid, { size: OFFICER_MESH_SIZE, color: PLAYER_COLOR });
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

  /**
   * Entity + `VehicleLook` + `Drivable` (+ `PoliceLights` and its `PatrolEquipment` for a model with
   * `equipment`, from `equipment` when given), then the chassis from `create`; nothing is left behind if it throws.
   */
  private addVehicle(
    model: VehicleModel,
    color: number,
    rng: Rng,
    equipment: EquipmentSave | null,
    create: (eid: EntityId) => DrivableVehicle,
  ): DrivableVehicle {
    const world = this.ctx.world;
    const slot = this.vehicleList.length;
    const eid = spawn(world, Transform, PrevTransform, PhysicsBody);
    let vehicle: DrivableVehicle;
    let eq: PatrolEquipment | null = null;
    try {
      EntityKind.kind[eid] = KIND.Vehicle;
      attachVehicleLook(world, eid, model.index, color);
      attachDrivable(world, eid);
      const spec = model.equipment;
      if (spec) {
        eq = equipment ? PatrolEquipment.restore(spec, equipment) : new PatrolEquipment(spec);
        // Light-bar clock offset from a named stream: the same for this slot in every run and after a load.
        attachPoliceLights(world, eid, this.rng.stream(`lights:${String(slot)}`).next());
        eq.writeLook(eid, false);
      }
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
    this.equipmentList.push(eq);
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

/** The contact target of a `nearestPerson` pick. */
function pickTarget(pick: PersonPick): { kind: 'actor'; actorId: number } | { kind: 'ped'; slot: number } | { kind: 'occupant'; vehicleId: number; seat: number } {
  if (pick.kind === 'actor') return { kind: 'actor', actorId: pick.id };
  if (pick.kind === 'ped') return { kind: 'ped', slot: pick.id };
  return { kind: 'occupant', vehicleId: pick.id, seat: pick.seat };
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

/** The station's block grown by `STATION_MARGIN` as [minX, minZ, maxX, maxZ]; null without a station. */
function stationRectOf(city: City): readonly [number, number, number, number] | null {
  const poi = city.pois.find((p) => p.kind === 'station');
  const block = poi ? city.blocks[poi.block] : undefined;
  if (!block) return null;
  return [block.minX - STATION_MARGIN, block.minZ - STATION_MARGIN, block.maxX + STATION_MARGIN, block.maxZ + STATION_MARGIN];
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

/** Snapshot of the session as a v5 save (see `GameSession.serialize`). */
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
 * Starts a shift for `seed`: the officer on foot at the station door, the equipped patrol cars
 * in the station lot, colliders around the station, the CAD roster with the AI units' fleet
 * cars at their beats, and traffic around the officer. The same seed always yields the same
 * city and the same run for the same inputs.
 */
export function startNewGame(ctx: GameContext, seed: number | string, options: NewGameOptions = {}): GameSession {
  const normalized = normalizeSeed(seed);
  const session = new GameSession(ctx, normalized);
  try {
    const spawnAt = session.city.spawn;
    session.spawnPlayer({ x: spawnAt.x, y: PLAYER_SIZE.y / 2, z: spawnAt.z }, spawnAt.yaw);
    session.parkPatrolCars();
    session.primeColliders();
    // Fleet cars take their lanes before ambient traffic fills the rest (design §21).
    session.startDispatch();
    session.populateTraffic();
    // Phase 4 (design §20): the shift starts in the station's locker room (the station's interior is resident at once).
    if (options.inStation !== false) session.beginShiftInStation();
    else session.station.restore(migratedStationSave(session.officer.badge));
    if (options.jurisdiction !== undefined) session.phase5.setJurisdiction(options.jurisdiction);
    primeContacts(ctx.physics, sessionBodies(session));
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
}

/**
 * Rebuilds a session from a v5 save into `ctx` (use a fresh physics world, see
 * `createScenePhysics`): the city is regenerated from the seed, bodies, vehicles and their
 * equipment get their saved state, traffic, the environment, CAD, records, the dispatcher and
 * the radio continue where they were (an empty vehicle list re-parks the patrol cars, missing
 * traffic is populated afresh, a save without dispatcher state starts a fresh roster and fleet).
 * Load order (design §17): environment, entities, vehicles and equipment, traffic, CAD, records,
 * dispatch, radio. Nothing is left behind if it throws.
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
    data.vehicles.forEach((saved, i) => session.restoreVehicle(saved, data.equipment[i] ?? null));
    const driven = data.player.mode === 'driving' ? session.vehicles[data.player.vehicle] : undefined;
    session.restoreLastVehicle(data.player.lastVehicle ?? -1);
    if (driven) session.enterVehicle(driven);
    session.restoreViolations(data.violations ?? []);
    session.restoreSpeeding(data.speeding ?? []);
    session.restoreOfficerKit(data.officerKit);
    session.restoreHeadlightOverride();
    session.primeColliders();
    if (data.traffic) session.traffic.restore(data.traffic);
    session.cad.restore(data.cad);
    session.records.restore(data.records);
    if (data.dispatch) session.dispatcher.restore(data.dispatch, session.now());
    else session.startDispatch();
    if (!data.traffic) session.populateTraffic();
    // Phase 3 (design §16): people after records (identities regenerate from the viewed record), then the
    // pedestrians and actors (they read people and the traffic view), the scenes (and the calls of a
    // migrated save), then the open contacts.
    session.people.restore(data.people);
    // Phase 4 (design §16): the interiors first (the officer's building resident), then the actors that stand in them.
    session.interiors.restore(data.interiors);
    session.syncLevel();
    if (data.npc) session.npc.restore(data.npc);
    session.tactical.restore(data.tactical);
    session.scene.restore(data.scenes, session.now());
    session.scene.adoptOpenCalls(session.now());
    session.contact.restore(data.contacts);
    session.investigation.restore(data.investigation);
    session.station.restore(data.station);
    // Phase 5 (design 16): force, incidents, conduct, court.
    session.phase5.restore(data);
    session.restoreTransients();
    session.radio.restore(data.radio);
    // Every body was just created with its saved state, so reading them back gives exactly that state.
    primeContacts(ctx.physics, sessionBodies(session));
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
}
