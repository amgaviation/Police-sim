import { CadState } from '../../src/cad/cadState';
import { newConductSave } from '../../src/conduct/save';
import { emptyCourtSave } from '../../src/court/save';
import { defaultForceSave } from '../../src/force/save';
import { emptyIncidentsSave } from '../../src/incidents/save';
import { createRng } from '../../src/core/rng';
import type { DispatchSave } from '../../src/dispatch/save';
import { CAMERA_MODE } from '../../src/player/cameraRig';
import { PatrolEquipment } from '../../src/police/equipment';
import { OfficerKit } from '../../src/police/inventory';
import { defaultRadioSave } from '../../src/radio/save';
import { RecordsDb } from '../../src/records/db';
import { DETACHED_CONTEXT } from '../../src/records/person';
import { emptyContactSave } from '../../src/contact/save';
import { emptyInteriorSave } from '../../src/indoors/save';
import { emptyInvestigationSave } from '../../src/investigation/save';
import { migratedStationSave, newShiftStationSave } from '../../src/station/stationState';
import { defaultTacticalSave } from '../../src/tactical/save';
import { Population } from '../../src/people/population';
import { emptySceneSave } from '../../src/scene/save';
import type { SaveGame, SaveGameV1, SaveGameV2, SaveGameV3, SaveGameV4, SaveGameV5, SaveGameV6, SavedVehicle } from '../../src/save/schema';
import type { TrafficSnapshot } from '../../src/traffic/trafficSystem';
import { vehicleModel } from '../../src/vehicles/model';

/** Shared save payloads for the save tests (one per schema version). */

export function makeSaveGameV1(overrides: Partial<SaveGameV1> = {}): SaveGameV1 {
  return {
    seed: 42,
    rngState: { seed: 42, s: [1, 2, 3, 4] },
    clock: { simTime: 12.5, timeScale: 1 },
    officer: { name: 'A. Vance', badge: '4471' },
    world: { entities: [{ kind: 1, x: 0, y: 1, z: 2, qx: 0, qy: 0, qz: 0, qw: 1 }] },
    ...overrides,
  };
}

export function makeSaveGameV2(overrides: Partial<SaveGameV2> = {}): SaveGameV2 {
  return {
    ...makeSaveGameV1(),
    camera: { pitch: 0.4 },
    world: {
      entities: [
        { kind: 1, x: 0, y: 1, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: -1, vz: 0, wx: 0, wy: 0, wz: 2, sleeping: false },
      ],
    },
    ...overrides,
  };
}

export function makeSavedVehicle(overrides: Partial<SavedVehicle> = {}): SavedVehicle {
  return {
    modelId: 'patrol_sedan',
    x: 190,
    y: 0.9,
    z: -300,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    vx: 0,
    vy: 0,
    vz: -3,
    wx: 0,
    wy: 0,
    wz: 0,
    fuelL: 52.5,
    brakeTempC: [80, 60],
    zones: [0.2, 0, 0, 0.05],
    engineHealth: 0.86,
    engineFailed: false,
    tireFlat: [false, false, false, true],
    headlights: true,
    lightbar: false,
    reversing: false,
    sim: { steerAngle: 0.1, gear: 2, stallS: 0, absTime: 3.5, wheelLoad: [4500, 4500, 4600, 4400] },
    color: 0x16181d,
    rng: { seed: 99, s: [5, 6, 7, 8] },
    ...overrides,
  };
}

export function makeTrafficSnapshot(): TrafficSnapshot {
  return {
    version: 1,
    rng: { seed: 7, s: [1, 2, 3, 4] },
    spawnSeq: 12,
    cars: [
      {
        vehicleId: 4711,
        lane: 160,
        s: 30.5,
        speed: 11,
        accel: 0.2,
        nextLane: -1,
        state: 0,
        behavior: 1,
        desiredFactor: 1.2,
        headway: 1.4,
        weaveAmp: 0,
        weavePeriod: 1,
        weavePhase: 0,
        stopPhase: 0,
        stopTimer: 0,
        holding: -1,
        reported: 0,
        flags: 0,
      },
    ],
  };
}

