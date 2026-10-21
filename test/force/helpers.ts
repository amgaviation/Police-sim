import type { CadTime } from '../../src/cad/types';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng, type Rng, type RngState } from '../../src/core/rng';
import { ForceSystem } from '../../src/force/forceSystem';
import type { FellowOfficer, ForceDeps, ForceOfficer, Resistance } from '../../src/force/types';
import '../../src/force/events';
import '../../src/npc/events';
import type { ActorInfo } from '../../src/npc/types';
import { ACTOR_STATE } from '../../src/npc/types';
import type { Population } from '../../src/people/population';

export const DT = 1 / 60;

/** An Rng that returns the scripted values in order, then `fallback`. */
export function scriptedRng(values: number[], fallback = 0.5): Rng {
  let i = 0;
  const rng: Rng = {
    seed: 1,
    next: () => (i < values.length ? (values[i++] ?? fallback) : fallback),
    nextInt: () => 0,
    nextFloat: (a: number) => a,
    chance: () => false,
    pick: <T>(arr: readonly T[]): T => arr[0] as T,
    shuffle: <T>(arr: T[]): T[] => arr,
    gaussian: () => 0,
    stream: () => rng,
    state: (): RngState => ({ seed: 1, s: [1, 2, 3, i] }),
    restore: () => undefined,
  };
  return rng;
}

export function makeActor(id: number, over: Partial<ActorInfo> = {}): ActorInfo {
  return {
    id, personId: id * 10, role: 'suspect', callId: 5, state: ACTOR_STATE.idle, x: 0, z: -1, yaw: 0, stress: 0, cuffed: false, following: false,
    hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: 'suspectCalm', body: 0, building: -1, aware: 0, ...over,
  };
}

export const OFFICER: ForceOfficer = { x: 0, z: 0, yaw: 0, building: -1, onFoot: true, moving: false, crouched: false, callId: 5 };

export interface PersonFake {
  elderly: boolean;
  juvenile: boolean;
  age: number;
  sex: string;
  bac: number;
}

/** Everything the ForceSystem talks to, faked and recorded. */
export class Rig {
  readonly bus = new EventBus<EventMap>();
  readonly actors = new Map<number, ActorInfo>();
  readonly resist = new Map<number, Resistance>();
  readonly persons = new Map<number, PersonFake>();
  readonly injured = new Map<number, number>();
  readonly deceased = new Set<number>();
  /** Ordered log of npc / scene calls. */
  readonly calls: string[] = [];
  readonly weapons: string[] = [];
  readonly held = new Set<string>(['taser', 'sidearm', 'ocSpray', 'baton', 'beanbag']);
  readonly applied: EventMap['force:applied'][] = [];
  readonly other: EventMap['force:other'][] = [];
  readonly intervened: EventMap['force:intervened'][] = [];
  readonly tools: string[] = [];
  readonly flashes: string[] = [];
  fellowList: FellowOfficer[] = [];
  k9 = false;
  temp = 15;
  elevated = false;
  /** Holster retention level answered by `holsterLevel()` (Phase 7). */
  level = 1;
  /** When true `incapacitate` / `wound` / `taserCycle` set the actor's resistance to compliant (an effect). */
  effectsCalm = true;
  readonly sys: ForceSystem;
  readonly rng: Rng;
  t = 0;

