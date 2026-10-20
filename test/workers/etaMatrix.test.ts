import { describe, expect, it } from 'vitest';
import { ETA_MATRIX_MAX_FROM } from '../../src/workers/protocol';
import { handleEtaMatrix } from '../../src/workers/sim.worker';
import { generateCity } from '../../src/world/generate';

const SEED = 42;

describe('eta.matrix worker handler', () => {
  const city = generateCity(SEED);
  const nodes = city.graph.nodes;
  const at = (i: number): { x: number; z: number } => {
    const n = nodes[Math.min(nodes.length - 1, i)];
    if (!n) throw new Error('empty graph');
    return { x: n.x, z: n.z };
  };

  it('matches routeBetweenPoints for each origin', () => {
    const a = at(3);
    const b = at(Math.floor(nodes.length / 2));
    const to = at(Math.floor(nodes.length / 4));
    const { rows } = handleEtaMatrix({ seed: SEED, from: [{ id: 'A', ...a }, { id: 'B', ...b }], to });
    expect(rows.map((r) => r.id)).toEqual(['A', 'B']);
    for (const [row, from] of [[rows[0], a], [rows[1], b]] as const) {
      const route = city.graph.routeBetweenPoints(from.x, from.z, to.x, to.z);
      expect(route).not.toBeNull();
      expect(row?.lengthM).toBe(route?.length);
      expect(row?.timeS).toBe(route?.time);
    }
    expect(rows[0]?.lengthM).toBeGreaterThan(0);
    expect(rows[0]?.timeS).toBeGreaterThan(0);
  });

  it('answers an origin on the target with a zero-length route and is repeatable (cached city)', () => {
    const p = at(10);
    const first = handleEtaMatrix({ seed: SEED, from: [{ id: 'X', ...p }], to: p });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.lengthM).toBeCloseTo(0, 6);
    expect(handleEtaMatrix({ seed: SEED, from: [{ id: 'X', ...p }], to: p })).toEqual(first);
  });

  it('skips unreachable origins', () => {
    const to = at(5);
    const { rows } = handleEtaMatrix({
      seed: SEED,
      from: [
        { id: 'far', x: 1e7, z: 1e7 },
        { id: 'ok', ...at(20) },
      ],
      to,
    });
    expect(rows.map((r) => r.id)).toEqual(['ok']);
  });

  it('returns no rows for no origins', () => {
    expect(handleEtaMatrix({ seed: SEED, from: [], to: at(0) })).toEqual({ rows: [] });
  });

  it('validates the payload', () => {
    const ok = { id: 'a', x: 0, z: 0 };
    const to = { x: 0, z: 0 };
    expect(ETA_MATRIX_MAX_FROM).toBe(64);
    const many = Array.from({ length: 65 }, (_, i) => ({ id: `u${i}`, x: 0, z: 0 }));
    expect(() => handleEtaMatrix({ seed: SEED, from: many, to })).toThrow(RangeError);
    expect(() => handleEtaMatrix({ seed: NaN, from: [ok], to })).toThrow(TypeError);
    expect(() => handleEtaMatrix({ seed: SEED, from: [{ id: 'a', x: NaN, z: 0 }], to })).toThrow(TypeError);
    expect(() => handleEtaMatrix({ seed: SEED, from: [{ id: 'a', x: 0, z: Infinity }], to })).toThrow(TypeError);
    expect(() => handleEtaMatrix({ seed: SEED, from: [{ id: 5 as unknown as string, x: 0, z: 0 }], to })).toThrow(TypeError);
    expect(() => handleEtaMatrix({ seed: SEED, from: [ok], to: { x: NaN, z: 0 } })).toThrow(TypeError);
    expect(() => handleEtaMatrix({ seed: SEED, from: 'x' as unknown as [], to })).toThrow(RangeError);
    expect(() => handleEtaMatrix({ seed: SEED, from: [ok], to: null as unknown as { x: number; z: number } })).toThrow(TypeError);
  });

  it('exactly 64 origins is accepted', () => {
    const p = at(7);
    const from = Array.from({ length: ETA_MATRIX_MAX_FROM }, (_, i) => ({ id: `u${i}`, ...p }));
    expect(handleEtaMatrix({ seed: SEED, from, to: at(30) }).rows).toHaveLength(ETA_MATRIX_MAX_FROM);
  });
});
