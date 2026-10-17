import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../src/debug/console';
import { createTrafficCommands } from '../../src/traffic/commands';
import { vehicleModel } from '../../src/vehicles/model';
import { laneRef } from '../../src/world/roadGraph';
import { lineGraph, makeHarness, runFor } from './helpers';

const ctx = {} as CommandContext;

describe('traffic commands', () => {
  it('pullover stops the nearest ambient car ahead; release and abandon end it; fleet lists the units', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    h.sys.spawnAt(laneRef(0, 0, 0), 1040, { speed: 10, behavior: 0, desiredFactor: 1 });
    h.sys.spawnAt(laneRef(0, 0, 0), 980, { speed: 10, behavior: 0, desiredFactor: 1 });
    const ahead = h.sys.view.vehicleId[0] ?? 0;
    h.sys.spawnFleetCar(2, -400, 0, { modelIndex: vehicleModel('patrol_suv').index, color: 0x101010 });
    const player = { x: -480, z: 1.75 };
    let heading: number | null = -Math.PI / 2;
    const cmds = createTrafficCommands({ traffic: () => h.sys, playerPosition: () => player, playerHeading: () => heading });
    const run = (name: string, args: string[] = []): unknown => cmds.find((c) => c.name === name)?.run(args, ctx);
    expect(run('pullover')).toMatch(new RegExp(`Vehicle ${String(ahead)} pulling over`));
    expect(h.sys.stopVehicleId).toBe(ahead);
    expect(run('pullover')).toMatch(/already running/);
    expect(run('pullover', ['release'])).toMatch(/released/);
    expect(run('pullover', ['abandon'])).toBe('No traffic stop');
    const behind = h.sys.view.vehicleId[1] ?? 0;
    heading = Math.PI / 2; // facing -x: the other car is ahead now
    expect(run('pullover')).toMatch(new RegExp(`Vehicle ${String(behind)} pulling over \\(40 m\\)`));
    expect(run('pullover', ['abandon'])).toMatch(/abandoned/);
    heading = 0; // facing -z: nothing ahead
    expect(run('pullover')).toMatch(/No car within 60 m ahead/);
    expect(() => run('pullover', ['x'])).toThrow(/Usage/);
    const list = run('fleet') as string;
    expect(list).toMatch(/^ 2 {2}id 1048578 {2}patrol/);
    runFor(h, 0, 0.1);
    const none = createTrafficCommands({ traffic: () => null, playerPosition: () => null });
    expect(() => none[1]?.run([], ctx)).toThrow(/not available/);
  });
});
