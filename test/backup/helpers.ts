import { CadState } from '../../src/cad/cadState';
import '../../src/cad/events';
import type { CadTime, UnitKind } from '../../src/cad/types';
import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { createRng, type Rng } from '../../src/core/rng';
import { ACTOR_STATE, type ActorInfo, type CommandContext, type CommandOutcome, type NpcCommand } from '../../src/npc/types';
import { BackupSystem, type BackupContext, type BackupDeps, type BackupNpcPort } from '../../src/backup/backupSystem';
import '../../src/backup/events';
import '../../src/force/events';
import '../../src/npc/events';
import '../../src/scene/events';
import type { BackupAppearance, BackupAppearanceRole, BackupConfig, SwatConfig } from '../../src/backup/types';
import { mistakeChances, officerProfile, rollMistakes } from '../../src/units/personality';
import { RosterState } from '../../src/units/roster';
import { ROSTER_CONFIG } from '../../src/units/data';
import type { MistakeRolls } from '../../src/units/types';
import { newCall } from '../cad/helpers';
import { StubInteriors } from '../tactical/helpers';

export const DT = 1 / 60;
export const SEED = 42;

export function at(sim: number): CadTime {
  return { sim, game: 50400 + sim * 30 };
}

export interface FakeActor {
  id: number;
  personId: number;
  role: string;
  callId: number;
  state: number;
  x: number;
  z: number;
  yaw: number;
  cuffed: boolean;
  weaponDrawn: boolean;
  building: number;
  hidden: boolean;
  dead: boolean;
  vehicleId: number;
}

/** A fixed set of scene actors with just enough behaviour for the backup officers. */
export class FakeNpc implements BackupNpcPort {
  readonly actors = new Map<number, FakeActor>();
  readonly commands: { id: number; cmd: NpcCommand }[] = [];
  readonly evaluated: { id: number; cmd: NpcCommand; ctx: CommandContext }[] = [];
  readonly tackles: { x: number; z: number; yaw: number }[] = [];
  readonly forced: { id: number; state: string }[] = [];
  readonly incapacitated: { id: number; seconds: number; by: string }[] = [];
  outcome: CommandOutcome = 'comply';
  /** Cuffing succeeds only after this many attempts. */
  cuffAfter = 0;
  private cuffTries = 0;
  actorCalls = 0;

  add(over: Partial<FakeActor> & { id: number }): FakeActor {
    const a: FakeActor = {
      personId: over.id + 100, role: 'subject', callId: 1, state: ACTOR_STATE.idle, x: 0, z: 0, yaw: 0, cuffed: false, weaponDrawn: false,
      building: -1, hidden: false, dead: false, vehicleId: -1, ...over,
    };
    this.actors.set(a.id, a);
    return a;
  }

  actorIds(out: number[]): number[] {
    out.length = 0;
    for (const id of this.actors.keys()) out.push(id);
    return out;
  }

  actor(id: number, out: ActorInfo): ActorInfo | null {
    this.actorCalls++;
    const a = this.actors.get(id);
    if (!a) return null;
    out.id = a.id;
    out.personId = a.personId;
    out.role = a.role;
    out.callId = a.callId;
    out.state = a.state as ActorInfo['state'];
    out.x = a.x;
    out.z = a.z;
    out.yaw = a.yaw;
    out.stress = 0;
    out.cuffed = a.cuffed;
    out.following = false;
    out.hidden = a.hidden;
    out.armed = a.weaponDrawn;
    out.weaponDrawn = a.weaponDrawn;
    out.vehicleId = a.vehicleId;
    out.seat = -1;
    out.profile = '';
    out.body = 0;
    out.building = a.building;
    out.dead = a.dead;
    return out;
  }

  actorsOfCall(callId: number, out: number[]): number[] {
    out.length = 0;
    for (const a of this.actors.values()) if (a.callId === callId) out.push(a.id);
    return out;
  }

  actorsInBuilding(buildingId: number, out: number[]): number[] {
    out.length = 0;
    for (const a of this.actors.values()) if (a.building === buildingId) out.push(a.id);
    return out;
  }

  evaluateCommand(id: number, cmd: NpcCommand, ctx: CommandContext): CommandOutcome {
    this.evaluated.push({ id, cmd, ctx: { ...ctx } });
    return this.outcome;
  }

  applyCommand(id: number, cmd: NpcCommand, outcome: CommandOutcome): void {
    this.commands.push({ id, cmd });
    const a = this.actors.get(id);
    if (!a) return;
    if (outcome === 'flee') a.state = ACTOR_STATE.flee;
    else if (outcome === 'comply' && cmd === 'showHands') a.state = ACTOR_STATE.handsUp;
  }

