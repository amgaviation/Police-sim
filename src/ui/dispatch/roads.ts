/**
 * Road layer cache for the console map and the scenario editor (design 12.1 / 12.2): the roads of a `RoadGraph` are
 * drawn once to an offscreen canvas that covers twice the viewport at the current zoom, and are redrawn only when the
 * zoom changes or the view leaves the cached window. The window maths is pure; drawing needs a DOM and is skipped
 * without one.
 */
import type { RoadGraph } from '../../world/roadGraph';
import { ROAD_CLASS } from '../../world/ids';
import { worldToMap, type MapPoint, type MapView } from '../mdt/map';

/** A cached rectangle of the world: `x0` / `z0` is the world position of the canvas top-left, `scale` px per metre. */
export interface RoadWindow {
  x0: number;
  z0: number;
  width: number;
  height: number;
  scale: number;
}

/** Largest side of the offscreen canvas in px. */
export const ROAD_WINDOW_MAX_PX = 2048;

/** Neutral road colours (not status colours) and minimum stroke widths by `ROAD_CLASS`. */
const ROAD_STYLE: readonly { readonly color: string; readonly minWidth: number }[] = [
  { color: '#b39a4a', minWidth: 2 },
  { color: '#8a96a3', minWidth: 1.6 },
  { color: '#6f7a86', minWidth: 1.2 },
  { color: '#4e5862', minWidth: 0.8 },
  { color: '#7d7462', minWidth: 1 },
  { color: '#5f5444', minWidth: 0.8 },
  { color: '#454c53', minWidth: 0.6 },
];
const DRAW_ORDER = [
  ROAD_CLASS.service, ROAD_CLASS.gravel, ROAD_CLASS.local, ROAD_CLASS.county,
  ROAD_CLASS.collector, ROAD_CLASS.arterial, ROAD_CLASS.highway,
] as const;

/** The window to cache for `view`: the viewport doubled around its centre, each side capped at `maxPx`. */
export function windowFor(view: Readonly<MapView>, maxPx = ROAD_WINDOW_MAX_PX): RoadWindow {
  const width = Math.max(1, Math.min(maxPx, Math.ceil(view.width * 2)));
  const height = Math.max(1, Math.min(maxPx, Math.ceil(view.height * 2)));
  return {
    x0: view.cx - width / 2 / view.scale,
    z0: view.cz - height / 2 / view.scale,
    width,
    height,
    scale: view.scale,
  };
}

/** True when the cached window shows the whole viewport at the view's zoom. */
export function windowCovers(win: Readonly<RoadWindow>, view: Readonly<MapView>): boolean {
  if (Math.abs(win.scale - view.scale) > 1e-9) return false;
  const left = view.cx - view.width / 2 / view.scale;
  const top = view.cz - view.height / 2 / view.scale;
  const right = view.cx + view.width / 2 / view.scale;
  const bottom = view.cz + view.height / 2 / view.scale;
  return left >= win.x0 && top >= win.z0 && right <= win.x0 + win.width / win.scale && bottom <= win.z0 + win.height / win.scale;
}

/** Screen position (px) of the cached canvas top-left in `view`. */
export function windowOffset(win: Readonly<RoadWindow>, view: Readonly<MapView>, out: MapPoint): MapPoint {
  out.x = view.width / 2 + (win.x0 - view.cx) * view.scale;
  out.y = view.height / 2 + (win.z0 - view.cz) * view.scale;
  return out;
}

export class RoadCache {
  private readonly graph: RoadGraph;
  private readonly maxPx: number;
  private canvas: HTMLCanvasElement | null = null;
  private win: RoadWindow | null = null;
  private drawn = 0;

  constructor(graph: RoadGraph, maxPx = ROAD_WINDOW_MAX_PX) {
    this.graph = graph;
    this.maxPx = maxPx;
  }

  /** Times the roads were drawn (tests and diagnostics). */
  get builds(): number {
    return this.drawn;
  }

  /** Forgets the cached window (the next `ensure` redraws). */
  invalidate(): void {
    this.win = null;
  }

  /** The cached window covering `view` (redrawn when needed); null without a DOM or a 2D context. */
  ensure(view: Readonly<MapView>): { canvas: HTMLCanvasElement; win: RoadWindow } | null {
    if (typeof document === 'undefined') return null;
    if (this.canvas !== null && this.win !== null && windowCovers(this.win, view)) return { canvas: this.canvas, win: this.win };
    const win = windowFor(view, this.maxPx);
    const canvas = this.canvas ?? document.createElement('canvas');
    canvas.width = win.width;
    canvas.height = win.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, win.width, win.height);
    this.draw(ctx, win);
    this.canvas = canvas;
    this.win = win;
    this.drawn++;
    return { canvas, win };
  }

  private draw(ctx: CanvasRenderingContext2D, win: Readonly<RoadWindow>): void {
    const local: MapView = { cx: win.x0 + win.width / 2 / win.scale, cz: win.z0 + win.height / 2 / win.scale, scale: win.scale, width: win.width, height: win.height };
    const x1 = win.x0 + win.width / win.scale;
    const z1 = win.z0 + win.height / win.scale;
    const p: MapPoint = { x: 0, y: 0 };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const visible: number[] = [];
    for (const e of this.graph.edges) {
      const pts = e.points;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let k = 0; k + 1 < pts.length; k += 2) {
        const x = pts[k] ?? 0;
        const z = pts[k + 1] ?? 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      if (maxX >= win.x0 && minX <= x1 && maxZ >= win.z0 && minZ <= z1) visible.push(e.id);
    }
    for (const cls of DRAW_ORDER) {
      const style = ROAD_STYLE[cls];
      if (!style) continue;
      let width = 0;
      ctx.beginPath();
      for (const id of visible) {
        const e = this.graph.edges[id];
        if (!e || e.roadClass !== cls) continue;
        width = Math.max(width, e.width * win.scale);
        const pts = e.points;
        for (let k = 0; k + 1 < pts.length; k += 2) {
          worldToMap(local, pts[k] ?? 0, pts[k + 1] ?? 0, p);
          if (k === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
      }
      if (width === 0) continue;
      ctx.strokeStyle = style.color;
      ctx.lineWidth = Math.max(style.minWidth, width);
      ctx.stroke();
    }
  }
}
