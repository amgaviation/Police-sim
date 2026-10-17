import type { City, PoiKind } from '../../world/city';
import { ROAD_CLASS } from '../../world/ids';
import type { RoadEdge } from '../../world/roadGraph';
import { worldToMap, type MapPoint } from './format';
import { PRIORITY_COLORS } from './police';

/** Canvas size in CSS pixels (square). */
export const MINIMAP_SIZE = 200;
/** Zoom levels: metres from the centre to the edge of the map. */
export const MINIMAP_RADII = [250, 500, 1000] as const;
/** Redraw rate cap (redraws per second). */
export const MINIMAP_HZ = 10;

export interface TrafficDots {
  count: number;
  x: Float32Array;
  z: Float32Array;
}

const HALF = MINIMAP_SIZE / 2;

/** Marker kinds for `MinimapMarkers.kind` (design §13.3). */
export const MARKER = {
  callP1: 1,
  callP2: 2,
  callP3: 3,
  callP4: 4,
  unitAvailable: 5,
  unitBusy: 6,
  unitEmergency: 7,
  stop: 8,
} as const;
export type MarkerKind = (typeof MARKER)[keyof typeof MARKER];

/** Call, unit and stop markers (world x/z); the integrator reuses one set of arrays. */
export interface MinimapMarkers {
  count: number;
  x: Float32Array;
  z: Float32Array;
  kind: Uint8Array;
}

/** Preallocated marker arrays for up to `capacity` markers. */
export function createMinimapMarkers(capacity: number): MinimapMarkers {
  const n = Math.max(0, Math.floor(capacity));
  return { count: 0, x: new Float32Array(n), z: new Float32Array(n), kind: new Uint8Array(n) };
}

/** Distance (px) from the map centre at which off-map call markers sit on the rim. */
export const MARKER_RIM = HALF - 7;

export interface MarkerPoint extends MapPoint {
  /** True when the point was pulled in to the rim. */
  clamped: boolean;
}

/**
 * `worldToMap` with off-map points clamped to a circle of `rimPx` pixels around the centre
 * (direction kept). Pass `Infinity` to never clamp. Allocation-free; returns `out`.
 */
export function markerProjection(
  px: number,
  pz: number,
  yaw: number,
  wx: number,
  wz: number,
  metersPerPixel: number,
  rimPx: number,
  out: MarkerPoint,
): MarkerPoint {
  worldToMap(px, pz, yaw, wx, wz, metersPerPixel, out);
  const d = Math.hypot(out.x, out.y);
  if (d > rimPx && d > 0) {
    const k = rimPx / d;
    out.x *= k;
    out.y *= k;
    out.clamped = true;
  } else {
    out.clamped = false;
  }
  return out;
}

const UNIT_FILL = '#4f8cff';
const UNIT_BUSY_FILL = '#2a4f8f';
const EMERGENCY_OUTLINE = '#ff3b3b';

/** Road colour and minimum stroke width (px) per `ROAD_CLASS` id, drawn minor classes first. */
const ROAD_STYLE: readonly { readonly color: string; readonly minWidth: number }[] = [
  { color: '#e6c867', minWidth: 3.5 }, // highway
  { color: '#e8e8e8', minWidth: 3 }, // arterial
  { color: '#c9c9c9', minWidth: 2.5 }, // collector
  { color: '#9a9a9a', minWidth: 1.5 }, // local
  { color: '#b0a58a', minWidth: 2 }, // county
  { color: '#8c7a5c', minWidth: 1.5 }, // gravel
  { color: '#7d7d7d', minWidth: 1 }, // service
];
const DRAW_ORDER = [
  ROAD_CLASS.service, ROAD_CLASS.gravel, ROAD_CLASS.local, ROAD_CLASS.county,
  ROAD_CLASS.collector, ROAD_CLASS.arterial, ROAD_CLASS.highway,
] as const;

const POI_COLOR: Record<PoiKind, string> = {
  station: '#4f8cff',
  hospital: '#ff5a5a',
  campus: '#b07cff',
  airport: '#9ad0ff',
  harbor: '#47c2c2',
  school: '#f5d63d',
  fuel: '#ff9f40',
  park: '#5fbf5f',
};

const ROOT_STYLE = [
  'position:absolute',
  'left:16px',
  'bottom:16px',
  `width:${String(MINIMAP_SIZE)}px`,
  `height:${String(MINIMAP_SIZE)}px`,
  'border-radius:50%',
  'box-shadow:0 0 0 2px rgba(255,255,255,0.35), 0 2px 8px rgba(0,0,0,0.5)',
  'pointer-events:none',
  'z-index:900',
].join(';');

