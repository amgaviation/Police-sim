import { semanticColor } from '../../a11y';
import { CAREER_CONFIG, rangeSchedule, scoreRange, swayOffset, type CareerConfig, type PerformanceMods, type RangeTarget } from '../../career';
import { div, setText } from '../panels/dom';
import type { UIRoot } from '../ui';
import './career.css';
import { HEADLESS_ELEMENT, canBuildDom, type MinigameOptions, type MinigameScreen } from './types';

/** Canvas size in logical pixels; the playfield is the centred square, so normalized circles stay circles. */
export const RANGE_W = 640;
export const RANGE_H = 360;
export const FIELD_SIZE = RANGE_H;
export const FIELD_X = (RANGE_W - FIELD_SIZE) / 2;
/** Shots closer together than this are ignored (no click spamming). */
export const MIN_SHOT_GAP_S = 0.25;
export const MAX_SHOTS = 200;
/** Arrow-key nudge of the pointer in normalized units. */
export const KEY_STEP = 0.025;

export type RangePhase = 'ready' | 'running' | 'done';

export interface RangeShot {
  t: number;
  x: number;
  y: number;
}

export interface RangeResult {
  score: number;
  hits: number;
  noShootHits: number;
  misses: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Normalized playfield coordinates -> canvas pixels. */
export function toCanvas(nx: number, ny: number, out: { x: number; y: number }): { x: number; y: number } {
  out.x = FIELD_X + nx * FIELD_SIZE;
  out.y = ny * FIELD_SIZE;
  return out;
}

/** Canvas pixels -> normalized playfield coordinates (clamped to 0..1). */
export function fromCanvas(px: number, py: number, out: { x: number; y: number }): { x: number; y: number } {
  out.x = clamp01((px - FIELD_X) / FIELD_SIZE);
  out.y = clamp01(py / FIELD_SIZE);
  return out;
}

/**
 * The firearms range as a state machine (design §11.1): the schedule comes from `rangeSchedule(seed, attempt)`, the
 * crosshair is the pointer plus `swayOffset(t, mods)`, a shot is recorded at the crosshair, the score is
 * `scoreRange(targets, shots)`. No timers or DOM: the screen feeds it `advance(dt)`.
 */
export class RangeRun {
  readonly targets: RangeTarget[];
  readonly durationS: number;
  readonly shots: RangeShot[] = [];
  readonly pointer = { x: 0.5, y: 0.5 };
  /** The crosshair (pointer + sway), refreshed by `advance`, `movePointer` and `nudge`. */
  readonly aim = { x: 0.5, y: 0.5 };
  phase: RangePhase = 'ready';
  t = 0;
  private lastShotT = -Infinity;
  private readonly sway = { x: 0, y: 0 };
  private final: RangeResult | null = null;

  private readonly mods: Readonly<PerformanceMods>;
  private readonly cfg: CareerConfig['range'];

  constructor(
    seed: number,
    attempt: number,
    mods: Readonly<PerformanceMods>,
    cfg: CareerConfig['range'] = CAREER_CONFIG.range,
  ) {
    this.mods = mods;
    this.cfg = cfg;
    this.targets = rangeSchedule(seed, attempt, cfg);
    this.durationS = cfg.durationS;
    this.updateAim();
  }

  /** Seconds left, 0 once done. */
  get remainingS(): number {
    return Math.max(0, this.durationS - this.t);
  }

  /** Fraction of the time used, 0..1. */
  get fraction(): number {
    return this.durationS > 0 ? Math.min(1, this.t / this.durationS) : 1;
  }

  start(): void {
    if (this.phase === 'ready') this.phase = 'running';
  }

  movePointer(nx: number, ny: number): void {
    this.pointer.x = clamp01(nx);
    this.pointer.y = clamp01(ny);
    this.updateAim();
  }

  nudge(dx: number, dy: number): void {
    this.movePointer(this.pointer.x + dx, this.pointer.y + dy);
  }

  /** Advances the clock; the range closes at `durationS`. */
  advance(dt: number): void {
    if (this.phase !== 'running' || !(dt > 0)) return;
    this.t = Math.min(this.durationS, this.t + dt);
    this.updateAim();
    if (this.t >= this.durationS) {
      this.phase = 'done';
      this.final = scoreRange(this.targets, this.shots);
    }
  }

  /** Fires at the crosshair; false when not running, too soon after the last shot or at the shot cap. */
  fire(): boolean {
    if (this.phase !== 'running' || this.shots.length >= MAX_SHOTS) return false;
    if (this.t - this.lastShotT < MIN_SHOT_GAP_S) return false;
    this.lastShotT = this.t;
    this.shots.push({ t: this.t, x: this.aim.x, y: this.aim.y });
    return true;
  }

  /** Targets on show now, appended to `out` (cleared first). */
  visible(out: RangeTarget[]): RangeTarget[] {
    out.length = 0;
    for (const target of this.targets) {
      if (this.t >= target.appearAt && this.t < target.appearAt + target.duration) out.push(target);
    }
    return out;
  }

  /** The final result once done, else null. */
  result(): RangeResult | null {
    return this.final;
  }

