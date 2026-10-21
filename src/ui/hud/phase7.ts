/** Phase 7 HUD text helpers (design §12.4): wear chips, altitude, battery, fleet chip and gear warning. Pure, no DOM. */

/** Oil or tread fraction below which the chip shows. */
export const WEAR_LOW_FRACTION = 0.25;

/** Maintenance state of the driven vehicle: oil level and the lowest tyre tread, both 0..1. */
export interface HudWear {
  oil: number;
  tread: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** The 'OIL LOW' chip shows below `WEAR_LOW_FRACTION`. */
export function oilLowFlag(wear: Readonly<HudWear> | null | undefined): boolean {
  return wear !== null && wear !== undefined && clamp01(wear.oil) < WEAR_LOW_FRACTION;
}

/** The 'TYRES WORN' chip shows below `WEAR_LOW_FRACTION`. */
export function tyresWornFlag(wear: Readonly<HudWear> | null | undefined): boolean {
  return wear !== null && wear !== undefined && clamp01(wear.tread) < WEAR_LOW_FRACTION;
}

/** 'ALT 120 m' (whole metres, never negative); '' without an altitude. */
export function altitudeText(metres: number | null | undefined): string {
  if (metres === null || metres === undefined || !Number.isFinite(metres)) return '';
  return `ALT ${String(Math.max(0, Math.round(metres)))} m`;
}

/** 'BATT 64 %' from a 0..1 fraction; '' without a battery. */
export function batteryText(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '';
  return `BATT ${String(Math.round(clamp01(fraction) * 100))} %`;
}

/** The fleet chip text ('P-101 · damage report due'); '' hides it. */
export function fleetChipText(text: string | null | undefined): string {
  return text ?? '';
}

/** The gear warning line ('Loadout: overweight 15.2 / 14 kg'); '' hides it. */
export function gearWarningText(text: string | null | undefined): string {
  return text ?? '';
}