/**
 * Heading-up circular minimap (canvas 2D): roads near the player by class, the active
 * route, POI markers, traffic dots, call/unit/stop markers and the player arrow. Redraws at most `MINIMAP_HZ`
 * times per second with reused scratch objects; headless (no `document`) it is a no-op.
 */
export class Minimap {
  private readonly city: City;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly edges: number[] = [];
  private readonly p: MapPoint = { x: 0, y: 0 };
  private readonly mp: MarkerPoint = { x: 0, y: 0, clamped: false };
  private zoom = 0;
  private lastDraw = -Infinity;
  private drawCount = 0;

  constructor(parent: HTMLElement, city: City) {
    this.city = city;
    if (typeof document === 'undefined') {
      this.canvas = null;
      this.ctx = null;
      return;
    }
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const canvas = document.createElement('canvas');
    canvas.id = 'minimap';
    canvas.width = Math.round(MINIMAP_SIZE * dpr);
    canvas.height = Math.round(MINIMAP_SIZE * dpr);
    canvas.setAttribute('style', ROOT_STYLE);
    parent.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx?.scale(dpr, dpr);
  }

  /** Current zoom radius (m from the centre to the edge). */
  get radius(): number {
    return MINIMAP_RADII[this.zoom] ?? MINIMAP_RADII[0];
  }

  /** Throttled redraws so far (tests and diagnostics). */
  get redraws(): number {
    return this.drawCount;
  }

  /** Cycles 250 -> 500 -> 1000 m and redraws on the next update. */
  toggleZoom(): void {
    this.zoom = (this.zoom + 1) % MINIMAP_RADII.length;
    this.lastDraw = -Infinity;
  }