  /** `holster` false leaves the optional `holsterLevel` dependency out (absent = level 1). */
  constructor(rng: Rng = createRng(1).stream('force'), holster = true) {
    this.rng = rng;
    const people = {
      identity: (id: number) => {
        const p = this.persons.get(id) ?? { elderly: false, juvenile: false, age: 30, sex: 'M', bac: 0 };
        return { elderly: p.elderly, juvenile: p.juvenile, age: p.age, record: { sex: p.sex } };
      },
      state: (id: number) => ({ injured: this.injured.get(id) ?? 0, deceased: this.deceased.has(id) }),
      intoxication: (id: number) => ({ bac: 0, drug: 'none', level: this.persons.get(id)?.bac ?? 0 }),
      setInjured: (id: number, v: number) => void this.injured.set(id, v),
      setDeceased: (id: number) => void this.deceased.add(id),
    } as unknown as Pick<Population, 'identity' | 'state' | 'intoxication' | 'setInjured' | 'setDeceased'>;
    const deps: ForceDeps = {
      seed: 4242,
      bus: this.bus,
      rng,
      people,
      npc: {
        actorIds: (out) => {
          out.length = 0;
          for (const id of this.actors.keys()) out.push(id);
          return out;
        },
        actor: (id, out) => {
          const a = this.actors.get(id);
          if (!a) return null;
          Object.assign(out, a);
          return out;
        },
        resistance: (id) => {
          this.calls.push(`resistance:${id}`);
          return this.resist.get(id) ?? 'compliant';
        },
        incapacitate: (id, seconds, by) => {
          this.calls.push(`incapacitate:${id}:${seconds}:${by}`);
          if (this.effectsCalm) this.resist.set(id, 'compliant');
          return true;
        },
        wound: (id, severity, fatal) => {
          this.calls.push(`wound:${id}:${severity.toFixed(3)}:${String(fatal)}`);
          if (this.effectsCalm) this.resist.set(id, 'compliant');
        },
        taserCycle: (id, seconds) => {
          this.calls.push(`taserCycle:${id}:${seconds}`);
          if (this.effectsCalm) this.resist.set(id, 'compliant');
        },
      },
      scene: {
        setWeapon: (w) => void this.weapons.push(w),
        serviceArrived: (_call, kind) => kind === 'k9' && this.k9,
      },
      armoryHas: (item) => this.held.has(item),
      temperatureC: () => this.temp,
      elevatedAt: () => this.elevated,
      fellows: () => this.fellowList,
      ...(holster ? { holsterLevel: () => this.level } : {}),
    };
    this.sys = new ForceSystem(deps);
    this.bus.on('force:applied', (e) => void this.applied.push(e));
    this.bus.on('force:other', (e) => void this.other.push(e));
    this.bus.on('force:intervened', (e) => void this.intervened.push(e));
    this.bus.on('force:tool', (e) => void this.tools.push(e.tool));
    this.bus.on('force:flash', (e) => void this.flashes.push(e.text));
  }

  add(a: ActorInfo, res: Resistance = 'compliant'): ActorInfo {
    this.actors.set(a.id, a);
    this.resist.set(a.id, res);
    return a;
  }

  time(): CadTime {
    return { sim: this.t, game: this.t };
  }

  /** Runs `n` fixed steps. */
  run(n: number, officer: ForceOfficer = OFFICER): void {
    for (let i = 0; i < n; i++) {
      this.t += DT;
      this.sys.step(DT, this.time(), officer);
    }
  }

  /** Runs for `seconds` of sim time. */
  runFor(seconds: number, officer: ForceOfficer = OFFICER): void {
    this.run(Math.ceil(seconds / DT), officer);
  }

  /** A fight started by actor `actorId` (the npc system's `npc:attack`). */
  attack(actorId: number, kind: 'fight' | 'fire' | 'brandish' = 'fight'): void {
    this.bus.emit('npc:attack', { actorId, personId: actorId * 10, callId: 5, kind });
  }

  select(tool: 'none' | 'hands' | 'ocSpray' | 'baton' | 'taser' | 'lessLethal' | 'firearm' | 'k9'): void {
    this.sys.request({ kind: 'selectTool', tool });
    this.run(1);
    // Phase 7: drawing the sidearm takes drawS seconds (level 1: 0.25 s) before it can fire.
    if (tool === 'firearm') this.runFor(0.3);
  }

  apply(dirX = 0, dirZ = -1, officer: ForceOfficer = OFFICER): void {
    this.sys.request({ kind: 'apply', dirX, dirZ });
    this.run(1, officer);
  }
}
