/**
 * Incident command panel model (Phase 6 design §12.2): pure. Two modes: triage (while a victim is being assessed) and
 * command (post, traffic control, evacuation, containment, resources, negotiation, SWAT, stand down). The SWAT plan
 * (entry, tempo, less-lethal) is panel state: it is sent with every SWAT command and the plan rows only change it.
 * The triage view never contains a START hint: the vitals are shown as readings only after the assessment.
 */
import type { CommandBoard, CommandRequest, CommandSwatCommand, SwatPlan, TriagePrompt, TriageTag, Vitals } from '../../command/types';
import type { ActionPanelModel, PanelOption } from '../panels/actionPanel';

/** The four tags with their wording (colour, then the START category name). */
export const TRIAGE_TAG_ROWS: readonly { readonly tag: TriageTag; readonly label: string }[] = [
  { tag: 'minor', label: 'GREEN minor' },
  { tag: 'delayed', label: 'YELLOW delayed' },
  { tag: 'immediate', label: 'RED immediate' },
  { tag: 'expectant', label: 'BLACK expectant' },
];

const SWAT_ROWS: readonly { readonly command: CommandSwatCommand; readonly label: string }[] = [
  { command: 'stage', label: 'Stage' },
  { command: 'stack', label: 'Stack on the door' },
  { command: 'breach', label: 'Breach' },
  { command: 'clear', label: 'Clear the building' },
  { command: 'hold', label: 'Hold' },
  { command: 'withdraw', label: 'Withdraw' },
];

/** The SWAT plan as the panel keeps it. */
export type CommandPlan = Required<SwatPlan>;

/** What the app keeps between model builds: which submenu is shown and the SWAT plan. */
export interface CommandPanelState {
  readonly submenu: 'root' | 'swat';
  readonly plan: CommandPlan;
}

/** Root menu, plan front / deliberate / lethal-default off. */
export const DEFAULT_COMMAND_PANEL_STATE: CommandPanelState = {
  submenu: 'root',
  plan: { entry: 'front', tempo: 'deliberate', lessLethal: false },
};

/** What a pick can produce: a request, a submenu change or a plan change (the app keeps the plan in its state). */
export type CommandPick = CommandRequest | { readonly submenu: 'swat' | 'root' } | { readonly plan: Partial<CommandPlan> };

interface Row {
  readonly option: PanelOption;
  readonly pick: CommandPick | null;
}

function row(label: string, pick: CommandPick, detail = ''): Row {
  return { option: detail === '' ? { label } : { label, detail }, pick };
}

function off(label: string, hint: string): Row {
  return { option: { label, detail: hint, enabled: false }, pick: null };
}

function gate(label: string, block: string, pick: CommandPick, detail = ''): Row {
  return block === '' ? row(label, pick, detail) : off(label, block);
}

/** 'yes' / 'no'. */
function yn(b: boolean): string {
  return b ? 'yes' : 'no';
}

/** The vitals as readings (no interpretation): one line each, in the order a rescuer checks them. */
export function vitalsLines(v: Vitals): string[] {
  const breathing = v.breathing
    ? `yes, ${String(Math.round(v.respRate))} / min`
    : v.breathesAfterAirway
      ? `no, starts after the airway is opened (${String(Math.round(v.respRate))} / min)`
      : 'no, even after the airway is opened';
  return [
    `Walking: ${yn(v.walking)}`,
    `Breathing: ${breathing}`,
    `Radial pulse: ${v.radialPulse ? 'present' : 'absent'}`,
    `Capillary refill: ${v.capRefillS.toFixed(1)} s`,
    `Follows commands: ${yn(v.followsCommands)}`,
  ];
}

function triageRows(t: TriagePrompt): { rows: Row[]; subtitle: string } {
  const rows: Row[] = [];
  const v = t.vitals;
  if (v === null) {
    const pct = Math.round(Math.min(1, Math.max(0, t.progress)) * 100);
    rows.push(off(`Assessing… ${String(pct)}%`, 'Stay with the patient'));
  } else {
    for (const text of vitalsLines(v)) rows.push({ option: { label: text, enabled: false }, pick: null });
  }
  for (const r of TRIAGE_TAG_ROWS) {
    const current = t.tag === r.tag ? '● current tag' : '';
    if (v === null) rows.push(off(`Tag ${r.label}`, 'Assess first'));
    else rows.push(row(`Tag ${r.label}`, { kind: 'tag', personId: t.personId, tag: r.tag }, current));
  }
  const notes: string[] = [];
  if (v?.trapped) notes.push('trapped');
  if (v?.contaminated) notes.push('contaminated');
  if (t.tag !== null) notes.push(`tagged ${TRIAGE_TAG_ROWS.find((r) => r.tag === t.tag)?.label ?? t.tag}`);
  return { rows, subtitle: notes.join(' · ') };
}

function needsText(n: CommandBoard['needs']): string {
  const parts: string[] = [];
  if (n.ems > 0) parts.push(`EMS ${String(n.ems)}`);
  if (n.fire > 0) parts.push(`fire ${String(n.fire)}`);
  if (n.supervisor > 0) parts.push(`supervisor ${String(n.supervisor)}`);
  return parts.join(', ');
}

function countsText(b: CommandBoard): string {
  const c = b.counts;
  const total = c.minor + c.delayed + c.immediate + c.expectant + c.untagged;
  return total === 0 ? '' : `RED ${String(c.immediate)} YEL ${String(c.delayed)} GRN ${String(c.minor)} BLK ${String(c.expectant)} · untagged ${String(c.untagged)}`;
}

