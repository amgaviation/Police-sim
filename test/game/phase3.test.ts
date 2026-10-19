import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { familyDef } from '../../src/calls';
import { Transform } from '../../src/ecs/components';
import { createMdtDeps } from '../../src/game/mdtDeps';
import { PLAYER_SIZE, headingOf, serializeGame, type GameSession } from '../../src/game/session';
import type { ActorInfo } from '../../src/npc';
import { initRapier } from '../../src/physics/physics';
import { driverDoorPoint } from '../../src/player/mode';
import { migrateEnvelope } from '../../src/save/migrations';
import { CURRENT_SAVE_VERSION, isSaveGame, type SaveGame } from '../../src/save/schema';
import { BEHAVIOR } from '../../src/traffic/trafficSystem';
import { MdtOverlay } from '../../src/ui/mdt/overlay';
import { VehicleLook } from '../../src/vehicles/components';
import type { DrivableVehicle } from '../../src/vehicles/drivableVehicle';
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

function blank(): ActorInfo {
  return {
    id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false,
    following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

function vehicle(session: GameSession, index: number): DrivableVehicle {
  const v = session.vehicles[index];
  if (!v) throw new Error(`no vehicle ${String(index)}`);
  return v;
}

function placeOfficer(session: GameSession, x: number, z: number): void {
  session.physics.getBody(session.player)?.setTranslation({ x, y: PLAYER_SIZE.y / 2, z }, true);
  Transform.x[session.player] = x;
  Transform.z[session.player] = z;
}

function yawOf(eid: number): number {
  return headingOf(Transform.qx[eid] ?? 0, Transform.qy[eid] ?? 0, Transform.qz[eid] ?? 0, Transform.qw[eid] ?? 1);
}

function actorOf(session: GameSession, id: number): ActorInfo {
  const a = session.npc.actor(id, blank());
  if (!a) throw new Error(`no actor ${String(id)}`);
  return a;
}

/** Spawns `typeId` calls until one has all of `roles` and none of the random variants. */
function spawnWith(session: GameSession, h: Harness, typeId: string, roles: readonly string[], at: { x: number; z: number }): number {
  for (let k = 0; k < 40; k++) {
    const id = session.scene.spawnCall(typeId, session.now(), at, []);
    const rt = session.scene.runtime(id);
    if (rt && roles.every((r) => rt.scenario.participants.some((p) => p.role === r)) && rt.scenario.variants.length === 0) return id;
    session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'clearCall', callId: id, disposition: 'unfounded' }, 'key');
    h.step(session, 2);
  }
  throw new Error(`no ${typeId} with ${roles.join('+')}`);
}

/** Accepts the call, goes to its anchor and waits for the scene to materialize and the officer to arrive. */
function goToScene(session: GameSession, h: Harness, callId: number): void {
  const rt = session.scene.runtime(callId);
  if (!rt) throw new Error('no scenario');
  session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'selfAssign', callId }, 'key');
  h.step(session, 5);
  session.teleport(rt.scenario.anchor.x - 15, rt.scenario.anchor.z);
  h.step(session, 120);
}

/** Walks the on-foot officer to (x, z) at about 1.8 m/s, stopping early once `until` holds. */
function walkTo(session: GameSession, h: Harness, x: number, z: number, until: () => boolean, maxSteps = 6000): number {
  let n = 0;
  for (; n < maxSteps && !until(); n++) {
    const p = session.playerPosition({ x: 0, z: 0 });
    const d = Math.hypot(x - p.x, z - p.z);
    const k = Math.min(1, 0.03 / Math.max(d, 1e-6));
    placeOfficer(session, p.x + (x - p.x) * k, p.z + (z - p.z) * k);
    h.step(session, 1);
  }
  return n;
}

function say(session: GameSession, h: Harness, contactId: number, utteranceId: string, steps = 300): void {
  session.contact.request({ kind: 'say', contactId, utteranceId, tone: 'polite' });
  h.step(session, steps);
}

function rearDoor(car: DrivableVehicle): { x: number; z: number } {
  const eid = car.eid;
  const yaw = yawOf(eid);
  const back = car.model.body.length * 0.15;
  const side = car.model.body.width / 2 + 0.2;
  return {
    x: (Transform.x[eid] ?? 0) + Math.sin(yaw) * back + Math.cos(yaw) * side,
    z: (Transform.z[eid] ?? 0) + Math.cos(yaw) * back - Math.sin(yaw) * side,
  };
}

