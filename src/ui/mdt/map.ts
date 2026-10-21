/**
 * MDT AVL map (design §13.2 tab 4): a static road layer pre-rendered once per city into an offscreen
 * canvas (by road class, as the minimap), blitted under a dynamic layer of units and calls that is
 * redrawn at most 4 Hz and only when something changed. The projection helpers are pure.
 */
import { revision as paletteRevision, semanticColor, type SemanticColor } from '../../a11y/palette';
import type { CadState } from '../../cad/cadState';
import type { CadCall, UnitStatus } from '../../cad/types';
import { WORLD_HALF_SIZE } from '../../world/constants';
import { ROAD_CLASS } from '../../world/ids';
import type { RoadEdge, RoadGraph } from '../../world/roadGraph';
import type { RemoteUnit } from '../hud/types';

/** Map viewport: centre in world metres, scale in CSS px per metre, size in CSS px. North (-Z) is up. */
export interface MapView {
  cx: number;
  cz: number;
  scale: number;
  width: number;
  height: number;
}

export interface MapPoint {
  x: number;
  y: number;
}

export interface WorldPoint {
  x: number;
  z: number;
}

/** Side of the pre-rendered road layer (px) for the whole world. */
export const ROAD_LAYER_SIZE = 2048;
export const WORLD_SIZE = WORLD_HALF_SIZE * 2;
/** Closest zoom, px per metre. */
export const MAP_MAX_SCALE = 4;
/** Calls within this many px of a click are picked. */
export const MAP_PICK_PX = 12;
/** Zoom step of +/- and one wheel notch. */
export const MAP_ZOOM_STEP = 1.5;
/** From this scale up roads are drawn as vectors (the road layer would be blurry). */
export const VECTOR_ROADS_SCALE = 1;

export function worldToMap(view: Readonly<MapView>, x: number, z: number, out: MapPoint): MapPoint {
  out.x = view.width / 2 + (x - view.cx) * view.scale;
  out.y = view.height / 2 + (z - view.cz) * view.scale;
  return out;
}

export function mapToWorld(view: Readonly<MapView>, px: number, py: number, out: WorldPoint): WorldPoint {
  out.x = view.cx + (px - view.width / 2) / view.scale;
  out.z = view.cz + (py - view.height / 2) / view.scale;
  return out;
}

/** Scale at which the whole world fits the viewport. */
export function fitScale(width: number, height: number): number {
  return Math.max(1e-4, Math.min(width, height) / WORLD_SIZE);
}

/** Clamps the scale to [fit, MAP_MAX_SCALE] and the centre to the world. */
export function clampView(view: MapView): MapView {
  const min = fitScale(view.width, view.height);
  view.scale = Math.min(MAP_MAX_SCALE, Math.max(min, Number.isFinite(view.scale) ? view.scale : min));
  view.cx = Math.min(WORLD_HALF_SIZE, Math.max(-WORLD_HALF_SIZE, Number.isFinite(view.cx) ? view.cx : 0));
  view.cz = Math.min(WORLD_HALF_SIZE, Math.max(-WORLD_HALF_SIZE, Number.isFinite(view.cz) ? view.cz : 0));
  return view;
}

const scratchWorld: WorldPoint = { x: 0, z: 0 };

/** Zooms by `factor` keeping the world point under (px, py) in place. */
export function zoomView(view: MapView, factor: number, px: number, py: number): MapView {
  const before = mapToWorld(view, px, py, scratchWorld);
  const wx = before.x;
  const wz = before.z;
  view.scale *= factor;
  clampView(view);
  // Re-centre so (wx, wz) stays under the cursor.
  view.cx = wx - (px - view.width / 2) / view.scale;
  view.cz = wz - (py - view.height / 2) / view.scale;
  return clampView(view);
}

/** Moves the content by (dx, dy) px (drag direction). */
export function panView(view: MapView, dx: number, dy: number): MapView {
  view.cx -= dx / view.scale;
  view.cz -= dy / view.scale;
  return clampView(view);
}

const scratchPoint: MapPoint = { x: 0, y: 0 };

