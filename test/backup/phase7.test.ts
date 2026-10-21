import { describe, expect, it } from 'vitest';
import { SWAT_CONFIG } from '../../src/backup/data';
import { clearOrder } from '../../src/backup/swat';
import type { BackupAppearance, BackupAppearanceRole } from '../../src/backup/types';
import { generateInterior } from '../../src/interior/generate';
import { ACTOR_STATE } from '../../src/npc/types';
import { TACTICS } from '../../src/tactical/data';
import { cityBuildings, indexFor, SEED as CITY_SEED } from '../interior/helpers';
import { Rig, SEED, START_FATIGUE, START_STRESS, NO_MISTAKES, findCallsigns } from './helpers';

/** Phase 7 hooks (design §11.5): AI officer outfits in the backup view. */

const CLEAN = findCallsigns(3, SEED, START_STRESS, START_FATIGUE, NO_MISTAKES);

/** An `appearanceOf` that records its questions and answers a recognisable look per callsign. */
function lookups(answer: (callsign: string, role: BackupAppearanceRole, n: number) => BackupAppearance | null = (_c, role, n) => ({
  outfit: 10 + n,
  top: role === 'supervisor' ? 0x112233 : role === 'swat' ? 0x445566 : 0x778899,
  bottom: 0xaabbcc + n,
})): { asked: { callsign: string; role: BackupAppearanceRole }[]; fn: (callsign: string, role: BackupAppearanceRole) => BackupAppearance | null } {
  const asked: { callsign: string; role: BackupAppearanceRole }[] = [];
  return {
    asked,
    fn: (callsign, role) => {
      asked.push({ callsign, role });
      return answer(callsign, role, asked.length);
    },
  };
}

function scene(rig: Rig): void {
  rig.openCall();
  rig.ctx.x = 0;
  rig.ctx.z = 0;
  rig.ctx.yaw = 0;
  rig.ctx.contactPersonId = 101;
  rig.npc.add({ id: 1, personId: 101, role: 'subject', x: 0, z: -3, state: ACTOR_STATE.idle });
}

describe('backup view outfits', () => {
  it('the view carries an outfit array sized for officers and operators, stable across steps', () => {
    const rig = new Rig();
    const cap = rig.sys.view.x.length;
    expect(rig.sys.view.outfit).toBeInstanceOf(Uint16Array);
    expect(rig.sys.view.outfit.length).toBe(cap);
    const arr = rig.sys.view.outfit;
    scene(rig);
    rig.unitOnScene(CLEAN[0] as string, 12, 6, 0);
    rig.step(30);
    expect(rig.sys.view.outfit).toBe(arr);
  });

  it('writes outfit, top and bottom from appearanceOf; sergeants ask for the supervisor look', () => {
    const l = lookups();
    const rig = new Rig({ appearanceOf: l.fn });
    scene(rig);
    rig.unitOnScene(CLEAN[0] as string, 12, 6, 0);
    rig.unitOnScene('SGT-1', 14, 6, 0, 'resource');
    rig.step(10);
    const v = rig.sys.view;
    expect(rig.sys.view.count).toBe(2);
    const askedFor = (cs: string): { callsign: string; role: BackupAppearanceRole } | undefined => l.asked.find((a) => a.callsign === cs);
    expect(askedFor(CLEAN[0] as string)?.role).toBe('patrol');
    expect(askedFor('SGT-1')?.role).toBe('supervisor');
    // Slot 0 is the first officer, slot 1 the sergeant (stable slots in arrival order).
    const first = l.asked.findIndex((a) => a.callsign === CLEAN[0]) + 1;
    const second = l.asked.findIndex((a) => a.callsign === 'SGT-1') + 1;
    expect(v.outfit[0]).toBe(10 + first);
    expect(v.top[0]).toBe(0x778899);
    expect(v.bottom[0]).toBe(0xaabbcc + first);
    expect(v.outfit[1]).toBe(10 + second);
    expect(v.top[1]).toBe(0x112233);
    expect(v.bottom[1]).toBe(0xaabbcc + second);
  });

  it('asks once per callsign, however many steps write the view', () => {
    const l = lookups();
    const rig = new Rig({ appearanceOf: l.fn });
    scene(rig);
    CLEAN.slice(0, 3).forEach((cs, i) => rig.unitOnScene(cs, 12 + i, 6, 0));
    rig.step(60 * 10);
    expect(l.asked.map((a) => a.callsign).sort()).toEqual([...CLEAN].sort());
  });

  it('falls back to the Phase 6 colours and outfit 0 without the dependency or when it answers null', () => {
    for (const rig of [new Rig(), new Rig({ appearanceOf: lookups(() => null).fn })]) {
      scene(rig);
      rig.unitOnScene(CLEAN[0] as string, 12, 6, 0);
      rig.step(10);
      expect(rig.sys.view.count).toBe(1);
      expect(rig.sys.view.outfit[0]).toBe(0);
      expect(rig.sys.view.top[0]).toBe(TACTICS.partner.colors.top);
      expect(rig.sys.view.bottom[0]).toBe(TACTICS.partner.colors.bottom);
    }
    // A null answer is cached too: the dependency is not asked again every step.
    const l = lookups(() => null);
    const rig = new Rig({ appearanceOf: l.fn });
    scene(rig);
    rig.unitOnScene(CLEAN[0] as string, 12, 6, 0);
    rig.step(120);
    expect(l.asked).toHaveLength(1);
  });

  it('a slot reused by another officer gets that officer\'s outfit', () => {
    const l = lookups();
    const rig = new Rig({ appearanceOf: l.fn });
    scene(rig);
    rig.unitOnScene(CLEAN[0] as string, 12, 6, 0);
    rig.step(10);
    const before = rig.sys.view.outfit[0];
    rig.sys.request({ kind: 'command', callsign: CLEAN[0] as string, command: 'release' });
    rig.step(60 * 15);
    rig.unitOnScene(CLEAN[1] as string, 13, 6, 0);
    rig.step(10);
    expect(rig.sys.view.outfit[0]).not.toBe(before);
    expect(rig.sys.view.outfit[0]).toBe(10 + l.asked.findIndex((a) => a.callsign === CLEAN[1]) + 1);
  });
});

