/**
 * Pure state machine of one on-foot backup officer (design §9.2). The transition table is evaluated top to bottom and
 * the first matching row wins each step; the runtime feeds the inputs and reads the state and the callout to schedule.
 */
import type { BackupConfig, BackupRole, BackupState } from './types';

export type { BackupRole, BackupState } from './types';

/** Mutable FSM state; `timer` counts the exit animation. */
export interface OfficerFsm {
  state: BackupState;
  role: BackupRole;
  timer: number;
}

export interface FsmInputs {
  dt: number;
  /** The unit is still assigned to the player's call and within reach. */
  onCall: boolean;
  /** Distance to the current goal spot (m). */
  goalDistance: number;
  /** A secondary subject is fleeing (role secondary). */
  runner: boolean;
  /** The chase target was caught. */
  caught: boolean;
  /** The chase target was lost. */
  lost: boolean;
  /** A player command for this officer this step, else null. */
  command: 'cover' | 'secondary' | 'detain' | 'standby' | 'release' | 'regroup' | null;
  /** A post is assigned (command module). */
  post: boolean;
  /** The detain target is cuffed. */
  detained: boolean;
  /** Back at the car (returning). */
  atCar: boolean;
}

export interface FsmOutput {
  changed: boolean;
  /** Callout to schedule this step. */
  callout: 'covering' | 'runner' | 'inCustody' | null;
}

/** A fresh output record for `stepOfficerFsm`. */
export function createFsmOutput(): FsmOutput {
  return { changed: false, callout: null };
}

/** Role for the k-th officer (arrival order) on the call: 0 cover, 1 secondary, others standby. */
export function initialRole(k: number): BackupRole {
  return k === 0 ? 'cover' : k === 1 ? 'secondary' : 'standby';
}

function enter(s: OfficerFsm, state: BackupState, out: FsmOutput): void {
  s.state = state;
  out.changed = true;
}

/** The state an officer settles into for `role` once it reached its goal. */
function stateOfRole(role: BackupRole): BackupState {
  return role === 'swat' ? 'swat' : role;
}

/** Mutates `s`; pure apart from `s` and `out`. Returns `out`. */
export function stepOfficerFsm(s: OfficerFsm, i: FsmInputs, cfg: BackupConfig, out: FsmOutput): FsmOutput {
  out.changed = false;
  out.callout = null;
  const state = s.state;

  // 1. Left the call.
  if (!i.onCall && state !== 'returning' && state !== 'gone' && state !== 'swat') {
    enter(s, 'returning', out);
    return out;
  }
  // 2. Back at the car.
  if (state === 'returning') {
    if (i.atCar) enter(s, 'gone', out);
    return out;
  }
  if (state === 'gone' || state === 'swat') return out;
  // 3. Getting out of the car.
  if (state === 'exiting') {
    s.timer += i.dt;
    if (s.timer >= cfg.spawn.exitS) {
      s.timer = 0;
      enter(s, 'approach', out);
    }
    return out;
  }
  // 4. Player command.
  if (i.command !== null) {
    switch (i.command) {
      case 'release':
        enter(s, 'returning', out);
        break;
      case 'cover':
      case 'secondary':
        s.role = i.command;
        enter(s, 'approach', out);
        break;
      case 'standby':
      case 'regroup':
        s.role = 'standby';
        enter(s, 'approach', out);
        break;
      case 'detain':
        enter(s, 'detain', out);
        break;
    }
    return out;
  }
  // 5. Posts.
  if (i.post && s.role !== 'post') {
    s.role = 'post';
    enter(s, 'approach', out);
    return out;
  }
  if (!i.post && s.role === 'post') {
    s.role = 'standby';
    enter(s, 'approach', out);
    return out;
  }
  switch (state) {
    // 6. Walking to the goal of the role.
    case 'approach':
      if (i.goalDistance <= cfg.move.arriveM) {
        enter(s, stateOfRole(s.role), out);
        if (s.role === 'cover') out.callout = 'covering';
      }
      return out;
    case 'secondary':
      // 7. A secondary subject runs.
      if (i.runner) {
        enter(s, 'chase', out);
        out.callout = 'runner';
        return out;
      }
      break;
    // 8. Chasing.
    case 'chase':
      if (i.caught) enter(s, 'detain', out);
      else if (i.lost) {
        s.role = 'secondary';
        enter(s, 'approach', out);
      }
      return out;
    // 9. Cuffing.
    case 'detain':
      if (i.detained) {
        out.callout = 'inCustody';
        enter(s, 'approach', out);
      }
      return out;
    default:
      break;
  }
  // 10. The goal moved.
  if ((state === 'cover' || state === 'secondary' || state === 'post' || state === 'standby') && i.goalDistance > 1.5) enter(s, 'approach', out);
  return out;
}
