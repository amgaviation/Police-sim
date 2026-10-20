import { appendFileSync } from 'node:fs';
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
function P(...a: unknown[]): void { appendFileSync('/tmp/claude-0/probe_out.txt', a.map(String).join(' ') + '\n'); }
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
function stopSpeeder(session: GameSession, h: Harness, edge = 58): number {
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
 * steps out and fights, a TASER application on them (the force system's hit model).
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
  // The driver attacks: the scene's fight state, then the TASER from 3 m.
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


describe('probe', () => {
  it('backup on a stop', () => {
    const h = new Harness(city);
    const session = h.start(SEED);
    h.step(session, 60);
    const sp = city.spawn;
    let best = 58; let bd = Infinity;
    for (const e of city.graph.edges) { if (e.length < 160) continue; const m = city.graph.lanePoint(laneRef(e.id, 0, 0), city.graph.laneStart(laneRef(e.id, 0, 0)) + 60, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 }); const d = Math.hypot(m.x - sp.x, m.z - sp.z); if (d < bd && d > 80) { bd = d; best = e.id; } }
    P('edge', best, bd);
    const vehicleId = stopSpeeder(session, h, best);
    const contact = talkToDriver(session, h);
    P('PROBE stop', vehicleId, contact);
    if (process.env.NORANK) session.dispatcher.setUnitRanker(null);
    session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'backup', code: 2 }, 'key');
    P('target', JSON.stringify(session.playerPosition({x:0,z:0})));
    const events: string[] = [];
    session.bus.on('backup:callout', (e) => events.push('callout ' + e.callsign + ' ' + e.kind + ' ' + e.text));
    session.bus.on('backup:radio', (e) => events.push('radio ' + e.speaker + ': ' + e.text));
    session.bus.on('resource:dispatched', (e) => events.push('disp ' + e.callsign));
    for (let i = 0; i < 60 * 150; i++) {
      h.step(session, 1);
      if (i % 600 === 0) P('PROBE t', i / 60, JSON.stringify(session.phase6.backup.officers().map((o) => [o.callsign, o.state, o.role])), JSON.stringify(session.cad.units().filter((u) => u.kind === 'ai' && u.status !== 'available').map((u) => [u.callsign, u.status, Math.round(u.x), Math.round(u.z), session.phase6.resources.eta(u.callsign)])));
    }
    P('PROBE events', events.join('\n'));
    h.reset(session);
  }, 120000);
});
