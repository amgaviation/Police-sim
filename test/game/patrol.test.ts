import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DebugConsole } from '../../src/debug/console';
import { Transform } from '../../src/ecs/components';
import { interactPrompt } from '../../src/game/hudFeed';
import { createMdtDeps } from '../../src/game/mdtDeps';
import { contactPanelModel, equipmentPanelModel, trunkPanelModel } from '../../src/game/panels';
import { createPatrolCommands } from '../../src/game/patrolCommands';
import { carriedText, plateResultText, PoliceFeed } from '../../src/game/policeFeed';
import { distanceToPolyline } from '../../src/game/route';
import { GameSession, PLAYER_SIZE, TRUNK_DISTANCE, headingOf, serializeGame } from '../../src/game/session';
import { TargetTracker, describeTarget } from '../../src/game/target';
import { initRapier } from '../../src/physics/physics';
import { driverDoorPoint } from '../../src/player/mode';
import { PoliceLights, SIREN_FLAG, hasPoliceLights } from '../../src/police/components';
import { patternIndex } from '../../src/police/lightbar';
import { migrateEnvelope } from '../../src/save/migrations';
import type { HudSnapshot } from '../../src/ui/hud/hud';
import { MARKER, createMinimapMarkers } from '../../src/ui/hud/minimap';
import { MdtOverlay } from '../../src/ui/mdt/overlay';
import { isFleetVehicleId } from '../../src/traffic/trafficSystem';
import { VEHICLE_MODELS } from '../../src/vehicles/model';
import { VehicleLook } from '../../src/vehicles/components';
import type { DrivableVehicle } from '../../src/vehicles/drivableVehicle';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { laneRef } from '../../src/world/roadGraph';
import { HudFeed } from '../../src/game/hudFeed';
import { makeSaveGameV3 } from '../save/fixtures';
import { Harness, roundTrip } from './harness';

const SEED = 42;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

function vehicle(session: GameSession, index: number): DrivableVehicle {
  const v = session.vehicles[index];
  if (!v) throw new Error(`no vehicle ${String(index)}`);
  return v;
}

function yawOf(eid: number): number {
  return headingOf(Transform.qx[eid] ?? 0, Transform.qy[eid] ?? 0, Transform.qz[eid] ?? 0, Transform.qw[eid] ?? 1);
}

function placeOfficer(session: GameSession, x: number, z: number): void {
  session.physics.getBody(session.player)?.setTranslation({ x, y: PLAYER_SIZE.y / 2, z }, true);
  Transform.x[session.player] = x;
  Transform.z[session.player] = z;
}

/** Creeps after the car ahead until it is the stop target, then brakes to a halt. */
function followAndStop(h: Harness, session: GameSession): void {
  const d = session.driverInput;
  d.handbrake = false;
  d.brake = 0;
  d.accelerate = 0.35;
  for (let i = 0; i < 900 && session.cad.trafficStop === null; i++) h.step(session, 1);
  // Brake only while still rolling forwards (a held brake at a standstill is reverse), then the handbrake.
  d.accelerate = 0;
  d.brake = 1;
  const car = session.drivenVehicle;
  for (let i = 0; i < 300 && (car?.telemetry.speed ?? 0) > 0.2; i++) h.step(session, 1);
  d.brake = 0;
  d.handbrake = true;
  h.step(session, 30);
  d.handbrake = false;
}

