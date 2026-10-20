import { beforeAll, describe, expect, it } from 'vitest';
import { Transform } from '../../src/ecs/components';
import { PLAYER_SIZE, serializeGame, type GameSession } from '../../src/game/session';
import { levelY } from '../../src/interior/constants';
import { roomAt } from '../../src/interior/nav';
import type { InteriorDoor, InteriorLayout } from '../../src/interior/types';
import { initRapier } from '../../src/physics/physics';
import type { BuildingInfo } from '../../src/world/buildings';
import { verifyLedger } from '../../src/evidence';
import { migrateEnvelope } from '../../src/save/migrations';
import { CURRENT_SAVE_VERSION, isSaveGame, type SaveGame } from '../../src/save/schema';
import { Harness, roundTrip } from './harness';

const SEED = 4242;

beforeAll(async () => {
  await initRapier();
});

/** Puts the officer at (x, z) on the level of building `b` (-1 outdoors). */
function place(session: GameSession, x: number, z: number, b = session.officerBuilding): void {
  const y = levelY(b) + PLAYER_SIZE.y / 2;
  session.physics.getBody(session.player)?.setTranslation({ x, y, z }, true);
  Transform.x[session.player] = x;
  Transform.y[session.player] = y;
  Transform.z[session.player] = z;
}

/** The station, locker, briefing, armory and the garage door, as a script. */
function stationShift(h: Harness, session: GameSession): void {
  session.station.lockerSelect(5);
  h.step(session, 2);
  session.station.request({ kind: 'complete', step: 'briefing' });
  session.station.armorySelect(0);
  session.station.armorySelect(1);
  h.step(session, 2);
  const st = session.buildings.station();
  if (!st) throw new Error('no station');
  const layout = session.interiors.layout(st.id);
  const garage = layout?.doors.find((d) => d.kind === 'wide' && d.exit && d.exit.z < st.minZ);
  if (!layout || !garage) throw new Error('no garage door');
  place(session, garage.x, garage.z + 1);
  session.interiors.request({ kind: 'exit', door: garage.index });
  h.step(session, 90);
}

function nearestHouse(session: GameSession): BuildingInfo {
  const at = session.playerPosition({ x: 0, z: 0 });
  const out: BuildingInfo[] = [];
  session.buildings.near(at.x, at.z, 700, out);
  const houses = out.filter((b) => b.kind === 'house' && session.interiors.layout(b.id) !== null);
  houses.sort((a, b) => Math.hypot(a.door.x - at.x, a.door.z - at.z) - Math.hypot(b.door.x - at.x, b.door.z - at.z));
  const house = houses[0];
  if (!house) throw new Error('no house');
  return house;
}

describe('Phase 4 session: the shift starts in the station', () => {
  it('places the officer in the locker room with the unit out of service', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 60);
    const st = session.buildings.station();
    expect(st).not.toBeNull();
    expect(session.officerBuilding).toBe(st?.id);
    expect(session.station.flow.step).toBe('locker');
    expect(session.cad.unit(session.dispatcher.playerCallsign)?.status).toBe('outOfService');
    const y = session.physics.getBody(session.player)?.translation().y ?? 0;
    expect(y).toBeCloseTo(-40 + PLAYER_SIZE.y / 2, 3);
    expect(session.interactHint()).toBe('locker');
    h.dispose();
  });

  it('locker, briefing, armory and the garage door put the unit on patrol', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 30);
    stationShift(h, session);
    expect(session.officerBuilding).toBe(-1);
    expect(session.station.flow.step).toBe('onPatrol');
    h.step(session, 30);
    expect(session.cad.unit(session.dispatcher.playerCallsign)?.status).toBe('available');
    expect(session.station.weaponsAvailable()).toEqual({ sidearm: true, taser: true });
    const house = nearestHouse(session);
    expect(house.kind).toBe('house');
    expect(serializeGame(session).station.flow).toBe('onPatrol');
    h.dispose();
  });
});

/** Observations of the scripted domestic call (everything is deterministic for the seed). */
interface Observed {
  callId: number;
  houseId: number;
  entered: boolean;
  kicked: boolean;
  itemId: string;
  ledger: string[];
}

/** Moves the officer next to door `d` of `layout`, inside the room `d.a`, 0.8 m from the opening. */
function stand(session: GameSession, layout: InteriorLayout, d: InteriorDoor): void {
  for (const sign of [1, -1]) {
    const x = d.axis === 'x' ? d.x : d.x + sign * 0.8;
    const z = d.axis === 'x' ? d.z + sign * 0.8 : d.z;
    if (roomAt(layout, x, z) === d.a) {
      place(session, x, z);
      return;
    }
  }
  place(session, d.x, d.z);
}

