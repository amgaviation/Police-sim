import * as THREE from 'three';
import { DOOR_HEIGHT, WALL_HEIGHT, WALL_THICKNESS } from '../../interior/constants';
import type { FloorSurface, InteriorLayout } from '../../interior/types';
import type { DoorStateName } from '../../indoors/types';

/** What the renderer reads from the interior system (structurally satisfied by `InteriorSystem`). */
export interface InteriorView {
  readonly officerBuilding: number;
  readonly resident: readonly number[];
  readonly revision: number;
  layout(buildingId: number): InteriorLayout | null;
  doorState(buildingId: number, door: number): DoorStateName;
  roomLit(buildingId: number, room: number): boolean;
}

/** Door swing: seconds to open fully and the open angle (95 degrees into room `a`). */
const SWING_S = 0.25;
const OPEN_ANGLE = (95 * Math.PI) / 180;
const PANEL_THICKNESS = 0.05;
const FLOOR_THICKNESS = 0.1;
/** Doors farther than this from the camera snap instead of swinging (m). */
const SWING_RANGE = 30;
const FIXTURE_SIZE = 0.5;
const FIXTURE_Y = 0.05;
const SWITCH_Y = 1.3;

const COLORS = {
  wall: 0xd8d6d0,
  ceiling: 0xe9e6df,
  door: 0x7a5230,
  fixtureOn: 0xfff1d6,
  fixtureOff: 0x3a3a3a,
  plate: 0xece9e1,
} as const;

const FLOOR_COLORS: Readonly<Record<FloorSurface, number>> = {
  carpet: 0x7d6b5d,
  wood: 0x9a7248,
  tile: 0xb7bdc2,
  concrete: 0x8a8a86,
  linoleum: 0xa8a58f,
};

interface Slot {
  readonly buildingId: number;
  readonly layout: InteriorLayout;
  readonly group: THREE.Group;
  readonly meshes: THREE.InstancedMesh[];
  readonly doors: THREE.InstancedMesh;
  readonly fixtures: THREE.InstancedMesh;
  /** Per door: panel instance index (-1 for wide doors). */
  readonly panel: Int32Array;
  /** Per door: open fraction 0..1 now and wanted. */
  readonly frac: Float32Array;
  readonly target: Float32Array;
  /** Per door: hinge x, z, closed angle, signed open angle, width. */
  readonly hinge: Float32Array;
  /** Per room: fixture instance index (-1 none). */
  readonly fixture: Int32Array;
  swinging: number;
}

const scratchColor = new THREE.Color();

function writeBox(a: Float32Array, i: number, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
  const o = i * 16;
  a[o] = sx; a[o + 1] = 0; a[o + 2] = 0; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = sz; a[o + 11] = 0;
  a[o + 12] = cx; a[o + 13] = cy; a[o + 14] = cz; a[o + 15] = 1;
}

/** M = T(tx, ty, tz) * Ry(theta) * S(sx, sy, sz), written into instance `i`. */
function writeTurned(a: Float32Array, i: number, tx: number, ty: number, tz: number, theta: number, sx: number, sy: number, sz: number): void {
  const o = i * 16;
  const c = Math.cos(theta), s = Math.sin(theta);
  a[o] = c * sx; a[o + 1] = 0; a[o + 2] = -s * sx; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = s * sz; a[o + 9] = 0; a[o + 10] = c * sz; a[o + 11] = 0;
  a[o + 12] = tx; a[o + 13] = ty; a[o + 14] = tz; a[o + 15] = 1;
}

function setColor(mesh: THREE.InstancedMesh, i: number, hex: number): void {
  mesh.setColorAt(i, scratchColor.setHex(hex));
}

function makeMesh(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, count: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = name;
  mesh.count = count;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = count > 0;
  return mesh;
}

/**
 * Draws the resident interiors: at most six `InstancedMesh` draw calls per interior (walls, floors, ceiling,
 * furniture, door panels, fixtures and switches), and only the officer's building is visible. Buffers are built when a
 * building becomes resident; later revisions only update door targets and fixture colours in place; door panels swing
 * 95 degrees into room `a` over 0.25 s and only a swinging door rewrites its matrix. Per-frame work does not
 * allocate. Constructs and runs headless (no GL needed).
 */
