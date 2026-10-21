/** Procedural decal outlines (Phase 7 §6.4). Pure: closed polygons as flat x,y pairs in [-1, 1], y down. */
import type { ShapeKind } from './types';

export interface ShapeOptions {
  /** `star` only; int 3..12, default 5. */
  starPoints?: number;
  /** `polygon` only: passed through unchanged. */
  points?: readonly (readonly [number, number])[];
  /** `circle` / `ellipse` only; default 32. */
  segments?: number;
}

const ROUND_RADIUS = 0.25;
const ROUND_SEGMENTS = 4;
const STAR_INNER = 0.45;
const SHIELD_CURVE_POINTS = 6;
const ARCH_INNER = 0.55;
const ARCH_SEGMENTS = 12;

function arc(out: number[], cx: number, cy: number, r: number, from: number, to: number, segments: number): void {
  for (let i = 0; i <= segments; i++) {
    const a = from + ((to - from) * i) / segments;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

/** `count` interior points of the quadratic curve p0 -> c -> p1 (t = k / (count + 1)). */
function curve(out: number[], x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, count: number): void {
  for (let k = 1; k <= count; k++) {
    const t = k / (count + 1);
    const m = 1 - t;
    out.push(m * m * x0 + 2 * m * t * cx + t * t * x1, m * m * y0 + 2 * m * t * cy + t * t * y1);
  }
}

/** Closed polygon of `kind` as flat x,y pairs in [-1, 1] (y down), written into `out` (cleared first) and returned. */
export function shapePolygon(kind: ShapeKind, opts: ShapeOptions, out: number[]): number[] {
  out.length = 0;
  switch (kind) {
    case 'rect':
      out.push(-1, -1, 1, -1, 1, 1, -1, 1);
      break;
    case 'roundedRect': {
      const c = 1 - ROUND_RADIUS;
      const q = Math.PI / 2;
      arc(out, -c, -c, ROUND_RADIUS, 2 * q, 3 * q, ROUND_SEGMENTS);
      arc(out, c, -c, ROUND_RADIUS, 3 * q, 4 * q, ROUND_SEGMENTS);
      arc(out, c, c, ROUND_RADIUS, 0, q, ROUND_SEGMENTS);
      arc(out, -c, c, ROUND_RADIUS, q, 2 * q, ROUND_SEGMENTS);
      break;
    }
    case 'circle':
    case 'ellipse': {
      const n = Math.max(3, Math.floor(opts.segments ?? 32));
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n;
        out.push(Math.cos(a), Math.sin(a));
      }
      break;
    }
    case 'star': {
      const n = Math.min(12, Math.max(3, Math.floor(opts.starPoints ?? 5)));
      for (let i = 0; i < 2 * n; i++) {
        const r = i % 2 === 0 ? 1 : STAR_INNER;
        const a = -Math.PI / 2 + (i * Math.PI) / n;
        out.push(r * Math.cos(a), r * Math.sin(a));
      }
      break;
    }
    case 'shield':
      out.push(-1, -1, 1, -1, 1, 0.2);
      curve(out, 1, 0.2, 1, 0.85, 0, 1, SHIELD_CURVE_POINTS);
      out.push(0, 1);
      curve(out, 0, 1, -1, 0.85, -1, 0.2, SHIELD_CURVE_POINTS);
      out.push(-1, 0.2);
      break;
    case 'chevron':
      out.push(0, -1, 1, 0, 1, 0.45, 0, -0.55, -1, 0.45, -1, 0);
      break;
    case 'triangle':
      out.push(0, -1, 1, 1, -1, 1);
      break;
    case 'arch':
      arc(out, 0, 0, 1, Math.PI, 2 * Math.PI, ARCH_SEGMENTS);
      arc(out, 0, 0, ARCH_INNER, 2 * Math.PI, Math.PI, ARCH_SEGMENTS);
      break;
    case 'polygon':
      for (const p of opts.points ?? []) out.push(p[0], p[1]);
      break;
  }
  return out;
}
