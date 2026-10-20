import { describe, expect, it } from 'vitest';
import type { BackupOfficerView } from '../../src/backup/types';
import { Hud, createHudText, hudText } from '../../src/ui/hud/hud';
import {
  BACKUP_HUD_LINES,
  PURSUIT_VERDICT_MS,
  backupHudLines,
  backupLineText,
  commandChipText,
  postStaffingText,
  pursuitHudLine,
  pursuitHudVerdict,
  resourceEtaText,
} from '../../src/ui/hud/phase6';
import { board } from '../ui6/fixtures';
import { snapshot } from './fixtures';

const parent = null as unknown as HTMLElement;
const officer = (over: Partial<BackupOfficerView> = {}): BackupOfficerView => ({
  callsign: '21', name: 'Officer J. Alvarez', role: 'cover', state: 'cover', stress: 0, fatigue: 0, loyalty: 0.5, quality: 1, post: null, ...over,
});

describe('backup lines', () => {
  it('shows callsign, surname and role, plus a state word where it adds something', () => {
    expect(backupLineText(officer())).toBe('21 Alvarez · COVER');
    expect(backupLineText(officer({ callsign: '23', name: 'Officer S. Park', role: 'secondary', state: 'chase' }))).toBe('23 Park · SECONDARY · chasing');
    expect(backupLineText(officer({ role: 'post', state: 'post' }))).toBe('21 Alvarez · POST');
    expect(backupLineText(officer({ role: 'standby', state: 'returning' }))).toBe('21 Alvarez · STANDBY · returning');
  });

  it('keeps at most four lines and ends with the posts line when there is one', () => {
    const many = ['21', '22', '23', '24', '25', '26'].map((callsign) => officer({ callsign }));
    expect(backupHudLines(many)).toHaveLength(BACKUP_HUD_LINES);
    const withPosts = backupHudLines(many, [], 'TCP 2/4');
    expect(withPosts).toHaveLength(BACKUP_HUD_LINES);
    expect(withPosts[3]).toBe('TCP 2/4');
    const reused: string[] = ['stale'];
    expect(backupHudLines([], reused)).toBe(reused);
    expect(reused).toEqual([]);
  });

  it('summarises post staffing from the command board', () => {
    expect(postStaffingText(board({ tcps: { staffed: 2, total: 4 }, inner: { staffed: 1, total: 4 } }))).toBe('TCP 2/4 · INNER 1/4');
    expect(postStaffingText(board())).toBe('');
    expect(postStaffingText(null)).toBe('');
  });
});

describe('feed helpers', () => {
  it('maps the module feeds to the snapshot strings', () => {
    expect(pursuitHudLine({ line: 'PURSUIT · 62 mph', verdict: 'PIT: within policy' })).toBe('PURSUIT · 62 mph');
    expect(pursuitHudVerdict({ line: 'x', verdict: 'PIT: within policy' })).toBe('PIT: within policy');
    expect(pursuitHudLine(null)).toBe('');
    expect(pursuitHudVerdict({ line: 'x', verdict: null })).toBe('');
    expect(resourceEtaText({ next: 'MEDIC-2 ETA 3:10', onScene: 0 })).toBe('MEDIC-2 ETA 3:10');
    expect(resourceEtaText({ next: null, onScene: 1 })).toBe('');
    expect(resourceEtaText(null)).toBe('');
  });

  it('builds the command chip from the board', () => {
    expect(commandChipText(board({ evac: { progress: 0.6, radiusM: 100 } }))).toBe('ICS · DISASTER · RED 3 YEL 4 GRN 2 BLK 1 · EVAC 60%');
    expect(commandChipText(board({ counts: { minor: 0, delayed: 0, immediate: 0, expectant: 0, untagged: 0 } }))).toBe('ICS · DISASTER');
    expect(commandChipText(board({ post: null }))).toBe('');
    expect(commandChipText(null)).toBe('');
  });
});

