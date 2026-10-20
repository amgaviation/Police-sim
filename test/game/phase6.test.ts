import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Transform } from '../../src/ecs/components';
import { PLAYER_SIZE, serializeGame, type GameSession } from '../../src/game/session';
import type { ActorInfo } from '../../src/npc';
import { initRapier } from '../../src/physics/physics';
import { driverDoorPoint } from '../../src/player/mode';
import { migrateEnvelope } from '../../src/save/migrations';
import { CURRENT_SAVE_VERSION, isSaveGame, isSaveGameV7, type SaveGame } from '../../src/save/schema';
import { VehicleLook } from '../../src/vehicles/components';
import { VEHICLE_MODELS } from '../../src/vehicles/model';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { laneRef } from '../../src/world/roadGraph';
import { Harness, roundTrip } from './harness';

const SEED = 42;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

const BLANK: ActorInfo = {
  id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false,
  following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
};

function placeOfficer(session: GameSession, x: number, z: number): void {
  session.physics.getBody(session.player)?.setTranslation({ x, y: PLAYER_SIZE.y / 2, z }, true);
  Transform.x[session.player] = x;
  Transform.z[session.player] = z;
}

/**
 * A car ahead of the patrol car on an arterial, with a speeding violation the officer saw before lighting it up (the
 * traffic module's own violation event), pulled over until it is stopped at the curb. A car that runs is called off.
 */
function stopSpeeder(session: GameSession, h: Harness, edge: number): number {
  for (let attempt = 0; attempt < 12; attempt++) {
    const patrol = session.vehicles[0];
    if (!patrol) throw new Error('no patrol car');
    session.enterVehicle(patrol);
    const lane = laneRef(edge, 0, 0);
    const s0 = city.graph.laneStart(lane) + 40;
    const p = city.graph.lanePoint(lane, s0, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    session.teleport(p.x, p.z, p.yaw);
    h.step(session, 30);
    const slot = session.traffic.spawnAt(lane, s0 + 14, { speed: 4, behavior: 0, desiredFactor: 0.3 });
    const vehicleId = session.traffic.view.vehicleId[slot] ?? -1;
    session.bus.emit('traffic:violation', { eid: 0, vehicleId, kind: 'speeding', x: p.x, z: p.z, speedMph: 52, limitMph: 35 });
    if (!session.drivenVehicle?.lightbar) session.toggleLightbar();
    const d = session.driverInput;
    d.handbrake = false;
    d.brake = 0;
    d.accelerate = 0.35;
    for (let i = 0; i < 900 && session.cad.trafficStop === null; i++) h.step(session, 1);
    d.accelerate = 0;
    d.brake = 1;
    const car = session.drivenVehicle;
    for (let i = 0; i < 300 && (car?.telemetry.speed ?? 0) > 0.2; i++) h.step(session, 1);
    d.brake = 0;
    d.handbrake = true;
    h.step(session, 30);
    d.handbrake = false;
    if (session.cad.trafficStop?.vehicleId === vehicleId && session.cad.trafficStop.outcome === 'active') return vehicleId;
    session.traffic.stopFlee(vehicleId);
    session.traffic.removeVehicle(vehicleId);
    const pu = session.cad.playerUnit();
    if (pu?.callId != null) session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'clearCall', callId: pu.callId, disposition: 'handled' }, 'key');
    h.step(session, 120);
  }
  throw new Error('no car could be stopped');
}

/** Gets out and opens the stopped driver's contact. Returns the contact id. */
function talkToDriver(session: GameSession, h: Harness): number {
  expect(session.interact()).toBe('exited');
  const st = session.traffic.stopState({ vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 });
  if (!st) throw new Error('no stop target');
  const model = VEHICLE_MODELS[VehicleLook.model[st.eid] ?? 0];
  if (!model) throw new Error('no model');
  const w = driverDoorPoint({ eid: st.eid, x: st.x, z: st.z, yaw: st.yaw, halfWidth: model.body.width / 2, halfLength: model.body.length / 2, speed: 0 }, { x: 0, z: 0 });
  placeOfficer(session, w.x, w.z);
  h.step(session, 10);
  expect(session.interact()).toBe('contact');
  h.step(session, 10);
  expect(session.contact.active).toBeGreaterThan(0);
  return session.contact.active;
}


type Captured = string[];

/** Records the Phase 6 topics of a session (one line per event, with the sim second). */
function capture(session: GameSession): Captured {
  const out: Captured = [];
  const topics = [
    'pursuit:tactic', 'pursuit:order', 'pursuit:handoff', 'scene:pursuit', 'resource:dispatched', 'resource:arrived',
    'pursuit:flash', 'backup:callout', 'backup:radio', 'command:post', 'command:triage', 'dispatch:backup',
  ] as const;
  for (const t of topics) session.bus.on(t, (e: unknown) => out.push(`${String(Math.round(session.now().sim))} ${t} ${JSON.stringify(e)}`));
  return out;
}