  /** The score so far (for tests and previews). */
  preview(): RangeResult {
    return scoreRange(this.targets, this.shots);
  }

  private updateAim(): void {
    swayOffset(this.t, this.mods, this.sway, this.cfg);
    this.aim.x = this.pointer.x + this.sway.x;
    this.aim.y = this.pointer.y + this.sway.y;
  }
}

const NEUTRAL_BG = '#10161d';
const NEUTRAL_FIELD = '#1a232d';
const NEUTRAL_PAPER = '#e8eef4';
const NEUTRAL_INK = '#0b0f14';
const NO_SHOOT_FILL = '#8a929a';

interface RangeDom {
  readonly root: HTMLDivElement;
  readonly status: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D | null;
  readonly result: HTMLDivElement;
  readonly hint: HTMLDivElement;
}

/**
 * Firearms range screen (pausing Menu, id 'range'). A canvas of 640x360 scaled to fit: the crosshair follows the pointer
 * plus the fatigue/stress sway, a click (or Space/Enter) fires, ring targets and grey no-shoot squares come and go, shots
 * leave a static mark (nothing flashes), a timer bar runs along the bottom. At the end the score goes to `onScore`.
 * Keys: arrows move the crosshair, Space/Enter fire (or start), Escape leaves. Headless it keeps the state machine only.
 */
export class RangeMinigame implements MinigameScreen {
  readonly id = 'range' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly dom: RangeDom | null;
  private run: RangeRun;
  private openFlag = false;
  private submitted = false;
  private raf = 0;
  private lastFrame = -1;
  private readonly visibleScratch: RangeTarget[] = [];
  private readonly px = { x: 0, y: 0 };
  private resultShown = false;

  private readonly ui: UIRoot | null;
  private readonly opts: MinigameOptions;
  private readonly mods: () => Readonly<PerformanceMods>;

