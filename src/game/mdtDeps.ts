import { observedVehicle } from '../records/vehicle';
import { REGISTRY_POPULATION } from '../traffic/registry';
import { isFleetVehicleId } from '../traffic/trafficSystem';
import { CAREER_LIST_MAX } from '../ui/mdt/career';
import { requestableTypes } from '../units';
import type { MdtDeps, MdtEtaRow } from '../ui/mdt/types';
import type { GameSession } from './session';
import type { TargetInfo } from './target';

/** App-side hooks of the MDT: the reticle target and what happens after a booking released a prisoner. */
export interface MdtHooks {
  target(): TargetInfo | null;
  /** A booking was completed; `released` is the person let out of the cage (-1 none). */
  bookingCompleted(bookingId: string, released: number): void;
  /** Phase 5: the Career tab's REVIEW on an IA case (the app opens the evidence review with the statement footer). */
  openIa?(caseId: string): void;
  /** Phase 5: the Career tab's REVIEW on a recorded incident (read-only evidence review). */
  openReview?(key: string): void;
  /** Phase 6: the presentation-only ETA board of the Resources tab (the worker's `eta.matrix`); empty without a worker. */
  etaBoard?(callId: number): Promise<readonly MdtEtaRow[]>;
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
      revision: () => session.conduct.revision * 4096 + session.court.revision + session.incidents.revision * 16_777_216 + session.fleet.revision * 3,
      view: () => session.conduct.career,
      cases: () => session.court.cases(),
      canAttend: (id) => session.court.canAttend(id, session.env.time.totalSeconds),
      attend: (id) => session.court.request({ kind: 'attend', caseId: id }),
      openIa: (id) => hooks.openIa?.(id),
      incidents: () =>
        session.incidents.keys().slice(0, CAREER_LIST_MAX).flatMap((key) => {
          const l = session.incidents.log(key);
          return l ? [{ key, typeId: l.typeId, district: l.district, game: l.openedGame, closed: l.closed }] : [];
        }),
      canReview: (key) => session.incidents.log(key) !== null,
      openReview: (key) => hooks.openReview?.(key),
      jurisdiction: () => ({ id: session.incidents.ruleset.id, name: session.incidents.ruleset.name }),
      now: () => session.now(),
    },
    reportHeader: () => session.phase7.reportHeader(),
    // Phase 7: the fleet's damage charges and the shift's unreported damage on the Career tab.
    fleet: {
      summary: () => ({
        points: session.fleet.ledger.officerPoints,
        departmentCost: session.fleet.ledger.departmentCost,
        incidents: session.fleet.incidents().length,
        unreported: session.fleet.openReports(),
      }),
      charges: () => session.fleet.ledger.entries(),
    },
    community: { revision: () => session.conduct.revision, rows: () => session.conduct.trustRows() },
    // The hidden truth, key, person and event of a choice never reach the UI.
    reportChoices: (callId) => session.incidents.reportChoices(session.incidents.keyOfCall(callId)).map((c) => ({ id: c.id, group: c.group, text: c.text })),
    submitReport: (docId, callId, ids) => void session.phase5.submitReport(docId, callId, ids),
    reportGrade: (docId) => session.conduct.reportGrade(docId),
    // Phase 6 (design 12.3): live ETAs, the Resources tab (request any unit type) and the Command tab (ICS board).
    eta: (cs) => session.phase6.resources.eta(cs),
    resources: {
      revision: () => session.phase6.resources.revision,
      units: () => session.phase6.resources.units(),
      types: () => requestableTypes().map((t) => ({ id: t.id, label: t.label, resolves: t.resolves, send: t.send })),
      request: (typeId) => void session.phase6.requestType(typeId, 'mdt'),
      ...(hooks.etaBoard ? { etaBoard: (callId: number) => hooks.etaBoard?.(callId) ?? Promise.resolve([]) } : {}),
    },
    command: {
      revision: () => session.phase6.command.revision,
      board: () => session.phase6.command.board(),
      request: (r) => session.phase6.command.request(r),
    },
  };
}
