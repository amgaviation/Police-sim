import type { CadState } from '../cad/cadState';
import { callNumber } from '../cad/cadState';
import { ConductState, type ConductSave, newConductSave } from '../conduct';
import type { ContactManager } from '../contact';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import { CourtState, emptyCourtSave, type CourtSave } from '../court';
import type { Dispatcher } from '../dispatch/dispatcher';
import type { Environment } from '../environment/environment';
import { defaultForceSave, ForceSystem, FORCE_CONFIG, type FellowOfficer, type ForceOfficer, type ForceSave } from '../force';
import { isOpenAt, hourOf, type InteriorSystem } from '../indoors';
import { IncidentSystem, emptyIncidentsSave, type DashProbe, type IncidentPorts, type IncidentsSave, type OfficerProbe, type PursuitProbe } from '../incidents';
import type { ActorInfo } from '../npc/types';
import type { InvestigationSystem } from '../investigation';
import { roomAt } from '../interior/nav';
import type { NpcSystem } from '../npc';
import { itemDef } from '../people/items';
import type { Population } from '../people/population';
import type { RadioSystem } from '../radio/radioSystem';
import { displayName } from '../records/person';
import type { RecordsDb } from '../records/db';
import type { SceneDirector } from '../scene';
import type { StationState } from '../station';
import type { TacticalSystem } from '../tactical';

/** Everything the Phase 5 systems read of the rest of the session (the session fills it; all calls are pure reads). */
export interface Phase5Host {
  readonly seed: number;
  readonly rng: Rng;
  readonly bus: EventBus<EventMap>;
  readonly cad: CadState;
  readonly dispatcher: Dispatcher;
  readonly scene: SceneDirector;
  readonly npc: NpcSystem;
  readonly people: Population;
  readonly records: RecordsDb;
  readonly investigation: InvestigationSystem;
  readonly station: StationState;
  readonly interiors: InteriorSystem;
  readonly tactical: TacticalSystem;
  readonly contact: ContactManager;
  readonly env: Environment;
  readonly radio: RadioSystem;
  /** Sim seconds now. */
  simNow(): number;
  /** Violation kinds a traffic vehicle was seen committing (counts by kind). */
  observedViolations(vehicleId: number): Readonly<Partial<Record<string, number>>>;
  /** Fills the officer as the force system sees them. */
  forceOfficer(out: ForceOfficer): ForceOfficer;
  /** Fills the officer for the incident recorder. */
  officerProbe(out: OfficerProbe): void;
  dashProbe(out: DashProbe): void;
  pursuitProbe(out: PursuitProbe): boolean;
}

/** The HUD legal line: the latest force verdict, flash or court message, kept for `LEGAL_LINE_S` sim seconds. */
export interface LegalLine {
  text: string;
  severity: 'ok' | 'warn' | 'bad';
  untilSim: number;
}

/** A force flash does not replace a verdict line younger than this (sim s). */
const VERDICT_HOLD_S = 2;
/** Seconds a legal line stays on the HUD. */
export const LEGAL_LINE_S = 6;

const scratchPartner: FellowOfficer[] = [{ name: 'Partner', x: 0, z: 0, building: -1 }];
const NO_FELLOWS: readonly FellowOfficer[] = [];

/** Severity of a force verdict text ("... within policy / questionable / excessive"). */
export function severityOf(text: string): LegalLine['severity'] {
  if (/excessive|unlawful|violation/i.test(text)) return 'bad';
  if (/questionable|warning|not recording|terminate/i.test(text)) return 'warn';
  return 'ok';
}

/**
 * The Phase 5 systems of one session (design 20): the force system, the incident recorder, conduct and the court,
 * their ports over the Phase 2-4 objects and the cross-system bridges of design 14.
 */
export class Phase5 {
  readonly force: ForceSystem;
  readonly incidents: IncidentSystem;
  readonly conduct: ConductState;
  readonly court: CourtState;
  /** HUD legal line (read by the HUD feed). */
  readonly legal: LegalLine = { text: '', severity: 'ok', untilSim: 0 };
  /** Bumps when the legal line changes. */
  legalRevision = 0;
  /** Sim second of the last force verdict on the legal line (a TASER flash does not replace it at once). */
  private verdictSim = -Infinity;
  private readonly host: Phase5Host;
  private readonly offs: (() => void)[] = [];
  private lastRetainMinute = -1;
  private readonly forceOfficerScratch: ForceOfficer = { x: 0, z: 0, yaw: 0, building: -1, onFoot: true, moving: false, crouched: false, callId: 0 };
  private readonly dummyTarget = { kind: 'actor' as const, actorId: 0 };