describe('SWAT operator outfits', () => {
  const index = indexFor();
  const houseInfo = cityBuildings(index, 3).find((b) => b.kind === 'house')!;
  const house = generateInterior(CITY_SEED, houseInfo)!;

  function swat(opts: ConstructorParameters<typeof Rig>[0]): Rig {
    const rig = new Rig({ seed: 1, ...opts });
    const callId = rig.openCall();
    const info = houseInfo;
    rig.buildings.set(info.id, { minX: info.minX, minZ: info.minZ, maxX: info.maxX, maxZ: info.maxZ, door: info.door });
    rig.interiors.layouts.set(info.id, house);
    rig.callBuildingId = info.id;
    rig.swatCount = 1;
    rig.ctx.x = info.door.x;
    rig.ctx.z = info.door.z;
    rig.ctx.yaw = info.door.yaw;
    const out = { x: -Math.sin(info.door.yaw), z: -Math.cos(info.door.yaw) };
    rig.unitOnScene('TAC-1', info.door.x + out.x * 22, info.door.z + out.z * 22, info.door.yaw, 'resource');
    const main = house.doors.find((d) => d.main)!;
    const room = clearOrder(house, main.a).at(-1)!;
    const r = house.rooms[room]!.rect;
    rig.npc.add({ id: 7, personId: 555, role: 'subject', building: info.id, callId, x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2, state: ACTOR_STATE.armed, weaponDrawn: true });
    return rig;
  }

  const ops = SWAT_CONFIG.operators;

  it('writes TAC-op<k> looks into the operator slots, once per operator', () => {
    const l = lookups();
    const rig = swat({ appearanceOf: l.fn });
    rig.step(60);
    const base = rig.sys.view.count - ops;
    expect(base).toBeGreaterThanOrEqual(0);
    const swatAsks = l.asked.filter((a) => a.role === 'swat');
    expect(swatAsks.map((a) => a.callsign).sort()).toEqual(Array.from({ length: ops }, (_, k) => `TAC-op${k}`));
    for (let k = 0; k < ops; k++) {
      const n = l.asked.findIndex((a) => a.callsign === `TAC-op${k}`) + 1;
      const slot = 8 + k;
      expect(rig.sys.view.outfit[slot]).toBe(10 + n);
      expect(rig.sys.view.top[slot]).toBe(0x445566);
      expect(rig.sys.view.bottom[slot]).toBe(0xaabbcc + n);
    }
    rig.step(60 * 5);
    expect(l.asked.filter((a) => a.role === 'swat')).toHaveLength(ops);
  });

  it('keeps the Phase 6 SWAT colours and outfit 0 without the dependency', () => {
    const rig = swat({});
    rig.step(60);
    for (let k = 0; k < ops; k++) {
      expect(rig.sys.view.outfit[8 + k]).toBe(0);
      expect(rig.sys.view.top[8 + k]).toBe(SWAT_CONFIG.colors.top);
      expect(rig.sys.view.bottom[8 + k]).toBe(SWAT_CONFIG.colors.bottom);
    }
  });
});
