/**
 * Livery painter over a minimal 2D-context interface (Phase 7 §6.5). Paints a `LiveryDoc` onto the
 * 1024x512 shell atlas. Pure and deterministic: no DOM, no randomness, no clock. Every region is the
 * face seen from outside; `sides` paints `left` at (u, v) and `right` at (1 - u, v) with angles negated
 * (mirrored placement, never mirrored glyphs).
 */
import { shapePolygon } from './shapes';
import type { CheckerLayer, Face, LiveryDoc, LiveryFont, LiveryLayer, ShapeLayer, StripeLayer, TextLayer } from './types';

/** The subset of `CanvasRenderingContext2D` the painter uses (tests pass a recording fake). */
export interface Canvas2DLike {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  globalAlpha: number;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number, maxWidth?: number): void;
}

export type AtlasFace = 'left' | 'right' | 'hood' | 'roof' | 'front' | 'rear';

/** Atlas size and the pixel rectangle `[x, y, w, h]` of each face. */
export const SHELL_ATLAS: {
  readonly width: 1024;
  readonly height: 512;
  readonly regions: Readonly<Record<AtlasFace, readonly [x: number, y: number, w: number, h: number]>>;
} = {
  width: 1024,
  height: 512,
  regions: {
    left: [0, 0, 1024, 192],
    right: [0, 192, 1024, 192],
    hood: [0, 384, 512, 128],
    roof: [512, 384, 256, 128],
    front: [768, 384, 128, 128],
    rear: [896, 384, 128, 128],
  },
};

export interface PaintOptions {
  /** Replaces `{unit}` in text layers. */
  unit: string;
  /** Replaces `{dept}` in text layers. */
  dept: string;
  /** Paint only the reflective layers, in white (the emissive map). */
  reflectiveOnly: boolean;
  /** Skip the opaque base and wrap fill, so only the layers show (shells around thin-framed vehicles). */
  decalsOnly?: boolean;
}

const ATLAS_FACES: readonly AtlasFace[] = ['left', 'right', 'hood', 'roof', 'front', 'rear'];
const FADE_BANDS = 8;
const PINSTRIPE_PX = 3;
const WHITE = '#ffffff';
const DEG = Math.PI / 180;
const FONT_FAMILY: Readonly<Record<LiveryFont, string>> = {
  sans: 'sans-serif',
  serif: 'serif',
  mono: 'monospace',
  stencil: "'Arial Black', sans-serif",
};

const scratchPoly: number[] = [];

/** Replaces the `{unit}` and `{dept}` tokens (single pass: replacement text is never re-scanned). */
export function resolveText(text: string, unit: string, dept: string): string {
  return text.replace(/\{(unit|dept)\}/g, (_m, token: string) => (token === 'unit' ? unit : dept));
}

