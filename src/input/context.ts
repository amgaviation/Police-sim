import type { ActionId } from './actions';
import type { Binding, BindingMap } from './bindings';

/**
 * Input contexts (Phase 8 review): which actions can act in which situation. Two actions may share a key when they are
 * never eligible together (an on-foot action and a driving one, a screen of another session mode, a radio-menu option
 * and everything else); `InputManager` silences the ineligible and the lower-ranked bindings of a shared key, so one key
 * press never fires several actions. The one-handed layouts rely on this: a hand has fewer keys than the game has actions.
 */

/** Session mode: `coop` = co-op patrol unit, `dispatch` = dispatch-only mode or a co-op dispatcher / supervisor. */
export type InputMode = 'solo' | 'coop' | 'dispatch';

export interface InputContext {
  /** Driving a vehicle or piloting the drone / an aircraft (else on foot). */
  driving: boolean;
  /** The controlled craft is a helicopter or the drone (Space and Shift climb there instead of braking and sprinting). */
  aircraft: boolean;
  /** The radio menu is open: its option keys belong to the menu until released. */
  radioMenu: boolean;
  mode: InputMode;
}

export const DEFAULT_INPUT_CONTEXT: Readonly<InputContext> = Object.freeze({ driving: false, aircraft: false, radioMenu: false, mode: 'solo' });

export interface ActionScope {
  /** Where the action acts: on foot, in a vehicle (or remote craft), or both. */
  readonly on: 'foot' | 'vehicle' | 'both';
  /** Only with an aircraft (`true`) or only without one (`false`) under control. */
  readonly aircraft?: boolean;
  /** Session modes the action exists in (default: all). */
  readonly modes?: readonly InputMode[];
  /** Acts only while the radio menu is open (and then takes the key from every other action). */
  readonly modal?: true;
  /** A rarely used opener: on a key shared with a non-rare eligible action it gives way. */
  readonly rare?: true;
}

const FOOT: ActionScope = { on: 'foot' };
const VEHICLE: ActionScope = { on: 'vehicle' };
const GROUND: ActionScope = { on: 'vehicle', aircraft: false };
const AIRCRAFT: ActionScope = { on: 'vehicle', aircraft: true };
const BOTH: ActionScope = { on: 'both' };
const RARE: ActionScope = { on: 'both', rare: true };
const RARE_FOOT: ActionScope = { on: 'foot', rare: true };
const RARE_VEHICLE: ActionScope = { on: 'vehicle', rare: true };
const OPTION: ActionScope = { on: 'both', modal: true };

/** Scope of every action (keep in step with `app.ts` handleToggles / handleActions and the Phase 4 / radio input readers). */
export const ACTION_SCOPES = {
  'move.forward': FOOT,
  'move.back': FOOT,
  'move.left': FOOT,
  'move.right': FOOT,
  'move.sprint': FOOT,
  'look.x': BOTH,
  'look.y': BOTH,
  interact: BOTH,
  'menu.toggle': BOTH,
  'console.toggle': RARE,
  'perf.toggle': RARE,
  'vehicle.accelerate': VEHICLE,
  'vehicle.brake': VEHICLE,
  'vehicle.steer': VEHICLE,
  'vehicle.siren': VEHICLE,
  'vehicle.lights': VEHICLE,
  'camera.toggle': BOTH,
  'vehicle.handbrake': GROUND,
  'vehicle.headlights': VEHICLE,
  'map.toggle': RARE,
  'vehicle.sirenTone': VEHICLE,
  'vehicle.horn': VEHICLE,
  'vehicle.manual': RARE_VEHICLE,
  'vehicle.lightPattern': RARE_VEHICLE,
  'vehicle.spotlight': VEHICLE,
  'vehicle.spotAim': RARE_VEHICLE,
  'vehicle.equipment': RARE_VEHICLE,
  'mdt.toggle': BOTH,
  'target.runPlate': BOTH,
  'radio.menu': BOTH,
  'radio.option1': OPTION,
  'radio.option2': OPTION,
  'radio.option3': OPTION,
  'radio.option4': OPTION,
  'radio.option5': OPTION,
  'radio.option6': OPTION,
  'radio.option7': OPTION,
  'radio.option8': OPTION,
  'radio.option9': OPTION,
  'radio.ptt': BOTH,
  'radio.emergency': BOTH,
  'radio.channelPrev': RARE,
  'radio.channelNext': RARE,
  'radio.scan': RARE,
  'officer.weapon': FOOT,
  'officer.fire': FOOT,
  'officer.tackle': FOOT,
  'officer.shout': FOOT,
  'scene.menu': BOTH,
  'officer.crouch': FOOT,
  'officer.leanLeft': FOOT,
  'officer.leanRight': FOOT,
  'officer.slice': FOOT,
  'officer.flashlight': FOOT,
  'officer.bodycam': RARE,
  'investigate.menu': RARE_FOOT,
  'camera.photo': RARE_FOOT,
  'partner.menu': RARE_FOOT,
  'officer.intervene': FOOT,
  'officer.bodycamMute': RARE_FOOT,
  'backup.menu': RARE,
  'command.menu': RARE,
  'pursuit.menu': RARE,
  'air.flir': RARE,
  'vehicle.lift': AIRCRAFT,
  'fleet.menu': RARE,
  'drone.toggle': RARE,
  'career.menu': { on: 'both', rare: true, modes: ['solo'] },
  'coop.menu': { on: 'both', rare: true, modes: ['coop'] },
  'dispatch.console': { on: 'both', rare: true, modes: ['dispatch'] },
} as const satisfies Record<ActionId, ActionScope>;

