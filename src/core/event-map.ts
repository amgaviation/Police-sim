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
