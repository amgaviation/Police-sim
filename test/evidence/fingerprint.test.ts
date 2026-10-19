import { describe, expect, it } from 'vitest';
import { brush, lift, moveCursor, startDust, SURFACE_QUALITY, type DustState } from '../../src/evidence/fingerprint';
import { PRINT_SURFACES } from '../../src/evidence/types';

function dustAll(s: DustState, seconds: number): void {
  for (let i = 0; i < 16; i++) {
    s.cursor = i;
    brush(s, seconds);
  }
}

describe('startDust', () => {
  it('derives base from surface quality and u', () => {
    expect(SURFACE_QUALITY).toEqual({ glass: 0.9, metal: 0.8, stone: 0.6, wood: 0.55, fabric: 0.1 });
    expect(Object.keys(SURFACE_QUALITY).sort()).toEqual([...PRINT_SURFACES].sort());
    expect(startDust('glass', true, 3, 0).base).toBeCloseTo(0.9 * 0.6);
    expect(startDust('glass', true, 3, 1).base).toBeCloseTo(0.9);
    const s = startDust('metal', true, 3, 0.5);
    expect(s.base).toBeCloseTo(0.8 * 0.8);
    expect(s.coverage).toHaveLength(16);
    expect(s.cursor).toBe(0);
  });
});

describe('moveCursor', () => {
  it('moves on a 4x4 grid and clamps at the edges', () => {
    const s = startDust('glass', true, 1, 1);
    moveCursor(s, 'up');
    moveCursor(s, 'left');
    expect(s.cursor).toBe(0);
    moveCursor(s, 'right');
    expect(s.cursor).toBe(1);
    moveCursor(s, 'down');
    expect(s.cursor).toBe(5);
    for (let i = 0; i < 10; i++) moveCursor(s, 'right');
    expect(s.cursor).toBe(7);
    for (let i = 0; i < 10; i++) moveCursor(s, 'down');
    expect(s.cursor).toBe(15);
    moveCursor(s, 'up');
    expect(s.cursor).toBe(11);
  });
});

describe('brush', () => {
  it('adds 2*dt coverage, overflow becomes over-brushing, coverage caps at 1.5', () => {
    const s = startDust('glass', true, 1, 1);
    brush(s, 0.25);
    expect(s.coverage[0]).toBeCloseTo(0.5);
    expect(s.overbrush).toBe(0);
    brush(s, 0.5);
    expect(s.coverage[0]).toBeCloseTo(1.5);
    expect(s.overbrush).toBeCloseTo(0.5);
    brush(s, 0.5);
    expect(s.coverage[0]).toBe(1.5);
    expect(s.overbrush).toBeCloseTo(1.5);
  });
  it('does nothing after the lift', () => {
    const s = startDust('glass', true, 1, 1);
    lift(s);
    brush(s, 1);
    expect(s.coverage[0]).toBe(0);
  });
});

describe('lift', () => {
  it('scales the base by mean coverage', () => {
    const s = startDust('glass', true, 9, 1);
    dustAll(s, 0.5);
    const r = lift(s);
    expect(r.quality).toBeCloseTo(0.9);
    expect(r.usable).toBe(true);
    expect(r.personId).toBe(9);
    expect(s.lifted).toBe(true);
  });
  it('half coverage gives half quality', () => {
    const s = startDust('glass', true, 9, 1);
    for (let i = 0; i < 8; i++) {
      s.cursor = i;
      brush(s, 0.5);
    }
    expect(lift(s).quality).toBeCloseTo(0.45);
  });
  it('penalises over-brushing', () => {
    const clean = startDust('glass', true, 1, 1);
    dustAll(clean, 0.5);
    const messy = startDust('glass', true, 1, 1);
    dustAll(messy, 0.5);
    messy.cursor = 0;
    brush(messy, 0.5); // +1.0 overbrush
    expect(lift(messy).quality).toBeCloseTo(lift(clean).quality - 0.15);
  });
  it('is never usable without a print, and unusable below 0.35', () => {
    const none = startDust('glass', false, -1, 1);
    dustAll(none, 0.5);
    const r = lift(none);
    expect(r.quality).toBeGreaterThan(0.8);
    expect(r.usable).toBe(false);
    const faint = startDust('glass', true, 1, 1);
    for (let i = 0; i < 5; i++) {
      faint.cursor = i;
      brush(faint, 0.5);
    }
    expect(lift(faint).quality).toBeLessThan(0.35);
    expect(lift(faint).usable).toBe(false);
  });
  it('clamps to 0..1 and fabric never reaches usable', () => {
    const wreck = startDust('glass', true, 1, 1);
    for (let i = 0; i < 20; i++) brush(wreck, 5);
    expect(lift(wreck).quality).toBe(0);
    const fabric = startDust('fabric', true, 1, 1);
    dustAll(fabric, 0.5);
    expect(lift(fabric).usable).toBe(false);
  });
  it('lowest u on stone still lifts a careful print; wood needs good dusting', () => {
    const s = startDust('stone', true, 1, 0);
    dustAll(s, 0.5);
    expect(lift(s).quality).toBeCloseTo(0.36);
    expect(lift(s).usable).toBe(true);
    const w = startDust('wood', true, 1, 0);
    dustAll(w, 0.5);
    expect(lift(w).usable).toBe(false);
  });
});
