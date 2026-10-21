/**
 * Badge and shoulder-patch drawings (Phase 7 §12.2): the outline comes from the livery `shapePolygon`, painted with
 * the spec's colours on any `Canvas2DLike` (a real 2D context or a test double). Pure apart from the context.
 */
import { shapePolygon, type Canvas2DLike, type ShapeKind } from '../../livery';
import type { BadgeSpec, PatchSpec } from '../../uniform';
import { hexString } from '../livery/fields';

const scratch: number[] = [];

function trace(ctx: Canvas2DLike, kind: ShapeKind, opts: { starPoints?: number; points?: readonly (readonly [number, number])[] }, size: number, squashY: number): void {
  const pts = shapePolygon(kind, opts, scratch);
  const r = size * 0.42;
  const c = size / 2;
  ctx.beginPath();
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = c + (pts[i] ?? 0) * r;
    const y = c + (pts[i + 1] ?? 0) * r * squashY;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function label(ctx: Canvas2DLike, text: string, x: number, y: number, px: number, color: string, maxWidth: number): void {
  if (text === '') return;
  ctx.fillStyle = color;
  ctx.font = `bold ${String(Math.round(px))}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y, maxWidth);
}

/** Draws the badge: the metal outline filled with the metal colour, an enamel edge and the text in enamel. */
export function drawBadge(ctx: Canvas2DLike, badge: BadgeSpec, size: number): void {
  ctx.clearRect(0, 0, size, size);
  const opts: { starPoints?: number; points?: readonly (readonly [number, number])[] } = {};
  if (badge.starPoints !== undefined) opts.starPoints = badge.starPoints;
  if (badge.points !== undefined) opts.points = badge.points;
  trace(ctx, badge.shape, opts, size, badge.shape === 'ellipse' ? 0.7 : 1);
  ctx.fillStyle = hexString(badge.metal);
  ctx.fill();
  ctx.strokeStyle = hexString(badge.enamel);
  ctx.lineWidth = Math.max(2, size * 0.04);
  ctx.stroke();
  label(ctx, badge.text, size / 2, size / 2, size * 0.14, hexString(badge.enamel), size * 0.6);
}

/** Draws the patch: base fill, border, the initials large in the accent colour and the text small below. */
export function drawPatch(ctx: Canvas2DLike, patch: PatchSpec, size: number): void {
  ctx.clearRect(0, 0, size, size);
  const opts: { points?: readonly (readonly [number, number])[] } = {};
  if (patch.points !== undefined) opts.points = patch.points;
  trace(ctx, patch.shape, opts, size, 1);
  ctx.fillStyle = hexString(patch.base);
  ctx.fill();
  ctx.strokeStyle = hexString(patch.border);
  ctx.lineWidth = Math.max(2, size * 0.05);
  ctx.stroke();
  label(ctx, patch.initials, size / 2, size * 0.42, size * 0.24, hexString(patch.accent), size * 0.6);
  label(ctx, patch.text, size / 2, size * 0.68, size * 0.09, hexString(patch.accent), size * 0.66);
}

/**
 * A real 2D context as the painter interface. The structural match fails only on `fillStyle` / `strokeStyle`
 * (gradients and patterns are allowed there), which these drawings never use.
 */
export function asCanvas2D(ctx: CanvasRenderingContext2D): Canvas2DLike {
  return ctx as unknown as Canvas2DLike;
}
