import { observedVehicle } from '../records/vehicle';
import { REGISTRY_POPULATION } from '../traffic/registry';
import { isFleetVehicleId } from '../traffic/trafficSystem';
import { CAREER_LIST_MAX } from '../ui/mdt/career';
import { requestableTypes } from '../units';
import { formatStamp } from '../records/calendar';
import type { RemoteUnit } from '../ui/hud/types';
import type { MdtCareerSummaryLine, MdtCaseRow, MdtDeps, MdtEtaRow, PremiseView } from '../ui/mdt/types';
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
  /** Phase 8: the co-op teammates drawn on the MDT map. */
  remoteUnits?(): readonly RemoteUnit[];
}

/** Display name of a person id ("Jordan Reyes"), '' when unknown. */
function personName(session: GameSession, id: number): string {
  if (id < 0) return '';
  const p = session.records.person(id);
  return `${p.first} ${p.last}`.trim();
}

const CASE_NAMES_MAX = 3;

function namesOf(session: GameSession, ids: readonly number[]): string {
  if (ids.length === 0) return 'none known';
  const shown = ids.slice(0, CASE_NAMES_MAX).map((id) => personName(session, id));
  return ids.length > CASE_NAMES_MAX ? `${shown.join(', ')} +${String(ids.length - CASE_NAMES_MAX)}` : shown.join(', ');
}

/** The Phase 8 feeds of the MDT: premise history, the case register and the career summary lines. */
function phase8Deps(session: GameSession, hooks: MdtHooks): Pick<MdtDeps, 'premise' | 'cases' | 'careerSummary' | 'remoteUnits'> {
  const world = session.phase8.world;
  let flagsRev = -1;
  let flagsFor = '';
  let flags: readonly string[] = [];
  let caseRev = -1;
  let rows: readonly MdtCaseRow[] = [];
  return {
    premise: (callId): PremiseView | null => {
      const call = session.cad.call(callId);
      if (!call) return null;
      const address = call.location.text;
      if (flagsRev !== world.revision || flagsFor !== address) {
        flagsRev = world.revision;
        flagsFor = address;
        flags = world.premiseFlags(address);
      }
      const entries = world
        .premiseHistory(address)
        .slice()
        .reverse()
        .map((e) => ({ when: formatStamp(e.game), text: `${e.callNumber} ${e.nature}: ${e.disposition}` }));
      return { address, flags, entries };
    },
    cases: {
      revision: () => world.revision,
      rows: () => {
        if (caseRev === world.revision) return rows;
        caseRev = world.revision;
        rows = world.cases().map((c): MdtCaseRow => ({
          id: c.id,
          status: c.status,
          nature: c.nature,
          opened: formatStamp(c.openedGame),
          location: c.locationText,
          suspects: namesOf(session, c.suspects),
          witnesses: namesOf(session, c.witnesses),
        }));
        return rows;
      },
    },
    careerSummary: (): readonly MdtCareerSummaryLine[] => {
      const v = session.phase8.career.view;
      const w = v.wellbeing;
      const pct = (x: number): string => `${String(Math.round(x * 100))} %`;
      return [
        { label: 'Stage', text: `${v.stage}, ${v.rank}${v.assignment === 'patrol' ? '' : `, ${v.assignment}`}` },
        { label: 'Shift', text: v.shift.onDuty ? `shift ${String(v.shift.shiftNo)}, ${v.slot.slot} / ${v.slot.beat}` : 'off duty' },
        { label: 'Wellbeing', text: `fatigue ${pct(w.fatigue)}, stress ${pct(w.stress)}, health ${pct(w.health)}` },
        { label: 'Money', text: `$${String(Math.round(v.money))}` },
      ];
    },
    ...(hooks.remoteUnits ? { remoteUnits: () => hooks.remoteUnits?.() ?? [] } : {}),
  };
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
    prisoner: (preferId) => session.prisoner(preferId),
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
    ...phase8Deps(session, hooks),
  };
}