/** Id of the open call nearest (px, py) within `maxPx`, null when none. */
export function pickCall(view: Readonly<MapView>, calls: readonly CadCall[], px: number, py: number, maxPx = MAP_PICK_PX): number | null {
  let best: number | null = null;
  let bestD2 = maxPx * maxPx;
  for (const c of calls) {
    if (c.status === 'closed') continue;
    worldToMap(view, c.location.x, c.location.z, scratchPoint);
    const dx = scratchPoint.x - px;
    const dy = scratchPoint.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = c.id;
    }
  }
  return best;
}

// --- Drawing ----------------------------------------------------------------------------------

/** Road colour and minimum stroke (px) per ROAD_CLASS id (the minimap palette, dimmed for the MDT). */
const ROAD_STYLE: readonly { readonly color: string; readonly minWidth: number }[] = [
  { color: '#b39a4a', minWidth: 2 }, // highway
  { color: '#8a96a3', minWidth: 1.6 }, // arterial
  { color: '#6f7a86', minWidth: 1.2 }, // collector
  { color: '#4e5862', minWidth: 0.8 }, // local
  { color: '#7d7462', minWidth: 1 }, // county
  { color: '#5f5444', minWidth: 0.8 }, // gravel
  { color: '#454c53', minWidth: 0.6 }, // service
];
const DRAW_ORDER = [
  ROAD_CLASS.service, ROAD_CLASS.gravel, ROAD_CLASS.local, ROAD_CLASS.county,
  ROAD_CLASS.collector, ROAD_CLASS.arterial, ROAD_CLASS.highway,
] as const;

/** Unit status -> semantic colour key; `outOfService` is a neutral grey (not a status colour). */
const STATUS_KEY: Readonly<Record<UnitStatus, SemanticColor | null>> = {
  available: 'ok',
  enRoute: 'caution',
  onScene: 'p2',
  busy: 'unitBusy',
  outOfService: null,
  transporting: 'unit',
};
const OUT_OF_SERVICE_GREY = '#8e8e93';
const PRIORITY_KEYS: readonly SemanticColor[] = ['p1', 'p2', 'p3', 'p4'];

/** Map colour of a unit status in the active colour-vision palette. */
export function unitStatusColor(status: UnitStatus): string {
  const key = STATUS_KEY[status];
  return key === null ? OUT_OF_SERVICE_GREY : semanticColor(key);
}

/** Map colour of a call priority (1..4) in the active colour-vision palette. */
export function priorityColor(priority: number): string {
  return semanticColor(PRIORITY_KEYS[priority - 1] ?? 'p4');
}

type Ctx2D = CanvasRenderingContext2D;

function strokeEdges(ctx: Ctx2D, graph: RoadGraph, ids: Iterable<number> | null, view: Readonly<MapView>, p: MapPoint): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const cls of DRAW_ORDER) {
    const style = ROAD_STYLE[cls];
    if (!style) continue;
    let width = 0;
    ctx.beginPath();
    const visit = (e: RoadEdge): void => {
      if (e.roadClass !== cls) return;
      width = Math.max(width, e.width * view.scale);
      const pts = e.points;
      for (let k = 0; k + 1 < pts.length; k += 2) {
        worldToMap(view, pts[k] ?? 0, pts[k + 1] ?? 0, p);
        if (k === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
    };
    if (ids) {
      for (const id of ids) {
        const e = graph.edges[id];
        if (e) visit(e);
      }
    } else {
      for (const e of graph.edges) visit(e);
    }
    if (width === 0) continue;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = Math.max(style.minWidth, width);
    ctx.stroke();
  }
}

/** Whole-world road layer (ROAD_LAYER_SIZE²), drawn once per city; null without a 2D context. */
export function buildRoadLayer(graph: RoadGraph, size = ROAD_LAYER_SIZE): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const view: MapView = { cx: 0, cz: 0, scale: size / WORLD_SIZE, width: size, height: size };
  strokeEdges(ctx, graph, null, view, { x: 0, y: 0 });
  return canvas;
}

export interface MapDrawState {
  readonly selectedCallId: number | null;
  readonly playerCallsign: string;
  readonly nowMs: number;
  readonly reducedFlash: boolean;
}

/**
 * The map canvas. Owns its view; `draw` is called by the overlay (≤ 4 Hz for the CAD layer, every
 * frame while `viewDirty` so pan / zoom / drag follow the input) and repaints only when `dirty`,
 * the CAD revisions changed, or an emergency marker needs its slow flash.
 */
