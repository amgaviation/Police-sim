import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FlashlightRig, FLASHLIGHT_INTENSITY } from '../../src/render/tactical/flashlightRig';

function camera(x = 0, y = 0, z = 0, yaw = 0): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(x, y, z);
  cam.rotation.set(0, yaw, 0);
  return cam;
}

describe('FlashlightRig', () => {
  it('adds one spot light with the design numbers and no shadow, off by default', () => {
    const scene = new THREE.Scene();
    const rig = new FlashlightRig(scene);
    const lights = scene.children.filter((c): c is THREE.SpotLight => c instanceof THREE.SpotLight);
    expect(lights).toHaveLength(1);
    const l = lights[0] as THREE.SpotLight;
    expect(l).toBe(rig.light);
    expect(l.color.getHex()).toBe(0xfff4e0);
    expect(l.distance).toBe(25);
    expect(l.angle).toBeCloseTo(0.35, 9);
    expect(l.penumbra).toBeCloseTo(0.4, 9);
    expect(l.decay).toBe(2);
    expect(l.castShadow).toBe(false);
    expect(l.intensity).toBe(0);
    expect(scene.children).toContain(l.target);
  });

  it('is on at intensity 60 and off at 0, always in the scene', () => {
    const scene = new THREE.Scene();
    const rig = new FlashlightRig(scene);
    const cam = camera();
    rig.update(true, cam);
    expect(rig.light.intensity).toBe(FLASHLIGHT_INTENSITY);
    expect(FLASHLIGHT_INTENSITY).toBe(60);
    rig.update(false, cam);
    expect(rig.light.intensity).toBe(0);
    expect(scene.children).toContain(rig.light);
  });

  it('sits 0.2 m right and 0.2 m below the camera and aims 10 m ahead', () => {
    const rig = new FlashlightRig(new THREE.Scene());
    rig.update(true, camera(10, -38, 20, 0));
    // Camera facing -Z: right is +X.
    expect(rig.light.position.x).toBeCloseTo(10.2, 6);
    expect(rig.light.position.y).toBeCloseTo(-38.2, 6);
    expect(rig.light.position.z).toBeCloseTo(20, 6);
    expect(rig.light.target.position.x).toBeCloseTo(10.2, 6);
    expect(rig.light.target.position.z).toBeCloseTo(10, 6);
    // Turned 90 degrees left (facing -X): right is -Z, ahead is -X.
    rig.update(true, camera(0, 0, 0, Math.PI / 2));
    expect(rig.light.position.x).toBeCloseTo(0, 6);
    expect(rig.light.position.z).toBeCloseTo(-0.2, 6);
    expect(rig.light.target.position.x).toBeCloseTo(-10, 6);
    expect(rig.light.target.position.z).toBeCloseTo(-0.2, 6);
  });

  it('follows a pitched camera', () => {
    const rig = new FlashlightRig(new THREE.Scene());
    const cam = camera();
    cam.rotation.set(-0.5, 0, 0); // looking down
    rig.update(true, cam);
    expect(rig.light.target.position.y).toBeLessThan(rig.light.position.y - 4);
  });

  it('removes itself from the scene on dispose', () => {
    const scene = new THREE.Scene();
    const rig = new FlashlightRig(scene);
    rig.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
