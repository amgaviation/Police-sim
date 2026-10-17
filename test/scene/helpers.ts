import type { CadTime } from '../../src/cad/types';
import { createRng } from '../../src/core/rng';
import { NpcSystem } from '../../src/npc/npcSystem';
import type { NpcFocus } from '../../src/npc/types';
import { Population } from '../../src/people/population';
import '../../src/scene/events';
import { SCENE_CONFIG } from '../../src/scene/data';
import { SceneDirector } from '../../src/scene/director';
import type { ContactPort, ContactTarget, IncidentInfo, OfficerFocus, ScenarioRuntime } from '../../src/scene/types';
import { DT, GAME0, at, makeHarness, quietConfig, type Harness, type HarnessOptions } from '../dispatch/helpers';

export { DT, GAME0, at };

/** A stub contact port: records `attachCall` and `open` calls. */
export class StubContact implements ContactPort {
  readonly attached: { incident: string; callId: number; role?: string }[] = [];
  readonly opened: { target: ContactTarget; incident: IncidentInfo | null }[] = [];
  open(target: ContactTarget, incident: IncidentInfo | null, _t: CadTime): number {
    this.opened.push({ target, incident });
    return this.opened.length;
  }
  attachCall(incident: string, callId: number, role?: string): void {
    this.attached.push(role === undefined ? { incident, callId } : { incident, callId, role });
  }
}

export const CAPTURED = ['scene:materialized', 'scene:radio', 'scene:line', 'scene:flash', 'scene:pursuit', 'scene:outcome', 'scene:openForm', 'force:used'] as const;

export interface SceneRig extends Harness {
  readonly people: Population;
  readonly npc: NpcSystem;
  readonly scene: SceneDirector;
  readonly contact: StubContact;
  readonly officer: OfficerFocus;
  readonly npcFocus: NpcFocus;
  /** Captured scene events. */
  readonly seen: { topic: string; payload: unknown }[];
  /** Items consumed from the kit. */
  readonly used: { item: string; n: number }[];
  /** Patrol cars reported to the scene. */
  readonly cars: { eid: number; lightbar: boolean; siren: boolean }[];
}

export interface RigOptions extends HarnessOptions {
  /** Kit items reported as missing. */
  missing?: string[];
  /** Pulled-over cars never flee on their own (scenario `flee` still applies). */
  noAmbientFlee?: boolean;
}

/** The full scene stack on a generated city: dispatch, traffic, people, npc, scene and a stub contact port. */
export async function makeRig(options: RigOptions = {}): Promise<SceneRig> {
  const h = await makeHarness({ density: 0, config: quietConfig(), ...options });
  const people = new Population({ seed: h.seed, records: h.records, now: () => GAME0 + h.sim * 30 });
  const npc = new NpcSystem({
    seed: h.seed,
    rng: createRng(h.seed).stream('npc'),
    city: h.city,
    people,
    traffic: h.traffic,
    world: h.world,
    bus: h.bus,
    now: () => GAME0 + h.sim * 30,
  });
  npc.setDensityScale(0);
  const contact = new StubContact();
  const used: { item: string; n: number }[] = [];
  const missing = new Set(options.missing ?? []);
  const cars: SceneRig['cars'] = [];
  const scene = new SceneDirector({
    seed: h.seed,
    city: h.city,
    bus: h.bus,
    cad: h.cad,
    records: h.records,
    people,
    npc,
    traffic: h.traffic,
    dispatcher: h.dispatcher,
    contact,
    rng: createRng(h.seed).stream('scene'),
    kit: () => ({
      carried: (item) => (missing.has(item) ? 0 : 5),
      use: (item, n) => {
        if (missing.has(item)) return false;
        used.push({ item, n });
        return true;
      },
    }),
    patrolCars: () => cars,
    config: options.noAmbientFlee ? { ...SCENE_CONFIG, ambientFlee: { ...SCENE_CONFIG.ambientFlee, base: 0, wanted: 0, stolen: 0, intoxicated: 0, contraband: 0 } } : undefined,
  });
  const seen: SceneRig['seen'] = [];
  for (const topic of CAPTURED) h.bus.on(topic, (payload) => seen.push({ topic, payload }));
  const rig: SceneRig = Object.assign(h, {
    people,
    npc,
    scene,
    contact,
    officer: { x: h.player.x, z: h.player.z, yaw: 0, speed: 0, onFoot: true },
    npcFocus: { x: 0, z: 0, yaw: 0, speed: 0, onFoot: true, weapon: 'none' as const, lights: false, backup: 0 },
    seen,
    used,
    cars,
  });
  return rig;
}

