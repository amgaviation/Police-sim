/** Shared HUD shapes of the Phase 4 additions (design §11.3). No DOM. */

/**
 * The floor plan of the building the officer is in, re-declared structurally (the interior module's `FloorPlan` is
 * assignable to it): `rooms` holds minX, minZ, maxX, maxZ per room; `doors` holds x, z and open (0 | 1) per door.
 */
export interface FloorPlan {
  readonly rooms: Float32Array;
  readonly doors: Float32Array;
  readonly rect: { readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number };
}

/** On-foot tactical state (chips CROUCH / LEAN / SLICE / LIGHT, a 5-step noise meter and a visibility readout). */
export interface HudTactical {
  crouched: boolean;
  lean: -1 | 0 | 1;
  flashlight: boolean;
  /** How loud the officer is, 0..1 (5-step meter). */
  noise: number;
  /** How visible the officer is to others, 0..1. */
  visibility: number;
  slicing: boolean;
}

/** Bodycam state: shown when the camera is worn. */
export interface HudBodycam {
  recording: boolean;
}

/** Where the officer is indoors. */
export interface HudLocation {
  /** Building label, e.g. 'House'. */
  building: string;
  /** Room label, e.g. 'Kitchen'. */
  room: string;
}

/** A co-op teammate drawn on the minimap and the MDT map (presentation only). */
export interface RemoteUnit {
  callsign: string;
  x: number;
  z: number;
}
