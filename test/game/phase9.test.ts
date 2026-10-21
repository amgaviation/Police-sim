import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { serializeGame, startNewGame, type GameSession } from '../../src/game/session';
import { initRapier } from '../../src/physics/physics';
import { migrateEnvelope } from '../../src/save/migrations';
import { CURRENT_SAVE_VERSION, isSaveGame, type SaveGame } from '../../src/save/schema';
import { TUTORIAL_SCRIPTS, isTutorialSave, type TutorialSave } from '../../src/tutorial';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { Harness, IDLE, roundTrip } from './harness';

const SEED = 42;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

let harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses) h.dispose();
  harnesses = [];
});

function fresh(c: City = city): Harness {
  const h = new Harness(c, undefined, true);
  harnesses.push(h);
  return h;
}

/** The tutorial as the player plays it, one scripted action per step id (what the real keys do, through the session APIs). */
const STAGES: Record<string, (h: Harness, s: GameSession) => void> = {
  welcome: (h, s) => {
    s.phase9.runner?.ack();
    h.step(s, 30);
  },
  enterCar: (h, s) => {
    s.enterVehicle(s.vehicles[0] as NonNullable<(typeof s.vehicles)[number]>);
    h.step(s, 30);
  },
  drive: (h, s) => {
    s.driverInput.accelerate = 1;
    for (let i = 0; i < 40 && s.phase9.runner?.view.step?.id === 'drive'; i++) h.step(s, 30);
    s.driverInput.accelerate = 0;
    s.driverInput.brake = 1;
    h.step(s, 30);
    s.driverInput.brake = 0;
  },
  lights: (h, s) => {
    s.toggleLightbar();
    h.step(s, 30);
  },
  radioStatus: (h, s) => {
    // The radio menu announces its requests on the bus; the dispatcher (and the tutorial) pick them up there.
    s.bus.emit('unit:request', { callsign: s.dispatcher.playerCallsign, request: { kind: 'status', status: 'available' }, via: 'radio' });
    h.step(s, 30);
  },
  takeCall: (h, s) => {
    const cs = s.dispatcher.playerCallsign;
    const callId = s.phase9.runner?.serialize().callId ?? -1;
    expect(callId).toBeGreaterThan(0);
    // The dispatcher's own pass offers the call to an available player in a police car; a slow pass or a far call falls back to self-assignment.
    for (let i = 0; i < 8 && s.cad.call(callId)?.offeredTo !== cs; i++) h.step(s, 60);
    const offered = s.cad.call(callId)?.offeredTo === cs;
    s.dispatcher.request(cs, offered ? { kind: 'acceptCall', callId } : { kind: 'selfAssign', callId }, 'key');
    h.step(s, 30);
  },
  driveToCall: (h, s) => {
    const callId = s.phase9.runner?.serialize().callId ?? -1;
    const anchor = s.scene.runtime(callId)?.scenario.anchor ?? s.cad.call(callId)?.location;
    expect(anchor).toBeDefined();
    if (!anchor) return;
    // The scene arrives the player automatically near the scenario's anchor.
    s.teleport(anchor.x - 15, anchor.z);
    s.driverInput.brake = 1;
    for (let i = 0; i < 30 && s.phase9.runner?.view.step?.id === 'driveToCall'; i++) h.step(s, 30);
    s.driverInput.brake = 0;
  },
  scene: (h, s) => {
    const callId = s.phase9.runner?.serialize().callId ?? -1;
    s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId, disposition: 'handled' }, 'key');
    h.step(s, 30);
  },
  report: (h, s) => {
    const callId = s.phase9.runner?.serialize().callId ?? -1;
    s.cad.docs.create('report', { callId, title: 'Abandoned vehicle' }, s.now(), 'Officer Doe #4071');
    h.step(s, 30);
  },
  trafficStop: (h, s) => {
    const car = s.trafficCars(1)[0];
    expect(car).toBeDefined();
    s.bus.emit('traffic:pulledOver', { eid: 0, vehicleId: car?.vehicleId ?? 0, x: 0, z: 0, yaw: 0 });
    h.step(s, 30);
  },
  runPlate: (h, s) => {
    const car = s.trafficCars(1)[0];
    expect(car).toBeDefined();
    if (car) s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'runPlate', plate: car.plate, vehicleId: car.vehicleId }, 'key');
    h.step(s, 30);
  },
  contact: (h, s) => {
    s.bus.emit('traffic:released', { eid: 0, vehicleId: s.trafficCars(1)[0]?.vehicleId ?? 0, reason: 'released' });
    h.step(s, 30);
  },
  backup: (h, s) => {
    s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'backup', code: 2 }, 'key');
    h.step(s, 30);
  },
  done: (h, s) => {
    s.phase9.runner?.ack();
    h.step(s, 30);
  },
};

