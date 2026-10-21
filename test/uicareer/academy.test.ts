import { describe, expect, it } from 'vitest';
import { ACADEMY_MODULES, CAREER_CONFIG, type AcademyModule, type AcademyRecord } from '../../src/career';
import {
  AcademyScreen, academyModel, loadTrainingRecords, parseTrainingRecords, recordTrainingScore, standaloneAcademyHost, TRAINING_STORAGE_KEY,
  type AcademyHost,
} from '../../src/ui/career';
import { DefensiveDrillScreen } from '../../src/ui/career/defensive';
import { LegalQuizScreen } from '../../src/ui/career/legalQuiz';
import { RangeMinigame } from '../../src/ui/career/range';
import { ReportExerciseScreen, exerciseForAttempt } from '../../src/ui/career/reportExercise';
import { fakeStorage, key } from './helpers';

function records(overrides: Partial<Record<AcademyModule, AcademyRecord>> = {}): Record<AcademyModule, AcademyRecord> {
  const out = {} as Record<AcademyModule, AcademyRecord>;
  for (const m of ACADEMY_MODULES) out[m] = overrides[m] ?? { best: -1, attempts: 0, passed: false };
  return out;
}

function fakeHost(initial = records(), standalone = false): AcademyHost & { log: string[]; recs: Record<AcademyModule, AcademyRecord> } {
  const log: string[] = [];
  const host = {
    log,
    recs: initial,
    standalone,
    seed: () => 42,
    records() { return host.recs; },
    mods: () => ({ aimSpread: 1, steerLagS: 0, vignette: 0 }),
    submit(module: AcademyModule, score: number) { log.push(`submit ${module} ${String(score)}`); },
    startDrivingCourse(id: string) { log.push(`drive ${id}`); },
    canGraduate: () => ACADEMY_MODULES.every((m) => host.recs[m].passed),
    graduate() { log.push('graduate'); },
    close() { log.push('close'); },
  };
  return host;
}

describe('academyModel', () => {
  it('lists the five modules with best, attempts, pass mark and status', () => {
    const m = academyModel(records({ firearms: { best: 82, attempts: 2, passed: true }, legal: { best: 55.4, attempts: 1, passed: false } }), CAREER_CONFIG.academy.pass);
    expect(m.rows.map((r) => r.module)).toEqual([...ACADEMY_MODULES]);
    expect(m.rows.map((r) => r.label)).toEqual(['Driving', 'Firearms', 'Defensive tactics', 'Report writing', 'Legal']);
    expect(m.rows[0]).toMatchObject({ best: '--', attempts: 0, passed: false, pass: 70 });
    expect(m.rows[1]).toMatchObject({ best: '82', attempts: 2, passed: true, pass: 75 });
    expect(m.rows[4]).toMatchObject({ best: '55', passed: false });
    expect(m.canGraduate).toBe(false);
  });

  it('can graduate only when every module is passed', () => {
    const all = Object.fromEntries(ACADEMY_MODULES.map((k) => [k, { best: 90, attempts: 1, passed: true }])) as Record<AcademyModule, AcademyRecord>;
    expect(academyModel(records(all), CAREER_CONFIG.academy.pass).canGraduate).toBe(true);
    expect(academyModel(records({ ...all, driving: { best: 40, attempts: 3, passed: false } }), CAREER_CONFIG.academy.pass).canGraduate).toBe(false);
  });
});

describe('standaloneAcademyHost', () => {
  it('starts empty, records attempts and persists them under patrol-training-records', () => {
    const storage = fakeStorage();
    let closed = 0;
    const host = standaloneAcademyHost(storage, () => { closed++; });
    expect(host.standalone).toBe(true);
    expect(host.records().firearms).toEqual({ best: -1, attempts: 0, passed: false });
    host.submit('firearms', 60);
    host.submit('firearms', 80);
    host.submit('firearms', 70);
    expect(host.records().firearms).toEqual({ best: 80, attempts: 3, passed: true });
    expect((JSON.parse(storage.data.get(TRAINING_STORAGE_KEY) ?? '{}') as Record<string, unknown>)['firearms']).toEqual({ best: 80, attempts: 3, passed: true });
    expect(host.canGraduate()).toBe(false);
    host.close();
    expect(closed).toBe(1);
  });

  it('reloads the stored records', () => {
    const storage = fakeStorage();
    standaloneAcademyHost(storage, () => undefined).submit('report', 90);
    const again = standaloneAcademyHost(storage, () => undefined);
    expect(again.records().report).toEqual({ best: 90, attempts: 1, passed: true });
    expect(again.records().legal.attempts).toBe(0);
  });

  it('ignores malformed storage and survives a missing or throwing one', () => {
    expect(parseTrainingRecords('not json').legal.attempts).toBe(0);
    expect(parseTrainingRecords('[1,2]').legal.attempts).toBe(0);
    expect(parseTrainingRecords(JSON.stringify({ legal: { best: 'x', attempts: 1 }, report: { best: 50, attempts: -2 } })).legal.attempts).toBe(0);
    expect(parseTrainingRecords(JSON.stringify({ legal: { best: 500, attempts: 1, passed: true } })).legal.best).toBe(100);
    const none = standaloneAcademyHost(null, () => undefined);
    none.submit('legal', 90);
    expect(none.records().legal.attempts).toBe(1);
    const throwing = {
      getItem: (): string | null => { throw new Error('blocked'); },
      setItem: (): void => { throw new Error('full'); },
    };
    const host = standaloneAcademyHost(throwing, () => undefined);
    expect(() => { host.submit('legal', 90); }).not.toThrow();
    expect(host.records().legal.best).toBe(90);
  });
});

