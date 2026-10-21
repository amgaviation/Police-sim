import { describe, expect, it } from 'vitest';
import {
  CRAFT_KINDS,
  createCraftState,
  stepCraft,
  type CraftEnv,
  type CraftInput,
  type CraftKind,
  type CraftState,
  type CraftStep,
} from '../../src/vehicles/craft';
import { vehicleModel, type CraftSpec } from '../../src/vehicles/model';

const DT = 1 / 60;
const boat = vehicleModel('patrol_boat');
const heli = vehicleModel('police_helicopter');
const drone = vehicleModel('police_drone');
const spec = (m: typeof boat): CraftSpec => {
  if (m.craft === null) throw new Error('not a craft');
  return m.craft;
};
const clearance = (m: typeof boat): number => m.body.groundClearance + m.body.height / 2;

const env = (over: Partial<CraftEnv> = {}): CraftEnv => ({ groundY: 0, waterY: -0.05, engineOk: true, anchorX: 0, anchorZ: 0, ...over });
const step = (): CraftStep => ({ dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, roll: 0, landed: false });
const input = (forward = 0, steer = 0, lift = 0): CraftInput => ({ forward, steer, lift });

/** Runs `seconds` of fixed steps applying the desired move to the position like an unobstructed body. */
function run(kind: CraftKind, m: typeof boat, s: CraftState, i: CraftInput, seconds: number, e: CraftEnv, each?: (out: CraftStep) => void): CraftStep {
  const out = step();
  for (let n = 0; n < Math.round(seconds / DT); n++) {
    stepCraft(kind, spec(m), clearance(m), s, i, DT, e, out);
    s.x += out.dx;
    s.y += out.dy;
    s.z += out.dz;
    each?.(out);
  }
  return out;
}

describe('stepCraft: boat', () => {
  it('lists the craft kinds', () => {
    expect(CRAFT_KINDS).toEqual(['boat', 'helicopter', 'drone']);
  });

  it('accelerates to its top speed in under 15 s with full throttle', () => {
    const s = createCraftState(0, clearance(boat) - 0.05, 0, 0);
    let t = 0;
    const out = step();
    while (s.speed < spec(boat).maxSpeedMps - 0.01 && t < 30) {
      stepCraft('boat', spec(boat), clearance(boat), s, input(1), DT, env(), out);
      s.z += out.dz;
      t += DT;
    }
    expect(t).toBeLessThan(15);
    expect(s.speed).toBeCloseTo(18, 1);
    // Heading 0 faces -Z.
    expect(s.z).toBeLessThan(-50);
    expect(s.x).toBeCloseTo(0, 6);
  });

  it('brakes to a stop, then reverses up to the reverse speed', () => {
    const s = createCraftState(0, clearance(boat) - 0.05, 0, 0);
    s.speed = 18;
    const out = step();
    let t = 0;
    while (s.speed > 0.5 && t < 20) {
      stepCraft('boat', spec(boat), clearance(boat), s, input(-1), DT, env(), out);
      t += DT;
    }
    expect(t).toBeLessThan(8);
    run('boat', boat, s, input(-1), 10, env());
    expect(s.speed).toBeCloseTo(-4, 1);
    expect(s.speed).toBeGreaterThanOrEqual(-4);
  });

  it('keeps its height at waterY + clearance', () => {
    const s = createCraftState(0, 3, 0, 0);
    const out = run('boat', boat, s, input(1), 0.1, env({ waterY: 0.7 }));
    expect(out.landed).toBe(false);
    expect(s.y).toBeCloseTo(0.7 + clearance(boat), 9);
    expect(s.vy).toBe(0);
    run('boat', boat, s, input(1), 2, env({ waterY: -1 }));
    expect(s.y).toBeCloseTo(-1 + clearance(boat), 9);
  });

  it('steers right by decreasing the yaw, needs way on, and reverses the helm when going astern', () => {
    const slow = createCraftState(0, 0, 0, 0);
    stepCraft('boat', spec(boat), clearance(boat), slow, input(0, 1), 1, env(), step());
    const rest = slow.yaw;
    expect(rest).toBeCloseTo(-0.15 * spec(boat).turnRateDegS * (Math.PI / 180), 6);
    const fast = createCraftState(0, 0, 0, 0);
    fast.speed = 10;
    stepCraft('boat', spec(boat), clearance(boat), fast, input(0, 1), 1, env(), step());
    expect(fast.yaw).toBeLessThan(rest);
    expect(fast.yaw).toBeCloseTo(-spec(boat).turnRateDegS * (Math.PI / 180), 6);
    const astern = createCraftState(0, 0, 0, 0);
    astern.speed = -3;
    stepCraft('boat', spec(boat), clearance(boat), astern, input(0, 1), 1, env(), step());
    expect(astern.yaw).toBeGreaterThan(0);
  });

  it('drives along fwd(yaw) = (-sin yaw, -cos yaw)', () => {
    const s = createCraftState(0, 0, 0, Math.PI / 2);
    s.speed = 10;
    const out = step();
    stepCraft('boat', spec(boat), clearance(boat), s, input(), 1, env(), out);
    expect(out.dx).toBeLessThan(-9);
    expect(Math.abs(out.dz)).toBeLessThan(1e-9);
  });

  it('banks into the turn and raises the bow with speed', () => {
    const s = createCraftState(0, 0, 0, 0);
    s.speed = 18;
    const out = step();
    stepCraft('boat', spec(boat), clearance(boat), s, input(0, 1), DT, env(), out);
    expect(out.roll).toBeLessThan(0);
    expect(out.pitch).toBeGreaterThan(0);
    expect(out.pitch).toBeLessThan((spec(boat).tiltDeg * Math.PI) / 180);
  });

  it('with a dead engine does not accelerate and loses speed faster', () => {
    const live = createCraftState(0, 0, 0, 0);
    const dead = createCraftState(0, 0, 0, 0);
    live.speed = 10;
    dead.speed = 10;
    run('boat', boat, live, input(0), 5, env());
    run('boat', boat, dead, input(1), 5, env({ engineOk: false }));
    expect(dead.speed).toBeLessThan(live.speed);
    expect(dead.speed).toBeLessThan(10);
  });
});