export class MdtMap {
  readonly canvas: HTMLCanvasElement;
  readonly view: MapView = { cx: 0, cz: 0, scale: 0, width: 0, height: 0 };
  /** Repaints so far (tests and diagnostics). */
  paints = 0;
  private readonly ctx: Ctx2D | null;
  private readonly graph: RoadGraph;
  private layer: HTMLCanvasElement | null = null;
  private dirty = true;
  private fitted = false;
  private lastRev = -1;
  private lastAvl = -1;
  private lastFlash = -1;
  private lastSelected: number | null = null;
  /** Palette revision the last paint used (a colour-vision mode change repaints). */
  private lastPaletteRev = -1;
  /** Co-op teammates (reused objects; `remoteCount` of them are live). */
  private readonly remote: RemoteUnit[] = [];
  private remoteCount = 0;
  private readonly p: MapPoint = { x: 0, y: 0 };
  private readonly edges: number[] = [];
  private drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  private readonly onPick: (callId: number | null) => void;

  constructor(graph: RoadGraph, onPick: (callId: number | null) => void) {
    this.graph = graph;
    this.onPick = onPick;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mdt-map-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    this.canvas.setAttribute('aria-label', 'AVL map. Arrow keys pan, plus and minus zoom, Enter selects the call at the centre, Home centres on your unit.');
    this.ctx = this.canvas.getContext('2d');
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Co-op teammates drawn with their callsign. Copies into reused objects and marks the map dirty only when something
   * changed, so the overlay may call it every frame. null or [] clears them.
   */
  setRemoteUnits(units: readonly RemoteUnit[] | null): void {
    const n = units?.length ?? 0;
    let changed = n !== this.remoteCount;
    for (let i = 0; i < n; i++) {
      const src = units?.[i] as RemoteUnit;
      let dst = this.remote[i];
      if (!dst) {
        dst = { callsign: '', x: 0, z: 0 };
        this.remote[i] = dst;
        changed = true;
      }
      if (dst.callsign !== src.callsign || dst.x !== src.x || dst.z !== src.z) {
        dst.callsign = src.callsign;
        dst.x = src.x;
        dst.z = src.z;
        changed = true;
      }
    }
    this.remoteCount = n;
    if (changed) this.dirty = true;
  }

  /** The view changed (pan, zoom, drag, resize) and has not been repainted yet. */
  get viewDirty(): boolean {
    return this.dirty;
  }

  pan(dx: number, dy: number): void {
    panView(this.view, dx, dy);
    this.dirty = true;
  }

  zoom(factor: number, px = this.view.width / 2, py = this.view.height / 2): void {
    zoomView(this.view, factor, px, py);
    this.dirty = true;
  }

  centreOn(x: number, z: number): void {
    this.view.cx = x;
    this.view.cz = z;
    clampView(this.view);
    this.dirty = true;
  }

  /** Picks the call nearest the viewport centre (Enter). */
  pickCentre(cad: CadState): number | null {
    return pickCall(this.view, cad.calls(), this.view.width / 2, this.view.height / 2);
  }

  draw(cad: CadState, s: MapDrawState): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // One layout read per paint, before any write.
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const emergency = cad.units().some((u) => u.emergency);
    const flash = emergency && !s.reducedFlash ? Math.floor(s.nowMs / 600) % 2 : 0;
    if (w !== this.view.width || h !== this.view.height) {
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.view.width = w;
      this.view.height = h;
      if (!this.fitted) {
        this.view.scale = fitScale(w, h) * 2;
        this.fitted = true;
      }
      clampView(this.view);
      this.dirty = true;
    }
    const paletteRev = paletteRevision();
    if (
      !this.dirty && cad.revision === this.lastRev && cad.avlRevision === this.lastAvl &&
      flash === this.lastFlash && s.selectedCallId === this.lastSelected && paletteRev === this.lastPaletteRev
    ) {
      return;
    }
    this.dirty = false;
    this.lastPaletteRev = paletteRev;
    this.lastRev = cad.revision;
    this.lastAvl = cad.avlRevision;
    this.lastFlash = flash;
    this.lastSelected = s.selectedCallId;
    this.paints++;
    this.paintRoads(ctx);
    this.paintCalls(ctx, cad, s.selectedCallId);
    this.paintUnits(ctx, cad, s.playerCallsign, flash === 1 || (emergency && s.reducedFlash));
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.layer = null;
    this.canvas.remove();
  }