function zone(h: Harness): { hour: number; isWeekday: boolean } {
  return { hour: ((GAME0 + h.sim * 30) % 86400) / 3600, isWeekday: true };
}

/** One fixed step in the session order: dispatch, scene, (contact), traffic, npc, physics. */
export function step(r: SceneRig): void {
  const t = at(r.sim);
  r.officer.x = r.player.x;
  r.officer.z = r.player.z;
  r.officer.speed = r.player.speed;
  r.dispatcher.step(DT, t, r.player);
  r.scene.step(DT, t, r.officer);
  r.focus.x = r.player.x;
  r.focus.z = r.player.z;
  r.focus.ox = r.player.x;
  r.focus.oz = r.player.z;
  r.sim += DT;
  r.traffic.step(DT, r.sim, zone(r), r.focus);
  r.npcFocus.x = r.player.x;
  r.npcFocus.z = r.player.z;
  r.npcFocus.yaw = r.officer.yaw;
  r.npcFocus.speed = r.player.speed;
  r.npcFocus.onFoot = r.officer.onFoot;
  r.npcFocus.weapon = r.scene.officerWeapon;
  r.npcFocus.lights = r.scene.presence.lights;
  r.npcFocus.backup = r.scene.presence.backup;
  r.npc.step(DT, r.sim, r.npcFocus);
  r.physics.step();
}

export function run(r: SceneRig, seconds: number, each?: () => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    each?.();
    step(r);
  }
}

export function runUntil(r: SceneRig, pred: () => boolean, maxSeconds: number): boolean {
  const n = Math.round(maxSeconds / DT);
  for (let i = 0; i < n; i++) {
    if (pred()) return true;
    step(r);
  }
  return pred();
}

export function eventsOf<T>(r: SceneRig, topic: string): T[] {
  return r.seen.filter((e) => e.topic === topic).map((e) => e.payload as T);
}

/** Spawns calls of `typeId` until one whose scenario satisfies `pred` (others are cancelled); returns the call id. */
export function spawnWhere(
  r: SceneRig,
  typeId: string,
  pred: (rt: ScenarioRuntime) => boolean,
  variants: Parameters<SceneDirector['spawnCall']>[3] = [],
  tries = 120,
): number {
  for (let i = 0; i < tries; i++) {
    const id = r.scene.spawnCall(typeId, at(r.sim), { x: r.player.x, z: r.player.z }, variants);
    if (id === 0) throw new Error(`No call for ${typeId}`);
    const rt = r.scene.runtime(id);
    if (rt && pred(rt)) return id;
    r.cad.closeCall(id, 'cancelled', at(r.sim));
  }
  throw new Error(`No ${typeId} scenario matched in ${tries} tries`);
}

/** Assigns the player to call `id` and puts them `away` metres west of its true anchor, then runs `seconds`. */
export function engage(r: SceneRig, id: number, away = 30, seconds = 1): ScenarioRuntime {
  const rt = r.scene.runtime(id);
  if (!rt) throw new Error('No scenario');
  r.dispatcher.request(r.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'key');
  r.player.x = rt.scenario.anchor.x - away;
  r.player.z = rt.scenario.anchor.z;
  run(r, seconds);
  return rt;
}

/**
 * Spawns call `typeId` through the scene (optionally with forced variants) at the player, assigns the player
 * and moves them next to the true anchor so the scene materializes. Returns the call id.
 */
export function startScene(r: SceneRig, typeId: string, variants: Parameters<SceneDirector['spawnCall']>[3] = [], seconds = 1): number {
  const id = r.scene.spawnCall(typeId, at(r.sim), { x: r.player.x, z: r.player.z }, variants);
  if (id === 0) throw new Error(`No call for ${typeId}`);
  const rt = r.scene.runtime(id);
  if (!rt) throw new Error('No scenario');
  r.dispatcher.request(r.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'key');
  r.player.x = rt.scenario.anchor.x - 30;
  r.player.z = rt.scenario.anchor.z;
  run(r, seconds);
  return id;
}
