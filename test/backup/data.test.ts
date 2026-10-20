import { describe, expect, it } from 'vitest';
import { BACKUP_CONFIG, SWAT_CONFIG, parseBackupConfig, parseSwatConfig } from '../../src/backup/data';
import { CALLOUT_KINDS } from '../../src/backup/types';
import backupJson from '../../src/data/backup/backup.json';
import swatJson from '../../src/data/backup/swat.json';

/** A deep copy of `json` with the value at the dotted `path` replaced (`undefined` deletes it). */
function patched(json: unknown, path: string, value: unknown): unknown {
  const root = structuredClone(json) as Record<string, unknown>;
  const keys = path.split('.');
  let node = root;
  for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>;
  const last = keys[keys.length - 1] as string;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return root;
}

describe('backup.json', () => {
  it('ships the contract values', () => {
    expect(BACKUP_CONFIG.spawn).toEqual({ maxCarDistanceM: 120, maxOfficers: 8, exitS: 1.5 });
    expect(BACKUP_CONFIG.move).toEqual({ walk: 1.6, run: 4.8, chase: 6.4, arriveM: 0.4 });
    expect(BACKUP_CONFIG.cover.distanceM).toEqual([4.5, 6.5]);
    expect(BACKUP_CONFIG.cover.angleDeg).toEqual([45, 60]);
    expect(BACKUP_CONFIG.callout.lateDelayS).toEqual([3, 6]);
    expect(BACKUP_CONFIG.callout.cooldownS).toBe(8);
    for (const k of CALLOUT_KINDS) expect(BACKUP_CONFIG.callouts[k].length).toBeGreaterThan(0);
  });

  it('rejects bad data naming the file and path', () => {
    expect(() => parseBackupConfig(patched(backupJson, 'spawn.maxOfficers', 0), 'x.json')).toThrow(/x\.json: spawn\.maxOfficers/);
    expect(() => parseBackupConfig(patched(backupJson, 'extra', 1), 'x.json')).toThrow(/extra/);
    expect(() => parseBackupConfig(patched(backupJson, 'callouts.weapon', []), 'x.json')).toThrow(/callouts\.weapon/);
    expect(() => parseBackupConfig(patched(backupJson, 'callout.lateDelayS', [0.1, 0.2]), 'x.json')).toThrow(/lateDelayS/);
    expect(() => parseBackupConfig(patched(backupJson, 'version', 2), 'x.json')).toThrow(/version/);
    expect(() => parseBackupConfig(patched(backupJson, 'callouts.weapon', [5]), 'x.json')).toThrow(/callouts\.weapon\[0\]/);
    expect(() => parseBackupConfig(patched(backupJson, 'cover.angleDeg', [60, 45]), 'x.json')).toThrow(/cover\.angleDeg/);
  });
});

describe('swat.json', () => {
  it('ships the contract values', () => {
    expect(SWAT_CONFIG.operators).toBe(4);
    expect(SWAT_CONFIG.roomS).toEqual({ deliberate: 5, dynamic: 2 });
    expect(SWAT_CONFIG.breachS).toBe(3);
    expect(SWAT_CONFIG.stageDistanceM).toBe(30);
    expect(SWAT_CONFIG.contact.surrenderBase).toBe(0.55);
    expect(SWAT_CONFIG.colors).toEqual({ top: 1316380, bottom: 1316380 });
  });

  it('rejects bad data naming the file and path', () => {
    expect(() => parseSwatConfig(patched(swatJson, 'contact.armedPenalty', 2), 'y.json')).toThrow(/y\.json: contact\.armedPenalty/);
    expect(() => parseSwatConfig(patched(swatJson, 'operators', 2.5), 'y.json')).toThrow(/operators/);
    expect(() => parseSwatConfig(patched(swatJson, 'roomS.dynamic', undefined), 'y.json')).toThrow(/roomS\.dynamic/);
  });
});
