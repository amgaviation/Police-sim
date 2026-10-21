/** Phase 8 HUD text helpers (design §11.3): wellbeing chip, shift line, course line and co-op chip. Pure, no DOM. */

export type ChipSeverity = 'clear' | 'caution' | 'alert';

/** What the integrator feeds `Hud.setCareer` (all derived from the career view and `performance()`). */
export interface HudCareer {
  /** 0..1. */
  fatigue: number;
  /** 0..1. */
  stress: number;
  /** Prepared by `shiftLine`; '' hides the line. */
  shiftLine: string;
  /** 0..1 vignette strength (`PerformanceMods.vignette`). */
  vignette: number;
}

/** Fatigue or stress from which the chip shows. */
export const WELLBEING_CHIP_FROM = 0.6;
/** Fatigue or stress from which the chip is an alert. */
export const WELLBEING_ALERT_FROM = 0.85;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * The wellbeing chip: 'FATIGUE 72 %', 'STRESS 64 %' or 'FATIGUE 72 % · STRESS 64 %' (only the values at or above 0.6),
 * 'alert' from 0.85, otherwise 'caution'; null when both are below 0.6.
 */
export function wellbeingChip(fatigue: number, stress: number): { text: string; severity: ChipSeverity } | null {
  const f = clamp01(fatigue);
  const s = clamp01(stress);
  const parts: string[] = [];
  if (f >= WELLBEING_CHIP_FROM) parts.push(`FATIGUE ${String(Math.round(f * 100))} %`);
  if (s >= WELLBEING_CHIP_FROM) parts.push(`STRESS ${String(Math.round(s * 100))} %`);
  if (parts.length === 0) return null;
  return { text: parts.join(' · '), severity: Math.max(f, s) >= WELLBEING_ALERT_FROM ? 'alert' : 'caution' };
}

/** 'HH:MM' of a game time in seconds. */
function clock(game: number): string {
  const s = ((Math.floor(Number.isFinite(game) ? game : 0) % 86400) + 86400) % 86400;
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
}

/** 'Shift 06:00-14:00' during the shift, 'OT +0:35' (whole minutes past the end) in overtime. */
export function shiftLine(nowGame: number, startGame: number, endGame: number): string {
  if (nowGame > endGame) {
    const minutes = Math.floor((nowGame - endGame) / 60);
    return `OT +${String(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
  }
  return `Shift ${clock(startGame)}-${clock(endGame)}`;
}

/** 'm:ss.t' from seconds (tenths truncated). */
function runTime(timeS: number): string {
  const tenths = Math.max(0, Math.floor((Number.isFinite(timeS) ? timeS : 0) * 10 + 1e-6));
  const seconds = Math.floor(tenths / 10) % 60;
  return `${String(Math.floor(tenths / 600))}:${pad2(seconds)}.${String(tenths % 10)}`;
}

/** 'Gate 4/8 · cones 1 · 0:42.3' from the driving course event; '' without a run. */
export function courseLine(e: { gate: number; gates: number; cones: number; timeS: number } | null): string {
  if (e === null) return '';
  return `Gate ${String(e.gate)}/${String(e.gates)} · cones ${String(e.cones)} · ${runTime(e.timeS)}`;
}

/** 'CO-OP N1 · 3 online' when connected, 'CO-OP offline' otherwise; '' without a co-op session. */
export function coopChip(s: { connected: boolean; unit: string; members: number } | null): string {
  if (s === null) return '';
  return s.connected ? `CO-OP ${s.unit} · ${String(s.members)} online` : 'CO-OP offline';
}

/** Vignette opacity: the 0..1 strength rounded to hundredths (so the DOM is written only on visible changes). */
export function vignetteOpacity(strength: number): number {
  return Math.round(clamp01(strength) * 100) / 100;
}
