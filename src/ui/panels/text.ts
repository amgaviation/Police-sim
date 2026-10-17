/** Pure text helpers for the panels (design §13.3); no DOM. */

/** One radio log line (from a radio transmission; the integrator maps `Transmission` to this). */
export interface RadioLine {
  readonly id: number;
  /** Channel tag as displayed, e.g. 'DISP' (the channel's short name). */
  readonly channel: string;
  readonly speaker: string;
  readonly text: string;
  /** Game clock 'HH:MM'. */
  readonly clock: string;
  readonly blocked: boolean;
  readonly priority: boolean;
  /** The player's own transmission. */
  readonly self: boolean;
}

export type RadioVoiceState = 'off' | 'ready' | 'listening' | 'unavailable';

/** Channel strip state (design §13.3). */
export interface RadioStatusView {
  /** Selected channel as displayed, e.g. 'DISP'. */
  readonly channel: string;
  readonly scanning: boolean;
  /** Player keyed up. */
  readonly tx: boolean;
  /** An audible transmission is playing. */
  readonly rx: boolean;
  /** Selected channel has an active transmission. */
  readonly busy: boolean;
  /** Emergency active (button pressed / channel held). */
  readonly emergency: boolean;
  /** Radio mode setting: 'tenCode' or 'plain'. */
  readonly mode: string;
  readonly voice: RadioVoiceState;
  /** Emergency button hold progress 0..1. */
  readonly emergencyCharge: number;
}

/** Number keys for the panels: '1'..'9' -> 0..8, anything else null. */
export function panelKeyToIndex(key: string): number | null {
  if (key.length !== 1) return null;
  const c = key.charCodeAt(0);
  return c >= 49 && c <= 57 ? c - 49 : null;
}

/** Number badge of option `index`: '1'..'9', '' from the tenth option on (reachable with the arrows). */
export function panelBadge(index: number): string {
  return index >= 0 && index < 9 ? String(index + 1) : '';
}

/** Radio log line: 'HH:MM CH Speaker: text', with ' [blocked]' for a stepped-on transmission. */
export function radioLineText(line: RadioLine): string {
  const head = line.clock === '' ? line.channel : `${line.clock} ${line.channel}`;
  const who = line.speaker === '' ? '' : `${line.speaker}: `;
  return `${head} ${who}${line.text}${line.blocked ? ' [blocked]' : ''}`;
}

/** Display label of a radio mode setting. */
export function radioModeLabel(mode: string): string {
  if (mode === 'tenCode') return '10-CODE';
  if (mode === 'plain') return 'PLAIN';
  return mode.toUpperCase();
}

const VOICE_LABEL: Readonly<Record<RadioVoiceState, string>> = {
  off: '',
  unavailable: '',
  ready: 'VOICE READY',
  listening: 'LISTENING',
};

/**
 * Channel strip text: 'DISP · SCAN · TX · EMERG · 10-CODE · VOICE READY'. TX wins over BUSY,
 * which wins over RX; voice commands show only when enabled and available.
 */
export function radioStatusText(s: RadioStatusView): string {
  let out = s.channel.toUpperCase();
  if (s.scanning) out += ' · SCAN';
  if (s.tx) out += ' · TX';
  else if (s.busy) out += ' · BUSY';
  else if (s.rx) out += ' · RX';
  if (s.emergency) out += ' · EMERG';
  const mode = radioModeLabel(s.mode);
  if (mode !== '') out += ` · ${mode}`;
  const voice = VOICE_LABEL[s.voice];
  if (voice !== '') out += ` · ${voice}`;
  return out;
}

/** Emergency hold bar width in 5 % steps ('0%'..'100%'), so the DOM changes at most 20 times per hold. */
export function chargeWidth(charge: number): string {
  const c = Number.isFinite(charge) ? Math.min(1, Math.max(0, charge)) : 0;
  return `${String(Math.round(c * 20) * 5)}%`;
}

/** Radio menu option line: '1 Status ▸'. */
export function radioMenuOptionText(o: { readonly key: number; readonly label: string }): string {
  return `${String(o.key)} ${o.label}`;
}
