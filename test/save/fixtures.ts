import { CAMERA_MODE } from '../../src/player/cameraRig';
import type { SaveGame, SaveGameV1, SaveGameV2, SavedVehicle } from '../../src/save/schema';
import type { TrafficSnapshot } from '../../src/traffic/trafficSystem';

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

/** A complete current-version (v3) payload: driving the first of two vehicles, with traffic. */
export function makeSaveGame(overrides: Partial<SaveGame> = {}): SaveGame {
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
