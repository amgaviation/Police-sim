import { revision as paletteRevision, semanticColor, type SemanticColor } from '../../a11y/palette';
import type { City, PoiKind } from '../../world/city';
import { ROAD_CLASS } from '../../world/ids';
import type { RoadEdge } from '../../world/roadGraph';
import { worldToMap, type MapPoint } from './format';
import type { FloorPlan, RemoteUnit } from './types';

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
  // Phase 3: a suspect of the player's scene (red), any other person of it (white), a fleeing car or runner.
  suspect: 9,
  person: 10,
  pursuit: 11,
} as const;
export type MarkerKind = (typeof MARKER)[keyof typeof MARKER];

/** Call, unit, stop, suspect, person and pursuit markers (world x/z); the integrator reuses one set of arrays. */
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

/** Call priority P1..P4 -> semantic colour key (colour-vision safe, read at draw time). */
const PRIORITY_KEYS: readonly SemanticColor[] = ['p1', 'p2', 'p3', 'p4'];
/** Most co-op teammates drawn. */
export const MAX_REMOTE_UNITS = 8;

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

/** Fraction of the circle's diameter the floor plan may fill. */
const PLAN_FILL = 0.84;
const PLAN_ROOM_FILL = '#2b3640';
const PLAN_ROOM_STROKE = '#8fa3b5';
const PLAN_DOOR_OPEN = '#5fd35f';
const PLAN_DOOR_CLOSED = '#8a8a8a';

/** Placement of a floor plan on the map: pixels per metre and the world point at the map centre. */
export interface PlanFit {
  scale: number;
  centerX: number;
  centerZ: number;
}

/**
 * Scale that fits the plan's rectangle into the circular map (its diagonal inside `PLAN_FILL` of the diameter) and the
 * rectangle's centre. A degenerate rectangle gets scale 1. Allocation-free; returns `out`.
 */
