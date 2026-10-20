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
  'vehicle.handbrake': { kind: 'button', label: 'Handbrake' },
  'vehicle.headlights': { kind: 'button', label: 'Headlights' },
  'map.toggle': { kind: 'button', label: 'Map zoom' },
  // Phase 2: patrol car equipment, MDT, targeting, radio (design §11.5).
  'vehicle.sirenTone': { kind: 'button', label: 'Siren tone' },
  'vehicle.horn': { kind: 'button', label: 'Air horn' },
  'vehicle.manual': { kind: 'button', label: 'Manual siren' },
  'vehicle.lightPattern': { kind: 'button', label: 'Light pattern' },
  'vehicle.spotlight': { kind: 'button', label: 'Spotlight' },
  'vehicle.spotAim': { kind: 'button', label: 'Aim spotlight (hold)' },
  'vehicle.equipment': { kind: 'button', label: 'Vehicle equipment' },
  'mdt.toggle': { kind: 'button', label: 'MDT' },
  'target.runPlate': { kind: 'button', label: 'Run plate' },
  'radio.menu': { kind: 'button', label: 'Radio menu' },
  'radio.option1': { kind: 'button', label: 'Radio option 1' },
  'radio.option2': { kind: 'button', label: 'Radio option 2' },
  'radio.option3': { kind: 'button', label: 'Radio option 3' },
  'radio.option4': { kind: 'button', label: 'Radio option 4' },
  'radio.option5': { kind: 'button', label: 'Radio option 5' },
  'radio.option6': { kind: 'button', label: 'Radio option 6' },
  'radio.option7': { kind: 'button', label: 'Radio option 7' },
  'radio.option8': { kind: 'button', label: 'Radio option 8' },
  'radio.option9': { kind: 'button', label: 'Radio option 9' },
  'radio.ptt': { kind: 'button', label: 'Push to talk' },
  'radio.emergency': { kind: 'button', label: 'Emergency button' },
  'radio.channelPrev': { kind: 'button', label: 'Previous channel' },
  'radio.channelNext': { kind: 'button', label: 'Next channel' },
  'radio.scan': { kind: 'button', label: 'Radio scan' },
  // Phase 3: on-foot officer actions and the scene menu (design §12.5).
  'officer.weapon': { kind: 'button', label: 'Cycle force tool' },
  'officer.fire': { kind: 'button', label: 'Fire / deploy weapon' },
  'officer.tackle': { kind: 'button', label: 'Tackle' },
  'officer.shout': { kind: 'button', label: 'Shout command' },
  'scene.menu': { kind: 'button', label: 'Scene menu' },
  // Phase 4: tactical movement, investigation, camera and partner (design §11.4).
  'officer.crouch': { kind: 'button', label: 'Crouch' },
  'officer.leanLeft': { kind: 'button', label: 'Lean left (hold)' },
  'officer.leanRight': { kind: 'button', label: 'Lean right (hold)' },
  'officer.slice': { kind: 'button', label: 'Slice the pie (hold)' },
  'officer.flashlight': { kind: 'button', label: 'Flashlight' },
  'officer.bodycam': { kind: 'button', label: 'Bodycam' },
  'investigate.menu': { kind: 'button', label: 'Investigation tools' },
  'camera.photo': { kind: 'button', label: 'Evidence camera' },
  'partner.menu': { kind: 'button', label: 'Partner commands' },
  // Phase 5: duty to intervene and the bodycam mute (design §12.5). `officer.weapon` is now the force tool cycle.
  'officer.intervene': { kind: 'button', label: 'Intervene' },
  'officer.bodycamMute': { kind: 'button', label: 'Bodycam mute' },
  // Phase 6: backup, incident command, pursuit tactics and the air unit camera (design §12.1).
  'backup.menu': { kind: 'button', label: 'Backup officers' },
  'command.menu': { kind: 'button', label: 'Incident command / triage' },
  'pursuit.menu': { kind: 'button', label: 'Pursuit tactics' },
  'air.flir': { kind: 'button', label: 'Air unit camera (FLIR)' },
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
