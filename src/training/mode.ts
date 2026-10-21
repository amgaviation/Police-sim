/**
 * Game modes (Phase 8 design 7.1) and the save block that keeps a mode's state. The block is stored by the integrator
 * in the session save; every nested block is validated with the validator of the module that owns it.
 */
import { isCourseRunSave, type CourseRunSave } from './course';
import { isDispatchTrainingSave, type DispatchTrainingSave } from './dispatchScore';
import { isSandboxScenario, type SandboxScenario } from './scenario';
import { isScriptRunSave, type ScriptRunSave } from './script';

export const GAME_MODES = ['freePatrol', 'career', 'drivingAcademy', 'dispatchOnly', 'sandbox', 'coop'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export type CoopRole = 'patrol' | 'dispatcher' | 'supervisor';

export interface ModeSave {
  version: 1;
  id: GameMode;
  /** Driving course in progress (drivingAcademy, career academy). */
  course: CourseRunSave | null;
  courseId: string | null;
  /** Dispatch script in progress. */
  script: ScriptRunSave | null;
  /** Dispatch-only scoring. */
  dispatch: DispatchTrainingSave | null;
  /** The sandbox scenario last run (re-run, editor reopen). */
  scenario: SandboxScenario | null;
  /** Informational; a co-op session loads offline as freePatrol. */
  coopRole: CoopRole | null;
}

/** An empty mode block for `id`. */
export function newModeSave(id: GameMode): ModeSave {
  return { version: 1, id, course: null, courseId: null, script: null, dispatch: null, scenario: null, coopRole: null };
}

/** Full structural check of a mode block, including every nested block. */
export function isModeSave(x: unknown): x is ModeSave {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.id === 'string' && (GAME_MODES as readonly string[]).includes(o.id) &&
    (o.course === null || isCourseRunSave(o.course)) &&
    (o.courseId === null || typeof o.courseId === 'string') &&
    (o.script === null || isScriptRunSave(o.script)) &&
    (o.dispatch === null || isDispatchTrainingSave(o.dispatch)) &&
    (o.scenario === null || isSandboxScenario(o.scenario)) &&
    (o.coopRole === null || o.coopRole === 'patrol' || o.coopRole === 'dispatcher' || o.coopRole === 'supervisor')
  );
}