  constructor(ui: UIRoot | null, opts: MinigameOptions, mods: () => Readonly<PerformanceMods>) {
    this.ui = ui;
    this.opts = opts;
    this.mods = mods;
    this.run = new RangeRun(opts.seed, opts.attempt, mods());
    this.dom = canBuildDom(ui) ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get state(): RangeRun {
    return this.run;
  }

  /** Opens a fresh range for the current attempt. */
  open(): void {
    this.run = new RangeRun(this.opts.seed, this.opts.attempt, this.mods());
    this.submitted = false;
    this.resultShown = false;
    this.openFlag = true;
    this.lastFrame = -1;
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
    this.startLoop();
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.stopLoop();
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  /** Leaves the screen and tells the hub. */
  exit(): void {
    this.close();
    this.opts.onExit();
  }

  onShow(): void {
    this.startLoop();
  }

  onHide(): void {
    this.stopLoop();
    this.openFlag = this.openFlag && (this.ui?.isOpen(this) ?? false);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    return this.press(event.key, event.repeat);
  }

  /** A key as the keyboard sends it; true when consumed. */
  press(key: string, repeat = false): boolean {
    const run = this.run;
    switch (key) {
      case 'Escape':
        this.exit();
        return true;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        if (repeat) return true;
        if (run.phase === 'ready') run.start();
        else if (run.phase === 'running') run.fire();
        else if (run.phase === 'done') this.exit();
        this.render();
        return true;
      case 'ArrowLeft':
        run.nudge(-KEY_STEP, 0);
        return true;
      case 'ArrowRight':
        run.nudge(KEY_STEP, 0);
        return true;
      case 'ArrowUp':
        run.nudge(0, -KEY_STEP);
        return true;
      case 'ArrowDown':
        run.nudge(0, KEY_STEP);
        return true;
      default:
        return false;
    }
  }

  /** Advances the run by `dt` seconds (the frame loop; tests call it directly) and submits the score when it ends. */
  advance(dt: number): void {
    if (!this.openFlag) return;
    this.run.advance(dt);
    if (this.run.phase === 'done' && !this.submitted) {
      this.submitted = true;
      const result = this.run.result();
      if (result) this.opts.onScore(result.score);
      this.render();
    }
    this.paint();
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  // --- DOM ----------------------------------------------------------------------------------------

  private startLoop(): void {
    if (!this.dom || this.raf !== 0 || !this.openFlag || typeof requestAnimationFrame === 'undefined') return;
    const tick = (nowMs: number): void => {
      this.raf = 0;
      if (!this.openFlag) return;
      const dt = this.lastFrame < 0 ? 0 : Math.min(0.1, (nowMs - this.lastFrame) / 1000);
      this.lastFrame = nowMs;
      this.advance(dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.raf !== 0 && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastFrame = -1;
  }

  private render(): void {
    const dom = this.dom;
    if (!dom) return;
    const run = this.run;
    const pass = CAREER_CONFIG.academy.pass.firearms;
    setText(dom.hint, run.phase === 'ready'
      ? 'Click or Enter to start · aim with the pointer or arrow keys · Space/click fires · Esc leaves'
      : run.phase === 'running' ? 'Shoot the round targets, never the grey squares · Esc abandons the attempt' : 'Enter to continue');
    setText(dom.status, run.phase === 'done' ? 'Range closed' : run.phase === 'ready' ? 'Firearms range' : 'Firearms range · live');
    dom.result.hidden = run.phase !== 'done';
    const result = run.result();
    if (result && !this.resultShown) {
      this.resultShown = true;
      dom.result.textContent = '';
      const passed = result.score >= pass;
      const scoreEl = div('cr-result-score', dom.result);
      const detailEl = div('cr-result-detail', dom.result);
      setText(scoreEl, `Score ${String(result.score)}`);
      setText(detailEl, `Targets hit ${String(result.hits)} · no-shoot hits ${String(result.noShootHits)} · misses ${String(result.misses)} · pass mark ${String(pass)} · ${passed ? 'PASSED' : 'not passed'}`);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cr-btn cr-primary';
      button.textContent = 'Continue';
      button.addEventListener('click', () => {
        this.exit();
      });
      dom.result.appendChild(button);
      button.focus();
    }
    this.paint();
  }

  private paint(): void {
    const dom = this.dom;
    const ctx = dom?.ctx;
    if (!dom || !ctx) return;
    const run = this.run;
    const p = this.px;
    ctx.fillStyle = NEUTRAL_BG;
    ctx.fillRect(0, 0, RANGE_W, RANGE_H);
    ctx.fillStyle = NEUTRAL_FIELD;
    ctx.fillRect(FIELD_X, 0, FIELD_SIZE, FIELD_SIZE);
    const radiusPx = CAREER_CONFIG.range.radius * FIELD_SIZE;
    for (const target of run.visible(this.visibleScratch)) {
      toCanvas(target.x, target.y, p);
      if (target.noShoot) drawNoShoot(ctx, p.x, p.y, radiusPx);
      else drawRings(ctx, p.x, p.y, radiusPx);
    }
    // Static marks of earlier shots: no flash, no animation.
    ctx.lineWidth = 1;
    for (const shot of run.shots) {
      toCanvas(shot.x, shot.y, p);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = NEUTRAL_INK;
      ctx.fill();
      ctx.strokeStyle = NEUTRAL_PAPER;
      ctx.stroke();
    }
    // Crosshair.
    toCanvas(run.aim.x, run.aim.y, p);
    ctx.strokeStyle = semanticColor('accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.moveTo(p.x - 14, p.y);
    ctx.lineTo(p.x + 14, p.y);
    ctx.moveTo(p.x, p.y - 14);
    ctx.lineTo(p.x, p.y + 14);
    ctx.stroke();
    // Timer bar along the bottom.
    ctx.fillStyle = NEUTRAL_INK;
    ctx.fillRect(0, RANGE_H - 8, RANGE_W, 8);
    ctx.fillStyle = run.fraction > 0.85 ? semanticColor('caution') : semanticColor('ok');
    ctx.fillRect(0, RANGE_H - 8, RANGE_W * (1 - run.fraction), 8);
  }

  private build(): RangeDom {
    const root = div('cr-panel cr-range');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Firearms range');
    const status = div('cr-title', root);
    const canvas = document.createElement('canvas');
    canvas.width = RANGE_W;
    canvas.height = RANGE_H;
    canvas.className = 'cr-range-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Firearms range. Arrow keys move the crosshair, Space fires.');
    root.appendChild(canvas);
    const result = div('cr-result', root);
    result.hidden = true;
    const hint = div('cr-hint', root);
    const ctx = canvas.getContext('2d');
    const local = { x: 0, y: 0 };
    const toLogical = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width > 0 ? RANGE_W / rect.width : 1;
      const sy = rect.height > 0 ? RANGE_H / rect.height : 1;
      fromCanvas((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy, local);
      this.run.movePointer(local.x, local.y);
    };
    canvas.addEventListener('pointermove', toLogical);
    canvas.addEventListener('pointerdown', (e) => {
      toLogical(e);
      if (this.run.phase === 'ready') this.run.start();
      else this.run.fire();
      this.render();
    });
    return { root, status, canvas, ctx, result, hint };
  }
}

function drawRings(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const rings = 5;
  for (let i = rings; i >= 1; i--) {
    ctx.beginPath();
    ctx.arc(x, y, (r * i) / rings, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 === 1 ? semanticColor('suspect') : NEUTRAL_PAPER;
    ctx.fill();
    ctx.strokeStyle = NEUTRAL_INK;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** A grey square with an open-hand glyph: do not shoot. */
function drawNoShoot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = NO_SHOOT_FILL;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.strokeStyle = NEUTRAL_INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(x - r, y - r, r * 2, r * 2);
  // Open hand: a palm and four fingers.
  const s = r * 0.5;
  ctx.fillStyle = NEUTRAL_INK;
  ctx.fillRect(x - s * 0.8, y - s * 0.1, s * 1.6, s * 1.0);
  for (let i = 0; i < 4; i++) ctx.fillRect(x - s * 0.8 + i * s * 0.45, y - s * 1.0, s * 0.3, s * 1.0);
}