/** A complete v3 (Phase 1) payload: driving the first of two vehicles, with traffic. */
export function makeSaveGameV3(overrides: Partial<SaveGameV3> = {}): SaveGameV3 {
  return {
    ...makeSaveGameV2(),
    camera: { pitch: 0.3, mode: CAMERA_MODE.hood },
    player: { mode: 'driving', vehicle: 0, lastVehicle: 0 },
    vehicles: [makeSavedVehicle(), makeSavedVehicle({ modelId: 'patrol_suv', x: 194, sim: undefined })],
    traffic: makeTrafficSnapshot(),
    violations: [[1234, { speeding: 2, redLight: 1 }]],
    environment: { timeOffset: 3600, override: { kind: 'rain', intensity: 0.8 } },
    ...overrides,
  };
}

const T0 = { sim: 10, game: 7 * 3600 + 300 };

/** A CAD block with the player and one AI unit, one open call and one draft report. */
export function makeCadSave(): SaveGame['cad'] {
  const cad = new CadState();
  cad.addUnit({ callsign: '12', kind: 'player', officer: 'Officer Doe', beat: 'downtown', fleetIndex: -1 }, T0);
  cad.addUnit({ callsign: '21', kind: 'ai', officer: 'Officer Reyes', beat: 'downtown', fleetIndex: 0 }, T0);
  const location = { x: 10, z: -20, edge: 3, text: '120 N Oak Street', street: 'Oak Street', cross: '5th Street', near: 'Oak Street at 5th Street', district: 'downtown' };
  const call = cad.createCall(
    { typeId: 'noiseComplaint', priority: 3, location, caller: { kind: 'anonymous', name: '', phone: '', personId: -1 }, narrative: 'Loud music.' },
    T0,
  );
  cad.assign(call.id, '21', T0, 'dispatch');
  cad.docs.create('report', { title: 'Noise', callId: call.id }, T0, 'Officer Doe #4071');
  return cad.serialize();
}

/** A dispatcher block with one AI unit en route. */
export function makeDispatchSave(): DispatchSave {
  const rng = createRng(42).stream('dispatch');
  return {
    version: 1,
    started: true,
    rng: { main: rng.state(), calls: rng.stream('calls').state(), units: rng.stream('units').state() },
    generator: { nextCallSim: 95.5, generated: 1, multiplier: 1.2, nextMultiplierSim: 15 },
    timers: { nextAssignSim: 11, assignDirty: false, nextAvlSim: 10.5, nextRetargetSim: 15 },
    units: [
      {
        callsign: '21',
        fleetIndex: 0,
        color: 0x16181d,
        mode: 'enRoute',
        role: 'call',
        callId: 1,
        dest: { x: 10, z: -20, emergency: false },
        timers: { onSceneUntil: -1, stuckSince: -1, enRouteSince: 10, breakUntil: -1, releaseAt: -1, nextBeatCheck: 20 },
        replanned: false,
        arrived: false,
        lastAvl: [100, -200],
      },
    ],
    offer: { callId: -1, declined: [] },
    plans: [[1, 1]],
    statusCheck: { lastAnswerSim: 0, attempt: 0, nextCheckSim: -1, awaitingSince: -1, locationAsked: false, welfareCallId: -1 },
    emergency: { active: false, callId: -1 },
    backup: { targetX: 0, targetZ: 0 },
    stop: { warned: false },
    events: [{ type: 'fleetArrived', index: 0 }],
    requests: [{ callsign: '12', request: { kind: 'status', status: 'busy' }, via: 'mdt' }],
  };
}

/** Records with one touched person and registration and a query in the log. */
export function makeRecordsSave(): SaveGame['records'] {
  const records = new RecordsDb(42, DETACHED_CONTEXT);
  records.person(17);
  records.runPlate(records.registration(4711).plate, undefined, T0.game);
  return records.serialize();
}

