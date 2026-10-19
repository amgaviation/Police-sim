/** The start-of-shift flow: locker, briefing, armory, garage, then patrol (design §11.1). Pure. */

export const SHIFT_STEPS = ['locker', 'briefing', 'armory', 'garage', 'onPatrol'] as const;
export type ShiftStep = (typeof SHIFT_STEPS)[number];

export function isShiftStep(value: unknown): value is ShiftStep {
  return typeof value === 'string' && (SHIFT_STEPS as readonly string[]).includes(value);
}

const OBJECTIVES: Readonly<Record<ShiftStep, string | null>> = {
  locker: 'Shift: choose your gear at the locker (E)',
  briefing: 'Shift: attend roll call (E at the podium)',
  armory: 'Shift: sign out your weapons at the armory (E)',
  garage: 'Shift: take a patrol car from the garage',
  onPatrol: null,
};

/**
 * Progress through the start-of-shift steps. `complete` marks a step done and moves on to the next one; completing
 * a later step skips the ones before it (every step passed is logged with the sim time).
 */
export class ShiftFlow {
  private current: ShiftStep;
  private readonly entries: [ShiftStep, number][] = [];

  constructor(start: ShiftStep = 'locker') {
    this.current = start;
  }

  get step(): ShiftStep {
    return this.current;
  }

  /** Steps completed (or skipped) so far with the sim time, oldest first. */
  get log(): readonly [ShiftStep, number][] {
    return this.entries;
  }

  /**
   * Marks `step` done; advances when it is the current step or a later one (earlier steps are skipped and logged too).
   * Returns false, changing nothing, for an earlier step or once on patrol. Completing `onPatrol` skips to patrol.
   */
  complete(step: ShiftStep, sim: number): boolean {
    const from = SHIFT_STEPS.indexOf(this.current);
    const to = SHIFT_STEPS.indexOf(step);
    const patrol = SHIFT_STEPS.length - 1;
    if (from >= patrol || to < from) return false;
    for (let i = from; i <= Math.min(to, patrol - 1); i++) this.entries.push([SHIFT_STEPS[i] ?? 'locker', sim]);
    this.current = SHIFT_STEPS[Math.min(to + 1, patrol)] ?? 'onPatrol';
    return true;
  }

  /** The HUD objective text for the current step, null once on patrol. */
  objective(): string | null {
    return OBJECTIVES[this.current];
  }

  /** Replaces the state (save load). */
  restore(step: ShiftStep, log: readonly (readonly [ShiftStep, number])[]): void {
    this.current = step;
    this.entries.length = 0;
    for (const [s, t] of log) this.entries.push([s, t]);
  }
}