/**
 * Puts a car 14 m ahead of the patrol car on an arterial and lights it up until it is stopped at the curb. Some
 * drivers run (a wanted driver, a stolen car; the scene rolls it at the pull-over): that pursuit is called off, the
 * car removed and the next one tried, so the script always ends with a stopped car.
 */
function stopCarAhead(session: GameSession, h: Harness, behavior: number): number {
  for (let attempt = 0; attempt < 12; attempt++) {
    session.enterVehicle(vehicle(session, 0));
    const lane = laneRef(58, 0, 0);
    const s0 = city.graph.laneStart(lane) + 40;
    const p = city.graph.lanePoint(lane, s0, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    session.teleport(p.x, p.z, p.yaw);
    h.step(session, 30);
    const slot = session.traffic.spawnAt(lane, s0 + 14, { speed: 4, behavior, desiredFactor: 0.3 });
    const vehicleId = session.traffic.view.vehicleId[slot] ?? -1;
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
    // The car ran or the stop did not form: call it off and try the next car.
    session.traffic.stopFlee(vehicleId);
    session.traffic.removeVehicle(vehicleId);
    const pu = session.cad.playerUnit();
    if (pu?.callId != null) session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'clearCall', callId: pu.callId, disposition: 'handled' }, 'key');
    h.step(session, 120);
  }
  throw new Error('no car could be stopped');
}

/** Gets out and stands at the stopped car's driver window; opens the driver contact with E. Returns the contact id. */
function talkToDriver(session: GameSession, h: Harness): number {
  expect(session.interact()).toBe('exited');
  const st = session.traffic.stopState({ vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 });
  if (!st) throw new Error('no stop target');
  const model = VEHICLE_MODELS[VehicleLook.model[st.eid] ?? 0];
  if (!model) throw new Error('no model');
  const w = driverDoorPoint({ eid: st.eid, x: st.x, z: st.z, yaw: st.yaw, halfWidth: model.body.width / 2, halfLength: model.body.length / 2, speed: 0 }, { x: 0, z: 0 });
  placeOfficer(session, w.x, w.z);
  h.step(session, 10);
  expect(session.interactHint()).toBe('driver');
  expect(session.interact()).toBe('contact');
  h.step(session, 10);
  expect(session.contact.active).toBeGreaterThan(0);
  return session.contact.active;
}

/**
 * Phase 3 script: a domestic disturbance (accept, walk, knock, a victim contact with ID and account, kneel and
 * cuff the suspect, escort to a patrol car, cage), then a DUI traffic stop (ID request, drinking question, PBT).
 */