describe('stepCraft: helicopter', () => {
  const ground = (): CraftState => createCraftState(0, clearance(heli), 0, 0);

  it('climbs at climbMps with lift 1, ramping at 4 m/s²', () => {
    const s = ground();
    const first = step();
    stepCraft('helicopter', spec(heli), clearance(heli), s, input(0, 0, 1), DT, env(), first);
    expect(s.vy).toBeCloseTo(4 * DT, 9);
    s.y += first.dy;
    run('helicopter', heli, s, input(0, 0, 1), 4, env());
    expect(s.vy).toBeCloseTo(spec(heli).climbMps, 6);
    expect(s.y).toBeGreaterThan(clearance(heli) + 20);
  });

  it('never exceeds the ceiling or goes below the floor', () => {
    const s = ground();
    let hi = -Infinity;
    let lo = Infinity;
    const ceiling = clearance(heli) + spec(heli).maxAltitudeM;
    const track = (): void => {
      hi = Math.max(hi, s.y);
      lo = Math.min(lo, s.y);
    };
    run('helicopter', heli, s, input(0, 0, 1), 60, env(), track);
    expect(hi).toBeLessThanOrEqual(ceiling + 1e-9);
    expect(s.y).toBeCloseTo(ceiling, 9);
    expect(s.vy).toBe(0);
    run('helicopter', heli, s, input(0, 0, -1), 120, env(), track);
    expect(lo).toBeGreaterThanOrEqual(clearance(heli) - 1e-9);
    expect(s.y).toBeCloseTo(clearance(heli), 9);
  });

  it('flags landed on the floor and not while climbing', () => {
    const s = ground();
    const out = step();
    stepCraft('helicopter', spec(heli), clearance(heli), s, input(), DT, env(), out);
    expect(out.landed).toBe(true);
    expect(out.dy).toBe(0);
    stepCraft('helicopter', spec(heli), clearance(heli), s, input(0, 0, 1), DT, env(), out);
    expect(out.landed).toBe(false);
  });

  it('descends at about 6 m/s when the engine fails', () => {
    const s = createCraftState(0, clearance(heli) + 100, 0, 0);
    let fastest = 0;
    run('helicopter', heli, s, input(0, 0, 1), 3, env({ engineOk: false }), () => {
      fastest = Math.min(fastest, s.vy);
    });
    expect(s.vy).toBeCloseTo(-6, 6);
    expect(fastest).toBeCloseTo(-6, 6);
    expect(s.y).toBeLessThan(clearance(heli) + 100 - 10);
  });

  it('bleeds speed while sitting on the ground with no lift, but not when lifting', () => {
    const resting = ground();
    resting.speed = 20;
    run('helicopter', heli, resting, input(0, 0, 0), 1, env());
    expect(resting.speed).toBeLessThan(2);
    const lifting = ground();
    lifting.speed = 20;
    run('helicopter', heli, lifting, input(0, 0, 1), 0.5, env());
    expect(lifting.speed).toBeGreaterThan(10);
  });

  it('hovers in place: the turn rate does not depend on speed, noses down when flying forward', () => {
    const s = createCraftState(0, 50, 0, 0);
    stepCraft('helicopter', spec(heli), clearance(heli), s, input(0, 1), 1, env({ groundY: -100 }), step());
    expect(s.yaw).toBeCloseTo(-spec(heli).turnRateDegS * (Math.PI / 180), 6);
    const f = createCraftState(0, 50, 0, 0);
    f.speed = 30;
    const out = step();
    stepCraft('helicopter', spec(heli), clearance(heli), f, input(1), DT, env({ groundY: -100 }), out);
    expect(out.pitch).toBeLessThan(0);
  });

  it('follows a moving ground height', () => {
    const s = createCraftState(0, clearance(heli) + 10, 0, 0);
    run('helicopter', heli, s, input(0, 0, -1), 20, env({ groundY: 5 }));
    expect(s.y).toBeCloseTo(5 + clearance(heli), 9);
  });
});