  constructor(host: Phase5Host, jurisdiction = 'generic') {
    this.host = host;
    const { bus, rng } = host;
    this.force = new ForceSystem({
      seed: host.seed,
      bus,
      rng: rng.stream('force'),
      npc: host.npc,
      people: host.people,
      scene: host.scene,
      armoryHas: (item) => host.station.armory.has(item),
      temperatureC: () => host.env.weather.temperatureC,
      elevatedAt: (building, x, z) => this.elevatedAt(building, x, z),
      fellows: () => this.fellows(),
    });
    this.incidents = new IncidentSystem({
      bus,
      ports: this.incidentPorts(),
      seed: host.seed,
      callsign: host.dispatcher.playerCallsign,
      jurisdiction,
    });
    this.conduct = new ConductState({
      bus,
      rng: rng.stream('conduct'),
      incidents: this.incidents,
      districtOf: (key) => this.incidents.log(key)?.district ?? '',
      injuryOf: (personId) => (personId < 0 ? 0 : host.people.state(personId).injured),
    });
    this.court = new CourtState({
      bus,
      rng: rng.stream('court'),
      seed: host.seed,
      incidents: this.incidents,
      ruleset: () => this.incidents.ruleset,
      reportGrade: (key) => this.reportScore(key),
    });
    this.wireBridges();
  }

  // --- Fixed steps (orders -685, -660, -658, -656) ----------------------------------------------

  stepForce(dt: number, t: { sim: number; game: number }): void {
    this.force.step(dt, t, this.host.forceOfficer(this.forceOfficerScratch));
  }

  stepIncidents(dt: number, t: { sim: number; game: number }): void {
    this.incidents.step(dt, t);
  }

  stepConduct(dt: number, t: { sim: number; game: number }): void {
    this.conduct.step(dt, t);
  }

  stepCourt(dt: number, t: { sim: number; game: number }): void {
    this.court.step(dt, t);
    // Once per game minute: logs nothing references may go (the minute is anchored at the first step, also after a load).
    const minute = Math.floor(t.game / 60);
    if (this.lastRetainMinute < 0) this.lastRetainMinute = minute;
    else if (minute !== this.lastRetainMinute) {
      this.lastRetainMinute = minute;
      this.incidents.retain(this.keysInUse(), t.game);
    }
  }

  /** Incident keys conduct (IA cases, commendations, report grades) and the court still reference. */
  keysInUse(): Set<string> {
    const keep = new Set<string>();
    const career = this.conduct.career;
    for (const c of career.ia) keep.add(c.key);
    for (const c of career.commendations) keep.add(c.key);
    for (const r of career.reports) keep.add(r.key);
    for (const c of this.court.cases()) if (c.key !== '') keep.add(c.key);
    return keep;
  }

  // --- Requests of the UI -----------------------------------------------------------------------

  /** MDT report submit: the recorder keeps the assertions in the log, conduct grades them. */
  submitReport(docId: string, callId: number, assertions: readonly string[]): boolean {
    const key = this.incidents.keyOfCall(callId);
    if (key === '') return false;
    this.incidents.request({ kind: 'report', key, docId, assertions });
    this.conduct.request({ kind: 'report', key, docId, assertions });
    return true;
  }

  /** Jurisdiction pick (main menu, console). */
  setJurisdiction(id: string): void {
    this.incidents.request({ kind: 'jurisdiction', id });
  }

  // --- Save -------------------------------------------------------------------------------------

  serialize(): { force: ForceSave; incidents: IncidentsSave; conduct: ConductSave; court: CourtSave } {
    return { force: this.force.serialize(), incidents: this.incidents.serialize(), conduct: this.conduct.serialize(), court: this.court.serialize() };
  }

  /** Load order (design 16): force, incidents, conduct, court. */
  restore(save: { force: ForceSave; incidents: IncidentsSave; conduct: ConductSave; court: CourtSave }): void {
    this.force.restore(save.force);
    this.incidents.restore(save.incidents);
    this.incidents.followCall(this.host.cad.unit(this.host.dispatcher.playerCallsign)?.callId ?? 0);
    this.conduct.restore(save.conduct);
    this.court.restore(save.court);
    this.lastRetainMinute = -1;
    this.legal.text = '';
    this.legalRevision++;
  }

