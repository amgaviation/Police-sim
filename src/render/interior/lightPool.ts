import * as THREE from 'three';
import type { InteriorLayout } from '../../interior/types';
import type { InteriorView } from './interiorRenderer';

const LIGHT_COLOR = 0xfff1d6;
const LIGHT_INTENSITY = 12;
const LIGHT_DISTANCE = 10;
const LIGHT_DECAY = 2;
/** Height of a ceiling fixture's light above the floor (m). */
const LIGHT_HEIGHT = 2.7;
const PARKED_Y = -1000;

/**
 * A fixed pool of point lights (the shader light count never changes) placed at the ceiling fixtures of the lit rooms
 * of the officer's building that are nearest the camera; every other light has intensity 0. Allocation-free per frame.
 */
export class InteriorLightPool {
  readonly lights: readonly THREE.PointLight[];
  private readonly group = new THREE.Group();
  private readonly bestD2: Float64Array;
  private readonly bestRoom: Int32Array;
  private disposed = false;

  constructor(scene: THREE.Scene, size = 4) {
    const n = Math.max(1, Math.floor(size));
    const lights: THREE.PointLight[] = [];
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_DISTANCE, LIGHT_DECAY);
      light.name = `interiorLight:${i}`;
      light.position.set(0, PARKED_Y, 0);
      light.castShadow = false;
      lights.push(light);
      this.group.add(light);
    }
    this.lights = lights;
    this.bestD2 = new Float64Array(n);
    this.bestRoom = new Int32Array(n);
    this.group.name = 'interiorLights';
    scene.add(this.group);
  }

  /** Per frame: the lit rooms nearest the camera get a light at the fixture, the rest are switched off. */
  update(sys: InteriorView, cameraX: number, cameraZ: number): void {
    if (this.disposed) return;
    const lights = this.lights;
    const b = sys.officerBuilding;
    const layout = b >= 0 ? sys.layout(b) : null;
    if (layout === null) {
      for (const light of lights) light.intensity = 0;
      return;
    }
    const n = lights.length;
    const d2s = this.bestD2;
    const rooms = this.bestRoom;
    d2s.fill(Infinity);
    for (let r = 0; r < layout.rooms.length; r++) {
      const fixture = (layout.rooms[r] as InteriorLayout['rooms'][number]).light;
      if (fixture === null || !sys.roomLit(b, r)) continue;
      const dx = fixture.x - cameraX, dz = fixture.z - cameraZ;
      const d2 = dx * dx + dz * dz;
      if (!(d2 < (d2s[n - 1] as number))) continue;
      let k = n - 1;
      while (k > 0 && (d2s[k - 1] as number) > d2) {
        d2s[k] = d2s[k - 1] as number;
        rooms[k] = rooms[k - 1] as number;
        k--;
      }
      d2s[k] = d2;
      rooms[k] = r;
    }
    for (let k = 0; k < n; k++) {
      const light = lights[k] as THREE.PointLight;
      if (d2s[k] === Infinity) {
        light.intensity = 0;
        continue;
      }
      const fixture = (layout.rooms[rooms[k] as number] as InteriorLayout['rooms'][number]).light as NonNullable<InteriorLayout['rooms'][number]['light']>;
      light.position.set(fixture.x, layout.floorY + LIGHT_HEIGHT, fixture.z);
      light.intensity = LIGHT_INTENSITY;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const light of this.lights) light.dispose();
  }
}
