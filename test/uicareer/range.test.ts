import { describe, expect, it } from 'vitest';
import { CAREER_CONFIG, rangeSchedule, scoreRange, swayOffset, type PerformanceMods, type RangeTarget } from '../../src/career';
import {
  FIELD_SIZE, FIELD_X, MIN_SHOT_GAP_S, RANGE_H, RANGE_W, RangeMinigame, RangeRun, fromCanvas, toCanvas,
} from '../../src/ui/career/range';
import { key } from './helpers';

const NEUTRAL: PerformanceMods = { aimSpread: 1, steerLagS: 0, vignette: 0 };
const TIRED: PerformanceMods = { aimSpread: 2.5, steerLagS: 0.2, vignette: 0.4 };

/** Plays a run that shoots every shoot target dead centre (cancelling the sway) and nothing else. */
function perfectRun(run: RangeRun, mods: PerformanceMods): void {
  run.start();
  const sway = { x: 0, y: 0 };
  for (const target of run.targets) {
    if (target.noShoot) continue;
    run.advance(Math.max(0, target.appearAt + 0.05 - run.t));
    swayOffset(run.t, mods, sway);
    run.movePointer(target.x - sway.x, target.y - sway.y);
    expect(run.fire()).toBe(true);
  }
  run.advance(CAREER_CONFIG.range.durationS);
}

describe('canvas mapping', () => {
  it('keeps the playfield square and centred in the 640x360 canvas', () => {
    expect([RANGE_W, RANGE_H, FIELD_SIZE, FIELD_X]).toEqual([640, 360, 360, 140]);
    const p = { x: 0, y: 0 };
    expect(toCanvas(0, 0, p)).toEqual({ x: 140, y: 0 });
    expect(toCanvas(1, 1, p)).toEqual({ x: 500, y: 360 });
    expect(fromCanvas(320, 180, p)).toEqual({ x: 0.5, y: 0.5 });
    expect(fromCanvas(-50, 999, p)).toEqual({ x: 0, y: 1 });
  });
});

