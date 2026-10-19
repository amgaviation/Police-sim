import { describe, expect, it } from 'vitest';
import { INTERIOR_FLOOR_Y } from '../../src/interior/constants';
import { roomAt } from '../../src/interior/nav';
import { FIGURE_FLAG, POSE } from '../../src/render/people/pose';
import { TACTICS } from '../../src/tactical/data';
import { PartnerOfficer } from '../../src/tactical/partner';
import type { OfficerPose } from '../../src/tactical/types';
import { StubInteriors, twoRooms } from './helpers';

const layout = twoRooms();

function rig(occupied = false) {
  const said: string[] = [];
  const q = new StubInteriors([[1, layout]]);
  const partner = new PartnerOfficer(TACTICS, { say: (t) => said.push(t), occupied: () => occupied });
  const officer: OfficerPose = { x: 3.5, z: 3.5, yaw: -Math.PI / 2, pitch: 0, building: 1, speed: 0, onFoot: true };
  return { said, q, partner, officer };
}

function run(r: ReturnType<typeof rig>, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) r.partner.step(1 / 60, r.officer, r.q);
}

describe('PartnerOfficer', () => {
  it('starts away and invisible; summon puts it beside the officer in the same room', () => {
    const r = rig();
    expect(r.partner.mode).toBe('away');
    r.partner.step(0.1, r.officer, r.q);
    expect(r.partner.view.count).toBe(0);
    expect(r.partner.command('hold', r.officer, r.q)).toBeNull();
    expect(r.partner.command('summon', r.officer, r.q)).toBe('On my way.');
    expect(r.partner.mode).toBe('follow');
    expect(r.partner.building).toBe(1);
    expect(roomAt(layout, r.partner.x, r.partner.z)).toBe(0);
    expect(Math.hypot(r.partner.x - r.officer.x, r.partner.z - r.officer.z)).toBeLessThan(1.5);
    r.partner.step(0.1, r.officer, r.q);
    expect(r.partner.view.count).toBe(1);
    expect(r.partner.view.y[0]).toBe(INTERIOR_FLOOR_Y);
    expect(r.partner.view.top[0]).toBe(TACTICS.partner.colors.top);
  });

  it('dismiss sends it away; follow from away summons it', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    expect(r.partner.command('dismiss', r.officer, r.q)).toBe('Copy, heading back.');
    expect(r.partner.mode).toBe('away');
    expect(r.partner.view.count).toBe(0);
    expect(r.partner.command('follow', r.officer, r.q)).toBe('On my way.');
    expect(r.partner.mode).toBe('follow');
  });

  it('follows at about 1.6 m, walking through a doorway on the room-graph route', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    // The officer walks into the next room and faces +X.
    r.officer.x = 8;
    r.officer.z = 2.5;
    let crossed = false;
    for (let i = 0; i < 60 * 8; i++) {
      r.partner.step(1 / 60, r.officer, r.q);
      // Passing the doorway means being near the door line at its z.
      if (Math.abs(r.partner.x - 5) < 0.3) {
        crossed = true;
        expect(Math.abs(r.partner.z - 2.5)).toBeLessThan(0.6);
      }
    }
    expect(crossed).toBe(true);
    expect(roomAt(layout, r.partner.x, r.partner.z)).toBe(1);
    const d = Math.hypot(r.partner.x - r.officer.x, r.partner.z - r.officer.z);
    expect(d).toBeGreaterThan(1.2);
    expect(d).toBeLessThanOrEqual(TACTICS.partner.followM + 1e-6);
    // It stands still once it is close enough.
    expect(r.partner.view.pose[0]).toBe(POSE.stand);
  });

  it('cannot follow through a locked door', () => {
    const r = rig();
    r.q.setDoor(1, 0, 'locked');
    r.partner.command('summon', r.officer, r.q);
    r.officer.x = 8;
    r.officer.z = 2.5;
    run(r, 6);
    expect(roomAt(layout, r.partner.x, r.partner.z)).toBe(0);
  });

  it('walks at the configured speed', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    r.officer.x = 2;
    r.officer.z = 2;
    r.partner.step(1 / 60, r.officer, r.q);
    r.officer.x = 0.6;
    r.officer.z = 0.6;
    r.officer.yaw = 0;
    const x0 = r.partner.x;
    const z0 = r.partner.z;
    r.partner.step(0.5, r.officer, r.q);
    const moved = Math.hypot(r.partner.x - x0, r.partner.z - z0);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(TACTICS.partner.speed * 0.5 + 1e-6);
    expect(r.partner.view.pose[0]).toBe(POSE.walk);
    expect(r.partner.view.speed[0]).toBeGreaterThan(0.1);
  });

  it('stacks beside the door frame on the officer side, opposite the officer, facing the door', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    expect(r.partner.command('stack', r.officer, r.q)).toBe('Stacked up on the door.');
    expect(r.partner.mode).toBe('stack');
    expect(r.partner.door).toBe(0);
    run(r, 5);
    const door = layout.doors[0];
    if (door === undefined) throw new Error('no door');
    // Officer at z 3.5 (+1 from the door centre): the partner takes the -Z side of the frame, on the officer's side (x < 5).
    expect(Math.hypot(r.partner.x - (door.x - 0.6), r.partner.z - (door.z - (door.width / 2 + TACTICS.partner.stackOffset)))).toBeLessThan(0.15);
    expect(r.partner.x).toBeLessThan(door.x);
    expect(r.partner.z).toBeLessThan(door.z);
    // Facing the door centre.
    const fx = -Math.sin(r.partner.yaw);
    const fz = -Math.cos(r.partner.yaw);
    const tx = door.x - r.partner.x;
    const tz = door.z - r.partner.z;
    const len = Math.hypot(tx, tz);
    expect(fx).toBeCloseTo(tx / len, 2);
    expect(fz).toBeCloseTo(tz / len, 2);
    // The other side of the door gets the other side of the frame.
    const other = rig();
    other.officer.x = 4.2;
    other.officer.z = 1.6;
    other.partner.command('summon', other.officer, other.q);
    other.partner.command('stack', other.officer, other.q);
    run(other, 5);
    expect(other.partner.z).toBeGreaterThan(door.z);
  });

  it('says there is no door when none is close', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    r.officer.x = 1;
    r.officer.z = 4.8; // 4.4 m from the interior door, 4.8 from the exterior one
    expect(r.partner.command('stack', r.officer, r.q)).toBe('No door close enough.');
    expect(r.partner.mode).toBe('follow');
  });

  it('clears the next room: walks to its centre, aims, reports clear', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    r.partner.command('stack', r.officer, r.q);
    run(r, 3);
    expect(r.partner.command('clear', r.officer, r.q)).toBe('Going in.');
    expect(r.partner.mode).toBe('clear');
    expect(r.partner.room).toBe(1);
    run(r, 2);
    expect(Math.hypot(r.partner.x - 7.5, r.partner.z - 2.5)).toBeLessThan(0.15);
    expect(r.partner.view.pose[0]).toBe(POSE.aim);
    expect(r.said).toEqual([]);
    run(r, 2.5);
    expect(r.said).toEqual(['Room clear.']);
    expect(r.partner.mode).toBe('hold');
    expect(r.partner.view.pose[0]).toBe(POSE.stand);
  });

  it('reports contact when someone awake is in the room', () => {
    const r = rig(true);
    r.partner.command('summon', r.officer, r.q);
    r.partner.command('clear', r.officer, r.q);
    run(r, 8);
    expect(r.said).toEqual(['Contact!']);
  });

  it('will not clear through a locked door or out of the building', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    r.q.setDoor(1, 0, 'locked');
    expect(r.partner.command('clear', r.officer, r.q)).toBe("That door's locked.");
    expect(r.partner.mode).toBe('follow');
    const out = rig();
    out.officer.x = 2;
    out.officer.z = 1; // the exterior door is the nearest
    out.partner.command('summon', out.officer, out.q);
    expect(out.partner.command('clear', out.officer, out.q)).toBe('That leads outside.');
    const nowhere = rig();
    nowhere.officer.building = -1;
    nowhere.partner.command('summon', nowhere.officer, nowhere.q);
    expect(nowhere.partner.command('stack', nowhere.officer, nowhere.q)).toBe('No door close enough.');
    expect(nowhere.partner.command('clear', nowhere.officer, nowhere.q)).toBe('Nothing to clear here.');
  });

  it('hold keeps it in place', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    expect(r.partner.command('hold', r.officer, r.q)).toBe('Holding here.');
    const { x, z } = r.partner;
    r.officer.x = 9;
    run(r, 3);
    expect(r.partner.x).toBe(x);
    expect(r.partner.z).toBe(z);
  });

  it('hides while the officer drives and reappears beside them when they get out', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    r.officer.onFoot = false;
    r.partner.step(0.1, r.officer, r.q);
    expect(r.partner.view.flags[0]).toBe(FIGURE_FLAG.hidden);
    r.officer.onFoot = true;
    r.officer.building = -1;
    r.officer.x = 100;
    r.officer.z = 50;
    r.partner.step(0.1, r.officer, r.q);
    expect(r.partner.view.flags[0]).toBe(0);
    expect(r.partner.building).toBe(-1);
    expect(Math.hypot(r.partner.x - 100, r.partner.z - 50)).toBeLessThan(1.5);
    expect(r.partner.view.y[0]).toBe(0);
  });

  it('teleports beside the officer on a level change (follow mode only)', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    r.partner.teleport(-1, 40, 40, 0, r.q);
    expect(r.partner.building).toBe(-1);
    expect(Math.hypot(r.partner.x - 40, r.partner.z - 40)).toBeLessThan(1.5);
    r.partner.command('hold', r.officer, r.q);
    r.partner.teleport(1, 2, 2, 0, r.q);
    expect(r.partner.building).toBe(-1);
  });

  it('serializes and restores', () => {
    const r = rig();
    r.partner.command('summon', r.officer, r.q);
    r.partner.command('stack', r.officer, r.q);
    run(r, 0.5);
    const s = r.partner.serialize();
    const b = rig();
    b.partner.restore(s);
    expect(b.partner.serialize()).toEqual(s);
    expect(b.partner.view.count).toBe(1);
    run(r, 3);
    run(b, 3);
    expect(b.partner.x).toBeCloseTo(r.partner.x, 6);
    expect(b.partner.z).toBeCloseTo(r.partner.z, 6);
  });
});
