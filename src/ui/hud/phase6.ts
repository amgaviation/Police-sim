/** Phase 6 HUD text helpers (design §12.4): backup lines, pursuit line, resource ETA and the command chip. Pure, no DOM. */
import type { BackupOfficerView, BackupState } from '../../backup/types';
import type { CommandBoard } from '../../command/types';
import type { PursuitHud } from '../../pursuit/types';
import type { ResourceHud } from '../../resources/types';

/** Backup lines the HUD shows at most. */
export const BACKUP_HUD_LINES = 4;
/** How long the last pursuit tactic verdict stays up (ms). */
export const PURSUIT_VERDICT_MS = 6000;

const STATE_WORD: Readonly<Partial<Record<BackupState, string>>> = {
  exiting: 'exiting',
  approach: 'approaching',
  chase: 'chasing',
  detain: 'detaining',
  returning: 'returning',
  gone: 'gone',
};

/** 'Alvarez' from 'Officer J. Alvarez': the last word. */
function lastName(name: string): string {
  const t = name.trim();
  const i = t.lastIndexOf(' ');
  return i < 0 ? t : t.slice(i + 1);
}

/** '21 Alvarez · COVER', '23 Park · SECONDARY · chasing'. */
export function backupLineText(o: Readonly<BackupOfficerView>): string {
  const word = STATE_WORD[o.state];
  return `${o.callsign} ${lastName(o.name)} · ${o.role.toUpperCase()}${word === undefined ? '' : ` · ${word}`}`;
}

/** 'TCP 2/4 · INNER 3/4' from the command board (the staffed posts), '' when no post is set. */
export function postStaffingText(board: Readonly<CommandBoard> | null): string {
  if (board === null) return '';
  const parts: string[] = [];
  if (board.tcps.total > 0) parts.push(`TCP ${String(board.tcps.staffed)}/${String(board.tcps.total)}`);
  if (board.inner !== null && board.inner.total > 0) parts.push(`INNER ${String(board.inner.staffed)}/${String(board.inner.total)}`);
  return parts.join(' · ');
}

/**
 * Fills `out` with the lines for the HUD snapshot's `backup` field: one per officer (in order) and, when given, the
 * post staffing line last; at most `BACKUP_HUD_LINES` in all. Returns `out`.
 */
export function backupHudLines(officers: readonly BackupOfficerView[], out: string[] = [], postsLine = ''): string[] {
  out.length = 0;
  const room = postsLine === '' ? BACKUP_HUD_LINES : BACKUP_HUD_LINES - 1;
  for (let i = 0; i < officers.length && out.length < room; i++) out.push(backupLineText(officers[i] as BackupOfficerView));
  if (postsLine !== '') out.push(postsLine);
  return out;
}

/** The `pursuit6` field from `PursuitSystem.hud()`: its line, '' without one. */
export function pursuitHudLine(hud: Readonly<PursuitHud> | null): string {
  return hud ? hud.line : '';
}

/** The `pursuitVerdict` field from `PursuitSystem.hud()`. */
export function pursuitHudVerdict(hud: Readonly<PursuitHud> | null): string {
  return hud?.verdict ?? '';
}

/** The `resourceEta` field from `ResourceSystem.hud()` ('MEDIC-2 ETA 3:10'), '' when no unit is coming. */
export function resourceEtaText(hud: Readonly<ResourceHud> | null): string {
  return hud?.next ?? '';
}

/**
 * Command chip from the board when the command module's own `hud()` line is not at hand:
 * 'ICS · DISASTER · RED 3 YEL 4 GRN 2 BLK 1 · EVAC 60%'; '' without a command post.
 */
export function commandChipText(board: Readonly<CommandBoard> | null): string {
  if (board === null || board.post === null) return '';
  const parts = ['ICS', board.post.level.toUpperCase()];
  const c = board.counts;
  if (c.minor + c.delayed + c.immediate + c.expectant + c.untagged > 0) parts.push(`RED ${String(c.immediate)} YEL ${String(c.delayed)} GRN ${String(c.minor)} BLK ${String(c.expectant)}`);
  if (board.evac !== null) parts.push(`EVAC ${String(Math.floor(board.evac.progress * 100))}%`);
  return parts.join(' · ');
}
