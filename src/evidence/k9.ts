/**
 * K9 sweep stub (design phase 4 §9.5): the dog visits rooms in order and alerts on what it can smell.
 */

export interface K9Target {
  kind: 'person' | 'item';
  ref: string;
  room: number;
  x: number;
  z: number;
  scent: 'person' | 'narcotics' | 'firearm' | 'other';
}

export interface K9Alert {
  ref: string;
  kind: 'person' | 'item';
  room: number;
  x: number;
  z: number;
  atS: number;
}

/** Seconds until the dog reaches the first room. */
export const K9_FIRST_ROOM_S = 4;
/** Seconds spent per room. */
export const K9_ROOM_S = 12;

export const K9_ALERT_CHANCE: Readonly<Record<K9Target['scent'], number>> = {
  person: 0.95,
  narcotics: 0.9,
  firearm: 0.6,
  other: 0.2,
};

/**
 * Visits rooms in `order` (first at 4 s, then 12 s per room); each target in a visited room alerts with the
 * probability of its scent when `u(i)` (deterministic 0..1 per target index) is below it. Alerts are in time order.
 */
export function k9Sweep(order: readonly number[], targets: readonly K9Target[], u: (i: number) => number): K9Alert[] {
  const alerts: K9Alert[] = [];
  for (let r = 0; r < order.length; r++) {
    const room = order[r];
    if (room === undefined || order.indexOf(room) !== r) continue;
    const atS = K9_FIRST_ROOM_S + K9_ROOM_S * r;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t || t.room !== room || u(i) >= K9_ALERT_CHANCE[t.scent]) continue;
      alerts.push({ ref: t.ref, kind: t.kind, room: t.room, x: t.x, z: t.z, atS });
    }
  }
  return alerts;
}