export function fitFloorPlan(plan: Readonly<FloorPlan>, out: PlanFit): PlanFit {
  const r = plan.rect;
  const diagonal = Math.hypot(r.maxX - r.minX, r.maxZ - r.minZ);
  out.scale = diagonal > 0 ? (MINIMAP_SIZE * PLAN_FILL) / diagonal : 1;
  out.centerX = (r.minX + r.maxX) / 2;
  out.centerZ = (r.minZ + r.maxZ) / 2;
  return out;
}

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
  private plan: FloorPlan | null = null;
  private planX = 0;
  private planZ = 0;
  private readonly fit: PlanFit = { scale: 1, centerX: 0, centerZ: 0 };
  private lastDraw = -Infinity;
  private drawCount = 0;
  /** Palette revision the last draw used (a change forces a repaint). */
  private lastPaletteRev = -1;
  private remoteCount = 0;
  private readonly remoteX = new Float32Array(MAX_REMOTE_UNITS);
  private readonly remoteZ = new Float32Array(MAX_REMOTE_UNITS);
  private readonly remoteNames: string[] = new Array<string>(MAX_REMOTE_UNITS).fill('');

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

  /** The floor plan drawn instead of the city while set (null = city map), and the officer's position on it. */
  get floorPlan(): FloorPlan | null {
    return this.plan;
  }

  /**
   * Indoors the minimap shows the building: room rectangles and doors (open green, closed grey) scaled to fit, north
   * up, with the officer at (officerX, officerZ). `null` returns to the city map. Redraws on the next update.
   */
  setFloorPlan(plan: FloorPlan | null, officerX: number, officerZ: number): void {
    if (plan !== this.plan) {
      this.plan = plan;
      this.lastDraw = -Infinity;
      if (plan) fitFloorPlan(plan, this.fit);
    }
    this.planX = officerX;
    this.planZ = officerZ;
  }

  /**
   * Co-op teammates (up to `MAX_REMOTE_UNITS`): drawn as unit-coloured squares with their callsign. Copies into reused
   * arrays; null or [] clears them. Redraws on the next update.
   */
  setRemoteUnits(units: readonly RemoteUnit[] | null): void {
    const n = Math.min(units?.length ?? 0, MAX_REMOTE_UNITS);
    for (let i = 0; i < n; i++) {
      const u = units?.[i] as RemoteUnit;
      this.remoteX[i] = u.x;
      this.remoteZ[i] = u.z;
      this.remoteNames[i] = u.callsign;
    }
    this.remoteCount = n;
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
    const paletteRev = paletteRevision();
    if (paletteRev !== this.lastPaletteRev) {
      this.lastPaletteRev = paletteRev;
      this.lastDraw = -Infinity;
    }
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

    if (this.plan) {
      this.drawFloorPlan(ctx, this.plan, yaw);
      ctx.restore();
      return;
    }
    this.drawRoads(ctx, x, z, yaw, radius, mpp);
    if (route) this.drawRoute(ctx, x, z, yaw, route, mpp);
    this.drawPois(ctx, x, z, yaw, radius, mpp);
    if (traffic) this.drawTraffic(ctx, x, z, yaw, traffic, radius, mpp);
    if (markers && markers.count > 0) this.drawMarkers(ctx, x, z, yaw, markers, mpp);
    if (this.remoteCount > 0) this.drawRemote(ctx, x, z, yaw, mpp);
    this.drawPlayer(ctx);
    this.drawNorth(ctx, x, z, yaw, mpp);
    ctx.restore();
  }

  dispose(): void {
    this.canvas?.remove();
  }

  /** Rooms, doors and the officer arrow of the floor plan (north up). */
  private drawFloorPlan(ctx: CanvasRenderingContext2D, plan: Readonly<FloorPlan>, yaw: number): void {
    const { scale, centerX, centerZ } = this.fit;
    const rooms = plan.rooms;
    ctx.lineWidth = 1.5;
    ctx.fillStyle = PLAN_ROOM_FILL;
    ctx.strokeStyle = PLAN_ROOM_STROKE;
    for (let i = 0; i + 3 < rooms.length; i += 4) {
      const x0 = HALF + ((rooms[i] ?? 0) - centerX) * scale;
      const z0 = HALF + ((rooms[i + 1] ?? 0) - centerZ) * scale;
      const w = ((rooms[i + 2] ?? 0) - (rooms[i] ?? 0)) * scale;
      const h = ((rooms[i + 3] ?? 0) - (rooms[i + 1] ?? 0)) * scale;
      ctx.fillRect(x0, z0, w, h);
      ctx.strokeRect(x0, z0, w, h);
    }
    const doors = plan.doors;
    for (let i = 0; i + 2 < doors.length; i += 3) {
      ctx.fillStyle = (doors[i + 2] ?? 0) > 0 ? PLAN_DOOR_OPEN : PLAN_DOOR_CLOSED;
      ctx.fillRect(HALF + ((doors[i] ?? 0) - centerX) * scale - 2.5, HALF + ((doors[i + 1] ?? 0) - centerZ) * scale - 2.5, 5, 5);
    }
    // Officer arrow: north up, so a yaw turns it by -yaw (yaw 0 faces -Z = up the map).
    ctx.save();
    ctx.translate(HALF + (this.planX - centerX) * scale, HALF + (this.planZ - centerZ) * scale);
    ctx.rotate(-yaw);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(0, 2);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fillStyle = semanticColor('unit');
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore();
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
    ctx.strokeStyle = semanticColor('accent');
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
   * Units (blue squares, busy darker, emergency with a red outline), the stop (white ring), persons (white
   * dots) and suspects (red dots) when on the map, then calls (diamonds by priority, P1 on top) with off-map
   * calls on the rim, and last the pursuit (orange disc, red ring; pinned to the rim when off the map).
   */
  private drawMarkers(ctx: CanvasRenderingContext2D, x: number, z: number, yaw: number, m: MinimapMarkers, mpp: number): void {
    const p = this.mp;
    const n = Math.min(m.count, m.x.length, m.z.length, m.kind.length);
    ctx.lineWidth = 1.5;
    for (let i = 0; i < n; i++) {
      const kind = m.kind[i] ?? 0;
      if (kind < MARKER.unitAvailable || kind > MARKER.person) continue;
      markerProjection(x, z, yaw, m.x[i] ?? 0, m.z[i] ?? 0, mpp, HALF + 4, p);
      if (p.clamped) continue;
      const cx = HALF + p.x;
      const cy = HALF + p.y;
      if (kind === MARKER.suspect || kind === MARKER.person) {
        ctx.beginPath();
        ctx.arc(cx, cy, kind === MARKER.suspect ? 4 : 3, 0, Math.PI * 2);
        ctx.fillStyle = semanticColor(kind === MARKER.suspect ? 'suspect' : 'person');
        ctx.fill();
        ctx.strokeStyle = '#111';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.lineWidth = 1.5;
        continue;
      }
      if (kind === MARKER.stop) {
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1.5;
        continue;
      }
      ctx.fillStyle = semanticColor(kind === MARKER.unitBusy ? 'unitBusy' : 'unit');
      ctx.fillRect(cx - 3.5, cy - 3.5, 7, 7);
      ctx.strokeStyle = kind === MARKER.unitEmergency ? semanticColor('emergency') : '#111';
      ctx.lineWidth = kind === MARKER.unitEmergency ? 2 : 1;
      ctx.strokeRect(cx - 3.5, cy - 3.5, 7, 7);
    }
    // Calls, lowest priority first so P1 is drawn on top.
    for (let kind: number = MARKER.callP4; kind >= MARKER.callP1; kind--) {
      ctx.fillStyle = semanticColor(PRIORITY_KEYS[kind - 1] ?? 'p4');
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
    // Pursuit last so it is on top; off the map it sits on the rim like a call.
    for (let i = 0; i < n; i++) {
      if (m.kind[i] !== MARKER.pursuit) continue;
      markerProjection(x, z, yaw, m.x[i] ?? 0, m.z[i] ?? 0, mpp, MARKER_RIM, p);
      ctx.beginPath();
      ctx.arc(HALF + p.x, HALF + p.y, p.clamped ? 4 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = semanticColor('pursuit');
      ctx.fill();
      ctx.strokeStyle = semanticColor('emergency');
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  private drawPlayer(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.moveTo(HALF, HALF - 8);
    ctx.lineTo(HALF + 6, HALF + 6);
    ctx.lineTo(HALF, HALF + 3);
    ctx.lineTo(HALF - 6, HALF + 6);
    ctx.closePath();
    ctx.fillStyle = semanticColor('unit');
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** Co-op teammates: a unit-coloured square with the callsign beside it (those off the map are skipped). */
  private drawRemote(ctx: CanvasRenderingContext2D, x: number, z: number, yaw: number, mpp: number): void {
    const p = this.mp;
    ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.remoteCount; i++) {
      markerProjection(x, z, yaw, this.remoteX[i] ?? 0, this.remoteZ[i] ?? 0, mpp, HALF + 4, p);
      if (p.clamped) continue;
      const cx = HALF + p.x;
      const cy = HALF + p.y;
      ctx.fillStyle = semanticColor('unit');
      ctx.fillRect(cx - 3.5, cy - 3.5, 7, 7);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - 3.5, cy - 3.5, 7, 7);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(this.remoteNames[i] ?? '', cx + 6, cy);
    }
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
    ctx.fillStyle = semanticColor('alert');
    ctx.fillText('N', nx, ny);
  }
}