/** Plays the tutorial from wherever the runner is until it is done, or stops once step `stopAt` is current (after its enter actions ran). */
function play(h: Harness, s: GameSession, stopAt?: string): void {
  const runner = s.phase9.runner;
  if (!runner) throw new Error('no tutorial');
  h.step(s, 5);
  for (let guard = 0; guard < 40 && runner.view.active; guard++) {
    const id = runner.view.step?.id ?? '';
    if (id === stopAt) return;
    const stage = STAGES[id];
    if (!stage) throw new Error(`no scripted stage for step '${id}'`);
    stage(h, s);
    if (runner.view.step?.id === id) throw new Error(`tutorial stuck at '${id}'`);
  }
}

function finalSave(h: Harness, s: GameSession, steps = 120): SaveGame {
  h.step(s, steps);
  return roundTrip(serializeGame(s));
}

function tutorialRun(stopAt?: string): { save: SaveGame; mid?: SaveGame } {
  const h = fresh();
  const s = h.attach(startNewGame(h.ctx, SEED, { tutorial: 'firstShift' }));
  play(h, s, stopAt);
  const mid = stopAt === undefined ? undefined : roundTrip(serializeGame(s));
  if (stopAt !== undefined) play(h, s);
  const save = finalSave(h, s);
  return mid === undefined ? { save } : { save, mid };
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

describe('Phase 9: the guided first shift', () => {
  it('starts outside the station with a runner on the first step, and a normal game has none', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, { tutorial: 'firstShift' }));
    expect(s.phase9.runner).not.toBeNull();
    expect(s.phase9.active).toBe(true);
    expect(s.phase9.runner?.view.step?.id).toBe('welcome');
    expect(s.station.flow.step).not.toBe('locker');
    h.step(s, 10);
    const save = serializeGame(s);
    expect(save.tutorial).not.toBeNull();
    expect(isSaveGame(save)).toBe(true);
    h.reset(s);
    const g = h.attach(startNewGame(h.ctx, SEED, {}));
    expect(g.phase9.runner).toBeNull();
    expect(serializeGame(g).tutorial).toBeNull();
  });

  it('refuses an unknown tutorial script', () => {
    const h = fresh();
    expect(() => startNewGame(h.ctx, SEED, { tutorial: 'nope' })).toThrow(/Unknown tutorial/);
  });

  it('plays every step of the script twice to bit-identical v11 saves with completed: true', () => {
    const script = TUTORIAL_SCRIPTS['firstShift'];
    expect(script).toBeDefined();
    for (const step of script?.steps ?? []) expect(STAGES[step.id], `a stage for '${step.id}'`).toBeDefined();
    const a = tutorialRun();
    const b = tutorialRun();
    expect(a.save.tutorial).toMatchObject({ done: true, completed: true, skipped: [] });
    expect(isTutorialSave(a.save.tutorial)).toBe(true);
    expect(isSaveGame(a.save)).toBe(true);
    expect(JSON.stringify(b.save)).toBe(JSON.stringify(a.save));
  }, 180_000);

  it('a mid-tutorial save loads and finishes identically to the uninterrupted run', () => {
    const whole = tutorialRun('takeCall');
    const mid = whole.mid as SaveGame;
    expect(mid.tutorial).toMatchObject({ done: false, entered: true });
    expect((mid.tutorial as TutorialSave).callId).toBeGreaterThan(0);
    const h = fresh();
    const loaded = h.load(mid);
    expect(loaded.phase9.runner?.view.step?.id).toBe('takeCall');
    // The runner continues on the same call: it was created once, never again.
    expect(loaded.phase9.runner?.serialize().callId).toBe((mid.tutorial as TutorialSave).callId);
    play(h, loaded);
    const save = finalSave(h, loaded);
    expect(save.tutorial).toMatchObject({ done: true, completed: true });
    expect(JSON.stringify(save)).toBe(JSON.stringify(whole.save));
  }, 180_000);

  it('skipping steps and ending the tutorial are applied in the fixed step and saved', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, { tutorial: 'firstShift' }));
    const runner = s.phase9.runner;
    runner?.ack();
    h.step(s, 5);
    expect(runner?.view.step?.id).toBe('enterCar');
    runner?.skip();
    h.step(s, 5);
    expect(runner?.view.step?.id).toBe('drive');
    const saved = roundTrip(serializeGame(s));
    expect(saved.tutorial?.skipped).toEqual(['enterCar']);
    runner?.end();
    h.step(s, 5);
    expect(s.phase9.active).toBe(false);
    const ended = roundTrip(serializeGame(s));
    expect(ended.tutorial).toMatchObject({ done: true, completed: false });
    // A finished tutorial survives a save and load as finished.
    h.reset(s);
    const again = h.load(ended);
    expect(again.phase9.runner?.view.done).toBe(true);
    expect(again.phase9.active).toBe(false);
  });

  it('the tutorial call is the POI nearest the middle of the distance range, deterministically', () => {
    const sample = (): { x: number; z: number; typeId: string } => {
      const h = fresh();
      const s = h.attach(startNewGame(h.ctx, SEED, { tutorial: 'firstShift' }));
      play(h, s, 'takeCall');
      const call = s.cad.call(s.phase9.runner?.serialize().callId ?? -1);
      expect(call).toBeDefined();
      const at = s.playerPosition({ x: 0, z: 0 });
      const d = Math.hypot((call?.location.x ?? 0) - at.x, (call?.location.z ?? 0) - at.z);
      // Between the step's 250 and 600 m (the car drove a little since the POI was picked, so allow some slack).
      expect(d).toBeGreaterThan(150);
      expect(d).toBeLessThan(750);
      return { x: call?.location.x ?? 0, z: call?.location.z ?? 0, typeId: call?.typeId ?? '' };
    };
    const a = sample();
    const b = sample();
    expect(b).toEqual(a);
    expect(a.typeId).toBe('abandonedVehicle');
  }, 120_000);
});