/** Domestic call at the nearest house: knock, evidence at the door, enter crouched with the light on, lean, kick, marker, photo. */
function domesticScript(h: Harness, session: GameSession): Observed {
  stationShift(h, session);
  h.step(session, 60);
  const house = nearestHouse(session);
  const out = { x: -Math.sin(house.door.yaw), z: -Math.cos(house.door.yaw) };
  session.teleport(house.door.x + out.x * 8, house.door.z + out.z * 8, house.door.yaw + Math.PI);
  h.step(session, 90);
  let callId = 0;
  for (let k = 0; k < 40 && callId === 0; k++) {
    const id = session.scene.spawnCall('domesticDisturbance', session.now(), { x: house.door.x, z: house.door.z }, [], house.id);
    const rt = session.scene.runtime(id);
    if (rt && rt.buildingId === house.id && rt.scenario.variants.length === 0 && ['victim', 'suspect'].every((r) => rt.scenario.participants.some((p) => p.role === r))) callId = id;
    else if (id > 0) {
      session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'clearCall', callId: id, disposition: 'unfounded' }, 'key');
      h.step(session, 2);
    }
  }
  expect(callId).toBeGreaterThan(0);
  session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'selfAssign', callId }, 'key');
  h.step(session, 120);
  const layout = session.interiors.layout(house.id);
  const main = layout?.doors.find((d) => d.main);
  if (!layout || !main?.exit) throw new Error('no front door');
  place(session, main.exit.x, main.exit.z, -1);
  session.controller.yaw = main.exit.yaw + Math.PI;
  h.step(session, 20);
  session.interiors.request({ kind: 'door', buildingId: house.id, door: main.index, action: 'knock' });
  h.step(session, 900);
  // The evidence at the door: a marker, a photograph, collect, bag and tag.
  const file = session.investigation.store.get(callId);
  const item = file?.items[0];
  if (!item) throw new Error('no evidence item');
  place(session, item.x, item.z, -1);
  session.investigation.request({ kind: 'marker' });
  h.step(session, 5);
  session.investigation.request({ kind: 'photo', fovDeg: 60 });
  h.step(session, 5);
  for (const kind of ['collect', 'bag', 'tag'] as const) {
    session.investigation.request({ kind, itemId: item.id });
    h.step(session, 5);
  }
  place(session, main.exit.x, main.exit.z, -1);
  session.interiors.request({ kind: 'enter', buildingId: house.id, door: main.index });
  h.step(session, 90);
  const entered = session.officerBuilding === house.id;
  session.tactical.request({ kind: 'crouch' });
  session.tactical.request({ kind: 'flashlight' });
  h.step(session, 20);
  session.tactical.setHeld(-1, false);
  h.step(session, 30);
  session.tactical.setHeld(1, false);
  h.step(session, 30);
  session.tactical.setHeld(0, false);
  // Kick an interior door.
  let kicked = false;
  for (const d of layout.doors) {
    if (kicked || d.kind !== 'interior' || d.b < 0 || session.interiors.doorState(house.id, d.index) !== 'closed') continue;
    stand(session, layout, d);
    for (let k = 0; k < 8 && !kicked; k++) {
      session.interiors.request({ kind: 'door', buildingId: house.id, door: d.index, action: 'kick' });
      h.step(session, 70);
      kicked = session.interiors.doorState(house.id, d.index) === 'broken';
    }
  }
  return { callId, houseId: house.id, entered, kicked, itemId: item.id, ledger: session.investigation.ledger.entries().map((e) => `${e.itemId}:${e.action}`) };
}

describe('Phase 4 session: an indoor domestic call', () => {
  it('runs the scripted entry', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 30);
    const o = domesticScript(h, session);
    expect(o.entered).toBe(true);
    expect(o.ledger).toEqual([`${o.itemId}:collect`, `${o.itemId}:bag`, `${o.itemId}:tag`]);
    h.dispose();
  }, 120_000);
});

