/**
 * Small Web Audio helpers shared by the siren bank, radio FX and engine. Every
 * helper tolerates partial implementations (older browsers without the
 * `positionX`-style AudioParams) and never throws for rejected promises.
 */

/** Listener position shared by the engine (writer) and the siren bank (in-cabin voices). */
export interface ListenerState {
  x: number;
  y: number;
  z: number;
}

interface LegacyPositioned {
  setPosition?(x: number, y: number, z: number): void;
}

interface LegacyListener extends LegacyPositioned {
  setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
}

interface ParamPositioned {
  readonly positionX?: AudioParam;
  readonly positionY?: AudioParam;
  readonly positionZ?: AudioParam;
}

interface ParamOriented {
  readonly forwardX?: AudioParam;
  readonly forwardY?: AudioParam;
  readonly forwardZ?: AudioParam;
  readonly upX?: AudioParam;
  readonly upY?: AudioParam;
  readonly upZ?: AudioParam;
}

/** Writes a panner's position through its AudioParams (or the legacy `setPosition`). */
export function setNodePosition(node: PannerNode, x: number, y: number, z: number): void {
  const p = node as unknown as ParamPositioned & LegacyPositioned;
  if (p.positionX && p.positionY && p.positionZ) {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else {
    p.setPosition?.(x, y, z);
  }
}

/** Writes the listener pose through its AudioParams (or the legacy setters). */
export function setListenerPose(
  listener: AudioListener,
  x: number,
  y: number,
  z: number,
  fx: number,
  fy: number,
  fz: number,
  ux: number,
  uy: number,
  uz: number,
): void {
  const l = listener as unknown as ParamPositioned & ParamOriented & LegacyListener;
  if (l.positionX && l.positionY && l.positionZ) {
    l.positionX.value = x;
    l.positionY.value = y;
    l.positionZ.value = z;
  } else {
    l.setPosition?.(x, y, z);
  }
  if (l.forwardX && l.forwardY && l.forwardZ && l.upX && l.upY && l.upZ) {
    l.forwardX.value = fx;
    l.forwardY.value = fy;
    l.forwardZ.value = fz;
    l.upX.value = ux;
    l.upY.value = uy;
    l.upZ.value = uz;
  } else {
    l.setOrientation?.(fx, fy, fz, ux, uy, uz);
  }
}

/** Exponential approach to `value` from `time` (time constant `tau` s). */
export function glide(param: AudioParam, value: number, time: number, tau: number): void {
  param.setTargetAtTime(value, time, Math.max(0.001, tau));
}

/** Ignores a promise rejection (resume/suspend/close may reject or return nothing). */
export function swallow(result: unknown): void {
  if (result instanceof Promise) result.catch(() => undefined);
}

/** Disconnects a node, ignoring "not connected" errors. */
export function safeDisconnect(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    // already disconnected
  }
}

/** Soft-clip transfer curve `tanh(k x) / tanh(k)` over [-1, 1]. */
export function softClipCurve(samples = 1024, k = 2.5): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const norm = Math.tanh(k);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/** Fills `out` with white noise in [-1, 1) from a 32-bit LCG (deterministic, no Math.random). */
export function fillNoise(out: Float32Array, seed = 0x2545f491): void {
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s / 4294967296) * 2 - 1;
  }
}
