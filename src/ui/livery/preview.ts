/**
 * Live-preview helpers of the livery editor (Phase 7 §12.1): the pure orbit-camera pose around the vehicle in the
 * station lot, the accumulated orbit state the app keeps from `host.orbit` deltas, and the 100 ms throttle for
 * `host.preview`. Nothing here touches the simulation.
 */

export interface PreviewTarget {
  x: number;
  y: number;
  z: number;
  /** Vehicle heading (rad, 0 = facing -Z, the project convention). */
  yaw: number;
}

export interface PreviewDims {
  length: number;
  width: number;
  height: number;
}

export interface PreviewPose {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
}

/**
 * Camera position and look-at point of an orbit around the vehicle at `target` (y = the vehicle's ground height).
 * `yaw` is the angle around the vehicle relative to its heading (0 = behind it, pi / 2 = its right side, pi = in
 * front of it, -pi / 2 = its left side), `pitch` the elevation (rad, 0 = level) and `zoom` a distance multiplier (1 = the default
 * framing). The camera always looks at the middle of the body. Writes into `out` and returns it.
 */
export function liveryPreviewPose(target: PreviewTarget, dims: PreviewDims, yaw: number, pitch: number, zoom: number, out: PreviewPose): PreviewPose {
  const lookY = target.y + dims.height * 0.5 + 0.4;
  const radius = (Math.hypot(dims.length, dims.width) * 0.5 + dims.height + 2.5) * zoom;
  const a = target.yaw + yaw;
  const horizontal = Math.cos(pitch) * radius;
  out.lookX = target.x;
  out.lookY = lookY;
  out.lookZ = target.z;
  out.x = target.x + Math.sin(a) * horizontal;
  out.y = lookY + Math.sin(pitch) * radius;
  out.z = target.z + Math.cos(a) * horizontal;
  return out;
}

/** Accumulated orbit angles and zoom. */
export interface OrbitState {
  yaw: number;
  pitch: number;
  zoom: number;
}

/** Limits of the orbit (rad, multiplier). */
export const ORBIT_LIMITS = { pitchMin: -0.1, pitchMax: 1.35, zoomMin: 0.5, zoomMax: 2.5 } as const;
/** Radians of orbit per pixel of mouse drag. */
export const ORBIT_RAD_PER_PX = 0.008;
/** Zoom change per wheel delta unit (pixels). */
export const ORBIT_ZOOM_PER_WHEEL = 0.001;

/** The editor's opening view: a three-quarter view from the front left, slightly raised. */
export function createOrbit(): OrbitState {
  return { yaw: -2.4, pitch: 0.3, zoom: 1 };
}

/** Applies the deltas `host.orbit` receives to `s` in place (pitch and zoom clamped, yaw wrapped) and returns it. */
export function orbitBy(s: OrbitState, dYaw: number, dPitch: number, dZoom: number): OrbitState {
  const TWO_PI = Math.PI * 2;
  let yaw = s.yaw + dYaw;
  yaw -= TWO_PI * Math.floor((yaw + Math.PI) / TWO_PI);
  s.yaw = yaw;
  s.pitch = Math.min(ORBIT_LIMITS.pitchMax, Math.max(ORBIT_LIMITS.pitchMin, s.pitch + dPitch));
  s.zoom = Math.min(ORBIT_LIMITS.zoomMax, Math.max(ORBIT_LIMITS.zoomMin, s.zoom + dZoom));
  return s;
}

/** Minimum time between `host.preview` calls (ms). */
export const PREVIEW_INTERVAL_MS = 100;

export interface ThrottleTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: ThrottleTimers = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Leading-and-trailing throttle: the first value fires at once, later values within `intervalMs` replace each other
 * and the last one fires when the interval is over. The clock and timers are injectable for tests.
 */
export class Throttle<T> {
  private readonly fire: (value: T) => void;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly timers: ThrottleTimers;
  private last = -Infinity;
  private pending: { value: T } | null = null;
  private handle: unknown = null;

  constructor(fire: (value: T) => void, intervalMs = PREVIEW_INTERVAL_MS, clock: () => number = () => performance.now(), timers: ThrottleTimers = DEFAULT_TIMERS) {
    this.fire = fire;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.timers = timers;
  }

  push(value: T): void {
    this.pending = { value };
    const wait = this.intervalMs - (this.clock() - this.last);
    if (wait <= 0) {
      this.flush();
    } else if (this.handle === null) {
      this.handle = this.timers.set(() => {
        this.handle = null;
        this.flush();
      }, wait);
    }
  }

  /** Fires the pending value now, if any. */
  flush(): void {
    if (this.handle !== null) {
      this.timers.clear(this.handle);
      this.handle = null;
    }
    const p = this.pending;
    if (p === null) return;
    this.pending = null;
    this.last = this.clock();
    this.fire(p.value);
  }

  /** Drops the pending value and the timer. */
  cancel(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
    this.pending = null;
  }
}
