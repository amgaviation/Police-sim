import { describe, expect, it } from 'vitest';
import { LIGHTBAR_SEGMENTS } from '../../src/police/lightbar';
import {
  buildCarParts,
  cabinBox,
  hiddenBarLens,
  LENS_KINDS,
  spotlightHousing,
  twoWheelPositions,
  wheelLocalPositions,
  type CarPart,
} from '../../src/render/vehicles/carParts';
import { VEHICLE_MODELS, vehicleModel, wheelLayout, type BodyStyle, type VehicleModel } from '../../src/vehicles/model';

const EPS = 1e-9;
const CAR_STYLES: readonly BodyStyle[] = ['sedan', 'hatchback', 'suv', 'pickup', 'van', 'truck', 'bus'];
const isCar = (m: VehicleModel): boolean => CAR_STYLES.includes(m.body.style);
const byStyle = (style: BodyStyle): VehicleModel => {
  const m = VEHICLE_MODELS.find((v) => v.body.style === style);
  if (!m) throw new Error(`no model with style ${style}`);
  return m;
};

/** Push-bumper boxes lie wholly in front of the body box. */
function inFront(model: VehicleModel, p: CarPart): boolean {
  return p.kind === 'pushBar' && p.z + p.sz / 2 < -model.body.length / 2;
}

