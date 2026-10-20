import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { ActorInfo } from '../npc/types';
import type { Population } from '../people/population';

/** The tools the officer can hold (design 6.3). `none` = hands free / holstered. */
export const FORCE_TOOLS = ['none', 'hands', 'ocSpray', 'baton', 'taser', 'lessLethal', 'firearm', 'k9'] as const;
export type ForceToolId = (typeof FORCE_TOOLS)[number];

/** Use-of-force continuum levels (re-declared locally; the legal engine owns the shared list). */
export const FORCE_LEVELS = ['presence', 'verbal', 'softHands', 'hardHands', 'ocSpray', 'baton', 'taser', 'k9', 'lessLethal', 'firearm'] as const;
export type ForceLevel = (typeof FORCE_LEVELS)[number];

/** Subject resistance levels (re-declared locally; design 4.2). */
export const RESISTANCE_LEVELS = ['compliant', 'passive', 'active', 'assaultive', 'lethal'] as const;
export type Resistance = (typeof RESISTANCE_LEVELS)[number];

/** Closed range `[min, max]`. */
export type Range2 = readonly [number, number];

/** One row of `force.json` `tools`. */
export interface ToolDef {
  readonly id: Exclude<ForceToolId, 'none'>;
  readonly label: string;
  readonly level: ForceLevel;
  /** Station armory item the tool needs signed out, null = always available. */
  readonly armory: string | null;
  readonly rangeM: Range2;
  readonly coneDeg: number;
  readonly hit: number;
  readonly incapacitate: { readonly chance: number; readonly seconds: number };
  readonly injury: Range2;
  /** OC spray uses per shift. */
  readonly uses?: number;
  /** Launcher / pistol rounds per shift. */
  readonly rounds?: number;
}

/** Validated `force.json` (design 6.1). */
export interface ForceConfig {
  readonly tools: readonly ToolDef[];
  readonly taser: {
    readonly cartridges: number;
    readonly spreadDeg: number;
    readonly minSpreadM: number;
    readonly torsoHalfWidthM: number;
    readonly targetHeightM: number;
    readonly sigmaDeg: number;
    readonly movingPenalty: number;
    readonly runningPenalty: number;
    readonly clothingFail: number;
    readonly coldC: number;
    readonly nmiSuccess: number;
    readonly painComply: number;
    readonly cycleS: number;
    readonly attachMaxS: number;
    readonly reattachRangeM: number;
  };
  readonly firearm: {
    readonly sigmaDeg: number;
    readonly torsoHalfWidthM: number;
    readonly zoneWeights: { readonly torso: number; readonly limb: number; readonly head: number };
    readonly injury: { readonly limb: Range2; readonly torso: Range2; readonly head: Range2 };
    readonly fatal: { readonly limb: number; readonly torso: number; readonly head: number };
  };
  readonly lessLethal: {
    readonly sigmaDeg: number;
    readonly torsoHalfWidthM: number;
    readonly minSafeM: number;
    readonly closeInjury: Range2;
  };
  readonly modifiers: { readonly officerMoving: number; readonly targetRunning: number; readonly crouched: number };
  readonly risk: {
    readonly elevatedRoomKinds: readonly string[];
    readonly pregnancyRate: number;
    readonly pregnancyAge: Range2;
  };
  readonly fellow: {
    readonly chance: number;
    readonly delayS: Range2;
    readonly repeatS: number;
    readonly maxStrikes: number;
    readonly injury: number;
    readonly interveneRadiusM: number;
  };
}

/** What the UI / keys ask of the force system; applied at the start of the next `step`. */
export type ForceRequest =
  | { readonly kind: 'cycleTool' }
  | { readonly kind: 'selectTool'; readonly tool: ForceToolId }
  | { readonly kind: 'apply'; readonly dirX: number; readonly dirZ: number }
  | { readonly kind: 'intervene' }
  | { readonly kind: 'fellowTest' };

/** The officer as seen by the force system, passed to every `step`. */
export interface ForceOfficer {
  x: number;
  z: number;
  yaw: number;
  /** Building the officer is in, -1 outdoors. */
  building: number;
  onFoot: boolean;
  moving: boolean;
  crouched: boolean;
  /** The call the officer is working, 0 none. */
  callId: number;
}

/** A fellow officer (the Phase 4 partner placeholder). */
export interface FellowOfficer {
  name: string;
  x: number;
  z: number;
  building: number;
}

/** Structural port to the NPC system (hooks adds `resistance`, `incapacitate`, `wound`, `taserCycle`). */
export interface ForceNpcPort {
  actorIds(out: number[]): number[];
  actor(id: number, out: ActorInfo): ActorInfo | null;
  resistance(id: number): Resistance;
  incapacitate(id: number, seconds: number, by: 'oc' | 'strike' | 'baton' | 'beanbag' | 'k9' | 'taser' | 'shot'): boolean;
  wound(id: number, severity: number, fatal: boolean): void;
  taserCycle(id: number, seconds: number): void;
}

/** Structural port to the scene director (hooks adds `setWeapon`, `serviceArrived`). */
export interface ForceScenePort {
  setWeapon(w: 'none' | 'sidearm' | 'taser'): void;
  serviceArrived(callId: number, kind: string): boolean;
}

export interface ForceDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  /** `session.rng.stream('force')`. */
  readonly rng: Rng;
  readonly npc: ForceNpcPort;
  readonly people: Pick<Population, 'identity' | 'state' | 'intoxication' | 'setInjured' | 'setDeceased'>;
  readonly scene: ForceScenePort;
  /** Is armory item `item` (sidearm, taser, ocSpray, baton, beanbag) signed out to the officer? */
  armoryHas(item: string): boolean;
  temperatureC(): number;
  elevatedAt(building: number, x: number, z: number): boolean;
  fellows(): readonly FellowOfficer[];
  readonly config?: ForceConfig;
}

/** HUD feed: one reused object, `revision` changes when any field does. */
export interface ForceHud {
  tool: ForceToolId;
  label: string;
  ammo: string;
  attached: boolean;
  cycle: number;
  episode: string | null;
}
