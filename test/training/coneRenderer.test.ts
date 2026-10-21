import { Matrix4, Quaternion, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CONE_CAPACITY, ConeRenderer } from '../../src/render/training/coneRenderer';

function matrixAt(r: ConeRenderer, i: number): { pos: Vector3; quat: Quaternion } {
  const m = new Matrix4();
  r.mesh.getMatrixAt(i, m);
  const pos = new Vector3();
  const quat = new Quaternion();
  m.decompose(pos, quat, new Vector3());
  return { pos, quat };
}

describe('ConeRenderer', () => {
  it('constructs headless with one instanced mesh and no cones', () => {
    const scene = new Scene();
    const r = new ConeRenderer(scene);
    expect(scene.children).toContain(r.mesh);
    expect(r.mesh.isInstancedMesh).toBe(true);
    expect(r.mesh.instanceMatrix.count).toBe(CONE_CAPACITY);
    expect(CONE_CAPACITY).toBe(64);
    expect(r.count).toBe(0);
    expect(r.mesh.geometry.type).toBe('ConeGeometry');
    const params = (r.mesh.geometry as unknown as { parameters: { radius: number; height: number; radialSegments: number } }).parameters;
    expect(params).toMatchObject({ radius: 0.18, height: 0.5, radialSegments: 8 });
    expect((r.mesh.material as unknown as { color: { getHex(): number } }).color.getHex()).toBe(0xff7a1a);
  });

  it('places standing cones on the ground and lays knocked cones on their side', () => {
    const r = new ConeRenderer(new Scene());
    const xz = new Float32Array([1, 2, 3, 4, 5, 6]);
    r.set(xz, 3, new Uint8Array([0, 1, 0]), 0.5);
    expect(r.count).toBe(3);
    const a = matrixAt(r, 0);
    expect(a.pos.x).toBeCloseTo(1);
    expect(a.pos.y).toBeCloseTo(0.75);
    expect(a.pos.z).toBeCloseTo(2);
    expect(a.quat.w).toBeCloseTo(1);
    const b = matrixAt(r, 1);
    expect(b.pos.y).toBeCloseTo(0.5 + 0.18);
    // 90 degrees about x: the cone axis (+y) points along +z.
    const axis = new Vector3(0, 1, 0).applyQuaternion(b.quat);
    expect(axis.z).toBeCloseTo(1);
    expect(axis.y).toBeCloseTo(0);
    expect(matrixAt(r, 2).pos.z).toBeCloseTo(6);
  });

  it('caps the count at 64 and at the data given, and clear hides everything', () => {
    const r = new ConeRenderer(new Scene());
    const xz = new Float32Array(200);
    r.set(xz, 100, new Uint8Array(100));
    expect(r.count).toBe(64);
    r.set(new Float32Array(4), 10, new Uint8Array(10));
    expect(r.count).toBe(2);
    r.clear();
    expect(r.count).toBe(0);
  });

  it('set flags the matrices for upload once; nothing else changes them', () => {
    const r = new ConeRenderer(new Scene());
    const v0 = r.mesh.instanceMatrix.version;
    r.set(new Float32Array([0, 0]), 1, new Uint8Array(1));
    expect(r.mesh.instanceMatrix.version).toBe(v0 + 1);
    r.clear();
    expect(r.mesh.instanceMatrix.version).toBe(v0 + 1);
  });

  it('dispose removes the mesh from the scene', () => {
    const scene = new Scene();
    const r = new ConeRenderer(scene);
    r.dispose();
    expect(scene.children).not.toContain(r.mesh);
  });
});