  private paintRoads(ctx: Ctx2D): void {
    const v = this.view;
    ctx.fillStyle = '#0a0f15';
    ctx.fillRect(0, 0, v.width, v.height);
    if (v.scale >= VECTOR_ROADS_SCALE) {
      const radius = Math.hypot(v.width, v.height) / 2 / v.scale;
      this.graph.edgesNear(v.cx, v.cz, radius, this.edges);
      strokeEdges(ctx, this.graph, this.edges, v, this.p);
      return;
    }
    this.layer ??= buildRoadLayer(this.graph);
    if (!this.layer) return;
    // Source rectangle of the layer that maps onto the viewport.
    const k = ROAD_LAYER_SIZE / WORLD_SIZE;
    const sx = (v.cx - v.width / 2 / v.scale + WORLD_HALF_SIZE) * k;
    const sy = (v.cz - v.height / 2 / v.scale + WORLD_HALF_SIZE) * k;
    const sw = (v.width / v.scale) * k;
    const sh = (v.height / v.scale) * k;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.layer, sx, sy, sw, sh, 0, 0, v.width, v.height);
  }

  private paintCalls(ctx: Ctx2D, cad: CadState, selected: number | null): void {
    const p = this.p;
    ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (const c of cad.calls()) {
      if (c.status === 'closed') continue;
      worldToMap(this.view, c.location.x, c.location.z, p);
      if (p.x < -20 || p.y < -20 || p.x > this.view.width + 20 || p.y > this.view.height + 20) continue;
      const r = 7;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - r);
      ctx.lineTo(p.x + r, p.y);
      ctx.lineTo(p.x, p.y + r);
      ctx.lineTo(p.x - r, p.y);
      ctx.closePath();
      ctx.fillStyle = priorityColor(c.priority);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000000';
      ctx.stroke();
      if (c.id === selected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
      ctx.fillStyle = '#e8eef4';
      ctx.fillText(`P${c.priority} ${c.number}`, p.x + 10, p.y);
    }
  }

  private paintUnits(ctx: Ctx2D, cad: CadState, player: string, emergencyOn: boolean): void {
    const p = this.p;
    ctx.font = '700 11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (const u of cad.units()) {
      worldToMap(this.view, u.x, u.z, p);
      if (p.x < -20 || p.y < -20 || p.x > this.view.width + 20 || p.y > this.view.height + 20) continue;
      const mine = u.callsign === player;
      const r = mine ? 7 : 5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = unitStatusColor(u.status);
      ctx.fill();
      ctx.lineWidth = mine ? 2.5 : 1;
      ctx.strokeStyle = mine ? '#ffffff' : '#000000';
      ctx.stroke();
      if (u.emergency && emergencyOn) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = semanticColor('emergency');
        ctx.stroke();
      }
      ctx.fillStyle = mine ? '#ffffff' : '#c8d3de';
      ctx.fillText(u.callsign, p.x + r + 4, p.y);
    }
    // Co-op teammates: the unit colour, the callsign beside the dot.
    for (let i = 0; i < this.remoteCount; i++) {
      const u = this.remote[i];
      if (!u) continue;
      worldToMap(this.view, u.x, u.z, p);
      if (p.x < -20 || p.y < -20 || p.x > this.view.width + 20 || p.y > this.view.height + 20) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = semanticColor('unit');
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#c8d3de';
      ctx.fillText(u.callsign, p.x + 10, p.y);
    }
  }

  private local(e: { clientX: number; clientY: number }): MapPoint {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.focus();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    this.pan(dx, dy);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (d.moved || e.type === 'pointercancel') return;
    const at = this.local(e);
    this.pickAt(at.x, at.y);
  };

  private pickCadCalls: (() => readonly CadCall[]) | null = null;

  /** The overlay supplies the call list used by clicks. */
  setCallSource(source: () => readonly CadCall[]): void {
    this.pickCadCalls = source;
  }

  private pickAt(px: number, py: number): void {
    const calls = this.pickCadCalls?.() ?? [];
    this.onPick(pickCall(this.view, calls, px, py));
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const at = this.local(e);
    this.zoom(e.deltaY < 0 ? MAP_ZOOM_STEP : 1 / MAP_ZOOM_STEP, at.x, at.y);
  };
}
