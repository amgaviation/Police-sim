import { observedVehicle } from '../records/vehicle';
import { REGISTRY_POPULATION } from '../traffic/registry';
import { isFleetVehicleId } from '../traffic/trafficSystem';
import type { MdtDeps } from '../ui/mdt/types';
import type { GameSession } from './session';
import type { TargetInfo } from './target';

/** App-side hooks of the MDT: the reticle target and what happens after a booking released a prisoner. */
export interface MdtHooks {
  target(): TargetInfo | null;
  /** A booking was completed; `released` is the person let out of the cage (-1 none). */
  bookingCompleted(bookingId: string, released: number): void;
}

/**
 * What the MDT reads from the session (design §13.2). CAD changes go through `request` (queued for the
 * dispatcher's next fixed step); records queries and documents act at once; completing a booking
 * releases the prisoner from the patrol car's cage.
 */
export function createMdtDeps(session: GameSession, hooks: MdtHooks): MdtDeps {
  const callsign = session.dispatcher.playerCallsign;
  return {
    cad: session.cad,
    records: session.records,
    graph: session.city.graph,
    callsign,
    officer: () => session.officer,
    now: () => session.now(),
    request: (r) => session.dispatcher.request(callsign, r, 'mdt'),
    target: () => {
      const t = hooks.target();
      return t ? { vehicleId: t.vehicleId, plate: t.plate, description: t.description } : null;
    },
    observed: (id) => (id >= 0 && id < REGISTRY_POPULATION && !isFleetVehicleId(id) ? observedVehicle(session.seed, id) : null),
    observedViolations: (id) => session.observedViolations(id),
    observedSpeed: (id) => session.observedSpeed(id),
    prisoner: () => session.prisoner(),
    atStation: () => session.atStation(),
    completeBooking: (id) => {
      const doc = session.cad.docs.get(id);
      hooks.bookingCompleted(id, session.releasePrisoner(doc?.kind === 'booking' ? doc.personId : -1));
    },
    defaultDisposition: (callId) => session.dispatcher.defaultDisposition(callId),
    plateRun: (vehicleId, readback) => session.bus.emit('dispatch:plateResult', { callsign, via: 'mdt', vehicleId, readback }),
  };
}