  /** A fresh game's blocks (what `migrateV6ToV7` writes). */
  static freshSave(rng: (name: string) => ReturnType<Rng['state']>, jurisdiction = 'generic'): { force: ForceSave; incidents: IncidentsSave; conduct: ConductSave; court: CourtSave } {
    return {
      force: defaultForceSave(rng('force')),
      incidents: emptyIncidentsSave(jurisdiction),
      conduct: newConductSave(rng('conduct')),
      court: emptyCourtSave(rng('court')),
    };
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.incidents.dispose();
    this.force.dispose();
  }

  // --- Legal line -------------------------------------------------------------------------------

  /** Shows `text` on the HUD legal line. */
  flash(text: string, severity?: LegalLine['severity']): void {
    this.legal.text = text;
    this.legal.severity = severity ?? severityOf(text);
    this.legal.untilSim = this.host.simNow() + LEGAL_LINE_S;
    this.legalRevision++;
  }

  // --- Ports ------------------------------------------------------------------------------------

  private reportScore(key: string): number | null {
    const reports = this.conduct.career.reports;
    for (let i = reports.length - 1; i >= 0; i--) {
      const r = reports[i];
      if (r && r.key === key) return r.score;
    }
    return null;
  }

  private elevatedAt(building: number, x: number, z: number): boolean {
    if (building < 0) return false;
    const layout = this.host.interiors.layout(building);
    if (!layout) return false;
    const room = roomAt(layout, x, z);
    const kind = layout.rooms[room]?.kind;
    return kind !== undefined && FORCE_CONFIG.risk.elevatedRoomKinds.includes(kind);
  }

  private fellows(): readonly FellowOfficer[] {
    const p = this.host.tactical.partner;
    if (p.mode === 'away') return NO_FELLOWS;
    const f = scratchPartner[0] as FellowOfficer;
    f.x = p.x;
    f.z = p.z;
    f.building = p.building;
    return scratchPartner;
  }

  private incidentPorts(): IncidentPorts {
    const h = this.host;
    return {
      callInfo: (callId) => {
        const call = h.cad.call(callId);
        if (!call) return null;
        const ctx = h.scene.callContext(callId);
        const rt = h.scene.runtime(callId);
        const sc = rt?.scenario;
        const suspects: number[] = [];
        let armed = false;
        if (sc) {
          for (const p of sc.participants) {
            if (p.personId < 0 || (p.role !== 'suspect' && p.role !== 'subject')) continue;
            suspects.push(p.personId);
            if (p.weapon !== null) armed = true;
          }
        }
        return {
          typeId: call.typeId,
          family: ctx?.family ?? sc?.family ?? '',
          exigency: ctx?.exigency ?? false,
          warrant: ctx?.warrant ?? false,
          suspects,
          weaponReported: (armed && !(sc?.errors.missingWeapon ?? false)) || sc?.family === 'weapons',
          district: call.location.district,
        };
      },
      personLabel: (personId) => {
        if (personId < 0) return 'Unknown';
        const id = h.people.identity(personId);
        const decade = Math.floor(id.age / 10) * 10;
        return `${id.record.sex === 'F' ? 'Female' : 'Male'}, about ${decade + 5}`;
      },
      personRole: (personId, callId) => {
        const info = h.scene.resolveIncident(personId, this.dummyTarget);
        if (info && (callId === 0 || info.callId === callId)) return info.role;
        const actor = h.npc.actorOfPerson(personId);
        if (actor <= 0) return '';
        return h.npc.actor(actor, scratchActorInfo)?.role ?? '';
      },
      stopDriver: () => {
        const stop = h.cad.trafficStop;
        if (!stop || stop.outcome !== 'active') return null;
        return { personId: stop.trueDriverId, vehicleId: stop.vehicleId, callId: stop.callId };
      },
      observedViolations: (vehicleId) => h.observedViolations(vehicleId),
      itemInfo: (itemId) => {
        const it = h.investigation.store.item(itemId);
        if (!it) return null;
        const def = itemDef(it.item);
        return {
          ref: it.id,
          item: it.item,
          label: it.label,
          category: def.category,
          weapon: def.weapon,
          incriminating: it.incriminating,
          ownerPersonId: it.ownerPersonId,
          buildingId: it.buildingId,
        };
      },
      booking: (docId) => {
        const doc = h.cad.docs.get(docId);
        if (doc?.kind !== 'booking') return null;
        return { personId: doc.personId, callId: doc.callId ?? 0, charges: [...doc.charges] };
      },
      buildingIncident: (buildingId) => h.scene.callOfBuilding(buildingId),
      publicPlace: (buildingId) => {
        const layout = h.interiors.layout(buildingId);
        if (!layout) return false;
        return layout.kind === 'policeStation' || (!layout.residential && isOpenAt(layout.occupants.openHours, hourOf(h.env.time.totalSeconds)));
      },
      officer: (out) => h.officerProbe(out),
      bodycamWorn: () => h.station.loadout.bodycamMount !== 'none',
      dashcam: (out) => h.dashProbe(out),
      pursuitProbe: (out) => h.pursuitProbe(out),
      activeContactIncident: () => {
        const inc = h.contact.activeIncident();
        return inc === null || inc === '' ? null : inc;
      },
    };
  }

