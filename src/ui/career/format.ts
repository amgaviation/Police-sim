/** Text and severity helpers shared by the career screens (Phase 8 §11). Pure, no DOM. */
import { formatClockTime, formatStamp } from '../../records/calendar';
import { formatMoney, formatPercent } from '../fleet/format';

export { formatMoney, formatPercent };

export type Severity = 'clear' | 'caution' | 'alert';

/** Wellbeing level where a HIGH value is bad (fatigue, stress): caution from `caution`, alert from `alert`. */
export function highIsBad(value: number, caution: number, alert: number): Severity {
  return value >= alert ? 'alert' : value >= caution ? 'caution' : 'clear';
}

/** Wellbeing level where a LOW value is bad (health, fitness, family): caution below `caution`, alert below `alert`. */
export function lowIsBad(value: number, caution: number, alert: number): Severity {
  return value < alert ? 'alert' : value < caution ? 'caution' : 'clear';
}

/** Severity thresholds of the wellbeing bars (0..1). */
export const WELLBEING_LEVELS = {
  fatigue: { caution: 0.6, alert: 0.85 },
  stress: { caution: 0.6, alert: 0.85 },
  health: { caution: 0.6, alert: 0.4 },
  fitness: { caution: 0.4, alert: 0.2 },
  family: { caution: 0.4, alert: 0.2 },
} as const;

/** 'HH:MM' of a game time. */
export function clockText(game: number): string {
  return formatClockTime(game);
}

/** 'MM/DD/YYYY 22:00 - 06:00' for a shift window. */
export function windowText(startGame: number, endGame: number): string {
  return `${formatStamp(startGame)} - ${formatClockTime(endGame)}`;
}

/** Whole hours of a duration in game seconds, one decimal: '8 h', '6.5 h'. */
export function hoursText(hours: number): string {
  const rounded = Math.round((Number.isFinite(hours) ? hours : 0) * 10) / 10;
  return `${String(rounded)} h`;
}

/** 'Day · Downtown' from a slot and a beat id. */
export function positionLabel(slot: string, beat: string): string {
  return `${capitalize(slot)} · ${capitalize(beat)}`;
}

export function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Signed money for pay rows: '$ 240' or '-$ 240'. */
export function signedMoney(dollars: number): string {
  return formatMoney(dollars);
}
