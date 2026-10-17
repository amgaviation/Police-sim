import { formatDistance } from './format';

/** Pure text helpers for the Phase 2 HUD additions (design §13.3); no DOM. */

/** Police equipment state of the driven patrol car. */
export interface HudPolice {
  lights: boolean;
  /** Light-bar pattern label, e.g. 'alt'; upper-cased for display. */
  pattern: string;
  /** Siren tone label, '' when off, e.g. 'WAIL'. */
  siren: string;
  horn: boolean;
  spot: boolean;
}

export type TargetSeverity = 'none' | 'clear' | 'caution' | 'alert';

/** Locked target vehicle and the latest plate-run result for it. */
export interface HudTarget {
  plate: string;
  /** e.g. '2019 black Sedan'. */
  description: string;
  /** Result line, e.g. 'NO WANTS · VALID REG'; '' while not run. */
  result: string;
  severity: TargetSeverity;
}

/** The player's active call. */
export interface HudCall {
  /** Display number, e.g. 'C-00042'. */
  number: string;
  /** 1..4. */
  priority: number;
  nature: string;
  address: string;
  /** e.g. 'En route'; upper-cased for display. */
  status: string;
  /** Straight-line distance to the call (m); negative or non-finite hides it. */
  distanceM: number;
}

/** The player's unit. */
export interface HudUnit {
  callsign: string;
  /** Status label, e.g. '10-8 Available'; upper-cased for display. */
  status: string;
  emergency: boolean;
  statusCheck: boolean;
}

/** Police status line: 'LIGHTS ALT · SIREN WAIL · HORN · SPOT', parts omitted when off; '' when nothing is on. */
export function policeStatusText(p: Readonly<HudPolice> | null | undefined): string {
  if (!p) return '';
  let out = '';
  if (p.lights) out = p.pattern === '' ? 'LIGHTS' : `LIGHTS ${p.pattern.toUpperCase()}`;
  if (p.siren !== '') out = join(out, `SIREN ${p.siren.toUpperCase()}`);
  if (p.horn) out = join(out, 'HORN');
  if (p.spot) out = join(out, 'SPOT');
  return out;
}

function join(a: string, b: string): string {
  if (a === '') return b;
  return b === '' ? a : `${a} · ${b}`;
}

/** Unit chip: '12 · 10-8 AVAILABLE' ('' without a unit). The emergency and status-check flags are separate chips. */
export function unitChipText(u: Readonly<HudUnit> | null | undefined): string {
  if (!u) return '';
  const status = u.status.toUpperCase();
  return status === '' ? u.callsign : `${u.callsign} · ${status}`;
}

export interface CallStripText {
  /** 'C-00042  P2  Noise complaint'. */
  title: string;
  address: string;
  /** 'EN ROUTE · 1.2 km' (m below 1 km). */
  status: string;
}

export function createCallStripText(): CallStripText {
  return { title: '', address: '', status: '' };
}

/** Clamped call priority 1..4. */
export function clampPriority(priority: number): number {
  return Number.isFinite(priority) ? Math.min(4, Math.max(1, Math.round(priority))) : 4;
}

/** Fills `out` with the call strip lines; all '' without a call. */
export function callStripText(c: Readonly<HudCall> | null | undefined, out: CallStripText = createCallStripText()): CallStripText {
  if (!c) {
    out.title = '';
    out.address = '';
    out.status = '';
    return out;
  }
  out.title = `${c.number}  P${String(clampPriority(c.priority))}  ${c.nature}`;
  out.address = c.address;
  out.status = join(c.status.toUpperCase(), formatDistance(c.distanceM));
  return out;
}

export interface TargetText {
  show: boolean;
  /** 'ABC 1234 · 2019 black Sedan'. */
  label: string;
  /** '' when hidden (severity 'none' or no result yet). */
  result: string;
  severity: TargetSeverity;
}

export function createTargetText(): TargetText {
  return { show: false, label: '', result: '', severity: 'none' };
}

/** Fills `out` with the target reticle lines; `show` is false without a target. */
export function targetText(t: Readonly<HudTarget> | null | undefined, out: TargetText = createTargetText()): TargetText {
  if (!t) {
    out.show = false;
    out.label = '';
    out.result = '';
    out.severity = 'none';
    return out;
  }
  out.show = true;
  out.label = t.description === '' ? t.plate : join(t.plate, t.description);
  const visible = t.severity !== 'none' && t.result !== '';
  out.result = visible ? t.result : '';
  out.severity = visible ? t.severity : 'none';
  return out;
}

/** Colour per call priority P1..P4 (index priority - 1); shared by the call strip and the minimap. */
export const PRIORITY_COLORS = ['#ff4d4d', '#ff9a3c', '#f2d23c', '#9a9a9a'] as const;

export function priorityColor(priority: number): string {
  return PRIORITY_COLORS[clampPriority(priority) - 1] ?? PRIORITY_COLORS[3];
}

/** Result-line colour per severity ('' for none). */
export const SEVERITY_COLORS: Readonly<Record<TargetSeverity, string>> = {
  none: '',
  clear: '#5fd35f',
  caution: '#f2c14e',
  alert: '#ff5a5a',
};