  // --- Bridges (design 14) ----------------------------------------------------------------------

  private wireBridges(): void {
    const h = this.host;
    const bus = h.bus;
    const radio = (text: string, speaker?: string): void => h.radio.say('dispatch', text, speaker);
    this.offs.push(
      bus.on('incident:closed', (e) => {
        this.conduct.request({ kind: 'incidentClosed', key: e.key, aggressiveLines: this.incidents.aggressiveLines(e.key) });
      }),
      bus.on('cad:documentSaved', (e) => {
        if (!e.final || (e.kind !== 'booking' && e.kind !== 'citation')) return;
        const doc = h.cad.docs.get(e.id);
        if (doc?.kind !== 'booking' && doc?.kind !== 'citation') return;
        if (doc.personId < 0) return;
        const statutes = doc.kind === 'booking' ? [...doc.charges] : doc.violations.map((v) => v.statuteId);
        this.court.request({
          kind: 'open',
          docId: doc.id,
          docKind: doc.kind,
          personId: doc.personId,
          personLabel: displayName(h.records.person(doc.personId)),
          callId: doc.callId ?? 0,
          statutes,
        });
      }),
      bus.on('court:verdict', (e) => {
        this.conduct.request({
          kind: 'verdict',
          key: e.key,
          caseId: e.caseId,
          verdict: e.verdict,
          reason: e.reason,
          credibilityDelta: e.credibilityDelta,
          impeached: e.impeached,
          missed: e.missed,
        });
      }),
      bus.on('conduct:status', (e) => {
        const status = e.status === 'active' ? 'available' : 'outOfService';
        h.dispatcher.request(h.dispatcher.playerCallsign, { kind: 'status', status }, 'auto');
        this.flash(e.status === 'active' ? 'Reinstated: back on duty' : `Duty status: ${e.status}${e.reason === '' ? '' : ` (${e.reason})`}`, e.status === 'active' ? 'ok' : 'bad');
      }),
      bus.on('incident:advisory', (e) => {
        radio(e.text, 'Supervisor');
        this.flash(e.text, 'warn');
      }),
      bus.on('incident:forceVerdict', (e) => {
        this.flash(e.text, e.verdict === 'justified' ? 'ok' : e.verdict === 'questionable' ? 'warn' : 'bad');
        this.verdictSim = h.simNow();
      }),
      bus.on('incident:flash', (e) => this.flash(e.text)),
      bus.on('force:flash', (e) => {
        if (h.simNow() - this.verdictSim > VERDICT_HOLD_S) this.flash(e.text, 'warn');
      }),
      bus.on('court:flash', (e) => this.flash(e.text, 'warn')),
      bus.on('court:subpoena', (e) => radio(`Subpoena received: ${e.label}. Check the Career tab for the date.`)),
      bus.on('court:reminder', () => radio('Court reminder: you are due to testify today.')),
      bus.on('conduct:ia', (e) => {
        radio(`Internal Affairs notice ${e.caseId}: ${e.reasons.join(', ')}. Review the incident from the Career tab.`);
        this.flash(`IA case ${e.caseId} opened`, 'bad');
      }),
      bus.on('conduct:iaResolved', (e) => {
        radio(`Internal Affairs ${e.caseId}: ${e.finding}${e.discipline.length > 0 ? ` (${e.discipline.join(', ')})` : ''}.`);
      }),
      bus.on('conduct:commendation', (e) => this.flash(`Commendation: ${e.label}`, 'ok')),
    );
  }
}

const scratchActorInfo: ActorInfo = {
  id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false,
  following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
};

/** Incident key shown for a call (CAD number). */
export function incidentKeyOfCall(callId: number): string {
  return callNumber(callId);
}
