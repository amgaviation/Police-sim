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
  /** Phase 5: the Career tab's REVIEW on an IA case (the app opens the evidence review with the statement footer). */
  openIa?(caseId: string): void;
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
    // Phase 5 (design 12.1): career, community and the report statements checklist.
    career: {
      revision: () => session.conduct.revision * 4096 + session.court.revision,
      view: () => session.conduct.career,
      cases: () => session.court.cases(),
      canAttend: (id) => session.court.canAttend(id, session.env.time.totalSeconds),
      attend: (id) => session.court.request({ kind: 'attend', caseId: id }),
      openIa: (id) => hooks.openIa?.(id),
      jurisdiction: () => ({ id: session.incidents.ruleset.id, name: session.incidents.ruleset.name }),
      now: () => session.now(),
    },
    community: { revision: () => session.conduct.revision, rows: () => session.conduct.trustRows() },
    // The hidden truth, key, person and event of a choice never reach the UI.
    reportChoices: (callId) => session.incidents.reportChoices(session.incidents.keyOfCall(callId)).map((c) => ({ id: c.id, group: c.group, text: c.text })),
    submitReport: (docId, callId, ids) => void session.phase5.submitReport(docId, callId, ids),
    reportGrade: (docId) => session.conduct.reportGrade(docId),
  };
}
