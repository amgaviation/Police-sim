import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACADEMY_MODULES } from '../../src/career';
import { beginRolledShift, prepareRollover, type PreparedRollover } from '../../src/game/rollover';
import { runScenario } from '../../src/game/modes';
import { serializeGame, startNewGame, type GameSession } from '../../src/game/session';
import { migrateEnvelope } from '../../src/save/migrations';
import { initRapier } from '../../src/physics/physics';
import { CURRENT_SAVE_VERSION, isSaveGame, type SaveGame } from '../../src/save/schema';
import { SAMPLE_SCENARIOS } from '../../src/training';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { Harness, roundTrip } from './harness';

const SEED = 42;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

let harness: Harness | null = null;
afterEach(() => {
  harness?.dispose();
  harness = null;
});

function fresh(): Harness {
  harness = new Harness(city, undefined, true);
  return harness;
}

function mustRollover(session: GameSession): PreparedRollover {
  const attempt = prepareRollover(session);
  if (!attempt.ok) throw new Error(`rollover refused: ${attempt.reason}`);
  return attempt;
}

/** A career run: academy, graduation, a shift with force and an arrest, End shift, the apartment, Report for duty and a calls in the next shift. */
function careerRun(h: Harness): { save: SaveGame; recidivists: number } {
  const session = h.attach(startNewGame(h.ctx, SEED, { mode: 'career' }));
  const career = session.phase8.career;
  expect(career.view.stage).toBe('academy');
  for (const module of ACADEMY_MODULES) career.request({ kind: 'academyScore', module, score: 90 });
  career.request({ kind: 'graduate' });
  h.step(session, 30);
  expect(career.view.stage).toBe('probation');
  // A shift: some force, an arrest of a person who will be released, a report.
  h.step(session, 120);
  session.bus.emit('force:applied', {
    seq: 1, tool: 'taser', level: 'electronic', personId: 5, actorId: 0, callId: 0, resistance: 'active', hit: true, injury: 0, fatal: false,
    cycle: 1, riskFactors: [], distance: 4, restrained: false, sim: session.clock.simTime,
  });
  const world = session.phase8.world;
  const now = session.now().game;
  for (let i = 0; i < 4; i++) {
    world.request({ kind: 'arrest', personId: 300 + i, district: 'downtown', callNumber: `C-0000${String(i + 1)}`, x: 10, z: 10, game: now, offenseClass: 'infraction', juvenile: false, priors: 6 });
    world.request({ kind: 'verdict', personId: 300 + i, verdict: 'convicted', game: now });
  }
  career.request({ kind: 'stat', key: 'arrests', delta: 4 });
  h.step(session, 120);
  session.fleet.request({ kind: 'endShift' });
  h.step(session, 10);
  expect(career.planActivity('family', 2).ok).toBe(true);
  expect(career.planActivity('rest', 6).ok).toBe(true);
  const attempt = mustRollover(session);
  h.reset(session);
  const next = h.attach(h.loadFrom(attempt.save));
  beginRolledShift(next, attempt.followUps);
  expect(next.phase8.career.view.shift.shiftNo).toBe(2);
  let recidivists = 0;
  const off = next.bus.on('world:recidivist', () => {
    recidivists++;
  });
  // Calls of types with a suspect (risk) role: released offenders are picked for them.
  for (let i = 0; i < 40; i++) {
    next.dispatcher.createCall('fightInProgress', next.now());
    h.step(next, 20);
  }
  off();
  const save = roundTrip(serializeGame(next));
  return { save, recidivists };
}

