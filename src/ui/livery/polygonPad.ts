/**
 * The polygon pad (Phase 7 §12.1): a 200x200 canvas where a click adds a point (up to 24), a drag moves one and a
 * right-click deletes one; the points are emitted in [-1, 1] (y down, the `shapePolygon` convention). The point
 * maths are pure and exported; `PolygonPad` adds the canvas and keeps working headless (no document).
 */
import { LIVERY_LIMITS } from '../../livery/types';

export type PadPoint = [number, number];

/** Canvas size in pixels. */
export const PAD_SIZE = 200;
/** Most points a polygon may hold (the livery schema limit). */
export const PAD_MAX_POINTS = LIVERY_LIMITS.polygonPoints;
/** A pointer within this many pixels of a point grabs it. */
export const PAD_PICK_PX = 9;

const round3 = (v: number): number => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

/** Canvas pixel -> point in [-1, 1] (clamped, 3 decimals). */
export function padToUnit(px: number, py: number, size = PAD_SIZE): PadPoint {
  const f = (v: number): number => round3(Math.min(1, Math.max(-1, (v / size) * 2 - 1)));
  return [f(px), f(py)];
}

/** Point in [-1, 1] -> canvas pixel. */
export function unitToPad(p: Readonly<PadPoint>, size = PAD_SIZE): PadPoint {
  return [((p[0] + 1) / 2) * size, ((p[1] + 1) / 2) * size];
}