export class InteriorRenderer {
  /** Draw calls of the visible interior (0 outdoors). */
  drawCalls = 0;
  private readonly root = new THREE.Group();
  private readonly slots: Slot[] = [];
  private readonly maxInteriors: number;
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  /** A unit panel hinged at x = 0, standing on y = 0. */
  private readonly panelGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0);
  private readonly lambert = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private readonly walls = new THREE.MeshLambertMaterial({ color: COLORS.wall });
  private readonly basic = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private lastRevision = -1;
  private disposed = false;

  constructor(scene: THREE.Scene, options: { maxInteriors?: number } = {}) {
    this.maxInteriors = Math.max(1, Math.floor(options.maxInteriors ?? 2));
    this.root.name = 'interiors';
    this.root.frustumCulled = false;
    scene.add(this.root);
  }

  /** Per frame, after the interior system stepped. `cameraX/Z` limit the door animation to what is near the view. */
  update(sys: InteriorView, dt: number, cameraX: number, cameraZ: number): void {
    if (this.disposed) return;
    if (sys.revision !== this.lastRevision) {
      this.lastRevision = sys.revision;
      this.sync(sys);
    }
    let calls = 0;
    const step = dt > 0 ? dt / SWING_S : 0;
    for (const slot of this.slots) {
      const visible = slot.buildingId === sys.officerBuilding;
      slot.group.visible = visible;
      if (!visible) continue;
      for (const m of slot.meshes) if (m.visible) calls++;
      if (slot.swinging > 0) this.animate(slot, step, cameraX, cameraZ);
    }
    this.drawCalls = calls;
  }

  /** Builds missing slots, drops stale ones and refreshes door targets and fixture colours. */
  private sync(sys: InteriorView): void {
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const slot = this.slots[i] as Slot;
      if (sys.resident.includes(slot.buildingId)) continue;
      this.root.remove(slot.group);
      for (const m of slot.meshes) m.dispose();
      this.slots.splice(i, 1);
    }
    for (const id of sys.resident) {
      if (this.slots.length >= this.maxInteriors || this.slots.some((s) => s.buildingId === id)) continue;
      const layout = sys.layout(id);
      if (layout === null) continue;
      const slot = this.build(id, layout);
      this.slots.push(slot);
      this.root.add(slot.group);
      this.refresh(slot, sys, true);
    }
    for (const slot of this.slots) this.refresh(slot, sys, false);
  }

  private build(buildingId: number, layout: InteriorLayout): Slot {
    const floorY = layout.floorY;
    const group = new THREE.Group();
    group.name = `interior:${buildingId}`;
    group.frustumCulled = false;

    // Walls: one box per wall segment, the length extended by the thickness so corners close.
    const nWalls = Math.floor(layout.walls.length / 4);
    const walls = makeMesh('interior-walls', this.box, this.walls, nWalls);
    for (let i = 0; i < nWalls; i++) {
      const x0 = layout.walls[i * 4] as number, z0 = layout.walls[i * 4 + 1] as number;
      const x1 = layout.walls[i * 4 + 2] as number, z1 = layout.walls[i * 4 + 3] as number;
      const lx = Math.abs(x1 - x0), lz = Math.abs(z1 - z0);
      const alongX = lx >= lz;
      writeBox(
        walls.instanceMatrix.array as Float32Array, i,
        (x0 + x1) / 2, floorY + WALL_HEIGHT / 2, (z0 + z1) / 2,
        alongX ? lx + WALL_THICKNESS : WALL_THICKNESS, WALL_HEIGHT, alongX ? WALL_THICKNESS : lz + WALL_THICKNESS,
      );
    }

    // Floors: one box per room, coloured by surface.
    const floors = makeMesh('interior-floors', this.box, this.lambert, layout.rooms.length);
    layout.rooms.forEach((r, i) => {
      const q = r.rect;
      writeBox(
        floors.instanceMatrix.array as Float32Array, i,
        (q.minX + q.maxX) / 2, floorY - FLOOR_THICKNESS / 2, (q.minZ + q.maxZ) / 2,
        q.maxX - q.minX, FLOOR_THICKNESS, q.maxZ - q.minZ,
      );
      setColor(floors, i, FLOOR_COLORS[r.surface]);
    });

    // One ceiling slab over the whole extent.
    const ceiling = makeMesh('interior-ceiling', this.box, this.lambert, 1);
    const e = layout.rect;
    writeBox(
      ceiling.instanceMatrix.array as Float32Array, 0,
      (e.minX + e.maxX) / 2, floorY + WALL_HEIGHT + FLOOR_THICKNESS / 2, (e.minZ + e.maxZ) / 2,
      e.maxX - e.minX + WALL_THICKNESS, FLOOR_THICKNESS, e.maxZ - e.minZ + WALL_THICKNESS,
    );
    setColor(ceiling, 0, COLORS.ceiling);

    // Furniture by world AABB (yaw is a multiple of 90 degrees), coloured per item.
    const furniture = makeMesh('interior-furniture', this.box, this.lambert, layout.furniture.length);
    layout.furniture.forEach((f, i) => {
      writeBox(
        furniture.instanceMatrix.array as Float32Array, i,
        (f.minX + f.maxX) / 2, floorY + f.h / 2, (f.minZ + f.maxZ) / 2,
        f.maxX - f.minX, f.h, f.maxZ - f.minZ,
      );
      setColor(furniture, i, f.color);
    });

    // Door panels (no panel for wide openings), hinged at one end of the opening.
    const panel = new Int32Array(layout.doors.length).fill(-1);
    const hinge = new Float32Array(layout.doors.length * 5);
    let panels = 0;
    layout.doors.forEach((d, i) => {
      if (d.kind !== 'wide') panel[i] = panels++;
    });
    const doors = makeMesh('interior-doors', this.panelGeometry, this.lambert, panels);
    layout.doors.forEach((d, i) => {
      const p = panel[i] as number;
      if (p < 0) return;
      const room = (layout.rooms[d.a] as InteriorLayout['rooms'][number]).rect;
      const o = i * 5;
      if (d.axis === 'x') {
        const side = (room.minZ + room.maxZ) / 2 < d.z ? -1 : 1;
        hinge[o] = d.x - d.width / 2;
        hinge[o + 1] = d.z;
        hinge[o + 2] = 0;
        hinge[o + 3] = -side * OPEN_ANGLE;
      } else {
        const side = (room.minX + room.maxX) / 2 < d.x ? -1 : 1;
        hinge[o] = d.x;
        hinge[o + 1] = d.z - d.width / 2;
        hinge[o + 2] = -Math.PI / 2;
        hinge[o + 3] = side * OPEN_ANGLE;
      }
      hinge[o + 4] = d.width;
      setColor(doors, p, COLORS.door);
    });

    // Fixtures (ceiling lights) and switch plates share one mesh; fixture colour follows the light state.
    const fixture = new Int32Array(layout.rooms.length).fill(-1);
    let fixtures = 0;
    layout.rooms.forEach((r, i) => {
      if (r.light !== null) fixture[i] = fixtures++;
    });
    const lights = fixtures;
    layout.rooms.forEach((r) => {
      if (r.switchAt !== null) fixtures++;
    });
    const fix = makeMesh('interior-fixtures', this.box, this.basic, fixtures);
    let plate = lights;
    layout.rooms.forEach((r, i) => {
      const a = fix.instanceMatrix.array as Float32Array;
      if (r.light !== null) {
        writeBox(a, fixture[i] as number, r.light.x, floorY + WALL_HEIGHT - FIXTURE_Y / 2, r.light.z, FIXTURE_SIZE, FIXTURE_Y, FIXTURE_SIZE);
        setColor(fix, fixture[i] as number, COLORS.fixtureOff);
      }
      if (r.switchAt !== null) {
        // A plate on the wall: thin along the wall normal (the switch yaw faces into the room).
        const s = r.switchAt;
        const nx = -Math.sin(s.yaw), nz = -Math.cos(s.yaw);
        const alongX = Math.abs(nz) > Math.abs(nx);
        writeBox(a, plate, s.x, floorY + SWITCH_Y, s.z, alongX ? 0.1 : 0.03, 0.14, alongX ? 0.03 : 0.1);
        setColor(fix, plate, COLORS.plate);
        plate++;
      }
    });

    const meshes = [walls, floors, ceiling, furniture, doors, fix];
    for (const m of meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      group.add(m);
    }
    doors.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    fix.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    return {
      buildingId, layout, group, meshes, doors, fixtures: fix, panel,
      frac: new Float32Array(layout.doors.length),
      target: new Float32Array(layout.doors.length),
      hinge, fixture, swinging: 0,
    };
  }

  /** Reads door states and room lights; `snap` places the doors at their targets at once (a fresh slot). */
  private refresh(slot: Slot, sys: InteriorView, snap: boolean): void {
    const layout = slot.layout;
    let swinging = 0;
    const m = slot.doors.instanceMatrix.array as Float32Array;
    for (let i = 0; i < layout.doors.length; i++) {
      const p = slot.panel[i] as number;
      if (p < 0) continue;
      const s = sys.doorState(slot.buildingId, i);
      const t = s === 'open' || s === 'broken' ? 1 : 0;
      slot.target[i] = t;
      if (snap) {
        slot.frac[i] = t;
        this.writeDoor(slot, i, m);
      } else if (slot.frac[i] !== t) swinging++;
    }
    slot.swinging = swinging;
    if (snap) slot.doors.instanceMatrix.needsUpdate = true;
    const colors = slot.fixtures.instanceColor;
    if (colors) {
      const arr = colors.array as Float32Array;
      for (let r = 0; r < layout.rooms.length; r++) {
        const f = slot.fixture[r] as number;
        if (f < 0) continue;
        scratchColor.setHex(sys.roomLit(slot.buildingId, r) ? COLORS.fixtureOn : COLORS.fixtureOff);
        arr[f * 3] = scratchColor.r;
        arr[f * 3 + 1] = scratchColor.g;
        arr[f * 3 + 2] = scratchColor.b;
      }
      colors.needsUpdate = true;
    }
  }

  private writeDoor(slot: Slot, door: number, m: Float32Array): void {
    const o = door * 5;
    const h = slot.hinge;
    const theta = (h[o + 2] as number) + (slot.frac[door] as number) * (h[o + 3] as number);
    writeTurned(m, slot.panel[door] as number, h[o] as number, slot.layout.floorY, h[o + 1] as number, theta, h[o + 4] as number, DOOR_HEIGHT, PANEL_THICKNESS);
  }

  /** Moves swinging doors towards their targets (snapping the ones far from the camera). */
  private animate(slot: Slot, step: number, cameraX: number, cameraZ: number): void {
    const m = slot.doors.instanceMatrix.array as Float32Array;
    let swinging = 0;
    let changed = false;
    const doors = slot.layout.doors;
    for (let i = 0; i < doors.length; i++) {
      const t = slot.target[i] as number;
      const f = slot.frac[i] as number;
      if (f === t) continue;
      const d = doors[i] as InteriorLayout['doors'][number];
      const dx = d.x - cameraX, dz = d.z - cameraZ;
      const next = dx * dx + dz * dz > SWING_RANGE * SWING_RANGE ? t : f < t ? Math.min(t, f + step) : Math.max(t, f - step);
      slot.frac[i] = next;
      this.writeDoor(slot, i, m);
      changed = true;
      if (next !== t) swinging++;
    }
    slot.swinging = swinging;
    if (changed) slot.doors.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) for (const m of slot.meshes) m.dispose();
    this.slots.length = 0;
    this.root.removeFromParent();
    this.box.dispose();
    this.panelGeometry.dispose();
    this.lambert.dispose();
    this.walls.dispose();
    this.basic.dispose();
  }
}
