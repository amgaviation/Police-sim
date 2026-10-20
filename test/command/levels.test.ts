import { describe, expect, it } from 'vitest';
import { COMMAND_CONFIG, parseCommandConfig } from '../../src/command/data';
import { commandLevel, resourceNeeds } from '../../src/command/levels';
import commandJson from '../../src/data/command/command.json';

const base = { immediate: 0, delayed: 0, trapped: 0, hazmat: false, onSceneEms: 0, onSceneFire: 0, supervisor: true };

describe('commandLevel', () => {
  it('uses the family table', () => {
    expect(commandLevel('massCasualty', 0)).toBe('disaster');
    expect(commandLevel('barricade', 0)).toBe('major');
    expect(commandLevel('activeAssailant', 1)).toBe('major');
    expect(commandLevel('hazard', 1)).toBe('incident');
  });

  it('raises an incident to major once enough units are on scene', () => {
    expect(commandLevel('hazard', 4)).toBe('incident');
    expect(commandLevel('hazard', 5)).toBe('major');
    expect(commandLevel('massCasualty', 9)).toBe('disaster');
  });

  it('an unlisted family has no command level until the scene is crowded', () => {
    expect(commandLevel('disturbance', 0)).toBe('none');
    expect(commandLevel('disturbance', 4)).toBe('none');
    expect(commandLevel('disturbance', 5)).toBe('incident');
  });

  it('follows a custom configuration', () => {
    const cfg = parseCommandConfig({ ...commandJson, levels: { families: { noise: 'major' }, majorUnitsOnScene: 2 } });
    expect(commandLevel('noise', 0, cfg)).toBe('major');
    expect(commandLevel('barricade', 1, cfg)).toBe('none');
    expect(commandLevel('barricade', 2, cfg)).toBe('incident');
  });
});

describe('resourceNeeds', () => {
  it('computes EMS from immediate and delayed patients', () => {
    expect(resourceNeeds({ ...base, immediate: 1 }).ems).toBe(1);
    expect(resourceNeeds({ ...base, immediate: 2 }).ems).toBe(2);
    expect(resourceNeeds({ ...base, delayed: 1 }).ems).toBe(1);
    expect(resourceNeeds({ ...base, delayed: 2 }).ems).toBe(1);
    expect(resourceNeeds({ ...base, immediate: 1, delayed: 3 }).ems).toBe(3);
  });

  it('caps at maxEms / maxFire and subtracts what is on scene', () => {
    expect(resourceNeeds({ ...base, immediate: 9, delayed: 9 }).ems).toBe(COMMAND_CONFIG.needs.maxEms);
    expect(resourceNeeds({ ...base, immediate: 9, onSceneEms: 1 }).ems).toBe(2);
    expect(resourceNeeds({ ...base, trapped: 9 }).fire).toBe(COMMAND_CONFIG.needs.maxFire);
    expect(resourceNeeds({ ...base, trapped: 9, onSceneFire: 1 }).fire).toBe(1);
  });

  it('never goes below zero', () => {
    expect(resourceNeeds({ ...base, immediate: 1, onSceneEms: 5, onSceneFire: 5 })).toEqual({ ems: 0, fire: 0, supervisor: 0 });
    expect(resourceNeeds({ ...base, onSceneEms: 2 }).ems).toBe(0);
  });

  it('fire: trapped patients at half a unit each (rounded up) plus one for hazmat', () => {
    expect(resourceNeeds({ ...base, trapped: 1 }).fire).toBe(1);
    expect(resourceNeeds({ ...base, trapped: 2 }).fire).toBe(1);
    expect(resourceNeeds({ ...base, trapped: 3 }).fire).toBe(2);
    expect(resourceNeeds({ ...base, hazmat: true }).fire).toBe(1);
    expect(resourceNeeds({ ...base, hazmat: true, trapped: 1 }).fire).toBe(2);
    expect(resourceNeeds({ ...base, hazmat: true, trapped: 2, onSceneFire: 1 }).fire).toBe(1);
  });

  it('asks for a supervisor only when none is assigned', () => {
    expect(resourceNeeds({ ...base, supervisor: false }).supervisor).toBe(1);
    expect(resourceNeeds({ ...base, supervisor: true }).supervisor).toBe(0);
  });
});
