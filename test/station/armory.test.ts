import { describe, expect, it } from 'vitest';
import { ARMORY_ITEMS, ArmoryLog, armoryItem } from '../../src/station/armory';

describe('armory data', () => {
  it('has the six generic items', () => {
    expect(ARMORY_ITEMS.map((d) => d.id)).toEqual(['sidearm', 'taser', 'ocSpray', 'baton', 'beanbag', 'rifle']);
    expect(ARMORY_ITEMS.map((d) => d.label)).toEqual([
      'Duty pistol', 'Conducted energy device', 'OC spray', 'Expandable baton', 'Less-lethal shotgun', 'Patrol rifle',
    ]);
    expect(armoryItem('sidearm')).toMatchObject({ serialPrefix: 'SA', weapon: 'sidearm' });
    expect(armoryItem('taser')).toMatchObject({ serialPrefix: 'CED', weapon: 'taser' });
    expect(armoryItem('baton')?.weapon).toBeNull();
    expect(armoryItem('nope')).toBeUndefined();
  });
});

describe('ArmoryLog', () => {
  it('signs out and in, tracking what is out', () => {
    const log = new ArmoryLog(42);
    expect(log.has('sidearm')).toBe(false);
    const out = log.signOut('sidearm', 'B-100', 5, 100);
    expect(out).toMatchObject({ seq: 0, item: 'sidearm', action: 'out', officer: 'B-100', sim: 5, game: 100 });
    expect(log.has('sidearm')).toBe(true);
    log.signOut('baton', 'B-100', 6, 101);
    expect(log.out()).toEqual(['sidearm', 'baton']);
    const back = log.signIn('sidearm', 'B-100', 7, 102);
    expect(back).toMatchObject({ seq: 2, action: 'in', serial: out?.serial });
    expect(log.has('sidearm')).toBe(false);
    expect(log.out()).toEqual(['baton']);
    expect(log.entries().map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('refuses double sign-outs, returns of items not out, and unknown items', () => {
    const log = new ArmoryLog(1);
    expect(log.signIn('sidearm', 'B', 0, 0)).toBeNull();
    expect(log.signOut('sidearm', 'B', 0, 0)).not.toBeNull();
    expect(log.signOut('sidearm', 'B', 1, 1)).toBeNull();
    expect(log.signOut('bazooka', 'B', 1, 1)).toBeNull();
    expect(log.signIn('bazooka', 'B', 1, 1)).toBeNull();
    expect(log.entries()).toHaveLength(1);
  });

  it('derives serials deterministically from the seed and the item index', () => {
    const a = new ArmoryLog(42);
    const b = new ArmoryLog(42);
    const c = new ArmoryLog(43);
    for (const d of ARMORY_ITEMS) {
      expect(a.serial(d.id)).toBe(b.serial(d.id));
      expect(a.serial(d.id)).toMatch(new RegExp(`^${d.serialPrefix}-[1-9]\\d{3}$`));
    }
    expect(ARMORY_ITEMS.map((d) => c.serial(d.id))).not.toEqual(ARMORY_ITEMS.map((d) => a.serial(d.id)));
    expect(a.serial('nope')).toBe('');
    // Same serial whenever the item is signed out again.
    const first = a.signOut('taser', 'B', 0, 0);
    a.signIn('taser', 'B', 1, 1);
    expect(a.signOut('taser', 'B', 2, 2)?.serial).toBe(first?.serial);
  });

  it('restores a log, re-deriving serials', () => {
    const a = new ArmoryLog(7);
    a.signOut('sidearm', 'B', 1, 1);
    a.signOut('rifle', 'B', 2, 2);
    a.signIn('rifle', 'B', 3, 3);
    const b = new ArmoryLog(7);
    b.restore(a.entries().map((e) => ({ ...e, serial: '' })));
    expect(b.entries()).toEqual(a.entries());
    expect(b.out()).toEqual(['sidearm']);
  });
});
