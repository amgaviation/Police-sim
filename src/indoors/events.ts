/** Interior events (design §6.8), declared on the shared event map. */

export interface InteriorResidentEvent {
  buildingId: number;
  loaded: boolean;
}

/** The officer is placed at a new pose (y = the level's floor, or 0 outdoors); the integrator teleports the body. */
export interface InteriorMoveOfficerEvent {
  buildingId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface InteriorTransitionEvent {
  buildingId: number;
  entering: boolean;
  phase: 'out' | 'in' | 'done';
}

export interface InteriorDoorEvent {
  buildingId: number;
  door: number;
  action: 'open' | 'close' | 'locked' | 'knock' | 'announce' | 'kick' | 'ram' | 'breached' | 'lock' | 'unlock';
  success: boolean;
  x: number;
  z: number;
  by: 'officer' | 'scene';
}

export interface InteriorSwitchEvent {
  buildingId: number;
  room: number;
  on: boolean;
}

export interface InteriorFlashEvent {
  text: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'interior:resident': InteriorResidentEvent;
    'interior:moveOfficer': InteriorMoveOfficerEvent;
    'interior:transition': InteriorTransitionEvent;
    'interior:door': InteriorDoorEvent;
    'interior:switch': InteriorSwitchEvent;
    'interior:flash': InteriorFlashEvent;
  }
}