function swatBlock(swatPhase: string | null): string {
  if (swatPhase === null) return 'No SWAT unit assigned';
  if (swatPhase === 'enRoute') return 'SWAT is en route';
  if (swatPhase === 'arrived') return 'No building to enter';
  return '';
}

function commandRows(board: CommandBoard, swatPhase: string | null): Row[] {
  const post = board.post;
  const noPost = post === null ? 'Establish command first' : '';
  const untagged = board.counts.untagged;
  const needs = needsText(board.needs);
  const rows: Row[] = [];
  rows.push(post === null ? row('Establish command', { kind: 'establish' }) : off('Establish command', 'Command post is open'));
  rows.push(gate('Assess nearest victim', noPost !== '' ? noPost : untagged > 0 ? '' : 'No untagged victims', { kind: 'assess' }, untagged > 0 ? `${String(untagged)} untagged` : ''));
  const tcpOn = board.tcps.total > 0;
  rows.push(gate(tcpOn ? 'Traffic control off' : 'Traffic control on', noPost, { kind: 'tcp', on: !tcpOn }, tcpOn ? `${String(board.tcps.staffed)}/${String(board.tcps.total)} staffed` : ''));
  rows.push(gate('Evacuate the zone', noPost !== '' ? noPost : board.evac !== null ? 'Evacuation under way' : '', { kind: 'evacuate' }));
  rows.push(gate('Contain the location', noPost !== '' ? noPost : board.inner !== null ? 'Containment is set' : '', { kind: 'contain' }));
  rows.push(gate('Request recommended resources', noPost !== '' ? noPost : needs === '' ? 'Nothing recommended' : '', { kind: 'requestNeeds' }, needs));
  rows.push(gate('Negotiate', noPost !== '' ? noPost : board.negotiation !== null && board.negotiation.outcome !== 'ongoing' ? 'Negotiation is over' : '', { kind: 'negotiationOpen' }, 'opens the dialogue'));
  const block = swatBlock(swatPhase);
  rows.push(block === '' ? row('SWAT ▸', { submenu: 'swat' }, swatPhase ?? '') : off('SWAT ▸', block));
  rows.push(gate('Stand down', noPost, { kind: 'standDown' }));
  return rows;
}

function swatRows(swatPhase: string | null, plan: CommandPlan): Row[] {
  const block = swatBlock(swatPhase);
  const rows: Row[] = SWAT_ROWS.map((r) => gate(r.label, block, { kind: 'swat', command: r.command, plan: { ...plan } }));
  rows.push(row(`Plan: entry ${plan.entry}`, { plan: { entry: plan.entry === 'front' ? 'rear' : 'front' } }, 'change'));
  rows.push(row(`Plan: tempo ${plan.tempo}`, { plan: { tempo: plan.tempo === 'deliberate' ? 'dynamic' : 'deliberate' } }, 'change'));
  rows.push(row(`Plan: less-lethal ${plan.lessLethal ? 'on' : 'off'}`, { plan: { lessLethal: !plan.lessLethal } }, 'change'));
  rows.push(row('Back ▸', { submenu: 'root' }));
  return rows;
}

function build(board: CommandBoard, triage: TriagePrompt | null, swatPhase: string | null, state: CommandPanelState): { title: string; subtitle: string; rows: Row[] } {
  if (triage !== null) {
    const t = triageRows(triage);
    return { title: `Triage — ${triage.label}`, subtitle: t.subtitle, rows: t.rows };
  }
  if (state.submenu === 'swat') {
    return { title: 'SWAT', subtitle: swatPhase === null ? 'No SWAT unit assigned' : `Team: ${swatPhase}`, rows: swatRows(swatPhase, state.plan) };
  }
  const post = board.post;
  const subtitle =
    post === null ? 'No command post' : [`${post.level.toUpperCase()} · ${post.commander}`, countsText(board)].filter((s) => s !== '').join(' · ');
  return { title: 'Incident command', subtitle, rows: commandRows(board, swatPhase) };
}

/**
 * The panel for the current command state. Triage mode when `triage` is non-null, else command mode (or its SWAT
 * submenu when `state.submenu` is 'swat').
 */
export function commandPanelModel(
  board: CommandBoard,
  triage: TriagePrompt | null,
  swatPhase: string | null,
  state: CommandPanelState = DEFAULT_COMMAND_PANEL_STATE,
): ActionPanelModel {
  const b = build(board, triage, swatPhase, state);
  const base: ActionPanelModel = { title: b.title, options: b.rows.map((r) => r.option) };
  return b.subtitle === '' ? base : { ...base, subtitle: b.subtitle };
}

/**
 * What option `index` of the same model does: a `CommandRequest`, `{ submenu }` to switch menu, `{ plan }` to change the
 * SWAT plan kept by the app, or null for a disabled / unknown option.
 */
export function commandPanelPick(
  index: number,
  board: CommandBoard,
  triage: TriagePrompt | null,
  swatPhase: string | null,
  state: CommandPanelState = DEFAULT_COMMAND_PANEL_STATE,
): CommandPick | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const r = build(board, triage, swatPhase, state).rows[index];
  return r?.pick ?? null;
}

/** Applies a `{ plan }` or `{ submenu }` pick to the panel state (other picks leave it unchanged). */
export function applyCommandPick(state: CommandPanelState, pick: CommandPick | null): CommandPanelState {
  if (pick === null) return state;
  if ('submenu' in pick) return { ...state, submenu: pick.submenu };
  if ('plan' in pick) return { ...state, plan: { ...state.plan, ...pick.plan } };
  return state;
}
