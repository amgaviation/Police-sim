import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Transform } from '../../src/ecs/components';
import { PLAYER_SIZE, serializeGame, type GameSession } from '../../src/game/session';
import type { ActorInfo } from '../../src/npc';
import { initRapier } from '../../src/physics/physics';
import { driverDoorPoint } from '../../src/player/mode';
import { migrateEnvelope } from '../../src/save/migrations';
import { CURRENT_SAVE_VERSION, isSaveGame, type SaveGame } from '../../src/save/schema';
import { VehicleLook } from '../../src/vehicles/components';
import { VEHICLE_MODELS } from '../../src/vehicles/model';
import { DISTRICT_NAMES } from '../../src/world/ids';
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

function actorOf(session: GameSession, id: number): ActorInfo {
  const a = session.npc.actor(id, { ...BLANK });
  if (!a) throw new Error(`no actor ${String(id)}`);
  return a;
}

function placeOfficer(session: GameSession, x: number, z: number): void {
  session.physics.getBody(session.player)?.setTranslation({ x, y: PLAYER_SIZE.y / 2, z }, true);
  Transform.x[session.player] = x;
  Transform.z[session.player] = z;
}

function say(session: GameSession, h: Harness, contactId: number, utteranceId: string, steps = 300): void {
  session.contact.request({ kind: 'say', contactId, utteranceId, tone: 'polite' });
  h.step(session, steps);
}

/**
 * A car ahead of the patrol car on an arterial, with a speeding violation the officer saw before lighting it up (the
 * traffic module's own violation event), pulled over until it is stopped at the curb. A car that runs is called off.
 */
function stopSpeeder(session: GameSession, h: Harness): number {
  for (let attempt = 0; attempt < 12; attempt++) {
    const patrol = session.vehicles[0];
    if (!patrol) throw new Error('no patrol car');
    session.enterVehicle(patrol);
    const lane = laneRef(58, 0, 0);
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

interface Ids {
  vehicleId: number;
  callId: number;
  driver: number;
  actor: number;
  contact: number;
  key: string;
}

/**
 * Part 1: bodycam on, a speeding car pulled over, the driver's ID, the drinking question (odor), a consent PBT, the driver
 * steps out and fights, a CED application on them (the force system's hit model).
 */
function stopAndTaser(h: Harness, session: GameSession): Ids {
  h.step(session, 60);
  session.investigation.request({ kind: 'bodycam', on: true });
  h.step(session, 5);
  const vehicleId = stopSpeeder(session, h);
  const stop = session.cad.trafficStop;
  if (!stop) throw new Error('no stop');
  const driver = session.npc.occupantsOf(vehicleId)[0] ?? -1;
  session.people.setIntoxication(driver, 0.12, 'none');
  const contact = talkToDriver(session, h);
  say(session, h, contact, 'requestId');
  say(session, h, contact, 'askDrinking');
  say(session, h, contact, 'consentPbt');
  session.contact.request({ kind: 'action', contactId: contact, action: 'pbt' });
  h.step(session, 200);
  say(session, h, contact, 'cmdStepOut');
  const actor = session.npc.actorOfPerson(driver);
  if (actor <= 0) throw new Error('the driver did not step out');
  // The driver attacks: the scene's fight state, then the CED from 3 m.
  session.npc.forceState(actor, 'fight');
  h.step(session, 30);
  const a = actorOf(session, actor);
  placeOfficer(session, a.x - 3, a.z);
  h.step(session, 5);
  session.force.request({ kind: 'selectTool', tool: 'taser' });
  h.step(session, 5);
  const target = actorOf(session, actor);
  const at = session.playerPosition({ x: 0, z: 0 });
  const len = Math.hypot(target.x - at.x, target.z - at.z);
  session.force.request({ kind: 'apply', dirX: (target.x - at.x) / len, dirZ: (target.z - at.z) / len });
  h.step(session, 10);
  return { vehicleId, callId: stop.callId, driver, actor, contact, key: session.incidents.current };
}

/** Part 2: kneel and cuff, the rights, a question in custody, the booking (a court case), the call cleared. */
function arrestAndBook(h: Harness, session: GameSession, ids: Ids): void {
  session.npc.forceState(ids.actor, 'kneel');
  h.step(session, 200);
  const a = actorOf(session, ids.actor);
  placeOfficer(session, a.x - 1.2, a.z);
  h.step(session, 30);
  session.contact.request({ kind: 'action', contactId: ids.contact, action: 'cuff' });
  h.step(session, 200);
  say(session, h, ids.contact, 'miranda');
  say(session, h, ids.contact, 'askDrugs');
  const t = session.now();
  const draft = session.cad.docs.create(
    'booking',
    { callId: ids.callId, personId: ids.driver, charges: ['TR-360'], arrestLocation: 'test', arrestedGame: t.game },
    t,
    'Officer Doe #4071',
  );
  session.cad.docs.finalize(draft.id, t);
  h.step(session, 30);
  session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'clearCall', callId: ids.callId, disposition: 'arrestMade' }, 'key');
  h.step(session, 300);
}

/** The Phase 5 blocks and the clock-free parts of a save, as one string. */
function blocks(d: SaveGame): string {
  return JSON.stringify({ force: d.force, incidents: d.incidents, conduct: d.conduct, court: d.court, cad: d.cad, people: d.people, rng: d.rngState });
}