describe('Phase 4 determinism and saves', () => {
  const blocks = (d: SaveGame): string =>
    JSON.stringify({
      interiors: d.interiors,
      tactical: d.tactical,
      investigation: d.investigation,
      station: d.station,
      scenes: d.scenes,
      npc: d.npc,
      contacts: d.contacts,
      cad: d.cad,
      people: d.people,
      records: d.records,
      kit: d.officerKit,
      rng: d.rngState,
    });

  it('replays the scripted station shift and domestic call to bit-identical v6 saves', () => {
    const h = new Harness(undefined, undefined, true);
    const run = (): { json: string; o: Observed } => {
      const session = h.start(SEED, true);
      h.step(session, 30);
      const o = domesticScript(h, session);
      const data = serializeGame(session);
      h.reset(session);
      return { json: JSON.stringify(data), o };
    };
    const first = run();
    const second = run();
    expect(second.json).toBe(first.json);
    const data = JSON.parse(first.json) as SaveGame;
    expect(isSaveGame(data)).toBe(true);
    expect(data.interiors.officerBuilding).toBe(first.o.houseId);
    expect(data.interiors.doors.some(([b, , state]) => b === first.o.houseId && state === 3)).toBe(true);
    expect(data.station.flow).toBe('onPatrol');
    expect(data.station.armory.map((e) => e.item)).toEqual(['sidearm', 'taser']);
    const file = data.investigation.files.find((f) => f.callId === first.o.callId);
    expect(file?.markers.length).toBe(1);
    expect(file?.photos.length).toBe(1);
    expect(file?.photos[0]?.thumb ?? null).toBeNull();
    expect(data.investigation.ledger.map((e) => e.action)).toEqual(['collect', 'bag', 'tag']);
    expect(data.tactical.crouched).toBe(true);
    h.dispose();
  }, 180_000);

  it('a v6 save made mid-scene continues exactly: interiors, tactical, investigation, station and the Phase 3 blocks match the original run', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 30);
    domesticScript(h, session);
    const mid = roundTrip(serializeGame(session));
    h.step(session, 900);
    const original = roundTrip(serializeGame(session));
    h.reset(session);
    const loaded = h.load(mid);
    expect(blocks(roundTrip(serializeGame(loaded)))).toBe(blocks(mid));
    h.step(loaded, 900);
    expect(blocks(roundTrip(serializeGame(loaded)))).toBe(blocks(original));
    h.dispose();
  }, 180_000);

  it('a v5 save loads outdoors with the station on patrol and the Phase 4 blocks empty', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, false);
    h.step(session, 120);
    const v6 = roundTrip(serializeGame(session));
    h.reset(session);
    const { interiors: _i, tactical: _t, investigation: _v, station: _s, force: _f, incidents: _n, conduct: _c, court: _o, ...v5 } = v6;
    const migrated = migrateEnvelope({ version: 5, createdAt: 1, updatedAt: 1, slot: 't', data: v5 });
    expect(migrated.version).toBe(CURRENT_SAVE_VERSION);
    const loaded = h.load(migrated.data);
    h.step(loaded, 120);
    expect(loaded.officerBuilding).toBe(-1);
    expect(loaded.station.flow.step).toBe('onPatrol');
    expect(loaded.station.weaponsAvailable()).toEqual({ sidearm: true, taser: true });
    expect(loaded.investigation.store.files().length).toBe(0);
    h.dispose();
  }, 60_000);
});

describe('Phase 4 evidence at the station', () => {
  it('an item left at a door is found in plain view, collected, bagged, tagged and deposited: the chain is complete and verifies', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 30);
    stationShift(h, session);
    const home = nearestHouse(session);
    const layout = session.interiors.layout(home.id);
    const main = layout?.doors.find((d) => d.main);
    if (!main?.exit) throw new Error('no front door');
    session.teleport(main.exit.x, main.exit.z, main.exit.yaw + Math.PI);
    h.step(session, 60);
    const inv = session.investigation;
    const id = inv.placeItem({
      callId: 0, item: 'knife', label: 'Kitchen knife', x: main.exit.x, y: 0, z: main.exit.z + 0.5, buildingId: -1, room: -1,
      furniture: -1, container: 'none', concealed: false, ownerPersonId: -1, incriminating: true,
    });
    h.step(session, 90);
    expect(inv.store.item(id)?.state).toBe('found');
    expect(session.collectTarget()).toBe(id);
    for (const kind of ['collect', 'bag', 'tag'] as const) {
      inv.request({ kind, itemId: id });
      h.step(session, 6);
    }
    expect(inv.ledger.itemEntries(id).map((e) => e.action)).toEqual(['collect', 'bag', 'tag']);
    expect(inv.ledger.complete(id)).toBe(false);
    // Deposit: only at the station's evidence room.
    const st = session.buildings.station();
    const point = session.stationPoint('evidence');
    if (!st || !point) throw new Error('no evidence point');
    session.interiors.placeOfficerInside(st.id, point);
    h.step(session, 10);
    expect(session.nearEvidenceRoom()).toBe(true);
    inv.request({ kind: 'deposit' });
    h.step(session, 6);
    expect(inv.ledger.complete(id)).toBe(true);
    expect(inv.ledger.itemEntries(id).map((e) => e.action)).toEqual(['collect', 'bag', 'tag', 'deposit']);
    expect(verifyLedger(inv.ledger.entries()).ok).toBe(true);
    h.dispose();
  }, 60_000);
});