/** Index of the point nearest to the pixel within `radius`, -1 when none. */
export function pickPoint(points: readonly PadPoint[], px: number, py: number, size = PAD_SIZE, radius = PAD_PICK_PX): number {
  let best = -1;
  let bestD = radius * radius;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = unitToPad(points[i] as PadPoint, size);
    const d = (x - px) * (x - px) + (y - py) * (y - py);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** A copy with `p` appended; unchanged (still a copy) at `max` points. */
export function addPoint(points: readonly PadPoint[], p: Readonly<PadPoint>, max = PAD_MAX_POINTS): PadPoint[] {
  const out = points.map((q): PadPoint => [q[0], q[1]]);
  if (out.length < max) out.push([p[0], p[1]]);
  return out;
}

/** A copy with point `i` replaced; unchanged for an index out of range. */
export function movePoint(points: readonly PadPoint[], i: number, p: Readonly<PadPoint>): PadPoint[] {
  const out = points.map((q): PadPoint => [q[0], q[1]]);
  if (i >= 0 && i < out.length) out[i] = [p[0], p[1]];
  return out;
}

/** A copy without point `i`; unchanged when that would leave fewer than `minPoints`. */
export function removePoint(points: readonly PadPoint[], i: number, minPoints = 0): PadPoint[] {
  const out = points.map((q): PadPoint => [q[0], q[1]]);
  if (i >= 0 && i < out.length && out.length > minPoints) out.splice(i, 1);
  return out;
}

/** A diamond: the points a freshly chosen `polygon` shape starts with. */
export function defaultPolygon(): PadPoint[] {
  return [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
}

export interface PolygonPadOptions {
  points: readonly PadPoint[];
  /** Deleting never goes below this many points (default 0). */
  minPoints?: number;
  size?: number;
  /** Called after a point was added or moved (when the pointer is released) and after a delete. */
  onChange: (points: PadPoint[]) => void;
}

const HEADLESS_ELEMENT = {} as HTMLElement;

/**
 * Pointer logic lives in `down` / `move` / `up` (pixel coordinates) so it runs and is testable headless; the canvas
 * only forwards pointer events to them and redraws.
 */
export class PolygonPad {
  readonly element: HTMLElement;
  private readonly size: number;
  private readonly minPoints: number;
  private readonly onChange: (points: PadPoint[]) => void;
  private pts: PadPoint[];
  private dragging = -1;
  private changed = false;
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(opts: PolygonPadOptions) {
    this.size = opts.size ?? PAD_SIZE;
    this.minPoints = opts.minPoints ?? 0;
    this.onChange = opts.onChange;
    this.pts = opts.points.map((p): PadPoint => [p[0], p[1]]);
    if (typeof document === 'undefined') {
      this.element = HEADLESS_ELEMENT;
      this.ctx = null;
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = this.size;
    canvas.height = this.size;
    canvas.className = 'livery-pad';
    canvas.setAttribute('aria-label', 'Polygon pad: click to add a point, drag to move, right-click to delete');
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      const [x, y] = this.local(canvas, e);
      canvas.setPointerCapture?.(e.pointerId);
      this.down(x, y, 0);
    });
    canvas.addEventListener('pointermove', (e) => {
      const [x, y] = this.local(canvas, e);
      this.move(x, y);
    });
    canvas.addEventListener('pointerup', () => this.up());
    canvas.addEventListener('pointercancel', () => this.up());
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [x, y] = this.local(canvas, e);
      this.down(x, y, 2);
    });
    this.element = canvas;
    this.ctx = canvas.getContext('2d');
    this.draw();
  }

  get points(): readonly PadPoint[] {
    return this.pts;
  }

  /** Replaces the points (e.g. after the document changed); ignored while a point is being dragged. */
  setPoints(points: readonly PadPoint[]): void {
    if (this.dragging >= 0) return;
    this.pts = points.map((p): PadPoint => [p[0], p[1]]);
    this.draw();
  }

  /** Button 0: grab the point under the pointer or add one there (and grab it). Button 2: delete the point under it. */
  down(px: number, py: number, button: 0 | 2): void {
    const hit = pickPoint(this.pts, px, py, this.size);
    if (button === 2) {
      if (hit < 0) return;
      const next = removePoint(this.pts, hit, this.minPoints);
      if (next.length === this.pts.length) return;
      this.pts = next;
      this.draw();
      this.onChange(this.copy());
      return;
    }
    if (hit >= 0) {
      this.dragging = hit;
    } else {
      const before = this.pts.length;
      this.pts = addPoint(this.pts, padToUnit(px, py, this.size));
      if (this.pts.length === before) return;
      this.dragging = this.pts.length - 1;
      this.changed = true;
    }
    this.draw();
  }

  move(px: number, py: number): void {
    if (this.dragging < 0) return;
    this.pts = movePoint(this.pts, this.dragging, padToUnit(px, py, this.size));
    this.changed = true;
    this.draw();
  }

  up(): void {
    if (this.dragging < 0) return;
    this.dragging = -1;
    if (this.changed) {
      this.changed = false;
      this.onChange(this.copy());
    }
  }

  private copy(): PadPoint[] {
    return this.pts.map((p): PadPoint => [p[0], p[1]]);
  }

  private local(canvas: HTMLCanvasElement, e: MouseEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    const sx = r.width > 0 ? this.size / r.width : 1;
    const sy = r.height > 0 ? this.size / r.height : 1;
    return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
  }

  private draw(): void {
    const c = this.ctx;
    if (!c) return;
    const s = this.size;
    c.clearRect(0, 0, s, s);
    c.fillStyle = '#0d141b';
    c.fillRect(0, 0, s, s);
    c.strokeStyle = '#2a3a4a';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(s / 2, 0);
    c.lineTo(s / 2, s);
    c.moveTo(0, s / 2);
    c.lineTo(s, s / 2);
    c.stroke();
    if (this.pts.length > 0) {
      c.beginPath();
      this.pts.forEach((p, i) => {
        const [x, y] = unitToPad(p, s);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      });
      if (this.pts.length >= 3) {
        c.closePath();
        c.fillStyle = 'rgba(59, 158, 255, 0.25)';
        c.fill();
      }
      c.strokeStyle = '#3b9eff';
      c.lineWidth = 2;
      c.stroke();
    }
    c.fillStyle = '#f2f2f2';
    for (const p of this.pts) {
      const [x, y] = unitToPad(p, s);
      c.beginPath();
      c.arc(x, y, 4, 0, Math.PI * 2);
      c.fill();
    }
  }
}