/** Drives patrol car 0 onto an arterial, puts a car 14 m ahead and switches the light bar on until it is stopped at the curb. */
function pullOverAhead(h: Harness, session: GameSession): number {
  session.enterVehicle(vehicle(session, 0));
  const lane = laneRef(58, 0, 0);
  const s0 = city.graph.laneStart(lane) + 40;
  const p = city.graph.lanePoint(lane, s0, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
  session.teleport(p.x, p.z, p.yaw);
  h.step(session, 30);
  const slot = session.traffic.spawnAt(lane, s0 + 14, { speed: 4, behavior: 0, desiredFactor: 0.3 });
  const vehicleId = session.traffic.view.vehicleId[slot] ?? -1;
  session.toggleLightbar();
  // Stop detection needs the patrol car moving behind the car (a parked car with scene lights stops no one).
  followAndStop(h, session);
  const stop = session.cad.trafficStop;
  if (!stop) throw new Error('no traffic stop');
  expect(stop.vehicleId).toBe(vehicleId);
  return vehicleId;
}

/** The stopped car's driver window (the stop must be at the curb). */
function stoppedWindow(session: GameSession): { x: number; z: number } {
  const st = session.traffic.stopState({ vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 });
  if (!st) throw new Error('no stop target');
  const model = VEHICLE_MODELS[VehicleLook.model[st.eid] ?? 0];
  if (!model) throw new Error('no model');
  return driverDoorPoint(
    { eid: st.eid, x: st.x, z: st.z, yaw: st.yaw, halfWidth: model.body.width / 2, halfLength: model.body.length / 2, speed: 0 },
    { x: 0, z: 0 },
  );
}

describe('patrol session (Phase 2)', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });
  function fresh(): Harness {
    const h = new Harness(city);
    live.push(h);
    return h;
  }

  it('starts with the CAD roster, the AI units in fleet cars, equipped patrol cars with PoliceLights and an empty kit', () => {
    const h = fresh();
    const session = h.start(SEED);
    const units = session.cad.units();
    expect(units.map((u) => u.callsign)).toEqual(['12', '21', '23', '25', '27', '31', '33']);
    expect(session.cad.playerUnit()?.callsign).toBe(session.dispatcher.playerCallsign);
    for (let i = 0; i < 6; i++) expect(session.traffic.fleetEntity(i)).not.toBe(0);
    for (const v of session.vehicles) {
      const eq = session.equipmentOf(v);
      expect(eq?.spec.mdt).toBe(true);
      expect(hasPoliceLights(h.world, v.eid)).toBe(true);
    }
    expect(session.officerKit.carriedTotal).toBe(0);
    expect(session.trafficCars(500).every((r) => !isFleetVehicleId(r.vehicleId))).toBe(true);
    // Every AI unit's fleet car gets its PoliceLights on the first step.
    h.step(session, 1);
    for (let i = 0; i < 6; i++) expect(hasPoliceLights(h.world, session.traffic.fleetEntity(i))).toBe(true);
  });

  it('writes PoliceLights every step: siren tone, pattern and spotlight; horn and manual only for the driven car', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    const other = vehicle(session, 1);
    const eq = session.equipmentOf(car);
    if (!eq) throw new Error('no equipment');
    session.enterVehicle(car);
    eq.toggleSiren();
    eq.cycleTone();
    eq.setPattern(patternIndex('sweep'));
    eq.toggleSpot();
    eq.aimSpot(0.4, -0.1);
    session.sirenHeld.horn = true;
    session.toggleLightbar();
    h.step(session, 1);
    expect(PoliceLights.siren[car.eid]).toBe(2); // 1 + index of yelp
    expect(PoliceLights.pattern[car.eid]).toBe(patternIndex('sweep'));
    expect(PoliceLights.spot[car.eid]).toBe(1);
    expect(PoliceLights.spotYaw[car.eid]).toBeCloseTo(eq.spotYaw, 5);
    expect(PoliceLights.sirenFlags[car.eid]).toBe(SIREN_FLAG.horn);
    expect(eq.lightsOn).toBe(true);
    expect(PoliceLights.sirenFlags[other.eid]).toBe(0);
    session.sirenHeld.horn = false;
    h.step(session, 1);
    expect(PoliceLights.sirenFlags[car.eid]).toBe(0);
  });

  it('pulls the car ahead over with the light bar; the officer talks to its driver at the window', () => {
    const h = fresh();
    const session = h.start(SEED);
    pullOverAhead(h, session);
    const stop = session.cad.trafficStop;
    expect(stop?.outcome).toBe('active');
    const call = session.cad.call(stop?.callId ?? -1);
    expect(call?.typeId).toBe('trafficStop');
    expect(call?.units).toEqual(['12']);
    expect(session.cad.unit('12')?.status).toBe('onScene');
    // Still driving: no contact; on foot at the window: contact.
    expect(session.atStoppedDriver()).toBe(false);
    for (let i = 0; i < 300 && (vehicle(session, 0).telemetry.groundSpeed > 0.5); i++) h.step(session, 1);
    expect(session.interact()).toBe('exited');
    const w = stoppedWindow(session);
    placeOfficer(session, w.x, w.z);
    expect(session.interactHint()).toBe('driver');
    expect(interactPrompt('driver', 'E')).toBe('E  Talk to the driver');
    expect(session.interact()).toBe('contact');
    placeOfficer(session, w.x + 5, w.z + 5);
    expect(session.atStoppedDriver()).toBe(false);
  });

  it('an arrest seats the driver in the patrol car cage; completing the booking at the station releases them', () => {
    const h = fresh();
    const session = h.start(SEED);
    pullOverAhead(h, session);
    const stop = session.cad.trafficStop;
    if (!stop) throw new Error('no stop');
    expect(session.arrestVehicle()).toBe(vehicle(session, 0));
    session.dispatcher.request('12', { kind: 'stopContact', action: 'arrest' }, 'key');
    h.step(session, 1);
    expect(session.cad.trafficStop?.outcome).toBe('arrest');
    expect(session.prisoner()).toBe(stop.trueDriverId);
    expect(session.equipmentOf(vehicle(session, 0))?.prisoner).toBe(stop.trueDriverId);
    // That cage is taken now, and the other patrol car is back in the station lot, far away.
    expect(session.arrestVehicle()).toBeNull();

    const released: number[] = [];
    const mdt = new MdtOverlay(null, createMdtDeps(session, { target: () => null, bookingCompleted: (_id, who) => released.push(who) }));
    const fields = { personId: stop.trueDriverId, charges: ['PC-220'], arrestLocation: 'test', callId: stop.callId };
    const away = mdt.saveDocument('booking', fields, true);
    expect(session.atStation()).toBe(false);
    expect(away.errors).toEqual(['Booking can only be completed at the station, for the prisoner in the car']);
    // Drive to the station with the prisoner and complete the booking there.
    session.teleport(city.spawn.x, city.spawn.z);
    expect(session.atStation()).toBe(true);
    const done = mdt.saveDocument('booking', fields, true, away.doc?.id ?? null);
    expect(done.errors).toEqual([]);
    expect(done.doc?.status).toBe('final');
    expect(released).toEqual([stop.trueDriverId]);
    expect(session.prisoner()).toBe(-1);
    h.step(session, 1);
    expect(session.records.person(stop.trueDriverId).priors.some((p) => p.kind === 'arrest' && p.ref === done.doc?.id)).toBe(true);
    mdt.dispose();
  });

  it('opens the trunk at the rear of a patrol car; take and stow move items between the trunk and the kit', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    const eid = car.eid;
    const yaw = yawOf(eid);
    const half = car.model.body.length / 2;
    const rx = (Transform.x[eid] ?? 0) + (half + 0.5) * Math.sin(yaw);
    const rz = (Transform.z[eid] ?? 0) + (half + 0.5) * Math.cos(yaw);
    placeOfficer(session, rx, rz);
    expect(session.trunkVehicle()).toBe(car);
    expect(session.interactHint()).toBe('trunk');
    expect(session.interact()).toBe('trunk');
    placeOfficer(session, rx + Math.sin(yaw) * (TRUNK_DISTANCE + 1), rz + Math.cos(yaw) * (TRUNK_DISTANCE + 1));
    expect(session.trunkVehicle()).toBeNull();
    const eq = session.equipmentOf(car);
    if (!eq) throw new Error('no equipment');
    const kit = session.officerKit;
    expect(eq.take('cones', kit)).toBe(true);
    expect(eq.take('cones', kit)).toBe(true);
    expect(eq.trunkCount('cones')).toBe(4);
    expect(carriedText(session)).toBe('Traffic cones ×2');
    expect(eq.stow('cones', kit)).toBe(true);
    expect(kit.carried('cones')).toBe(1);
  });

  it('reaches the MDT in a patrol car or on foot within 3 m of its driver door', () => {
    const h = fresh();
    const session = h.start(SEED);
    expect(session.mdtReachable()).toBe(false);
    const car = vehicle(session, 0);
    const c = { eid: car.eid, x: Transform.x[car.eid] ?? 0, z: Transform.z[car.eid] ?? 0, yaw: yawOf(car.eid), halfWidth: car.model.body.width / 2, halfLength: car.model.body.length / 2, speed: 0 };
    const door = driverDoorPoint(c, { x: 0, z: 0 });
    placeOfficer(session, door.x - 1.5 * Math.cos(c.yaw), door.z + 1.5 * Math.sin(c.yaw));
    expect(session.mdtReachable()).toBe(true);
    session.enterVehicle(car);
    expect(session.inPatrolCar).toBe(true);
    expect(session.mdtReachable()).toBe(true);
  });

  it('saves and restores equipment, the officer kit, the prisoner and every Phase 2 block (v4 round trip)', () => {
    const h = fresh();
    const session = h.start(SEED);
    const car = vehicle(session, 0);
    const eq = session.equipmentOf(car);
    if (!eq) throw new Error('no equipment');
    eq.toggleSiren();
    eq.cycleTone();
    eq.cyclePattern();
    eq.toggleSpot();
    expect(eq.toggleRackLock(true)).toBe(true);
    expect(eq.checkOut('shotgun', session.officerKit)).toBe(true);
    expect(eq.take('flares', session.officerKit)).toBe(true);
    expect(eq.seatPrisoner(4321)).toBe(true);
    session.radio.selectChannel('tac');
    session.radio.toggleScan();
    session.records.runPlate(session.records.registration(77).plate, undefined, session.now().game);
    expect(session.dispatcher.createCall('alarm', session.now())).not.toBeNull();
    h.step(session, 120);
    const data = roundTrip(serializeGame(session));
    expect(data.equipment[0]).toEqual(eq.serialize());
    expect(data.equipment[1]).not.toBeNull();
    h.reset(session);
    const loaded = h.load(data);
    const leq = loaded.equipmentOf(vehicle(loaded, 0));
    expect(leq?.serialize()).toEqual(data.equipment[0]);
    expect(loaded.officerKit.longGun).toBe('shotgun');
    expect(loaded.officerKit.carried('flares')).toBe(1);
    expect(loaded.prisoner()).toBe(4321);
    expect(loaded.radio.selected).toBe('tac');
    expect(loaded.cad.calls().map((c) => c.typeId)).toEqual(data.cad.calls.map((c) => c.typeId));
    expect(loaded.records.queryLog.length).toBe(data.records.queries.length);
    const again = roundTrip(serializeGame(loaded));
    expect(again.cad).toEqual(data.cad);
    expect(again.records).toEqual(data.records);
    expect(again.radio).toEqual(data.radio);
    expect(again.dispatch).toEqual(data.dispatch);
    expect(again.officerKit).toEqual(data.officerKit);
    expect(again.equipment).toEqual(data.equipment);
    // PoliceLights come back from the equipment on the first step.
    h.step(loaded, 1);
    expect(PoliceLights.siren[vehicle(loaded, 0).eid]).toBe(2);
    expect(PoliceLights.spot[vehicle(loaded, 0).eid]).toBe(1);
  });

  it('loads a migrated Phase 1 (v3) save with a fresh roster, fleet and new-car equipment', () => {
    const v3 = { ...makeSaveGameV3({ player: { mode: 'onFoot', vehicle: -1, lastVehicle: -1 }, traffic: null }), seed: SEED, rngState: { seed: SEED, s: [1, 2, 3, 4] as [number, number, number, number] } };
    v3.world = { entities: [] };
    const migrated = migrateEnvelope({ version: 3, createdAt: 1, updatedAt: 1, slot: 'old', data: v3 }).data;
    expect(migrated.dispatch).toBeNull();
    const h = fresh();
    const session = h.load(migrated);
    expect(session.cad.units()).toHaveLength(7);
    for (let i = 0; i < 6; i++) expect(session.traffic.fleetEntity(i)).not.toBe(0);
    expect(session.equipmentOf(vehicle(session, 0))?.trunkCount('cones')).toBe(6);
    expect(session.officerKit.carriedTotal).toBe(0);
    h.step(session, 60);
    expect(session.radio.serialize().version).toBe(1);
  });
});