describe('hudText Phase 6 fields', () => {
  it('hides everything when the optional fields are absent', () => {
    const t = hudText(snapshot());
    expect(t.backup).toEqual(['', '', '', '']);
    expect([t.pursuit6, t.pursuitVerdict, t.resourceEta, t.command]).toEqual(['', '', '', '']);
    expect(t.flir).toBe(false);
    expect(createHudText().backup).toHaveLength(BACKUP_HUD_LINES);
  });

  it('copies the strings and pads the backup lines', () => {
    const t = hudText(
      snapshot({
        backup: ['21 Alvarez · COVER', '23 Park · SECONDARY · chasing'],
        pursuit6: 'PURSUIT · 62 mph · risk 0.48',
        pursuitVerdict: 'PIT: within policy',
        resourceEta: 'MEDIC-2 ETA 3:10',
        command: 'ICS · DISASTER',
        flir: true,
      }),
    );
    expect(t.backup).toEqual(['21 Alvarez · COVER', '23 Park · SECONDARY · chasing', '', '']);
    expect(t.pursuit6).toBe('PURSUIT · 62 mph · risk 0.48');
    expect(t.pursuitVerdict).toBe('PIT: within policy');
    expect(t.resourceEta).toBe('MEDIC-2 ETA 3:10');
    expect(t.command).toBe('ICS · DISASTER');
    expect(t.flir).toBe(true);
    expect(hudText(snapshot({ backup: null })).backup).toEqual(['', '', '', '']);
    expect(hudText(snapshot({ backup: ['a', 'b', 'c', 'd', 'e'] })).backup).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reuses the backup array of the output object', () => {
    const out = createHudText();
    const arr = out.backup;
    hudText(snapshot({ backup: ['x'] }), out);
    hudText(snapshot(), out);
    expect(out.backup).toBe(arr);
    expect(out.backup[0]).toBe('');
  });
});

describe('Hud Phase 6 updates', () => {
  it('shows the fields at the throttled rate and clears them when they go away', () => {
    const hud = new Hud(parent, { updateHz: 10 });
    hud.update(snapshot({ backup: ['21 Alvarez · COVER'], pursuit6: 'PURSUIT', resourceEta: 'K9-1 ETA 1:35', command: 'ICS · MAJOR', flir: true }), 0);
    expect(hud.text.backup[0]).toBe('21 Alvarez · COVER');
    expect(hud.text.pursuit6).toBe('PURSUIT');
    expect(hud.text.resourceEta).toBe('K9-1 ETA 1:35');
    expect(hud.text.command).toBe('ICS · MAJOR');
    expect(hud.text.flir).toBe(true);
    hud.update(snapshot(), 50);
    expect(hud.text.pursuit6).toBe('PURSUIT'); // throttled
    hud.update(snapshot(), 150);
    expect(hud.text.backup[0]).toBe('');
    expect(hud.text.pursuit6).toBe('');
    expect(hud.text.flir).toBe(false);
  });

  it('shows a tactic verdict for six seconds after it changed', () => {
    const hud = new Hud(parent, { updateHz: 10 });
    const snap = (v: string | null) => snapshot({ pursuitVerdict: v });
    hud.update(snap(null), 0);
    expect(hud.text.pursuitVerdict).toBe('');
    hud.update(snap('PIT: within policy'), 1000);
    expect(hud.text.pursuitVerdict).toBe('PIT: within policy');
    hud.update(snap('PIT: within policy'), 1000 + PURSUIT_VERDICT_MS - 200);
    expect(hud.text.pursuitVerdict).toBe('PIT: within policy');
    hud.update(snap('PIT: within policy'), 1000 + PURSUIT_VERDICT_MS);
    expect(hud.text.pursuitVerdict).toBe('');
    hud.update(snap('Spikes: success'), 8000);
    expect(hud.text.pursuitVerdict).toBe('Spikes: success');
    hud.update(snap('Spikes: success'), 8000 + PURSUIT_VERDICT_MS + 100);
    expect(hud.text.pursuitVerdict).toBe('');
    hud.update(snap(null), 20000);
    hud.update(snap('Spikes: success'), 21000);
    expect(hud.text.pursuitVerdict).toBe('Spikes: success'); // a repeat after a gap shows again
  });
});