describe('buildCarParts', () => {
  it('keeps every box inside the body box (plus the cabin height on top, and the push bumper in front)', () => {
    expect(VEHICLE_MODELS.length).toBeGreaterThan(0);
    for (const model of VEHICLE_MODELS) {
      const { width, height, length, cabin } = model.body;
      const parts = buildCarParts(model);
      for (const p of parts) {
        // Helicopter blades and drone discs sweep wider than the body (and spin about their own centre).
        if (p.kind === 'rotor') continue;
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
    const models = VEHICLE_MODELS.filter((m) => m.lightbar && isCar(m));
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

  it('adds push bar and spotlight housing parts only for models with a push bumper or a spotlight', () => {
    for (const model of VEHICLE_MODELS) {
      const parts = buildCarParts(model);
      const eq = model.equipment;
      expect(parts.filter((p) => p.kind === 'pushBar').length, model.id).toBe(eq?.pushBumper ? 3 : 0);
      expect(parts.filter((p) => p.kind === 'spotHousing').length, model.id).toBe(eq?.spotlight ? 1 : 0);
    }
    // Phase 1-6 models carry no other trim.
    for (const id of ['patrol_sedan', 'patrol_suv', 'tactical_truck', 'van']) {
      expect(buildCarParts(vehicleModel(id)).filter((p) => p.kind === 'trim').length, id).toBe(0);
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
    for (const model of VEHICLE_MODELS.filter((m) => m.equipment?.spotlight && isCar(m))) {
      const housing = spotlightHousing(model);
      const c = cabinBox(model);
      expect(buildCarParts(model)).toContainEqual(housing);
      expect(housing.kind).toBe('spotHousing');
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
      if (wheelLayout(model) === 'four' && model.control === 'car') {
        expect((head?.z ?? 0) - (head?.sz ?? 0) / 2).toBeCloseTo(-model.body.length / 2, 9);
      }
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

describe('buildCarParts for the Phase 7 styles', () => {
  const NEW_STYLES: readonly BodyStyle[] = ['motorcycle', 'bicycle', 'atv', 'boat', 'helicopter', 'drone'];

  it('has a model for every new style', () => {
    for (const style of NEW_STYLES) expect(VEHICLE_MODELS.some((m) => m.body.style === style), style).toBe(true);
  });

  it('gives each new model glass, four lamps and a body, with positive sizes', () => {
    for (const model of VEHICLE_MODELS.filter((m) => NEW_STYLES.includes(m.body.style))) {
      const parts = buildCarParts(model);
      const kinds = parts.map((p) => p.kind);
      for (const kind of ['body', 'glass', 'headLeft', 'headRight', 'tailLeft', 'tailRight'] as const) {
        expect(kinds, `${model.id} ${kind}`).toContain(kind);
      }
      for (const p of parts) {
        expect(p.sx * p.sy * p.sz, `${model.id} ${p.kind}`).toBeGreaterThan(0);
        expect(Number.isFinite(p.x + p.y + p.z), model.id).toBe(true);
      }
      const head = parts.find((p) => p.kind === 'headLeft') as CarPart;
      const headR = parts.find((p) => p.kind === 'headRight') as CarPart;
      const tail = parts.find((p) => p.kind === 'tailLeft') as CarPart;
      expect(head.x, model.id).toBeLessThan(0);
      expect(headR.x, model.id).toBeGreaterThan(0);
      expect(head.z, model.id).toBeLessThan(0);
      expect(tail.z, model.id).toBeGreaterThan(0);
    }
  });

  it('has the light-bar lenses 0-7 exactly once on light-bar models, none otherwise', () => {
    for (const model of VEHICLE_MODELS.filter((m) => NEW_STYLES.includes(m.body.style))) {
      const segs = buildCarParts(model)
        .filter((p) => p.kind === 'lightbar')
        .map((p) => p.segment);
      expect(segs.slice().sort(), model.id).toEqual(model.lightbar ? Array.from({ length: LIGHTBAR_SEGMENTS }, (_, i) => i) : []);
    }
  });

  it('splits the motorcycle bar: 0-3 across the fairing front, 4-7 across the top-case rear, left to right', () => {
    const model = byStyle('motorcycle');
    const lenses = buildCarParts(model).filter((p) => p.kind === 'lightbar');
    expect(lenses.length).toBe(LIGHTBAR_SEGMENTS);
    const frontRow = lenses.filter((p) => (p.segment ?? -1) < 4);
    const rearRow = lenses.filter((p) => (p.segment ?? -1) >= 4);
    expect(frontRow.length).toBe(4);
    expect(frontRow.every((p) => p.z < 0)).toBe(true);
    expect(rearRow.every((p) => p.z > 0)).toBe(true);
    for (const row of [frontRow, rearRow]) {
      for (let i = 1; i < row.length; i++) expect((row[i] as CarPart).x).toBeGreaterThan((row[i - 1] as CarPart).x);
      const lo = Math.min(...row.map((p) => p.x - p.sx / 2));
      const hi = Math.max(...row.map((p) => p.x + p.sx / 2));
      expect(hi - lo).toBeCloseTo(0.4 * model.body.width, 9);
    }
  });

  it('builds the motorcycle frame, fairing, windscreen, handlebar and top case from the design fractions', () => {
    const model = byStyle('motorcycle');
    const { width: w, height: h, length: l } = model.body;
    const parts = buildCarParts(model);
    const frame = parts.find((p) => p.kind === 'body') as CarPart;
    expect(frame.sx).toBeCloseTo(0.3 * w, 9);
    expect(frame.sy).toBeCloseTo(0.35 * h, 9);
    expect(frame.sz).toBeCloseTo(0.85 * l, 9);
    expect(frame.y - frame.sy / 2).toBeCloseTo(-h / 2, 9);
    const fairing = parts.find((p) => p.kind === 'cabin') as CarPart;
    expect(fairing.sx).toBeCloseTo(0.6 * w, 9);
    expect(fairing.sz).toBeCloseTo(0.18 * l, 9);
    expect(fairing.z).toBeLessThan(0);
    const screen = parts.find((p) => p.kind === 'glass') as CarPart;
    expect(screen.y - screen.sy / 2).toBeGreaterThanOrEqual(fairing.y + fairing.sy / 2 - EPS);
    expect(screen.sz).toBeCloseTo(0.03, 9);
    const bar = parts.find((p) => p.kind === 'trim') as CarPart;
    expect(bar.sx).toBeCloseTo(0.8 * w, 9);
    const heads = parts.filter((p) => p.kind === 'headLeft' || p.kind === 'headRight');
    expect(heads.map((p) => p.x).sort((a, b) => a - b)).toEqual([-0.06, 0.06]);
  });

  it('builds the helicopter with two crossed rotor blades, skids and a belly beacon', () => {
    const model = byStyle('helicopter');
    const { length: l, height: h } = model.body;
    const parts = buildCarParts(model);
    const rotors = parts.filter((p) => p.kind === 'rotor');
    expect(rotors.length).toBe(2);
    const [a, b] = rotors as [CarPart, CarPart];
    expect(a.sz).toBeCloseTo(0.95 * l, 9);
    expect(b.sx).toBeCloseTo(0.95 * l, 9);
    expect(a.x).toBe(b.x);
    expect(a.z).toBe(b.z);
    expect(a.y + a.sy / 2).toBeLessThanOrEqual(h / 2 + EPS);
    const skids = parts.filter((p) => p.kind === 'trim' && p.sz > 0.3 * l);
    expect(skids.length).toBe(2);
    expect(skids.map((p) => Math.sign(p.x)).sort()).toEqual([-1, 1]);
    const bubble = parts.find((p) => p.kind === 'glass') as CarPart;
    expect(bubble.sx).toBeCloseTo(0.9 * model.body.width, 9);
    const beacon = parts.filter((p) => p.kind === 'lightbar');
    const fuselage = parts.find((p) => p.kind === 'body') as CarPart;
    for (const lens of beacon) expect(lens.y + lens.sy / 2).toBeLessThanOrEqual(fuselage.y - fuselage.sy / 2 + EPS);
  });

  it('builds the drone with four rotor discs at the arm ends and a camera below the front', () => {
    const model = byStyle('drone');
    const { width: w, length: l, height: h } = model.body;
    const parts = buildCarParts(model);
    const rotors = parts.filter((p) => p.kind === 'rotor');
    expect(rotors.length).toBe(4);
    for (const r of rotors) {
      expect([r.sx, r.sy, r.sz]).toEqual([0.22, 0.01, 0.22]);
      expect(Math.max(Math.abs(r.x) + r.sx / 2, Math.abs(r.z) + r.sz / 2)).toBeCloseTo(Math.max(w, l) / 2, 9);
    }
    const camera = parts.find((p) => p.kind === 'glass') as CarPart;
    expect(camera.z).toBeLessThan(0);
    expect(camera.y - camera.sy / 2).toBeCloseTo(-h / 2, 9);
    expect(parts.some((p) => p.kind === 'lightbar')).toBe(false);
  });

  it('builds the bicycle from thin tubes with a painted pannier and no light bar', () => {
    const model = byStyle('bicycle');
    const parts = buildCarParts(model);
    expect(parts.some((p) => p.kind === 'lightbar')).toBe(false);
    const thin = parts.filter((p) => p.kind === 'body');
    expect(thin.length).toBeGreaterThanOrEqual(3);
    for (const t of thin) expect(Math.min(t.sx, t.sy, t.sz)).toBeLessThanOrEqual(0.06);
    const pannier = parts.find((p) => p.kind === 'cabin') as CarPart;
    expect(pannier.sx).toBeCloseTo(0.3 * model.body.width, 9);
    expect(pannier.z).toBeGreaterThan(0);
    const reflector = parts.find((p) => p.kind === 'glass') as CarPart;
    expect(reflector.sz).toBeCloseTo(0.01, 9);
  });

  it('puts the ATV rack lenses across the rear rack, the boat hull ahead of its console and a spotlight on boat and helicopter', () => {
    const atv = byStyle('atv');
    const rack = buildCarParts(atv).filter((p) => p.kind === 'trim' && p.z > 0);
    const lenses = buildCarParts(atv).filter((p) => p.kind === 'lightbar');
    expect(rack.length).toBe(1);
    expect(lenses.length).toBe(LIGHTBAR_SEGMENTS);
    for (const lens of lenses) {
      expect(lens.z).toBeGreaterThan(0);
      expect(Math.abs(lens.x) + lens.sx / 2).toBeLessThanOrEqual((rack[0] as CarPart).sx / 2);
    }
    const boat = byStyle('boat');
    const parts = buildCarParts(boat);
    expect(parts.filter((p) => p.kind === 'body').length).toBe(2); // hull and bow block
    const bowBlock = parts.filter((p) => p.kind === 'body').sort((p, q) => p.z - q.z)[0] as CarPart;
    expect(bowBlock.sx).toBeCloseTo(0.7 * boat.body.width, 9);
    for (const style of ['boat', 'helicopter'] as const) {
      const model = byStyle(style);
      expect(model.equipment?.spotlight).toBe(true);
      expect(buildCarParts(model).filter((p) => p.kind === 'spotHousing').length, style).toBe(1);
    }
  });
});

describe('hiddenBarLens', () => {
  it('puts segments 0-3 behind the grille at head lamp height + 0.05, spread over -0.3w..0.3w', () => {
    const model = vehicleModel('unmarked_sedan');
    const head = buildCarParts(model).find((p) => p.kind === 'headLeft') as CarPart;
    const lenses = [0, 1, 2, 3].map((s) => hiddenBarLens(model, s));
    expect(lenses.map((p) => p.segment)).toEqual([0, 1, 2, 3]);
    expect(lenses[0]?.x).toBeCloseTo(-0.3 * model.body.width, 9);
    expect(lenses[3]?.x).toBeCloseTo(0.3 * model.body.width, 9);
    for (const p of lenses) {
      expect(p.kind).toBe('lightbar');
      expect(p.y).toBeCloseTo(head.y + 0.05, 9);
      expect([p.sx, p.sy, p.sz]).toEqual([0.12, 0.05, 0.03]);
      // A hair proud of the front face.
      expect(p.z - p.sz / 2).toBeCloseTo(-model.body.length / 2 - 0.01, 9);
    }
    for (let i = 1; i < 4; i++) expect((lenses[i] as CarPart).x).toBeGreaterThan((lenses[i - 1] as CarPart).x);
  });

  it('puts segments 4-7 at the rear window top: roof - 0.08, at the cabin rear', () => {
    const model = vehicleModel('unmarked_sedan');
    const c = cabinBox(model);
    const lenses = [4, 5, 6, 7].map((s) => hiddenBarLens(model, s));
    expect(lenses.map((p) => p.segment)).toEqual([4, 5, 6, 7]);
    for (const p of lenses) {
      expect(p.y).toBeCloseTo(c.top - 0.08, 9);
      expect(p.z).toBeGreaterThan(c.z1 - 0.05);
      expect(p.z).toBeLessThan(c.z1 + 0.05);
    }
    expect(lenses[0]?.x).toBeCloseTo(-0.3 * model.body.width, 9);
    expect(lenses[3]?.x).toBeCloseTo(0.3 * model.body.width, 9);
  });

  it('places vans at the rear face and clamps the segment index', () => {
    const van = vehicleModel('van');
    expect(hiddenBarLens(van, 5).z).toBeCloseTo(van.body.length / 2 - 0.02, 9);
    expect(hiddenBarLens(van, 99).segment).toBe(7);
    expect(hiddenBarLens(van, -3).segment).toBe(0);
  });

  it('works for every model', () => {
    for (const model of VEHICLE_MODELS) {
      for (let s = 0; s < LIGHTBAR_SEGMENTS; s++) {
        const p = hiddenBarLens(model, s);
        expect(Number.isFinite(p.x + p.y + p.z), model.id).toBe(true);
        expect(Math.abs(p.x), model.id).toBeLessThanOrEqual(model.body.width / 2);
      }
    }
  });
});

describe('twoWheelPositions', () => {
  it('places the front wheel at -wheelbase/2 and the rear at +wheelbase/2 in line, tyres on the ground', () => {
    const models = VEHICLE_MODELS.filter((m) => wheelLayout(m) === 'two');
    expect(models.map((m) => m.body.style).sort()).toEqual(['bicycle', 'motorcycle']);
    for (const model of models) {
      const { wheelbase, height, groundClearance } = model.body;
      const out = twoWheelPositions(model, new Float32Array(6));
      expect(out[0]).toBe(0);
      expect(out[3]).toBe(0);
      expect(out[2]).toBeCloseTo(-wheelbase / 2, 5);
      expect(out[5]).toBeCloseTo(wheelbase / 2, 5);
      expect((out[1] ?? 0) - model.tires.radius).toBeCloseTo(-(height / 2 + groundClearance), 5);
      expect(out[1]).toBe(out[4]);
    }
  });

  it('works with plain arrays', () => {
    const model = byStyle('motorcycle');
    expect(twoWheelPositions(model, new Array<number>(6).fill(0)).every((v) => Number.isFinite(v))).toBe(true);
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