  forceState(id: number, state: 'handsUp' | 'kneel' | 'prone' | 'hold' | 'leave'): void {
    this.forced.push({ id, state });
    const a = this.actors.get(id);
    if (!a) return;
    a.state = state === 'handsUp' ? ACTOR_STATE.handsUp : state === 'kneel' ? ACTOR_STATE.kneel : state === 'prone' ? ACTOR_STATE.prone : ACTOR_STATE.hold;
  }

  cuff(id: number): 'ok' | 'resist' | 'notReady' {
    const a = this.actors.get(id);
    if (!a) return 'notReady';
    if (a.cuffed) return 'ok';
    if (![ACTOR_STATE.handsUp, ACTOR_STATE.kneel, ACTOR_STATE.prone, ACTOR_STATE.down, ACTOR_STATE.hold].includes(a.state as 5)) return 'notReady';
    if (this.cuffTries++ < this.cuffAfter) return 'resist';
    a.cuffed = true;
    a.state = ACTOR_STATE.cuffed;
    return 'ok';
  }

  tackle(officerX: number, officerZ: number, officerYaw: number): number {
    this.tackles.push({ x: officerX, z: officerZ, yaw: officerYaw });
    for (const a of this.actors.values()) {
      if (a.state === ACTOR_STATE.flee && Math.hypot(a.x - officerX, a.z - officerZ) <= 1.7) {
        a.state = ACTOR_STATE.down;
        return a.id;
      }
    }
    return 0;
  }

  incapacitate(id: number, seconds: number, by: 'beanbag' | 'strike'): boolean {
    this.incapacitated.push({ id, seconds, by });
    const a = this.actors.get(id);
    if (!a) return false;
    a.state = ACTOR_STATE.down;
    return true;
  }
}

export interface Pose {
  x: number;
  z: number;
  yaw: number;
}

export interface RigOptions {
  seed?: number;
  config?: BackupConfig;
  swatConfig?: SwatConfig;
  /** Phase 7: the `appearanceOf` dependency. */
  appearanceOf?: (callsign: string, role: BackupAppearanceRole) => BackupAppearance | null;
}

export interface Recorded {
  topic: string;
  payload: unknown;
  sim: number;
}

const TOPICS = ['backup:callout', 'backup:mistake', 'backup:custody', 'backup:swat', 'backup:radio', 'backup:flash'] as const;

/** A BackupSystem on a real CAD with a fake NPC system, car poses and interiors. */
export class Rig {
  readonly seed: number;
  readonly bus = new EventBus<EventMap>((topic, error) => {
    throw new Error(`${topic}: ${String(error)}`);
  });
  readonly cad = new CadState(this.bus);
  readonly roster: RosterState;
  readonly npc = new FakeNpc();
  readonly interiors = new StubInteriors();
  readonly cars = new Map<string, Pose>();
  readonly events: Recorded[] = [];
  readonly doorRequests: { building: number; door: number; action: string }[] = [];
  readonly rng: Rng;
  readonly sys: BackupSystem;
  buildings = new Map<number, { minX: number; minZ: number; maxX: number; maxZ: number; door: { x: number; z: number; yaw: number } }>();
  callBuildingId = -1;
  /** Callsigns the dispatcher / resources flagged as leaving (the `releasing` dep). */
  readonly leaving = new Set<string>();
  swatCount = 0;
  trust = 0;
  sim = 0;
  callId = 0;
  ctx: BackupContext = { x: 0, z: 0, yaw: 0, building: -1, onFoot: true, callId: 0, contactPersonId: -1, game: 50400 };

  constructor(opts: RigOptions = {}) {
    this.seed = opts.seed ?? SEED;
    this.roster = new RosterState(this.seed);
    this.rng = createRng(this.seed).stream('backup');
    const deps: BackupDeps = {
      seed: this.seed,
      bus: this.bus,
      rng: this.rng,
      roster: this.roster,
      cad: this.cad,
      npc: this.npc,
      unitCar: (cs, out) => {
        const p = this.cars.get(cs);
        if (!p) return false;
        out.x = p.x;
        out.z = p.z;
        out.yaw = p.yaw;
        return true;
      },
      releasing: (cs) => this.leaving.has(cs),
      interiors: this.interiors,
      doorRequest: (building, door, action) => {
        this.doorRequests.push({ building, door, action });
      },
      building: (id) => this.buildings.get(id) ?? null,
      callBuilding: () => this.callBuildingId,
      swatOnScene: () => this.swatCount,
      negotiationTrust: () => this.trust,
      ...(opts.config ? { config: opts.config } : {}),
      ...(opts.swatConfig ? { swatConfig: opts.swatConfig } : {}),
      ...(opts.appearanceOf ? { appearanceOf: opts.appearanceOf } : {}),
    };
    this.sys = new BackupSystem(deps);
    for (const topic of TOPICS) this.bus.on(topic, (payload: unknown) => this.events.push({ topic, payload, sim: this.sim }));
    this.cad.addUnit({ callsign: '12', kind: 'player', officer: 'Officer Doe', beat: 'downtown', fleetIndex: -1 }, at(0));
  }