function phase3Script(h: Harness, session: GameSession): { callId: number; victim: number; suspect: number; driver: number } {
  h.step(session, 60);
  const at = session.playerPosition({ x: 0, z: 0 });
  const callId = spawnWith(session, h, 'domesticDisturbance', ['victim', 'suspect'], { x: at.x + 30, z: at.z - 30 });
  const rt = session.scene.runtime(callId);
  if (!rt) throw new Error('no scenario');
  goToScene(session, h, callId);
  const family = familyDef(rt.scenario.family);
  if (!family) throw new Error('no family');
  session.scene.panelSelect(callId, family.actions.indexOf('knock'));
  h.step(session, 900);
  const actors = rt.actorIds.filter((a) => a > 0).map((aid) => actorOf(session, aid));
  const victim = actors.find((a) => a.role === 'victim');
  const suspect = actors.find((a) => a.role === 'suspect');
  if (!victim || !suspect) throw new Error('victim and suspect expected');
  // The victim: ID and account.
  placeOfficer(session, victim.x - 1.2, victim.z);
  session.controller.yaw = Math.PI / 2;
  h.step(session, 30);
  session.contact.request({ kind: 'open', target: { kind: 'actor', actorId: victim.id } });
  h.step(session, 5);
  const vc = session.contact.active;
  say(session, h, vc, 'requestId');
  say(session, h, vc, 'askAccount', 400);
  session.contact.request({ kind: 'close', contactId: vc });
  // The suspect: kneels (the command roll is the module's business; the script forces compliance), cuffed, escorted, caged.
  const sa = actorOf(session, suspect.id);
  placeOfficer(session, sa.x - 1.2, sa.z);
  h.step(session, 30);
  session.contact.request({ kind: 'open', target: { kind: 'actor', actorId: suspect.id } });
  h.step(session, 5);
  const sc = session.contact.active;
  session.npc.forceState(suspect.id, 'kneel');
  h.step(session, 90);
  session.contact.request({ kind: 'action', contactId: sc, action: 'cuff' });
  h.step(session, 120);
  session.contact.request({ kind: 'action', contactId: sc, action: 'escort' });
  h.step(session, 30);
  session.contact.request({ kind: 'close', contactId: sc });
  h.step(session, 5);
  // A patrol car at the scene: walk the prisoner to its rear door.
  const car = vehicle(session, 0);
  const pos = session.playerPosition({ x: 0, z: 0 });
  const body = session.physics.getBody(car.eid);
  body?.setTranslation({ x: pos.x + 8, y: Transform.y[car.eid] ?? 1, z: pos.z }, true);
  body?.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  body?.setLinvel({ x: 0, y: 0, z: 0 }, true);
  Transform.x[car.eid] = pos.x + 8;
  Transform.z[car.eid] = pos.z;
  h.step(session, 10);
  const door = rearDoor(car);
  walkTo(session, h, door.x, door.z, () => session.cageCarIndex() >= 0);
  expect(session.interact()).toBe('cage');
  h.step(session, 10);
  // Clear the domestic with the suggested disposition (the officer is free for the next job).
  session.scene.request({ kind: 'clear', callId, disposition: null });
  h.step(session, 60);
  // The DUI stop.
  // The driver is made drunk once the car has stopped (the ambient flee roll happens at the pull-over).
  const vehicleId = stopCarAhead(session, h, 0);
  const driver = session.npc.occupantsOf(vehicleId)[0] ?? -1;
  session.people.setIntoxication(driver, 0.12, 'none');
  const dc = talkToDriver(session, h);
  say(session, h, dc, 'requestId');
  say(session, h, dc, 'askDrinking');
  say(session, h, dc, 'consentPbt');
  session.contact.request({ kind: 'action', contactId: dc, action: 'pbt' });
  h.step(session, 200);
  return { callId, victim: victim.personId, suspect: suspect.personId, driver };
}

