import { CadState, type NewCall } from '../../src/cad/cadState';
import type { CadTime, CadLocation, Priority } from '../../src/cad/types';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import '../../src/cad/events';

export const CAD_TOPICS = [
  'cad:callCreated', 'cad:callUpdated', 'cad:callClosed', 'cad:unitAssigned', 'cad:unitStatus', 'cad:documentSaved', 'cad:trafficStop',
] as const;
export type CadTopic = (typeof CAD_TOPICS)[number];

export interface Recorded {
  readonly topic: CadTopic;
  readonly payload: unknown;
}

/** A CadState on a private bus that records every cad:* event in order. */
export function recordingCad(): { cad: CadState; bus: EventBus<EventMap>; events: Recorded[] } {
  const bus = new EventBus<EventMap>((topic, error) => {
    throw new Error(`${topic}: ${String(error)}`);
  });
  const events: Recorded[] = [];
  for (const topic of CAD_TOPICS) bus.on(topic, (payload) => events.push({ topic, payload }));
  return { cad: new CadState(bus), bus, events };
}

export function at(sim: number): CadTime {
  return { sim, game: 50400 + sim * 30 };
}

export const LOCATION: CadLocation = {
  x: 10, z: -250, edge: 3, text: '248 N Oak Street', street: 'Oak Street', cross: '2nd Street',
  near: '200 block of N Oak Street', district: 'Suburbs',
};

export function newCall(typeId = 'trafficHazard', priority: Priority = 3, narrative = 'RP reports debris.'): NewCall {
  return {
    typeId,
    priority,
    location: LOCATION,
    caller: { kind: 'citizen', name: 'Jane Roe', phone: '555-0100', personId: 77 },
    narrative,
  };
}

export function addRoster(cad: CadState): void {
  cad.addUnit({ callsign: '12', kind: 'player', officer: 'Officer Doe', beat: 'downtown', fleetIndex: -1 }, at(0));
  cad.addUnit({ callsign: '21', kind: 'ai', officer: 'Officer Reyes', beat: 'downtown', fleetIndex: 0 }, at(0));
  cad.addUnit({ callsign: '23', kind: 'ai', officer: 'Officer Park', beat: 'suburbs', fleetIndex: 1 }, at(0));
}