/** True when `id` can act in `ctx` (a radio option only while the menu is open). */
export function isEligible(id: ActionId, ctx: Readonly<InputContext>): boolean {
  const s: ActionScope = ACTION_SCOPES[id];
  if (s.modal === true && !ctx.radioMenu) return false;
  if (s.on === 'foot' && ctx.driving) return false;
  if (s.on === 'vehicle' && !ctx.driving) return false;
  if (s.aircraft !== undefined && s.aircraft !== ctx.aircraft) return false;
  return s.modes === undefined || s.modes.includes(ctx.mode);
}

/** A radio option: it acts only while the radio menu is open and then owns its key. */
export function isModal(id: ActionId): boolean {
  return (ACTION_SCOPES[id] as ActionScope).modal === true;
}

/** The rank of an action on a shared key: a rare opener gives way to any other eligible action. */
export function rankOf(id: ActionId): number {
  return (ACTION_SCOPES[id] as ActionScope).rare === true ? 1 : 2;
}

/** Keyboard keys and mouse buttons only: the devices whose shared inputs are arbitrated. */
export function isArbitrated(b: Binding): boolean {
  return b.device === 'keyboard' || (b.device === 'mouse' && b.code.startsWith('MouseButton'));
}

const MODES: readonly InputMode[] = ['solo', 'coop', 'dispatch'];

/** True when some session state makes both actions eligible, the radio menu aside (see `modalOverlap`). */
export function scopesOverlap(a: ActionId, b: ActionId): boolean {
  const sa: ActionScope = ACTION_SCOPES[a];
  const sb: ActionScope = ACTION_SCOPES[b];
  if ((sa.modal === true) !== (sb.modal === true)) return false; // the menu's option keys are taken from everything else
  for (const state of situations(sa.modal === true)) if (isEligible(a, state) && isEligible(b, state)) return true;
  return false;
}

/** Every combination of on foot / driving / aircraft and session mode. */
export function situations(radioMenu = false): InputContext[] {
  const out: InputContext[] = [];
  for (const mode of MODES) {
    out.push({ driving: false, aircraft: false, radioMenu, mode });
    for (const aircraft of [false, true]) out.push({ driving: true, aircraft, radioMenu, mode });
  }
  return out;
}

export interface KeyCollision {
  /** `keyboard:KeyW` or `mouse:MouseButton2`. */
  readonly key: string;
  readonly actions: readonly [ActionId, ActionId];
  /** True when one of the two is a rare opener that gives way (no double action, but the opener is unreachable there). */
  readonly shadowed: boolean;
}

/**
 * Pairs of actions that share a keyboard key or mouse button and can be eligible together. At run time `InputManager`
 * keeps such a press from firing both (the non-rare one wins); two rare ones, or two of equal rank, would both fire.
 */
export function bindingCollisions(map: Readonly<BindingMap>, ids: readonly ActionId[]): KeyCollision[] {
  const byKey = new Map<string, Set<ActionId>>();
  for (const id of ids) {
    for (const b of map[id]) {
      if (!isArbitrated(b)) continue;
      const k = `${b.device}:${b.code}`;
      const set = byKey.get(k) ?? new Set<ActionId>();
      set.add(id);
      byKey.set(k, set);
    }
  }
  const out: KeyCollision[] = [];
  for (const [key, set] of byKey) {
    const list = [...set];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as ActionId;
        const b = list[j] as ActionId;
        if (scopesOverlap(a, b)) out.push({ key, actions: [a, b], shadowed: rankOf(a) !== rankOf(b) });
      }
    }
  }
  return out;
}

/**
 * Actions with a keyboard / mouse binding that never act in any situation because a higher-ranked action always holds
 * their key (a rare opener hidden behind a core action on every key it has). A layout must have none.
 */
export function unreachableActions(map: Readonly<BindingMap>, ids: readonly ActionId[]): ActionId[] {
  const keysOf = (id: ActionId): string[] => map[id].filter(isArbitrated).map((b) => `${b.device}:${b.code}`);
  const keys = new Map<ActionId, string[]>();
  for (const id of ids) keys.set(id, keysOf(id));
  const out: ActionId[] = [];
  for (const id of ids) {
    const own = keys.get(id) ?? [];
    if (own.length === 0 || isModal(id)) continue;
    const reachable = situations().some(
      (state) =>
        isEligible(id, state) &&
        own.some((key) => !ids.some((o) => o !== id && !isModal(o) && rankOf(o) > rankOf(id) && isEligible(o, state) && (keys.get(o) ?? []).includes(key))),
    );
    if (!reachable) out.push(id);
  }
  return out;
}
