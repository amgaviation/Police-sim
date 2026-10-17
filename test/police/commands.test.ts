import { describe, expect, it } from 'vitest';
import type { Command, CommandContext } from '../../src/debug/console';
import { createPoliceCommands } from '../../src/police/commands';
import { PatrolEquipment } from '../../src/police/equipment';
import { patternIndex } from '../../src/police/lightbar';
import { vehicleModel } from '../../src/vehicles/model';

const ctx = {} as CommandContext;

function setup(eq: PatrolEquipment | null): (line: string) => unknown {
  const commands = new Map<string, Command>(createPoliceCommands({ equipment: () => eq }).map((c) => [c.name, c]));
  return (line) => {
    const [name = '', ...args] = line.split(' ');
    return commands.get(name)?.run(args, ctx);
  };
}

describe('police commands', () => {
  it('equip prints the state; commands fail without a car', () => {
    const eq = new PatrolEquipment(vehicleModel('patrol_sedan').equipment!);
    const run = setup(eq);
    const text = run('equip') as string;
    expect(text).toMatch(/^siren off \(wail\)/);
    expect(text).toMatch(/pattern alternate/);
    expect(text).toMatch(/rack locked; shotgun racked, rifle racked/);
    expect(text).toMatch(/trunk cones 6, flares 8/);
    expect(text).toMatch(/cage empty/);
    const none = setup(null);
    expect(() => none('equip')).toThrow(/No patrol car equipment/);
  });

  it('pattern <id|next>', () => {
    const eq = new PatrolEquipment(vehicleModel('patrol_suv').equipment!);
    const run = setup(eq);
    expect(run('pattern takedown')).toBe('pattern takedown');
    expect(eq.pattern).toBe(patternIndex('takedown'));
    expect(run('pattern next')).toBe('pattern cruise');
    expect(() => run('pattern disco')).toThrow(/Unknown pattern "disco"/);
    expect(run('pattern')).toMatch(/^pattern cruise \(patterns: alternate, quad/);
  });

  it('siren <tone|off>', () => {
    const eq = new PatrolEquipment(vehicleModel('patrol_sedan').equipment!);
    const run = setup(eq);
    expect(run('siren yelp')).toBe('siren on (yelp)');
    expect(eq.sirenOn).toBe(true);
    expect(run('siren off')).toBe('siren off (yelp)');
    expect(eq.sirenOn).toBe(false);
    expect(() => run('siren whoop')).toThrow(/Usage: siren/);
  });
});
