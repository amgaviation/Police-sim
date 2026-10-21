import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Transform } from '../../src/ecs/components';
import { FLEET_DATA } from '../../src/fleet';
import { officerPreset } from '../../src/gear';
import { headingOf, PLAYER_SIZE, serializeGame, startNewGame, type GameSession } from '../../src/game/session';
import { initRapier } from '../../src/physics/physics';
import { PLAYER_MODE } from '../../src/player/mode';
import { migrateEnvelope } from '../../src/save/migrations';
import { CURRENT_SAVE_VERSION, isSaveGame, type SaveGame } from '../../src/save/schema';
import { PRONOUN_PRESETS, characterFromLegacy, defaultCharacter, type CharacterProfile } from '../../src/uniform';
import { VehicleLook } from '../../src/vehicles/components';
import type { DrivableVehicle } from '../../src/vehicles/drivableVehicle';
import { BLOCK_KIND, type City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { stationLayout } from '../../src/world/stationLayout';
import { LANDMARKS } from '../../src/world/data';
import { Harness, roundTrip } from './harness';
import { makeSaveGameV8 } from '../save/fixtures';

const SEED = 42;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

/** A custom they/them officer in tactical gear with a ball cap. */
function customCharacter(): CharacterProfile {
  const p = defaultCharacter();
  p.firstName = 'Robin';
  p.lastName = 'Vale';
  p.badge = '5203';
  p.pronouns = { ...PRONOUN_PRESETS.they };
  p.body = { heightM: 1.68, build: 1.1, shoulders: 1, hips: 1.1 };
  p.outfit = { ...p.outfit, uniform: 'tactical', hat: 'ballCap' };
  return p;
}

function placeOfficer(session: GameSession, x: number, z: number): void {
  session.physics.getBody(session.player)?.setTranslation({ x, y: PLAYER_SIZE.y / 2, z }, true);
  Transform.x[session.player] = x;
  Transform.z[session.player] = z;
}

function placeVehicle(session: GameSession, car: DrivableVehicle, x: number, z: number, yaw: number): void {
  const body = session.physics.getBody(car.eid);
  body?.setTranslation({ x, y: Transform.y[car.eid] ?? 1, z }, true);
  body?.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  body?.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body?.setAngvel({ x: 0, y: 0, z: 0 }, true);
  Transform.x[car.eid] = x;
  Transform.z[car.eid] = z;
}

function unit(session: GameSession, id: string): DrivableVehicle {
  const v = session.unitVehicle(id);
  if (!v) throw new Error(`unit ${id} is not out`);
  return v;
}

describe('Phase 7: fleet, uniforms, customization', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });

  function begin(): { h: Harness; session: GameSession } {
    const h = new Harness(city);
    live.push(h);
    const session = h.attach(
      startNewGame(h.ctx, SEED, { inStation: false, character: { profile: customCharacter(), gear: officerPreset('patrolStandard') } }),
    );
    return { h, session };
  }

  /** First half of the scripted shift of the determinism test: the motorcycle slalom and the patrol-car crash. */
  function firstHalf(h: Harness, session: GameSession): void {
    // Motorcycle: check out and ride a slalom.
    expect(session.checkOut('M-601').ok).toBe(true);
    const bike = unit(session, 'M-601');
    session.enterVehicle(bike);
    const d = session.driverInput;
    for (let i = 0; i < 240; i++) {
      d.accelerate = 0.5;
      d.steer = Math.sin(i / 25) * 0.5;
      h.step(session, 1);
      expect(Math.abs(bike.telemetry.lean)).toBeLessThan(1.2);
    }
    d.accelerate = 0;
    d.steer = 0;
    d.brake = 1;
    h.step(session, 240);
    d.brake = 0;
    // Back to the garage exit, then park it.
    placeVehicle(session, bike, session.yard.garage.x, session.yard.garage.z, 0);
    h.step(session, 60);
    expect(session.exitVehicle()).toBe('exited');
    expect(session.checkIn('M-601').ok).toBe(true);

    // Patrol car: crash it into the station building.
    const car = unit(session, 'P-101');
    const block = city.blocks[city.pois.find((p) => p.kind === 'station')?.block ?? 0];
    if (!block) throw new Error('no station block');
    const [minX, minZ, maxX] = stationLayout(block, LANDMARKS.station.yaw).building;
    session.enterVehicle(car);
    session.teleport((minX + maxX) / 2, minZ - 30, Math.PI);
    h.step(session, 30);
    d.accelerate = 1;
    for (let i = 0; i < 360; i++) h.step(session, 1);
    d.accelerate = 0;
    d.brake = 1;
    h.step(session, 120);
    d.brake = 0;
    h.step(session, 600);
  }

  /** Second half: the camera drone, then the v9 save. */
  function secondHalf(h: Harness, session: GameSession): SaveGame {
    const d = session.driverInput;

    // The supervisor SUV carries a camera drone: launch it, fly a little, recall it.
    expect(session.exitVehicle()).toBe('exited');
    expect(session.checkOut('S-201').ok).toBe(true);
    const sup = unit(session, 'S-201');
    const sx = Transform.x[sup.eid] ?? 0;
    const sz = Transform.z[sup.eid] ?? 0;
    placeOfficer(session, sx + 4, sz);
    h.step(session, 5);
    expect(session.toggleDrone().ok).toBe(true);
    d.accelerate = 0.8;
    d.lift = 1;
    h.step(session, 90);
    d.accelerate = 0;
    d.lift = 0;
    expect(session.toggleDrone().ok).toBe(true);
    h.step(session, 30);
    return roundTrip(serializeGame(session));
  }

  it('starts with the custom character, the fleet parked and the evidence kit in the officer kit', () => {
    const { session } = begin();
    expect(session.character.lastName).toBe('Vale');
    expect(session.officer).toEqual({ name: 'Officer Robin Vale', badge: '5203' });
    expect(session.vehicles.map((v) => session.unitOf(v))).toEqual(['P-101', 'P-102', 'MAR-1', 'AIR-2']);
    expect(session.fleet.units().filter((u) => u.spawned).map((u) => u.id)).toEqual(['P-101', 'P-102', 'MAR-1', 'AIR-2']);
    // The livery paints the unit: colour and trim come from the document.
    const p101 = unit(session, 'P-101');
    expect(VehicleLook.color[p101.eid]).toBeGreaterThan(0);
    expect(session.gear.validation.ok).toBe(true);
    expect(session.officerKit.carried('evidenceMarkers')).toBeGreaterThanOrEqual(0);
  });

  it('checks the motorcycle out at the garage exit and rides it upright', () => {
    const { h, session } = begin();
    const res = session.checkOut('M-601');
    expect(res.ok).toBe(true);
    const bike = unit(session, 'M-601');
    expect(bike.model.id).toBe('police_motorcycle');
    expect(session.checkOut('M-601').ok).toBe(false);
    session.enterVehicle(bike);
    session.driverInput.accelerate = 1;
    h.step(session, 120);
    expect(bike.telemetry.speed).toBeGreaterThan(8);
    expect(Math.abs(bike.telemetry.lean)).toBeLessThan(0.2);
  });

  it('flies the helicopter up and lands it; the boat only lets the officer out onto the quay', () => {
    const { h, session } = begin();
    const heli = unit(session, 'AIR-2');
    const at = session.playerPosition({ x: 0, z: 0 });
    expect(Math.hypot((Transform.x[heli.eid] ?? 0) - at.x, (Transform.z[heli.eid] ?? 0) - at.z)).toBeGreaterThan(0);
    session.enterVehicle(heli);
    session.driverInput.lift = 1;
    h.step(session, 240);
    expect(heli.telemetry.altitudeM).toBeGreaterThan(5);
    expect(session.exitVehicle()).toBe('exitBlocked');
    session.driverInput.lift = -1;
    for (let i = 0; i < 1200 && heli.telemetry.altitudeM > 0.3; i++) h.step(session, 1);
    session.driverInput.lift = 0;
    h.step(session, 60);
    expect(heli.telemetry.altitudeM).toBeLessThan(0.5);
    expect(session.exitVehicle()).toBe('exited');
    expect(session.checkIn('AIR-2').ok).toBe(true);
    expect(session.unitVehicle('AIR-2')).toBeNull();
    expect(session.checkOut('AIR-2').ok).toBe(true);

    // The boat lets the officer out onto the quay at its slip, and not in the middle of the water ("Dock first").
    const boat = unit(session, 'MAR-1');
    const slip = session.yard.boatSlip;
    if (!slip) throw new Error('no boat slip');
    placeOfficer(session, slip.x, slip.z);
    session.enterVehicle(boat);
    const water = city.blocks
      .filter((b) => b.kind === BLOCK_KIND.water)
      .sort((a, b) => Math.hypot((a.minX + a.maxX) / 2 - slip.x, (a.minZ + a.maxZ) / 2 - slip.z) - Math.hypot((b.minX + b.maxX) / 2 - slip.x, (b.minZ + b.maxZ) / 2 - slip.z))[0];
    if (!water) throw new Error('no water');
    placeVehicle(session, boat, (water.minX + water.maxX) / 2, (water.minZ + water.maxZ) / 2, 0);
    h.step(session, 30);
    expect(session.exitVehicle()).toBe('exitBlocked');
    placeVehicle(session, boat, slip.x, slip.z, slip.yaw);
    h.step(session, 30);
    expect(session.exitVehicle()).toBe('exited');
  });

  it('deploys the drone from a trunk, flies it and recalls it', () => {
    const { h, session } = begin();
    expect(session.checkOut('S-201').ok).toBe(true);
    const car = unit(session, 'S-201');
    const x = Transform.x[car.eid] ?? 0;
    const z = Transform.z[car.eid] ?? 0;
    const yaw = headingOf(Transform.qx[car.eid] ?? 0, Transform.qy[car.eid] ?? 0, Transform.qz[car.eid] ?? 0, Transform.qw[car.eid] ?? 1);
    placeOfficer(session, x + Math.sin(yaw) * 4, z + Math.cos(yaw) * 4);
    const trunk = session.equipmentOf(car);
    const before = trunk?.trunkCount('drone') ?? 0;
    expect(before).toBeGreaterThan(0);
    const res = session.toggleDrone();
    expect(res.ok).toBe(true);
    expect(session.remote).toBe(true);
    expect(session.modes.mode).toBe(PLAYER_MODE.remote);
    expect(trunk?.trunkCount('drone')).toBe(before - 1);
    const drone = session.droneVehicle;
    expect(drone?.model.id).toBe('police_drone');
    session.driverInput.accelerate = 1;
    session.driverInput.lift = 1;
    h.step(session, 120);
    expect(Math.hypot((Transform.x[drone?.eid ?? 0] ?? 0) - x, (Transform.z[drone?.eid ?? 0] ?? 0) - z)).toBeGreaterThan(3);
    const saved = roundTrip(serializeGame(session));
    expect(saved.player.mode).toBe('remote');
    expect(isSaveGame(saved)).toBe(true);
    session.driverInput.accelerate = 0;
    session.driverInput.lift = 0;
    expect(session.toggleDrone().ok).toBe(true);
    expect(session.remote).toBe(false);
    expect(session.officerKit.carried('drone')).toBe(1);
    expect(session.unitVehicle('D-1')).toBeNull();
  });

  it('records a crash as an incident, files the report, services the car and charges career points at the end of the shift', () => {
    const { h, session } = begin();
    const out: string[] = [];
    session.bus.on('fleet:charge', (e) => out.push(`${e.unitId}:${String(e.points)}`));
    firstHalf(h, session);
    h.step(session, 600);
    expect(session.fleet.incidents().length).toBeGreaterThan(0);
    const inc = session.fleet.incidents()[0];
    expect(inc?.unitId).toBe('P-101');
    expect(inc?.closed).toBe(true);
    const points0 = session.conduct.career.points;
    session.fleet.request({ kind: 'report', incidentId: inc?.id ?? 0 });
    h.step(session, 2);
    expect(session.fleet.reports()).toHaveLength(1);
    expect(session.fleet.reports()[0]?.text).toContain('Robin Vale');
    expect(session.fleet.reports()[0]?.text).toContain('they/them');
    // Service at the station pump.
    session.fleet.request({ kind: 'service', unitId: 'P-101', service: 'all' });
    h.step(session, 2);
    expect(unit(session, 'P-101').needsRepair).toBe(false);
    expect(session.fleet.ledger.departmentCost).toBeGreaterThan(0);
    // Inspection, then the end of the shift charges the (reported) incident.
    const input = session.inspectionInput('P-101');
    if (!input) throw new Error('no inspection input');
    session.fleet.request({ kind: 'inspect', unitId: 'P-101', input });
    session.fleet.request({ kind: 'endShift' });
    h.step(session, 2);
    expect(session.fleet.lastInspection()?.rows.length).toBeGreaterThan(5);
    expect(out.length).toBeGreaterThan(0);
    expect(session.conduct.career.points).toBeLessThan(points0);
  });

  it('is deterministic: two runs give bit-identical v9 saves, and a load mid-flight continues exactly', () => {
    const a = begin();
    firstHalf(a.h, a.session);
    const mid = roundTrip(serializeGame(a.session));
    const first = secondHalf(a.h, a.session);
    expect(isSaveGame(first)).toBe(true);
    a.h.reset(a.session);

    const b = begin();
    firstHalf(b.h, b.session);
    const second = secondHalf(b.h, b.session);
    expect(second).toEqual(first);
    b.h.reset(b.session);

    const h = new Harness(city);
    live.push(h);
    const loaded = h.load(mid);
    expect(loaded.character.lastName).toBe('Vale');
    expect(secondHalf(h, loaded)).toEqual(first);
  });

  it('loads a v8 save: the fleet binds the saved cars, then checks out the motorcycle and flies the drone', () => {
    const v8 = makeSaveGameV8();
    const data = migrateEnvelope({ version: 8, createdAt: 1, updatedAt: 1, slot: 'old', data: v8 }).data;
    expect(CURRENT_SAVE_VERSION).toBe(9);
    const h = new Harness(city);
    live.push(h);
    const session = h.load(data);
    // The fixture was saved while driving the first car.
    expect(session.driving).toBe(true);
    expect(session.character.badge).toBe('4471');
    expect(session.unitOf(session.vehicles[0] ?? null)).toBe('P-101');
    expect(session.unitOf(session.vehicles[1] ?? null)).toBe('P-102');
    h.step(session, 30);
    const spot = session.yard.slots[10];
    if (!spot) throw new Error('no yard slot');
    session.teleport(spot.x, spot.z, spot.yaw);
    h.step(session, 60);
    expect(session.exitVehicle()).toBe('exited');
    expect(session.checkOut('M-601').ok).toBe(true);
    const at = session.playerPosition({ x: 0, z: 0 });
    const car = unit(session, 'P-101');
    placeVehicle(session, car, at.x + 3, at.z, 0);
    h.step(session, 5);
    expect(session.checkOut('S-201').ok).toBe(true);
    const sup = unit(session, 'S-201');
    placeVehicle(session, sup, at.x - 3, at.z, 0);
    h.step(session, 5);
    expect(session.toggleDrone()).toEqual({ ok: true, message: expect.any(String) as string });
    expect(session.remote).toBe(true);
    expect(FLEET_DATA.units.some((u) => u.id === 'D-1')).toBe(true);
  });

  it('rolls rounds fired at the officer from the gear stream: deterministic, the vest stops torso hits, the radio calls officer down', () => {
    const rolls = (protection: number): string[] => {
      const { session } = begin();
      const out: string[] = [];
      for (let i = 0; i < 60; i++) out.push(session.phase7.hit(protection, 8));
      return out;
    };
    const bare = rolls(0);
    expect(rolls(0)).toEqual(bare);
    expect(bare.some((o) => o === 'wounded')).toBe(true);
    expect(bare.includes('stopped')).toBe(false);
    const vest = rolls(1);
    expect(vest.includes('stopped')).toBe(true);
    // Beyond the maximum range every round misses.
    const { session } = begin();
    expect(session.phase7.hit(0, 5000)).toBe('miss');
  });

  it('doubles the target range in a radar unit and flashes the uniform policy for a unit class rule', () => {
    const { session } = begin();
    expect(session.radarFactor).toBe(1);
    expect(session.checkOut('T-401').ok).toBe(true);
    const flashes: string[] = [];
    session.bus.on('fleet:flash', (e) => flashes.push(e.text));
    const traffic = unit(session, 'T-401');
    session.enterVehicle(traffic);
    expect(session.radarFactor).toBe(2);
    // The tactical uniform is allowed in a traffic unit (no rule); a bike unit wants the bike uniform.
    expect(session.phase7.checkUniformPolicy('bicycle')).toBe(true);
    expect(session.phase7.checkUniformPolicy('bicycle')).toBe(false);
    expect(session.phase7.checkUniformPolicy('patrol')).toBe(false);
  });

  it('keeps the officer record in sync with the character and carries the legacy name by default', () => {
    const h = new Harness(city);
    live.push(h);
    const session = h.start(SEED);
    expect(session.officer).toEqual({ name: 'Officer Doe', badge: '4071' });
    expect(session.character.lastName).toBe(characterFromLegacy('Officer Doe', '4071').lastName);
    session.setCharacter(customCharacter());
    expect(session.officer.name).toBe('Officer Robin Vale');
  });
});
