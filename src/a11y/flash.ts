/**
 * Photosensitivity helpers (design §9.4). Presentation only. Nothing in the UI may change brightness faster than
 * `MAX_FLASH_HZ` (three flashes per second, the WCAG general-flash threshold); with reduced flash on, highlights hold
 * a constant level.
 */

/** Most brightness changes per second any UI element or light may make. */
export const MAX_FLASH_HZ = 3;

/** Pulse frequency used for UI highlights (well under `MAX_FLASH_HZ`). */
const PULSE_HZ = 1;

/** 0..1 pulse for a UI highlight at `tMs`: a 1 Hz sine when allowed; constant 1 when `reduced`. */
export function pulse(tMs: number, reduced: boolean): number {
  if (reduced) return 1;
  return 0.5 + 0.5 * Math.sin((tMs / 1000) * PULSE_HZ * 2 * Math.PI);
}

/** True when the document asks for reduced flashing (`<html data-reduced-flash="true">`); false without a DOM. */
export function isReducedFlash(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.dataset['reducedFlash'] === 'true';
}
