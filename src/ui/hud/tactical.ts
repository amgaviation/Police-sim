import type { HudBodycam, HudLocation, HudTactical } from './types';

/** Pure text helpers for the Phase 4 HUD additions (design §11.3); no DOM. */

/** Steps of the noise meter. */
export const NOISE_STEPS = 5;

/** Lit steps (0..NOISE_STEPS) of a noise level 0..1; any audible noise lights at least one step. */
export function noiseSteps(noise: number): number {
  if (!Number.isFinite(noise) || noise <= 0) return 0;
  return Math.min(NOISE_STEPS, Math.ceil(Math.min(1, noise) * NOISE_STEPS));
}

/** '■■■□□' for a noise level. */
export function noiseMeterText(noise: number): string {
  const lit = noiseSteps(noise);
  return '■'.repeat(lit) + '□'.repeat(NOISE_STEPS - lit);
}

/** 'CROUCH · LEAN L · SLICE · LIGHT' (only the active states); '' when nothing is active or without tactical state. */
export function tacticalChipsText(t: Readonly<HudTactical> | null | undefined): string {
  if (!t) return '';
  const parts: string[] = [];
  if (t.crouched) parts.push('CROUCH');
  if (t.lean < 0) parts.push('LEAN L');
  else if (t.lean > 0) parts.push('LEAN R');
  if (t.slicing) parts.push('SLICE');
  if (t.flashlight) parts.push('LIGHT');
  return parts.join(' · ');
}

/** 'VIS 60%' (visibility 0..1); '' without tactical state. */
export function visibilityText(t: Readonly<HudTactical> | null | undefined): string {
  if (!t) return '';
  const v = Number.isFinite(t.visibility) ? Math.min(1, Math.max(0, t.visibility)) : 0;
  return `VIS ${String(Math.round(v * 100))}%`;
}

/** '● REC' while recording, 'CAM' when worn but off, '' without a bodycam. */
export function bodycamChipText(b: Readonly<HudBodycam> | null | undefined): string {
  if (!b) return '';
  return b.recording ? '● REC' : 'CAM';
}

/** 'House · Kitchen' (empty parts omitted); '' without a location. */
export function locationChipText(l: Readonly<HudLocation> | null | undefined): string {
  if (!l) return '';
  return l.building !== '' && l.room !== '' ? `${l.building} · ${l.room}` : l.building !== '' ? l.building : l.room;
}