function has(events: Captured, topic: string, needle = ''): boolean {
  return events.some((l) => l.includes(` ${topic} `) && l.includes(needle));
}

/** The Phase 6 blocks, the CAD, the traffic and the root stream of a save, as one string. */
function blocks(d: SaveGame): string {
  return JSON.stringify({ roster: d.roster, resources: d.resources, backup: d.backup, pursuit: d.pursuit, command: d.command, cad: d.cad, traffic: d.traffic, rng: d.rngState });
}

/** A road with a long straight near unit 21's beat, where the stop and the backup happen. */
function stopEdge(session: GameSession): number {
  const u = session.cad.unit('21');
  const sp = { x: u?.x ?? 0, z: u?.z ?? 0 };
  let best = 58;
  let bd = Infinity;
  for (const e of city.graph.edges) {
    if (e.length < 160) continue;
    const lane = laneRef(e.id, 0, 0);
    const m = city.graph.lanePoint(lane, city.graph.laneStart(lane) + 60, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    const d = Math.hypot(m.x - sp.x, m.z - sp.z);
    if (d < bd && d > 80) {
      bd = d;
      best = e.id;
    }
  }
  return best;
}

/** Traffic stop, backup code 2 (an AI unit gets out and covers) and a K9 request (drives from the station). */
function backupScenario(h: Harness, session: GameSession): { events: Captured; k9Eta: number[] } {
  h.step(session, 60);
  const events = capture(session);
  const edge = stopEdge(session);
  stopSpeeder(session, h, edge);
  talkToDriver(session, h);
  const player = session.dispatcher.playerCallsign;
  session.dispatcher.request(player, { kind: 'backup', code: 2 }, 'key');
  session.phase6.requestType('k9', 'mdt');
  const k9Eta: number[] = [];
  // The nearest patrol unit may be stuck at a light for minutes: put the dispatched ones behind the stopped car (the
  // dispatcher respawns an absent fleet car at its CAD position, as after a traffic reset).
  const lane = laneRef(edge, 0, 0);
  const behind = city.graph.lanePoint(lane, city.graph.laneStart(lane) + 5, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
  for (let i = 0; i < 60 * 160; i++) {
    h.step(session, 1);
    if (i === 120) {
      for (const u of session.cad.units()) {
        if (u.kind !== 'ai' || u.status !== 'enRoute') continue;
        session.cad.setUnitPosition(u.callsign, behind.x, behind.z);
        session.traffic.removeFleetCar(u.fleetIndex);
      }
    }
    if (i % 600 === 599) k9Eta.push(session.phase6.resources.eta('K9-1'));
  }
  return { events, k9Eta };
}

/** A car runs from the patrol car on the highway; spikes, the air unit, a PIT contact, a bail-out and the perimeter. */
function pursuitScenario(h: Harness, session: GameSession, from: number, to: number, mid?: (s: GameSession) => void, chase = true): Captured {
  const events = capture(session);
  const d = session.driverInput;
  if (from === 0) {
    h.step(session, 60);
    const patrol = session.vehicles[0];
    if (!patrol) throw new Error('no patrol car');
    session.enterVehicle(patrol);
    const lane = laneRef(58, 0, 0);
    const s0 = city.graph.laneStart(lane) + 40;
    const p = city.graph.lanePoint(lane, s0, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    session.teleport(p.x, p.z, p.yaw);
    h.step(session, 30);
    const slot = session.traffic.spawnAt(lane, s0 + 40, { speed: 8, behavior: 0 });
    const vehicleId = session.traffic.view.vehicleId[slot] ?? -1;
    if (!session.scene.startPursuitOf(vehicleId, session.now())) throw new Error('the car did not run');
    if (!session.drivenVehicle?.lightbar) session.toggleLightbar();
  }
  for (let i = from * 60; i < to * 60; i++) {
    if (i === 60 * 45) mid?.(session);
    d.accelerate = chase ? 0.6 : 0;
    d.brake = 0;
    d.handbrake = !chase;
    d.steer = 0;
    h.step(session, 1);
    if (i === 60 * 20) session.phase6.pursuit.request({ kind: 'spikesAhead' });
    if (i === 60 * 40) session.phase6.pursuit.request({ kind: 'air' });
  }
  return events;
}

/** A multi-vehicle crash: the command post, the supervisors, the player's triage tags, EMS triage and transport. */
function mciScenario(h: Harness, session: GameSession): Captured {
  h.step(session, 60);
  const events = capture(session);
  const at = session.playerPosition({ x: 0, z: 0 });
  const id = session.scene.spawnCall('multiVehicleCrash', session.now(), at, [], -1);
  session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'auto');
  h.step(session, 120);
  const loc = session.cad.call(id)?.location;
  if (loc) session.teleport(loc.x, loc.z, 0);
  h.step(session, 120);
  const cmd = session.phase6.command;
  cmd.request({ kind: 'establish' });
  h.step(session, 60);
  const first = cmd.board().victims[0];
  const a = first ? session.npc.actor(first.actorId, { ...BLANK }) : null;
  if (a) session.teleport(a.x + 1.2, a.z, 0);
  h.step(session, 30);
  cmd.request({ kind: 'requestNeeds' });
  for (let k = 0; k < 3; k++) {
    cmd.request({ kind: 'assess' });
    h.step(session, 60 * 6);
    const t = cmd.triage();
    if (t) cmd.request({ kind: 'tag', personId: t.personId, tag: 'immediate' });
    h.step(session, 30);
  }
  h.step(session, 60 * 240);
  return events;
}

describe('Phase 6 session', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });
  function fresh(): Harness {
    const h = new Harness(city);
    live.push(h);
    return h;
  }

  it('backup on a stop: an AI officer gets out, takes cover and calls it out; a K9 drives from the station; two runs give bit-identical v8 saves', () => {
    const h = fresh();
    const run = (): string => {
      const session = h.start(SEED);
      const { events, k9Eta } = backupScenario(h, session);
      const officers = session.phase6.backup.officers();
      expect(officers.length).toBeGreaterThan(0);
      const o = officers[0];
      expect(o?.role).toBe('cover');
      // The officer carries the roster's name; the roster counted the arrival.
      expect(o?.name).toBe(session.roster.profile(o?.callsign ?? '')?.name);
      expect(session.roster.dynamic(o?.callsign ?? '')?.arrivals).toBeGreaterThan(0);
      expect(has(events, 'backup:callout', 'covering')).toBe(true);
      expect(has(events, 'backup:radio')).toBe(true);
      // K9: dispatched from its base, its ETA counts down while it drives.
      expect(has(events, 'resource:dispatched', 'K9-1')).toBe(true);
      expect(session.cad.unit('K9-1')?.kind).toBe('resource');
      const eta = k9Eta.filter((e) => e >= 0);
      expect(eta.length).toBeGreaterThan(1);
      expect(eta[eta.length - 1]).toBeLessThan(eta[0] ?? 0);
      const data = serializeGame(session);
      expect(isSaveGame(data)).toBe(true);
      h.reset(session);
      return JSON.stringify(data);
    };
    const first = run();
    const second = run();
    expect(second).toBe(first);
  }, 240_000);

  it('the officer-needs-assistance button puts the player on the emergency call, so the responding officers get out', () => {
    const h = fresh();
    const session = h.start(SEED);
    h.step(session, 60);
    const events = capture(session);
    const flashes: string[] = [];
    session.bus.on('backup:flash', (e) => flashes.push(e.text));
    session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'emergency' }, 'key');
    h.step(session, 60 * 240);
    const call = session.cad.calls().find((c) => c.typeId === 'officerEmergency');
    expect(call).toBeDefined();
    expect(session.cad.playerUnit()?.callId).toBe(call?.id);
    expect(session.phase6.backup.officers().length).toBeGreaterThan(0);
    expect(flashes.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    h.reset(session);
  }, 120_000);

  it('a pursuit: spikes, the air unit, a PIT contact, the supervisor\'s order, the bail-out and the perimeter; two runs give bit-identical v8 saves', () => {
    const h = fresh();
    const run = (): { saved: string; events: Captured } => {
      const session = h.start(SEED);
      const events = pursuitScenario(h, session, 0, 120);
      const data = serializeGame(session);
      h.reset(session);
      return { saved: JSON.stringify(data), events };
    };
    const first = run();
    const ev = first.events;
    expect(has(ev, 'scene:pursuit', '"kind":"vehicle","active":true')).toBe(true);
    expect(has(ev, 'resource:dispatched', 'SGT-1')).toBe(true);
    expect(has(ev, 'pursuit:order', '"order":"terminate"')).toBe(true);
    // The spikes request at 20 s is either set (and judged) or refused as unreachable in time: never silently accepted.
    expect(has(ev, 'pursuit:tactic', '"tactic":"spikes"') || has(ev, 'pursuit:flash', 'No unit can reach it in time')).toBe(true);
    expect(has(ev, 'pursuit:tactic', '"tactic":"pit"')).toBe(true);
    expect(has(ev, 'resource:dispatched', 'AIR-1')).toBe(true);
    expect(has(ev, 'scene:pursuit', '"kind":"foot","active":true')).toBe(true);
    expect(has(ev, 'pursuit:tactic', '"tactic":"perimeter"')).toBe(true);
    const second = run();
    expect(second.saved).toBe(first.saved);
    expect(isSaveGame(JSON.parse(first.saved))).toBe(true);
  }, 480_000);

  it('a save made mid-pursuit (the officer waits at the roadside) loads and continues exactly', () => {
    const h = fresh();
    let mid: SaveGame | null = null;
    const session = h.start(SEED);
    pursuitScenario(h, session, 0, 100, (s) => {
      mid ??= roundTrip(serializeGame(s));
    }, false);
    const original = roundTrip(serializeGame(session));
    h.reset(session);
    expect(mid).not.toBeNull();
    const midSave = mid as unknown as SaveGame;
    expect(midSave.pursuit.pursuit).not.toBeNull();
    const loaded = h.load(midSave);
    expect(blocks(roundTrip(serializeGame(loaded)))).toBe(blocks(midSave));
    pursuitScenario(h, loaded, 45, 100, undefined, false);
    const a = roundTrip(serializeGame(loaded)) as unknown as Record<string, unknown>;
    const b = original as unknown as Record<string, unknown>;
    for (const k of ['roster', 'resources', 'backup', 'pursuit', 'command', 'cad', 'dispatch', 'traffic', 'scenes', 'incidents']) expect(JSON.stringify(a[k]), k).toBe(JSON.stringify(b[k]));
    h.reset(loaded);
  }, 480_000);

  it('a mass-casualty incident: the post, supervisors, the player\'s triage tags, EMS triage; two runs give bit-identical v8 saves', () => {
    const h = fresh();
    const run = (): { saved: string; events: Captured } => {
      const session = h.start(SEED);
      const events = mciScenario(h, session);
      const data = serializeGame(session);
      h.reset(session);
      return { saved: JSON.stringify(data), events };
    };
    const first = run();
    const ev = first.events;
    expect(has(ev, 'command:post', '"open":true')).toBe(true);
    expect(has(ev, 'resource:dispatched', 'LT-1')).toBe(true);
    expect(has(ev, 'resource:dispatched', 'MEDIC-1')).toBe(true);
    expect(has(ev, 'command:triage', '"by":"player"')).toBe(true);
    expect(has(ev, 'command:triage', '"by":"ems"')).toBe(true);
    expect(has(ev, 'resource:arrived', 'MEDIC-1')).toBe(true);
    const second = run();
    expect(second.saved).toBe(first.saved);
    const data = JSON.parse(first.saved) as SaveGame;
    expect(isSaveGame(data)).toBe(true);
    expect(data.command.post).not.toBeNull();
  }, 480_000);

  it('a v7 save loads as v8: the resource units join the CAD, the roster names the officers, and a pursuit and a K9 request work on it', () => {
    const h = fresh();
    const session = h.start(SEED);
    h.step(session, 120);
    const v8 = roundTrip(serializeGame(session));
    h.reset(session);
    // A Phase 5 save: the five Phase 6 blocks are gone, the version is 7.
    const v7: Record<string, unknown> = { ...v8 };
    for (const k of ['roster', 'resources', 'backup', 'pursuit', 'command']) delete v7[k];
    expect(isSaveGameV7(v7)).toBe(true);
    expect(isSaveGame(v7)).toBe(false);
    const migrated = migrateEnvelope({ version: 7, createdAt: 1, updatedAt: 1, slot: 'old', data: v7 });
    expect(migrated.version).toBe(CURRENT_SAVE_VERSION);
    const loaded = h.load(migrated.data);
    expect(loaded.cad.units().filter((u) => u.kind === 'resource')).toHaveLength(23);
    expect(loaded.roster.callsigns().length).toBeGreaterThanOrEqual(6 + 23);
    expect(loaded.roster.profile('SGT-1')?.rank).toBe('sergeant');
    // A pursuit starts on the migrated save ...
    const events = capture(loaded);
    pursuitScenario(h, loaded, 0, 30);
    expect(has(events, 'scene:pursuit', '"kind":"vehicle","active":true')).toBe(true);
    expect(loaded.phase6.pursuit.hud()).not.toBeNull();
    // ... and a K9 requested for its call drives from the station.
    loaded.phase6.requestType('k9', 'mdt');
    h.step(loaded, 600);
    expect(['turnout', 'enRoute', 'onScene']).toContain(loaded.cad.unit('K9-1')?.status);
    const eta0 = loaded.phase6.resources.eta('K9-1');
    h.step(loaded, 1200);
    const eta1 = loaded.phase6.resources.eta('K9-1');
    expect(eta0).toBeGreaterThan(0);
    expect(eta1 < eta0 || eta1 < 0).toBe(true);
    h.reset(loaded);
  }, 240_000);
});
