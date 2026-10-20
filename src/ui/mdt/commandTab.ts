/**
 * Command tab of the MDT (design phase 6 §12.3): the incident command board as a pure view model plus a DOM renderer
 * that copies it into a container. The overlay rebuilds the container only when the command revision changes (at most
 * 4 Hz), so these functions may allocate freely.
 */
import { TRIAGE_COLORS } from '../../command/triage';
import type { CommandBoard, TriageTag, VictimRow } from '../../command/types';
import { clearChildren, el } from '../ui';
import { button } from './dom';
import { formatEta } from './model';

/** Chip text per tag: colour name first, like the tag the rescuers use. */
const TAG_WORDS: Readonly<Record<TriageTag, string>> = { minor: 'GREEN', delayed: 'YELLOW', immediate: 'RED', expectant: 'BLACK' };
const TAG_ORDER: readonly TriageTag[] = ['immediate', 'delayed', 'minor', 'expectant'];

/** One colour chip of the triage counts. */
export interface TriageChip {
  /** `null` for the untagged chip. */
  readonly tag: TriageTag | null;
  readonly label: string;
  readonly count: number;
  readonly color: string;
  /** Text colour that reads on `color`. */
  readonly textColor: string;
}

export interface CommandVictimRow {
  readonly personId: number;
  readonly label: string;
  /** 'RED', ..., '-' when untagged. */
  readonly tag: string;
  readonly by: string;
  /** '✓' graded correct, '✗' graded wrong, '' not graded. */
  readonly mark: string;
  /** 'trapped, contaminated, transported'. */
  readonly flags: string;
}

export interface CommandBar {
  readonly label: string;
  /** 0..100. */
  readonly pct: number;
  readonly text: string;
}

export interface CommandTabModel {
  /** Whether a command post is open. */
  readonly hasPost: boolean;
  /** 'DISASTER · commander 12' or 'No command post'. */
  readonly post: string;
  readonly chips: readonly TriageChip[];
  readonly victims: readonly CommandVictimRow[];
  /** 'TCP 2/4 · INNER 3/4' lines, one per staffed post kind that exists. */
  readonly staffing: readonly string[];
  readonly evac: CommandBar | null;
  /** SWAT phase text, '' none. */
  readonly swat: string;
  readonly trust: CommandBar | null;
  readonly agitation: CommandBar | null;
  /** 'ongoing · rapport stage', '' without a negotiation. */
  readonly negotiation: string;
  /** 'EMS 2, fire 1' or ''. */
  readonly needs: string;
  readonly units: readonly { readonly callsign: string; readonly label: string; readonly status: string; readonly eta: string }[];
}

function textOn(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.5 ? '#111111' : '#f2f2f2';
}

function pct(v: number): number {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v * 100))) : 0;
}

function victimFlags(v: VictimRow): string {
  const f: string[] = [];
  if (v.trapped) f.push('trapped');
  if (v.contaminated) f.push('contaminated');
  if (v.transported) f.push('transported');
  return f.join(', ');
}

/** The Command tab's content for a board. */
export function commandTabModel(board: CommandBoard): CommandTabModel {
  const chips: TriageChip[] = TAG_ORDER.map((tag) => ({
    tag,
    label: TAG_WORDS[tag],
    count: board.counts[tag],
    color: TRIAGE_COLORS[tag],
    textColor: textOn(TRIAGE_COLORS[tag]),
  }));
  chips.push({ tag: null, label: 'UNTAGGED', count: board.counts.untagged, color: '#6b6f76', textColor: '#f2f2f2' });
  const staffing: string[] = [];
  if (board.tcps.total > 0) staffing.push(`Traffic control ${String(board.tcps.staffed)}/${String(board.tcps.total)} staffed`);
  if (board.inner !== null) staffing.push(`Inner perimeter ${String(board.inner.staffed)}/${String(board.inner.total)} staffed`);
  const n = board.needs;
  const needs = [n.ems > 0 ? `EMS ${String(n.ems)}` : '', n.fire > 0 ? `fire ${String(n.fire)}` : '', n.supervisor > 0 ? `supervisor ${String(n.supervisor)}` : ''].filter((s) => s !== '').join(', ');
  const neg = board.negotiation;
  return {
    hasPost: board.post !== null,
    post: board.post ? `${board.post.level.toUpperCase()} · commander ${board.post.commander}` : 'No command post',
    chips,
    victims: board.victims.map((v) => ({
      personId: v.personId,
      label: v.label,
      tag: v.tag ? TAG_WORDS[v.tag] : '-',
      by: v.by === null ? '' : v.by === 'player' ? 'you' : 'EMS',
      mark: v.correct === null ? '' : v.correct ? '✓' : '✗',
      flags: victimFlags(v),
    })),
    staffing,
    evac: board.evac ? { label: 'Evacuation', pct: pct(board.evac.progress), text: `${String(pct(board.evac.progress))} % · ${String(Math.round(board.evac.radiusM))} m` } : null,
    swat: board.swat ?? '',
    trust: neg ? { label: 'Trust', pct: pct(neg.trust), text: `${String(pct(neg.trust))} %` } : null,
    agitation: neg ? { label: 'Agitation', pct: pct(neg.agitation), text: `${String(pct(neg.agitation))} %` } : null,
    negotiation: neg ? `${neg.outcome} · ${neg.stage} stage` : '',
    needs,
    units: board.units.map((u) => ({ callsign: u.callsign, label: u.label, status: u.status, eta: formatEta(u.etaS) })),
  };
}

