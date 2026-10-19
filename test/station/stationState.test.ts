import { describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { ARMORY_ITEMS } from '../../src/station/armory';
import { defaultLoadout } from '../../src/station/locker';
import {
  StationState,
  isStationSave,
  migratedStationSave,
  newShiftStationSave,
  type StationRequest,
} from '../../src/station/stationState';

const officer = (): { name: string; badge: string } => ({ name: 'Alex Rivera', badge: '4417' });
const T = { sim: 10, game: 500 };

interface Harness {
  s: StationState;
  events: { topic: string; payload: unknown }[];
}

function make(seed = 42, cells = 3): Harness {
  const bus = new EventBus<EventMap>();
  const events: { topic: string; payload: unknown }[] = [];
  for (const topic of ['station:step', 'station:armory', 'station:loadout', 'station:holding', 'station:interview'] as const) {
    bus.on(topic, (payload) => events.push({ topic, payload }));
  }
  return { s: new StationState(seed, officer, bus, cells), events };
}

describe('StationState requests', () => {
  it('applies requests only in step, in order', () => {
    const { s, events } = make();
    s.request({ kind: 'loadout', field: 'vest' });
    s.request({ kind: 'armory', item: 'sidearm', action: 'out' });
    s.request({ kind: 'hold', personId: 7 });
    expect(s.loadout.vest).toBe(true);
    expect(s.armory.has('sidearm')).toBe(false);
    expect(s.holding.cellOf(7)).toBe(-1);
    expect(events).toEqual([]);
    s.step(1 / 60, T);
    expect(s.loadout.vest).toBe(false);
    expect(s.armory.has('sidearm')).toBe(true);
    expect(s.holding.cellOf(7)).toBe(0);
    expect(events.map((e) => e.topic)).toEqual(['station:loadout', 'station:armory', 'station:step', 'station:holding']);
    // The queue is empty afterwards.
    events.length = 0;
    s.step(1 / 60, T);
    expect(events).toEqual([]);
  });

  it('completes steps and emits station:step with the new step', () => {
    const { s, events } = make();
    s.request({ kind: 'complete', step: 'locker' });
    s.step(0.016, T);
    expect(s.flow.step).toBe('briefing');
    expect(events).toEqual([{ topic: 'station:step', payload: { step: 'briefing' } }]);
    // A step that is already behind changes nothing and emits nothing.
    s.request({ kind: 'complete', step: 'locker' });
    s.step(0.016, T);
    expect(events).toHaveLength(1);
    expect(s.flow.log).toEqual([['locker', 10]]);
  });

  it('signs out through requests with the officer badge, completing the armory step on the sidearm', () => {
    const { s, events } = make();
    s.request({ kind: 'complete', step: 'locker' });
    s.request({ kind: 'complete', step: 'briefing' });
    s.request({ kind: 'armory', item: 'taser', action: 'out' });
    s.step(0.016, T);
    expect(s.flow.step).toBe('armory');
    expect(s.weaponsAvailable()).toEqual({ sidearm: false, taser: true });
    s.request({ kind: 'armory', item: 'sidearm', action: 'out' });
    s.step(0.016, { sim: 11, game: 501 });
    expect(s.flow.step).toBe('garage');
    expect(s.weaponsAvailable()).toEqual({ sidearm: true, taser: true });
    const entries = s.armory.entries();
    expect(entries.map((e) => e.officer)).toEqual(['4417', '4417']);
    expect(entries[1]).toMatchObject({ item: 'sidearm', action: 'out', sim: 11, game: 501 });
    const topics = events.map((e) => e.topic);
    expect(topics.filter((t) => t === 'station:armory')).toHaveLength(2);
    expect(topics[topics.length - 1]).toBe('station:step');
    // Returning the pistol does not move the flow back, and a repeat sign-out emits nothing.
    events.length = 0;
    s.request({ kind: 'armory', item: 'sidearm', action: 'in' });
    s.request({ kind: 'armory', item: 'baton', action: 'in' });
    s.step(0.016, T);
    expect(s.flow.step).toBe('garage');
    expect(s.weaponsAvailable().sidearm).toBe(false);
    expect(events.map((e) => e.topic)).toEqual(['station:armory']);
  });

  it('holds and releases people, emitting the cell', () => {
    const { s, events } = make(1, 1);
    s.request({ kind: 'hold', personId: 3 });
    s.request({ kind: 'hold', personId: 4 });
    s.step(0.016, T);
    expect(events).toEqual([{ topic: 'station:holding', payload: { personId: 3, cell: 0, placed: true } }]);
    events.length = 0;
    s.request({ kind: 'release', personId: 3 });
    s.request({ kind: 'release', personId: 99 });
    s.step(0.016, T);
    expect(events).toEqual([{ topic: 'station:holding', payload: { personId: 3, cell: 0, placed: false } }]);
  });

  it('sets and ends the interview, ending it when the person is released', () => {
    const { s, events } = make();
    s.request({ kind: 'hold', personId: 5 });
    s.request({ kind: 'interview', personId: 5 });
    s.step(0.016, T);
    expect(s.interviewing).toBe(5);
    s.request({ kind: 'interview', personId: 5 });
    s.step(0.016, T);
    expect(events.filter((e) => e.topic === 'station:interview')).toHaveLength(1);
    s.request({ kind: 'release', personId: 5 });
    s.step(0.016, T);
    expect(s.interviewing).toBe(-1);
    expect(events[events.length - 1]).toEqual({ topic: 'station:interview', payload: { personId: -1 } });
    s.request({ kind: 'interview', personId: 5 });
    s.request({ kind: 'interview', personId: null });
    s.step(0.016, T);
    expect(s.interviewing).toBe(-1);
  });

  it('emits a copy of the loadout', () => {
    const { s, events } = make();
    s.request({ kind: 'loadout', field: 'flashlight' });
    s.step(0.016, T);
    const payload = events[0]?.payload as { loadout: { flashlight: string } };
    expect(payload.loadout.flashlight).toBe('mounted');
    expect(s.loadout.flashlight).toBe('mounted');
  });

  it('bounds the request queue', () => {
    const { s } = make();
    for (let i = 0; i < 500; i++) s.request({ kind: 'loadout', field: 'vest' });
    expect(s.serialize().queue.length).toBeLessThanOrEqual(64);
  });
});

describe('StationState panels', () => {
  it('locker rows reflect the loadout and select requests', () => {
    const { s } = make();
    let m = s.lockerModel();
    expect(m.options.map((o) => o.label)).toEqual(['Uniform', 'Vest', 'Bodycam mount', 'Radio audio', 'Flashlight', 'Done']);
    expect(m.options.map((o) => o.detail)).toEqual(['Long sleeve', 'On', 'Chest', 'Speaker', 'Handheld', undefined]);
    s.lockerSelect(0);
    s.lockerSelect(1);
    s.lockerSelect(2);
    s.lockerSelect(3);
    s.lockerSelect(4);
    s.lockerSelect(99);
    // Nothing changes until the step.
    expect(s.lockerModel()).toEqual(m);
    s.step(0.016, T);
    m = s.lockerModel();
    expect(m.options.map((o) => o.detail)).toEqual(['Short sleeve', 'Off', 'Shoulder', 'Earpiece', 'Mounted', undefined]);
    s.lockerSelect(5);
    s.step(0.016, T);
    expect(s.flow.step).toBe('briefing');
  });

  it('armory rows show serials, sign out / return, and Done needs the sidearm', () => {
    const { s } = make();
    let m = s.armoryModel();
    expect(m.options).toHaveLength(ARMORY_ITEMS.length + 1);
    expect(m.options[0]?.label).toBe(`Sign out Duty pistol (${s.armory.serial('sidearm')})`);
    expect(m.options[0]?.label).toMatch(/^Sign out Duty pistol \(SA-\d{4}\)$/);
    expect(m.options[ARMORY_ITEMS.length]).toMatchObject({ label: 'Done', enabled: false });
    s.armorySelect(ARMORY_ITEMS.length);
    s.step(0.016, T);
    expect(s.flow.step).toBe('locker');
    s.armorySelect(0);
    s.step(0.016, T);
    m = s.armoryModel();
    expect(m.options[0]?.label).toMatch(/^Return Duty pistol \(SA-\d{4}\)$/);
    expect(m.options[ARMORY_ITEMS.length]?.enabled).not.toBe(false);
    expect(m.subtitle).toBe('1 signed out');
    s.armorySelect(0);
    s.step(0.016, T);
    expect(s.armory.has('sidearm')).toBe(false);
  });

  it('interview rows list the held people', () => {
    const { s } = make();
    const names = (id: number): string => `Person ${String(id)}`;
    let m = s.interviewModel(names);
    expect(m.options.map((o) => o.label)).toEqual(['End interview']);
    expect(m.options[0]?.enabled).toBe(false);
    s.request({ kind: 'hold', personId: 21 });
    s.request({ kind: 'hold', personId: 22 });
    s.step(0.016, T);
    m = s.interviewModel(names);
    expect(m.options.map((o) => o.label)).toEqual(['Bring in Person 21', 'Bring in Person 22', 'End interview']);
    expect(m.options[0]?.detail).toBe('Cell 1');
    s.interviewSelect(1);
    s.step(0.016, T);
    expect(s.interviewing).toBe(22);
    m = s.interviewModel(names);
    expect(m.subtitle).toBe('Interviewing Person 22');
    expect(m.options[1]?.enabled).toBe(false);
    expect(m.options[2]?.enabled).not.toBe(false);
    s.interviewSelect(2);
    s.step(0.016, T);
    expect(s.interviewing).toBe(-1);
  });
});

describe('StationState save', () => {
  it('round-trips through JSON, keeping serials and queued requests', () => {
    const a = make(9).s;
    a.request({ kind: 'complete', step: 'locker' });
    a.request({ kind: 'loadout', field: 'uniform' });
    a.request({ kind: 'armory', item: 'sidearm', action: 'out' });
    a.request({ kind: 'hold', personId: 12 });
    a.request({ kind: 'interview', personId: 12 });
    a.step(0.016, T);
    const pending: StationRequest = { kind: 'loadout', field: 'radioAudio' };
    a.request(pending);
    const saved = JSON.parse(JSON.stringify(a.serialize())) as unknown;
    expect(isStationSave(saved)).toBe(true);
    const b = make(9).s;
    if (!isStationSave(saved)) throw new Error('not a save');
    b.restore(saved);
    expect(b.serialize()).toEqual(a.serialize());
    expect(b.flow.step).toBe('garage');
    expect(b.interviewing).toBe(12);
    expect(b.armory.serial('sidearm')).toBe(a.armory.serial('sidearm'));
    // The queued request survives and applies on the next step of both.
    a.step(0.016, T);
    b.step(0.016, T);
    expect(b.serialize()).toEqual(a.serialize());
    expect(b.loadout.radioAudio).toBe('earpiece');
  });

  it('continues identically after restore (determinism)', () => {
    const script: StationRequest[] = [
      { kind: 'complete', step: 'locker' },
      { kind: 'armory', item: 'taser', action: 'out' },
      { kind: 'hold', personId: 1 },
      { kind: 'hold', personId: 2 },
      { kind: 'release', personId: 1 },
      { kind: 'loadout', field: 'bodycamMount' },
    ];
    const a = make(5).s;
    const b = make(5).s;
    for (const r of script) {
      a.request(r);
      b.request(r);
    }
    a.step(0.016, T);
    b.step(0.016, T);
    expect(a.serialize()).toEqual(b.serialize());
  });

  it('validates saves', () => {
    expect(isStationSave(newShiftStationSave())).toBe(true);
    expect(isStationSave(migratedStationSave('4417'))).toBe(true);
    expect(isStationSave(null)).toBe(false);
    expect(isStationSave({})).toBe(false);
    expect(isStationSave({ ...newShiftStationSave(), version: 2 })).toBe(false);
    expect(isStationSave({ ...newShiftStationSave(), flow: 'lunch' })).toBe(false);
    expect(isStationSave({ ...newShiftStationSave(), loadout: { ...defaultLoadout(), uniform: 'x' } })).toBe(false);
    expect(isStationSave({ ...newShiftStationSave(), queue: [{ kind: 'explode' }] })).toBe(false);
    expect(isStationSave({ ...newShiftStationSave(), queue: [{ kind: 'armory', item: 'nope', action: 'out' }] })).toBe(false);
    expect(isStationSave({ ...newShiftStationSave(), holding: [[0, 1]] })).toBe(false);
    expect(isStationSave({ ...newShiftStationSave(), interviewing: 'x' })).toBe(false);
    expect(isStationSave({ ...newShiftStationSave(), flowLog: [['locker', 'x']] })).toBe(false);
  });

  it('newShiftStationSave starts at the locker with nothing signed out', () => {
    const save = newShiftStationSave();
    expect(save).toMatchObject({ version: 1, flow: 'locker', flowLog: [], armory: [], holding: [], interviewing: -1, queue: [] });
    expect(save.loadout).toEqual(defaultLoadout());
    const s = make().s;
    s.restore(save);
    expect(s.flow.step).toBe('locker');
    expect(s.weaponsAvailable()).toEqual({ sidearm: false, taser: false });
  });

  it('migratedStationSave is on patrol with the pistol and the CED signed out at sim 0', () => {
    const save = migratedStationSave('4417');
    expect(save.flow).toBe('onPatrol');
    expect(save.armory.map((e) => [e.item, e.action, e.officer, e.sim])).toEqual([
      ['sidearm', 'out', '4417', 0],
      ['taser', 'out', '4417', 0],
    ]);
    const s = make(77).s;
    s.restore(save);
    expect(s.flow.step).toBe('onPatrol');
    expect(s.flow.objective()).toBeNull();
    expect(s.weaponsAvailable()).toEqual({ sidearm: true, taser: true });
    // Serials are re-derived from the session seed.
    expect(s.armory.entries().map((e) => e.serial)).toEqual([s.armory.serial('sidearm'), s.armory.serial('taser')]);
    expect(s.armory.entries()[0]?.serial).toMatch(/^SA-\d{4}$/);
  });
});
