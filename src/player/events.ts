/** Player and camera mode names as carried by events (and the v3 save). */
export type PlayerModeName = 'onFoot' | 'driving';
export type CameraModeName = 'onFoot' | 'chase' | 'hood' | 'cockpit';

/** The officer got into (`vehicle` = its eid) or out of (`vehicle` = 0) a vehicle. */
export interface PlayerModeEvent {
  mode: PlayerModeName;
  vehicle: number;
}

export interface CameraModeEvent {
  mode: CameraModeName;
}

declare module '../core/event-map' {
  interface EventMap {
    'player:mode': PlayerModeEvent;
    'camera:mode': CameraModeEvent;
  }
}
