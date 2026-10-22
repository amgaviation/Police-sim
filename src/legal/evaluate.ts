import { forceVerdict } from './force';
import { evaluatePursuit } from './pursuit';
import { IndicatorBook } from './scores';
import {
  CAM,
  OFFENSES,
  type AdvisoryEvent,
  type ArrestEvent,
  type ConsentEvent,
  type ConsentKind,
  type DetentionEvent,
  type Determination,
  type Doctrine,
  type EntryEvent,
  type EvidenceRuling,
  type ForceEvent,
  type ForceRuling,
  type FoundItem,
  type FriskEvent,
  type IncidentEvent,
  type IncidentLog,
  type IndicatorEvent,
  type InterveneEvent,
  type LegalAssessment,
  type MirandaEvent,
  type Offense,
  type Outcome,
  type OtherForceEvent,
  type PersonAssessment,
  type PursuitEndEvent,
  type PursuitRuling,
  type PursuitSampleEvent,
  type PursuitStartEvent,
  type QuestionEvent,
  type Ruleset,
  type SearchEvent,
  type SeizureEvent,
  type StatementEvent,
  type TestEvent,
} from './types';

/**
 * Evaluates an incident log against a ruleset (design §5.8): one deterministic pass over the events, no randomness,
 * no module-level mutable state. Rule ids on every determination come from the ruleset.
 */

const ITEM_OFFENSE: Readonly<Record<string, Offense>> = {
  weapon: 'weapons', drugs: 'drugs', paraphernalia: 'drugs', property: 'property',
};
const STATEMENT_OFFENSE: Readonly<Record<string, Offense>> = { drinking: 'dui', drugs: 'drugs', weapons: 'weapons' };
const BASIS_TEXT: Readonly<Record<string, string>> = {
  consent: 'with consent', incidentToArrest: 'incident to arrest', automobile: 'under the automobile exception',
  exigency: 'in exigent circumstances', warrant: 'under a warrant', protectiveSweep: 'as a protective sweep',
  plainView: 'in plain view', publicArea: 'in a public area',
};
const SEARCH_CONSENTS: readonly ConsentKind[] = ['searchPerson', 'searchVehicle', 'searchPremises', 'searchRoom'];
/** Consents that let the officer enter a building (the game accepts any of them for lawful presence). */
const ENTRY_CONSENTS: readonly ConsentKind[] = ['entry', 'searchPremises', 'searchRoom'];
/** Roles that are never a suspect: a complied command to them is a consensual encounter, not a detention. */
const CONSENSUAL_ROLES: ReadonlySet<string> = new Set([
  'victim', 'witness', 'caller', 'reporter', 'reportingParty', 'bystander', 'staff', 'resident', 'owner',
]);
/** Consecutive other-officer force events of one officer within this many seconds form one episode. */
const EPISODE_GAP_S = 10;

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

interface ArrestRec { eventId: number; personId: number; t: number; lawful: boolean; offense: Offense | null; building: number }
interface ConsentRec { event: ConsentEvent; effective: boolean; root: number }
interface QuestionRec { event: QuestionEvent; unwarned: boolean; afterInvocation: boolean }
interface PState {
  id: number;
  detained: boolean;
  detentionLawful: boolean | null;
  taintFrom: number;
  arrests: ArrestRec[];
  custodySince: number;
  miranda: 'none' | MirandaEvent['result'];
  mirandaCustody: boolean;
  questions: QuestionRec[];
  consents: ConsentRec[];
  rsAtDetention: number;
  pcAtArrest: Partial<Record<Offense, number>>;
  arrestOffense: Offense | null;
  arrestLawful: boolean | null;
  suppressedStatements: number;
}
interface Episode { det: Determination; lastT: number }
interface PursuitAcc {
  start: PursuitStartEvent; samples: PursuitSampleEvent[]; end: PursuitEndEvent | null; advisory: AdvisoryEvent | null;
}
interface Basis { basis: string; ruleIds: string[] }
interface SearchCtx { root: number; scopeMiss: boolean; vehicleFail: boolean; entryFail: boolean }

class Pass {
  private readonly log: IncidentLog;
  private readonly rs: Ruleset;
  private readonly book: IndicatorBook;
  private readonly dets: Determination[] = [];
  private readonly evidence: EvidenceRuling[] = [];
  private readonly forces: ForceRuling[] = [];
  private readonly pursuitRulings: PursuitRuling[] = [];
  private readonly taint = new Map<number, number>();
  private readonly persons = new Map<number, PState>();
  private readonly personOrder: number[] = [];
  private readonly entryTaint = new Map<number, number>();
  private readonly entryLawful = new Map<number, boolean>();
  private readonly allConsents: ConsentRec[] = [];
  private readonly allArrests: ArrestRec[] = [];
  private readonly arrestEvents: ArrestEvent[] = [];
  /** Event ids whose non-weapon found items were excluded by frisk scope (taints their `contrabandFound` indicators). */
  private readonly scopeTaint = new Map<number, number>();
  private readonly personSearchRulings = new Set<EvidenceRuling>();
  private readonly rulingRefs = new Set<string>();
  private readonly episodeOf = new Map<number, { ep: Episode; t: number }>();
  private readonly lastEpisode = new Map<string, Episode>();
  private readonly mirandaDets = new Map<string, Determination>();
  private readonly pursuits: PursuitAcc[] = [];
  private readonly recChecks: IncidentEvent[] = [];
  private readonly firstT = new Map<number, number>();
  private readonly required: ReadonlySet<string>;
  /** Building (-1 the whole call) -> sim time the exigency was last confirmed. */
  private readonly exigencyAt = new Map<number, number>();
  private warrantSearch = false;
  private warrantArrest = false;
  private readonly roleOf = new Map<number, string>();
  private currentBuilding = -1;
  private qCustodial = false;
  private count = 0;

