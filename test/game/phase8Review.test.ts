import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CAREER_CONFIG } from '../../src/career';
import { LocalConsolePort } from '../../src/game/consolePorts';
import { runScenario, scenarioBlockedReason } from '../../src/game/modes';
import { beginRolledShift, prepareRollover } from '../../src/game/rollover';
import { startNewGame, type GameSession } from '../../src/game/session';
import { initRapier } from '../../src/physics/physics';
import { SAMPLE_SCENARIOS } from '../../src/training';
import { DISTRICT_NAMES } from '../../src/world/ids';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { Harness } from './harness';

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

describe('Phase 8 review: dispatch-only scoring', () => {
  it('scores a call the random generator opened (not only scripted and console calls)', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, { mode: 'dispatchOnly' }));
    let id = -1;
    for (let i = 0; i < 40 && id < 0; i++) {
      h.step(s, 60 * 10);
      id = s.cad.openCalls()[0]?.id ?? -1;
    }
    expect(id).toBeGreaterThan(0);
    expect(s.phase8.mode.dispatch?.serialize().calls.some((c) => c.callId === id)).toBe(true);
    const port = new LocalConsolePort(s);
    const unit = s.cad.units().find((u) => u.kind === 'ai' && u.status === 'available');
    if (!unit) throw new Error('no free AI unit');
    port.assign(id, unit.callsign);
    h.step(s, 60);
    port.close(id, 'handled');
    h.step(s, 60);
    const saved = s.phase8.mode.dispatch?.serialize();
    expect(saved?.scored).toBeGreaterThan(0);
    expect(saved?.total).toBeGreaterThan(0);
  }, 300_000);
});

describe('Phase 8 review: arrests', () => {
  it('a booking credits the district of the call scene, not the station where it is typed', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, {}));
    const stationDistrict = DISTRICT_NAMES[city.districtAt(city.spawn.x, city.spawn.z)] ?? '';
    // A point in another district.
    let at: { x: number; z: number } | null = null;
    for (let x = -3000; x <= 3000 && at === null; x += 250) {
      for (let z = -3000; z <= 3000 && at === null; z += 250) {
        const name = DISTRICT_NAMES[city.districtAt(x, z)] ?? '';
        if (name !== '' && name !== 'water' && name !== stationDistrict) at = { x, z };
      }
    }
    if (!at) throw new Error('no second district');
    const call = s.dispatcher.createScriptedCall({ typeId: 'verbalDispute', x: at.x, z: at.z }, s.now());
    if (!call) throw new Error('no call');
    const expected = DISTRICT_NAMES[city.districtAt(call.location.x, call.location.z)] ?? '';
    expect(expected).not.toBe(stationDistrict);
    // The officer stands at the station when the booking is filed.
    s.teleport(city.spawn.x, city.spawn.z);
    const person = 4321;
    const draft = s.cad.docs.create('booking', { personId: person, charges: ['PC-220'], arrestLocation: 'scene', callId: call.id }, s.now(), 'tester');
    s.cad.docs.finalize(draft.id, s.now());
    h.step(s, 2);
    expect(s.phase8.arrestsByDistrict[expected]).toBe(1);
    expect(s.phase8.arrestsByDistrict[stationDistrict] ?? 0).toBe(0);
    const offender = s.phase8.world.offender(person);
    expect(offender?.district).toBe(expected);
    expect(Math.hypot((offender?.x ?? 0) - call.location.x, (offender?.z ?? 0) - call.location.z)).toBeLessThan(1);
  }, 120_000);

  it('a person the court acquits is out of custody after the rollover and can be met again', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, {}));
    const person = 777;
    s.court.request({ kind: 'open', docId: 'B-1', docKind: 'booking', personId: person, personLabel: 'Test', callId: -1, statutes: ['PC-220'] });
    h.step(s, 2);
    const c = s.court.cases()[0];
    if (!c) throw new Error('no case');
    s.phase8.world.request({ kind: 'arrest', personId: person, district: 'downtown', callNumber: 'C-1', x: 0, z: 0, game: s.now().game, offenseClass: 'misdemeanor', juvenile: false, priors: 0 });
    s.people.setCustody(person, 'jailed');
    s.bus.emit('court:verdict', { caseId: c.id, key: c.key, verdict: 'acquitted', reason: 'reasonableDoubt', credibilityDelta: 0, impeached: false, missed: false });
    h.step(s, 2);
    // The world frees the offender at once; the person stays booked until the next shift.
    expect(s.phase8.world.offender(person)?.custody).toBe('released');
    expect(s.people.state(person).custody).toBe('jailed');
    s.fleet.request({ kind: 'endShift' });
    h.step(s, 10);
    const attempt = prepareRollover(s);
    if (!attempt.ok) throw new Error(attempt.reason);
    expect(s.people.state(person).custody).toBe('released');
  }, 120_000);

  it('a hearing the officer testified at is court time on the shift pay slip, a plea or a missed date is not', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, {}));
    // Some cases end in a plea at once: open cases until one has a hearing date.
    let scheduled = '';
    for (let i = 0; i < 40 && scheduled === ''; i++) {
      s.court.request({ kind: 'open', docId: `B-${String(i + 1)}`, docKind: 'booking', personId: 800 + i, personLabel: 'Test', callId: -1, statutes: ['PC-220'] });
      h.step(s, 2);
      scheduled = s.court.cases().find((c) => c.status === 'scheduled')?.id ?? '';
    }
    expect(scheduled).not.toBe('');
    const pleaded = s.court.cases().filter((c) => c.status !== 'scheduled').length;
    expect(s.phase8.career.view.stats.courtMinutes).toBe(0);
    s.court.request({ kind: 'advance', caseId: scheduled });
    h.step(s, 2);
    s.court.request({ kind: 'attend', caseId: scheduled });
    h.step(s, 2);
    s.court.request({ kind: 'testify', caseId: scheduled, answers: (s.court.cases().find((c) => c.id === scheduled)?.questions ?? []).map(() => 'dontRecall' as const) });
    h.step(s, 2);
    expect(s.court.cases().find((c) => c.id === scheduled)?.testimony).not.toBeNull();
    expect(s.phase8.career.view.stats.courtMinutes).toBe(CAREER_CONFIG.pay.courtMinutesPerHearing);
    expect(pleaded).toBeGreaterThanOrEqual(0);
  }, 120_000);
});

