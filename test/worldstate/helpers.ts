import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { createRng } from '../../src/core/rng';
import {
  WorldState, type ClosedCallInfo, type OffenderRecord, type WorldConfig, type WorldRequest, type WorldStateSave,
} from '../../src/worldstate';

export const DAY = 86400;
export const T0 = 1000 * DAY;

export interface Rig {
  bus: EventBus<EventMap>;
  world: WorldState;
  /** Recorded `world:*` events as [topic, payload]. */
  events: [string, unknown][];
}

/** A world with custom deps (config / base crime). */
export function customWorld(deps: { config?: WorldConfig; baseCrime?: Record<string, number> }, seed = 5): WorldState {
  return new WorldState({ bus: new EventBus<EventMap>(), rng: createRng(seed).stream('worldstate'), ...deps });
}

export function rig(seed = 7, save?: WorldStateSave): Rig {
  const bus = new EventBus<EventMap>();
  const events: [string, unknown][] = [];
  bus.on('world:recidivist', (p) => events.push(['world:recidivist', p]));
  bus.on('world:case', (p) => events.push(['world:case', p]));
  bus.on('world:flash', (p) => events.push(['world:flash', p]));
  const world = new WorldState({ bus, rng: createRng(seed).stream('worldstate') }, save);
  return { bus, world, events };
}

/** Queues requests and runs one fixed step. */
export function run(r: Rig, ...reqs: WorldRequest[]): void {
  for (const q of reqs) r.world.request(q);
  r.world.step(1 / 60, { sim: 0, game: 0 });
}

export function call(over: Partial<ClosedCallInfo> = {}): ClosedCallInfo {
  return {
    callId: 1, number: 'C-0001', typeId: 'burglaryAlarm', nature: 'Burglary alarm', category: 'burglary', x: 10, z: 20, edge: 3,
    text: '1240 N Oak Street', district: 'downtown', disposition: 'report', flags: [], persons: [], game: T0, ...over,
  };
}

export function offender(over: Partial<OffenderRecord> = {}): OffenderRecord {
  return {
    personId: 1, arrests: 1, lastArrestGame: 0, custody: 'released', releaseGame: 0, risk: 0.5, district: 'downtown',
    lastCallNumber: 'C-0001', x: 0, z: 0, juvenile: false, offenseClass: 'felony', convicted: true, ...over,
  };
}

/** Draws from a fixed list (then 0.99), counting calls. */
export function scripted(values: number[]): { draw: () => number; calls: () => number } {
  let i = 0;
  return { draw: () => values[i++] ?? 0.99, calls: () => i };
}
