/** Pure text helpers for the Phase 5 HUD additions (design §12.4): force tool, cameras, legal line, duty, court, trust. No DOM. */

/** The force tool and its ammunition (fed from `ForceSystem.hud`). */
export interface HudForce {
  /** Tool label, e.g. 'TASER'; '' or 'none' = holstered. */
  tool: string;
  /** 'n/max' or ''. */
  ammo: string;
  /** TASER probes are attached to a subject. */
  attached: boolean;
  /** Fellow-officer misconduct episode text (the H key intervenes); null when none. */
  episode: string | null;
}

/** Bodycam and dashcam state (fed from `IncidentSystem.cam`). */
export interface HudCam {
  body: boolean;
  muted: boolean;
  dash: boolean;
  /** The officer wears a bodycam (shows 'CAM' while it is off). */
  worn: boolean;
}

export type LegalSeverity = 'ok' | 'warn' | 'bad';

/** The last force verdict / advisory line (the feed keeps it about 6 s). */
export interface HudLegal {
  text: string;
  severity: LegalSeverity;
}

/** The community trust of the district the officer is in. */
export interface HudTrust {
  district: string;
  /** 0..1. */
  value: number;
}

export type TrustBand = 'low' | 'mid' | 'high';
export type CamChipState = 'none' | 'off' | 'muted' | 'rec';

/** Trust below this is red. */
export const TRUST_LOW = 0.3;
/** Trust below this (and not low) is amber, else green. */
export const TRUST_MID = 0.5;

/** 'TASER 2/2 · PROBES' / 'SIDEARM'; '' when holstered, unknown or without force state. */
export function forceChipText(f: Readonly<HudForce> | null | undefined): string {
  if (!f || f.tool === '' || f.tool === 'none') return '';
  let out = f.tool.toUpperCase();
  if (f.ammo !== '') out = `${out} ${f.ammo}`;
  return f.attached ? `${out} · PROBES` : out;
}

/** The misconduct episode line, upper-cased ('' without one). */
export function forceEpisodeText(f: Readonly<HudForce> | null | undefined): string {
  return f?.episode ? f.episode.toUpperCase() : '';
}

/** Which bodycam chip shows: recording (body, not muted), muted (body and muted), off (worn, not recording) or none. */
export function camChipState(c: Readonly<HudCam> | null | undefined): CamChipState {
  if (!c) return 'none';
  if (c.body) return c.muted ? 'muted' : 'rec';
  return c.worn ? 'off' : 'none';
}

/** '● REC' / 'MUTED' / 'CAM' / ''. */
export function camChipText(c: Readonly<HudCam> | null | undefined): string {
  switch (camChipState(c)) {
    case 'rec':
      return '● REC';
    case 'muted':
      return 'MUTED';
    case 'off':
      return 'CAM';
    default:
      return '';
  }
}

/** 'DASH' while the dashcam records, else ''. */
export function dashChipText(c: Readonly<HudCam> | null | undefined): string {
  return c?.dash ? 'DASH' : '';
}

/** The legal line text; '' without one. */
export function legalLineText(l: Readonly<HudLegal> | null | undefined): string {
  return l?.text ?? '';
}

/** Line accent per severity. */
export const LEGAL_COLORS: Readonly<Record<LegalSeverity, string>> = {
  ok: '#5fd35f',
  warn: '#f2c14e',
  bad: '#ff5a5a',
};

/** Clamps a trust value to 0..1 (NaN -> 0). */
export function clampTrust(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Colour band of a trust value: < 0.3 low (red), < 0.5 mid (amber), else high (green). */
export function trustBand(value: number): TrustBand {
  const v = clampTrust(value);
  return v < TRUST_LOW ? 'low' : v < TRUST_MID ? 'mid' : 'high';
}

/** 'Trust · Suburbs 62 %' ('' without a trust reading). */
export function trustChipText(t: Readonly<HudTrust> | null | undefined): string {
  if (!t) return '';
  const pct = String(Math.round(clampTrust(t.value) * 100));
  return t.district === '' ? `Trust · ${pct} %` : `Trust · ${t.district} ${pct} %`;
}

/** Colour per trust band. */
export const TRUST_COLORS: Readonly<Record<TrustBand, string>> = {
  low: '#ff5a5a',
  mid: '#f2c14e',
  high: '#5fd35f',
};
