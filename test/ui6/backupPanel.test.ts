import { describe, expect, it } from 'vitest';
import { BACKUP_PANEL_COMMANDS, backupPanelModel, backupPanelPick, officerLine, surname } from '../../src/ui/backup';
import { officer } from './fixtures';

const two = [officer(), officer({ callsign: '23', name: 'Officer S. Park', role: 'secondary', state: 'chase', stress: 0.1 })];

describe('backupPanelModel', () => {
  it('lists a Select row per officer, All units, then the six commands', () => {
    const m = backupPanelModel(two, '21');
    expect(m.title).toBe('Backup');
    expect(m.options.map((o) => o.label)).toEqual([
      'Select: 21',
      'Select: 23',
      'All units',
      'Cover me',
      'Take the secondary',
      'Detain my subject',
      'Stand by',
      'Regroup on me',
      'Release (Code 4)',
    ]);
    expect(m.options.every((o) => o.enabled !== false)).toBe(true);
  });

  it('shows the selected officer as the subtitle', () => {
    expect(backupPanelModel(two, '21').subtitle).toBe('21 Officer J. Alvarez · COVER · stress 0.42');
    expect(backupPanelModel(two, 'all').subtitle).toBe('All units (2)');
    expect(officerLine(two[1] as (typeof two)[number])).toBe('23 Officer S. Park · CHASE · stress 0.10');
    expect(surname('Officer J. Alvarez')).toBe('Alvarez');
    expect(surname('Madonna')).toBe('Madonna');
  });

  it('marks the selected row and disables the commands with a hint when nobody is selected', () => {
    const m = backupPanelModel(two, 'nobody');
    const cmds = m.options.slice(3);
    expect(cmds).toHaveLength(BACKUP_PANEL_COMMANDS.length);
    for (const c of cmds) {
      expect(c.enabled).toBe(false);
      expect(c.detail).toBe('Select an officer first');
    }
    expect(m.subtitle).toBe('No officer selected');
    expect(backupPanelModel(two, '23').options[1]?.detail).toContain('●');
  });

  it('disables everything useful when no officer is on scene', () => {
    const m = backupPanelModel([], 'all');
    expect(m.subtitle).toBe('No backup officers on foot');
    expect(m.options.map((o) => o.label)[0]).toBe('All units');
    expect(m.options.every((o) => o.enabled === false)).toBe(true);
    expect(m.options[1]?.detail).toBe('No officers on scene');
  });
});

describe('backupPanelPick', () => {
  it('selects an officer or everyone', () => {
    expect(backupPanelPick(0, two, '21')).toEqual({ select: '21' });
    expect(backupPanelPick(1, two, '21')).toEqual({ select: '23' });
    expect(backupPanelPick(2, two, '21')).toEqual({ select: 'all' });
  });

  it('turns a command into a BackupRequest for the selection', () => {
    expect(backupPanelPick(3, two, '23')).toEqual({ request: { kind: 'command', callsign: '23', command: 'cover' } });
    expect(backupPanelPick(5, two, 'all')).toEqual({ request: { kind: 'command', callsign: 'all', command: 'detain' } });
    expect(backupPanelPick(7, two, '21')).toEqual({ request: { kind: 'command', callsign: '21', command: 'regroup' } });
    expect(backupPanelPick(8, two, '21')).toEqual({ request: { kind: 'command', callsign: '21', command: 'release' } });
  });

  it('returns null for disabled or unknown options', () => {
    expect(backupPanelPick(3, two, 'nobody')).toBeNull();
    expect(backupPanelPick(3, [], 'all')).toBeNull();
    expect(backupPanelPick(0, [], 'all')).toBeNull();
    expect(backupPanelPick(2, [], 'all')).toBeNull();
    expect(backupPanelPick(99, two, '21')).toBeNull();
    expect(backupPanelPick(-1, two, '21')).toBeNull();
    expect(backupPanelPick(1.5, two, '21')).toBeNull();
  });
});
