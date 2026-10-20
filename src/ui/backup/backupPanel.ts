/**
 * Backup panel model (Phase 6 design §12.2): pure. The app opens an `ActionPanel` with the model, keeps the selected
 * officer (a callsign or 'all') and turns a pick into a `BackupRequest` for `BackupSystem.request`.
 */
import type { BackupCommand, BackupOfficerView, BackupRequest } from '../../backup/types';
import type { ActionPanelModel, PanelOption } from '../panels/actionPanel';

/** The commands in panel order (the 'regroup' entry sits before 'release', which is Code 4). */
export const BACKUP_PANEL_COMMANDS: readonly { readonly command: BackupCommand; readonly label: string }[] = [
  { command: 'cover', label: 'Cover me' },
  { command: 'secondary', label: 'Take the secondary' },
  { command: 'detain', label: 'Detain my subject' },
  { command: 'standby', label: 'Stand by' },
  { command: 'regroup', label: 'Regroup on me' },
  { command: 'release', label: 'Release (Code 4)' },
];

/** Result of a pick: the new selection and/or a request to queue. */
export interface BackupPick {
  readonly select?: string;
  readonly request?: BackupRequest;
}

/** 'Alvarez' from 'Officer J. Alvarez' (the last word of the name). */
export function surname(name: string): string {
  const t = name.trim();
  const i = t.lastIndexOf(' ');
  return i < 0 ? t : t.slice(i + 1);
}

/** '21 Officer J. Alvarez · COVER · stress 0.42'. */
export function officerLine(o: BackupOfficerView): string {
  const stress = Number.isFinite(o.stress) ? o.stress : 0;
  return `${o.callsign} ${o.name} · ${o.state.toUpperCase()} · stress ${stress.toFixed(2)}`;
}

function findOfficer(officers: readonly BackupOfficerView[], callsign: string): BackupOfficerView | undefined {
  for (const o of officers) if (o.callsign === callsign) return o;
  return undefined;
}

/** Why the commands are unavailable, '' when they are available. */
function commandBlock(officers: readonly BackupOfficerView[], selected: string): string {
  if (officers.length === 0) return 'No officers on scene';
  if (selected !== 'all' && findOfficer(officers, selected) === undefined) return 'Select an officer first';
  return '';
}

/**
 * Backup panel: title 'Backup', the selected officer as subtitle, a `Select: <callsign>` row per officer, 'All units',
 * then the six commands (disabled with a hint when no officer is selected or none is on scene).
 */
export function backupPanelModel(officers: readonly BackupOfficerView[], selected: string): ActionPanelModel {
  const options: PanelOption[] = [];
  for (const o of officers) {
    const sel = o.callsign === selected;
    options.push({ label: `Select: ${o.callsign}`, detail: `${sel ? '● ' : ''}${surname(o.name)} · ${o.state.toUpperCase()}` });
  }
  options.push({
    label: 'All units',
    detail: selected === 'all' ? '●' : '',
    enabled: officers.length > 0,
  });
  const block = commandBlock(officers, selected);
  for (const c of BACKUP_PANEL_COMMANDS) {
    options.push(block === '' ? { label: c.label } : { label: c.label, detail: block, enabled: false });
  }
  let subtitle: string;
  if (officers.length === 0) subtitle = 'No backup officers on foot';
  else if (selected === 'all') subtitle = `All units (${String(officers.length)})`;
  else {
    const o = findOfficer(officers, selected);
    subtitle = o ? officerLine(o) : 'No officer selected';
  }
  return { title: 'Backup', subtitle, options };
}

/**
 * Maps a picked option index of `backupPanelModel(officers, selected)` to a selection change or a request; null for an
 * out-of-range or disabled option.
 */
export function backupPanelPick(index: number, officers: readonly BackupOfficerView[], selected: string): BackupPick | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const n = officers.length;
  if (index < n) {
    const o = officers[index];
    return o ? { select: o.callsign } : null;
  }
  if (index === n) return n > 0 ? { select: 'all' } : null;
  const c = BACKUP_PANEL_COMMANDS[index - n - 1];
  if (!c || commandBlock(officers, selected) !== '') return null;
  return { request: { kind: 'command', callsign: selected, command: c.command } };
}
