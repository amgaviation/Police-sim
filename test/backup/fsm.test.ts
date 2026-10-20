import { describe, expect, it } from 'vitest';
import { BACKUP_CONFIG } from '../../src/backup/data';
import { createFsmOutput, initialRole, stepOfficerFsm, type FsmInputs, type OfficerFsm } from '../../src/backup/fsm';
import type { BackupRole, BackupState } from '../../src/backup/types';

const cfg = BACKUP_CONFIG;

function inputs(over: Partial<FsmInputs> = {}): FsmInputs {
  return { dt: 1 / 60, onCall: true, goalDistance: 10, runner: false, caught: false, lost: false, command: null, post: false, detained: false, atCar: false, ...over };
}
function fsm(state: BackupState, role: BackupRole = 'cover', timer = 0): OfficerFsm {
  return { state, role, timer };
}
function step(s: OfficerFsm, over: Partial<FsmInputs> = {}) {
  const out = createFsmOutput();
  return stepOfficerFsm(s, inputs(over), cfg, out);
}

describe('initialRole', () => {
  it('gives cover, secondary, then standby by arrival order', () => {
    expect(initialRole(0)).toBe('cover');
    expect(initialRole(1)).toBe('secondary');
    expect(initialRole(2)).toBe('standby');
    expect(initialRole(7)).toBe('standby');
  });
});