describe('RangeRun', () => {
  it('draws the schedule of rangeSchedule(seed, attempt) and differs per attempt', () => {
    const a = new RangeRun(11, 0, NEUTRAL);
    expect(a.targets).toEqual(rangeSchedule(11, 0));
    expect(new RangeRun(11, 0, NEUTRAL).targets).toEqual(a.targets);
    expect(new RangeRun(11, 1, NEUTRAL).targets).not.toEqual(a.targets);
    expect(a.targets).toHaveLength(CAREER_CONFIG.range.targets);
    expect(a.targets.filter((t) => t.noShoot)).toHaveLength(CAREER_CONFIG.range.noShoot);
  });

  it('is idle until started; the clock only runs while running', () => {
    const run = new RangeRun(1, 0, NEUTRAL);
    run.advance(5);
    expect(run.t).toBe(0);
    expect(run.fire()).toBe(false);
    run.start();
    run.advance(2);
    expect(run.t).toBe(2);
    expect(run.remainingS).toBe(CAREER_CONFIG.range.durationS - 2);
    expect(run.fraction).toBeCloseTo(2 / CAREER_CONFIG.range.durationS);
  });

  it('the crosshair is the pointer plus the sway, bigger when tired', () => {
    const calm = new RangeRun(1, 0, NEUTRAL);
    const tired = new RangeRun(1, 0, TIRED);
    for (const run of [calm, tired]) {
      run.start();
      run.advance(1.3);
      run.movePointer(0.5, 0.5);
    }
    const calmOff = Math.hypot(calm.aim.x - 0.5, calm.aim.y - 0.5);
    const tiredOff = Math.hypot(tired.aim.x - 0.5, tired.aim.y - 0.5);
    expect(calmOff).toBeGreaterThan(0);
    expect(tiredOff).toBeCloseTo(calmOff * 2.5, 9);
    const expected = swayOffset(1.3, NEUTRAL, { x: 0, y: 0 });
    expect(calm.aim.x).toBeCloseTo(0.5 + expected.x, 12);
    expect(calm.aim.y).toBeCloseTo(0.5 + expected.y, 12);
  });

  it('clamps the pointer to the playfield and nudges with the arrows', () => {
    const run = new RangeRun(1, 0, NEUTRAL);
    run.movePointer(-3, 9);
    expect(run.pointer).toEqual({ x: 0, y: 1 });
    run.movePointer(0.5, 0.5);
    run.nudge(0.1, -0.1);
    expect(run.pointer.x).toBeCloseTo(0.6);
    expect(run.pointer.y).toBeCloseTo(0.4);
  });

  it('limits the fire rate', () => {
    const run = new RangeRun(1, 0, NEUTRAL);
    run.start();
    expect(run.fire()).toBe(true);
    expect(run.fire()).toBe(false);
    run.advance(MIN_SHOT_GAP_S - 0.01);
    expect(run.fire()).toBe(false);
    run.advance(0.02);
    expect(run.fire()).toBe(true);
    expect(run.shots).toHaveLength(2);
  });

  it('lists the targets on show at the current time', () => {
    const run = new RangeRun(3, 0, NEUTRAL);
    run.start();
    const first = run.targets[0] as RangeTarget;
    const out: RangeTarget[] = [];
    run.advance(first.appearAt + 0.01);
    expect(run.visible(out).map((t) => t.id)).toContain(first.id);
    run.advance(first.duration + 0.5);
    expect(run.visible(out).map((t) => t.id)).not.toContain(first.id);
  });

  it('scores a perfect run 100 with the scoring path of scoreRange', () => {
    const run = new RangeRun(5, 2, NEUTRAL);
    perfectRun(run, NEUTRAL);
    expect(run.phase).toBe('done');
    const result = run.result();
    expect(result).toEqual(scoreRange(run.targets, run.shots));
    expect(result).toMatchObject({ score: 100, noShootHits: 0 });
    expect(result?.hits).toBe(CAREER_CONFIG.range.targets - CAREER_CONFIG.range.noShoot);
  });

  it('costs 15 points per no-shoot hit and scores nothing for an empty run', () => {
    const run = new RangeRun(5, 2, NEUTRAL);
    run.start();
    const sway = { x: 0, y: 0 };
    const target = run.targets.find((t) => t.noShoot) as RangeTarget;
    run.advance(target.appearAt + 0.05);
    swayOffset(run.t, NEUTRAL, sway);
    run.movePointer(target.x - sway.x, target.y - sway.y);
    run.fire();
    run.advance(100);
    expect(run.result()).toMatchObject({ score: 0, noShootHits: 1, hits: 0 });
    const empty = new RangeRun(5, 2, NEUTRAL);
    empty.start();
    empty.advance(100);
    expect(empty.result()).toMatchObject({ score: 0, misses: 0, hits: 0 });
  });

  it('a tired officer scores lower than a rested one aiming at the same spots', () => {
    const rested = new RangeRun(8, 0, NEUTRAL);
    const tired = new RangeRun(8, 0, TIRED);
    for (const run of [rested, tired]) {
      run.start();
      for (const target of run.targets) {
        if (target.noShoot) continue;
        run.advance(Math.max(0, target.appearAt + 0.3 - run.t));
        run.movePointer(target.x, target.y); // no compensation: the sway decides
        run.fire();
      }
      run.advance(100);
    }
    expect(tired.result()?.score ?? 0).toBeLessThanOrEqual(rested.result()?.score ?? 0);
  });
});

describe('RangeMinigame (headless)', () => {
  function make(): { screen: RangeMinigame; scores: number[]; exits: number[] } {
    const scores: number[] = [];
    const exits: number[] = [];
    const screen = new RangeMinigame(null, { seed: 9, attempt: 1, onScore: (s) => scores.push(s), onExit: () => exits.push(1) }, () => NEUTRAL);
    return { screen, scores, exits };
  }

  it('submits the score once when the range closes, then Enter leaves', () => {
    const { screen, scores, exits } = make();
    screen.open();
    expect(screen.onKeyDown(key('Enter'))).toBe(true); // start
    expect(screen.state.phase).toBe('running');
    screen.advance(30);
    expect(scores).toEqual([]);
    screen.advance(30);
    screen.advance(5);
    expect(screen.state.phase).toBe('done');
    expect(scores).toHaveLength(1);
    expect(screen.onKeyDown(key(' '))).toBe(true);
    expect(exits).toEqual([1]);
    expect(screen.isOpen).toBe(false);
  });

  it('arrow keys move the crosshair, Space fires, Escape abandons without a score', () => {
    const { screen, scores, exits } = make();
    screen.open();
    screen.press('Enter');
    const x0 = screen.state.pointer.x;
    screen.press('ArrowRight');
    expect(screen.state.pointer.x).toBeGreaterThan(x0);
    screen.press(' ');
    expect(screen.state.shots).toHaveLength(1);
    expect(screen.press('q')).toBe(false);
    expect(screen.onKeyDown(key('Escape'))).toBe(true);
    expect(scores).toEqual([]);
    expect(exits).toEqual([1]);
  });
});
