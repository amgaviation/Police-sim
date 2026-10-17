import './panels.css';
import { div, radioColumn, removeFromColumn, setClass, setText } from './dom';
import { chargeWidth, radioLineText, radioStatusText, type RadioLine, type RadioStatusView } from './text';

/** Lines shown in the log. */
export const RADIO_VISIBLE_LINES = 6;
/** Lines kept in `lines`. */
export const RADIO_LINE_CAP = 50;
/** Minimum time between channel strip writes (4 Hz). */
export const RADIO_STATUS_MS = 250;

interface PanelDom {
  readonly root: HTMLDivElement;
  readonly log: HTMLDivElement;
  readonly rows: HTMLDivElement[];
  readonly strip: HTMLDivElement;
  readonly stripText: HTMLSpanElement;
  readonly charge: HTMLDivElement;
  readonly chargeBar: HTMLDivElement;
  readonly caption: HTMLDivElement;
}

/** CSS class list of a log line. */
export function radioLineClass(line: RadioLine): string {
  let c = 'radio-line';
  if (line.self) c += ' radio-self';
  if (line.priority) c += ' radio-priority';
  if (line.blocked) c += ' radio-blocked';
  return c;
}

/**
 * Always-visible radio log (left, above the minimap): the last 6 transmissions with their
 * time, channel tag, speaker and text (stepped-on lines marked, own lines highlighted,
 * priority lines red), a channel strip (channel, SCAN, TX/RX/BUSY, EMERG, mode, voice,
 * emergency hold bar) written at most 4 Hz, and the caption line (bottom-centre) for the
 * latest audible transmission. Lines are written on events only. Headless (null parent or
 * no `document`) it keeps the buffer, the strip text and the caption state.
 */
export class RadioPanel {
  private readonly dom: PanelDom | null;
  private readonly buffer: RadioLine[] = [];
  private captionText: string | null = null;
  private captionUntil = 0;
  private statusShown = '';
  private chargeShown = '';
  private flagsShown = -1;
  private lastStatusMs = -Infinity;
  private visible = true;

  constructor(parent: HTMLElement | null) {
    this.dom = parent !== null && typeof document !== 'undefined' ? build(parent) : null;
  }

  /** Oldest first, at most `RADIO_LINE_CAP`. */
  get lines(): readonly RadioLine[] {
    return this.buffer;
  }

  /** Caption text while shown, else null. */
  get caption(): string | null {
    return this.captionText;
  }

  /** Channel strip text as last written. */
  get statusText(): string {
    return this.statusShown;
  }

  addLine(line: RadioLine): void {
    this.buffer.push(line);
    if (this.buffer.length > RADIO_LINE_CAP) this.buffer.splice(0, this.buffer.length - RADIO_LINE_CAP);
    this.renderLines();
  }

  /** Marks the line with transmission id `id` as stepped on (no-op when unknown or already marked). */
  markBlocked(id: number): void {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const line = this.buffer[i] as RadioLine;
      if (line.id !== id) continue;
      if (line.blocked) return;
      this.buffer[i] = { ...line, blocked: true };
      this.renderLines();
      return;
    }
  }

  /** Channel strip; computes and writes at most every `RADIO_STATUS_MS`, and only what changed. */
  setStatus(s: RadioStatusView, nowMs: number): void {
    if (nowMs - this.lastStatusMs < RADIO_STATUS_MS) return;
    this.lastStatusMs = nowMs;
    const text = radioStatusText(s);
    const charge = s.emergency ? '' : chargeWidth(s.emergencyCharge);
    const flags = (s.tx ? 1 : 0) | (s.busy ? 2 : 0) | (s.emergency ? 4 : 0);
    const dom = this.dom;
    if (text !== this.statusShown) {
      this.statusShown = text;
      if (dom) setText(dom.stripText, text);
    }
    if (flags !== this.flagsShown) {
      this.flagsShown = flags;
      if (dom) setClass(dom.strip, `radio-strip${s.tx ? ' radio-tx' : ''}${s.busy && !s.tx ? ' radio-busy' : ''}${s.emergency ? ' radio-emerg' : ''}`);
    }
    if (charge !== this.chargeShown) {
      this.chargeShown = charge;
      if (dom) {
        dom.charge.hidden = charge === '' || charge === '0%';
        dom.chargeBar.style.width = charge === '' ? '0%' : charge;
      }
    }
  }

  /** Shows `text` on the caption line until `untilMs` (`update` hides it); null or '' hides it now. */
  setCaption(text: string | null, untilMs: number): void {
    this.captionText = text === null || text === '' ? null : text;
    this.captionUntil = untilMs;
    const dom = this.dom;
    if (!dom) return;
    if (this.captionText !== null) setText(dom.caption, this.captionText);
    dom.caption.hidden = this.captionText === null || !this.visible;
  }

  /** Expires the caption. */
  update(nowMs: number): void {
    if (this.captionText !== null && nowMs >= this.captionUntil) this.setCaption(null, 0);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    const dom = this.dom;
    if (!dom) return;
    dom.root.hidden = !visible;
    dom.caption.hidden = !visible || this.captionText === null;
  }

  dispose(): void {
    const dom = this.dom;
    if (!dom) return;
    removeFromColumn(dom.root);
    dom.caption.remove();
  }

  private renderLines(): void {
    const dom = this.dom;
    if (!dom) return;
    const first = this.buffer.length - RADIO_VISIBLE_LINES;
    for (let k = 0; k < RADIO_VISIBLE_LINES; k++) {
      const row = dom.rows[k] as HTMLDivElement;
      const line = this.buffer[first + k];
      row.hidden = line === undefined;
      if (!line) continue;
      setText(row, radioLineText(line));
      setClass(row, radioLineClass(line));
    }
  }
}

function build(parent: HTMLElement): PanelDom {
  const root = div('radio-panel', radioColumn(parent));
  root.setAttribute('aria-live', 'off');
  const log = div('radio-log', root);
  const rows: HTMLDivElement[] = [];
  for (let k = 0; k < RADIO_VISIBLE_LINES; k++) {
    const row = div('radio-line', log);
    row.hidden = true;
    rows.push(row);
  }
  const strip = div('radio-strip', root);
  const stripText = document.createElement('span');
  strip.appendChild(stripText);
  const charge = div('radio-charge', strip);
  charge.hidden = true;
  const chargeBar = div('radio-charge-bar', charge);
  const caption = div('radio-caption', parent);
  caption.hidden = true;
  return { root, log, rows, strip, stripText, charge, chargeBar, caption };
}