describe('AcademyScreen (headless)', () => {
  it('launches each minigame with the seed and the module attempt, and submits through the host', () => {
    const host = fakeHost(records({ legal: { best: 50, attempts: 2, passed: false } }));
    const screen = new AcademyScreen(null, host);
    screen.open();
    expect(screen.isOpen).toBe(true);
    expect(screen.launch('firearms')).toBeInstanceOf(RangeMinigame);
    expect(screen.launch('defensive')).toBeInstanceOf(DefensiveDrillScreen);
    expect(screen.launch('report')).toBeInstanceOf(ReportExerciseScreen);
    const quiz = screen.launch('legal');
    expect(quiz).toBeInstanceOf(LegalQuizScreen);
    expect(screen.activeScreen).toBe(quiz);
    const q = quiz as LegalQuizScreen;
    expect(q.mode).toBe('academy');
    // Answer everything right: the hub submits 'legal' 100.
    while (!q.state.done) {
      const right = q.state.question?.answer ?? 0;
      q.answer(right);
      q.advance();
    }
    expect(host.log).toContain('submit legal 100');
  });

  it('keys 1-5 start modules, Escape closes through the host, driving goes to the host', () => {
    const host = fakeHost();
    const screen = new AcademyScreen(null, host);
    screen.open();
    expect(screen.onKeyDown(key('5'))).toBe(true);
    expect(screen.activeScreen).toBeInstanceOf(LegalQuizScreen);
    expect(screen.onKeyDown(key('1'))).toBe(true);
    expect(host.log).toEqual(['drive basic']);
    screen.setCourse('slalom');
    screen.launch('driving');
    screen.setCourse('nonsense');
    screen.launch('driving');
    expect(host.log).toEqual(['drive basic', 'drive slalom', 'drive slalom']);
    expect(screen.onKeyDown(key('Escape'))).toBe(true);
    expect(host.log.at(-1)).toBe('close');
    expect(screen.onKeyDown(key('x'))).toBe(false);
  });

  it('graduates only when allowed and not standalone; standalone has no driving course', () => {
    const passed = Object.fromEntries(ACADEMY_MODULES.map((m) => [m, { best: 99, attempts: 1, passed: true }])) as Record<AcademyModule, AcademyRecord>;
    const host = fakeHost(passed);
    const screen = new AcademyScreen(null, host);
    screen.open();
    expect(screen.graduate()).toBe(true);
    expect(host.log).toEqual(['graduate']);
    const blocked = fakeHost();
    expect(new AcademyScreen(null, blocked).graduate()).toBe(false);
    const standalone = fakeHost(passed, true);
    const hub = new AcademyScreen(null, standalone);
    expect(hub.graduate()).toBe(false);
    expect(hub.launch('driving')).toBeNull();
    expect(standalone.log).toEqual([]);
  });
});

describe('report-writing-only records', () => {
  it('each submitted score advances the attempt (a different exercise) and persists', () => {
    const storage = fakeStorage();
    expect(loadTrainingRecords(storage).report.attempts).toBe(0);
    const first = exerciseForAttempt(loadTrainingRecords(storage).report.attempts);
    recordTrainingScore(storage, 'report', 55);
    recordTrainingScore(storage, 'report', 90);
    const after = loadTrainingRecords(storage).report;
    expect(after).toEqual({ best: 90, attempts: 2, passed: true });
    expect(exerciseForAttempt(after.attempts)?.id).not.toBe(first?.id);
  });

  it('works without storage and with a failing one', () => {
    expect(recordTrainingScore(null, 'report', 70).report.attempts).toBe(1);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadTrainingRecords(broken).report.attempts).toBe(0);
    expect(() => recordTrainingScore(broken, 'report', 70)).not.toThrow();
  });
});
