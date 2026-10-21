import { describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import {
  ENTER_DISTANCE,
  EXIT_MAX_SPEED,
  EXIT_OFFSET,
  PLAYER_MODE_NAMES,
  PLAYER_MODE,
  PlayerModeMachine,
  driverDoorPoint,
  exitPoint,
  findEnterable,
  type EnterCandidate,
} from '../../src/player/mode';

const car = (over: Partial<EnterCandidate> = {}): EnterCandidate => ({
  eid: 5,
  x: 0,
  z: 0,
  yaw: 0,
  halfWidth: 1,
  halfLength: 2.4,
  speed: 0,
  ...over,
});
const pt = () => ({ x: 0, z: 0 });

describe('door and exit points', () => {
  it('puts the driver door on the left (-X), a third back from the front, at yaw 0', () => {
    const p = driverDoorPoint(car(), pt());
    expect(p.x).toBeCloseTo(-1.4);
    // Front is at z = -2.4; a third of the 4.8 m length back is z = -0.8.
    expect(p.z).toBeCloseTo(-0.8);
  });

  it('rotates with the vehicle', () => {
    // Yaw +90 deg: the car faces -X, so its left side is +Z and its front -X.
    const p = driverDoorPoint(car({ x: 10, z: 20, yaw: Math.PI / 2 }), pt());
    expect(p.x).toBeCloseTo(10 - 0.8);
    expect(p.z).toBeCloseTo(20 + 1.4);
  });

  it('exitPoint takes an optional offset (boats use a wider gap)', () => {
    expect(EXIT_OFFSET).toBe(1);
    expect(exitPoint(car(), -1, pt(), 2)).toMatchObject({ x: expect.closeTo(-3) as number, z: expect.closeTo(-0.8) as number });
    expect(exitPoint(car(), 1, pt(), 0).x).toBeCloseTo(1);
    expect(exitPoint(car(), 1, pt(), EXIT_OFFSET)).toEqual(exitPoint(car(), 1, pt()));
    const r = exitPoint(car({ yaw: Math.PI, halfWidth: 1.3 }), -1, pt(), 2);
    expect(r.x).toBeCloseTo(3.3);
    expect(r.z).toBeCloseTo(0.8);
  });

  it('places exits 1 m clear on either side', () => {
    expect(exitPoint(car(), -1, pt())).toMatchObject({ x: expect.closeTo(-2) as number, z: expect.closeTo(-0.8) as number });
    expect(exitPoint(car(), 1, pt())).toMatchObject({ x: expect.closeTo(2) as number, z: expect.closeTo(-0.8) as number });
    const r = exitPoint(car({ yaw: Math.PI }), -1, pt());
    // Facing +Z, the driver side is +X and the seat line is at z = +0.8.
    expect(r.x).toBeCloseTo(2);
    expect(r.z).toBeCloseTo(0.8);
  });
});

describe('findEnterable', () => {
  it('picks the nearest door within range', () => {
    const list = [car({ eid: 1, x: 0 }), car({ eid: 2, x: 3 }), car({ eid: 3, x: 50 })];
    // Doors at x = -1.4, 1.6 and 48.6 (z = -0.8).
    expect(findEnterable(1, -0.8, list)).toBe(1);
    expect(findEnterable(-1, -0.8, list)).toBe(0);
    expect(findEnterable(20, -0.8, list)).toBe(-1);
  });

  it('respects ENTER_DISTANCE and ignores moving vehicles', () => {
    const c = car();
    expect(findEnterable(-1.4 - ENTER_DISTANCE + 0.01, -0.8, [c])).toBe(0);
    expect(findEnterable(-1.4 - ENTER_DISTANCE - 0.01, -0.8, [c])).toBe(-1);
    expect(findEnterable(-1.4, -0.8, [car({ speed: 1.5 })])).toBe(-1);
    expect(findEnterable(-1.4, -0.8, [car({ speed: -1.5 }), car({ x: 1 })])).toBe(1);
    expect(findEnterable(0, 0, [])).toBe(-1);
  });
});

describe('PlayerModeMachine', () => {
  function spy() {
    const bus = new EventBus<EventMap>();
    const events: EventMap['player:mode'][] = [];
    bus.on('player:mode', (e) => events.push(e));
    return { bus, events };
  }

  it('enters only on foot and exits only when slow enough', () => {
    const { bus, events } = spy();
    const m = new PlayerModeMachine(bus);
    expect(m.mode).toBe(PLAYER_MODE.onFoot);
    expect(m.vehicle).toBe(0);
    expect(m.exit(0)).toBe(false);
    expect(m.enter(7)).toBe(true);
    expect(m.mode).toBe(PLAYER_MODE.driving);
    expect(m.vehicle).toBe(7);
    expect(m.enter(8)).toBe(false);
    expect(m.exit(EXIT_MAX_SPEED + 0.1)).toBe(false);
    expect(m.exit(-EXIT_MAX_SPEED - 0.1)).toBe(false);
    expect(m.mode).toBe(PLAYER_MODE.driving);
    expect(m.exit(-EXIT_MAX_SPEED)).toBe(true);
    expect(m.mode).toBe(PLAYER_MODE.onFoot);
    expect(m.vehicle).toBe(0);
    expect(events).toEqual([
      { mode: 'driving', vehicle: 7 },
      { mode: 'onFoot', vehicle: 0 },
    ]);
  });

  it('reset emits only on change and works without a bus', () => {
    const { bus, events } = spy();
    const m = new PlayerModeMachine(bus);
    m.reset(PLAYER_MODE.onFoot, 0);
    expect(events).toEqual([]);
    m.reset(PLAYER_MODE.driving, 3);
    m.reset(PLAYER_MODE.driving, 3);
    expect(events).toEqual([{ mode: 'driving', vehicle: 3 }]);
    const quiet = new PlayerModeMachine();
    expect(quiet.enter(2)).toBe(true);
    expect(quiet.enter(0)).toBe(false);
  });
});

describe('PlayerModeMachine remote mode', () => {
  function spy() {
    const bus = new EventBus<EventMap>();
    const events: EventMap['player:mode'][] = [];
    bus.on('player:mode', (e) => events.push(e));
    return { bus, events };
  }

  it('has the remote mode id and name', () => {
    expect(PLAYER_MODE).toEqual({ onFoot: 0, driving: 1, remote: 2 });
    expect(PLAYER_MODE_NAMES).toEqual(['onFoot', 'driving', 'remote']);
  });

  it('goes remote only from on foot and back with endRemote, emitting player:mode', () => {
    const { bus, events } = spy();
    const m = new PlayerModeMachine(bus);
    expect(m.endRemote()).toBe(false);
    expect(m.remote(0)).toBe(false);
    expect(m.remote(-3)).toBe(false);
    expect(m.remote(9)).toBe(true);
    expect(m.mode).toBe(PLAYER_MODE.remote);
    expect(m.vehicle).toBe(9);
    expect(m.remote(10)).toBe(false);
    expect(m.vehicle).toBe(9);
    expect(m.endRemote()).toBe(true);
    expect(m.mode).toBe(PLAYER_MODE.onFoot);
    expect(m.vehicle).toBe(0);
    expect(m.endRemote()).toBe(false);
    expect(events).toEqual([
      { mode: 'remote', vehicle: 9 },
      { mode: 'onFoot', vehicle: 0 },
    ]);
  });

  it('refuses enter and exit while remote, and remote while driving', () => {
    const { bus, events } = spy();
    const m = new PlayerModeMachine(bus);
    m.remote(4);
    expect(m.enter(5)).toBe(false);
    expect(m.exit(0)).toBe(false);
    expect(m.mode).toBe(PLAYER_MODE.remote);
    expect(m.vehicle).toBe(4);
    m.endRemote();
    m.enter(5);
    expect(m.remote(6)).toBe(false);
    expect(m.endRemote()).toBe(false);
    expect(m.mode).toBe(PLAYER_MODE.driving);
    expect(events.map((e) => e.mode)).toEqual(['remote', 'onFoot', 'driving']);
  });

  it('reset accepts remote (keeping the vehicle), emits only on change, and clears the vehicle on foot', () => {
    const { bus, events } = spy();
    const m = new PlayerModeMachine(bus);
    m.reset(PLAYER_MODE.remote, 12);
    m.reset(PLAYER_MODE.remote, 12);
    expect(m.mode).toBe(PLAYER_MODE.remote);
    expect(m.vehicle).toBe(12);
    m.reset(PLAYER_MODE.driving, 3);
    expect(m.vehicle).toBe(3);
    m.reset(PLAYER_MODE.onFoot, 3);
    expect(m.vehicle).toBe(0);
    expect(events).toEqual([
      { mode: 'remote', vehicle: 12 },
      { mode: 'driving', vehicle: 3 },
      { mode: 'onFoot', vehicle: 0 },
    ]);
  });
});
