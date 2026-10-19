import './investigation.css';
import type { Menu, UIRoot } from '../ui';
import { div, setText } from '../panels/dom';
import { PHOTO_FOV_DEFAULT, PHOTO_FOV_MAX, PHOTO_FOV_MIN } from '../../investigation/types';

/** Degrees one zoom key press changes the field of view. */
export const CAMERA_FOV_STEP = 5;

export interface CameraState {
  readonly fovDeg: number;
}

export type CameraEmit =
  | { readonly kind: 'shutter'; readonly fovDeg: number }
  | { readonly kind: 'fov'; readonly fovDeg: number }
  | { readonly kind: 'close' };

export interface CameraKeyResult {
  readonly state: CameraState;
  readonly emit: CameraEmit | null;
  readonly consumed: boolean;
}

/** What the viewfinder shows. */
export interface CameraInfo {
  /** 'C-00042' or 'Field case'. */
  readonly caseLabel: string;
  readonly room: string;
  /** Caption of the last photo, '' none. */
  readonly caption: string;
}

export interface CameraHandlers {
  shutter(fovDeg: number): void;
  fov(fovDeg: number): void;
  close(): void;
}

export function createCameraState(fovDeg: number = PHOTO_FOV_DEFAULT): CameraState {
  return { fovDeg: clampFov(fovDeg) };
}

function clampFov(fovDeg: number): number {
  return Math.min(PHOTO_FOV_MAX, Math.max(PHOTO_FOV_MIN, Number.isFinite(fovDeg) ? fovDeg : PHOTO_FOV_DEFAULT));
}

/**
 * Pure key reducer of the viewfinder: Space or Enter takes the photo, Up / `+` / `=` zooms in (narrower field of
 * view), Down / `-` zooms out, Escape closes. Other keys are not consumed.
 */
export function reduceCameraKey(state: CameraState, key: string): CameraKeyResult {
  switch (key) {
    case ' ':
    case 'Enter':
      return { state, emit: { kind: 'shutter', fovDeg: state.fovDeg }, consumed: true };
    case 'ArrowUp':
    case '+':
    case '=':
    case 'ArrowDown':
    case '-':
    case '_': {
      const zoomIn = key === 'ArrowUp' || key === '+' || key === '=';
      const fovDeg = clampFov(state.fovDeg + (zoomIn ? -CAMERA_FOV_STEP : CAMERA_FOV_STEP));
      return { state: { fovDeg }, emit: fovDeg === state.fovDeg ? null : { kind: 'fov', fovDeg }, consumed: true };
    }
    case 'Escape':
      return { state, emit: { kind: 'close' }, consumed: true };
    default:
      return { state, emit: null, consumed: false };
  }
}

interface CameraDom {
  readonly root: HTMLDivElement;
  readonly fov: HTMLDivElement;
  readonly place: HTMLDivElement;
  readonly caption: HTMLDivElement;
}

const HEADLESS_ELEMENT = {} as HTMLElement;

/**
 * Camera mode (design §10.4): a non-pausing `Menu` drawing a viewfinder frame, the field of view, the case and room
 * and the last caption. Space / Enter (the app also maps `officer.fire`: call `shutter()`) takes the photo through
 * `handlers.shutter`; Escape closes through `handlers.close`. Headless it keeps the state and key handling only.
 */
export class CameraOverlay implements Menu {
  readonly id = 'inv-camera' as const;
  readonly element: HTMLElement;
  readonly pausesGame = false as const;

  private readonly ui: UIRoot | null;
  private readonly dom: CameraDom | null;
  private st: CameraState = createCameraState();
  private info: CameraInfo | null = null;
  private handlers: CameraHandlers | null = null;
  private openFlag = false;

  constructor(ui: UIRoot | null) {
    this.ui = ui;
    this.dom = ui !== null && typeof document !== 'undefined' ? build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** The current field of view (read it to set the camera). */
  get state(): CameraState {
    return this.st;
  }

  open(info: CameraInfo, handlers: CameraHandlers, fovDeg: number = PHOTO_FOV_DEFAULT): void {
    this.info = info;
    this.handlers = handlers;
    this.st = createCameraState(fovDeg);
    this.openFlag = true;
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
    handlers.fov(this.st.fovDeg);
  }

  /** Replaces the case, room and caption lines. */
  update(info: CameraInfo): void {
    this.info = info;
    this.render();
  }

  /** The shutter (also for a mouse button the app maps). */
  shutter(): void {
    if (this.openFlag) this.handlers?.shutter(this.st.fovDeg);
  }

  /** Closes the viewfinder without calling `handlers.close`. */
  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.handlers = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onHide(): void {
    // Popped by someone else (the menu stack was cleared): the user left camera mode.
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) this.finish();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    const r = reduceCameraKey(this.st, event.key);
    this.st = r.state;
    const emit = r.emit;
    const h = this.handlers;
    if (emit && h) {
      if (emit.kind === 'shutter') {
        // A held key repeats zoom, never the shutter.
        if (!event.repeat) h.shutter(emit.fovDeg);
      } else if (emit.kind === 'fov') {
        h.fov(emit.fovDeg);
      } else {
        this.finish();
        return true;
      }
    }
    this.render();
    return r.consumed;
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private finish(): void {
    const h = this.handlers;
    this.openFlag = false;
    this.handlers = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
    h?.close();
  }

  private render(): void {
    const dom = this.dom;
    const info = this.info;
    if (!dom || !info) return;
    setText(dom.fov, `FOV ${String(Math.round(this.st.fovDeg))}°`);
    setText(dom.place, `${info.caseLabel} · ${info.room}`);
    setText(dom.caption, info.caption);
  }
}

function build(): CameraDom {
  const root = div('inv-camera');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Camera');
  div('inv-cam-frame', root);
  const top = div('inv-cam-top', root);
  const fov = div('inv-cam-fov', top);
  const place = div('inv-cam-place', top);
  const bottom = div('inv-cam-bottom', root);
  const caption = div('inv-cam-caption', bottom);
  const hint = div('inv-cam-hint', bottom);
  hint.textContent = 'Space / Enter photo · ↑↓ zoom · Esc close';
  return { root, fov, place, caption };
}
