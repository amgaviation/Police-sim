import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng, RngState } from '../core/rng';
import type { GameWorld } from '../ecs/world';
import type { Population } from '../people/population';
import type { HumanoidSource } from '../render/people/pose';
import type { TrafficSystem } from '../traffic/trafficSystem';
import type { City } from '../world/city';

/** Behaviour states of a scene actor (design §8.3). */
export const ACTOR_STATE = {
  idle: 0, wander: 1, talk: 2, follow: 3, hold: 4, handsUp: 5, kneel: 6, prone: 7, cuffed: 8, seated: 9,
  flee: 10, hide: 11, fight: 12, armed: 13, down: 14, lying: 15, leave: 16, crowd: 17, sit: 18, walkTo: 19,
} as const;
export type ActorStateId = (typeof ACTOR_STATE)[keyof typeof ACTOR_STATE];

/** State names by id (debug output). */
export const ACTOR_STATE_NAMES: readonly string[] = Object.keys(ACTOR_STATE);

/** Every command an actor can be given: the 17 officer commands plus the internal `release` and `returnToVehicle`. */
export const NPC_COMMANDS = [
  'stop', 'handsUp', 'getDown', 'turnAround', 'comeHere', 'stayBack', 'followMe', 'sitDown', 'stepOut', 'dropWeapon', 'showHands',
  'leaveArea', 'disperse', 'calmDown', 'turnOffEngine', 'tossKeys', 'walkBackward', 'release', 'returnToVehicle',
] as const;
export type NpcCommand = (typeof NPC_COMMANDS)[number];

export type CommandOutcome = 'comply' | 'refuse' | 'flee' | 'fight' | 'confused';

/** What `NpcSystem.spawnActor` takes (design §8.3). */
export interface ActorSpawn {
  /** Person id, -1 for an animal. */
  readonly personId: number;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  /** A behaviour profile id (`behaviors.json`). */
  readonly profile: string;
  readonly role: string;
  readonly callId: number;
  readonly hidden: boolean;
  readonly body: 'human' | 'dog';
  /** Carried weapon item id (not drawn), or null. */
  readonly weapon: string | null;
  /** Associated vehicle (not seated: seated people are occupants, see `setOccupants`), -1 for none. */
  readonly vehicleId: number;
  readonly pose?: 'stand' | 'sit' | 'lying' | 'kneel';
}

/** `NpcSystem.actor` output. */
export interface ActorInfo {
  id: number;
  personId: number;
  role: string;
  callId: number;
  state: ActorStateId;
  x: number;
  z: number;
  yaw: number;
  stress: number;
  cuffed: boolean;
  following: boolean;
  hidden: boolean;
  armed: boolean;
  weaponDrawn: boolean;
  vehicleId: number;
  seat: number;
  profile: string;
  /** `BODY.human` or `BODY.dog`. */
  body: number;
}

/** The officer as seen by the NPC system, passed to every `step`. */
export interface NpcFocus {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  onFoot: boolean;
  weapon: 'none' | 'sidearm' | 'taser';
  lights: boolean;
  backup: number;
}

export interface NpcDeps {
  readonly seed: number;
  /** `session.rng.stream('npc')`; the system draws from its children `'peds'` and `'actors'`. */
  readonly rng: Rng;
  readonly city: City;
  readonly people: Population;
  readonly traffic: TrafficSystem;
  readonly world: GameWorld;
  readonly bus: EventBus<EventMap>;
  /** Game seconds (0 = 00:00 on game day 0). */
  now(): number;
  /** Optional wall-clock milliseconds for `stats.stepMs` only (the system never uses time sources itself). */
  clock?(): number;
}

export interface CommandContext {
  readonly tone: 'polite' | 'neutral' | 'commanding' | 'aggressive' | 'shout';
  readonly rapport: number;
  readonly commMode: string;
  readonly weapon: 'none' | 'sidearm' | 'taser';
  readonly backup: number;
  readonly lights: boolean;
}

export interface PersonPick {
  kind: 'actor' | 'ped' | 'occupant';
  /** Actor id, pedestrian slot or vehicle id. */
  id: number;
  seat: number;
  personId: number;
  distance: number;
}

export type NpcView = HumanoidSource & { count: number };

/** One pedestrian in a save. `acc` (time since its last LOD update) is optional when reading. */
export interface PedSave {
  personId: number;
  edge: number;
  s: number;
  side: number;
  dir: number;
  speed: number;
  gait: number;
  flee: number;
  acc?: number;
}

/** One actor in a save. Bit 1 cuffed, 2 following, 4 hidden, 8 armed, 16 weaponDrawn, 32 approached, then internal bits. */
export interface ActorSave {
  id: number;
  personId: number;
  role: string;
  callId: number;
  profile: string;
  state: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  stress: number;
  timer: number;
  stamina: number;
  flags: number;
  weapon: string;
  vehicleId: number;
  seat: number;
  body: number;
  targetX: number;
  targetZ: number;
  route: number[];
  routePos: number;
  lostTimer: number;
  acc?: number;
  age?: number;
}

export interface NpcSave {
  version: 1;
  rng: RngState;
  pedsRng: RngState;
  actorsRng: RngState;
  step: number;
  nextActorId: number;
  retargetIn: number;
  target: number;
  peds: PedSave[];
  actors: ActorSave[];
  /** Scenario occupant overrides per vehicle id. */
  occupants: [number, number[]][];
  /** Step at which each override was set (absent in older saves: they restart their prune grace period). */
  occupantsSince?: [number, number][];
  /** Seats stepped out, per vehicle id. */
  out: [number, number[]][];
}
