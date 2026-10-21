import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { beginRolledShift, prepareRollover } from '../../src/game/rollover';
import { serializeGame, startNewGame, type GameSession } from '../../src/game/session';
import { initRapier } from '../../src/physics/physics';
import { CURRENT_SAVE_VERSION, isSaveGame, type SaveGame } from '../../src/save/schema';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { Harness, envelope, roundTrip } from './harness';

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
    const attempt = prepareRollover(session);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(isSaveGame(attempt.save)).toBe(true);
    expect(attempt.plan.startGame).toBeGreaterThan(attempt.plan.nowGame);
    h.reset(session);
    const next = h.attach(h.loadFrom(attempt.save));
    beginRolledShift(next, attempt.followUps);
    expect(next.phase8.career.view.shift.shiftNo).toBe(2);
    expect(next.env.time.totalSeconds).toBeGreaterThanOrEqual(attempt.plan.startGame);
    expect(next.station.flow.current).toBe('locker');
    expect(next.cad.calls().every((c) => c.status === 'closed')).toBe(true);
    h.step(next, 60);
    const saved = roundTrip(serializeGame(next));
    expect(saved.career.shift.shiftNo).toBe(2);
    expect(CURRENT_SAVE_VERSION).toBe(10);
  }, 120_000);
});

export type { SaveGame };
void envelope;
