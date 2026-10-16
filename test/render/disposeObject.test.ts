import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { disposeObject } from '../../src/render/renderer';

describe('disposeObject', () => {
  it('disposes InstancedMesh so its instance buffers are released, plus geometry and material', () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.InstancedMesh(geometry, material, 4);
    const group = new THREE.Group();
    group.add(mesh);
    const meshDisposed = vi.fn();
    const geometryDisposed = vi.fn();
    const materialDisposed = vi.fn();
    mesh.addEventListener('dispose', meshDisposed);
    geometry.addEventListener('dispose', geometryDisposed);
    material.addEventListener('dispose', materialDisposed);

    disposeObject(group);

    expect(meshDisposed).toHaveBeenCalledOnce();
    expect(geometryDisposed).toHaveBeenCalled();
    expect(materialDisposed).toHaveBeenCalledOnce();
  });
});
