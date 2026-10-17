import { describe, expect, it } from 'vitest';
import { LIGHTBAR_SEGMENTS } from '../../src/police/lightbar';
import { buildCarParts, cabinBox, LENS_KINDS, spotlightHousing, wheelLocalPositions, type CarPart } from '../../src/render/vehicles/carParts';
import { VEHICLE_MODELS, vehicleModel, type VehicleModel } from '../../src/vehicles/model';

const EPS = 1e-9;

/** Push-bumper boxes lie wholly in front of the body box. */
function inFront(model: VehicleModel, p: CarPart): boolean {
  return p.kind === 'trim' && p.z + p.sz / 2 < -model.body.length / 2;
}

describe('buildCarParts', () => {
  it('keeps every box inside the body box (plus the cabin height on top, and the push bumper in front)', () => {
    expect(VEHICLE_MODELS.length).toBeGreaterThan(0);
    for (const model of VEHICLE_MODELS) {
      const { width, height, length, cabin } = model.body;
      const parts = buildCarParts(model);
      for (const p of parts) {
        expect(p.sx, `${model.id} ${p.kind}`).toBeGreaterThan(0);
        expect(p.sy, `${model.id} ${p.kind}`).toBeGreaterThan(0);
        expect(p.sz, `${model.id} ${p.kind}`).toBeGreaterThan(0);
        expect(Math.abs(p.x) + p.sx / 2, `${model.id} ${p.kind} x`).toBeLessThanOrEqual(width / 2 + EPS);
        if (inFront(model, p)) expect(p.z - p.sz / 2, `${model.id} bumper z`).toBeGreaterThan(-length / 2 - 0.3);
        else expect(Math.abs(p.z) + p.sz / 2, `${model.id} ${p.kind} z`).toBeLessThanOrEqual(length / 2 + EPS);
        expect(p.y - p.sy / 2, `${model.id} ${p.kind} bottom`).toBeGreaterThanOrEqual(-height / 2 - EPS);
        expect(p.y + p.sy / 2, `${model.id} ${p.kind} top`).toBeLessThanOrEqual(height / 2 + cabin.height + EPS);
      }
    }
  });

  it('has a body, cabin, glass and four lamps, and LIGHTBAR_SEGMENTS light-bar lenses only on light-bar models', () => {
    for (const model of VEHICLE_MODELS) {
      const kinds = buildCarParts(model).map((p) => p.kind);
      for (const kind of ['body', 'cabin', 'glass', 'headLeft', 'headRight', 'tailLeft', 'tailRight'] as const) {
        expect(kinds, `${model.id}`).toContain(kind);
      }
      expect(kinds.filter((k) => k === 'lightbar').length, model.id).toBe(model.lightbar ? LIGHTBAR_SEGMENTS : 0);
      expect(kinds.filter((k) => LENS_KINDS.includes(k)).length).toBe(model.lightbar ? 4 + LIGHTBAR_SEGMENTS : 4);
    }
  });

  it('orders light-bar segments left to right across the Phase 1 bar extent, on the roof', () => {
    const models = VEHICLE_MODELS.filter((m) => m.lightbar);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      const segs = buildCarParts(model).filter((p) => p.kind === 'lightbar');
      expect(segs.map((p) => p.segment)).toEqual(Array.from({ length: LIGHTBAR_SEGMENTS }, (_, i) => i));
      for (let i = 1; i < segs.length; i++) {
        const a = segs[i - 1] as CarPart;
        const b = segs[i] as CarPart;
        expect(b.x).toBeGreaterThan(a.x);
        expect(b.x - b.sx / 2).toBeGreaterThan(a.x + a.sx / 2); // no overlap
        expect(b.sx).toBeCloseTo(a.sx, 9);
        expect(b.z).toBeCloseTo(a.z, 9);
      }
      const c = cabinBox(model);
      const half = Math.min(c.cx * 2 * 0.85, 1.4) / 2;
      const first = segs[0] as CarPart;
      const last = segs[segs.length - 1] as CarPart;
      expect(first.x - first.sx / 2).toBeCloseTo(-half, 9);
      expect(last.x + last.sx / 2).toBeCloseTo(half, 9);
      expect(first.y - first.sy / 2).toBeCloseTo(model.body.height / 2, 9);
    }
  });

  it('adds trim only for models with a push bumper or a spotlight', () => {
    for (const model of VEHICLE_MODELS) {
      const trim = buildCarParts(model).filter((p) => p.kind === 'trim');
      const eq = model.equipment;
      const expected = (eq?.pushBumper ? 3 : 0) + (eq?.spotlight ? 1 : 0);
      expect(trim.length, model.id).toBe(expected);
    }
  });

  it('puts the push bumper bar in front of the body below the lamps, with two uprights', () => {
    const model = vehicleModel('patrol_sedan');
    expect(model.equipment?.pushBumper).not.toBeNull();
    const parts = buildCarParts(model);
    const bumper = parts.filter((p) => inFront(model, p));
    expect(bumper.length).toBe(3);
    const head = parts.find((p) => p.kind === 'headLeft') as CarPart;
    const [bar, ...uprights] = [...bumper].sort((a, b) => b.sx - a.sx) as [CarPart, CarPart, CarPart];
    expect(bar.x).toBeCloseTo(0, 9);
    expect(bar.sx).toBeGreaterThan(model.body.width * 0.5);
    expect(bar.y + bar.sy / 2).toBeLessThan(head.y - head.sy / 2); // below lamp height
    expect(bar.y - bar.sy / 2).toBeGreaterThanOrEqual(-model.body.height / 2 - EPS);
    expect(uprights.map((u) => Math.sign(u.x)).sort()).toEqual([-1, 1]);
    for (const u of uprights) {
      expect(u.sy).toBeGreaterThan(bar.sy);
      expect(u.y + u.sy / 2).toBeGreaterThan(head.y); // rises past the lamps
      expect(Math.abs(u.x) + u.sx / 2).toBeLessThan(Math.abs(head.x) - head.sx / 2); // inboard of the lamps
    }
  });

  it('puts the spotlight housing at the driver A-pillar on top of the lower body', () => {
    for (const model of VEHICLE_MODELS.filter((m) => m.equipment?.spotlight)) {
      const housing = spotlightHousing(model);
      const c = cabinBox(model);
      expect(buildCarParts(model)).toContainEqual(housing);
      expect(housing.x).toBeLessThan(-c.cx + 0.1); // left side, outboard of the cabin
      expect(housing.y - housing.sy / 2).toBeCloseTo(c.lowerTop, 9);
      expect(housing.z - housing.sz / 2).toBeCloseTo(c.z0, 9);
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