function lerpColor(a: string, b: string, t: number): string {
  const ca = parseInt(a.slice(1), 16);
  const cb = parseInt(b.slice(1), 16);
  const ch = (shift: number): number => Math.round(((ca >> shift) & 255) * (1 - t) + ((cb >> shift) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

function paintWrap(ctx: Canvas2DLike, doc: LiveryDoc): void {
  const wrap = doc.wrap;
  if (wrap === null) return;
  const c0 = wrap.colors[0] ?? doc.base.color;
  const c1 = wrap.colors[1] ?? c0;
  for (const face of ATLAS_FACES) {
    const [x, y, w, h] = SHELL_ATLAS.regions[face];
    const side = face === 'left' || face === 'right';
    ctx.fillStyle = c0;
    if (!side || wrap.kind === 'solid' || wrap.kind === 'pinstripe') {
      ctx.fillRect(x, y, w, h);
      if (side && wrap.kind === 'pinstripe') {
        ctx.fillStyle = c1;
        ctx.fillRect(x, y + wrap.split * h - PINSTRIPE_PX / 2, w, PINSTRIPE_PX);
      }
    } else if (wrap.kind === 'twoTone') {
      const cut = wrap.split * h;
      ctx.fillRect(x, y, w, cut);
      ctx.fillStyle = c1;
      ctx.fillRect(x, y + cut, w, h - cut);
    } else {
      const bh = h / FADE_BANDS;
      for (let i = 0; i < FADE_BANDS; i++) {
        ctx.fillStyle = lerpColor(c0, c1, i / (FADE_BANDS - 1));
        // Overlap by a pixel so rounding never leaves a seam.
        ctx.fillRect(x, y + i * bh, w, bh + (i < FADE_BANDS - 1 ? 1 : 0));
      }
    }
  }
}

function clipTo(ctx: Canvas2DLike, region: readonly [number, number, number, number]): void {
  ctx.beginPath();
  ctx.rect(region[0], region[1], region[2], region[3]);
  ctx.clip();
}

function paintStripe(ctx: Canvas2DLike, l: StripeLayer, rx: number, ry: number, rw: number, rh: number, mirror: boolean, white: boolean): void {
  const a = mirror ? 1 - l.u1 : l.u0;
  const b = mirror ? 1 - l.u0 : l.u1;
  const angle = mirror ? -l.angleDeg : l.angleDeg;
  const hh = (l.height * rh) / 2;
  const shear = Math.tan(angle * DEG) * hh;
  const cy = ry + l.v * rh;
  const x0 = rx + a * rw;
  const x1 = rx + b * rw;
  ctx.fillStyle = white ? WHITE : l.color;
  ctx.beginPath();
  ctx.moveTo(x0 + shear, cy - hh);
  ctx.lineTo(x1 + shear, cy - hh);
  ctx.lineTo(x1 - shear, cy + hh);
  ctx.lineTo(x0 - shear, cy + hh);
  ctx.closePath();
  ctx.fill();
}

function paintShape(ctx: Canvas2DLike, l: ShapeLayer, rx: number, ry: number, rw: number, rh: number, mirror: boolean, white: boolean): void {
  const poly = shapePolygon(l.shape, { starPoints: l.starPoints, points: l.points }, scratchPoly);
  const hx = (l.w * rw) / 2;
  const hy = (l.h * rh) / 2;
  ctx.save();
  ctx.translate(rx + (mirror ? 1 - l.u : l.u) * rw, ry + l.v * rh);
  ctx.rotate((mirror ? -l.rotationDeg : l.rotationDeg) * DEG);
  ctx.beginPath();
  for (let i = 0; i + 1 < poly.length; i += 2) {
    const x = (poly[i] ?? 0) * hx;
    const y = (poly[i + 1] ?? 0) * hy;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = white ? WHITE : l.color;
  ctx.fill();
  if (l.outline !== null) {
    ctx.strokeStyle = white ? WHITE : l.outline;
    ctx.lineWidth = Math.max(2, Math.min(hx, hy) * 0.06);
    ctx.stroke();
  }
  ctx.restore();
}

function paintText(ctx: Canvas2DLike, l: TextLayer, rx: number, ry: number, rw: number, rh: number, mirror: boolean, white: boolean, text: string): void {
  const px = Math.round(l.size * rh * 100) / 100;
  ctx.font = `${l.italic ? 'italic ' : ''}${l.weight} ${px}px ${FONT_FAMILY[l.font]}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const x = rx + (mirror ? 1 - l.u : l.u) * rw;
  const y = ry + l.v * rh;
  const maxWidth = 0.96 * rw;
  if (l.outline !== null) {
    ctx.strokeStyle = white ? WHITE : l.outline;
    ctx.lineWidth = Math.max(2, l.size * rh * 0.08);
    ctx.strokeText(text, x, y, maxWidth);
  }
  ctx.fillStyle = white ? WHITE : l.color;
  ctx.fillText(text, x, y, maxWidth);
}

function paintChecker(ctx: Canvas2DLike, l: CheckerLayer, rx: number, ry: number, rw: number, rh: number, mirror: boolean, white: boolean): void {
  const top = ry + (l.v - l.height / 2) * rh;
  const band = l.height * rh;
  if (white) {
    ctx.fillStyle = WHITE;
    ctx.fillRect(rx, top, rw, band);
    return;
  }
  const cw = rw / l.cells;
  const ch = band / l.rows;
  for (let row = 0; row < l.rows; row++) {
    for (let col = 0; col < l.cells; col++) {
      const c = mirror ? l.cells - 1 - col : col;
      ctx.fillStyle = l.colors[(c + row) % 2] ?? l.colors[0];
      ctx.fillRect(rx + col * cw, top + row * ch, cw, ch);
    }
  }
}

function paintLayerOn(ctx: Canvas2DLike, l: LiveryLayer, face: AtlasFace, mirror: boolean, white: boolean, text: string): void {
  const region = SHELL_ATLAS.regions[face];
  const [rx, ry, rw, rh] = region;
  ctx.save();
  clipTo(ctx, region);
  switch (l.type) {
    case 'stripe':
      paintStripe(ctx, l, rx, ry, rw, rh, mirror, white);
      break;
    case 'shape':
      paintShape(ctx, l, rx, ry, rw, rh, mirror, white);
      break;
    case 'text':
      paintText(ctx, l, rx, ry, rw, rh, mirror, white, text);
      break;
    case 'checker':
      paintChecker(ctx, l, rx, ry, rw, rh, mirror, white);
      break;
  }
  ctx.restore();
}

const SIDES: readonly AtlasFace[] = ['left', 'right'];

function facesOf(face: Face): readonly AtlasFace[] {
  return face === 'sides' ? SIDES : [face];
}

/**
 * Clears the atlas and paints `doc`: base colour, wrap, then the layers in order. With `reflectiveOnly`
 * only the reflective layers are painted, in white, on the cleared canvas (the emissive map). With `decalsOnly` the base
 * colour and wrap are left out too: the canvas stays transparent but for the layers.
 */
export function paintLivery(ctx: Canvas2DLike, doc: LiveryDoc, opts: PaintOptions): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, SHELL_ATLAS.width, SHELL_ATLAS.height);
  if (!opts.reflectiveOnly && opts.decalsOnly !== true) {
    ctx.fillStyle = doc.base.color;
    ctx.fillRect(0, 0, SHELL_ATLAS.width, SHELL_ATLAS.height);
    paintWrap(ctx, doc);
  }
  for (const layer of doc.layers) {
    if (opts.reflectiveOnly && !layer.reflective) continue;
    const text = layer.type === 'text' ? resolveText(layer.text, opts.unit, opts.dept) : '';
    for (const face of facesOf(layer.face)) {
      paintLayerOn(ctx, layer, face, layer.face === 'sides' && face === 'right', opts.reflectiveOnly, text);
    }
  }
  ctx.restore();
}
