import { CadState } from '../../src/cad/cadState';
import type { CadLocation, CadTime } from '../../src/cad/types';
import { CommandSystem } from '../../src/command/commandSystem';
import { COMMAND_CONFIG } from '../../src/command/data';
import '../../src/command/events';
import type {
  BackupPort,
  CommandBuilding,
  CommandConfig,
  CommandContext,
  CommandDeps,
  CommandParticipant,
  CommandSwatCommand,
  PostSpec,
  ResourcePort,
} from '../../src/command/types';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import { ACTOR_STATE, type ActorInfo } from '../../src/npc/types';
import type { SceneRequest } from '../../src/scene/types';
import type { City } from '../../src/world/city';
import { cityFor } from '../world/helpers';

export const DT = 1 / 60;
export const SEED = 42;

export function at(sim: number): CadTime {
  return { sim, game: 7 * 3600 + sim * 30 };
}

export interface Recorded {
  topic: string;
  payload: unknown;
}

export interface Fakes {
  /** Scene state per call. */
  family: string;
  flags: Set<string>;
  participants: CommandParticipant[];
  buildingId: number;
  hasScenario: boolean;
  requests: SceneRequest[];
  /** npc */
  actors: Map<number, ActorInfo>;
  removed: number[];
  forced: { id: number; state: string }[];
  walks: { id: number; x: number; z: number }[];
  scanned: number[];
  /** people */
  temperament: 'calm' | 'timid' | 'irritable' | 'volatile';
  mental: string;
  bac: number;
  /** resources: units on scene by type id */
  onScene: Map<string, string[]>;
  requested: { typeId: string; callId: number; via: string }[];
  transported: { callsign: string; personId: number }[];
  supervisor: string | null;
  transportOk: boolean;
  /** backup */
  capacity: number;
  posts: { spec: PostSpec; callsign: string }[];
  cleared: (string | undefined)[];
  swatLog: { callId: number; command: CommandSwatCommand }[];
  swatPhase: string | null;
  staffedOverride: Partial<Record<'inner' | 'tcp' | 'evac', number>>;
  /** buildings */
  buildings: number;
  building: CommandBuilding | null;
}

export const DOOR = { x: 130, z: 40 };

export class Rig {
  readonly bus = new EventBus<EventMap>();
  readonly city: City = cityFor(SEED);
  readonly cad = new CadState(this.bus);
  readonly fakes: Fakes;
  readonly events: Recorded[] = [];
  readonly sys: CommandSystem;
  sim = 0;
  callId = 0;
  readonly incident: { x: number; z: number };
  readonly ctx: CommandContext;

  constructor(opts: { config?: CommandConfig; family?: string; flags?: string[]; seed?: number } = {}) {
    // A road node near the middle of the map, so roads surround the incident.
    let best = Infinity;
    let ix = 0;
    let iz = 0;
    for (const n of this.city.graph.nodes) {
      const d = Math.hypot(n.x, n.z);
      if (d < best && n.edges.length >= 3) {
        best = d;
        ix = n.x;
        iz = n.z;
      }
    }
    this.incident = { x: ix, z: iz };
    this.ctx = { x: ix + 30, z: iz, yaw: 0, onFoot: true, building: -1, callId: 0 };
    this.fakes = {
      family: opts.family ?? 'massCasualty',
      flags: new Set(opts.flags ?? ['mci', 'roadway']),
      participants: [],
      buildingId: -1,
      hasScenario: true,
      requests: [],
      actors: new Map(),
      removed: [],
      forced: [],
      walks: [],
      scanned: [],
      temperament: 'calm',
      mental: 'none',
      bac: 0,
      onScene: new Map(),
      requested: [],
      transported: [],
      supervisor: null,
      transportOk: true,
      capacity: 99,
      posts: [],
      cleared: [],
      swatLog: [],
      swatPhase: null,
      staffedOverride: {},
      buildings: 4,
      building: null,
    };
    for (const topic of ['command:post', 'command:triage', 'command:negotiation', 'command:radio', 'command:flash'] as const) {
      this.bus.on(topic, (payload) => this.events.push({ topic, payload }));
    }
    this.sys = new CommandSystem(this.deps(opts.config, opts.seed ?? SEED));
    this.cad.addUnit({ callsign: '1-A-12', kind: 'player', officer: 'Officer Player', beat: 'A', fleetIndex: -1 }, at(0));
  }