describe('patrol presentation', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });

  it('PoliceFeed fills the HUD police, unit, call, offer, target and carried lines, minimap markers and the MDT screen', () => {
    const h = new Harness(city);
    live.push(h);
    const session = h.start(SEED);
    const feed = new PoliceFeed(session, h.bus);
    const hud = new HudFeed();
    session.enterVehicle(vehicle(session, 0));
    session.drivenEquipment?.toggleSiren();
    session.toggleLightbar();
    const call = session.dispatcher.createCall('noiseComplaint', session.now());
    if (!call) throw new Error('no call');
    session.dispatcher.request('12', { kind: 'selfAssign', callId: call.id }, 'mdt');
    h.step(session, 2);
    const target = describeTarget(SEED, 1234, 0);
    h.bus.emit('dispatch:plateResult', {
      callsign: '12',
      via: 'key',
      vehicleId: 1234,
      readback: { plate: target.plate, found: true, description: target.description, owner: 'X', ownerPersonId: 1, hits: ['STOLEN VEHICLE'], severity: 'alert' },
    });
    const s: HudSnapshot = hud.fill(session, 'chase', null);
    feed.fillHud(s, target, 'T', 1000);
    expect(s.police).toMatchObject({ lights: true, pattern: 'alternate', siren: 'wail' });
    expect(s.unit).toMatchObject({ callsign: '12', status: '10-76 EN ROUTE', emergency: false, statusCheck: false });
    expect(s.call).toMatchObject({ number: call.number, priority: call.priority, nature: call.nature, status: 'en route' });
    expect(s.call?.distanceM).toBeGreaterThan(0);
    expect(s.target).toEqual({ plate: target.plate, description: target.description, result: 'STOLEN VEHICLE', severity: 'alert' });
    expect(s.carried).toBe('');
    const m = feed.fillMarkers(createMinimapMarkers(32));
    expect(m.count).toBeGreaterThanOrEqual(7);
    expect([...m.kind.subarray(0, m.count)]).toContain(MARKER.callP1 + call.priority - 1);
    const screen = feed.screenModel(1000);
    expect(screen.call?.number).toBe(call.number);
    expect(screen.alert).toContain('STOLEN VEHICLE');
    expect(feed.screenModel(1100)).toBe(screen);
    // The status check is the dispatcher's state (it survives save/load): pending until any player request.
    const ds = session.dispatcher.serialize();
    ds.statusCheck.attempt = 1;
    ds.statusCheck.awaitingSince = session.now().sim;
    session.dispatcher.restore(ds, session.now());
    feed.fillHud(s, null, 'T', 2000);
    expect(s.unit?.statusCheck).toBe(true);
    expect(s.target).toBeNull();
    // A fresh feed (as after a load) shows it too, with the in-car alert.
    const reloaded = new PoliceFeed(session, h.bus);
    reloaded.fillHud(s, null, 'T', 2050);
    expect(s.unit?.statusCheck).toBe(true);
    expect(reloaded.screenModel(2050).alert).toContain('STATUS CHECK');
    reloaded.dispose();
    session.dispatcher.request('12', { kind: 'location' }, 'mdt');
    h.step(session, 2);
    feed.fillHud(s, null, 'T', 2100);
    expect(s.unit?.statusCheck).toBe(false);
    const ctx = feed.radioContext('plain', target);
    expect(ctx).toMatchObject({ mode: 'plain', hasTarget: true, onCall: true, fallbackPlate: target.plate, fallbackVehicleId: 1234 });
    const cockpit = feed.cockpitState();
    expect(cockpit).toMatchObject({ sirenOn: true, lightsOn: true, radioChannel: 'DISP', racked: [true, true], caged: false });
    feed.dispose();
  });

  it('offers a call on the HUD line with the radio menu keys', () => {
    const h = new Harness(city);
    live.push(h);
    const session = h.start(SEED);
    const feed = new PoliceFeed(session, h.bus);
    session.enterVehicle(vehicle(session, 0));
    const call = session.dispatcher.createCall('noiseComplaint', session.now(), session.playerPosition({ x: 0, z: 0 }));
    if (!call) throw new Error('no call');
    h.step(session, 2);
    const s = new HudFeed().fill(session, 'chase', null);
    feed.fillHud(s, null, 'T', 0);
    expect(s.offer).toBe(`OFFER ${call.number} P${String(call.priority)} ${call.nature} · T 7 accept · T 8 decline`);
    feed.dispose();
  });

  it('the target tracker locks the ambient car ahead, never a fleet car, and holds it briefly', () => {
    const h = new Harness(city);
    live.push(h);
    const session = h.start(SEED);
    const view = session.traffic.view;
    let slot = 0;
    while (slot < view.count && isFleetVehicleId(view.vehicleId[slot] ?? 0)) slot++;
    const x = view.x[slot] ?? 0;
    const z = view.z[slot] ?? 0;
    const tracker = new TargetTracker(SEED);
    // From 20 m east of the car, looking west at it.
    const t = tracker.update(view, x + 20, z, -1, 0, 0);
    expect(t?.vehicleId).toBe(view.vehicleId[slot]);
    expect(t?.plate).toBe(describeTarget(SEED, view.vehicleId[slot] ?? 0, 0).plate);
    expect(tracker.update(view, x + 20, z, 1, 0, 1000)?.vehicleId).toBe(t?.vehicleId);
    expect(tracker.update(view, x + 20, z, 1, 0, 3000)).toBeNull();
    for (let i = 0; i < 6; i++) {
      const eid = session.traffic.fleetEntity(i);
      const fs = session.traffic.fleetState(i, { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 });
      if (!fs || eid === 0) continue;
      const hit = new TargetTracker(SEED).update(view, fs.x + 3, fs.z, -1, 0, 0);
      expect(hit === null || !isFleetVehicleId(hit.vehicleId)).toBe(true);
    }
  });

  it('panel models: two-level trunk, equipment rack and spotlight, driver contact with the arrest rule', () => {
    const h = new Harness(city);
    live.push(h);
    const session = h.start(SEED);
    const eq = session.equipmentOf(vehicle(session, 0));
    if (!eq) throw new Error('no equipment');
    const kit = session.officerKit;
    const top = trunkPanelModel(eq, kit, null);
    expect(top.options[0]).toEqual({ label: 'Traffic cones', detail: 'trunk 6 · carried 0/4' });
    const cones = trunkPanelModel(eq, kit, 'cones');
    expect(cones.options.map((o) => o.label)).toEqual(['Take one', 'Stow one', 'Back']);
    expect(cones.options.map((o) => o.enabled)).toEqual([true, false, undefined]);
    const equip = equipmentPanelModel(eq, kit, '');
    expect(equip.options[0]).toMatchObject({ label: 'Unlock gun rack', detail: 'Locked', enabled: true });
    expect(equip.options[1]).toMatchObject({ label: 'Check out patrol shotgun', enabled: false });
    eq.toggleRackLock(true);
    expect(equipmentPanelModel(eq, kit, '').options[1]?.enabled).toBe(true);
    const stop = {
      callId: 1, vehicleId: 5, plate: 'ABC 1234', x: 0, z: 0, started: { sim: 0, game: 0 }, driverId: -1, trueDriverId: 9,
      plateRun: false, vinChecked: false, vinResult: '', citations: [], outcome: 'active' as const,
    };
    const contact = contactPanelModel(stop, '2019 black Sedan', '', false);
    expect(contact.options.map((o) => o.label)).toEqual(['Request licence', 'Check VIN', 'Write citation', 'Warn and release', 'Release', 'Arrest']);
    expect(contact.options[5]?.enabled).toBe(false);
    expect(contactPanelModel(stop, '', 'DOE, JOHN', true).options[5]?.enabled).toBe(true);
  });

  it('patrol console shortcuts: cad call/units/clear, lookup plate/person, lights, radio say', async () => {
    const h = new Harness(city);
    live.push(h);
    const session = h.start(SEED);
    const commands = createPatrolCommands({ session: () => session });
    const ctx = { console: null as unknown as DebugConsole, print: () => undefined };
    const run = async (line: string): Promise<string> => {
      const [name, ...args] = line.split(' ');
      const c = commands.find((x) => x.name === name);
      if (!c) throw new Error(`no command ${String(name)}`);
      return String((await c.run(args, ctx)) ?? '');
    };
    expect(await run('cad call trafficHazard')).toMatch(/^C-00001 P\d Traffic hazard at /);
    expect(await run('cad units')).toContain('12 ');
    expect(await run('cad clear')).toBe('You are not on a call');
    session.dispatcher.request('12', { kind: 'selfAssign', callId: 1 }, 'key');
    h.step(session, 1);
    expect(await run('cad clear handled')).toBe('Clearing C-00001 (handled)');
    h.step(session, 1);
    expect(session.cad.call(1)?.status).toBe('closed');
    const plate = session.records.registration(4711).plate;
    expect(await run(`lookup plate ${plate}`)).toContain(plate);
    expect(await run('lookup person 17')).toContain('#17');
    expect(await run('lookup')).toMatch(/^Usage/);
    session.enterVehicle(vehicle(session, 0));
    expect(await run('lights takedown')).toBe('lights on, pattern takedown');
    expect(vehicle(session, 0).lightbar).toBe(true);
    expect(await run('lights off')).toBe('lights off, pattern takedown');
    expect(await run('radio say Testing one two')).toBe('Queued on dispatch');
    expect(await run('radio say tac Testing')).toBe('Queued on tac');
    h.step(session, 60);
    expect(session.radio.log.some((t) => t.text === 'Testing one two')).toBe(true);
  });

  it('pure helpers: plate result line and distance to a route', () => {
    const base = { plate: 'ABC 1234', found: true, description: '', owner: '', ownerPersonId: 1, severity: 'clear' as const };
    expect(plateResultText({ ...base, hits: [] })).toBe('CLEAR');
    expect(plateResultText({ ...base, found: false, hits: [] })).toBe('NO RECORD');
    expect(plateResultText({ ...base, hits: ['A', 'B', 'C'] })).toBe('A · B +1');
    const line = new Float32Array([0, 0, 100, 0, 100, 100]);
    expect(distanceToPolyline(line, 50, 10)).toBeCloseTo(10, 6);
    expect(distanceToPolyline(line, 130, 50)).toBeCloseTo(30, 6);
    expect(distanceToPolyline(new Float32Array(0), 1, 1)).toBe(Infinity);
  });
});