/** What the buttons of the tab do. */
export interface CommandTabHandlers {
  establish(): void;
  requestNeeds(): void;
}

function bar(b: CommandBar, cls: string): HTMLElement {
  const fill = el('div', { class: `mdt-bar-fill ${cls}` });
  fill.style.width = `${String(b.pct)}%`;
  return el('div', { class: 'mdt-trust-row' },
    el('span', { class: 'mdt-trust-label' }, b.label),
    el('div', { class: 'mdt-bar', role: 'meter', 'aria-label': b.label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': b.pct }, fill),
    el('span', { class: 'mdt-trust-pct' }, b.text));
}

/** Replaces `container`'s content with the model. */
export function renderCommandTab(container: HTMLElement, m: CommandTabModel, handlers: CommandTabHandlers): void {
  clearChildren(container);
  const head = el('section', { class: 'mdt-section mdt-section-post', 'aria-label': 'Command post' }, el('h3', null, 'Command post'), el('p', { class: 'mdt-cmd-post' }, m.post));
  if (!m.hasPost) head.appendChild(el('p', { class: 'mdt-hint' }, 'The post opens by itself when you arrive at a large incident, or with this button.'));
  const establish = button(m.hasPost ? 'Command post open' : 'Establish command', () => handlers.establish(), 'small primary');
  establish.disabled = m.hasPost;
  head.appendChild(establish);
  container.appendChild(head);
  if (!m.hasPost) return;

  const chips = el('div', { class: 'mdt-chips', role: 'group', 'aria-label': 'Triage counts' });
  for (const c of m.chips) {
    const chip = el('span', { class: 'mdt-chip', title: c.label }, `${c.label} ${String(c.count)}`);
    chip.style.background = c.color;
    chip.style.color = c.textColor;
    chips.appendChild(chip);
  }
  container.appendChild(el('section', { class: 'mdt-section mdt-section-triage', 'aria-label': 'Triage' }, el('h3', null, 'Triage'), chips));

  if (m.victims.length > 0) {
    const body = el('tbody');
    for (const v of m.victims) {
      body.appendChild(el('tr', null, el('td', null, v.label), el('td', null, v.tag), el('td', null, v.by), el('td', { class: v.mark === '✗' ? 'mdt-sev-alert' : '' }, v.mark), el('td', null, v.flags)));
    }
    container.appendChild(
      el('section', { class: 'mdt-section mdt-section-victims', 'aria-label': 'Victims' }, el('h3', null, 'Victims'),
        el('table', { class: 'mdt-list', 'aria-label': 'Victims' },
          el('thead', null, el('tr', null, ...['Patient', 'Tag', 'By', 'Graded', 'Notes'].map((h) => el('th', { scope: 'col' }, h)))), body)),
    );
  }

  const ops = el('section', { class: 'mdt-section mdt-section-ops', 'aria-label': 'Operations' }, el('h3', null, 'Operations'));
  for (const s of m.staffing) ops.appendChild(el('p', null, s));
  if (m.evac) ops.appendChild(bar(m.evac, 'mdt-band-mid'));
  if (m.swat !== '') ops.appendChild(el('p', null, `SWAT: ${m.swat}`));
  if (m.staffing.length === 0 && !m.evac && m.swat === '') ops.appendChild(el('p', { class: 'mdt-hint' }, 'No traffic control, containment, evacuation or SWAT yet.'));
  container.appendChild(ops);

  if (m.trust && m.agitation) {
    container.appendChild(
      el('section', { class: 'mdt-section mdt-section-negotiation', 'aria-label': 'Negotiation' }, el('h3', null, 'Negotiation'), el('p', null, m.negotiation), bar(m.trust, 'mdt-band-high'), bar(m.agitation, 'mdt-band-low')),
    );
  }

  const needs = el('section', { class: 'mdt-section mdt-section-needs', 'aria-label': 'Needs' }, el('h3', null, 'Resources'),
    el('p', null, m.needs === '' ? 'Nothing more is recommended.' : `Recommended: ${m.needs}`));
  const request = button('REQUEST', () => handlers.requestNeeds(), 'small primary');
  request.disabled = m.needs === '';
  needs.appendChild(request);
  container.appendChild(needs);

  if (m.units.length > 0) {
    const body = el('tbody');
    for (const u of m.units) body.appendChild(el('tr', null, el('td', { class: 'mdt-c-num' }, u.callsign), el('td', null, u.label), el('td', null, u.status), el('td', { class: 'mdt-c-num' }, u.eta)));
    container.appendChild(
      el('section', { class: 'mdt-section mdt-section-units', 'aria-label': 'Units on the incident' }, el('h3', null, 'Units'),
        el('table', { class: 'mdt-list', 'aria-label': 'Units on the incident' },
          el('thead', null, el('tr', null, ...['Unit', 'Officer', 'Status', 'ETA'].map((h) => el('th', { scope: 'col' }, h)))), body)),
    );
  }
}
