/** Creates a canvas of the given size, or null when there is no DOM (tests, workers). */
export type CanvasFactory = (width: number, height: number) => HTMLCanvasElement | null;

/** `document.createElement('canvas')` sized `width` x `height`; null without a document. */
export const domCanvas: CanvasFactory = (width, height) => {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/** What the in-car MDT screen shows (design §12): a compact CAD summary. */
export interface MdtScreenModel {
  readonly callsign: string;
  readonly status: string;
  readonly clock: string;
  readonly call: {
    readonly number: string;
    readonly priority: number;
    readonly nature: string;
    readonly address: string;
    readonly status: string;
  } | null;
  readonly queue: readonly { readonly priority: number; readonly nature: string; readonly address: string }[];
  readonly offer: string | null;
  readonly alert: string | null;
  readonly stop: string | null;
}

/** At most 2 repaints per second (design §18). */
export const MDT_SCREEN_MIN_INTERVAL_MS = 500;
/** Queue rows shown. */
export const MDT_SCREEN_QUEUE_ROWS = 4;

const SEP = '\u001f';

/** Everything the screen draws, as one string: equal keys paint identical screens. */
export function screenKey(model: MdtScreenModel): string {
  const parts: string[] = [model.callsign, model.status, model.clock];
  const c = model.call;
  if (c) parts.push('C', c.number, String(c.priority), c.nature, c.address, c.status);
  else parts.push('-');
  const n = Math.min(model.queue.length, MDT_SCREEN_QUEUE_ROWS);
  parts.push(String(n));
  for (let i = 0; i < n; i++) {
    const q = model.queue[i];
    if (q) parts.push(String(q.priority), q.nature, q.address);
  }
  parts.push(model.offer ?? '\u0000', model.alert ?? '\u0000', model.stop ?? '\u0000');
  return parts.join(SEP);
}

/** Throttle: a repaint is allowed when none happened yet or the last one is at least `minIntervalMs` old. */
export function screenPaintDue(nowMs: number, lastPaintMs: number, minIntervalMs = MDT_SCREEN_MIN_INTERVAL_MS): boolean {
  return !Number.isFinite(lastPaintMs) || nowMs - lastPaintMs >= minIntervalMs || nowMs < lastPaintMs;
}

const COLOR = {
  bg: '#0b1016',
  header: '#16212c',
  text: '#d8e2ec',
  dim: '#7d8b99',
  card: '#111a23',
  offer: '#ffb84d',
  alert: '#ff5a4f',
  stop: '#5fd0ff',
} as const;
const PRIORITY_COLOR: readonly string[] = ['#ff5a4f', '#ffb84d', '#7fd67f', '#9aa7b4'];
const FONT = 'ui-monospace, Menlo, Consolas, monospace';

function priorityColor(p: number): string {
  return PRIORITY_COLOR[Math.min(Math.max(p, 1), PRIORITY_COLOR.length) - 1] ?? COLOR.dim;
}

/** Cuts `text` to `max` characters (monospace layout), marking the cut. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}~`;
}

/**
 * Paints the MDT summary into a canvas for the cockpit laptop's `CanvasTexture`. Repaints only when
 * `screenKey` changed and at most every `MDT_SCREEN_MIN_INTERVAL_MS`; without a DOM the canvas is
 * null and `paint` returns false.
 */
export class MdtScreen {
  readonly canvas: HTMLCanvasElement | null;
  readonly width: number;
  readonly height: number;
  private readonly ctx: CanvasRenderingContext2D | null;
  private lastKey: string | null = null;
  private lastPaintMs = -Infinity;

  constructor(width = 512, height = 320, createCanvas: CanvasFactory = domCanvas) {
    this.width = width;
    this.height = height;
    const canvas = createCanvas(width, height);
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.canvas = this.ctx ? canvas : null;
  }

  /** Repaints for `model` when due and changed; true when the canvas changed (then call `CockpitRenderer.markScreenDirty`). */
  paint(model: MdtScreenModel, nowMs: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (!screenPaintDue(nowMs, this.lastPaintMs)) return false;
    const key = screenKey(model);
    if (key === this.lastKey) return false;
    this.draw(ctx, model);
    this.lastKey = key;
    this.lastPaintMs = nowMs;
    return true;
  }

  private draw(ctx: CanvasRenderingContext2D, m: MdtScreenModel): void {
    const W = this.width;
    const H = this.height;
    const s = W / 512;
    const pad = 10 * s;
    const cols = Math.floor((W - 2 * pad) / (9.6 * s));
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(0, 0, W, H);

    // Header: unit, status, clock.
    ctx.fillStyle = COLOR.header;
    ctx.fillRect(0, 0, W, 34 * s);
    ctx.font = `bold ${16 * s}px ${FONT}`;
    ctx.fillStyle = COLOR.text;
    ctx.fillText(clip(`UNIT ${m.callsign}`, 12), pad, 17 * s);
    ctx.fillStyle = COLOR.offer;
    ctx.fillText(clip(m.status, 22), 150 * s, 17 * s);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLOR.text;
    ctx.fillText(m.clock, W - pad, 17 * s);
    ctx.textAlign = 'left';

    // Current call card.
    ctx.fillStyle = COLOR.card;
    ctx.fillRect(pad / 2, 40 * s, W - pad, 96 * s);
    const call = m.call;
    if (call) {
      ctx.fillStyle = priorityColor(call.priority);
      ctx.fillRect(pad / 2, 40 * s, 5 * s, 96 * s);
      ctx.font = `bold ${15 * s}px ${FONT}`;
      ctx.fillText(`P${call.priority}`, pad + 4 * s, 56 * s);
      ctx.fillStyle = COLOR.text;
      ctx.fillText(call.number, pad + 44 * s, 56 * s);
      ctx.textAlign = 'right';
      ctx.fillStyle = COLOR.dim;
      ctx.fillText(clip(call.status, 18), W - pad, 56 * s);
      ctx.textAlign = 'left';
      ctx.font = `bold ${18 * s}px ${FONT}`;
      ctx.fillStyle = COLOR.text;
      ctx.fillText(clip(call.nature.toUpperCase(), Math.floor(cols * 0.85)), pad + 4 * s, 86 * s);
      ctx.font = `${15 * s}px ${FONT}`;
      ctx.fillStyle = COLOR.dim;
      ctx.fillText(clip(call.address, cols - 1), pad + 4 * s, 114 * s);
    } else {
      ctx.font = `${16 * s}px ${FONT}`;
      ctx.fillStyle = COLOR.dim;
      ctx.fillText('NO ACTIVE CALL', pad + 4 * s, 88 * s);
    }

    // Queue.
    ctx.font = `bold ${12 * s}px ${FONT}`;
    ctx.fillStyle = COLOR.dim;
    ctx.fillText(`PENDING (${m.queue.length})`, pad, 150 * s);
    ctx.font = `${14 * s}px ${FONT}`;
    const rows = Math.min(m.queue.length, MDT_SCREEN_QUEUE_ROWS);
    for (let i = 0; i < rows; i++) {
      const q = m.queue[i];
      if (!q) continue;
      const y = (170 + i * 20) * s;
      ctx.fillStyle = priorityColor(q.priority);
      ctx.fillText(`P${q.priority}`, pad, y);
      ctx.fillStyle = COLOR.text;
      ctx.fillText(clip(`${q.nature} - ${q.address}`, cols - 4), pad + 34 * s, y);
    }

    // Offer / alert / stop lines.
    ctx.font = `bold ${14 * s}px ${FONT}`;
    let y = 258 * s;
    const line = (text: string | null, color: string, label: string): void => {
      if (text === null) return;
      ctx.fillStyle = color;
      ctx.fillText(clip(`${label} ${text}`, cols), pad, y);
      y += 21 * s;
    };
    line(m.offer, COLOR.offer, 'OFFER');
    line(m.alert, COLOR.alert, 'ALERT');
    line(m.stop, COLOR.stop, 'STOP');
  }
}
