import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Strip } from '../../src/pursuit/types';
import { STRIP_HEIGHT_M, STRIP_WIDTH_M, SpikeRenderer } from '../../src/render/pursuit';

function strip(over: Partial<Strip> = {}): Strip {
  return { id: 1, x0: -2, z0: 10, x1: 2, z1: 10, placedSim: 0, owner: '12', active: true, ...over };
}

const m = new THREE.Matrix4();
const p = new THREE.Vector3();
const q = new THREE.Quaternion();
const s = new THREE.Vector3();

describe('SpikeRenderer', () => {
  it('adds two instanced meshes and draws nothing without strips', () => {
    const scene = new THREE.Scene();
    const r = new SpikeRenderer(scene);
    expect(scene.children).toContain(r.group);
    expect(r.strips).toBeInstanceOf(THREE.InstancedMesh);
    expect(r.spikes).toBeInstanceOf(THREE.InstancedMesh);
    expect(r.max).toBe(8);
    r.update([]);
    expect(r.count).toBe(0);
    expect(r.drawCalls).toBe(0);
    expect(r.strips.visible).toBe(false);
  });

  it('places an active strip at its midpoint, scaled to its length, in at most two draw calls', () => {
    const r = new SpikeRenderer(new THREE.Scene());
    r.update([strip({ x0: 0, z0: 0, x1: 6, z1: 0 })]);
    expect(r.count).toBe(1);
    expect(r.drawCalls).toBe(2);
    r.strips.getMatrixAt(0, m);
    m.decompose(p, q, s);
    expect(p.x).toBeCloseTo(3);
    expect(p.z).toBeCloseTo(0);
    expect(p.y).toBeGreaterThan(0);
    expect(p.y).toBeLessThan(0.1);
    expect(s.x).toBeCloseTo(6);
    expect(s.y).toBeCloseTo(STRIP_HEIGHT_M);
    expect(s.z).toBeCloseTo(STRIP_WIDTH_M);
    r.spikes.getMatrixAt(0, m);
    m.decompose(p, q, s);
    expect(s.x).toBeLessThan(6);
    expect(p.y).toBeGreaterThan(STRIP_HEIGHT_M / 2);
  });

  it('turns the long axis along the strip direction', () => {
    const r = new SpikeRenderer(new THREE.Scene());
    r.update([strip({ x0: 0, z0: 0, x1: 0, z1: 4 }), strip({ id: 2, x0: 0, z0: 0, x1: 3, z1: 3 })]);
    const axis = new THREE.Vector3();
    r.strips.getMatrixAt(0, m);
    m.decompose(p, q, s);
    axis.set(1, 0, 0).applyQuaternion(q);
    expect(axis.x).toBeCloseTo(0);
    expect(Math.abs(axis.z)).toBeCloseTo(1);
    r.strips.getMatrixAt(1, m);
    m.decompose(p, q, s);
    axis.set(1, 0, 0).applyQuaternion(q);
    expect(Math.abs(axis.x)).toBeCloseTo(Math.SQRT1_2);
    expect(Math.abs(axis.z)).toBeCloseTo(Math.SQRT1_2);
    expect(axis.x * axis.z).toBeGreaterThan(0); // a (3, 3) strip runs along (+1, +1), not (+1, -1)
  });

  it('draws active strips only and caps at max', () => {
    const r = new SpikeRenderer(new THREE.Scene(), 2);
    r.update([strip({ id: 1, active: false }), strip({ id: 2 }), strip({ id: 3 }), strip({ id: 4 })]);
    expect(r.count).toBe(2);
    r.update([strip({ id: 5, active: false })]);
    expect(r.count).toBe(0);
    expect(r.drawCalls).toBe(0);
  });

  it('skips a degenerate strip', () => {
    const r = new SpikeRenderer(new THREE.Scene());
    r.update([strip({ x0: 1, z0: 1, x1: 1, z1: 1 })]);
    expect(r.count).toBe(0);
  });

  it('disposes: removes the group and frees geometry, materials and instance buffers', () => {
    const scene = new THREE.Scene();
    const r = new SpikeRenderer(scene);
    const disposed: string[] = [];
    r.strips.addEventListener('dispose', () => disposed.push('strips mesh'));
    r.spikes.addEventListener('dispose', () => disposed.push('spikes mesh'));
    r.strips.geometry.addEventListener('dispose', () => disposed.push('strips geometry'));
    (r.strips.material as THREE.Material).addEventListener('dispose', () => disposed.push('strips material'));
    r.dispose();
    expect(scene.children).not.toContain(r.group);
    expect(disposed.sort()).toEqual(['spikes mesh', 'strips geometry', 'strips material', 'strips mesh']);
  });
});