describe('Phase 3 session', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });
  function fresh(): Harness {
    const h = new Harness(city);
    live.push(h);
    return h;
  }

  it('replays the scripted Phase 3 shift to bit-identical v5 saves', () => {
    const h = fresh();
    const run = (): { json: string; ids: ReturnType<typeof phase3Script> } => {
      const session = h.start(SEED);
      const ids = phase3Script(h, session);
      const data = serializeGame(session);
      expect(session.prisoner()).toBe(ids.suspect);
      h.reset(session);
      return { json: JSON.stringify(data), ids };
    };
    const first = run();
    const second = run();
    expect(second.json).toBe(first.json);
    const data = JSON.parse(first.json) as SaveGame;
    expect(isSaveGame(data)).toBe(true);
    expect(data.equipment.some((e) => e?.prisoner === first.ids.suspect)).toBe(true);
    // People: the touched persons carry their statements, facts and custody.
    const person = (id: number): SaveGame['people']['persons'][number] | undefined => data.people.persons.find((p) => p.id === id);
    expect(person(first.ids.victim)?.statements?.some((s) => s.fact === 'account')).toBe(true);
    expect(person(first.ids.victim)?.facts?.some((f) => f.topic === 'identity')).toBe(true);
    expect(person(first.ids.suspect)?.custody).toBe('arrested');
    expect(person(first.ids.driver)?.facts?.some((f) => f.topic === 'drinking' && f.source === 'evidence' && f.display.startsWith('Breath test'))).toBe(true);
    // Calls: the cleared domestic is a graded outcome with its branch; the other calls keep their scenarios and flags.
    const outcome = data.scenes.closed.find((o) => o.callId === first.ids.callId);
    expect(outcome?.typeId).toBe('domesticDisturbance');
    expect(outcome?.branch).not.toBe('');
    expect(outcome?.forceUsed).toBeDefined();
    expect(data.scenes.scenarios.length).toBeGreaterThan(0);
    expect(data.scenes.scenarios.every((s) => s.flags.some((f) => f.startsWith('branch:')) || s.scenario.family === 'trafficStop')).toBe(true);
    expect(data.contacts.contacts.length).toBeGreaterThan(0);
    expect(data.npc).not.toBeNull();
    h.dispose();
  }, 180_000);

  it('a v5 save made mid-scene continues exactly: people, scenes, contacts, npc and CAD match the original run', () => {
    const h = fresh();
    const session = h.start(SEED);
    phase3Script(h, session);
    const mid = roundTrip(serializeGame(session));
    const blocks = (d: SaveGame): string =>
      JSON.stringify({ people: d.people, npc: d.npc, contacts: d.contacts, scenes: d.scenes, cad: d.cad, dispatch: d.dispatch, records: d.records, traffic: d.traffic, rng: d.rngState });
    h.step(session, 1800);
    const original = roundTrip(serializeGame(session));
    h.reset(session);
    const loaded = h.load(mid);
    // Loading restores every Phase 3 block exactly ...
    expect(blocks(roundTrip(serializeGame(loaded)))).toBe(blocks(mid));
    // ... and the continuation is the same run.
    h.step(loaded, 1800);
    expect(blocks(roundTrip(serializeGame(loaded)))).toBe(blocks(original));
    h.dispose();
  }, 180_000);

  it('a migrated v4 save with an open call gets a scenario for it (adoptOpenCalls) and loads as the current version', () => {
    const h = fresh();
    const session = h.start(SEED);
    h.step(session, 60);
    const id = session.dispatcher.createCall('noiseComplaint', session.now());
    expect(id).not.toBeNull();
    const v5 = roundTrip(serializeGame(session));
    // A v4 save has none of the Phase 3 blocks.
    const { people: _p, npc: _n, contacts: _c, scenes: _s, interiors: _i, tactical: _t, investigation: _v, station: _st, ...v4 } = v5;
    h.reset(session);
    const migrated = migrateEnvelope({ version: 4, createdAt: 1, updatedAt: 1, slot: 't', data: v4 });
    expect(migrated.version).toBe(CURRENT_SAVE_VERSION);
    const loaded = h.load(migrated.data);
    const open = loaded.cad.openCalls().filter((c) => c.typeId === 'noiseComplaint');
    expect(open.length).toBeGreaterThan(0);
    for (const c of open) expect(loaded.scene.runtime(c.id)).not.toBeNull();
    h.step(loaded, 120);
    h.dispose();
  }, 120_000);

  it('DUI stop to booking: odor, PBT, SFST, step out, cuff, cage, then the booking at the station puts the person in jail', () => {
    const h = fresh();
    const session = h.start(SEED);
    const vehicleId = stopCarAhead(session, h, BEHAVIOR.dui);
    const stop = session.cad.trafficStop;
    if (!stop) throw new Error('no stop');
    const driver = session.npc.occupantsOf(vehicleId)[0] ?? -1;
    session.people.setIntoxication(driver, 0.12, 'none');
    const cid = talkToDriver(session, h);
    say(session, h, cid, 'greet', 120);
    say(session, h, cid, 'requestId');
    say(session, h, cid, 'askDrinking');
    say(session, h, cid, 'consentPbt');
    session.contact.request({ kind: 'action', contactId: cid, action: 'pbt' });
    h.step(session, 200);
    say(session, h, cid, 'cmdStepOut');
    say(session, h, cid, 'consentSfst');
    session.contact.request({ kind: 'action', contactId: cid, action: 'sfst' });
    h.step(session, 30);
    expect(session.contact.sfstView()?.title).toBe('Horizontal gaze nystagmus');
    for (let i = 0; i < 4000 && session.contact.sfstView() && !session.contact.sfstView()?.finished; i++) {
      const prompt = session.contact.sfstView()?.prompt;
      if (prompt) session.contact.request({ kind: 'sfstKey', key: prompt.includes('(A)') ? 'a' : prompt.includes('(D)') ? 'd' : prompt.includes('(W)') ? 'w' : 'space' });
      h.step(session, 5);
    }
    expect(session.contact.sfstView()?.finished).toBe(true);
    say(session, h, cid, 'cmdHandsUp');
    session.contact.request({ kind: 'action', contactId: cid, action: 'cuff' });
    h.step(session, 120);
    expect(session.people.state(driver).custody).toBe('arrested');
    expect(session.cad.trafficStop?.outcome).toBe('arrest');
    session.contact.request({ kind: 'action', contactId: cid, action: 'escort' });
    h.step(session, 30);
    session.contact.request({ kind: 'close', contactId: cid });
    const door = rearDoor(vehicle(session, 0));
    walkTo(session, h, door.x, door.z, () => session.cageCarIndex() >= 0);
    expect(session.interactHint()).toBe('cage');
    expect(session.interact()).toBe('cage');
    h.step(session, 10);
    expect(session.prisoner()).toBe(driver);
    // The statements and facts the player collected are in the people block.
    const facts = session.people.facts(driver);
    expect(facts.some((f) => f.topic === 'drinking' && f.source === 'evidence')).toBe(true);
    expect(facts.some((f) => f.topic === 'identity')).toBe(true);
    // Booking at the station.
    const released: number[] = [];
    const mdt = new MdtOverlay(null, createMdtDeps(session, { target: () => null, bookingCompleted: (_id, who) => released.push(who) }));
    session.teleport(city.spawn.x, city.spawn.z);
    expect(session.atStation()).toBe(true);
    const done = mdt.saveDocument('booking', { personId: driver, charges: ['PC-220'], arrestLocation: 'test', callId: stop.callId }, true);
    expect(done.errors).toEqual([]);
    expect(released).toEqual([driver]);
    h.step(session, 2);
    expect(session.people.state(driver).custody).toBe('jailed');
    expect(session.people.facts(driver).some((f) => f.source === 'booking')).toBe(true);
    mdt.dispose();
  }, 180_000);

  it('a stolen-identity claim, citation form and release: the stop driver contact writes a citation and the stop closes as cited', () => {
    const h = fresh();
    const session = h.start(SEED);
    const forms: { kind: string; callId: number }[] = [];
    session.bus.on('contact:openForm', (e) => forms.push({ kind: e.kind, callId: e.callId }));
    const vehicleId = stopCarAhead(session, h, 0);
    const stop = session.cad.trafficStop;
    if (!stop) throw new Error('no stop');
    const cid = talkToDriver(session, h);
    say(session, h, cid, 'requestId');
    say(session, h, cid, 'askDestination');
    session.contact.request({ kind: 'action', contactId: cid, action: 'runId' });
    h.step(session, 120);
    session.contact.request({ kind: 'action', contactId: cid, action: 'writeCitation' });
    h.step(session, 30);
    expect(forms).toContainEqual({ kind: 'citation', callId: stop.callId });
    // The MDT writes the form the contact asked for.
    const t = session.now();
    const draft = session.cad.docs.create(
      'citation',
      { callId: stop.callId, personId: session.cad.trafficStop?.driverId ?? -1, vehicleId, plate: stop.plate, location: 'test', violations: [{ statuteId: 'TR-301', fine: 150, detail: '45 in a 30' }] },
      t,
      'Officer Doe #4071',
    );
    session.cad.docs.finalize(draft.id, t);
    h.step(session, 30);
    session.contact.request({ kind: 'action', contactId: cid, action: 'release' });
    h.step(session, 1200);
    expect(session.cad.trafficStop?.outcome).toBe('released');
    expect(session.cad.call(stop.callId)?.disposition).toBe('citationIssued');
    // The ID check recorded a record fact next to what the driver said.
    const driver = session.npc.occupantsOf(vehicleId)[0] ?? -1;
    expect(session.people.facts(driver).some((f) => f.source === 'record' || f.source === 'document')).toBe(true);
  }, 180_000);

  it('shoplifting: the store guard and the detained suspect are on scene; cuffing the suspect resolves the call as an arrest', () => {
    const h = fresh();
    const session = h.start(SEED);
    h.step(session, 60);
    const at = session.playerPosition({ x: 0, z: 0 });
    let callId = 0;
    for (let k = 0; k < 40 && callId === 0; k++) {
      const id = session.scene.spawnCall('shopliftingDetained', session.now(), { x: at.x + 30, z: at.z - 30 }, []);
      const rt0 = session.scene.runtime(id);
      if (rt0?.scenario.branch === 'detained' && rt0.scenario.variants.length === 0) callId = id;
      else session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'clearCall', callId: id, disposition: 'unfounded' }, 'key');
      h.step(session, 2);
    }
    const rt = session.scene.runtime(callId);
    if (!rt) throw new Error('no shoplifting scenario');
    goToScene(session, h, callId);
    h.step(session, 300);
    const actors = rt.actorIds.filter((a) => a > 0).map((a) => actorOf(session, a));
    const guard = actors.find((a) => a.role === 'guard');
    const suspect = actors.find((a) => a.role === 'suspect');
    expect(guard).toBeDefined();
    expect(suspect).toBeDefined();
    if (!guard || !suspect) return;
    for (const a of [guard, suspect]) {
      const now = actorOf(session, a.id);
      placeOfficer(session, now.x - 1.2, now.z);
      h.step(session, 20);
      session.contact.request({ kind: 'open', target: { kind: 'actor', actorId: a.id } });
      h.step(session, 5);
      const cid = session.contact.active;
      say(session, h, cid, 'requestId');
      say(session, h, cid, 'askAccount', 400);
      session.contact.request({ kind: 'close', contactId: cid });
      h.step(session, 5);
    }
    expect(rt.flags.has('contacted:guard')).toBe(true);
    expect(rt.flags.has('contacted:suspect')).toBe(true);
    expect(session.people.statements(guard.personId).length).toBeGreaterThan(0);
    expect(session.people.statements(suspect.personId).length).toBeGreaterThan(0);
    // Detain and cuff the suspect: custody resolves the call as an arrest.
    const sa = actorOf(session, suspect.id);
    placeOfficer(session, sa.x - 1.2, sa.z);
    h.step(session, 20);
    session.contact.request({ kind: 'open', target: { kind: 'actor', actorId: suspect.id } });
    h.step(session, 5);
    const sc = session.contact.active;
    session.npc.forceState(suspect.id, 'kneel');
    h.step(session, 90);
    session.contact.request({ kind: 'action', contactId: sc, action: 'cuff' });
    h.step(session, 120);
    expect(rt.flags.has('custody:suspect')).toBe(true);
    session.scene.request({ kind: 'clear', callId, disposition: null });
    // An AI unit assigned to the call clears first or later; the call closes with the last unit.
    for (let i = 0; i < 100 && session.cad.call(callId)?.status !== 'closed'; i++) h.step(session, 600);
    expect(session.cad.call(callId)?.status).toBe('closed');
    const outcome = session.scene.outcomes().find((o) => o.callId === callId);
    expect(outcome?.outcomeId).toBe('arrest');
    // The recorded disposition is the last unit's; the scene's suggestion follows the flags.
    expect(outcome?.suggested).toBe('arrestMade');
  }, 120_000);

  it('lie detection: people carrying a fake ID give a false identity; running the name shows what contradicts the record, and nothing before', () => {
    const h = fresh();
    const session = h.start(SEED);
    h.step(session, 10);
    const liars: number[] = [];
    for (let p = 0; p < 20_000 && liars.length < 4; p++) {
      const i = session.people.identity(p);
      if (!i.juvenile && i.age > 20 && i.age < 60 && i.hearing === 'normal' && i.language.english === 'fluent' && !i.dementia && i.baseItems.some((x) => x.item === 'fakeId')) liars.push(p);
    }
    expect(liars.length).toBe(4);
    const at = session.playerPosition({ x: 0, z: 0 });
    const found: string[] = [];
    for (const personId of liars) {
      const aid = session.npc.spawnActor({ personId, x: at.x - 3, z: at.z - 3, yaw: 0, profile: 'suspectNervous', role: 'subject', callId: 0, hidden: false, body: 'human', weapon: null, vehicleId: -1 });
      session.contact.request({ kind: 'open', target: { kind: 'actor', actorId: aid } });
      h.step(session, 5);
      const cid = session.contact.active;
      say(session, h, cid, 'requestId', 360);
      say(session, h, cid, 'askAddress', 360);
      // Before any lookup nothing contradicts the claim: the player knows only what the person said.
      expect(session.contact.view(cid)?.inconsistencies ?? []).toEqual([]);
      session.contact.request({ kind: 'action', contactId: cid, action: 'runName' });
      h.step(session, 360);
      for (const n of session.contact.view(cid)?.inconsistencies ?? []) found.push(`${n.severity}:${n.text}`);
      session.contact.request({ kind: 'close', contactId: cid });
      h.step(session, 5);
    }
    // At least one of them lied about something the record contradicts (no record, a different date of birth or address).
    expect(found.some((f) => f.startsWith('alert:'))).toBe(true);
    // Statements and lookup facts persist on the people block.
    expect(liars.some((p) => session.people.facts(p).some((f) => f.source === 'record'))).toBe(true);
  }, 120_000);

  it('a false call has no actors and a duplicate call is linked and closed in CAD', () => {
    const h = fresh();
    const session = h.start(SEED);
    h.step(session, 60);
    const at = session.playerPosition({ x: 0, z: 0 });
    const falseId = session.scene.spawnCall('noiseComplaint', session.now(), { x: at.x + 30, z: at.z - 30 }, ['false']);
    expect(session.scene.runtime(falseId)?.scenario.variants).toContain('false');
    goToScene(session, h, falseId);
    const frt = session.scene.runtime(falseId);
    expect(frt?.materialized).toBe(true);
    // A false report has its caller and nothing else on scene.
    expect(frt?.scenario.participants.map((p) => p.role)).toEqual(['caller']);
    // Cleared by the officer, it is graded as nothing found (an AI unit assigned too may close the CAD call first).
    session.scene.request({ kind: 'clear', callId: falseId, disposition: null });
    for (let i = 0; i < 100 && session.cad.call(falseId)?.status !== 'closed'; i++) h.step(session, 600);
    expect(session.cad.call(falseId)?.status).toBe('closed');
    expect(['unfounded', 'gone']).toContain(session.scene.outcomes().find((o) => o.callId === falseId)?.outcomeId);
    let dupId = 0;
    for (let k = 0; k < 40 && dupId === 0; k++) {
      const cand = session.scene.spawnCall('loudParty', session.now(), { x: at.x - 40, z: at.z + 40 }, ['duplicate']);
      if (session.scene.runtime(cand)?.scenario.timeline.some((e) => e.kind === 'linkedCall')) dupId = cand;
      else session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'clearCall', callId: cand, disposition: 'unfounded' }, 'key');
      h.step(session, 2);
    }
    expect(dupId).toBeGreaterThan(0);
    h.step(session, 3600);
    const orig = session.cad.call(dupId);
    expect(orig?.links.length).toBeGreaterThan(0);
    const dup = session.cad.call(orig?.links[0] ?? -1);
    expect(dup?.status).toBe('closed');
    expect(dup?.disposition).toBe('duplicate');
    expect(dup?.links).toContain(dupId);
  }, 120_000);

  it('a foot pursuit: the fleeing suspect is chased, tackled and cuffed', () => {
    const h = fresh();
    const session = h.start(SEED);
    h.step(session, 60);
    const at = session.playerPosition({ x: 0, z: 0 });
    const callId = spawnWith(session, h, 'domesticDisturbance', ['suspect'], { x: at.x + 30, z: at.z - 30 });
    const rt = session.scene.runtime(callId);
    if (!rt) throw new Error('no scenario');
    goToScene(session, h, callId);
    const family = familyDef(rt.scenario.family);
    session.scene.panelSelect(callId, family?.actions.indexOf('knock') ?? 0);
    h.step(session, 900);
    const suspect = rt.actorIds.map((a) => (a > 0 ? actorOf(session, a) : null)).find((a) => a?.role === 'suspect');
    if (!suspect) throw new Error('no suspect');
    const pursuits: boolean[] = [];
    session.bus.on('scene:pursuit', (e) => pursuits.push(e.active));
    placeOfficer(session, suspect.x - 3, suspect.z);
    h.step(session, 30);
    session.npc.forceState(suspect.id, 'flee');
    // Chase: run towards the runner each step until a tackle lands.
    let caught = false;
    for (let i = 0; i < 1800 && !caught; i++) {
      const s = actorOf(session, suspect.id);
      const p = session.playerPosition({ x: 0, z: 0 });
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      const k = Math.min(1, 0.09 / Math.max(d, 1e-6));
      placeOfficer(session, p.x + (s.x - p.x) * k, p.z + (s.z - p.z) * k);
      session.controller.yaw = Math.atan2(-(s.x - p.x), -(s.z - p.z));
      if (d < 2) session.scene.request({ kind: 'tackle' });
      h.step(session, 1);
      caught = rt.flags.has(`caught:suspect`);
    }
    expect(pursuits).toContain(true);
    expect(caught).toBe(true);
    expect(rt.flags.has('forceUsed')).toBe(true);
  }, 120_000);
});