  /** Opens the player's call (id 1) and points the context at it. */
  openCall(): number {
    const call = this.cad.createCall(newCall(), at(this.sim));
    this.callId = call.id;
    this.ctx.callId = call.id;
    return call.id;
  }

  /** Adds a unit with a car at (x, z) heading `yaw`, assigns it to the call and puts it on scene. */
  unitOnScene(callsign: string, x: number, z: number, yaw = 0, kind: UnitKind = 'ai'): void {
    this.cad.addUnit({ callsign, kind, officer: `Officer ${callsign}`, beat: 'downtown', fleetIndex: this.cars.size }, at(this.sim));
    this.cars.set(callsign, { x, z, yaw });
    this.cad.assign(this.callId, callsign, at(this.sim), 'dispatch');
    this.cad.setUnitStatus(callsign, 'onScene', at(this.sim), 'auto');
  }

  /** The unit leaves the call (cleared). */
  release(callsign: string): void {
    this.cad.unassign(callsign, at(this.sim));
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.sim += DT;
      this.ctx.game = 50400 + this.sim * 30;
      this.sys.step(DT, at(this.sim), this.ctx);
    }
  }

  /** Steps until `pred` holds (at most `seconds`); returns whether it did. */
  until(pred: () => boolean, seconds: number): boolean {
    const n = Math.ceil(seconds / DT);
    for (let i = 0; i < n; i++) {
      if (pred()) return true;
      this.step();
    }
    return pred();
  }

  of<T = unknown>(topic: string): T[] {
    return this.events.filter((e) => e.topic === topic).map((e) => e.payload as T);
  }
}

/** The mistakes an officer `callsign` with the given stress and fatigue rolls on its first arrival (the roster starts loyalty from the profile stream). */
export function predictRolls(seed: number, callsign: string, stress: number, fatigue: number): MistakeRolls {
  const roster = new RosterState(seed);
  roster.ensure(callsign, 'officer');
  const dyn = roster.dynamic(callsign)!;
  dyn.stress = stress;
  dyn.fatigue = fatigue;
  return rollMistakes(seed, callsign, 1, mistakeChances(officerProfile(seed, callsign, 'officer').traits, dyn, ROSTER_CONFIG));
}

/** First callsign `U<n>` whose first-arrival rolls satisfy `pred`. */
export function findCallsign(seed: number, stress: number, fatigue: number, pred: (r: MistakeRolls) => boolean): string {
  for (let i = 1; i < 2000; i++) {
    const cs = `U${i}`;
    if (pred(predictRolls(seed, cs, stress, fatigue))) return cs;
  }
  throw new Error('no callsign found');
}

/** Gives the roster entry of `callsign` the stress and fatigue before it arrives. */
export function prepare(rig: Rig, callsign: string, stress: number, fatigue: number): void {
  rig.roster.ensure(callsign, 'officer');
  const dyn = rig.roster.dynamic(callsign)!;
  dyn.stress = stress;
  dyn.fatigue = fatigue;
}

/** `n` distinct callsigns whose first-arrival rolls satisfy `pred`. */
export function findCallsigns(n: number, seed: number, stress: number, fatigue: number, pred: (r: MistakeRolls) => boolean): string[] {
  const out: string[] = [];
  for (let i = 1; i < 5000 && out.length < n; i++) {
    const cs = `U${i}`;
    if (pred(predictRolls(seed, cs, stress, fatigue))) out.push(cs);
  }
  if (out.length < n) throw new Error('not enough callsigns');
  return out;
}

export const NO_MISTAKES = (r: MistakeRolls): boolean => !r.lateCallout && !r.poorPosition && !r.excessiveForce;
/** The roster's starting stress and fatigue (what an unprepared officer arrives with). */
export const START_STRESS = ROSTER_CONFIG.stress.start;
export const START_FATIGUE = ROSTER_CONFIG.fatigue.start;
