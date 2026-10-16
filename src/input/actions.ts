/** Whether an action reads as an on/off button or a continuous -1..1 axis. */
export type ActionKind = 'button' | 'axis';

export interface ActionMeta {
  readonly kind: ActionKind;
  /** Human-readable name for the rebinding UI. */
  readonly label: string;
  /**
   * Two-way axis (look, steer): a binding's sign says which way it turns, so a
   * captured stick takes the slot's sign rather than the direction it was pushed.
   */
  readonly bipolar?: boolean;
}

/** Every abstract input action the game understands, with its metadata. */
export const ACTIONS = {
  'move.forward': { kind: 'button', label: 'Move forward' },
  'move.back': { kind: 'button', label: 'Move back' },
  'move.left': { kind: 'button', label: 'Move left' },
  'move.right': { kind: 'button', label: 'Move right' },
  'move.sprint': { kind: 'button', label: 'Sprint' },
  'look.x': { kind: 'axis', label: 'Look horizontal', bipolar: true },
  'look.y': { kind: 'axis', label: 'Look vertical', bipolar: true },
  interact: { kind: 'button', label: 'Interact' },
  'menu.toggle': { kind: 'button', label: 'Menu' },
  'console.toggle': { kind: 'button', label: 'Debug console' },
  'perf.toggle': { kind: 'button', label: 'Performance overlay' },
  'vehicle.accelerate': { kind: 'axis', label: 'Accelerate' },
  'vehicle.brake': { kind: 'axis', label: 'Brake / reverse' },
  'vehicle.steer': { kind: 'axis', label: 'Steer', bipolar: true },
  'vehicle.siren': { kind: 'button', label: 'Siren' },
  'vehicle.lights': { kind: 'button', label: 'Emergency lights' },
  'camera.toggle': { kind: 'button', label: 'Toggle camera' },
} as const satisfies Record<string, ActionMeta>;

export type ActionId = keyof typeof ACTIONS;

/** All action ids in declaration order. */
export const ACTION_IDS: readonly ActionId[] = Object.keys(ACTIONS) as ActionId[];

export function isActionId(value: unknown): value is ActionId {
  return typeof value === 'string' && Object.hasOwn(ACTIONS, value);
}

export function actionKind(id: ActionId): ActionKind {
  return ACTIONS[id].kind;
}

/** True for two-way axis actions (see `ActionMeta.bipolar`). */
export function isBipolar(id: ActionId): boolean {
  return (ACTIONS[id] as ActionMeta).bipolar === true;
}