/** Patrol equipment of a sedan with the siren on, a pattern, the spotlight and a prisoner. */
export function makeEquipmentSave(): NonNullable<SaveGame['equipment'][number]> {
  const spec = vehicleModel('patrol_sedan').equipment;
  if (!spec) throw new Error('patrol_sedan has no equipment');
  const eq = new PatrolEquipment(spec);
  eq.toggleSiren();
  eq.cycleTone();
  eq.cyclePattern();
  eq.toggleSpot();
  eq.seatPrisoner(321);
  return eq.serialize();
}

/** People save with one touched person (intoxication, mood, custody and a statement). */
export function makePeopleSave(): SaveGame['people'] {
  const records = new RecordsDb(42, DETACHED_CONTEXT);
  const pop = new Population({ seed: 42, records, now: () => T0.game });
  pop.setMood(17, 0.4);
  pop.setCustody(17, 'detained');
  pop.ensureIntoxicated(17, 0.09);
  return pop.serialize();
}

/** Trunk items Phase 4 added (absent from a pre-v6 trunk). */
export const PHASE4_TRUNK_ITEMS = ['ram', 'sceneTape', 'evidenceMarkers', 'evidenceBags', 'fingerprintKit', 'camera'] as const;

/** `makeEquipmentSave()` as a pre-Phase-4 build wrote it: without the six Phase 4 trunk items. */
export function makeLegacyEquipmentSave(): NonNullable<SaveGame['equipment'][number]> {
  const eq = makeEquipmentSave();
  const trunk = { ...eq.trunk };
  for (const id of PHASE4_TRUNK_ITEMS) delete trunk[id];
  return { ...eq, trunk };
}

/** A complete v4 (Phase 2) payload: the v3 fixture plus every Phase 2 block. */
export function makeSaveGameV4(overrides: Partial<SaveGameV4> = {}): SaveGameV4 {
  const kit = new OfficerKit();
  kit.adjust('cones', 2);
  return {
    ...makeSaveGameV3(),
    cad: makeCadSave(),
    dispatch: makeDispatchSave(),
    records: makeRecordsSave(),
    radio: defaultRadioSave(createRng(42).stream('radio').state()),
    equipment: [makeLegacyEquipmentSave(), null],
    officerKit: kit.serialize(),
    speeding: [[1234, 52.5, 35]],
    ...overrides,
  };
}

/** A complete v5 (Phase 3) payload: the v4 fixture plus the people, npc, contact and scene blocks. */
export function makeSaveGameV5(overrides: Partial<SaveGameV5> = {}): SaveGameV5 {
  return {
    ...makeSaveGameV4(),
    people: makePeopleSave(),
    npc: null,
    contacts: emptyContactSave(),
    scenes: emptySceneSave(createRng(42).stream('scene').state()),
    ...overrides,
  };
}

/** A complete v6 (Phase 4) payload: the v5 fixture plus the interior, tactical, investigation and station blocks. */
export function makeSaveGameV6(overrides: Partial<SaveGameV6> = {}): SaveGameV6 {
  return {
    ...makeSaveGameV5(),
    equipment: [makeEquipmentSave(), null],
    interiors: emptyInteriorSave(createRng(42).stream('interior').state()),
    tactical: defaultTacticalSave(createRng(42).stream('tactical').state()),
    investigation: emptyInvestigationSave(createRng(42).stream('investigation').state()),
    station: newShiftStationSave(),
    ...overrides,
  };
}

/** A complete current-version (v7) payload: the v6 fixture plus the force, incidents, conduct and court blocks. */
export function makeSaveGame(overrides: Partial<SaveGame> = {}): SaveGame {
  return {
    ...makeSaveGameV6(),
    force: defaultForceSave(createRng(42).stream('force').state()),
    incidents: emptyIncidentsSave('generic'),
    conduct: newConductSave(createRng(42).stream('conduct').state()),
    court: emptyCourtSave(createRng(42).stream('court').state()),
    ...overrides,
  };
}

/** The station block a migrated v5 save gets (on patrol, pistol and taser out to `badge`). */
export { migratedStationSave };
