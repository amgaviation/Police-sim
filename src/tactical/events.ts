/** Tactical bus topics (design §7.6, §14). */
import type { SoundKind } from './sound';

/** An officer-made sound (the noise meter). The payload object is reused: copy what you keep. */
export interface TacticalSoundEvent {
  kind: SoundKind;
  x: number;
  z: number;
  building: number;
  /** Source level in dB at 1 m. */
  level: number;
}

export interface TacticalStanceEvent {
  crouched: boolean;
}

export interface TacticalFlashlightEvent {
  on: boolean;
}

/** A partner reply or report (subtitle and optional speech). */
export interface TacticalPartnerEvent {
  text: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'tactical:sound': TacticalSoundEvent;
    'tactical:stance': TacticalStanceEvent;
    'tactical:flashlight': TacticalFlashlightEvent;
    'tactical:partner': TacticalPartnerEvent;
  }
}