describe('officer FSM table', () => {
  it('row 1: leaving the call returns the officer to the car, except when returning, gone or swat', () => {
    for (const st of ['approach', 'cover', 'secondary', 'chase', 'detain', 'post', 'standby', 'exiting'] as const) {
      const s = fsm(st);
      const out = step(s, { onCall: false });
      expect(s.state).toBe('returning');
      expect(out.changed).toBe(true);
    }
    for (const st of ['returning', 'gone', 'swat'] as const) {
      const s = fsm(st);
      step(s, { onCall: false });
      expect(s.state).toBe(st);
    }
  });

  it('row 2: returning is gone at the car, not before', () => {
    const s = fsm('returning');
    expect(step(s, { atCar: false }).changed).toBe(false);
    expect(s.state).toBe('returning');
    const out = step(s, { atCar: true });
    expect(s.state).toBe('gone');
    expect(out.changed).toBe(true);
    // gone stays gone
    step(s, { atCar: true });
    expect(s.state).toBe('gone');
  });

  it('row 3: exiting waits spawn.exitS, then approaches', () => {
    const s = fsm('exiting', 'cover');
    let steps = 0;
    while (s.state === 'exiting' && steps < 1000) {
      step(s);
      steps++;
    }
    expect(s.state).toBe('approach');
    expect(steps * (1 / 60)).toBeGreaterThanOrEqual(cfg.spawn.exitS);
    expect(steps * (1 / 60)).toBeLessThan(cfg.spawn.exitS + 0.05);
    // commands wait until the exit is done
    const t = fsm('exiting');
    step(t, { command: 'release' });
    expect(t.state).toBe('exiting');
  });

  it('row 4: player commands', () => {
    let s = fsm('cover', 'cover');
    step(s, { command: 'release' });
    expect(s.state).toBe('returning');

    s = fsm('standby', 'standby');
    const out = step(s, { command: 'cover' });
    expect(out.changed).toBe(true);
    expect(s).toMatchObject({ state: 'approach', role: 'cover' });

    s = fsm('cover', 'cover');
    step(s, { command: 'secondary' });
    expect(s).toMatchObject({ state: 'approach', role: 'secondary' });

    for (const cmd of ['standby', 'regroup'] as const) {
      s = fsm('cover', 'cover');
      step(s, { command: cmd });
      expect(s).toMatchObject({ state: 'approach', role: 'standby' });
    }

    s = fsm('secondary', 'secondary');
    step(s, { command: 'detain' });
    expect(s).toMatchObject({ state: 'detain', role: 'secondary' });
  });

  it('row 5: a post assignment switches the role and removing it goes back to standby', () => {
    const s = fsm('standby', 'standby');
    step(s, { post: true });
    expect(s).toMatchObject({ state: 'approach', role: 'post' });
    step(s, { post: true, goalDistance: 0.1 });
    expect(s.state).toBe('post');
    step(s, { post: false, goalDistance: 0.1 });
    expect(s).toMatchObject({ state: 'approach', role: 'standby' });
  });

  it('row 6: approach arrives into the state of its role; cover announces itself', () => {
    for (const role of ['cover', 'secondary', 'post', 'standby'] as const) {
      const s = fsm('approach', role);
      const far = step(s, { goalDistance: cfg.move.arriveM + 0.01, post: role === 'post' });
      expect(s.state).toBe('approach');
      expect(far.callout).toBeNull();
      const out = step(s, { goalDistance: cfg.move.arriveM, post: role === 'post' });
      expect(s.state).toBe(role);
      expect(out.callout).toBe(role === 'cover' ? 'covering' : null);
    }
  });

  it('row 7: a runner sends a secondary officer chasing with a runner callout', () => {
    const s = fsm('secondary', 'secondary');
    const out = step(s, { runner: true, goalDistance: 0 });
    expect(s.state).toBe('chase');
    expect(out.callout).toBe('runner');
    // other roles ignore runners
    const c = fsm('cover', 'cover');
    step(c, { runner: true, goalDistance: 0 });
    expect(c.state).toBe('cover');
  });

  it('row 8: chase ends caught -> detain, or lost -> approach as secondary', () => {
    let s = fsm('chase', 'secondary');
    step(s);
    expect(s.state).toBe('chase');
    step(s, { caught: true });
    expect(s.state).toBe('detain');
    s = fsm('chase', 'secondary');
    step(s, { lost: true });
    expect(s).toMatchObject({ state: 'approach', role: 'secondary' });
    // caught wins over lost
    s = fsm('chase', 'secondary');
    step(s, { caught: true, lost: true });
    expect(s.state).toBe('detain');
  });

  it('row 9: detain waits for the cuffs, then calls it in and goes back to approach keeping the role', () => {
    const s = fsm('detain', 'secondary');
    expect(step(s).callout).toBeNull();
    expect(s.state).toBe('detain');
    const out = step(s, { detained: true });
    expect(out.callout).toBe('inCustody');
    expect(s).toMatchObject({ state: 'approach', role: 'secondary' });
  });

  it('row 10: a goal that moved sends settled officers back to approach', () => {
    for (const st of ['cover', 'secondary', 'post', 'standby'] as const) {
      const s = fsm(st, st, 0);
      step(s, { goalDistance: 1.5, post: st === 'post' });
      expect(s.state).toBe(st);
      step(s, { goalDistance: 1.6, post: st === 'post' });
      expect(s.state).toBe('approach');
    }
  });

  it('first matching row wins: leaving the call beats a command', () => {
    const s = fsm('cover', 'cover');
    step(s, { onCall: false, command: 'secondary' });
    expect(s.state).toBe('returning');
  });

  it('full sequence: exit -> approach -> cover with the covering callout once', () => {
    const s = fsm('exiting', 'cover');
    const callouts: (string | null)[] = [];
    let dist = 6;
    for (let i = 0; i < 600; i++) {
      const out = step(s, { goalDistance: dist });
      if (out.callout) callouts.push(out.callout);
      if (s.state === 'approach') dist = Math.max(0, dist - 0.05);
    }
    expect(s.state).toBe('cover');
    expect(callouts).toEqual(['covering']);
  });

  it('full sequence: release -> returning -> gone', () => {
    const s = fsm('standby', 'standby');
    step(s, { command: 'release' });
    expect(s.state).toBe('returning');
    step(s, { atCar: false });
    expect(s.state).toBe('returning');
    step(s, { atCar: true });
    expect(s.state).toBe('gone');
  });

  it('full sequence: runner -> chase -> detain -> inCustody', () => {
    const s = fsm('secondary', 'secondary');
    const seen: string[] = [];
    const log = (o: { callout: string | null }): void => {
      if (o.callout) seen.push(o.callout);
    };
    log(step(s, { runner: true, goalDistance: 0 }));
    expect(s.state).toBe('chase');
    log(step(s));
    log(step(s, { caught: true }));
    expect(s.state).toBe('detain');
    log(step(s, { detained: true }));
    expect(s.state).toBe('approach');
    log(step(s, { goalDistance: 0 }));
    expect(s.state).toBe('secondary');
    expect(seen).toEqual(['runner', 'inCustody']);
  });

  it('full sequence: post assignment and removal', () => {
    const s = fsm('standby', 'standby');
    step(s, { post: true, goalDistance: 0 });
    expect(s).toMatchObject({ state: 'approach', role: 'post' });
    step(s, { post: true, goalDistance: 0 });
    expect(s.state).toBe('post');
    step(s, { post: false, goalDistance: 0 });
    expect(s).toMatchObject({ state: 'approach', role: 'standby' });
    step(s, { post: false, goalDistance: 0 });
    expect(s.state).toBe('standby');
  });
});