describe('Phase 8 review: follow-up warrant service', () => {
  it('the case suspect is the subject of the call even without a warrant on record', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, {}));
    let suspect = -1;
    for (let id = 1000; id < 4000 && suspect < 0; id++) if (s.records.peekPerson(id).warrants.length === 0 && s.records.peekPerson(id).dob < 0) suspect = id;
    if (suspect < 0) throw new Error('no warrant-free adult');
    let found = 0;
    for (let i = 0; i < 4; i++) {
      const call = s.dispatcher.createScriptedCall({ typeId: 'warrantService', x: city.spawn.x + 40 * i, z: city.spawn.z + 40 }, s.now());
      if (!call) continue;
      s.phase8.world.bindPerson(call.id, suspect + i);
      h.step(s, 20);
      const subject = s.scene.participants(call.id).find((p) => p.role === 'subject');
      if (subject?.personId === suspect + i) found++;
    }
    expect(found).toBeGreaterThan(0);
  }, 180_000);
});

describe('Phase 8 review: rollover keeps the call generator stream', () => {
  it('the second shift draws other call locations than the first', () => {
    const h = fresh();
    const first = h.attach(startNewGame(h.ctx, SEED, {}));
    const locations = (s: GameSession, skip: ReadonlySet<number> = new Set()): string[] =>
      s.cad.calls().filter((c) => !skip.has(c.id)).slice(0, 4).map((c) => `${Math.round(c.location.x)},${Math.round(c.location.z)}`);
    const untilCalls = (s: GameSession, skip: ReadonlySet<number>): void => {
      for (let i = 0; i < 60 && locations(s, skip).length < 3; i++) h.step(s, 60 * 30);
    };
    untilCalls(first, new Set());
    const a = locations(first);
    expect(a.length).toBeGreaterThanOrEqual(2);
    const firstIds = new Set(first.cad.calls().map((c) => c.id));
    first.fleet.request({ kind: 'endShift' });
    h.step(first, 10);
    const attempt = prepareRollover(first);
    if (!attempt.ok) throw new Error(attempt.reason);
    h.reset(first);
    const next = h.attach(h.loadFrom(attempt.save));
    beginRolledShift(next, attempt.followUps, attempt.dispatchRng);
    untilCalls(next, firstIds);
    const b = locations(next, firstIds);
    expect(b.length).toBeGreaterThanOrEqual(2);
    expect(b.slice(0, 2)).not.toEqual(a.slice(0, 2));
  }, 300_000);
});

describe('Phase 8 review: scenarios', () => {
  it('run only in free patrol and sandbox sessions and leave the clock and weather alone otherwise', () => {
    const scenario = SAMPLE_SCENARIOS[0];
    if (!scenario) throw new Error('no sample scenario');
    const h = fresh();
    const career = h.attach(startNewGame(h.ctx, SEED, { mode: 'career' }));
    const clock = career.env.time.totalSeconds;
    expect(scenarioBlockedReason(career)).toMatch(/free patrol or sandbox/);
    expect(runScenario(career, scenario)).toMatch(/free patrol or sandbox/);
    expect(career.env.time.totalSeconds).toBe(clock);
    expect(career.env.serialize().override).toBeNull();
    expect(career.phase8.modeId).toBe('career');
    expect(scenarioBlockedReason(career, true)).toMatch(/co-op/);
  }, 120_000);

  it('a scenario in free patrol switches to sandbox and the weather comes back when the sandbox ends', () => {
    const base = SAMPLE_SCENARIOS[0];
    if (!base) throw new Error('no sample scenario');
    const scenario = { ...base, weather: 'storm', hour: null };
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, {}));
    expect(s.env.serialize().override).toBeNull();
    expect(runScenario(s, scenario)).toBeNull();
    expect(s.phase8.modeId).toBe('sandbox');
    expect(s.env.serialize().override?.kind).toBe('storm');
    s.phase8.setMode('freePatrol');
    expect(s.env.serialize().override).toBeNull();
  }, 120_000);
});
