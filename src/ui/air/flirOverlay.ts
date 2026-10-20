import './air.css';
import { compassLabel } from '../hud/format';

/** Screen position of the tracked target (pixels from the canvas top-left) and whether it is on screen. */
export interface FlirTarget {
  sx: number;
  sy: number;
  visible: boolean;
}

/** 'ALT 150 m' (whole metres, never negative). */
export function flirAltText(altM: number): string {
  return `ALT ${String(Number.isFinite(altM) ? Math.max(0, Math.round(altM)) : 0)} m`;
}

/** 'HDG 45° NW': bearing in degrees clockwise from north plus the 8-point label, from a world yaw (rad). */
export function flirHeadingText(yaw: number): string {
  const deg = Number.isFinite(yaw) ? ((Math.round(-yaw * (180 / Math.PI)) % 360) + 360) % 360 : 0;
  return `HDG ${String(deg).padStart(3, '0')}° ${compassLabel(yaw)}`;
}

/** Mode label: 'FLIR WHT' (white hot) or 'FLIR BHOT' (black hot). */
export function flirModeText(blackHot: boolean): string {
  return blackHot ? 'FLIR BHOT' : 'FLIR WHT';
}

interface FlirDom {
  readonly root: HTMLDivElement;
  readonly mode: HTMLDivElement;
  readonly alt: HTMLDivElement;
  readonly compass: HTMLDivElement;
  readonly target: HTMLDivElement;
}

function node(cls: string, parent: HTMLElement): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  parent.appendChild(e);
  return e;
}

/**
 * FLIR overlay of the air unit camera (Phase 6 design §12.5). `show(true)` adds the CSS class `flir-on` to the canvas
 * (grey-scale, high-contrast filter; `flir-black-hot` adds an invert) and shows a reticle, the mode, altitude and
 * compass readouts and a target box. `update` is called every frame with the target's screen position (computed by the
 * app with `Vector3.project`); it writes the DOM only when a rounded value changed. Headless (no `document`, or no
 * parent) it keeps its state and touches no DOM.
 */
export class FlirOverlay {
  private readonly canvas: HTMLElement | null;
  private readonly dom: FlirDom | null;
  private onFlag = false;
  private blackHotFlag = false;
  private altText = '';
  private headingText = '';
  private targetOn = false;
  private tx = Number.NaN;
  private ty = Number.NaN;
  private writeCount = 0;

  /** `canvas` receives the filter classes; `parent` hosts the overlay element (usually the same container as the HUD). */
  constructor(canvas: HTMLElement | null, parent: HTMLElement | null) {
    this.canvas = typeof document === 'undefined' ? null : canvas;
    this.dom = typeof document !== 'undefined' && parent !== null ? build(parent) : null;
  }

  /** The overlay is on. */
  get on(): boolean {
    return this.onFlag;
  }

  get blackHot(): boolean {
    return this.blackHotFlag;
  }

  /** Last altitude / heading texts written. */
  get readouts(): { readonly alt: string; readonly heading: string } {
    return { alt: this.altText, heading: this.headingText };
  }

  /** The target box is shown. */
  get targetShown(): boolean {
    return this.targetOn;
  }

  /** DOM writes of `update` so far (tests and diagnostics). */
  get writes(): number {
    return this.writeCount;
  }

  /** Switches FLIR on or off (canvas class and overlay). */
  show(on: boolean): void {
    if (on === this.onFlag) return;
    this.onFlag = on;
    this.applyClasses();
    const dom = this.dom;
    if (dom) {
      dom.root.hidden = !on;
      dom.mode.textContent = flirModeText(this.blackHotFlag);
    }
    if (!on) {
      this.targetOn = false;
      this.tx = Number.NaN;
      this.ty = Number.NaN;
      this.altText = '';
      this.headingText = '';
    }
  }

  /** White hot (default) or black hot. */
  setBlackHot(blackHot: boolean): void {
    if (blackHot === this.blackHotFlag) return;
    this.blackHotFlag = blackHot;
    this.applyClasses();
    if (this.dom) this.dom.mode.textContent = flirModeText(blackHot);
  }

  /**
   * Per-frame update: the target's screen position (null = none), the camera altitude (m) and heading (a world yaw in
   * radians, as `airCameraYaw` gives it). Does nothing while FLIR is off.
   */
  update(target: Readonly<FlirTarget> | null, altM: number, heading: number): void {
    if (!this.onFlag) return;
    const alt = flirAltText(altM);
    const hdg = flirHeadingText(heading);
    const dom = this.dom;
    if (alt !== this.altText) {
      this.altText = alt;
      this.writeCount++;
      if (dom) dom.alt.textContent = alt;
    }
    if (hdg !== this.headingText) {
      this.headingText = hdg;
      this.writeCount++;
      if (dom) dom.compass.textContent = hdg;
    }
    const visible = target !== null && target.visible && Number.isFinite(target.sx) && Number.isFinite(target.sy);
    if (visible !== this.targetOn) {
      this.targetOn = visible;
      this.writeCount++;
      if (dom) dom.target.hidden = !visible;
    }
    if (visible && target) {
      const x = Math.round(target.sx);
      const y = Math.round(target.sy);
      if (x !== this.tx || y !== this.ty) {
        this.tx = x;
        this.ty = y;
        this.writeCount++;
        if (dom) {
          dom.target.style.left = `${String(x)}px`;
          dom.target.style.top = `${String(y)}px`;
        }
      }
    }
  }

  dispose(): void {
    this.show(false);
    this.dom?.root.remove();
  }

  private applyClasses(): void {
    const c = this.canvas;
    if (!c) return;
    c.classList.toggle('flir-on', this.onFlag);
    c.classList.toggle('flir-black-hot', this.onFlag && this.blackHotFlag);
  }
}

function build(parent: HTMLElement): FlirDom {
  const root = node('air-flir', parent);
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true');
  node('air-reticle', root);
  const mode = node('air-mode', root);
  mode.textContent = flirModeText(false);
  const alt = node('air-alt', root);
  const compass = node('air-compass', root);
  const target = node('air-target', root);
  target.hidden = true;
  return { root, mode, alt, compass, target };
}
