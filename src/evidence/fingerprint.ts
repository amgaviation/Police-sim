/**
 * Fingerprint dusting minigame model (design phase 4 §9.4): a 4x4 grid of cells, brush time per cell, an
 * over-brushing penalty. Pure; the panel feeds it cursor moves and held-brush time.
 */
import type { PrintSurface } from './types';

export const DUST_GRID = 4;
export const DUST_CELLS = DUST_GRID * DUST_GRID;
/** Coverage cap per cell. */
export const DUST_MAX_COVERAGE = 1.5;
/** Lifted quality needed for a usable print. */
export const USABLE_QUALITY = 0.35;

export interface DustState {
  surface: PrintSurface;
  hasPrint: boolean;
  personId: number;
  /** 0..1 best achievable quality. */
  base: number;
  /** 16 cells, 0..1.5. */
  coverage: number[];
  /** 0..15, row-major. */
  cursor: number;
  overbrush: number;
  lifted: boolean;
}

export const SURFACE_QUALITY: Readonly<Record<PrintSurface, number>> = {
  glass: 0.9,
  metal: 0.8,
  stone: 0.6,
  wood: 0.55,
  fabric: 0.1,
};

/** `u` is a deterministic 0..1 draw; base = SURFACE_QUALITY * (0.6 + 0.4u). */
export function startDust(surface: PrintSurface, hasPrint: boolean, personId: number, u: number): DustState {
  return {
    surface,
    hasPrint,
    personId,
    base: SURFACE_QUALITY[surface] * (0.6 + 0.4 * u),
    coverage: new Array<number>(DUST_CELLS).fill(0),
    cursor: 0,
    overbrush: 0,
    lifted: false,
  };
}

/** Moves the cursor one cell on the 4x4 grid; clamped at the edges. */
export function moveCursor(s: DustState, dir: 'up' | 'down' | 'left' | 'right'): void {
  const row = Math.floor(s.cursor / DUST_GRID);
  const col = s.cursor % DUST_GRID;
  if (dir === 'up') s.cursor = Math.max(0, row - 1) * DUST_GRID + col;
  else if (dir === 'down') s.cursor = Math.min(DUST_GRID - 1, row + 1) * DUST_GRID + col;
  else if (dir === 'left') s.cursor = row * DUST_GRID + Math.max(0, col - 1);
  else s.cursor = row * DUST_GRID + Math.min(DUST_GRID - 1, col + 1);
}

/** Brushes the cursor cell: coverage += 2*dt; whatever passes 1.0 counts as over-brushing. No-op once lifted. */
export function brush(s: DustState, dt: number): void {
  if (s.lifted || dt <= 0) return;
  const before = s.coverage[s.cursor] ?? 0;
  const after = before + 2 * dt;
  s.overbrush += Math.max(0, after - Math.max(before, 1));
  s.coverage[s.cursor] = Math.min(DUST_MAX_COVERAGE, after);
}

/** quality = base * mean(min(1, coverage)) - 0.15 * overbrush (clamped 0..1); usable when hasPrint && quality >= 0.35. */
export function lift(s: DustState): { quality: number; usable: boolean; personId: number } {
  s.lifted = true;
  let sum = 0;
  for (let i = 0; i < DUST_CELLS; i++) sum += Math.min(1, s.coverage[i] ?? 0);
  const quality = Math.min(1, Math.max(0, s.base * (sum / DUST_CELLS) - 0.15 * s.overbrush));
  return { quality, usable: s.hasPrint && quality >= USABLE_QUALITY, personId: s.personId };
}
