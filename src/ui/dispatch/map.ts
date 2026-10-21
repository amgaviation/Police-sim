/**
 * Dispatch console map (design 12.1): pure view framing and marker picking, plus the canvas painter. Roads come from
 * the cached window (`roads.ts`); calls and units are painted on top at most 4 Hz. Marker colours come from
 * `semanticColor` (colour-vision palettes), and every marker also differs by shape or text so colour is never the
 * only cue.
 */
import { semanticColor, type SemanticColor } from '../../a11y/palette';
import { clampView, fitScale, mapToWorld, worldToMap, type MapPoint, type MapView, type WorldPoint } from '../mdt/map';
import type { ConsoleCall, ConsoleUnit } from './model';
import { windowOffset, type RoadCache } from './roads';

/** Marker pick radius (px) and the closest automatic zoom (px per metre). */
export const MARKER_PICK_PX = 14;
export const FRAME_MAX_SCALE = 1;
export const FRAME_PADDING_M = 120;

export type MapHit = { kind: 'call'; id: number } | { kind: 'unit'; callsign: string };

const PRIORITY_KEYS: readonly SemanticColor[] = ['p1', 'p2', 'p3', 'p4'];

/** Semantic colour key of a call priority (1..4). */
export function priorityColorKey(p: number): SemanticColor {
  return PRIORITY_KEYS[Math.min(3, Math.max(0, Math.round(p) - 1))] ?? 'p4';
}

/** Semantic colour key of a unit status. */
export function unitColorKey(status: string): SemanticColor {
  switch (status) {
    case 'available':
      return 'ok';
    case 'enRoute':
      return 'caution';
    case 'onScene':
      return 'unit';
    case 'busy':
      return 'unitBusy';
    case 'transporting':
      return 'person';
    default:
      return 'accent';
  }
}

/** The view that frames every open call and unit with padding, never closer than 1 px per metre; the whole world when empty. */
export function frameView(width: number, height: number, calls: readonly ConsoleCall[], units: readonly ConsoleUnit[]): MapView {
  const view: MapView = { cx: 0, cz: 0, scale: fitScale(width, height), width, height };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const add = (x: number, z: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const c of calls) if (c.status !== 'closed') add(c.x, c.z);
  for (const u of units) add(u.x, u.z);
  if (minX > maxX) return view;
  const w = maxX - minX + 2 * FRAME_PADDING_M;
  const h = maxZ - minZ + 2 * FRAME_PADDING_M;
  view.cx = (minX + maxX) / 2;
  view.cz = (minZ + maxZ) / 2;
  view.scale = Math.min(FRAME_MAX_SCALE, Math.min(width / w, height / h));
  return clampView(view);
}

const scratch: MapPoint = { x: 0, y: 0 };

/** The call or unit marker nearest (px, py) within `maxPx`; calls win a tie (they are drawn under the units). */
export function pickMarker(
  view: Readonly<MapView>,
  calls: readonly ConsoleCall[],
  units: readonly ConsoleUnit[],
  px: number,
  py: number,
  maxPx = MARKER_PICK_PX,
): MapHit | null {
  let best: MapHit | null = null;
  let bestD2 = maxPx * maxPx;
  for (const c of calls) {
    if (c.status === 'closed') continue;
    worldToMap(view, c.x, c.z, scratch);
    const d2 = (scratch.x - px) ** 2 + (scratch.y - py) ** 2;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = { kind: 'call', id: c.id };
    }
  }
  for (const u of units) {
    worldToMap(view, u.x, u.z, scratch);
    const d2 = (scratch.x - px) ** 2 + (scratch.y - py) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = { kind: 'unit', callsign: u.callsign };
    }
  }
  return best;
}

/** World position under a canvas pixel. */
export function worldAt(view: Readonly<MapView>, px: number, py: number): WorldPoint {
  return mapToWorld(view, px, py, { x: 0, z: 0 });
}

export interface ConsoleMapState {
  selectedCall: number | null;
  selectedUnit: string | null;
  creating: boolean;
}

const INK = '#dfe7ee';
const BACKDROP = '#0e151d';
const GRID = '#1c2733';

/** Paints the roads, the unit-to-call lines, the calls and the units. */
export function drawConsoleMap(
  ctx: CanvasRenderingContext2D,
  roads: RoadCache,
  view: Readonly<MapView>,
  calls: readonly ConsoleCall[],
  units: readonly ConsoleUnit[],
  state: Readonly<ConsoleMapState>,
): void {
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, view.width, view.height);
  const cached = roads.ensure(view);
  if (cached) {
    const at = windowOffset(cached.win, view, scratch);
    ctx.drawImage(cached.canvas, at.x, at.y);
  } else {
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, view.width - 1, view.height - 1);
  }
  const p: MapPoint = { x: 0, y: 0 };
  const q: MapPoint = { x: 0, y: 0 };
  const byId = new Map<number, ConsoleCall>();
  for (const c of calls) byId.set(c.id, c);
  // Assignment lines.
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (const u of units) {
    const c = u.callId === null ? undefined : byId.get(u.callId);
    if (!c || c.status === 'closed') continue;
    worldToMap(view, u.x, u.z, p);
    worldToMap(view, c.x, c.z, q);
    ctx.strokeStyle = semanticColor(unitColorKey(u.status));
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const c of calls) {
    if (c.status === 'closed') continue;
    worldToMap(view, c.x, c.z, p);
    if (p.x < -20 || p.y < -20 || p.x > view.width + 20 || p.y > view.height + 20) continue;
    const colour = semanticColor(priorityColorKey(c.priority));
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    if (c.status === 'pending') {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = BACKDROP;
      ctx.fill();
      ctx.fillStyle = INK;
    } else {
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.fillStyle = '#0b0f14';
    }
    ctx.fillText(String(c.priority), p.x, p.y + 0.5);
    if (c.id === state.selectedCall) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.textAlign = 'left';
  for (const u of units) {
    worldToMap(view, u.x, u.z, p);
    if (p.x < -40 || p.y < -20 || p.x > view.width + 40 || p.y > view.height + 20) continue;
    ctx.fillStyle = semanticColor(unitColorKey(u.status));
    ctx.beginPath();
    if (u.kind === 'player') {
      ctx.moveTo(p.x, p.y - 7);
      ctx.lineTo(p.x + 7, p.y);
      ctx.lineTo(p.x, p.y + 7);
      ctx.lineTo(p.x - 7, p.y);
      ctx.closePath();
    } else if (u.kind === 'remote') {
      ctx.rect(p.x - 5.5, p.y - 5.5, 11, 11);
    } else {
      ctx.moveTo(p.x, p.y - 7);
      ctx.lineTo(p.x + 6.5, p.y + 5);
      ctx.lineTo(p.x - 6.5, p.y + 5);
      ctx.closePath();
    }
    ctx.fill();
    ctx.strokeStyle = u.callsign === state.selectedUnit ? INK : BACKDROP;
    ctx.lineWidth = u.callsign === state.selectedUnit ? 2 : 1;
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.fillText(u.callsign, p.x + 10, p.y);
  }
  if (state.creating) {
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.fillText('Click the map to place the call (Esc cancels)', view.width / 2, 14);
  }
}
