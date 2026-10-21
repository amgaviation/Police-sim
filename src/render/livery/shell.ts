import { SHELL_ATLAS, type AtlasFace } from '../../livery/painter';
import type { VehicleModel } from '../../vehicles/model';
import { cabinBox, LENS_DEPTH } from '../vehicles/carParts';

/** How far the shell stands off the painted body (m). */
export const SHELL_INFLATE = 0.006;

/** Shell faces in vertex order: four vertices and six indices each. */
export const SHELL_FACES: readonly AtlasFace[] = ['left', 'right', 'hood', 'roof', 'front', 'rear'];

export interface ShellGeometryData {
  /** x, y, z per vertex, vehicle frame (origin = body box centre, -Z front, -X left). */
  positions: Float32Array;
  /** u, v per vertex into the 1024x512 atlas (`v = 1 - canvasY / 512`). */
  uvs: Float32Array;
  /** Two counter-clockwise triangles per face, seen from outside. */
  indices: Uint16Array;
}

/** A face corner in the vehicle frame. */
type Corner = readonly [x: number, y: number, z: number];

/** True for the body styles that get a decal shell (a shell around a thin-framed vehicle would hide it). */
export function hasShell(model: VehicleModel): boolean {
  const style = model.body.style;
  return style === 'sedan' || style === 'hatchback' || style === 'suv' || style === 'pickup' || style === 'van' || style === 'truck' || style === 'bus';
}

/**
 * Shell quads around `model` (design §10.3), inflated by `SHELL_INFLATE`, with UVs into `SHELL_ATLAS` following the
 * §6.5 orientation: every face is mapped as seen from outside, canvas x left to right as the viewer sees it, canvas
 * y top to bottom. Six quads in `SHELL_FACES` order.
 *
 * Car styles (sedan, hatchback, suv, pickup, van, truck, bus): the sides of the lower body (floor to belt line,
 * the length of the painted body), the hood (on top of the lower body, front to cabin start), the roof (over the
 * cabin), the painted front and rear faces. Other styles: the faces of the whole body box (sides full height,
 * hood = the front half of the top, roof = the rear half).
 */
export function shellGeometryData(model: VehicleModel): ShellGeometryData {
  const { width: w, height: h, length: l } = model.body;
  const e = SHELL_INFLATE;
  const car = hasShell(model);
  let zF: number;
  let zR: number;
  const yBottom = -h / 2;
  let yTop: number;
  let hoodY: number;
  let hoodZ1: number;
  let roofY: number;
  let roofHalf: number;
  let roofZ0: number;
  let roofZ1: number;
  if (car) {
    const c = cabinBox(model);
    zF = -l / 2 + LENS_DEPTH;
    zR = l / 2 - LENS_DEPTH;
    yTop = c.lowerTop;
    hoodY = c.lowerTop + e;
    hoodZ1 = c.z0;
    roofY = c.top + e;
    roofHalf = c.cx;
    roofZ0 = c.z0;
    roofZ1 = c.z1;
  } else {
    zF = -l / 2;
    zR = l / 2;
    yTop = h / 2;
    hoodY = h / 2 + e;
    hoodZ1 = 0;
    roofY = h / 2 + e;
    roofHalf = w / 2;
    roofZ0 = 0;
    roofZ1 = l / 2;
  }
  const xL = -(w / 2 + e);
  const xR = w / 2 + e;
  const half = w / 2;
  const zFront = zF - e;
  const zRear = zR + e;
  // Corners as seen from outside: top-left, top-right, bottom-right, bottom-left.
  const corners: Record<AtlasFace, readonly [Corner, Corner, Corner, Corner]> = {
    // Seen from -X: screen right = +Z (rear).
    left: [[xL, yTop, zF], [xL, yTop, zR], [xL, yBottom, zR], [xL, yBottom, zF]],
    // Seen from +X: screen right = -Z (front).
    right: [[xR, yTop, zR], [xR, yTop, zF], [xR, yBottom, zF], [xR, yBottom, zR]],
    // Seen from above, front at the top: screen right = +X.
    hood: [[-half, hoodY, zF], [half, hoodY, zF], [half, hoodY, hoodZ1], [-half, hoodY, hoodZ1]],
    roof: [[-roofHalf, roofY, roofZ0], [roofHalf, roofY, roofZ0], [roofHalf, roofY, roofZ1], [-roofHalf, roofY, roofZ1]],
    // Seen from ahead: screen right = -X.
    front: [[half, yTop, zFront], [-half, yTop, zFront], [-half, yBottom, zFront], [half, yBottom, zFront]],
    // Seen from behind: screen right = +X.
    rear: [[-half, yTop, zRear], [half, yTop, zRear], [half, yBottom, zRear], [-half, yBottom, zRear]],
  };

  const positions = new Float32Array(SHELL_FACES.length * 12);
  const uvs = new Float32Array(SHELL_FACES.length * 8);
  const indices = new Uint16Array(SHELL_FACES.length * 6);
  SHELL_FACES.forEach((face, f) => {
    const [rx, ry, rw, rh] = SHELL_ATLAS.regions[face];
    const pixels = [rx, ry, rx + rw, ry, rx + rw, ry + rh, rx, ry + rh];
    const quad = corners[face];
    for (let v = 0; v < 4; v++) {
      const corner = quad[v] as Corner;
      positions[f * 12 + v * 3] = corner[0];
      positions[f * 12 + v * 3 + 1] = corner[1];
      positions[f * 12 + v * 3 + 2] = corner[2];
      uvs[f * 8 + v * 2] = (pixels[v * 2] ?? 0) / SHELL_ATLAS.width;
      uvs[f * 8 + v * 2 + 1] = 1 - (pixels[v * 2 + 1] ?? 0) / SHELL_ATLAS.height;
    }
    const b = f * 4;
    indices.set([b, b + 3, b + 2, b, b + 2, b + 1], f * 6);
  });
  return { positions, uvs, indices };
}
