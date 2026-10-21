import { describe, expect, it } from 'vitest';
import { shapePolygon } from '../../src/livery/shapes';
import { SHAPE_KINDS, type ShapeKind } from '../../src/livery/types';

const pts = (kind: ShapeKind, opts: Parameters<typeof shapePolygon>[1] = {}): number[] => shapePolygon(kind, opts, []);
const count = (kind: ShapeKind, opts: Parameters<typeof shapePolygon>[1] = {}): number => pts(kind, opts).length / 2;

describe('shapePolygon', () => {
  it('point counts', () => {
    expect(count('rect')).toBe(4);
    expect(count('roundedRect')).toBe(20); // 4 corners x (4 segments + 1)
    expect(count('circle')).toBe(32);
    expect(count('ellipse')).toBe(32);
    expect(count('circle', { segments: 12 })).toBe(12);
    expect(count('circle', { segments: 1 })).toBe(3);
    expect(count('star')).toBe(10);
    expect(count('star', { starPoints: 3 })).toBe(6);
    expect(count('star', { starPoints: 12 })).toBe(24);
    expect(count('star', { starPoints: 40 })).toBe(24);
    expect(count('shield')).toBe(3 + 6 + 1 + 6 + 1);
    expect(count('chevron')).toBe(6);
    expect(count('triangle')).toBe(3);
    expect(count('arch')).toBe(26); // 13 outer + 13 inner
  });

  it('every point stays within [-1, 1] and the output is finite flat pairs', () => {
    for (const kind of SHAPE_KINDS) {
      const p = pts(kind, { points: [[-1, -1], [1, 0], [0, 1]], starPoints: 7 });
      expect(p.length % 2, kind).toBe(0);
      for (const v of p) {
        expect(Number.isFinite(v), kind).toBe(true);
        expect(Math.abs(v), kind).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('rect, triangle, chevron and shield have the documented corners', () => {
    expect(pts('rect')).toEqual([-1, -1, 1, -1, 1, 1, -1, 1]);
    expect(pts('triangle')).toEqual([0, -1, 1, 1, -1, 1]);
    expect(pts('chevron').slice(0, 2)).toEqual([0, -1]);
    const s = pts('shield');
    expect(s.slice(0, 6)).toEqual([-1, -1, 1, -1, 1, 0.2]);
    expect(s.slice(-2)).toEqual([-1, 0.2]);
    expect(s[2 * 9]).toBe(0); // the bottom tip
    expect(s[2 * 9 + 1]).toBe(1);
  });

  it('star alternates radius 1 and 0.45 and starts at the top', () => {
    const p = pts('star');
    expect(p[0]).toBeCloseTo(0, 9);
    expect(p[1]).toBeCloseTo(-1, 9);
    for (let i = 0; i < 10; i++) {
      const r = Math.hypot(p[2 * i] ?? 0, p[2 * i + 1] ?? 0);
      expect(r).toBeCloseTo(i % 2 === 0 ? 1 : 0.45, 9);
    }
    const seven = pts('star', { starPoints: 7 });
    expect(seven).toHaveLength(28);
    expect(Math.hypot(seven[2] ?? 0, seven[3] ?? 0)).toBeCloseTo(0.45, 9);
  });

  it('circle points lie on the unit circle', () => {
    const p = pts('circle');
    for (let i = 0; i < 32; i++) expect(Math.hypot(p[2 * i] ?? 0, p[2 * i + 1] ?? 0)).toBeCloseTo(1, 9);
  });

  it('roundedRect reaches the box edges and cuts the corners', () => {
    const p = pts('roundedRect');
    const xs = p.filter((_, i) => i % 2 === 0);
    const ys = p.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(-1, 9);
    expect(Math.max(...xs)).toBeCloseTo(1, 9);
    expect(Math.min(...ys)).toBeCloseTo(-1, 9);
    expect(Math.max(...ys)).toBeCloseTo(1, 9);
    for (let i = 0; i < p.length; i += 2) expect(Math.abs(p[i] ?? 0) === 1 && Math.abs(p[i + 1] ?? 0) === 1).toBe(false);
  });

  it('arch is a half annulus: outer radius 1, inner 0.55, upper half only', () => {
    const p = pts('arch');
    for (let i = 0; i < 13; i++) expect(Math.hypot(p[2 * i] ?? 0, p[2 * i + 1] ?? 0)).toBeCloseTo(1, 9);
    for (let i = 13; i < 26; i++) expect(Math.hypot(p[2 * i] ?? 0, p[2 * i + 1] ?? 0)).toBeCloseTo(0.55, 9);
    for (let i = 1; i < p.length; i += 2) expect(p[i]).toBeLessThanOrEqual(1e-9);
  });

  it('polygon passes the user points through', () => {
    const user: [number, number][] = [[-0.5, -0.25], [0.75, 0], [0.1, 0.9], [-1, 1]];
    expect(pts('polygon', { points: user })).toEqual([-0.5, -0.25, 0.75, 0, 0.1, 0.9, -1, 1]);
    expect(pts('polygon')).toEqual([]);
  });

  it('clears and returns the out array, and is deterministic', () => {
    const out = [9, 9, 9];
    const r = shapePolygon('triangle', {}, out);
    expect(r).toBe(out);
    expect(out).toEqual([0, -1, 1, 1, -1, 1]);
    for (const kind of SHAPE_KINDS) {
      expect(pts(kind, { points: [[0, 0], [1, 1], [0, 1]] })).toEqual(pts(kind, { points: [[0, 0], [1, 1], [0, 1]] }));
    }
  });
});