describe('Phase 9: games without a tutorial are unchanged', () => {
  /** Hashes of the save (without the Phase 9 `tutorial` block) of three runs made by the Phase 8 build (commit 9c54ce0). */
  const PHASE8_GOLDEN: Record<string, string> = {
    idle42: '998d94949def3af5',
    drive42: 'f4fa268c8b5c3430',
    drive7: 'ef85592c4dbce2ec',
  };

  function freePatrol(name: string, seed: number, steps: number, drive: boolean): SaveGame {
    const h = fresh(generateCity(seed));
    const s = h.attach(startNewGame(h.ctx, seed, {}));
    if (drive) {
      s.enterVehicle(s.vehicles[0] as NonNullable<(typeof s.vehicles)[number]>);
      s.driverInput.accelerate = 1;
      s.driverInput.steer = 0.15;
    }
    h.step(s, steps, IDLE);
    const save = roundTrip(serializeGame(s));
    expect(save.tutorial, name).toBeNull();
    return save;
  }

  it('free patrol saves are identical to the Phase 8 build apart from the tutorial block', () => {
    for (const [name, seed, steps, drive] of [['idle42', 42, 600, false], ['drive42', 42, 900, true], ['drive7', 7, 900, true]] as const) {
      const save = freePatrol(name, seed, steps, drive);
      const { tutorial: _tutorial, ...rest } = save;
      expect(digest(rest), name).toBe(PHASE8_GOLDEN[name]);
    }
  }, 180_000);

  it('a v10 save loads with no tutorial and plays on exactly like the same game saved as v11', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, {}));
    h.step(s, 200, IDLE);
    const v11 = roundTrip(serializeGame(s));
    const { tutorial: _tutorial, ...v10 } = v11;
    h.reset(s);

    const migrated = migrateEnvelope({ version: 10, createdAt: 1, updatedAt: 1, slot: 'old', data: v10 });
    expect(migrated.version).toBe(CURRENT_SAVE_VERSION);
    expect(migrated.data.tutorial).toBeNull();
    const fromV10 = h.attach(h.loadFrom(migrated.data));
    expect(fromV10.phase9.runner).toBeNull();
    h.step(fromV10, 300, IDLE);
    const a = roundTrip(serializeGame(fromV10));
    h.reset(fromV10);

    const fromV11 = h.attach(h.loadFrom(v11));
    h.step(fromV11, 300, IDLE);
    const b = roundTrip(serializeGame(fromV11));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.tutorial).toBeNull();
  }, 120_000);
});