describe('Phase 5 session', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });
  function fresh(): Harness {
    const h = new Harness(city);
    live.push(h);
    return h;
  }

  it('records the stop, judges it, filed a case and moves trust; two runs give bit-identical v7 saves', () => {
    const h = fresh();
    const run = (): { json: string; ids: Ids; session: GameSession | null } => {
      const session = h.start(SEED);
      const ids = stopAndTaser(h, session);
      const duringForce = { legal: { ...session.phase5.legal }, hud: { ...session.force.hud } };
      expect(duringForce.hud.tool).toBe('taser');
      expect(duringForce.legal.text).toMatch(/^CED on assaultive resistance: within policy/);
      arrestAndBook(h, session, ids);
      const data = serializeGame(session);
      // The incident: a complete event log with camera bits, closed and judged.
      const log = session.incidents.log(ids.key);
      expect(log?.closed).toBe(true);
      const kinds = new Set(log?.events.map((e) => e.kind));
      for (const kind of ['start', 'detention', 'indicator', 'statement', 'consent', 'test', 'force', 'arrest', 'miranda', 'question', 'close']) expect(kinds.has(kind as never), kind).toBe(true);
      const force = log?.events.find((e) => e.kind === 'force');
      expect(force).toMatchObject({ tool: 'taser', resistance: 'assaultive', hit: true });
      expect((force?.cam ?? 0) & 1).toBe(1);
      const assessment = session.incidents.assessment(ids.key);
      expect(assessment?.rulesetId).toBe('generic');
      expect(assessment?.force[0]).toMatchObject({ verdict: 'justified', ruleIds: ['GS-8.1'] });
      expect(assessment?.determinations.find((d) => d.doctrine === 'detention')?.outcome).toBe('lawful');
      expect(assessment?.summary.excessiveForce).toBe(0);
      // Consequences: the booking opened a court case with a hearing; conduct counted the incident and moved trust.
      const cases = session.court.cases();
      expect(cases.length).toBe(1);
      expect(cases[0]).toMatchObject({ docKind: 'booking', key: ids.key });
      // A plea is rolled when the case opens: either it is settled at once, or a hearing is scheduled and on the calendar.
      expect(['scheduled', 'pleaded']).toContain(cases[0]?.status);
      if (cases[0]?.status === 'scheduled') expect(session.court.next(session.env.time.totalSeconds)?.id).toBe(cases[0].id);
      expect(session.conduct.career.stats.incidents).toBe(1);
      expect(session.conduct.career.stats.arrests).toBe(1);
      expect(session.conduct.trustRows().some((r) => Math.abs(r.value - r.baseline) > 1e-6)).toBe(true);
      // Trust is per district: the incident carries the lowercase district id, and that district moves well past the spill.
      const district = log?.district ?? '';
      expect(DISTRICT_NAMES as readonly string[]).toContain(district);
      const deltas = session.conduct.trustRows().map((r) => ({ district: r.district, move: Math.abs(r.value - r.baseline) }));
      const own = deltas.find((r) => r.district === district)?.move ?? 0;
      const others = Math.max(...deltas.filter((r) => r.district !== district).map((r) => r.move));
      expect(own).toBeGreaterThan(others * 2);
      // The report checklist hides the truth and offers true and false statements.
      const choices = session.incidents.reportChoices(ids.key);
      expect(choices.some((c) => c.truth === 'true')).toBe(true);
      expect(choices.some((c) => c.truth === 'false' || c.truth === 'unsupported')).toBe(true);
      h.reset(session);
      return { json: JSON.stringify(data), ids, session: null };
    };
    const first = run();
    const second = run();
    expect(second.json).toBe(first.json);
    const data = JSON.parse(first.json) as SaveGame;
    expect(isSaveGame(data)).toBe(true);
    expect(data.incidents.logs.length).toBe(1);
    expect(data.court.cases.length).toBe(1);
  }, 240_000);

  it('a v7 save made mid-incident continues exactly: the force, incident, conduct and court blocks match the original run', () => {
    const h = fresh();
    const session = h.start(SEED);
    const ids = stopAndTaser(h, session);
    const mid = roundTrip(serializeGame(session));
    expect(mid.force.attached).not.toBeNull();
    expect(mid.incidents.logs[0]?.closed).toBe(false);
    arrestAndBook(h, session, ids);
    const original = roundTrip(serializeGame(session));
    h.reset(session);
    const loaded = h.load(mid);
    expect(blocks(roundTrip(serializeGame(loaded)))).toBe(blocks(mid));
    expect(loaded.incidents.current).toBe(ids.key);
    arrestAndBook(h, loaded, ids);
    expect(blocks(roundTrip(serializeGame(loaded)))).toBe(blocks(original));
  }, 240_000);

  it('a v6 save loads (incidents empty, trust at its baselines) and a stop played on it closes an incident', () => {
    const h = fresh();
    const session = h.start(SEED);
    h.step(session, 120);
    const v7 = roundTrip(serializeGame(session));
    h.reset(session);
    const { force: _f, incidents: _i, conduct: _c, court: _o, ...v6 } = v7;
    const migrated = migrateEnvelope({ version: 6, createdAt: 1, updatedAt: 1, slot: 't', data: v6 });
    expect(migrated.version).toBe(CURRENT_SAVE_VERSION);
    const loaded = h.load(migrated.data);
    expect(loaded.incidents.keys()).toEqual([]);
    expect(loaded.conduct.trustRows().every((r) => r.value === r.baseline)).toBe(true);
    const ids = stopAndTaser(h, loaded);
    arrestAndBook(h, loaded, ids);
    expect(loaded.incidents.log(ids.key)?.closed).toBe(true);
    expect(loaded.incidents.assessment(ids.key)).not.toBeNull();
    expect(loaded.court.cases().length).toBe(1);
  }, 240_000);
});
