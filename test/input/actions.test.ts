import { describe, expect, it } from 'vitest';
import { ACTIONS, ACTION_IDS, actionKind, isActionId } from '../../src/input/actions';

describe('actions', () => {
  it('lists every action id exactly once', () => {
    expect(ACTION_IDS).toEqual(Object.keys(ACTIONS));
    expect(new Set(ACTION_IDS).size).toBe(ACTION_IDS.length);
    expect(ACTION_IDS).toContain('move.forward');
    expect(ACTION_IDS).toContain('vehicle.siren');
    expect(ACTION_IDS).toContain('camera.toggle');
  });

  it('classifies look and steering as axes and everything else as buttons', () => {
    expect(actionKind('look.x')).toBe('axis');
    expect(actionKind('look.y')).toBe('axis');
    expect(actionKind('vehicle.steer')).toBe('axis');
    expect(actionKind('vehicle.accelerate')).toBe('axis');
    expect(actionKind('move.forward')).toBe('button');
    expect(actionKind('interact')).toBe('button');
    expect(actionKind('console.toggle')).toBe('button');
  });

  it('isActionId rejects unknown ids and non-strings', () => {
    expect(isActionId('move.forward')).toBe(true);
    expect(isActionId('move.sideways')).toBe(false);
    expect(isActionId('toString')).toBe(false);
    expect(isActionId(42)).toBe(false);
    expect(isActionId(null)).toBe(false);
  });

  it('adds the Phase 2 button actions with readable labels', () => {
    const expected: Record<string, string> = {
      'vehicle.sirenTone': 'Siren tone',
      'vehicle.horn': 'Air horn',
      'vehicle.manual': 'Manual siren',
      'vehicle.lightPattern': 'Light pattern',
      'vehicle.spotlight': 'Spotlight',
      'vehicle.spotAim': 'Aim spotlight (hold)',
      'vehicle.equipment': 'Vehicle equipment',
      'mdt.toggle': 'MDT',
      'target.runPlate': 'Run plate',
      'radio.menu': 'Radio menu',
      'radio.ptt': 'Push to talk',
      'radio.emergency': 'Emergency button',
      'radio.channelPrev': 'Previous channel',
      'radio.channelNext': 'Next channel',
      'radio.scan': 'Radio scan',
    };
    for (let i = 1; i <= 9; i++) expected[`radio.option${i}`] = `Radio option ${i}`;
    for (const [id, label] of Object.entries(expected)) {
      expect(isActionId(id), id).toBe(true);
      if (!isActionId(id)) continue;
      expect(ACTIONS[id]).toEqual({ kind: 'button', label });
    }
  });

  it('adds the Phase 3 officer actions and the scene menu as buttons with labels', () => {
    const expected: Record<string, string> = {
      'officer.weapon': 'Cycle force tool',
      'officer.fire': 'Fire / deploy weapon',
      'officer.tackle': 'Tackle',
      'officer.shout': 'Shout command',
      'scene.menu': 'Scene menu',
    };
    for (const [id, label] of Object.entries(expected)) {
      expect(isActionId(id), id).toBe(true);
      if (!isActionId(id)) continue;
      expect(ACTIONS[id]).toEqual({ kind: 'button', label });
      expect(actionKind(id)).toBe('button');
    }
  });

  it('adds the nine Phase 4 button actions with readable labels', () => {
    const expected: Record<string, string> = {
      'officer.crouch': 'Crouch',
      'officer.leanLeft': 'Lean left (hold)',
      'officer.leanRight': 'Lean right (hold)',
      'officer.slice': 'Slice the pie (hold)',
      'officer.flashlight': 'Flashlight',
      'officer.bodycam': 'Bodycam',
      'investigate.menu': 'Investigation tools',
      'camera.photo': 'Evidence camera',
      'partner.menu': 'Partner commands',
    };
    expect(Object.keys(expected)).toHaveLength(9);
    for (const [id, label] of Object.entries(expected)) {
      expect(isActionId(id), id).toBe(true);
      if (!isActionId(id)) continue;
      expect(ACTIONS[id]).toEqual({ kind: 'button', label });
      expect(actionKind(id)).toBe('button');
    }
    // Appended after the Phase 3 actions, in the design's order (the Phase 5 actions follow them).
    const tail = ACTION_IDS.slice(-21, -12);
    expect(tail).toEqual(Object.keys(expected));
  });

  it('adds the two Phase 5 button actions after the Phase 4 ones, and relabels the weapon cycle', () => {
    expect(ACTIONS['officer.intervene']).toEqual({ kind: 'button', label: 'Intervene' });
    expect(ACTIONS['officer.bodycamMute']).toEqual({ kind: 'button', label: 'Bodycam mute' });
    expect(actionKind('officer.intervene')).toBe('button');
    expect(actionKind('officer.bodycamMute')).toBe('button');
    expect(ACTION_IDS.slice(-12, -10)).toEqual(['officer.intervene', 'officer.bodycamMute']);
    // Same id and binding as before; only the label changes.
    expect(ACTIONS['officer.weapon'].label).toBe('Cycle force tool');
    expect(isActionId('officer.weapon')).toBe(true);
  });

  it('appends the four Phase 6 button actions with the design labels', () => {
    const expected: Record<string, string> = {
      'backup.menu': 'Backup officers',
      'command.menu': 'Incident command / triage',
      'pursuit.menu': 'Pursuit tactics',
      'air.flir': 'Air unit camera (thermal)',
    };
    for (const [id, label] of Object.entries(expected)) {
      expect(isActionId(id), id).toBe(true);
      if (!isActionId(id)) continue;
      expect(ACTIONS[id]).toEqual({ kind: 'button', label });
      expect(actionKind(id)).toBe('button');
    }
    expect(ACTION_IDS.slice(-10, -6)).toEqual(Object.keys(expected));
  });

  it('appends the three Phase 7 actions: the aircraft lift axis, the fleet panel and the drone toggle', () => {
    expect(ACTION_IDS.slice(-6, -3)).toEqual(['vehicle.lift', 'fleet.menu', 'drone.toggle']);
    expect(ACTIONS['vehicle.lift']).toEqual({ kind: 'axis', label: 'Climb / descend (aircraft)', bipolar: true });
    expect(ACTIONS['fleet.menu']).toEqual({ kind: 'button', label: 'Fleet / garage panel' });
    expect(ACTIONS['drone.toggle']).toEqual({ kind: 'button', label: 'Deploy / recall drone' });
    expect(actionKind('vehicle.lift')).toBe('axis');
    expect(actionKind('fleet.menu')).toBe('button');
    expect(actionKind('drone.toggle')).toBe('button');
  });

  it('appends the three Phase 8 button actions: career, co-op and dispatch console', () => {
    expect(ACTION_IDS.slice(-3)).toEqual(['career.menu', 'coop.menu', 'dispatch.console']);
    expect(ACTIONS['career.menu']).toEqual({ kind: 'button', label: 'Career / schedule' });
    expect(ACTIONS['coop.menu']).toEqual({ kind: 'button', label: 'Co-op panel' });
    expect(ACTIONS['dispatch.console']).toEqual({ kind: 'button', label: 'Dispatch console' });
    for (const id of ['career.menu', 'coop.menu', 'dispatch.console'] as const) expect(actionKind(id)).toBe('button');
  });

  it('has a distinct non-empty label for every action', () => {
    const labels = ACTION_IDS.map((id) => ACTIONS[id].label);
    expect(labels.every((l) => l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