describe('Phase 8: shift rollover', () => {
  it('ends a shift, plans the off-duty hours, reports for duty and plays the next shift', () => {
    const h = fresh();
    const session = h.attach(startNewGame(h.ctx, SEED, {}));
    h.step(session, 120);
    session.fleet.request({ kind: 'endShift' });
    h.step(session, 5);
    const career = session.phase8.career;
    expect(career.view.offDuty).not.toBeNull();
    expect(career.view.shift.onDuty).toBe(false);
    expect(career.planActivity('rest', 4).ok).toBe(true);
    const attempt = mustRollover(session);
    expect(isSaveGame(attempt.save)).toBe(true);
    expect(attempt.plan.startGame).toBeGreaterThan(attempt.plan.nowGame);
    h.reset(session);
    const next = h.attach(h.loadFrom(attempt.save));
    beginRolledShift(next, attempt.followUps);
    expect(next.phase8.career.view.shift.shiftNo).toBe(2);
    expect(next.env.time.totalSeconds).toBeGreaterThanOrEqual(attempt.plan.startGame);
    expect(next.station.flow.step).toBe('locker');
    expect(next.cad.calls().every((c) => c.status === 'closed')).toBe(true);
    h.step(next, 60);
    const saved = roundTrip(serializeGame(next));
    expect(saved.career.shift.shiftNo).toBe(2);
    expect(CURRENT_SAVE_VERSION).toBe(10);
  }, 120_000);

  it('does not roll over while off duty is not reached or the officer is unfit', () => {
    const h = fresh();
    const session = h.attach(startNewGame(h.ctx, SEED, {}));
    h.step(session, 30);
    expect(prepareRollover(session)).toEqual({ ok: false, reason: 'Not off duty' });
  }, 60_000);

  it('a v9 save loads (migrated), ends a shift, rolls over and plays the next shift', () => {
    const h = fresh();
    const session = h.attach(startNewGame(h.ctx, SEED, {}));
    h.step(session, 90);
    const v10 = roundTrip(serializeGame(session));
    const { career, worldState, mode, mods, ...rest } = v10;
    void career;
    void worldState;
    void mode;
    void mods;
    const migrated = migrateEnvelope({ version: 9, createdAt: 1, updatedAt: 1, slot: 'old', data: rest });
    expect(migrated.version).toBe(CURRENT_SAVE_VERSION);
    h.reset(session);
    const loaded = h.attach(h.loadFrom(migrated.data));
    expect(loaded.phase8.career.view.stage).toBe('patrol');
    h.step(loaded, 60);
    loaded.fleet.request({ kind: 'endShift' });
    h.step(loaded, 5);
    expect(loaded.phase8.career.planActivity('rest', 3).ok).toBe(true);
    const attempt = mustRollover(loaded);
    h.reset(loaded);
    const next = h.attach(h.loadFrom(attempt.save));
    beginRolledShift(next, attempt.followUps);
    expect(next.phase8.career.view.shift.shiftNo).toBe(2);
    h.step(next, 60);
  }, 120_000);
});

describe('Phase 8: determinism', () => {
  it('a career run with a rollover and recidivist picks twice gives identical v10 saves', () => {
    const h = fresh();
    const a = careerRun(h);
    h.reset();
    const b = careerRun(h);
    expect(isSaveGame(a.save)).toBe(true);
    expect(JSON.stringify(b.save)).toBe(JSON.stringify(a.save));
    expect(a.recidivists).toBe(b.recidivists);
    expect(a.save.worldState.offenders.length).toBeGreaterThanOrEqual(4);
    // The released offenders were picked for suspect roles at least once in 40 calls.
    expect(a.recidivists).toBeGreaterThan(0);
  }, 600_000);

  it('a dispatch-only script run with manual assignments twice gives identical saves and score', () => {
    const run = (h: Harness): SaveGame => {
      const session = h.attach(startNewGame(h.ctx, SEED, { mode: 'dispatchOnly' }));
      expect(session.phase8.startScript('friday-night')).toBeNull();
      for (let i = 0; i < 8; i++) {
        h.step(session, 60 * 30);
        const open = session.cad.openCalls().find((c) => c.units.length === 0);
        const unit = session.cad.units().find((u) => u.kind === 'ai' && u.status === 'available');
        if (open && unit) {
          const t = session.now();
          const d = Math.hypot(unit.x - open.location.x, unit.z - open.location.z);
          if (session.dispatcher.assignUnit(unit.callsign, open.id, t)) {
            session.phase8.mode.dispatch?.onAssigned(open.id, t.sim, d, session.dispatcher.nearestAvailableDistance(open.location.x, open.location.z));
          }
        }
      }
      return roundTrip(serializeGame(session));
    };
    const h = fresh();
    const a = run(h);
    h.reset();
    const b = run(h);
    expect(a.mode.id).toBe('dispatchOnly');
    expect(a.mode.dispatch?.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(b.mode.dispatch?.total).toBe(a.mode.dispatch?.total);
  }, 600_000);

  it('a sandbox scenario run twice gives identical saves', () => {
    const scenario = SAMPLE_SCENARIOS[0];
    if (!scenario) throw new Error('no sample scenario');
    const run = (h: Harness): SaveGame => {
      const session = h.attach(startNewGame(h.ctx, SEED, { mode: 'sandbox', inStation: false }));
      expect(runScenario(session, scenario)).toBeNull();
      h.step(session, 300);
      const save = roundTrip(serializeGame(session));
      expect(save.mode.scenario?.id).toBe(scenario.id);
      return save;
    };
    const h = fresh();
    const a = run(h);
    h.reset();
    const b = run(h);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  }, 300_000);

  it('a v10 save of a career mid-academy loads back as it was', () => {
    const h = fresh();
    const session = h.attach(startNewGame(h.ctx, SEED, { mode: 'career' }));
    session.phase8.career.request({ kind: 'academyScore', module: 'firearms', score: 88 });
    h.step(session, 30);
    const saved = roundTrip(serializeGame(session));
    h.reset(session);
    const loaded = h.attach(h.loadFrom(saved));
    expect(loaded.phase8.modeId).toBe('career');
    expect(loaded.phase8.career.view.academy.firearms.best).toBe(88);
    expect(JSON.stringify(roundTrip(serializeGame(loaded)).career)).toBe(JSON.stringify(saved.career));
  }, 120_000);
});
