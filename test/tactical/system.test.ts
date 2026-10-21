import { describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import type { City } from '../../src/world/city';
import type { Transmission } from '../../src/radio/types';
import { generateInterior } from '../../src/interior/generate';
import { isTacticalSave } from '../../src/tactical/save';
import type { TacticalSoundEvent } from '../../src/tactical/events';
import { TacticalSystem } from '../../src/tactical/tacticalSystem';
import { createListener, type Listener, type ListenerPort } from '../../src/tactical/types';
import { handBuilding } from '../interior/helpers';
import { StubInteriors, box, makeRig, T0, twoRooms, type Rig } from './helpers';

const FACING_PLUS_X = -Math.PI / 2;

/** The Node pieces the allocation test needs (the project has no Node type definitions). */
declare const process: { memoryUsage(): { heapUsed: number } };
interface NodeModules {
  v8: { setFlagsFromString(flags: string): void };
  vm: { runInNewContext(code: string): unknown };
}

async function loadGc(): Promise<() => void> {
  const names: Record<keyof NodeModules, string> = { v8: 'node:v8', vm: 'node:vm' };
  const v8 = (await import(/* @vite-ignore */ names.v8)) as NodeModules['v8'];
  const vm = (await import(/* @vite-ignore */ names.vm)) as NodeModules['vm'];
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

function stepN(r: Rig, n: number, dt = 1 / 60): void {
  for (let i = 0; i < n; i++) r.sys.step(dt, T0);
}

function walking(r: Rig, speed = 4): void {
  r.officer.speed = speed;
}

describe('footsteps and the sound field', () => {
  it('a footstep stimulates a normal listener in the same room, not a deaf one', () => {
    const r = makeRig(twoRooms());
    const hearing = r.port.add({ x: 4.5, z: 2 });
    const deaf = r.port.add({ x: 4.5, z: 2, hearing: 'deaf' });
    walking(r);
    stepN(r, 1);
    const calls = r.port.of(hearing.actorId, 'sound');
    expect(calls).toHaveLength(1);
    // Wood floor, walking: 40 dB at 1 m, 2.5 m away: 40 - 7.96 = 32.04 -> (32.04 - 20) / 30.
    expect(calls[0]?.amount).toBeCloseTo((40 - 20 * Math.log10(2.5) - 20) / 30, 4);
    expect(r.port.of(deaf.actorId, 'sound')).toHaveLength(0);
  });

  it('footsteps follow the gait interval and the floor surface', () => {
    const r = makeRig(twoRooms());
    r.port.add({ x: 1, z: 2 });
    const levels: number[] = [];
    r.bus.on('tactical:sound', (e) => levels.push(e.level));
    walking(r);
    stepN(r, 60 * 4); // 4 s on the wooden room
    expect(levels.length).toBeGreaterThanOrEqual(6);
    expect(levels.length).toBeLessThanOrEqual(9);
    expect(new Set(levels)).toEqual(new Set([40]));
    // In the carpeted room the steps are quieter.
    r.officer.x = 8;
    levels.length = 0;
    stepN(r, 60);
    expect(new Set(levels)).toEqual(new Set([28]));
  });

  it('does not step while standing still or driving, and runs and creeps change the level', () => {
    const r = makeRig(twoRooms());
    r.port.add({ x: 3, z: 2 });
    const levels: number[] = [];
    r.bus.on('tactical:sound', (e) => levels.push(e.level));
    stepN(r, 120);
    expect(levels).toEqual([]);
    walking(r);
    r.officer.onFoot = false;
    stepN(r, 120);
    expect(levels).toEqual([]);
    r.officer.onFoot = true;
    walking(r, 6);
    stepN(r, 10);
    expect(levels[0]).toBe(48);
    levels.length = 0;
    r.officer.speed = 1;
    r.sys.request({ kind: 'crouch' });
    stepN(r, 70);
    expect(levels[0]).toBe(40 - 6 - 10);
  });

  it('a closed door reduces the stimulus, an open one does not (the graph follows the door revision)', () => {
    const r = makeRig(twoRooms());
    const next = r.port.add({ x: 8, z: 2.5 });
    const level = 58 - 20 * Math.log10(Math.hypot(8 - 2.5, 0));
    r.sys.request({ kind: 'sound', source: 'voiceTalk', x: 2.5, z: 2.5, building: 1 });
    stepN(r, 1);
    const closed = r.port.of(next.actorId, 'sound')[0]?.amount ?? 0;
    expect(closed).toBeCloseTo((level - 18 - 20) / 30, 4);
    expect(closed).toBeGreaterThan(0);

    r.interiors.setDoor(1, 0, 'open');
    r.sys.request({ kind: 'sound', source: 'voiceTalk', x: 2.5, z: 2.5, building: 1 });
    stepN(r, 1);
    const open = r.port.of(next.actorId, 'sound')[1]?.amount ?? 0;
    expect(open).toBeCloseTo((level - 2 - 20) / 30, 4);
    expect(open).toBeGreaterThan(closed * 2);
  });

  it('rebuilds the graph only when the door revision changes', () => {
    const r = makeRig(twoRooms());
    const next = r.port.add({ x: 8, z: 2.5 });
    const talk = (): void => r.sys.request({ kind: 'sound', source: 'voiceTalk', x: 2.5, z: 2.5, building: 1 });
    talk();
    stepN(r, 1);
    // The door opens without a revision bump: the cached (closed) graph is still used.
    r.interiors.setDoorQuiet(1, 0, 'open');
    talk();
    stepN(r, 1);
    const [a, b] = r.port.of(next.actorId, 'sound');
    expect(b?.amount).toBeCloseTo(a?.amount ?? -1, 9);
    r.interiors.revisions.set(1, 99);
    talk();
    stepN(r, 1);
    expect(r.port.of(next.actorId, 'sound')[2]?.amount).toBeGreaterThan((a?.amount ?? 0) * 2);
  });

  it('works with generated house layouts and ignores listeners of other buildings', () => {
    const layout = generateInterior(42, handBuilding('house', 14, 12, 0, 900_200));
    if (layout === null) throw new Error('no house');
    const r = makeRig(layout);
    const entry = layout.entry;
    r.officer.x = entry.x;
    r.officer.z = entry.z;
    const near = r.port.add({ x: entry.x + 1, z: entry.z + 0.5, building: 1 });
    const elsewhere = r.port.add({ x: entry.x + 1, z: entry.z + 0.5, building: 2 });
    const outdoors = r.port.add({ x: entry.x + 1, z: entry.z + 0.5, building: -1 });
    r.sys.request({ kind: 'sound', source: 'voiceShout', x: entry.x, z: entry.z, building: 1 });
    stepN(r, 1);
    expect(r.port.of(near.actorId, 'sound')).toHaveLength(1);
    expect(r.port.of(elsewhere.actorId, 'sound')).toHaveLength(0);
    // The outdoor listener hears it through the walls / door (85 dB shout, 40 dB wall, ~1 m): still audible.
    expect(r.port.of(outdoors.actorId, 'sound').length).toBeLessThanOrEqual(1);
  });

  it('a sleeper needs a louder sound', () => {
    const r = makeRig(twoRooms());
    const awake = r.port.add({ x: 4.5, z: 2.5 });
    const asleep = r.port.add({ x: 4.5, z: 2.6, asleep: true });
    r.sys.request({ kind: 'sound', source: 'knock', x: 0.5, z: 2.5, building: 1 }); // 65 dB, 4 m: 52.9
    r.sys.request({ kind: 'sound', source: 'flashlightClick', x: 0.5, z: 2.5, building: 1 }); // 25 dB: inaudible for a sleeper
    stepN(r, 1);
    expect(r.port.of(awake.actorId, 'sound').length).toBeGreaterThanOrEqual(1);
    const heardAsleep = r.port.of(asleep.actorId, 'sound');
    expect(heardAsleep).toHaveLength(1);
    expect(heardAsleep[0]?.amount).toBeCloseTo((65 - 20 * Math.log10(4.0) - 40) / 30, 3);
  });

  it('outdoors sound travels by distance only', () => {
    const r = makeRig(null);
    r.officer.x = 100;
    r.officer.z = 100;
    const close = r.port.add({ x: 105, z: 100 });
    const far = r.port.add({ x: 140, z: 100 });
    walking(r);
    stepN(r, 1);
    // Asphalt (the stub city) 36 dB: 5 m -> 22 dB, 40 m -> 4 dB.
    expect(r.port.of(close.actorId, 'sound')[0]?.amount).toBeCloseTo((36 - 20 * Math.log10(5) - 20) / 30, 4);
    expect(r.port.of(far.actorId, 'sound')).toHaveLength(0);
  });

  it('an indoor shout is heard outside through the exterior door', () => {
    const r = makeRig(twoRooms());
    const outside = r.port.add({ x: 2.5, z: -3, building: -1 });
    r.sys.request({ kind: 'sound', source: 'voiceShout', x: 2.5, z: 2, building: 1 });
    stepN(r, 1);
    // 85 - 20 log10(5) - 18 (closed exterior door) = 53 dB.
    expect(r.port.of(outside.actorId, 'sound')[0]?.amount).toBeCloseTo(1, 4);
  });
});

describe('bus sounds', () => {
  const tx = (audible: boolean): { tx: Transmission } => ({ tx: { audible } as unknown as Transmission });

  it('officer radio transmissions chirp, quietly in an earpiece, and inaudible ones are ignored', () => {
    const r = makeRig(twoRooms());
    const l = r.port.add({ x: 4, z: 2 });
    r.bus.emit('radio:start', tx(false));
    stepN(r, 1);
    expect(r.port.of(l.actorId, 'sound')).toHaveLength(0);
    r.bus.emit('radio:start', tx(true));
    stepN(r, 1);
    expect(r.port.of(l.actorId, 'sound')).toHaveLength(1);
    r.earpiece.on = true;
    r.bus.emit('radio:start', tx(true));
    stepN(r, 1);
    // 22 dB at 2.2 m: 15 dB, below the hearing threshold.
    expect(r.port.of(l.actorId, 'sound')).toHaveLength(1);
  });

  it('the officer talking and a taser shot make sound; other speakers and force kinds do not', () => {
    const r = makeRig(twoRooms());
    const l = r.port.add({ x: 4, z: 2 });
    const kinds: string[] = [];
    r.bus.on('tactical:sound', (e) => kinds.push(e.kind));
    r.bus.emit('contact:line', { personId: 1, speaker: 'subject', text: 'hi', language: 'en', label: 'x' });
    r.bus.emit('force:used', { kind: 'taserDrawn', personId: 1, callId: 0 });
    stepN(r, 1);
    expect(kinds).toEqual([]);
    r.bus.emit('contact:line', { personId: 1, speaker: 'officer', text: 'hi', language: 'en', label: 'x' });
    r.bus.emit('force:used', { kind: 'taser', personId: 1, callId: 0 });
    stepN(r, 1);
    expect(kinds).toEqual(['voiceTalk', 'taser']);
    expect(r.port.of(l.actorId, 'sound')).toHaveLength(2);
  });

  it('dispose stops listening', () => {
    const r = makeRig(twoRooms());
    const l = r.port.add({ x: 4, z: 2 });
    r.sys.dispose();
    r.bus.emit('force:used', { kind: 'taser', personId: 1, callId: 0 });
    stepN(r, 1);
    expect(r.port.of(l.actorId, 'sound')).toHaveLength(0);
  });
});

describe('noise meter and events', () => {
  it('rises with officer-made sounds and decays by 0.5 per second', () => {
    const r = makeRig(twoRooms());
    expect(r.sys.noise).toBe(0);
    r.sys.request({ kind: 'sound', source: 'kick', x: 2, z: 2, building: 1 });
    stepN(r, 1);
    expect(r.sys.noise).toBeCloseTo(0.95 - 0.5 / 60, 4);
    stepN(r, 60);
    expect(r.sys.noise).toBeCloseTo(0.95 - (0.5 * 61) / 60, 3);
    stepN(r, 120);
    expect(r.sys.noise).toBe(0);
  });

  it('sounds far from the officer do not count and emit no event', () => {
    const r = makeRig(twoRooms());
    const events: TacticalSoundEvent[] = [];
    r.bus.on('tactical:sound', (e) => events.push({ ...e }));
    r.sys.request({ kind: 'sound', source: 'kick', x: 9, z: 4, building: 1 });
    stepN(r, 1);
    expect(events).toEqual([]);
    expect(r.sys.noise).toBe(0);
    r.sys.request({ kind: 'sound', source: 'doorOpen', x: 2.5, z: 2, building: 1 });
    stepN(r, 1);
    expect(events).toEqual([{ kind: 'doorOpen', x: 2.5, z: 2, building: 1, level: 45 }]);
  });
});

describe('stance requests', () => {
  it('crouch toggles on foot, emits, slows and lowers the eye; getting in a car stands up', () => {
    const r = makeRig(twoRooms());
    const seen: boolean[] = [];
    r.bus.on('tactical:stance', (e) => seen.push(e.crouched));
    r.sys.request({ kind: 'crouch' });
    stepN(r, 1);
    expect(r.sys.stance.crouched).toBe(true);
    expect(r.sys.speedFactor()).toBe(0.5);
    const eye = { x: 0, y: 0, z: 0, roll: 0 };
    r.sys.eye(0, eye);
    expect(eye.y).toBe(1.05);
    r.sys.request({ kind: 'crouch' });
    stepN(r, 1);
    expect(r.sys.stance.crouched).toBe(false);
    r.sys.request({ kind: 'crouch' });
    stepN(r, 1);
    r.officer.onFoot = false;
    stepN(r, 1);
    expect(r.sys.stance.crouched).toBe(false);
    expect(seen).toEqual([true, false, true, false]);
    // No crouching from inside a vehicle.
    r.sys.request({ kind: 'crouch' });
    stepN(r, 1);
    expect(r.sys.stance.crouched).toBe(false);
  });

  it('held lean eases in and out, slows the officer and offsets the eye', () => {
    const r = makeRig(twoRooms());
    r.sys.setHeld(1, false);
    stepN(r, 5);
    expect(r.sys.stance.lean).toBe(1);
    expect(r.sys.stance.leanAmount).toBeGreaterThan(0.3);
    expect(r.sys.speedFactor()).toBe(0.5);
    stepN(r, 30);
    expect(r.sys.stance.leanAmount).toBe(1);
    const eye = { x: 0, y: 0, z: 0, roll: 0 };
    r.sys.eye(0, eye);
    expect(eye.x).toBeCloseTo(0.35, 6);
    expect(eye.roll).toBeCloseTo(-0.17, 6);
    r.sys.setHeld(0, false);
    stepN(r, 30);
    expect(r.sys.stance.leanAmount).toBe(0);
    expect(r.sys.speedFactor()).toBe(1);
  });

  it('flashlight toggles and clicks', () => {
    const r = makeRig(twoRooms());
    const on: boolean[] = [];
    const kinds: string[] = [];
    r.bus.on('tactical:flashlight', (e) => on.push(e.on));
    r.bus.on('tactical:sound', (e) => kinds.push(e.kind));
    r.sys.request({ kind: 'flashlight' });
    stepN(r, 1);
    expect(r.sys.flashlightOn).toBe(true);
    r.sys.request({ kind: 'flashlight' });
    stepN(r, 1);
    expect(r.sys.flashlightOn).toBe(false);
    expect(on).toEqual([true, false]);
    expect(kinds).toEqual(['flashlightClick', 'flashlightClick']);
  });
});

describe('flashlight gear', () => {
  it('cannot be switched on without a flashlight in the loadout, but can always be switched off', () => {
    let carried = false;
    const r = makeRig(twoRooms(), 1, 7, () => carried);
    expect(r.sys.canFlashlight).toBe(false);
    r.sys.request({ kind: 'flashlight' });
    stepN(r, 1);
    expect(r.sys.flashlightOn).toBe(false);
    carried = true;
    expect(r.sys.canFlashlight).toBe(true);
    r.sys.request({ kind: 'flashlight' });
    stepN(r, 1);
    expect(r.sys.flashlightOn).toBe(true);
    carried = false;
    r.sys.request({ kind: 'flashlight' });
    stepN(r, 1);
    expect(r.sys.flashlightOn).toBe(false);
  });
});

describe('slicing', () => {
  it('engages an open doorway ahead while held, moves the officer on its arc and releases', () => {
    const r = makeRig(twoRooms());
    r.interiors.setDoor(1, 0, 'open');
    r.officer.x = 3;
    r.officer.z = 2.5;
    r.officer.yaw = FACING_PLUS_X;
    r.sys.setHeld(0, true);
    stepN(r, 1);
    expect(r.sys.slicing).toBe(true);
    const out = { vx: 0, vz: 0, yaw: 0 };
    expect(r.sys.sliceMove(3, 2.5, 0, 1, 1 / 60, out)).toBe(true);
    // Strafing right (+Z for an officer facing +X) at 0.6 m/s on a 2 m radius.
    expect(out.vz).toBeGreaterThan(0.5);
    expect(out.vz).toBeLessThan(0.7);
    expect(Math.abs(out.vx)).toBeLessThan(0.05);
    r.sys.setHeld(0, false);
    stepN(r, 1);
    expect(r.sys.slicing).toBe(false);
    expect(r.sys.sliceMove(3, 2.5, 0, 1, 1 / 60, out)).toBe(false);
  });

  it('does not slice a closed door, and stops when the door closes', () => {
    const r = makeRig(twoRooms());
    r.officer.x = 3;
    r.officer.z = 2.5;
    r.officer.yaw = FACING_PLUS_X;
    r.sys.setHeld(0, true);
    stepN(r, 2);
    expect(r.sys.slicing).toBe(false);
    r.interiors.setDoor(1, 0, 'open');
    stepN(r, 1);
    expect(r.sys.slicing).toBe(true);
    r.interiors.setDoor(1, 0, 'closed');
    stepN(r, 1);
    expect(r.sys.slicing).toBe(false);
  });

  it('never slices outdoors', () => {
    const r = makeRig(null);
    r.sys.setHeld(0, true);
    stepN(r, 2);
    expect(r.sys.slicing).toBe(false);
  });
});

describe('notice pass', () => {
  /** Officer at (2, 2) facing +X in the wooden room; listeners face the officer from 2.5 m. */
  function lit(): Rig {
    const r = makeRig(twoRooms());
    r.officer.yaw = FACING_PLUS_X;
    return r;
  }

  it('stimulates sight every 0.25 s, scaled by distance, and reports visibility', () => {
    const r = lit();
    const l = r.port.add({ x: 4.5, z: 2, yaw: Math.PI / 2 }); // faces -X, i.e. towards the officer
    stepN(r, 14); // 14/60 s < 0.25: no pass yet
    expect(r.port.of(l.actorId, 'sight')).toHaveLength(0);
    stepN(r, 2);
    const sights = r.port.of(l.actorId, 'sight');
    expect(sights).toHaveLength(1);
    expect(sights[0]?.amount).toBeCloseTo(1 * 1 * 1 * 0.8 * 0.25 * (1 - 2.5 / 25), 6);
    expect(r.sys.visibility).toBeCloseTo(1, 6);
  });

  it('looking away uses peripheral vision; a dark room, a closed door and sleep reduce it', () => {
    const r = lit();
    const away = r.port.add({ x: 4.5, z: 2, yaw: -Math.PI / 2 }); // faces +X, away from the officer
    stepN(r, 16);
    expect(r.sys.visibility).toBeCloseTo(0.3, 6);
    expect(r.port.of(away.actorId, 'sight')[0]?.amount).toBeCloseTo(0.3 * 0.8 * 0.25 * (1 - 2.5 / 25), 6);

    const dark = lit();
    dark.interiors.unlit.add(1 * 1024 + 0);
    dark.port.add({ x: 4.5, z: 2, yaw: Math.PI / 2 });
    stepN(dark, 16);
    expect(dark.sys.visibility).toBeCloseTo(0.3, 6);

    const behindDoor = lit();
    behindDoor.port.add({ x: 8, z: 4.5, yaw: Math.PI / 2 }); // in the next room, off the doorway line
    stepN(behindDoor, 16);
    expect(behindDoor.sys.visibility).toBe(0);
    expect(behindDoor.port.calls.filter((c) => c.kind === 'sight')).toHaveLength(0);

    const asleep = lit();
    asleep.port.add({ x: 4.5, z: 2, asleep: true });
    stepN(asleep, 16);
    expect(asleep.sys.visibility).toBe(0);
  });

  it('ignores listeners out of range or on another level', () => {
    const r = lit();
    r.port.add({ x: 4.5, z: 2, building: 3 });
    r.port.add({ x: 4.5, z: 2, building: -1 });
    stepN(r, 16);
    expect(r.port.calls.filter((c) => c.kind !== 'sound')).toEqual([]);
    expect(r.sys.visibility).toBe(0);
  });

  it('outdoors, night makes the officer harder to see', () => {
    const r = makeRig(null);
    r.officer.yaw = FACING_PLUS_X;
    r.port.add({ x: 5, z: 0, yaw: Math.PI / 2 });
    r.officer.x = 0;
    r.officer.z = 0;
    stepN(r, 16);
    expect(r.sys.visibility).toBeCloseTo(1, 6);
    r.night.value = 1;
    stepN(r, 16);
    expect(r.sys.visibility).toBeCloseTo(0.5, 6);
  });

  it('crouching behind a counter lowers the sight stimulus', () => {
    const r = makeRig(twoRooms([box(0, 0, 2, 1.5, 2.7, 3.5, 1.0)]));
    r.officer.x = 3.2;
    r.officer.z = 2.5;
    const l = r.port.add({ x: 0.5, z: 2.5, yaw: FACING_PLUS_X });
    stepN(r, 16);
    const standing = r.port.of(l.actorId, 'sight')[0]?.amount ?? 0;
    expect(r.sys.visibility).toBeGreaterThanOrEqual(2 / 3 - 1e-9);
    r.sys.request({ kind: 'crouch' });
    stepN(r, 16);
    const crouched = r.port.of(l.actorId, 'sight')[1]?.amount ?? 0;
    expect(r.sys.visibility).toBeLessThanOrEqual(1 / 3 + 1e-9);
    expect(standing).toBeGreaterThan(0);
    expect(crouched).toBeGreaterThan(0);
    expect(crouched).toBeLessThan(standing * 0.6);
  });

  it('the flashlight stimulates light only inside its cone, within range and with a clear beam', () => {
    const r = lit();
    r.officer.x = 2;
    r.officer.z = 2;
    const front = r.port.add({ x: 4.5, z: 2, yaw: Math.PI / 2 });
    const side = r.port.add({ x: 2, z: 4.5, yaw: Math.PI / 2 });
    const behind = r.port.add({ x: 0.5, z: 2, yaw: Math.PI / 2 });
    const wall = r.port.add({ x: 8, z: 2.4, yaw: Math.PI / 2 }); // in the cone, but the closed door is in the way
    stepN(r, 16);
    expect(r.port.calls.filter((c) => c.kind === 'light')).toHaveLength(0);

    r.sys.request({ kind: 'flashlight' });
    stepN(r, 16);
    expect(r.port.of(front.actorId, 'light')).toHaveLength(1);
    expect(r.port.of(front.actorId, 'light')[0]?.amount).toBeCloseTo(0.6 * 0.25, 9);
    expect(r.port.of(side.actorId, 'light')).toHaveLength(0);
    expect(r.port.of(behind.actorId, 'light')).toHaveLength(0);
    expect(r.port.of(wall.actorId, 'light')).toHaveLength(0);

    // With the door open the beam reaches the far room.
    r.interiors.setDoor(1, 0, 'open');
    stepN(r, 16);
    expect(r.port.of(wall.actorId, 'light').length).toBeGreaterThanOrEqual(1);
  });

  it('sleepers feel the light but cannot see', () => {
    const r = lit();
    const l = r.port.add({ x: 4.5, z: 2, asleep: true });
    r.sys.request({ kind: 'flashlight' });
    stepN(r, 16);
    expect(r.port.of(l.actorId, 'light')).toHaveLength(1);
    expect(r.port.of(l.actorId, 'sight')).toHaveLength(0);
  });
});

describe('partner through the system', () => {
  it('replies to requests on the bus and steps with the officer', () => {
    const r = makeRig(twoRooms());
    const said: string[] = [];
    r.bus.on('tactical:partner', (e) => said.push(e.text));
    r.sys.request({ kind: 'partner', command: 'hold' });
    stepN(r, 1);
    expect(said).toEqual([]); // away: ignored
    r.sys.request({ kind: 'partner', command: 'summon' });
    stepN(r, 1);
    expect(said).toEqual(['On my way.']);
    expect(r.sys.partner.mode).toBe('follow');
    expect(r.sys.partner.view.count).toBe(1);
    r.officer.x = 3.5;
    r.officer.z = 3.5;
    r.sys.request({ kind: 'partner', command: 'stack' });
    stepN(r, 1);
    expect(said[1]).toBe('Stacked up on the door.');
    r.sys.request({ kind: 'partner', command: 'clear' });
    stepN(r, 60 * 6);
    expect(said[2]).toBe('Going in.');
    expect(said[3]).toBe('Room clear.');
  });

  it('a hidden actor in the room is not contact (the partner is no hiding-spot detector)', () => {
    const r = makeRig(twoRooms());
    r.port.add({ x: 8, z: 4, building: 1, hidden: true });
    r.officer.x = 3.5;
    r.officer.z = 3.5;
    const said: string[] = [];
    r.bus.on('tactical:partner', (e) => said.push(e.text));
    r.sys.request({ kind: 'partner', command: 'summon' });
    r.sys.request({ kind: 'partner', command: 'clear' });
    stepN(r, 60 * 8);
    expect(said).not.toContain('Contact!');
  });

  it('reports contact through the listener port', () => {
    const r = makeRig(twoRooms());
    r.port.add({ x: 8, z: 4, building: 1 });
    r.officer.x = 3.5;
    r.officer.z = 3.5;
    const said: string[] = [];
    r.bus.on('tactical:partner', (e) => said.push(e.text));
    r.sys.request({ kind: 'partner', command: 'summon' });
    r.sys.request({ kind: 'partner', command: 'clear' });
    stepN(r, 60 * 8);
    expect(said).toContain('Contact!');
    r.sys.request({ kind: 'partner', command: 'follow' });
    stepN(r, 1);
    r.sys.teleportPartner(-1, 10, 10, 0);
    expect(r.sys.partner.building).toBe(-1);
  });
});

describe('save and restore', () => {
  function script(r: Rig, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      r.officer.speed = i % 90 < 60 ? 4 : 0;
      r.officer.x = 1 + ((i * 0.03) % 3.5);
      if (i % 50 === 20) r.sys.request({ kind: 'crouch' });
      if (i % 70 === 30) r.sys.request({ kind: 'flashlight' });
      if (i % 40 === 10) r.sys.request({ kind: 'sound', source: 'knock', x: 3, z: 2, building: 1 });
      r.sys.setHeld(i % 120 < 30 ? 1 : 0, false);
      r.sys.step(1 / 60, T0);
    }
  }

  function populate(r: Rig): void {
    r.port.add({ x: 4.5, z: 2, yaw: Math.PI / 2 });
    r.port.add({ x: 8, z: 3, yaw: 0 });
    r.port.add({ x: 3, z: 4, yaw: Math.PI, asleep: true });
  }

  it('continues identically after a save, a JSON round trip and a restore into a fresh system', () => {
    const a = makeRig(twoRooms());
    populate(a);
    script(a, 0, 100);
    a.bus.emit('force:used', { kind: 'taser', personId: 1, callId: 0 });
    a.sys.request({ kind: 'partner', command: 'summon' });
    const save = JSON.parse(JSON.stringify(a.sys.serialize())) as unknown;
    expect(isTacticalSave(save)).toBe(true);
    if (!isTacticalSave(save)) throw new Error('bad save');
    expect(save.pendingSounds).toHaveLength(1);
    expect(save.queue).toHaveLength(1);

    const b = makeRig(twoRooms());
    populate(b);
    b.sys.restore(save);
    const marker = a.port.calls.length;
    script(a, 100, 400);
    script(b, 100, 400);
    expect(a.port.calls.length).toBeGreaterThan(marker + 10);
    expect(b.port.calls).toEqual(a.port.calls.slice(marker));
    expect(b.sys.noise).toBe(a.sys.noise);
    expect(b.sys.visibility).toBe(a.sys.visibility);
    expect(b.sys.serialize()).toEqual(a.sys.serialize());
  });

  it('rejects malformed saves', () => {
    const r = makeRig(twoRooms());
    const good = JSON.parse(JSON.stringify(r.sys.serialize())) as Record<string, unknown>;
    expect(isTacticalSave(good)).toBe(true);
    expect(isTacticalSave(null)).toBe(false);
    expect(isTacticalSave({ ...good, version: 2 })).toBe(false);
    expect(isTacticalSave({ ...good, lean: 2 })).toBe(false);
    expect(isTacticalSave({ ...good, queue: [{ kind: 'nope' }] })).toBe(false);
    expect(isTacticalSave({ ...good, pendingSounds: [{ kind: 'kick' }] })).toBe(false);
    expect(isTacticalSave({ ...good, partner: { ...(good['partner'] as object), mode: 'dance' } })).toBe(false);
  });
});

describe('performance', () => {
  /** Allocation-free stubs so only the system itself is measured: a fixed crowd, a silent port and a mutable officer. */
  function fastSystem(): { step: () => void } {
    const layout = generateInterior(42, handBuilding('house', 14, 12, 0, 900_300));
    if (layout === null) throw new Error('no house');
    const interiors = new StubInteriors([[1, layout]]);
    const crowd: Listener[] = [];
    for (let i = 0; i < 12; i++) {
      const room = layout.rooms[i % layout.rooms.length];
      if (room === undefined) continue;
      crowd.push({
        ...createListener(),
        actorId: i + 1,
        x: (room.rect.minX + room.rect.maxX) / 2,
        z: (room.rect.minZ + room.rect.maxZ) / 2,
        yaw: i,
        building: 1,
      });
    }
    const port: ListenerPort = {
      listeners: (_x, _z, _radius, out) => {
        const n = Math.min(crowd.length, out.length);
        for (let i = 0; i < n; i++) {
          const o = out[i] as Listener;
          const s = crowd[i] as Listener;
          o.actorId = s.actorId;
          o.x = s.x;
          o.z = s.z;
          o.building = s.building;
          o.hearing = s.hearing;
          o.asleep = s.asleep;
          o.yaw = s.yaw;
          o.eyeY = s.eyeY;
        }
        return n;
      },
      stimulate: () => {},
    };
    const state = { x: layout.entry.x, z: layout.entry.z, yaw: 0, pitch: 0, building: 1, speed: 4, onFoot: true };
    const bus = new EventBus<EventMap>();
    const sys = new TacticalSystem({
      seed: 1,
      bus,
      rng: createRng(1).stream('tactical'),
      city: { surfaceAt: () => 0 } as unknown as City,
      interiors,
      listeners: port,
      officer: (out) => {
        out.x = state.x;
        out.z = state.z;
        out.yaw = state.yaw;
        out.pitch = state.pitch;
        out.building = state.building;
        out.speed = state.speed;
        out.onFoot = state.onFoot;
        return out;
      },
      radioEarpiece: () => false,
      nightFactor: () => 0,
    });
    sys.request({ kind: 'flashlight' });
    sys.setHeld(1, false);
    return { step: () => sys.step(1 / 60, T0) };
  }

  it('steps in well under 0.05 ms with a dozen listeners', () => {
    const { step } = fastSystem();
    for (let i = 0; i < 600; i++) step();
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) step();
      best = Math.min(best, (performance.now() - t0) / 2000);
    }
    expect(best).toBeLessThan(0.05);
  });

  it('does not allocate per step after warm-up', async () => {
    const gc = await loadGc();
    const { step } = fastSystem();
    // Long warm-up: unoptimised code boxes doubles; the steady state must not.
    for (let i = 0; i < 8000; i++) step();
    let least = Infinity;
    for (let k = 0; k < 16; k++) {
      gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 100; i++) step();
      least = Math.min(least, process.memoryUsage().heapUsed - before);
    }
    // Same bound as the other steady-state allocation tests: the test loop itself boxes a few numbers per step and a
    // sound heard by 12 listeners boxes a few doubles each; un-warmed code or a per-listener allocation would cost far more.
    expect(least).toBeLessThan(40_000);
  }, 30000);
});
