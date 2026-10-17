import { describe, expect, it } from 'vitest';
import { buildCarParts, LENS_KINDS, wheelLocalPositions } from '../../src/render/vehicles/carParts';
import { VEHICLE_MODELS } from '../../src/vehicles/model';

const EPS = 1e-9;

describe('buildCarParts', () => {
  it('keeps every box inside the body box (plus the cabin height on top) for every shipped model', () => {
    expect(VEHICLE_MODELS.length).toBeGreaterThan(0);
    for (const model of VEHICLE_MODELS) {
      const { width, height, length, cabin } = model.body;
      const parts = buildCarParts(model);
      for (const p of parts) {
        expect(p.sx, `${model.id} ${p.kind}`).toBeGreaterThan(0);
        expect(p.sy, `${model.id} ${p.kind}`).toBeGreaterThan(0);
        expect(p.sz, `${model.id} ${p.kind}`).toBeGreaterThan(0);
        expect(Math.abs(p.x) + p.sx / 2, `${model.id} ${p.kind} x`).toBeLessThanOrEqual(width / 2 + EPS);
        expect(Math.abs(p.z) + p.sz / 2, `${model.id} ${p.kind} z`).toBeLessThanOrEqual(length / 2 + EPS);
        expect(p.y - p.sy / 2, `${model.id} ${p.kind} bottom`).toBeGreaterThanOrEqual(-height / 2 - EPS);
        expect(p.y + p.sy / 2, `${model.id} ${p.kind} top`).toBeLessThanOrEqual(height / 2 + cabin.height + EPS);
      }
    }
  });

  it('has a body, cabin, glass and four lamps, and a two-part light bar only on light-bar models', () => {
    for (const model of VEHICLE_MODELS) {
      const kinds = buildCarParts(model).map((p) => p.kind);
      for (const kind of ['body', 'cabin', 'glass', 'headLeft', 'headRight', 'tailLeft', 'tailRight'] as const) {
        expect(kinds, `${model.id}`).toContain(kind);
      }
      expect(kinds.includes('lightbarRed'), model.id).toBe(model.lightbar);
      expect(kinds.includes('lightbarBlue'), model.id).toBe(model.lightbar);
      expect(kinds.filter((k) => LENS_KINDS.includes(k)).length).toBe(model.lightbar ? 6 : 4);
    }
  });

  it('puts head lamps at the front (-Z), tails at the rear and left lamps on -X', () => {
    for (const model of VEHICLE_MODELS) {
      const parts = buildCarParts(model);
      const find = (kind: string) => parts.find((p) => p.kind === kind);
      expect(find('headLeft')?.z).toBeLessThan(0);
      expect(find('tailLeft')?.z).toBeGreaterThan(0);
      expect(find('headLeft')?.x).toBeLessThan(0);
      expect(find('headRight')?.x).toBeGreaterThan(0);
      // Lenses reach the body box ends so they show in front of the painted body.
      const head = find('headLeft');
      expect((head?.z ?? 0) - (head?.sz ?? 0) / 2).toBeCloseTo(-model.body.length / 2, 9);
    }
  });

  it('makes vans and trucks full height behind the cab', () => {
    for (const model of VEHICLE_MODELS.filter((m) => m.body.style === 'van' || m.body.style === 'truck')) {
      const bodies = buildCarParts(model).filter((p) => p.kind === 'body');
      expect(bodies.length).toBe(2);
      expect(bodies[1]?.y ?? 0).toBeGreaterThan(bodies[0]?.y ?? 0);
    }
  });
});

describe('wheelLocalPositions', () => {
  it('places FL, FR, RL, RR at ±track/2, ±wheelbase/2 with tyres touching the ground', () => {
    for (const model of VEHICLE_MODELS) {
      const { track, wheelbase, height, groundClearance } = model.body;
      const out = wheelLocalPositions(model, new Float32Array(12));
      const expected = [
        [-track / 2, -wheelbase / 2],
        [track / 2, -wheelbase / 2],
        [-track / 2, wheelbase / 2],
        [track / 2, wheelbase / 2],
      ];
      for (let i = 0; i < 4; i++) {
        expect(out[i * 3]).toBeCloseTo(expected[i]?.[0] ?? NaN, 5);
        expect(out[i * 3 + 2]).toBeCloseTo(expected[i]?.[1] ?? NaN, 5);
        // Bottom of the tyre at ground level: hub y - radius = -(height/2 + groundClearance).
        expect((out[i * 3 + 1] ?? 0) - model.tires.radius).toBeCloseTo(-(height / 2 + groundClearance), 5);
      }
    }
  });

  it('works with plain arrays', () => {
    const model = VEHICLE_MODELS[0];
    if (!model) throw new Error('no models');
    const out = wheelLocalPositions(model, new Array<number>(12).fill(0));
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });
});