  update(
    x: number,
    z: number,
    yaw: number,
    traffic: TrafficDots | null,
    route: Float32Array | null,
    nowMs: number,
    markers: MinimapMarkers | null = null,
  ): void {
    if (nowMs - this.lastDraw < 1000 / MINIMAP_HZ) return;
    this.lastDraw = nowMs;
    this.drawCount += 1;
    const ctx = this.ctx;
    if (!ctx) return;

    const radius = this.radius;
    const mpp = radius / HALF;
    ctx.save();
    ctx.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
    ctx.beginPath();
    ctx.arc(HALF, HALF, HALF, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(20,24,28,0.82)';
    ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

    this.drawRoads(ctx, x, z, yaw, radius, mpp);
    if (route) this.drawRoute(ctx, x, z, yaw, route, mpp);
    this.drawPois(ctx, x, z, yaw, radius, mpp);
    if (traffic) this.drawTraffic(ctx, x, z, yaw, traffic, radius, mpp);
    if (markers && markers.count > 0) this.drawMarkers(ctx, x, z, yaw, markers, mpp);
    this.drawPlayer(ctx);
    this.drawNorth(ctx, x, z, yaw, mpp);
    ctx.restore();
  }

  dispose(): void {
    this.canvas?.remove();
  }

  private drawRoads(ctx: CanvasRenderingContext2D, x: number, z: number, yaw: number, radius: number, mpp: number): void {
    const graph = this.city.graph;
    // The map is clipped to a circle, so `radius` covers everything visible.
    graph.edgesNear(x, z, radius, this.edges);
    const p = this.p;
    ctx.lineCap = 'round';
    for (const cls of DRAW_ORDER) {
      const style = ROAD_STYLE[cls];
      if (!style) continue;
      let width = 0;
      ctx.beginPath();
      for (const id of this.edges) {
        const e = graph.edges[id] as RoadEdge;
        if (e.roadClass !== cls) continue;
        width = Math.max(width, e.width / mpp);
        const pts = e.points;
        for (let k = 0; k + 1 < pts.length; k += 2) {
          worldToMap(x, z, yaw, pts[k] ?? 0, pts[k + 1] ?? 0, mpp, p);
          if (k === 0) ctx.moveTo(HALF + p.x, HALF + p.y);
          else ctx.lineTo(HALF + p.x, HALF + p.y);
        }
      }
      if (width === 0) continue;
      ctx.strokeStyle = style.color;
      ctx.lineWidth = Math.max(style.minWidth, width);
      ctx.stroke();
    }
  }

  private drawRoute(ctx: CanvasRenderingContext2D, x: number, z: number, yaw: number, route: Float32Array, mpp: number): void {
    const p = this.p;
    ctx.beginPath();
    for (let k = 0; k + 1 < route.length; k += 2) {
      worldToMap(x, z, yaw, route[k] ?? 0, route[k + 1] ?? 0, mpp, p);
      if (k === 0) ctx.moveTo(HALF + p.x, HALF + p.y);
      else ctx.lineTo(HALF + p.x, HALF + p.y);
    }
    ctx.strokeStyle = '#3fa9ff';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  private drawPois(ctx: CanvasRenderingContext2D, x: number, z: number, yaw: number, radius: number, mpp: number): void {
    const p = this.p;
    const r2 = radius * radius;
    for (const poi of this.city.pois) {
      const dx = poi.x - x;
      const dz = poi.z - z;
      if (dx * dx + dz * dz > r2) continue;
      worldToMap(x, z, yaw, poi.x, poi.z, mpp, p);
      ctx.fillStyle = POI_COLOR[poi.kind];
      ctx.fillRect(HALF + p.x - 4, HALF + p.y - 4, 8, 8);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1;
      ctx.strokeRect(HALF + p.x - 4, HALF + p.y - 4, 8, 8);
    }
  }

  private drawTraffic(ctx: CanvasRenderingContext2D, x: number, z: number, yaw: number, t: TrafficDots, radius: number, mpp: number): void {
    const p = this.p;
    const r2 = radius * radius;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < t.count; i++) {
      const tx = t.x[i] ?? 0;
      const tz = t.z[i] ?? 0;
      const dx = tx - x;
      const dz = tz - z;
      if (dx * dx + dz * dz > r2) continue;
      worldToMap(x, z, yaw, tx, tz, mpp, p);
      ctx.fillRect(HALF + p.x - 1.5, HALF + p.y - 1.5, 3, 3);
    }
  }

  /**
   * Units (blue squares, busy darker, emergency with a red outline) and the stop (white ring)
   * when on the map, then calls (diamonds by priority, P1 on top) with off-map calls on the rim.
   */
  private drawMarkers(ctx: CanvasRenderingContext2D, x: number, z: number, yaw: number, m: MinimapMarkers, mpp: number): void {
    const p = this.mp;
    const n = Math.min(m.count, m.x.length, m.z.length, m.kind.length);
    ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      const kind = m.kind[i] ?? 0;
      if (kind < MARKER.unitAvailable || kind > MARKER.stop) continue;
      markerProjection(x, z, yaw, m.x[i] ?? 0, m.z[i] ?? 0, mpp, HALF + 4, p);
      if (p.clamped) continue;
      const cx = HALF + p.x;
      const cy = HALF + p.y;
      if (kind === MARKER.stop) {
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1.5;
        continue;
      }
      ctx.fillStyle = kind === MARKER.unitBusy ? UNIT_BUSY_FILL : UNIT_FILL;
      ctx.fillRect(cx - 3.5, cy - 3.5, 7, 7);
      ctx.strokeStyle = kind === MARKER.unitEmergency ? EMERGENCY_OUTLINE : '#111';
      ctx.lineWidth = kind === MARKER.unitEmergency ? 2 : 1;
      ctx.strokeRect(cx - 3.5, cy - 3.5, 7, 7);
    }
    // Calls, lowest priority first so P1 is drawn on top.
    for (let kind: number = MARKER.callP4; kind >= MARKER.callP1; kind--) {
      ctx.fillStyle = PRIORITY_COLORS[kind - 1] ?? PRIORITY_COLORS[3];
      for (let i = 0; i < n; i++) {
        if (m.kind[i] !== kind) continue;
        markerProjection(x, z, yaw, m.x[i] ?? 0, m.z[i] ?? 0, mpp, MARKER_RIM, p);
        const cx = HALF + p.x;
        const cy = HALF + p.y;
        const r = p.clamped ? 4.5 : 6;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r, cy);
        ctx.lineTo(cx, cy + r);
        ctx.lineTo(cx - r, cy);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  private drawPlayer(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.moveTo(HALF, HALF - 8);
    ctx.lineTo(HALF + 6, HALF + 6);
    ctx.lineTo(HALF, HALF + 3);
    ctx.lineTo(HALF - 6, HALF + 6);
    ctx.closePath();
    ctx.fillStyle = '#4f8cff';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** "N" on the rim in the direction of north (-Z). */
  private drawNorth(ctx: CanvasRenderingContext2D, x: number, z: number, yaw: number, mpp: number): void {
    const p = worldToMap(x, z, yaw, x, z - 1, mpp, this.p);
    const len = Math.hypot(p.x, p.y) || 1;
    const nx = HALF + (p.x / len) * (HALF - 10);
    const ny = HALF + (p.y / len) * (HALF - 10);
    ctx.font = 'bold 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff6b6b';
    ctx.fillText('N', nx, ny);
  }
}
