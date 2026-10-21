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
 * Phase 5: `force:*` in force/events.ts (tool, applied, other, intervened, flash), `contact:fact` / `contact:said` /
 * `contact:action` / `contact:miranda` in contact/events.ts, `scene:command` (and the optional `scene:pursuit` owner,
 * person and end reason) in scene/events.ts, `npc:caught.by` 'force' in npc/events.ts, `incident:*` in incidents/events.ts,
 * `conduct:*` in conduct/events.ts, `court:*` in court/events.ts.
 * Phase 6: `resource:*` in resources/events.ts (dispatched, arrived, cleared, radio, flash), `backup:*` in backup/events.ts
 * (callout, mistake, custody, swat, radio, flash), `pursuit:*` in pursuit/events.ts (tactic, handoff, radio, flash) and
 * `pursuit:order` in incidents/events.ts, `command:*` in command/events.ts (post, triage, negotiation, radio, flash),
 * `traffic:collision.fleeing` in traffic/events.ts, `unit:request` kind `resource` in cad/events.ts. The radio and flash
 * payloads are shared (`RadioLinePayload`, `FlashPayload` in units/types.ts); the session bridges them to the radio and HUD.
 * Phase 7: `fleet:*` in fleet/events.ts (damage, incident, charge, service, inspection, shiftEnd, flash), `conduct:points`
 * in conduct/events.ts, `player:mode` mode `remote` (the camera drone) in player/events.ts. The session bridges
 * `fleet:charge` to the conduct points request, `fleet:flash` and `conduct:points` to the HUD flash line and
 * `station:loadout` (vest) to the officer's gear; the presenter opens the shift summary on `fleet:shiftEnd`.
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
