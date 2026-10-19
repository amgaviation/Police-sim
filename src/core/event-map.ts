/**
 * Central registry of event topics and their payload types.
 *
 * Other modules extend it through declaration merging:
 *
 * ```ts
 * declare module '@/core/event-map' {
 *   interface EventMap { 'traffic:spawned': { eid: number } }
 * }
 * ```
 *
 * Phase 1 topics are declared that way next to their payload types:
 * `env:*` in environment/events.ts, `vehicle:*` in vehicles/events.ts,
 * `traffic:*` in traffic/events.ts, `player:mode` and `camera:mode` in player/events.ts.
 * Phase 2: `cad:*`, `unit:request` and `dispatch:*` in cad/events.ts, `radio:*` in radio/events.ts.
 * Phase 3: `traffic:fleeing` / `traffic:fleeEnded` (and `traffic:released` reason `fled`) in traffic/events.ts,
 * `npc:*` in npc/events.ts, `contact:*` in contact/events.ts, `scene:*` and `force:used` in scene/events.ts,
 * `cad:callUpdated` change `links` in cad/events.ts.
 * Phase 4: `interior:*` in indoors/events.ts, `tactical:*` in tactical/events.ts, `npc:aware` in npc/events.ts,
 * `contact:consent` in contact/events.ts, `investigation:*` in investigation/events.ts, `station:*` in station/events.ts,
 * `scene:service` (and `scene:materialized.buildingId`) in scene/events.ts.
 */
export interface EventMap {
  'app:ready': Record<string, never>;
  'app:pause': { paused: boolean };
  'loop:fixed': { dt: number; step: number };
  'input:action': { action: string; value: number; pressed: boolean };
  'save:completed': { slot: string };
  'save:loaded': { slot: string };
  'settings:changed': { path: string; value: unknown };
  'console:log': { level: 'debug' | 'info' | 'warn' | 'error'; message: string; time: number };
  'rng:reseed': { seed: number };
}

export type EventTopic = keyof EventMap;
export type EventPayload<K extends EventTopic> = EventMap[K];
