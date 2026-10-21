import { describe, expect, it } from 'vitest';
import { SHELL_ATLAS, type AtlasFace } from '../../src/livery/painter';
import { SHELL_FACES, SHELL_INFLATE, shellGeometryData } from '../../src/render/livery/shell';
import { cabinBox, LENS_DEPTH } from '../../src/render/vehicles/carParts';
import { VEHICLE_MODELS, vehicleModel, type VehicleModel } from '../../src/vehicles/model';

type V3 = [number, number, number];

function corner(data: ReturnType<typeof shellGeometryData>, face: AtlasFace, i: number): V3 {
  const f = SHELL_FACES.indexOf(face);
  const o = f * 12 + i * 3;
  return [data.positions[o] ?? NaN, data.positions[o + 1] ?? NaN, data.positions[o + 2] ?? NaN];
}
function uv(data: ReturnType<typeof shellGeometryData>, face: AtlasFace, i: number): [number, number] {
  const f = SHELL_FACES.indexOf(face);
  return [data.uvs[f * 8 + i * 2] ?? NaN, data.uvs[f * 8 + i * 2 + 1] ?? NaN];
}
/** Normal of the first triangle of `face` (right-hand rule on the index order). */
function normal(data: ReturnType<typeof shellGeometryData>, face: AtlasFace): V3 {
  const f = SHELL_FACES.indexOf(face);
  const idx = [0, 1, 2].map((k) => data.indices[f * 6 + k] ?? 0);
  const p = idx.map((i) => [data.positions[i * 3] ?? 0, data.positions[i * 3 + 1] ?? 0, data.positions[i * 3 + 2] ?? 0] as V3);
  const a = p[0] as V3;
  const b = p[1] as V3;
  const c = p[2] as V3;
  const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
const SEDAN = vehicleModel('patrol_sedan');

describe('shellGeometryData', () => {
  it('has six quads (left, right, hood, roof, front, rear) with finite data for every model', () => {
    expect(SHELL_FACES).toEqual(['left', 'right', 'hood', 'roof', 'front', 'rear']);
    for (const model of VEHICLE_MODELS) {
      const d = shellGeometryData(model);
      expect(d.positions.length, model.id).toBe(6 * 4 * 3);
      expect(d.uvs.length, model.id).toBe(6 * 4 * 2);
      expect(d.indices.length, model.id).toBe(6 * 6);
      expect([...d.positions, ...d.uvs].every((v) => Number.isFinite(v)), model.id).toBe(true);
      expect(Math.max(...d.indices), model.id).toBe(23);
    }
  });

  it('maps each quad onto exactly its atlas region (v = 1 - canvasY / 512)', () => {
    for (const model of VEHICLE_MODELS) {
      const d = shellGeometryData(model);
      for (const face of SHELL_FACES) {
        const [rx, ry, rw, rh] = SHELL_ATLAS.regions[face];
        const us = [0, 1, 2, 3].map((i) => uv(d, face, i)[0]);
        const vs = [0, 1, 2, 3].map((i) => uv(d, face, i)[1]);
        expect(Math.min(...us), `${model.id} ${face}`).toBeCloseTo(rx / 1024, 9);
        expect(Math.max(...us), `${model.id} ${face}`).toBeCloseTo((rx + rw) / 1024, 9);
        expect(Math.min(...vs), `${model.id} ${face}`).toBeCloseTo(1 - (ry + rh) / 512, 9);
        expect(Math.max(...vs), `${model.id} ${face}`).toBeCloseTo(1 - ry / 512, 9);
        for (const v of [...us, ...vs]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('winds every quad counter-clockwise seen from outside', () => {
    const outward: Record<AtlasFace, V3> = {
      left: [-1, 0, 0],
      right: [1, 0, 0],
      hood: [0, 1, 0],
      roof: [0, 1, 0],
      front: [0, 0, -1],
      rear: [0, 0, 1],
    };
    for (const model of VEHICLE_MODELS) {
      const d = shellGeometryData(model);
      for (const face of SHELL_FACES) {
        const n = normal(d, face);
        const o = outward[face];
        expect(n[0] * o[0] + n[1] * o[1] + n[2] * o[2], `${model.id} ${face}`).toBeGreaterThan(0);
      }
    }
  });

  it('puts canvas x = 0 of the left region at the front and of the right region at the rear', () => {
    const { width: w, length: l } = SEDAN.body;
    const d = shellGeometryData(SEDAN);
    // Front-left corner (x = -w/2, front end): u = 0, the top edge of the left region (v = 1).
    const frontLeft = [0, 1, 2, 3].find((i) => corner(d, 'left', i)[2] < 0 && corner(d, 'left', i)[1] > 0);
    expect(frontLeft).toBeDefined();
    const fl = corner(d, 'left', frontLeft ?? 0);
    expect(fl[0]).toBeCloseTo(-(w / 2 + SHELL_INFLATE), 6);
    expect(fl[2]).toBeCloseTo(-l / 2 + LENS_DEPTH, 6);
    expect(uv(d, 'left', frontLeft ?? 0)[0]).toBeCloseTo(0, 9);
    expect(uv(d, 'left', frontLeft ?? 0)[1]).toBeCloseTo(1, 9);
    // The rear end of the left side is at the far edge of the region.
    const rearLeft = [0, 1, 2, 3].find((i) => corner(d, 'left', i)[2] > 0 && corner(d, 'left', i)[1] > 0) ?? 0;
    expect(uv(d, 'left', rearLeft)[0]).toBeCloseTo(1, 9);
    // Right side: canvas x = 0 at the rear.
    const rearRight = [0, 1, 2, 3].find((i) => corner(d, 'right', i)[2] > 0 && corner(d, 'right', i)[1] > 0) ?? 0;
    expect(corner(d, 'right', rearRight)[0]).toBeCloseTo(w / 2 + SHELL_INFLATE, 6);
    expect(uv(d, 'right', rearRight)[0]).toBeCloseTo(0, 9);
    const frontRight = [0, 1, 2, 3].find((i) => corner(d, 'right', i)[2] < 0 && corner(d, 'right', i)[1] > 0) ?? 0;
    expect(uv(d, 'right', frontRight)[0]).toBeCloseTo(1, 9);
  });

  it('orients hood and roof with the front at the top and the left at canvas x = 0', () => {
    const d = shellGeometryData(SEDAN);
    for (const face of ['hood', 'roof'] as const) {
      const [rx, ry, rw, rh] = SHELL_ATLAS.regions[face];
      for (let i = 0; i < 4; i++) {
        const c = corner(d, face, i);
        const [u, v] = uv(d, face, i);
        const left = c[0] < 0;
        const front = u * 1024 === rx || Math.abs(u - rx / 1024) < 1e-9;
        expect(front, `${face} corner ${i} x`).toBe(left);
        const top = Math.abs(v - (1 - ry / 512)) < 1e-9;
        const frontEdge = c[2] === Math.min(...[0, 1, 2, 3].map((k) => corner(d, face, k)[2]));
        expect(top, `${face} corner ${i} y`).toBe(frontEdge);
        expect(rw + rh).toBeGreaterThan(0);
      }
    }
  });

  it('orients front (canvas x = 0 at the vehicle right) and rear (x = 0 at the vehicle left)', () => {
    const d = shellGeometryData(SEDAN);
    for (let i = 0; i < 4; i++) {
      const f = corner(d, 'front', i);
      const [fu] = uv(d, 'front', i);
      expect(Math.abs(fu - 768 / 1024) < 1e-9).toBe(f[0] > 0);
      const r = corner(d, 'rear', i);
      const [ru] = uv(d, 'rear', i);
      expect(Math.abs(ru - 896 / 1024) < 1e-9).toBe(r[0] < 0);
    }
  });

  it('wraps the lower body of cars: sides to the belt line, hood ahead of the cabin, roof over it', () => {
    const { width: w, height: h, length: l } = SEDAN.body;
    const c = cabinBox(SEDAN);
    const d = shellGeometryData(SEDAN);
    const ys = [0, 1, 2, 3].map((i) => corner(d, 'left', i)[1]);
    expect(Math.min(...ys)).toBeCloseTo(-h / 2, 6);
    expect(Math.max(...ys)).toBeCloseTo(c.lowerTop, 6);
    const hood = [0, 1, 2, 3].map((i) => corner(d, 'hood', i));
    for (const p of hood) expect(p[1]).toBeCloseTo(c.lowerTop + SHELL_INFLATE, 6);
    expect(Math.max(...hood.map((p) => p[2]))).toBeCloseTo(c.z0, 6);
    expect(Math.max(...hood.map((p) => Math.abs(p[0])))).toBeCloseTo(w / 2, 6);
    const roof = [0, 1, 2, 3].map((i) => corner(d, 'roof', i));
    for (const p of roof) expect(p[1]).toBeCloseTo(c.top + SHELL_INFLATE, 6);
    expect(Math.max(...roof.map((p) => Math.abs(p[0])))).toBeCloseTo(c.cx, 6);
    expect(Math.min(...roof.map((p) => p[2]))).toBeCloseTo(c.z0, 6);
    expect(Math.max(...roof.map((p) => p[2]))).toBeCloseTo(c.z1, 6);
    // Front / rear are just in front of the painted body ends (behind the lamp lenses).
    expect(corner(d, 'front', 0)[2]).toBeCloseTo(-l / 2 + LENS_DEPTH - SHELL_INFLATE, 6);
    expect(corner(d, 'rear', 0)[2]).toBeCloseTo(l / 2 - LENS_DEPTH + SHELL_INFLATE, 6);
  });

  it('uses the whole body box faces for other styles (hood = front half of the top, roof = rear half)', () => {
    for (const id of ['police_motorcycle', 'police_helicopter', 'patrol_boat', 'police_atv']) {
      const model: VehicleModel = vehicleModel(id);
      const { width: w, height: h, length: l } = model.body;
      const d = shellGeometryData(model);
      const sideYs = [0, 1, 2, 3].map((i) => corner(d, 'left', i)[1]);
      expect(Math.min(...sideYs), id).toBeCloseTo(-h / 2, 6);
      expect(Math.max(...sideYs), id).toBeCloseTo(h / 2, 6);
      const sideZs = [0, 1, 2, 3].map((i) => corner(d, 'left', i)[2]);
      expect(Math.min(...sideZs), id).toBeCloseTo(-l / 2, 6);
      expect(Math.max(...sideZs), id).toBeCloseTo(l / 2, 6);
      const hood = [0, 1, 2, 3].map((i) => corner(d, 'hood', i));
      expect(Math.min(...hood.map((p) => p[2])), id).toBeCloseTo(-l / 2, 6);
      expect(Math.max(...hood.map((p) => p[2])), id).toBeCloseTo(0, 6);
      const roof = [0, 1, 2, 3].map((i) => corner(d, 'roof', i));
      expect(Math.min(...roof.map((p) => p[2])), id).toBeCloseTo(0, 6);
      expect(Math.max(...roof.map((p) => p[2])), id).toBeCloseTo(l / 2, 6);
      expect(Math.max(...roof.map((p) => Math.abs(p[0]))), id).toBeCloseTo(w / 2, 6);
      expect(hood[0]?.[1], id).toBeCloseTo(h / 2 + SHELL_INFLATE, 6);
    }
  });

  it('is deterministic and pure', () => {
    const a = shellGeometryData(SEDAN);
    const b = shellGeometryData(SEDAN);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.uvs)).toEqual(Array.from(b.uvs));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
});