describe('stepCraft: drone', () => {
  it('never lets the distance from the anchor exceed rangeM', () => {
    const range = spec(drone).rangeM;
    const s = createCraftState(0, 30, 0, 0);
    const e = env({ groundY: -100 });
    let worst = 0;
    const watch = (): void => {
      worst = Math.max(worst, Math.hypot(s.x, s.z));
    };
    // Fly straight out, then circle along the edge, then try to leave in other directions.
    run('drone', drone, s, input(1), 60, e, watch);
    expect(Math.hypot(s.x, s.z)).toBeGreaterThan(range - 15);
    run('drone', drone, s, input(1, 0.35), 60, e, watch);
    run('drone', drone, s, input(1, -0.2), 60, e, watch);
    run('drone', drone, s, input(1, 1), 30, e, watch);
    expect(worst).toBeLessThanOrEqual(range + 0.01);
  });

  it('can still fly back in from the edge', () => {
    const s = createCraftState(0, 30, 0, 0);
    s.z = -350;
    s.yaw = Math.PI; // facing +Z, toward the anchor
    s.speed = 5;
    run('drone', drone, s, input(1), 10, env({ groundY: -100 }));
    expect(Math.hypot(s.x, s.z)).toBeLessThan(330);
  });

  it('has no leash when rangeM is 0', () => {
    const s = createCraftState(0, 30, 0, 0);
    run('helicopter', heli, s, input(1), 60, env({ groundY: -100 }));
    expect(Math.hypot(s.x, s.z)).toBeGreaterThan(400);
  });

  it('is deterministic: the same inputs give bit-identical states', () => {
    const runOnce = (): number[] => {
      const s = createCraftState(3, 20, -4, 0.5);
      const out = step();
      for (let n = 0; n < 900; n++) {
        const t = n * DT;
        stepCraft('drone', spec(drone), clearance(drone), s, input(Math.sin(t), Math.cos(t * 0.7), Math.sin(t * 0.3)), DT, env({ groundY: 0 }), out);
        s.x += out.dx;
        s.y += out.dy;
        s.z += out.dz;
      }
      return [s.x, s.y, s.z, s.yaw, s.speed, s.vy, s.pitch, s.roll, out.dx, out.dy, out.dz];
    };
    const a = runOnce();
    const b = runOnce();
    expect(b).toEqual(a);
    expect(a.every(Number.isFinite)).toBe(true);
  });
});

describe('stepCraft input handling', () => {
  it('clamps out-of-range and NaN inputs', () => {
    const a = createCraftState(0, 0, 0, 0);
    const b = createCraftState(0, 0, 0, 0);
    stepCraft('boat', spec(boat), clearance(boat), a, input(5, 9), DT, env(), step());
    stepCraft('boat', spec(boat), clearance(boat), b, input(1, 1), DT, env(), step());
    expect(a).toEqual(b);
    const c = createCraftState(0, 0, 0, 0);
    stepCraft('boat', spec(boat), clearance(boat), c, input(Number.NaN, Number.NaN, Number.NaN), DT, env(), step());
    expect(c.speed).toBe(0);
    expect(c.yaw).toBe(0);
  });
});