  private deps(config: CommandConfig | undefined, seed: number): CommandDeps {
    const f = this.fakes;
    const resources: ResourcePort = {
      requestType: (typeId, callId, via) => void f.requested.push({ typeId, callId, via }),
      supervisorFor: () => f.supervisor,
      onScene: (_c, typeId) => f.onScene.get(typeId)?.length ?? 0,
      onSceneUnits: (_c, typeId, out) => {
        out.length = 0;
        for (const cs of f.onScene.get(typeId) ?? []) out.push(cs);
        return out;
      },
      transport: (callsign, personId) => {
        if (!f.transportOk) return false;
        f.transported.push({ callsign, personId });
        const list = f.onScene.get('ems') ?? [];
        f.onScene.set('ems', list.filter((c) => c !== callsign));
        return true;
      },
    };
    const staffedCount = (kind: 'inner' | 'tcp' | 'evac'): number => f.staffedOverride[kind] ?? f.posts.filter((p) => p.spec.kind === kind).length;
    const backup: BackupPort = {
      staffPost: (spec) => {
        if (f.posts.length >= f.capacity) return null;
        const callsign = `BK-${f.posts.length + 1}`;
        f.posts.push({ spec: { ...spec }, callsign });
        return callsign;
      },
      clearPosts: (kind) => {
        f.cleared.push(kind);
        f.posts = kind === undefined ? [] : f.posts.filter((p) => p.spec.kind !== kind);
      },
      staffed: staffedCount,
      swat: (callId, command) => {
        f.swatLog.push({ callId, command });
        return `SWAT: ${command}`;
      },
      swatPhase: () => f.swatPhase,
    };
    return {
      seed,
      bus: this.bus,
      rng: createRng(seed).stream('command'),
      graph: this.city.graph,
      cad: this.cad,
      scene: {
        request: (r) => void f.requests.push(r),
        participants: () => f.participants,
        hasScenario: () => f.hasScenario,
        familyOf: () => f.family,
        flagsOf: () => f.flags,
        buildingOfCall: () => f.buildingId,
      },
      npc: {
        actor: (id, out) => {
          const a = f.actors.get(id);
          if (!a) return null;
          Object.assign(out, a);
          return out;
        },
        removeActor: (id) => void f.removed.push(id),
        forceState: (id, state) => {
          f.forced.push({ id, state });
          const a = f.actors.get(id);
          if (a && state === 'handsUp') a.state = ACTOR_STATE.handsUp;
        },
        actorsOfCall: (_c, out) => {
          out.length = 0;
          for (const id of f.actors.keys()) out.push(id);
          f.scanned = out.slice();
          return out;
        },
        walkTo: (id, x, z) => void f.walks.push({ id, x, z }),
      },
      people: {
        identity: () => ({ temperament: f.temperament, mental: f.mental }),
        intoxication: () => ({ bac: f.bac, drug: '' }),
        setInjured: () => undefined,
      },
      resources,
      backup,
      buildingsNear: () => f.buildings,
      building: () => f.building,
      ...(config ? { config } : {}),
    };
  }

  /** Opens a call at the incident (the player is assigned to it) and points the context at it. */
  openCall(typeId = 'multiVehicleCrash'): number {
    const location: CadLocation = {
      x: this.incident.x, z: this.incident.z, edge: 0, text: '100 Main Street', street: 'Main Street', cross: '1st Street',
      near: 'Main Street at 1st Street', district: 'downtown',
    };
    const call = this.cad.createCall(
      { typeId, priority: 1, location, caller: { kind: 'citizen', name: 'Caller', phone: '555-0100', personId: -1 }, narrative: 'Multiple injured.' },
      at(this.sim),
    );
    this.cad.assign(call.id, '1-A-12', at(this.sim), 'dispatch');
    this.callId = call.id;
    this.ctx.callId = call.id;
    return call.id;
  }

  /** Adds a unit assigned to the call, on scene. */
  addUnit(callsign: string, status: 'enRoute' | 'onScene' = 'onScene'): void {
    this.cad.addUnit({ callsign, kind: 'resource', officer: callsign, beat: 'R', fleetIndex: 8 }, at(this.sim));
    this.cad.assign(this.callId, callsign, at(this.sim), 'dispatch');
    if (status === 'onScene') this.cad.setUnitStatus(callsign, 'onScene', at(this.sim), 'auto');
  }

  /** Puts `n` victims on the scene: the first `walking` are walking wounded, then victims, one unconscious and one deceased. */
  victims(roles: readonly string[] = ['victim', 'victim', 'victim', 'walkingWounded', 'unconscious', 'deceased']): number[] {
    const ids: number[] = [];
    roles.forEach((role, i) => {
      const personId = 100 + i;
      const actorId = 1 + i;
      ids.push(personId);
      this.fakes.participants.push({ role, personId, actorId, injured: role !== 'walkingWounded', deceased: role === 'deceased' });
      this.fakes.actors.set(actorId, actor(actorId, personId, role, this.incident.x + 31.5 + i * 0.1, this.incident.z));
    });
    this.fakes.participants.push({ role: 'bystander', personId: 900, actorId: 50, injured: false, deceased: false });
    this.fakes.actors.set(50, actor(50, 900, 'bystander', this.incident.x + 20, this.incident.z + 5));
    return ids;
  }

  run(seconds: number): void {
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) {
      this.sim += DT;
      this.sys.step(DT, at(this.sim), this.ctx);
    }
  }

  of(topic: string): unknown[] {
    return this.events.filter((e) => e.topic === topic).map((e) => e.payload);
  }

  flashes(): string[] {
    return this.of('command:flash').map((p) => (p as { text: string }).text);
  }

  radios(): string[] {
    return this.of('command:radio').map((p) => (p as { text: string }).text);
  }

  flagRequests(): string[] {
    return this.fakes.requests.filter((r) => r.kind === 'commandFlag').map((r) => (r as { flag: string }).flag);
  }
}

export function actor(id: number, personId: number, role: string, x: number, z: number): ActorInfo {
  return {
    id, personId, role, callId: 1, state: ACTOR_STATE.idle, x, z, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: 'victimInjured', body: 0, building: -1,
  };
}

export { COMMAND_CONFIG };
