/**
 * Scenario editor canvas (design 12.2): the top-down view of the area around the anchor and the painter. The view maths
 * is pure; painting needs a 2D context. Glyphs: circle = person, rectangle = vehicle, diamond = evidence, star = call.
 * Hidden people and concealed evidence have a dashed outline, so colour is not the only cue.
 */
import { semanticColor } from '../../a11y/palette';
import { SCENARIO_LIMITS, type SandboxScenario } from '../../training/scenario';
import { dashedOutline, fillStar } from './glyphs';
import { worldToMap, type MapPoint, type MapView } from '../mdt/map';
import { windowOffset, type RoadCache } from '../dispatch/roads';
import type { EditorSelection } from './state';

/** Canvas side in px; the view shows the radius plus a margin. */
export const EDITOR_PX = 600;
const MARGIN_M = 15;

/** The fixed square view around the anchor: ±(150 m + margin). */
export function editorView(anchor: { x: number; z: number }, px = EDITOR_PX): MapView {
  return { cx: anchor.x, cz: anchor.z, scale: px / (2 * (SCENARIO_LIMITS.radiusM + MARGIN_M)), width: px, height: px };
}

/** Screen pick radius (px) used for selecting and for the glyph hit test. */
export const PICK_PX = 12;

const INK = '#dfe7ee';
const BACKDROP = '#0e151d';
const RING = '#3a4a5c';

/** Paints roads, the 150 m ring, the anchor and every placed object. */
export function drawScenario(
  ctx: CanvasRenderingContext2D,
  roads: RoadCache,
  view: Readonly<MapView>,
  doc: Readonly<SandboxScenario>,
  sel: Readonly<EditorSelection> | null,
): void {
  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, view.width, view.height);
  const cached = roads.ensure(view);
  const p: MapPoint = { x: 0, y: 0 };
  if (cached) {
    const at = windowOffset(cached.win, view, p);
    ctx.drawImage(cached.canvas, at.x, at.y);
  }
  worldToMap(view, doc.anchor.x, doc.anchor.z, p);
  ctx.strokeStyle = RING;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.arc(p.x, p.y, SCENARIO_LIMITS.radiusM * view.scale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(p.x - 6, p.y);
  ctx.lineTo(p.x + 6, p.y);
  ctx.moveTo(p.x, p.y - 6);
  ctx.lineTo(p.x, p.y + 6);
  ctx.stroke();

  const isSel = (kind: EditorSelection['kind'], i: number): boolean => sel !== null && sel.kind === kind && sel.index === i;
  const ring = (x: number, y: number): void => {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.stroke();
  };

  doc.vehicles.forEach((v, i) => {
    worldToMap(view, v.x, v.z, p);
    ctx.save();
    ctx.translate(p.x, p.y);
    // yaw 0 faces -Z (up the screen); the long side follows the heading.
    ctx.rotate(-v.yaw);
    ctx.fillStyle = semanticColor('unit');
    ctx.fillRect(-4.5, -9, 9, 18);
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(-3.5, -8, 7, 4);
    ctx.restore();
    if (isSel('vehicle', i)) ring(p.x, p.y);
  });
  doc.evidence.forEach((e, i) => {
    worldToMap(view, e.x, e.z, p);
    ctx.fillStyle = semanticColor('caution');
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - 6);
    ctx.lineTo(p.x + 6, p.y);
    ctx.lineTo(p.x, p.y + 6);
    ctx.lineTo(p.x - 6, p.y);
    ctx.closePath();
    ctx.fill();
    if (e.concealed) dashedOutline(ctx, p.x, p.y, 8, INK);
    if (isSel('evidence', i)) ring(p.x, p.y);
  });
  doc.npcs.forEach((n, i) => {
    worldToMap(view, n.x, n.z, p);
    ctx.fillStyle = semanticColor(n.weapon !== null ? 'suspect' : 'person');
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - Math.sin(n.yaw) * 11, p.y - Math.cos(n.yaw) * 11);
    ctx.stroke();
    if (n.hidden) dashedOutline(ctx, p.x, p.y, 9, INK);
    if (isSel('npc', i)) ring(p.x, p.y);
  });
  if (doc.call) {
    worldToMap(view, doc.anchor.x, doc.anchor.z, p);
    ctx.fillStyle = semanticColor('emergency');
    fillStar(ctx, p.x, p.y, 11, 5);
    if (sel !== null && sel.kind === 'call') ring(p.x, p.y);
  }
}
