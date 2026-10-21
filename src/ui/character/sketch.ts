/**
 * Front orthographic sketch of the standing figure (Phase 7 §12.2): the body parts and the outfit's accessory boxes as
 * coloured rectangles in metres, y up, x from the viewer's left (the figure's right arm is on the left, as seen from
 * the front). The proportions mirror `PeopleRenderer` (1.75 m reference figure scaled by height, build, shoulders and
 * hips); keep both in step. Pure: no DOM.
 */
import { ATTACH, type AccessoryBox, type AttachId, type OutfitDef } from '../../uniform/types';
import type { FigureAppearance } from '../../uniform/appearance';

export interface SketchRect {
  /** Left edge, metres (viewer's left is negative). */
  x: number;
  /** Bottom edge, metres above the feet. */
  y: number;
  w: number;
  h: number;
  /** 0xRRGGBB. */
  color: number;
  /** The `ATTACH` frame of an accessory box, null for a body part. */
  attach: AttachId | null;
}

// Proportions of the reference figure (see peopleRenderer.ts).
const HIP_HEIGHT = 0.85;
const TORSO_HEIGHT = 0.58;
const SHOULDER_HEIGHT = 0.55;
const SHOULDER_X = 0.265;
const HIP_X = 0.09;
const ARM_LENGTH = 0.6;
const LEG_SEGMENT = 0.425;
const HEAD_GAP = 0.02;
const REFERENCE_HEIGHT = 1.75;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.6;
const NO_HAIR = 0xffffffff;

/** Total height of the sketch at the tallest figure (head + hat) in metres: the drawing's vertical extent. */
export const SKETCH_HEIGHT_M = 2.3;
/** Half-width of the sketch in metres. */
export const SKETCH_HALF_WIDTH_M = 0.6;

const clampScale = (v: number): number => (v < MIN_SCALE ? MIN_SCALE : v > MAX_SCALE ? MAX_SCALE : v);

interface Frame {
  px: number;
  py: number;
  sx: number;
}

/**
 * The sketch rectangles, back to front: legs, torso, arms, head, hair, then the accessory boxes sorted by depth
 * (farther first). A mirrored view: `x` is minus the figure frame's x.
 */
export function figureSketchRects(app: FigureAppearance, outfit: OutfitDef): SketchRect[] {
  const s = clampScale(app.height > 0 ? app.height / REFERENCE_HEIGHT : 1);
  const w = s * clampScale(app.build > 0 ? app.build : 1);
  const sh = app.shoulders > 0 ? clampScale(app.shoulders) : 1;
  const hp = app.hips > 0 ? clampScale(app.hips) : 1;
  const rects: SketchRect[] = [];
  const part = (cx: number, y0: number, width: number, height: number, color: number): void => {
    rects.push({ x: -cx - width / 2, y: y0, w: width, h: height, color, attach: null });
  };

  const hipY = HIP_HEIGHT * s;
  const kneeY = hipY - LEG_SEGMENT * s;
  const shoulderY = hipY + SHOULDER_HEIGHT * s;
  const neckY = hipY + TORSO_HEIGHT * s;
  for (const side of [-1, 1]) {
    const hx = side * HIP_X * w * hp;
    part(hx, kneeY, 0.15 * w * hp, LEG_SEGMENT * s, app.bottom);
    part(hx, 0, 0.15 * w * hp, LEG_SEGMENT * s, app.shins);
  }
  part(0, hipY, 0.42 * w * sh, TORSO_HEIGHT * s, app.top);
  for (const side of [-1, 1]) part(side * SHOULDER_X * w * sh, shoulderY - ARM_LENGTH * s, 0.11 * w * sh, ARM_LENGTH * s, app.top);
  part(0, neckY + HEAD_GAP * s, 0.22 * w, 0.24 * s, app.skin);
  if (app.hair !== NO_HAIR) part(0, neckY + (HEAD_GAP + 0.25 - 0.04) * s, 0.24 * w, 0.08 * s, app.hair);

  const frames: Record<AttachId, Frame> = {
    [ATTACH.torso]: { px: 0, py: hipY, sx: w * sh },
    [ATTACH.head]: { px: 0, py: neckY, sx: w },
    [ATTACH.leftArm]: { px: -SHOULDER_X * w * sh, py: shoulderY, sx: w * sh },
    [ATTACH.rightArm]: { px: SHOULDER_X * w * sh, py: shoulderY, sx: w * sh },
    [ATTACH.pelvis]: { px: 0, py: hipY, sx: w * hp },
    [ATTACH.leftThigh]: { px: -HIP_X * w * hp, py: hipY, sx: w * hp },
    [ATTACH.rightThigh]: { px: HIP_X * w * hp, py: hipY, sx: w * hp },
    [ATTACH.leftShin]: { px: -HIP_X * w * hp, py: kneeY, sx: w * hp },
    [ATTACH.rightShin]: { px: HIP_X * w * hp, py: kneeY, sx: w * hp },
  };
  const ordered: { box: AccessoryBox; i: number }[] = outfit.boxes.map((box, i) => ({ box, i }));
  // Farther boxes (larger z, behind the figure) first; the original order breaks ties.
  ordered.sort((a, b) => b.box.z - a.box.z || a.i - b.i);
  for (const { box } of ordered) {
    const f = frames[box.attach];
    const cx = f.px + box.x * f.sx;
    const cy = f.py + box.y * s;
    const width = box.sx * f.sx;
    const height = box.sy * s;
    rects.push({ x: -cx - width / 2, y: cy - height / 2, w: width, h: height, color: box.color, attach: box.attach });
  }
  return rects;
}
