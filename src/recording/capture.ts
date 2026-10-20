/**
 * Snapshot capture (design phase 5 §8.3): when a frame is due and the synchronous 16:9 crop-and-downscale of the
 * rendered canvas. Presentation only: the scheduler reads sim time but nothing here feeds back into the simulation.
 */
import { RECORDING, type RecordingConfig } from './data';

/** Camera state bits carried on every incident event (design §4.3; legal's `CAM` is the same table). */
export const CAM_BITS = { body: 1, muted: 2, dash: 4 } as const;

/**
 * Decides when to take a snapshot. The camera records while the body bit is set without the muted bit, or the dash bit
 * is set; a snapshot is due every `intervalS` sim seconds of recording, at the first recording frame of a new incident,
 * and when `immediate()` was asked while recording (a request made while the cameras are off is dropped, there is no footage).
 */
export class SnapshotScheduler {
  private readonly intervalS: number;
  private lastSim = Number.NEGATIVE_INFINITY;
  private lastIncident = '';
  private wantNow = false;

  constructor(cfg: RecordingConfig = RECORDING) {
    this.intervalS = cfg.intervalS;
  }

  /** True when a snapshot is due now. Call once per frame; allocation free. */
  due(sim: number, cam: number, incident: string): boolean {
    const recording = ((cam & CAM_BITS.body) !== 0 && (cam & CAM_BITS.muted) === 0) || (cam & CAM_BITS.dash) !== 0;
    if (!recording) {
      this.wantNow = false;
      return false;
    }
    if (this.wantNow || incident !== this.lastIncident) return true;
    // A sim time before the last capture means a save was loaded: capture again.
    return sim < this.lastSim || sim - this.lastSim >= this.intervalS;
  }

  /** Marks a capture taken (resets the timer, clears the immediate request). */
  taken(sim: number, incident: string): void {
    this.lastSim = sim;
    this.lastIncident = incident;
    this.wantNow = false;
  }

  /** Asks for a capture on the next recording frame (force applied, arrest). */
  immediate(): void {
    this.wantNow = true;
  }
}

let scratch: HTMLCanvasElement | null = null;

/**
 * Draws `canvas` centre-cropped to 16:9 into a reused `w`×`h` 2D canvas synchronously (call it right after
 * `renderer.render()` in the same task, while the drawing buffer is still valid), then encodes it as JPEG.
 * Resolves null without a DOM, for an empty canvas, or when drawing or encoding fails.
 */
export function captureSnapshot(canvas: HTMLCanvasElement, w: number, h: number, quality: number): Promise<Blob | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  try {
    if (canvas.width <= 0 || canvas.height <= 0) return Promise.resolve(null);
    const target = (scratch ??= document.createElement('canvas'));
    if (target.width !== w) target.width = w;
    if (target.height !== h) target.height = h;
    const ctx = target.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    const sw = Math.min(canvas.width, (canvas.height * w) / h);
    const sh = (sw * h) / w;
    ctx.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, 0, 0, w, h);
    return new Promise<Blob | null>((resolve) => {
      try {
        // toBlob snapshots the bitmap when called, so reusing the canvas next frame is safe.
        target.toBlob((blob) => {
          resolve(blob);
        }, 'image/jpeg', quality);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return Promise.resolve(null);
  }
}