  constructor(log: IncidentLog, rs: Ruleset) {
    this.log = log;
    this.rs = rs;
    this.book = new IndicatorBook(rs);
    this.book.setFamily(log.family);
    this.required = new Set(rs.recording.requiredFor);
    for (const person of log.people) {
      this.person(person.personId);
      this.book.setRole(person.personId, person.role);
      this.roleOf.set(person.personId, person.role);
    }
    for (const e of log.events) if (e.kind === 'arrest') this.arrestEvents.push(e);
  }

  run(): LegalAssessment {
    const events = this.log.events;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e) continue;
      if (!this.firstT.has(e.personId)) this.firstT.set(e.personId, e.t);
      this.qCustodial = false;
      this.dispatch(e);
      this.noteRecording(e);
    }
    this.finishPursuits(events.length > 0 ? (events[events.length - 1]?.t ?? this.log.openedSim) : this.log.openedSim);
    this.finishRecording();
    this.finishInevitable();
    return this.assemble();
  }

  // --- State helpers ---------------------------------------------------------------------------

  private person(id: number): PState {
    let p = this.persons.get(id);
    if (!p) {
      p = {
        id, detained: false, detentionLawful: null, taintFrom: -1, arrests: [], custodySince: -1, miranda: 'none',
        mirandaCustody: false, questions: [], consents: [], rsAtDetention: 0, pcAtArrest: {}, arrestOffense: null,
        arrestLawful: null, suppressedStatements: 0,
      };
      this.persons.set(id, p);
      if (id >= 0) this.personOrder.push(id);
    }
    return p;
  }

  private det(
    doctrine: Doctrine, e: IncidentEvent, outcome: Outcome, ruleIds: string[], reason: string, basis: string | null = null,
  ): Determination {
    const d: Determination = {
      id: `d${++this.count}`, doctrine, eventId: e.id, personId: e.personId, t: e.t, outcome, ruleIds, reason, basis, eventIds: [e.id],
    };
    this.dets.push(d);
    return d;
  }

  private hasLawfulArrest(p: PState): boolean {
    for (const a of p.arrests) if (a.lawful) return true;
    return false;
  }

  private effectiveConsent(p: PState, kind: ConsentKind): boolean {
    for (const c of p.consents) if (c.effective && c.event.consent === kind) return true;
    return false;
  }

  private custodial(p: PState, e: QuestionEvent): boolean {
    return (p.custodySince >= 0 && e.t >= p.custodySince) || e.custody || (this.rs.miranda.custodyIncludesGunpoint && e.gunpoint);
  }

  /** Adds a ruling for a found / seized item; `root` < 0 means admissible. */
  private item(eventId: number, personId: number, it: FoundItem, root: number, why: string): EvidenceRuling {
    const ev = this.rs.evidence;
    const admissible = root < 0;
    const ruling: EvidenceRuling = {
      eventId, ref: it.ref, label: it.label, personId, kind: 'item', offense: ITEM_OFFENSE[it.category] ?? null, admissible,
      ruleIds: admissible ? [] : root === eventId ? [ev.exclusionRuleId] : [ev.fruitRuleId, ev.exclusionRuleId],
      taintedBy: admissible ? -1 : root,
      reason: admissible ? 'Lawfully obtained' : why,
    };
    this.evidence.push(ruling);
    this.rulingRefs.add(it.ref);
    return ruling;
  }

  // --- Dispatch --------------------------------------------------------------------------------

  private dispatch(e: IncidentEvent): void {
    switch (e.kind) {
      case 'start': this.book.setFamily(e.family); break;
      case 'person': this.book.setRole(e.personId, e.role); this.roleOf.set(e.personId, e.role); this.person(e.personId); break;
      case 'indicator': this.indicator(e); break;
      case 'detention': this.detention(e); break;
      case 'question': this.question(e); break;
      case 'statement': this.statement(e); break;
      case 'miranda': {
        const p = this.person(e.personId);
        // An invocation stands: a later waiver is not a new, subject-initiated one (the dialogue never re-asks after an invocation).
        if (p.miranda !== 'invoked') p.miranda = e.result;
        p.mirandaCustody = e.custody;
        break;
      }
      case 'consent': this.consent(e); break;
      case 'frisk': this.frisk(e); break;
      case 'search': this.search(e); break;
      case 'seizure': this.seizure(e); break;
      case 'test': this.test(e); break;
      case 'arrest': this.arrest(e); break;
      case 'release': this.person(e.personId).custodySince = -1; break;
      case 'force': this.force(e); break;
      case 'otherForce': this.otherForce(e); break;
      case 'intervene': this.intervene(e); break;
      case 'entry': this.entry(e); break;
      case 'exigency': this.exigencyAt.set(e.buildingId !== undefined && e.buildingId >= 0 ? e.buildingId : -1, e.t); break;
      case 'warrant':
        if (e.scope === 'search') this.warrantSearch = true;
        else this.warrantArrest = true;
        break;
      case 'pursuitStart': this.pursuits.push({ start: e, samples: [], end: null, advisory: null }); break;
      case 'pursuitSample': this.openPursuit(e.personId)?.samples.push(e); break;
      case 'pursuitEnd': {
        const acc = this.openPursuit(e.personId);
        if (acc) acc.end = e;
        break;
      }
      case 'advisory':
        if (e.advisory === 'terminatePursuit') {
          const acc = this.openPursuit(e.personId);
          if (acc && !acc.advisory) acc.advisory = e;
        }
        break;
      default: break;
    }
  }

  // --- Indicators, detention ---------------------------------------------------------------------

  /** The person a shared (-1) indicator is judged against: the first driver, else the first detained person. */
  private stopSubject(): PState | null {
    let detained: PState | null = null;
    for (const id of this.personOrder) {
      const p = this.persons.get(id);
      if (!p) continue;
      if (this.roleOf.get(id) === 'driver') return p;
      if (detained === null && p.detained) detained = p;
    }
    return detained;
  }

  private indicator(e: IndicatorEvent): void {
    const p = e.personId === -1 ? (this.stopSubject() ?? this.person(-1)) : this.person(e.personId);
    let root = this.taint.get(e.sourceEvent) ?? -1;
    if (root < 0 && p.taintFrom >= 0 && e.source !== 'call' && !this.rs.detention.attenuating.includes(e.indicator)) root = p.taintFrom;
    if (root < 0 && e.indicator === 'contrabandFound') root = this.scopeTaint.get(e.sourceEvent) ?? -1;
    this.book.add(e.personId, e.indicator, e.id, e.t, root >= 0);
    if (root >= 0) this.taint.set(e.id, root);
  }

  private detention(e: DetentionEvent): void {
    const p = this.person(e.personId);
    if (e.how === 'cuffed' && p.custodySince < 0) p.custodySince = e.t;
    if (p.detained) return;
    if (e.how === 'command' && CONSENSUAL_ROLES.has(this.roleOf.get(e.personId) ?? '')) return;
    p.detained = true;
    const rs = this.rs;
    const rsSum = this.book.rs(e.personId, e.t);
    p.rsAtDetention = rsSum;
    const warrant = this.callWarrantFor(p);
    const lawful = rsSum >= rs.thresholds.rs || this.book.bestPc(e.personId, e.t, false) !== null || this.hasLawfulArrest(p) || warrant;
    p.detentionLawful = lawful;
    if (lawful) {
      const labels = this.book.indicators(e.personId, e.t).map((i) => rs.indicators[i]?.label ?? i);
      this.det('detention', e, 'lawful', [rs.detention.ruleId], `Stop supported by: ${labels.join(', ') || (warrant ? 'an outstanding warrant' : 'probable cause')}`);
    } else {
      p.taintFrom = e.id;
      this.taint.set(e.id, e.id);
      this.det('detention', e, 'unlawful', [rs.detention.ruleId], `No reasonable suspicion: ${fmt(rsSum)} of ${fmt(rs.thresholds.rs)}`);
    }
  }

  // --- Consent, frisk, search --------------------------------------------------------------------

  private consent(e: ConsentEvent): void {
    const rs = this.rs;
    const p = this.person(e.personId);
    const coerced = (rs.consent.coercedByWeaponDrawn && e.weaponDrawn) || e.aggressiveLines > rs.consent.maxAggressiveLines;
    const tainted = p.taintFrom >= 0;
    const effective = e.granted && e.valid && !coerced && !tainted;
    const rec: ConsentRec = { event: e, effective, root: e.granted && tainted ? p.taintFrom : -1 };
    p.consents.push(rec);
    this.allConsents.push(rec);
    if (!e.granted) {
      // A refusal or withdrawal revokes every earlier consent of the same kind (for the person or the same building).
      for (const c of this.allConsents) {
        const ev = c.event;
        if (c === rec || ev.consent !== e.consent || !c.effective) continue;
        if (ev.personId === e.personId || (e.buildingId >= 0 && ev.buildingId === e.buildingId)) c.effective = false;
      }
      return;
    }
    if (rec.root >= 0) this.taint.set(e.id, rec.root);
    if (!e.valid) {
      this.det('consent', e, 'unlawful', [rs.consent.ruleId], 'The consent was not valid (the person could not lawfully give it)', e.consent);
    } else if (coerced) {
      this.det('consent', e, 'unlawful', [rs.consent.coercionRuleId], 'The consent was coerced by a drawn weapon or repeated pressure', e.consent);
    } else if (tainted) {
      this.det('consent', e, 'questionable', [rs.consent.ruleId, rs.evidence.fruitRuleId], 'Consent obtained during an unlawful detention does not cure it', e.consent);
    } else {
      this.det('consent', e, 'lawful', [rs.consent.ruleId], 'Freely given consent', e.consent);
    }
  }

  private frisk(e: FriskEvent): void {
    const rs = this.rs;
    const p = this.person(e.personId);
    let basis: string | null = null;
    if (this.effectiveConsent(p, 'searchPerson')) basis = 'consent';
    else if (this.hasLawfulArrest(p)) basis = 'incidentToArrest';
    else if (p.detentionLawful === true && this.book.armed(e.personId, e.t) >= rs.thresholds.armed) basis = 'terry';

    let root = -1;
    if (basis !== null) {
      this.det('frisk', e, 'lawful', [rs.frisk.ruleId], basis === 'terry' ? 'Frisk for weapons on a lawful stop with armed indicators' : `Pat-down justified (${basis})`, basis);
    } else {
      root = p.taintFrom >= 0 ? p.taintFrom : e.id;
      this.taint.set(e.id, root);
      const reason = p.detentionLawful !== true
        ? 'A frisk requires a lawful stop, arrest or consent'
        : `Nothing indicated the person was armed (${fmt(this.book.armed(e.personId, e.t))} of ${fmt(rs.thresholds.armed)})`;
      this.det('frisk', e, 'unlawful', [rs.frisk.ruleId], reason);
    }

    for (const it of e.found) {
      let itemRoot = root;
      if (root < 0 && basis === 'terry' && !it.weapon) {
        const allowed = rs.frisk.plainFeel && rs.frisk.plainFeelCategories.includes(it.category);
        if (!allowed) {
          itemRoot = e.id;
          this.scopeTaint.set(e.id, e.id);
          this.det('friskScope', e, 'unlawful', [rs.frisk.scopeRuleId], `Frisk exceeded its scope: ${it.label} may not be seized`);
        }
      }
      const ruling = this.item(e.id, e.personId, it, itemRoot, itemRoot === root ? 'Obtained through an unlawful frisk' : 'Beyond the scope of a weapons frisk');
      this.personSearchRulings.add(ruling);
    }
  }

  private coveringKinds(target: SearchEvent['target']): readonly ConsentKind[] {
    switch (target) {
      case 'person': return ['searchPerson'];
      case 'vehicle': return ['searchVehicle'];
      case 'room':
      case 'container': return ['searchRoom', 'searchPremises'];
      default: return ['searchPremises'];
    }
  }

  private basisConsent(e: SearchEvent, ctx: SearchCtx): Basis | null {
    const kinds = this.coveringKinds(e.target);
    const building = e.target === 'premises' || e.target === 'room' || e.target === 'container';
    for (const c of this.allConsents) {
      const ev = c.event;
      if (!ev.granted) continue;
      const same = ev.personId === e.personId || (building && e.buildingId >= 0 && ev.buildingId === e.buildingId);
      if (!same) continue;
      if (kinds.includes(ev.consent)) {
        if (c.effective) return { basis: 'consent', ruleIds: [this.rs.consent.ruleId] };
        if (c.root >= 0 && ctx.root < 0) ctx.root = c.root;
      } else if (c.effective && (SEARCH_CONSENTS.includes(ev.consent) || (building && ev.consent === 'entry'))) {
        ctx.scopeMiss = true;
      }
    }
    return null;
  }

  private basisSita(e: SearchEvent, p: PState, ctx: SearchCtx): Basis | null {
    const rs = this.rs;
    const sita = rs.sita;
    if (e.target === 'person' || e.target === 'vehicle') {
      const vehicle = e.target === 'vehicle';
      for (const a of p.arrests) {
        const dt = e.t - a.t;
        if (dt < 0 || dt > sita.windowS) continue;
        if (!a.lawful) {
          if (ctx.root < 0) ctx.root = this.taint.get(a.eventId) ?? a.eventId;
          continue;
        }
        if (vehicle && sita.vehicle === 'gant' && p.custodySince >= 0 && !(a.offense !== null && rs.offenses[a.offense].vehicleEvidence)) {
          ctx.vehicleFail = true;
          continue;
        }
        return { basis: 'incidentToArrest', ruleIds: [vehicle ? sita.vehicleRuleId : sita.ruleId] };
      }
      if (sita.preArrestS > 0) {
        const best = this.book.bestPc(e.personId, e.t, true);
        if (best !== null) {
          for (const a of this.arrestEvents) {
            const dt = a.t - e.t;
            if (a.personId !== e.personId || a.id <= e.id || dt <= 0 || dt > sita.preArrestS) continue;
            if (vehicle && sita.vehicle === 'gant' && p.custodySince >= 0 && !rs.offenses[best].vehicleEvidence) {
              ctx.vehicleFail = true;
              continue;
            }
            return { basis: 'incidentToArrest', ruleIds: [vehicle ? sita.vehicleRuleId : sita.ruleId] };
          }
        }
      }
      return null;
    }
    if (e.claimedBasis === 'incidentToArrest') {
      for (const a of this.allArrests) {
        const dt = e.t - a.t;
        if (a.lawful && dt >= 0 && dt <= sita.windowS) return { basis: 'incidentToArrest', ruleIds: [sita.ruleId] };
      }
    }
    return null;
  }

  private basisAutomobile(e: SearchEvent): Basis | null {
    const rs = this.rs;
    if (e.target !== 'vehicle' || !rs.automobile.enabled) return null;
    for (const o of OFFENSES) {
      if (rs.offenses[o].vehicleEvidence && this.book.pc(e.personId, o, e.t) >= rs.thresholds.pc) {
        return { basis: 'automobile', ruleIds: [rs.automobile.ruleId] };
      }
    }
    return null;
  }

  private basisExigency(e: SearchEvent): Basis | null {
    if (e.target === 'person' || e.target === 'vehicle' || !this.exigencyActive(e.t, e.buildingId)) return null;
    return { basis: 'exigency', ruleIds: [this.rs.exigency.ruleId] };
  }

  /** The call's exigency was confirmed (for the whole call or this building) within the ruleset's window before `t`. */
  private exigencyActive(t: number, buildingId: number): boolean {
    const window = this.rs.exigency.windowS;
    for (const key of buildingId >= 0 ? [-1, buildingId] : [-1]) {
      const at = this.exigencyAt.get(key);
      if (at !== undefined && t - at <= window) return true;
    }
    return false;
  }

  /** A call-level arrest warrant covers the call's suspect or subject, and is cut off by an unlawful stop like a warrant hit. */
  private callWarrantFor(p: PState): boolean {
    if (!this.warrantArrest) return false;
    const role = this.roleOf.get(p.id);
    if (role !== 'suspect' && role !== 'subject') return false;
    return p.taintFrom < 0 || this.rs.detention.attenuating.includes('warrantHit');
  }

  private basisWarrant(e: SearchEvent): Basis | null {
    if (e.target === 'person' || e.target === 'vehicle') return null;
    return this.warrantSearch ? { basis: 'warrant', ruleIds: [this.rs.arrest.warrantRuleId] } : null;
  }

  private basisSweep(e: SearchEvent): Basis | null {
    if (e.claimedBasis !== 'protectiveSweep' || (e.target !== 'room' && e.target !== 'container') || e.buildingId < 0) return null;
    for (const a of this.allArrests) {
      if (a.lawful && a.building === e.buildingId) return { basis: 'protectiveSweep', ruleIds: [this.rs.premises.protectiveSweepRuleId] };
    }
    return null;
  }

  private basisPlainView(e: SearchEvent, ctx: SearchCtx): Basis | null {
    if (e.claimedBasis !== 'plainView' && e.claimedBasis !== 'publicArea') return null;
    // No recorded entry judgment means nothing shows the vantage point was unlawful.
    if (e.buildingId < 0 || this.entryLawful.get(e.buildingId) !== false) {
      return { basis: e.claimedBasis, ruleIds: [this.rs.premises.plainViewRuleId] };
    }
    ctx.entryFail = true;
    return null;
  }

  private search(e: SearchEvent): void {
    const rs = this.rs;
    const p = this.person(e.personId);
    const ctx: SearchCtx = { root: -1, scopeMiss: false, vehicleFail: false, entryFail: false };
    const bt = e.buildingId >= 0 ? (this.entryTaint.get(e.buildingId) ?? -1) : -1;
    const res = this.basisConsent(e, ctx) ?? this.basisSita(e, p, ctx) ?? this.basisAutomobile(e) ?? this.basisExigency(e)
      ?? this.basisWarrant(e) ?? this.basisSweep(e) ?? this.basisPlainView(e, ctx);

    let root: number;
    if (res) {
      root = bt;
      this.det('search', e, 'lawful', res.ruleIds, `Search of the ${e.target} was lawful ${BASIS_TEXT[res.basis] ?? res.basis}`, res.basis);
    } else {
      root = ctx.root >= 0 ? ctx.root : bt >= 0 ? bt : e.id;
      let reason = `No lawful basis for the search of the ${e.target}`;
      const ruleIds: string[] = [];
      if (ctx.scopeMiss) {
        ruleIds.push(rs.consent.scopeRuleId);
        reason = `Consent did not cover the ${e.target}`;
      } else if (ctx.vehicleFail) {
        ruleIds.push(rs.sita.vehicleRuleId);
        reason = 'A vehicle search incident to arrest needs an unsecured arrestee or evidence of the arrest offense';
      } else if (ctx.entryFail) {
        ruleIds.push(rs.premises.plainViewRuleId);
        reason = 'Plain view requires lawful presence; the entry was unlawful';
      }
      ruleIds.push(rs.evidence.exclusionRuleId);
      this.det('search', e, 'unlawful', ruleIds, reason);
    }
    if (root >= 0) this.taint.set(e.id, root);

    const why = root === e.id ? 'Obtained in a search without a lawful basis' : bt >= 0 && root === bt ? 'Fruit of an unlawful entry' : 'Fruit of an earlier unlawful act';
    for (const it of e.found) {
      const ruling = this.item(e.id, e.personId, it, root, why);
      if (e.target === 'person') this.personSearchRulings.add(ruling);
    }
  }

  private seizure(e: SeizureEvent): void {
    if (this.rulingRefs.has(e.item.ref)) return;
    const root = this.taint.get(e.fromEvent) ?? -1;
    this.item(e.id, e.personId, e.item, root, 'Seized as a result of an earlier unlawful act');
  }

  // --- Tests, arrest -----------------------------------------------------------------------------

  private test(e: TestEvent): void {
    const rs = this.rs;
    const p = this.person(e.personId);
    const consented = this.effectiveConsent(p, e.test);
    const implied = rs.test.impliedAfterArrest && this.hasLawfulArrest(p);
    const lawful = consented || implied;
    this.det(
      'test', e, lawful ? 'lawful' : 'unlawful', [rs.test.ruleId],
      lawful ? (consented ? 'Test given with consent' : 'Test lawful as implied consent after arrest') : `The ${e.test.toUpperCase()} requires consent or a lawful arrest first`,
      lawful ? (consented ? 'consent' : 'arrest') : null,
    );
    if (!lawful) this.taint.set(e.id, e.id);
    this.evidence.push({
      eventId: e.id, ref: `test:${e.id}`, label: `${e.test.toUpperCase()} (${e.result})`, personId: e.personId, kind: 'test', offense: 'dui',
      admissible: lawful, ruleIds: lawful ? [] : [rs.evidence.exclusionRuleId], taintedBy: lawful ? -1 : e.id,
      reason: lawful ? 'Lawfully obtained' : 'Test given without consent or a lawful arrest',
    });
  }

  private arrest(e: ArrestEvent): void {
    const rs = this.rs;
    const p = this.person(e.personId);
    if (p.custodySince < 0) p.custodySince = e.t;
    if (e.how === 'booking' && p.arrests.length > 0) return;

    const warrant = this.book.has(e.personId, 'warrantHit', e.t) || this.callWarrantFor(p);
    const best = this.book.bestPc(e.personId, e.t, true);
    const table = this.book.pcTable(e.personId, e.t);
    const lawful = warrant || best !== null;
    const offense: Offense | null = best ?? (warrant ? 'warrant' : null);
    const rec: ArrestRec = { eventId: e.id, personId: e.personId, t: e.t, lawful, offense, building: this.currentBuilding };
    p.arrests.push(rec);
    this.allArrests.push(rec);

    if (p.arrests.length === 1) {
      p.arrestLawful = lawful;
      p.arrestOffense = offense;
      OFFENSES.forEach((o, i) => {
        const v = table[i] ?? 0;
        if (v > 0) p.pcAtArrest[o] = v;
      });
    }
    if (lawful) {
      this.det(
        'arrest', e, 'lawful', [warrant ? rs.arrest.warrantRuleId : rs.arrest.ruleId],
        warrant ? 'Arrest supported by an outstanding warrant' : `Probable cause for ${rs.offenses[best as Offense].label}: ${fmt(table[OFFENSES.indexOf(best as Offense)] ?? 0)} of ${fmt(rs.thresholds.pc)}`,
        warrant ? 'warrant' : 'probableCause',
      );
      return;
    }
    this.taint.set(e.id, e.id);
    if (e.how !== 'booking' && p.taintFrom < 0) p.taintFrom = e.id;
    let top: Offense | null = null;
    let topPc = 0;
    for (let i = 0; i < OFFENSES.length; i++) {
      const v = table[i] ?? 0;
      if (v > topPc) { top = OFFENSES[i] ?? null; topPc = v; }
    }
    let reason = 'No probable cause: nothing supports an arrest';
    if (top !== null) {
      reason = topPc >= rs.thresholds.pc && !rs.offenses[top].arrestable
        ? `${rs.offenses[top].label} is not an arrestable offense under this ruleset`
        : `Probable cause for ${rs.offenses[top].label}: ${fmt(topPc)} of ${fmt(rs.thresholds.pc)}`;
    }
    this.det('arrest', e, 'unlawful', [rs.arrest.ruleId], reason);
  }

  // --- Miranda -----------------------------------------------------------------------------------

  private mirandaViolation(p: PState, e: QuestionEvent, ruleId: string, reason: string): void {
    const key = `${p.id}|${ruleId}`;
    const existing = this.mirandaDets.get(key);
    if (existing) {
      existing.eventIds.push(e.id);
      return;
    }
    this.mirandaDets.set(key, this.det('miranda', e, 'unlawful', [ruleId], reason));
  }

  private question(e: QuestionEvent): void {
    const rs = this.rs;
    const p = this.person(e.personId);
    const custodial = this.custodial(p, e);
    this.qCustodial = custodial;
    const incriminating = rs.miranda.incriminatingFacts.includes(e.fact);
    const afterInvocation = p.miranda === 'invoked' && incriminating && (custodial || p.mirandaCustody);
    const unwarned = custodial && incriminating && p.miranda !== 'waived';
    p.questions.push({ event: e, unwarned, afterInvocation });
    if (afterInvocation) {
      this.mirandaViolation(p, e, rs.miranda.invocationRuleId, `Questioned about ${e.fact} after the person invoked their rights`);
    } else if (unwarned) {
      this.mirandaViolation(p, e, rs.miranda.ruleId, `Custodial questioning about ${e.fact} without a warning and waiver`);
    }
  }

  private statement(e: StatementEvent): void {
    const rs = this.rs;
    if (!rs.miranda.incriminatingFacts.includes(e.fact)) return;
    const p = this.person(e.personId);
    let q: QuestionRec | null = null;
    let any: QuestionRec | null = null;
    for (let i = p.questions.length - 1; i >= 0; i--) {
      const c = p.questions[i];
      if (!c) continue;
      const dt = e.t - c.event.t;
      if (dt < 0) continue;
      if (dt > rs.miranda.responseWindowS) break;
      if (c.event.fact === e.fact) { q = c; break; }
      if (any === null && rs.miranda.incriminatingFacts.includes(c.event.fact)) any = c;
    }
    q = q ?? any;

    let root = -1;
    let ruleIds: string[] = [];
    let reason = 'Volunteered or properly obtained';
    if (q && (q.unwarned || q.afterInvocation)) {
      root = q.event.id;
      ruleIds = [q.afterInvocation ? rs.miranda.invocationRuleId : rs.miranda.ruleId, rs.evidence.exclusionRuleId];
      reason = q.afterInvocation ? 'Obtained by questioning after the person invoked their rights' : 'Obtained by custodial questioning without a warning and waiver';
    } else if (p.taintFrom >= 0) {
      root = p.taintFrom;
      ruleIds = [rs.evidence.fruitRuleId, rs.evidence.exclusionRuleId];
      reason = 'Fruit of an unlawful detention';
    }
    if (root >= 0) {
      this.taint.set(e.id, root);
      p.suppressedStatements++;
    }
    this.evidence.push({
      eventId: e.id, ref: `statement:${e.id}`, label: e.display || `${e.fact}: ${e.value}`, personId: e.personId, kind: 'statement',
      offense: STATEMENT_OFFENSE[e.fact] ?? null, admissible: root < 0, ruleIds, taintedBy: root, reason,
    });
  }

  // --- Force, duty to intervene --------------------------------------------------------------------

  private forceReason(level: string, resistance: string, v: ReturnType<typeof forceVerdict>): string {
    if (v.factors.includes('restrained')) return `Force beyond control holds used on a restrained subject (${level})`;
    if (v.factors.includes('lethal')) return 'Firearm used against a subject who was not a lethal threat';
    if (v.factors.includes('cycles')) return 'CED cycled more times than policy allows';
    if (v.factors.includes('display')) return `Firearm pointed at a ${resistance} subject`;
    if (v.ruleIds[0] === this.rs.force.taser.riskRuleId) return `CED used on a subject with a risk factor (${v.factors.join(', ')})`;
    return `${level} used on a ${resistance} subject; policy allows up to ${v.maxAllowed}`;
  }

  private force(e: ForceEvent): void {
    const v = forceVerdict(e, this.rs);
    this.forces.push({
      eventId: e.id, personId: e.personId, level: e.level, tool: e.tool, resistance: e.resistance, maxAllowed: v.maxAllowed,
      verdict: v.verdict, factors: v.factors, ruleIds: v.ruleIds, other: false,
    });
    if (v.verdict !== 'justified') {
      this.det('force', e, v.verdict === 'excessive' ? 'unlawful' : 'questionable', v.ruleIds, this.forceReason(e.level, e.resistance, v));
    }
  }

  private otherForce(e: OtherForceEvent): void {
    const rs = this.rs;
    const v = forceVerdict({ level: e.level, tool: 'other', resistance: e.resistance, cycle: 1, riskFactors: [], restrained: e.restrained }, rs);
    this.forces.push({
      eventId: e.id, personId: e.personId, level: e.level, tool: 'other', resistance: e.resistance, maxAllowed: v.maxAllowed,
      verdict: v.verdict, factors: v.factors, ruleIds: v.ruleIds, other: true,
    });
    if (v.verdict !== 'excessive' || e.distanceToOfficer > rs.intervene.radiusM) return;
    const key = `${e.officer}|${e.personId}`;
    let ep = this.lastEpisode.get(key);
    if (ep && e.t - ep.lastT <= EPISODE_GAP_S) {
      ep.lastT = e.t;
      ep.det.eventIds.push(e.id);
    } else {
      ep = {
        det: this.det('intervene', e, 'unlawful', [rs.intervene.ruleId], `Did not intervene while ${e.officer} used excessive force`),
        lastT: e.t,
      };
      this.lastEpisode.set(key, ep);
    }
    this.episodeOf.set(e.id, { ep, t: e.t });
  }

  private intervene(e: InterveneEvent): void {
    const rec = this.episodeOf.get(e.otherEvent);
    if (!rec || e.t - rec.t > this.rs.intervene.windowS) return;
    rec.ep.det.outcome = 'lawful';
    rec.ep.det.reason = 'Officer intervened';
  }

  // --- Entry -------------------------------------------------------------------------------------

  private entry(e: EntryEvent): void {
    const rs = this.rs;
    this.currentBuilding = e.buildingId;
    if (this.entryLawful.has(e.buildingId)) return;
    let ruleId = rs.entry.ruleId;
    let basis: string | null = null;
    if (e.publicPlace) basis = 'publicPlace';
    else if (this.allConsents.some((c) => c.effective && ENTRY_CONSENTS.includes(c.event.consent) && c.event.buildingId === e.buildingId)) {
      basis = 'consent';
      ruleId = rs.consent.ruleId;
    } else if (this.exigencyActive(e.t, e.buildingId)) {
      basis = 'exigency';
      ruleId = rs.exigency.ruleId;
    } else if (this.warrantSearch) {
      basis = 'warrant';
      ruleId = rs.arrest.warrantRuleId;
    }
    const lawful = basis !== null;
    this.entryLawful.set(e.buildingId, lawful);
    if (lawful) {
      this.det('entry', e, 'lawful', [ruleId], basis === 'publicPlace' ? 'Entry into a place open to the public' : `Entry lawful by ${basis}`, basis);
    } else {
      this.entryTaint.set(e.buildingId, e.id);
      this.taint.set(e.id, e.id);
      this.det('entry', e, 'unlawful', [ruleId], 'Entry without consent, a warrant or exigent circumstances');
    }
  }

  // --- Pursuits ------------------------------------------------------------------------------------

  private openPursuit(personId: number): PursuitAcc | null {
    let fallback: PursuitAcc | null = null;
    for (let i = this.pursuits.length - 1; i >= 0; i--) {
      const acc = this.pursuits[i];
      if (!acc || acc.end) continue;
      if (acc.start.personId === personId) return acc;
      fallback = fallback ?? acc;
    }
    return fallback;
  }

  private finishPursuits(nowT: number): void {
    const rs = this.rs;
    for (const acc of this.pursuits) {
      if (acc.start.pursuit !== 'vehicle') continue;
      const pid = acc.start.personId;
      let offense = this.book.knownOffense(pid, acc.start.t);
      if (offense === null) {
        const role = this.log.people.find((x) => x.personId === pid)?.role;
        if (role === 'suspect' || role === 'driver') offense = rs.familyOffense[this.log.family] ?? null;
      }
      const ruling = evaluatePursuit({ start: acc.start, samples: acc.samples, end: acc.end, advisory: acc.advisory, offense, nowT }, rs);
      this.pursuitRulings.push(ruling);
      this.det(
        'pursuit', acc.start, ruling.outcome, ruling.outcome === 'lawful' ? [rs.pursuit.ruleId] : ruling.ruleIds,
        ruling.reasons.length > 0 ? ruling.reasons.join('; ') : 'Pursuit conformed to policy',
      );
    }
  }

  // --- Recording ---------------------------------------------------------------------------------

  private noteRecording(e: IncidentEvent): void {
    if (e.kind === 'pursuitSample') {
      this.recChecks.push(e);
      return;
    }
    if (!this.required.has(e.kind)) return;
    if (e.kind === 'question' && !this.qCustodial) return;
    if (e.kind === 'force' && e.level === 'presence') return;
    this.recChecks.push(e);
  }

  private finishRecording(): void {
    const rec = this.rs.recording;
    const missing: IncidentEvent[] = [];
    const muted: IncidentEvent[] = [];
    for (const e of this.recChecks) {
      const t0 = this.firstT.get(e.personId) ?? this.log.openedSim;
      if (e.t - t0 <= rec.activationGraceS) continue;
      const body = (e.cam & CAM.body) !== 0;
      const dash = (e.cam & CAM.dash) !== 0;
      if (e.kind === 'pursuitSample') {
        if (!body && !dash) missing.push(e);
        continue;
      }
      if (body && (e.cam & CAM.muted) === 0) continue;
      if (dash && rec.dashCounts.includes(e.kind)) continue;
      if (body) muted.push(e);
      else missing.push(e);
    }
    this.recordingDet(missing, rec.ruleId, 'The camera was not recording during');
    this.recordingDet(muted, rec.muteRuleId, 'The recording was muted during');
  }

  private recordingDet(events: IncidentEvent[], ruleId: string, lead: string): void {
    const first = events[0];
    if (!first) return;
    const d = this.det('recording', first, 'unlawful', [ruleId], `${lead} ${events.length} required ${events.length === 1 ? 'event' : 'events'}`);
    d.eventIds = events.map((x) => x.id);
  }

  // --- Evidence post-pass --------------------------------------------------------------------------

  private finishInevitable(): void {
    const ev = this.rs.evidence;
    if (!ev.inevitableDiscovery) return;
    for (const r of this.evidence) {
      if (r.admissible || r.kind !== 'item' || !this.personSearchRulings.has(r)) continue;
      const p = this.persons.get(r.personId);
      if (!p || !p.arrests.some((a) => a.lawful && a.eventId > r.eventId)) continue;
      r.admissible = true;
      r.taintedBy = -1;
      r.ruleIds = [ev.inevitableRuleId];
      r.reason = 'Would have been found in a search incident to the later lawful arrest';
    }
  }

  // --- Assembly ------------------------------------------------------------------------------------

  private assemble(): LegalAssessment {
    const persons: PersonAssessment[] = [];
    for (const id of this.personOrder) {
      const p = this.persons.get(id);
      if (!p) continue;
      persons.push({
        personId: id, detained: p.detained, detentionLawful: p.detentionLawful, arrested: p.arrests.length > 0,
        arrestLawful: p.arrestLawful, arrestOffense: p.arrestOffense, pcAtArrest: p.pcAtArrest, rsAtDetention: p.rsAtDetention,
        suppressedStatements: p.suppressedStatements,
      });
    }
    let unlawful = 0;
    let recordingUnlawful = 0;
    let questionable = 0;
    for (const d of this.dets) {
      if (d.doctrine === 'force') continue;
      if (d.doctrine === 'recording') {
        if (d.outcome === 'unlawful') recordingUnlawful++;
      } else if (d.outcome === 'unlawful') unlawful++;
      else if (d.outcome === 'questionable') questionable++;
    }
    let excessiveForce = 0;
    let questionableForce = 0;
    for (const f of this.forces) {
      if (f.other) continue;
      if (f.verdict === 'excessive') excessiveForce++;
      else if (f.verdict === 'questionable') questionableForce++;
    }
    let suppressed = 0;
    for (const r of this.evidence) if (!r.admissible) suppressed++;
    const raw = 100 - 15 * unlawful - 8 * recordingUnlawful - 10 * questionable - 10 * questionableForce - 30 * excessiveForce;
    return {
      rulesetId: this.rs.id, key: this.log.key, determinations: this.dets, evidence: this.evidence, force: this.forces,
      pursuits: this.pursuitRulings, persons,
      summary: { unlawful, questionable, suppressed, excessiveForce, questionableForce, score: Math.max(0, Math.min(100, Math.round(raw))) },
    };
  }
}

/** Evaluates `log` against `rs`: pure, deterministic, a single pass over the events. */
export function evaluateIncident(log: IncidentLog, rs: Ruleset): LegalAssessment {
  return new Pass(log, rs).run();
}
