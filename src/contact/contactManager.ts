import type { CadTime } from '../cad/types';
import type { Rng } from '../core/rng';
import {
  SfstSession,
  TOOLS,
  available,
  commModes,
  commandLine,
  findInconsistencies,
  frisk as friskTool,
  initialMemory,
  MODE_DELAY_S,
  odorOf,
  officerLine,
  pbtReading,
  respond,
  RESPONSES,
  search as searchTool,
  toneEffect,
  utterance,
  visualCheck as visualTool,
  type CommMode,
  type DialogueContext,
  type DialogueDirectory,
  type DialogueResult,
  type IdentityClaim,
  type Inconsistency,
  type SubjectMemory,
  type SubjectProfile,
  type Tone,
  type Utterance,
} from '../dialogue';
import {
  ACTOR_STATE,
  complianceChance,
  findBehavior,
  understands,
  type ActorInfo,
  type CommandContext,
  type CommandOutcome,
  type NpcCommand,
} from '../npc';
import { itemDef, type CarriedItem, type Intoxication } from '../people';
import { ageOn, epochDayOfGameSeconds, formatDate } from '../records/calendar';
import { personIdFromDl, vinOf } from '../records/ids';
import { displayName } from '../records/person';
import { driverOf } from '../records/vehicle';
import { REGISTRY_POPULATION } from '../traffic/registry';
import type { DialogueOptionView, DialogueView, SfstView, TranscriptLine } from '../ui/dialogue/types';
import {
  appearanceText,
  appearanceValue,
  claimFromFacts,
  evidenceCategoryOf,
  nameValue,
  ownerClaimValue,
  recordAppearance,
  roundTo,
} from './facts';
import {
  ACTION_LABELS,
  buildView,
  demeanorCue,
  factNote,
  groupTopics,
  inconsistencyNote,
  statementNote,
  subtitleOf,
  titleOf,
} from './presenter';
import { isContactSave } from './save';
import {
  CONTACT_ACTIONS,
  type ContactActionId,
  type ContactDeps,
  type ContactRequest,
  type ContactSave,
  type ContactSaveEntry,
  type ContactTarget,
  type IncidentInfo,
  type IncidentResolver,
} from './types';

/**
 * ContactManager (design §10): conversations and field actions between the officer and one person at a time
 * (up to 8 stay open). The UI only queues requests; everything is applied inside `step`. Statements and
 * discovered facts go to `Population` (persisted); the lie-detection inconsistencies are always recomputed
 * from the facts the player has, never from hidden truth.
 */

const MAX_CONTACTS = 8;
const TRANSCRIPT_CAP = 40;
/** Frisk, search, cuff: the officer must be this close. */
const ACTION_RANGE_M = 3.5;
/** Looking into a vehicle. */
const VEHICLE_RANGE_M = 3;
/** Liveness and release checks run every this many steps. */
const CHECK_EVERY = 15;
const GUARDIAN_DELAY_S = 30;
/** A finished SFST stays on screen this long. */
const SFST_LINGER_S = 8;
const BAC_YES = 0.02;
const BAC_OVER = 0.08;
const IDENTITY_TOPICS: readonly string[] = ['name', 'dob', 'identity', 'idCard'];
/** States in which a person can be frisked, searched or cuffed (not moving away, fighting or hidden). */
const TOUCHABLE: ReadonlySet<number> = new Set([
  ACTOR_STATE.idle,
  ACTOR_STATE.talk,
  ACTOR_STATE.hold,
  ACTOR_STATE.handsUp,
  ACTOR_STATE.kneel,
  ACTOR_STATE.prone,
  ACTOR_STATE.cuffed,
  ACTOR_STATE.sit,
  ACTOR_STATE.down,
  ACTOR_STATE.follow,
]);

interface Line {
  id: number;
  speaker: 'officer' | 'subject' | 'system';
  text: string;
}

interface Pending {
  dueSim: number;
  result: DialogueResult;
}

interface Contact {
  id: number;
  personId: number;
  incident: string;
  callId: number;
  role: string;
  target: ContactTarget;
  actorId: number;
  commMode: CommMode;
  memory: SubjectMemory;
  transcript: Line[];
  nextLine: number;
  pending: Pending[];
  sfst: SfstSession | null;
  sfstDoneSim: number;
  guardianNotifiedAt: number;
  truth: IncidentInfo['truth'];
  guilty: boolean;
  vehicleId: number;
  stop: boolean;
  appTranslation: boolean;
  flags: Set<string>;
  found: string[];
  tone: Tone;
  /** Registered owner of the vehicle, -1 when none (not saved). */
  ownerId: number;
  /** Sim second of the last interaction (eviction order, not saved). */
  lastSim: number;
  /** Inconsistency keys already reported (not saved). */
  seen: Set<string>;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isRegistered(vehicleId: number): boolean {
  return Number.isInteger(vehicleId) && vehicleId >= 0 && vehicleId < REGISTRY_POPULATION;
}

function blankMemory(): SubjectMemory {
  return {
    rapport: 0,
    stress: 0,
    greeted: false,
    reasonGiven: false,
    mirandized: false,
    identity: null,
    identityRefusals: 0,
    lies: {},
    asked: {},
    consent: {},
    consentAskedAt: {},
  };
}

function claimName(c: IdentityClaim): string {
  return `${c.first} ${c.last}`;
}

export class ContactManager {
  private readonly deps: ContactDeps;
  private readonly rng: Rng;
  private readonly directory: DialogueDirectory;
  private readonly offBooking: () => void;
  private contacts: Contact[] = [];
  private readonly byPerson = new Map<number, Contact>();
  private queue: ContactRequest[] = [];
  private bookings: string[] = [];
  private resolver: IncidentResolver | null = null;
  private nextId = 1;
  private activeId = -1;
  private rev = 0;
  private stepCount = 0;
  private t: CadTime = { sim: 0, game: 0 };
  private readonly opos = { x: 0, z: 0, yaw: 0 };
  private readonly vpos = { x: 0, z: 0 };
  private readonly ainfo: ActorInfo = {
    id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };

  constructor(deps: ContactDeps) {
    this.deps = deps;
    this.rng = deps.rng;
    const records = deps.records;
    this.directory = {
      person(id: number) {
        if (!Number.isInteger(id) || id < 0) return null;
        const p = records.peekPerson(id);
        return { first: p.first, middle: p.middle, last: p.last, dob: p.dob, address: p.address, dlNumber: p.license.number };
      },
      dlOnFile: (dl: string) => personIdFromDl(deps.seed, dl) !== null,
    };
    // Bus handlers only enqueue (design §2).
    this.offBooking = deps.bus.on('cad:documentSaved', (e) => {
      if (e.kind === 'booking' && e.final) this.bookings.push(e.id);
    });
  }

  // --- Public API -------------------------------------------------------------------------

  setResolver(r: IncidentResolver): void {
    this.resolver = r;
  }

  /** Active contact id, -1 for none. */
  get active(): number {
    return this.activeId;
  }

  /** Bumps on any change a view can show. */
  get revision(): number {
    return this.rev;
  }

  contactOfPerson(personId: number): number {
    return this.byPerson.get(personId)?.id ?? -1;
  }

  personOf(contactId: number): number {
    return this.find(contactId)?.personId ?? -1;
  }

  /** The actor id being escorted (cuffed and following the officer), 0 when none. */
  escorting(): number {
    for (const c of this.contacts) {
      const a = this.actorOf(c);
      if (a && a.cuffed && a.following) return a.id;
    }
    return 0;
  }

  /** Queues a UI request; it is applied at the start of the next `step`. */
  request(r: ContactRequest): void {
    this.queue.push(r);
  }

  /** Field contact `incident` got a CAD call (the scene answers `contact:needsCall`). */
  attachCall(incident: string, callId: number): void {
    for (const c of this.contacts) {
      if (c.incident === incident) {
        c.callId = callId;
        this.rev++;
      }
    }
  }

  /** One fixed step (system order -680): queued requests, delayed answers, SFST timers, escort and release checks. */
  step(dt: number, t: CadTime): void {
    this.t = t;
    this.stepCount++;
    if (this.queue.length > 0) {
      const q = this.queue;
      this.queue = [];
      for (const r of q) this.apply(r);
    }
    if (this.bookings.length > 0) {
      const b = this.bookings;
      this.bookings = [];
      for (const id of b) this.bookingFact(id);
    }
    if (this.contacts.length === 0) return;
    for (let i = 0; i < this.contacts.length; i++) {
      const c = this.contacts[i] as Contact;
      if (c.pending.length > 0) this.drain(c);
      if (c.sfst) this.stepSfst(c, dt);
      if (c.guardianNotifiedAt >= 0 && t.sim >= c.guardianNotifiedAt && !c.flags.has('guardianArrived')) {
        c.flags.add('guardianArrived');
        this.line(c, 'system', 'The guardian has arrived.');
        this.emitFlag(c, 'guardianNotified');
      }
    }
    if (this.stepCount % CHECK_EVERY === 0) this.maintain();
  }

  /**
   * Opens (or re-activates) the conversation with the person at `target`. `incident` comes from the scene; null asks
   * the resolver and then falls back to a field contact. Returns the contact id, -1 when it cannot be opened.
   */
  open(target: ContactTarget, incident: IncidentInfo | null, t: CadTime): number {
    this.t = t;
    const npc = this.deps.npc;
    let actorId = 0;
    let personId = -1;
    switch (target.kind) {
      case 'actor': {
        const a = npc.actor(target.actorId, this.ainfo);
        if (!a || a.personId < 0 || a.hidden) return -1;
        actorId = a.id;
        personId = a.personId;
        break;
      }
      case 'ped': {
        const existing = npc.promotePedestrian(target.slot);
        const a = existing > 0 ? npc.actor(existing, this.ainfo) : null;
        if (!a) return -1;
        actorId = a.id;
        personId = a.personId;
        break;
      }
      case 'occupant': {
        personId = npc.occupantsOf(target.vehicleId)[target.seat] ?? -1;
        if (personId < 0) return -1;
        actorId = npc.actorOfPerson(personId);
        break;
      }
    }
    const known = this.byPerson.get(personId);
    if (known) {
      if (actorId > 0) known.actorId = actorId;
      known.target = target;
      this.activeId = known.id;
      this.rev++;
      return known.id;
    }
    const info = incident ?? this.resolver?.resolveIncident(personId, target) ?? null;
    if (this.contacts.length >= MAX_CONTACTS && !this.evict()) return -1;

    const records = this.deps.records;
    const rec = records.person(personId);
    const identity = this.deps.people.identity(personId);
    const items = this.deps.people.itemsOn(personId);
    const intox = this.deps.people.intoxication(personId);
    const vehicleId = info ? info.vehicleId : target.kind === 'occupant' ? target.vehicleId : (actorId > 0 ? (npc.actor(actorId, this.ainfo)?.vehicleId ?? -1) : -1);
    const c: Contact = {
      id: this.nextId++,
      personId,
      incident: '',
      callId: info ? info.callId : 0,
      role: info ? info.role : target.kind === 'occupant' ? (target.seat === 0 ? 'driver' : 'passenger') : actorId > 0 ? (npc.actor(actorId, this.ainfo)?.role || 'subject') : 'subject',
      target,
      actorId,
      commMode: 'verbal',
      memory: blankMemory(),
      transcript: [],
      nextLine: 1,
      pending: [],
      sfst: null,
      sfstDoneSim: -1,
      guardianNotifiedAt: -1,
      truth: { destination: '', origin: '', account: '', suspectWhereabouts: '', reason: '' },
      guilty: false,
      vehicleId,
      stop: info ? info.stop : false,
      appTranslation: false,
      flags: new Set(),
      found: [],
      tone: 'neutral',
      ownerId: isRegistered(vehicleId) ? records.registration(vehicleId).ownerId : -1,
      lastSim: t.sim,
      seen: new Set(),
    };
    if (info) {
      c.incident = info.key;
      c.truth = info.truth;
      c.guilty = info.guilty;
    } else {
      c.incident = `FC-${personId}-${epochDayOfGameSeconds(t.game)}`;
      c.truth = this.drawTruth();
      c.guilty =
        identity.wanted ||
        items.some((i) => itemDef(i.item).contraband) ||
        (intox.bac >= BAC_OVER && (target.kind === 'occupant' || vehicleId >= 0));
    }
    // A reopened contact keeps the story it already told.
    const facts = this.deps.people.facts(personId, c.incident);
    const subject = this.subjectOf(c);
    c.memory = initialMemory(subject, this.dctx(c, 'neutral'));
    for (const s of this.deps.people.statements(personId, c.incident)) {
      if (s.fact !== 'identity' && s.fact !== 'name' && s.fact !== 'dob') c.memory.asked[s.fact] = (c.memory.asked[s.fact] ?? 0) + 1;
      const lie = this.deps.people.lieFor(personId, c.incident, s.fact);
      if (lie !== null) c.memory.lies[s.fact] = lie;
    }
    c.memory.identity = claimFromFacts(facts, personId, rec);
    if (c.memory.identity) c.memory.greeted = true;

    this.contacts.push(c);
    this.byPerson.set(personId, c);
    this.activeId = c.id;
    this.refreshSeen(c);
    this.observe(c, identity.age, rec.sex, rec.heightCm, rec.hair, items, intox);
    this.emitFlag(c, 'contacted');
    this.rev++;
    return c.id;
  }

  /** The dialogue panel model of a contact (allocates: call on revision changes only). */
  view(contactId: number): DialogueView | null {
    const c = this.find(contactId);
    if (!c) return null;
    const subject = this.subjectOf(c);
    const ctx = this.dctx(c, c.tone);
    const reason = c.truth.reason === '' ? 'checking on things here' : c.truth.reason;
    const topics = groupTopics(
      available(subject, ctx, c.memory),
      (u, tone) => officerLine(u, tone, { officerName: ctx.officerName, reason }),
      c.tone,
    );
    const actions: DialogueOptionView[] = [];
    for (const id of CONTACT_ACTIONS) {
      const why = this.canDo(c, id, subject);
      actions.push(why === '' ? { id, label: ACTION_LABELS[id], enabled: true } : { id, label: ACTION_LABELS[id], enabled: false, hint: why });
    }
    const transcript: TranscriptLine[] = c.transcript.map((l) => ({ id: l.id, speaker: l.speaker, text: l.text, pending: false }));
    for (let i = 0; i < c.pending.length; i++) transcript.push({ id: c.nextLine + i, speaker: 'subject', text: '...', pending: true });
    const facts = this.deps.people.facts(c.personId, c.incident);
    const claim = c.memory.identity;
    return buildView({
      contactId: c.id,
      title: titleOf(claim ? claimName(claim) : null, subject.identity.record.sex, roundTo(subject.identity.age, 5), c.role),
      subtitle: subtitleOf(this.subtitleParts(c, subject)),
      tone: c.tone,
      commMode: c.commMode,
      commModes: this.visibleModes(c, subject, ctx),
      topics,
      actions,
      transcript: transcript.slice(-TRANSCRIPT_CAP),
      statements: this.deps.people.statements(c.personId, c.incident).map(statementNote),
      facts: facts.map(factNote),
      inconsistencies: findInconsistencies(facts).map(inconsistencyNote),
      busy: this.isBusy(c),
    });
  }

  /** The field sobriety test panel model (the active contact's session first), null when none runs. */
  sfstView(): SfstView | null {
    let c = this.find(this.activeId);
    if (!c?.sfst) c = this.contacts.find((x) => x.sfst !== null);
    const s = c?.sfst;
    if (!c || !s) return null;
    const result = s.result();
    const prompt = s.prompt;
    return {
      title: s.title,
      instruction: s.instruction,
      prompt: prompt ? prompt.label : null,
      promptRemaining: prompt ? clamp(prompt.remainingS / TOOLS.sfst.promptWindowS, 0, 1) : 0,
      progress: s.progress,
      finished: result !== null,
      summary: result ? result.summary : [],
    };
  }

  /** Inconsistencies among the facts the player has about `personId` in `incident` (never hidden truth). */
  inconsistencies(incident: string, personId: number): readonly Inconsistency[] {
    return findInconsistencies(this.deps.people.facts(personId, incident));
  }

  serialize(): ContactSave {
    const contacts: ContactSaveEntry[] = this.contacts.map((c) => ({
      id: c.id,
      personId: c.personId,
      incident: c.incident,
      callId: c.callId,
      role: c.role,
      target: { ...c.target },
      actorId: c.actorId,
      commMode: c.commMode,
      memory: structuredClone(c.memory),
      transcript: c.transcript.map((l) => ({ ...l })),
      nextLine: c.nextLine,
      pending: c.pending.map((p) => ({ dueSim: p.dueSim, result: structuredClone(p.result) })),
      sfst: c.sfst ? c.sfst.serialize() : null,
      guardianNotifiedAt: c.guardianNotifiedAt,
      truth: { ...c.truth },
      guilty: c.guilty,
      vehicleId: c.vehicleId,
      stop: c.stop,
      appTranslation: c.appTranslation,
      flags: [...c.flags].sort(),
      found: [...c.found],
    }));
    return { version: 1, nextId: this.nextId, active: this.activeId, contacts, rng: this.rng.state() };
  }

  /** Replaces every conversation with `save` (ignored when malformed). Restore the npc system and people first. */
  restore(save: ContactSave): void {
    if (!isContactSave(save)) return;
    this.contacts = [];
    this.byPerson.clear();
    this.queue = [];
    this.bookings = [];
    for (const e of save.contacts) {
      const c: Contact = {
        id: e.id,
        personId: e.personId,
        incident: e.incident,
        callId: e.callId,
        role: e.role,
        target: { ...e.target },
        actorId: e.actorId,
        commMode: e.commMode,
        memory: structuredClone(e.memory),
        transcript: e.transcript.map((l) => ({ ...l })),
        nextLine: e.nextLine,
        pending: e.pending.map((p) => ({ dueSim: p.dueSim, result: structuredClone(p.result) })),
        sfst: e.sfst ? SfstSession.restore(e.sfst) : null,
        sfstDoneSim: -1,
        guardianNotifiedAt: e.guardianNotifiedAt,
        truth: { ...e.truth },
        guilty: e.guilty,
        vehicleId: e.vehicleId,
        stop: e.stop,
        appTranslation: e.appTranslation,
        flags: new Set(e.flags ?? []),
        found: [...(e.found ?? [])],
        tone: 'neutral',
        ownerId: isRegistered(e.vehicleId) ? this.deps.records.registration(e.vehicleId).ownerId : -1,
        lastSim: this.t.sim,
        seen: new Set(),
      };
      if (c.sfst && c.sfst.test === 'done') c.sfstDoneSim = this.t.sim;
      this.contacts.push(c);
      this.byPerson.set(c.personId, c);
      this.refreshSeen(c);
    }
    this.nextId = save.nextId;
    this.activeId = this.contacts.some((c) => c.id === save.active) ? save.active : -1;
    if (save.rng) this.rng.restore(save.rng);
    this.rev++;
  }

  dispose(): void {
    this.offBooking();
    this.contacts = [];
    this.byPerson.clear();
    this.queue = [];
    this.bookings = [];
    this.activeId = -1;
  }

  // --- Request dispatch --------------------------------------------------------------------

  private apply(r: ContactRequest): void {
    switch (r.kind) {
      case 'open':
        this.open(r.target, null, this.t);
        break;
      case 'say':
        this.doSay(r.contactId, r.utteranceId, r.tone);
        break;
      case 'action':
        this.doAction(r.contactId, r.action);
        break;
      case 'commMode':
        this.doCommMode(r.contactId, r.mode);
        break;
      case 'activate':
        if (this.find(r.contactId)) {
          this.activeId = r.contactId;
          this.rev++;
        }
        break;
      case 'close': {
        const c = this.find(r.contactId);
        if (c) this.closeContact(c);
        break;
      }
      case 'sfstKey': {
        const c = this.contacts.find((x) => x.sfst !== null && x.id === this.activeId) ?? this.contacts.find((x) => x.sfst !== null);
        if (c?.sfst && c.sfst.test !== 'done') {
          c.sfst.press(r.key);
          this.rev++;
        }
        break;
      }
      case 'cage':
        this.doCage(r.vehicleIndex);
        break;
    }
  }

  // --- Lookups and scratch helpers ---------------------------------------------------------

  private find(id: number): Contact | undefined {
    return this.contacts.find((c) => c.id === id);
  }

  /** The actor of a contact (scratch, valid until the next call), or null for a seated occupant or a gone actor. */
  private actorOf(c: Contact): ActorInfo | null {
    return c.actorId > 0 ? this.deps.npc.actor(c.actorId, this.ainfo) : null;
  }

  /** Distance between the officer and the subject; 0 for a seated occupant of the stopped car. */
  private distanceTo(c: Contact): number {
    this.deps.officerPosition(this.opos);
    const a = this.actorOf(c);
    if (a) return Math.hypot(a.x - this.opos.x, a.z - this.opos.z);
    return this.vehicleDistance(c);
  }

  private vehicleDistance(c: Contact): number {
    if (c.vehicleId >= 0 && this.deps.vehiclePosition?.(c.vehicleId, this.vpos)) {
      this.deps.officerPosition(this.opos);
      return Math.hypot(this.vpos.x - this.opos.x, this.vpos.z - this.opos.z);
    }
    return 0;
  }

  private hourOf(): number {
    const s = ((this.t.game % 86400) + 86400) % 86400;
    return Math.floor(s / 3600);
  }

  private isBusy(c: Contact): boolean {
    return c.pending.length > 0 || (c.sfst !== null && c.sfst.test !== 'done');
  }

  private isDriver(c: Contact): boolean {
    return c.target.kind === 'occupant' ? c.target.seat === 0 : c.role === 'driver';
  }

  /** Whether the subject is still sitting in the vehicle (no actor). */
  private seated(c: Contact): boolean {
    return c.target.kind === 'occupant' && c.actorId === 0;
  }

  private drawTruth(): IncidentInfo['truth'] {
    const pick = (name: string): string => {
      const list = RESPONSES.values.get(name) ?? [];
      return list.length > 0 ? this.rng.pick(list) : '';
    };
    return { destination: pick('destination'), origin: pick('origin'), account: pick('account'), suspectWhereabouts: pick('suspectWhereabouts'), reason: '' };
  }

  /** Makes room for a new contact: drops the least recently used idle one; false when all are in use. */
  private evict(): boolean {
    let best: Contact | null = null;
    for (const c of this.contacts) {
      if (c.id === this.activeId || this.isBusy(c)) continue;
      const a = this.actorOf(c);
      if (a && a.cuffed) continue;
      if (best === null || c.lastSim < best.lastSim) best = c;
    }
    if (!best) return false;
    this.removeContact(best);
    return true;
  }

  private removeContact(c: Contact): void {
    const i = this.contacts.indexOf(c);
    if (i >= 0) this.contacts.splice(i, 1);
    if (this.byPerson.get(c.personId) === c) this.byPerson.delete(c.personId);
    if (this.activeId === c.id) this.activeId = -1;
    this.rev++;
  }

  /** Closes the conversation; a prisoner who is being escorted keeps the contact (so the cage still works). */
  private closeContact(c: Contact): void {
    const a = this.actorOf(c);
    if (a && a.cuffed && a.following) {
      if (this.activeId === c.id) this.activeId = -1;
      this.rev++;
      return;
    }
    this.removeContact(c);
  }

  // --- Subject and dialogue context ---------------------------------------------------------

  private demeanorOf(c: Contact, a: ActorInfo | null, deceased: boolean): string {
    if (deceased) return 'unresponsive';
    if (a) return findBehavior(a.profile)?.demeanor ?? 'cooperative';
    return c.stop && c.guilty ? 'nervous' : 'cooperative';
  }

  private subjectOf(c: Contact): SubjectProfile {
    const people = this.deps.people;
    const a = this.actorOf(c);
    const drawn = a !== null && a.weaponDrawn;
    const state = people.state(c.personId);
    const demeanor = this.demeanorOf(c, a, state.deceased);
    const cuffed = a !== null && a.cuffed;
    const items = people.itemsOn(c.personId).map((i) => (drawn && itemDef(i.item).weapon ? { ...i, visible: true } : i));
    let vehicleItems: readonly CarriedItem[] = [];
    if (isRegistered(c.vehicleId)) {
      const driver = this.deps.npc.occupantsOf(c.vehicleId)[0] ?? driverOf(this.deps.seed, c.vehicleId);
      vehicleItems = people.vehicleItems(c.vehicleId, driver);
    }
    return {
      personId: c.personId,
      identity: people.identity(c.personId),
      intoxication: state.intoxication,
      demeanor,
      role: c.role,
      items,
      vehicleItems,
      vehicleOwnerId: c.ownerId,
      guilty: c.guilty,
      injured: state.injured > 0,
      inVehicle: this.seated(c),
      restrained: cuffed,
    };
  }

  private dctx(c: Contact, tone: Tone): DialogueContext {
    this.deps.officerPosition(this.opos);
    const a = this.actorOf(c);
    const x = a ? a.x : this.opos.x;
    const z = a ? a.z : this.opos.z;
    const p = this.deps.presence();
    const juvenile = this.deps.people.identity(c.personId).juvenile;
    return {
      tone,
      commMode: c.commMode,
      hour: this.hourOf(),
      officerName: this.deps.officer().name,
      presence: { lights: p.lights, backup: p.backup, weapon: p.weapon, uniform: true },
      history: this.deps.people.officerHistory(c.personId),
      trust: this.deps.trustAt(x, z),
      truth: c.truth,
      guardianPresent: !juvenile || (c.guardianNotifiedAt >= 0 && this.t.sim >= c.guardianNotifiedAt),
      interpreterAvailable: c.callId > 0 && this.deps.interpreterAvailable(c.callId),
      directory: this.directory,
    };
  }

  private visibleModes(c: Contact, subject: SubjectProfile, ctx: DialogueContext): CommMode[] {
    const hearing = c.flags.has('noticedDeaf') || c.flags.has('noticedHoh');
    const language = c.flags.has('noticedForeign') || c.flags.has('noticedLimited');
    return commModes(subject, ctx).filter((m) => {
      if (m === 'verbal' || m === 'interpreter' || m === c.commMode) return true;
      if (m === 'written' || m === 'gesture') return hearing;
      return language;
    });
  }

  private subtitleParts(c: Contact, subject: SubjectProfile): string[] {
    const parts: string[] = [demeanorCue(subject.demeanor)];
    const facts = this.deps.people.facts(c.personId, c.incident);
    if (facts.some((f) => f.topic === 'drinking' && f.source === 'evidence' && f.detail === 'odor of alcohol')) parts.push('Odor of alcohol');
    if (subject.restrained) parts.push('Cuffed');
    if (c.flags.has('noticedDeaf')) parts.push('Deaf - use written notes');
    else if (c.flags.has('noticedHoh')) parts.push('Hard of hearing');
    if (c.flags.has('noticedForeign')) parts.push(`Speaks ${subject.identity.language.label}`);
    else if (c.flags.has('noticedLimited')) parts.push('Limited English');
    if (subject.identity.juvenile) parts.push('Juvenile');
    if (subject.injured) parts.push('Injured');
    return parts;
  }

  // --- Transcript, events, facts --------------------------------------------------------------

  private line(c: Contact, speaker: Line['speaker'], text: string, language = 'en'): void {
    c.transcript.push({ id: c.nextLine++, speaker, text });
    if (c.transcript.length > TRANSCRIPT_CAP) c.transcript.splice(0, c.transcript.length - TRANSCRIPT_CAP);
    c.lastSim = this.t.sim;
    this.rev++;
    this.deps.bus.emit('contact:line', { personId: c.personId, speaker, text, language });
  }

  private emitFlag(c: Contact, flag: string): void {
    this.rev++;
    this.deps.bus.emit('contact:event', { incident: c.incident, callId: c.callId, personId: c.personId, role: c.role, flag });
  }

  /** Emits `flag` once per contact. */
  private flagOnce(c: Contact, flag: string): void {
    if (c.flags.has(`ev:${flag}`)) return;
    c.flags.add(`ev:${flag}`);
    this.emitFlag(c, flag);
  }

  /** Stores a discovered fact unless the latest fact of the same topic and source says exactly the same. */
  private addFact(c: Contact, topic: string, value: string, source: 'claim' | 'document' | 'record' | 'evidence' | 'observation' | 'booking', display: string, detail = ''): void {
    this.storeFact(c.personId, c.incident, topic, value, source, display, detail);
    this.checkInconsistencies(c);
  }

  private storeFact(personId: number, incident: string, topic: string, value: string, source: 'claim' | 'document' | 'record' | 'evidence' | 'observation' | 'booking', display: string, detail: string): void {
    const list = this.deps.people.facts(personId, incident);
    for (let i = list.length - 1; i >= 0; i--) {
      const f = list[i];
      if (f && f.topic === topic && f.source === source) {
        if (f.value === value && f.display === display && f.detail === detail) return;
        break;
      }
    }
    this.deps.people.addFact(personId, { incident, topic, value, source, display, detail, game: this.t.game });
    this.rev++;
  }

  private refreshSeen(c: Contact): void {
    c.seen.clear();
    for (const i of findInconsistencies(this.deps.people.facts(c.personId, c.incident))) c.seen.add(i.key);
  }

  /** Reports new identity contradictions as `falseIdentity`. */
  private checkInconsistencies(c: Contact): void {
    for (const i of findInconsistencies(this.deps.people.facts(c.personId, c.incident))) {
      if (c.seen.has(i.key)) continue;
      c.seen.add(i.key);
      this.rev++;
      if (IDENTITY_TOPICS.includes(i.topic) && i.severity === 'alert') this.flagOnce(c, 'falseIdentity');
    }
  }

  /** Appearance and odor observations when a contact starts. */
  private observe(c: Contact, age: number, sex: string, heightCm: number, hair: string, items: readonly CarriedItem[], intox: Intoxication): void {
    const value = appearanceValue(sex, roundTo(age, 5), roundTo(heightCm, 5), hair);
    this.addFact(c, 'appearance', value, 'observation', appearanceText(value, true), 'seen at first contact');
    if (this.distanceTo(c) <= TOOLS.odor.distanceM) {
      const odors = odorOf(items, intox);
      if (odors.includes('alcohol')) this.addFact(c, 'drinking', 'yes', 'evidence', 'Odor of alcohol', 'odor of alcohol');
      if (odors.includes('cannabis')) this.addFact(c, 'drugs', 'yes', 'evidence', 'Odor of cannabis', 'odor of cannabis');
    }
  }

  // --- Saying things -----------------------------------------------------------------------

  private doSay(contactId: number, utteranceId: string, tone: Tone): void {
    const c = this.find(contactId);
    if (!c || this.isBusy(c)) return;
    let u: Utterance;
    try {
      u = utterance(utteranceId);
    } catch {
      return;
    }
    c.tone = tone;
    c.lastSim = this.t.sim;
    const subject = this.subjectOf(c);
    const ctx = this.dctx(c, tone);
    const entry = available(subject, ctx, c.memory).find((e) => e.utterance.id === u.id);
    if (!entry || !entry.enabled) {
      this.line(c, 'system', entry && entry.reason !== '' ? entry.reason : 'Not possible now.');
      return;
    }
    const reason = c.truth.reason === '' ? 'checking on things here' : c.truth.reason;
    this.line(c, 'officer', officerLine(u, tone, { officerName: ctx.officerName, reason }));
    if (
      c.callId === 0 &&
      c.incident.startsWith('FC-') &&
      !c.flags.has('needsCall') &&
      (u.intent === 'requestId' || u.intent === 'command' || u.intent === 'consent')
    ) {
      c.flags.add('needsCall');
      this.deps.officerPosition(this.opos);
      const a = this.actorOf(c);
      this.deps.bus.emit('contact:needsCall', {
        personId: c.personId,
        x: a ? a.x : this.opos.x,
        z: a ? a.z : this.opos.z,
        incident: c.incident,
      });
    }
    if (u.intent === 'command') {
      this.doCommand(c, u, subject, ctx);
      return;
    }
    const res = respond(u, subject, ctx, c.memory, this.rng);
    c.pending.push({ dueSim: this.t.sim + res.delayS, result: res });
    this.rev++;
    this.drain(c);
  }

  /** Delivers every delayed answer that is due. */
  private drain(c: Contact): void {
    while (c.pending.length > 0) {
      const p = c.pending[0] as Pending;
      if (p.dueSim > this.t.sim + 1e-9) return;
      c.pending.shift();
      this.deliver(c, p.result);
    }
  }

  private deliver(c: Contact, res: DialogueResult): void {
    const people = this.deps.people;
    const previous = c.memory.identity;
    c.memory = res.memory;
    switch (res.lineKey) {
      case 'deaf.noResponse':
        c.flags.add('noticedDeaf');
        break;
      case 'hoh.repeat':
        c.flags.add('noticedHoh');
        break;
      case 'foreign.untranslated':
      case 'foreign.misunderstood':
        c.flags.add('noticedForeign');
        break;
      case 'limited.confused':
        c.flags.add('noticedLimited');
        break;
      default:
        break;
    }
    if (res.text !== '') {
      const language = res.lineKey === 'foreign.untranslated' ? people.identity(c.personId).language.label : 'en';
      this.line(c, 'subject', res.text, language);
    }
    const st = res.statement;
    if (st) {
      people.addStatement(c.personId, {
        incident: c.incident,
        fact: st.fact,
        value: st.value,
        text: st.display,
        game: this.t.game,
        truthful: st.truthful,
        confused: st.confused,
      });
      if (!st.truthful) people.rememberLie(c.personId, c.incident, st.fact, st.value);
      this.claimFacts(c, res);
      if (st.fact === 'account' || st.fact === 'identity' || st.fact === 'name' || st.fact === 'dob') this.emitFlag(c, 'statement');
    }
    const claim = res.identity;
    if (claim) {
      if (claim.document !== 'none') {
        this.documentFacts(c, claim);
        this.flagOnce(c, 'identified');
      }
      if (previous === null || previous.personId !== claim.personId || previous.kind !== claim.kind) this.identityEffects(c, claim);
    }
    if (res.escalate) this.escalate(c, res.escalate);
    if (res.calmed) this.flagOnce(c, 'calmed');
    if (c.actorId > 0) this.deps.npc.setStress(c.actorId, c.memory.stress);
    this.rev++;
  }

  /** Writes the claim facts of a statement. Name and date of birth questions write only that fact (nothing else leaks). */
  private claimFacts(c: Contact, res: DialogueResult): void {
    const st = res.statement;
    if (!st) return;
    const mem = c.memory;
    const claimed = mem.identity;
    const trueId = c.personId;
    switch (st.fact) {
      case 'identity': {
        const claim = res.identity;
        if (!claim) return;
        this.addFact(c, 'name', nameValue(claim.first, claim.last), 'claim', claimName(claim));
        this.addFact(c, 'dob', String(claim.dob), 'claim', formatDate(claim.dob));
        this.addFact(c, 'identity', st.value, 'claim', st.display);
        this.addFact(c, 'address', claim.address.toUpperCase(), 'claim', claim.address);
        return;
      }
      case 'name':
        this.addFact(c, 'name', st.value, 'claim', st.display);
        return;
      case 'dob':
        this.addFact(c, 'dob', st.value, 'claim', st.display);
        return;
      case 'address':
        this.addFact(c, 'address', st.value.toUpperCase(), 'claim', st.display);
        return;
      case 'vehicleOwner':
        this.addFact(c, 'vehicleOwner', ownerClaimValue(st.value, st.truthful, claimed ? claimed.personId : -1, trueId, c.ownerId), 'claim', st.display);
        return;
      default:
        this.addFact(c, st.fact, st.value, 'claim', st.display);
    }
  }

  /** Document facts of an ID card handed over (name, date of birth, number). */
  private documentFacts(c: Contact, claim: IdentityClaim): void {
    this.addFact(c, 'name', nameValue(claim.first, claim.last), 'document', claimName(claim));
    this.addFact(c, 'dob', String(claim.dob), 'document', formatDate(claim.dob));
    this.addFact(c, 'idCard', claim.dlNumber, 'document', `DL ${claim.dlNumber}`, `ID card number ${claim.dlNumber}`);
  }

  /** CAD consequences of a new identity claim by a stop driver. */
  private identityEffects(c: Contact, claim: IdentityClaim): void {
    if (!c.stop || !this.isDriver(c)) return;
    if (claim.personId >= 0) {
      this.deps.request({ kind: 'stopContact', action: 'license', personId: claim.personId });
    } else if (c.callId > 0) {
      this.deps.cad.addNarrative(
        c.callId,
        this.deps.playerCallsign,
        `Driver identified verbally as ${claimName(claim).toUpperCase()}, DOB ${formatDate(claim.dob)} (not verified).`,
        this.t,
      );
    }
  }

  private escalate(c: Contact, kind: 'flee' | 'fight'): void {
    if (c.actorId === 0) this.stepOutActor(c);
    if (c.actorId > 0) this.deps.npc.forceState(c.actorId, kind);
  }

  /** Gets a seated occupant out of the car (creates its actor); returns the actor id, 0 when impossible. */
  private stepOutActor(c: Contact): number {
    if (c.target.kind !== 'occupant') return 0;
    const npc = this.deps.npc;
    const id = npc.stepOut(c.target.vehicleId, c.target.seat);
    if (id === 0) return 0;
    c.actorId = id;
    npc.setProfile(id, c.target.seat === 0 ? (c.guilty ? 'driverNervous' : 'driverCooperative') : 'passenger');
    npc.setRole(id, c.role, c.callId);
    npc.setStress(id, c.memory.stress);
    this.rev++;
    return id;
  }

  // --- Commands ------------------------------------------------------------------------------

  private doCommand(c: Contact, u: Utterance, subject: SubjectProfile, ctx: DialogueContext): void {
    const npc = this.deps.npc;
    const cmd = u.command as NpcCommand;
    const mem = c.memory;
    toneEffect(mem, ctx.tone, subject.demeanor, ctx.hour, 'command');
    const cc = { tone: ctx.tone, rapport: mem.rapport, commMode: c.commMode, weapon: ctx.presence.weapon, backup: ctx.presence.backup, lights: ctx.presence.lights };
    let outcome: CommandOutcome;
    if (c.actorId > 0 && this.actorOf(c)) {
      npc.setStress(c.actorId, mem.stress);
      outcome = npc.evaluateCommand(c.actorId, cmd, cc);
    } else {
      outcome = this.seatedRoll(c, subject, cmd, cc);
    }
    const spoken = commandLine(outcome, subject, ctx, this.rng);
    if (outcome === 'comply' && c.actorId === 0 && cmd === 'stepOut') this.stepOutActor(c);
    if (c.actorId > 0) {
      npc.applyCommand(c.actorId, cmd, outcome);
      const a = this.actorOf(c);
      if (a) mem.stress = a.stress;
    } else if (outcome === 'comply') {
      if (cmd === 'turnOffEngine') c.flags.add('engineOff');
      if (cmd === 'tossKeys') c.flags.add('keysTossed');
    }
    const result: DialogueResult = {
      lineKey: spoken.lineKey,
      text: spoken.text,
      delayS: MODE_DELAY_S[c.commMode],
      understood: outcome !== 'confused',
      statement: null,
      identity: null,
      consent: null,
      escalate: null,
      calmed: false,
      memory: structuredClone(mem),
    };
    c.pending.push({ dueSim: this.t.sim + result.delayS, result });
    this.rev++;
    this.drain(c);
  }

  /** A command to someone still seated in a car: no actor yet, so the same formulas run here. */
  private seatedRoll(c: Contact, subject: SubjectProfile, cmd: NpcCommand, cc: CommandContext): CommandOutcome {
    const profile = findBehavior(c.target.kind === 'occupant' && c.target.seat === 0 ? (c.guilty ? 'driverNervous' : 'driverCooperative') : 'passenger');
    if (!profile) return 'refuse';
    if (this.rng.next() >= understands(subject.identity, c.commMode, cmd)) return 'confused';
    return this.rng.next() < complianceChance(profile, subject.identity, subject.intoxication, c.memory.stress, cc, cmd) ? 'comply' : 'refuse';
  }

  private doCommMode(contactId: number, mode: CommMode): void {
    const c = this.find(contactId);
    if (!c || this.isBusy(c)) return;
    const subject = this.subjectOf(c);
    if (!commModes(subject, this.dctx(c, c.tone)).includes(mode)) return;
    c.commMode = mode;
    c.appTranslation = mode === 'translationApp';
    this.rev++;
  }

  // --- Actions ---------------------------------------------------------------------------------

  /** Why `action` is not possible now ('' when it is). Depends only on what the player can see or has been told. */
  private canDo(c: Contact, action: ContactActionId, subject: SubjectProfile): string {
    if (this.isBusy(c)) return 'Wait for the answer';
    const a = this.actorOf(c);
    const seated = this.seated(c);
    const cuffed = a !== null && a.cuffed;
    const near = (range: number): boolean => this.distanceTo(c) <= range;
    const standing = (): string => {
      if (seated) return 'Order the subject out of the vehicle first';
      if (!a) return 'Subject is gone';
      if (a.hidden || !TOUCHABLE.has(a.state)) return 'Subject is not standing still';
      if (!near(ACTION_RANGE_M)) return 'Too far away';
      return '';
    };
    const consent = (k: 'searchPerson' | 'searchVehicle' | 'pbt' | 'sfst'): boolean => c.memory.consent[k] === 'granted';
    const hasVehicle = isRegistered(c.vehicleId);
    switch (action) {
      case 'frisk':
        return c.flags.has('frisked') ? 'Already frisked' : standing();
      case 'searchPerson': {
        if (c.flags.has('searched')) return 'Already searched';
        const why = standing();
        if (why !== '') return why;
        return consent('searchPerson') || cuffed ? '' : 'Needs consent or custody';
      }
      case 'searchVehicle':
        if (!hasVehicle) return 'No vehicle';
        if (c.flags.has('vehicleSearched')) return 'Already searched';
        return consent('searchVehicle') || cuffed ? '' : 'Needs consent or custody';
      case 'visualCheck':
        if (!hasVehicle) return 'No vehicle';
        if (c.flags.has('visualChecked')) return 'Already checked';
        return this.vehicleDistance(c) <= VEHICLE_RANGE_M || this.deps.stopVehicleId() === c.vehicleId ? '' : 'Too far from the vehicle';
      case 'pbt':
        if (c.flags.has('pbt')) return 'Already tested';
        if (!consent('pbt')) return 'Needs consent';
        return near(ACTION_RANGE_M) ? '' : 'Too far away';
      case 'sfst':
        if (c.sfst !== null || c.flags.has('sfst')) return 'Already tested';
        if (!consent('sfst')) return 'Needs consent';
        if (seated) return 'Order the subject out of the vehicle first';
        if (!a) return 'Subject is gone';
        if (cuffed) return 'Cannot test a restrained subject';
        return near(ACTION_RANGE_M * 2) ? '' : 'Too far away';
      case 'checkId':
        return c.memory.identity && c.memory.identity.document !== 'none' ? '' : 'No ID card handed over';
      case 'runName':
        return c.memory.identity ? '' : 'No name given yet';
      case 'runId':
        return c.memory.identity && c.memory.identity.dlNumber !== '' ? '' : 'No ID number yet';
      case 'runPlate':
      case 'checkVin':
        return hasVehicle ? '' : 'No vehicle';
      case 'cuff':
        if (seated) return 'Order the subject out of the vehicle first';
        if (!a) return 'Subject is gone';
        if (a.cuffed) return 'Already cuffed';
        if (a.hidden) return 'Subject is not visible';
        return near(ACTION_RANGE_M) ? '' : 'Too far away';
      case 'uncuff':
        return cuffed ? (near(ACTION_RANGE_M) ? '' : 'Too far away') : 'Not cuffed';
      case 'escort':
        if (!a) return 'Subject is not out of the vehicle';
        return a.following ? 'Already escorting' : '';
      case 'stopEscort':
        return a?.following ? '' : 'Not escorting';
      case 'release':
      case 'warnRelease':
      case 'writeCitation':
        return '';
      case 'notifyGuardian':
        if (!subject.identity.juvenile) return 'Not a juvenile';
        return c.guardianNotifiedAt >= 0 ? 'Guardian already notified' : '';
      case 'useTranslationApp':
        if (c.commMode === 'translationApp') return 'Already in use';
        return c.flags.has('noticedForeign') || c.flags.has('noticedLimited') ? '' : 'No language barrier noticed';
      case 'requestInterpreter':
        if (c.commMode === 'interpreter') return 'Already in use';
        return c.flags.has('noticedForeign') || c.flags.has('noticedLimited') || c.flags.has('noticedDeaf') || c.flags.has('noticedHoh')
          ? ''
          : 'No communication barrier noticed';
      case 'seize':
        return c.found.length > 0 ? '' : 'Nothing found to seize';
    }
  }

  private doAction(contactId: number, action: ContactActionId): void {
    const c = this.find(contactId);
    if (!c) return;
    c.lastSim = this.t.sim;
    const subject = this.subjectOf(c);
    const why = this.canDo(c, action, subject);
    if (why !== '') {
      this.line(c, 'system', why);
      return;
    }
    switch (action) {
      case 'frisk':
        this.doFrisk(c, subject);
        break;
      case 'searchPerson':
        this.doSearchPerson(c, subject);
        break;
      case 'searchVehicle':
        this.doSearchVehicle(c, subject);
        break;
      case 'visualCheck':
        this.doVisualCheck(c, subject);
        break;
      case 'pbt':
        this.doPbt(c, subject);
        break;
      case 'sfst':
        this.doSfst(c, subject);
        break;
      case 'checkId':
        this.doCheckId(c);
        break;
      case 'runName':
        this.doRunName(c);
        break;
      case 'runId':
        this.doRunId(c);
        break;
      case 'runPlate':
        this.doRunPlate(c);
        break;
      case 'checkVin':
        this.doCheckVin(c);
        break;
      case 'cuff':
        this.doCuff(c);
        break;
      case 'uncuff':
        this.doUncuff(c);
        break;
      case 'escort':
        this.doEscort(c, true);
        break;
      case 'stopEscort':
        this.doEscort(c, false);
        break;
      case 'release':
        this.doRelease(c, false);
        break;
      case 'warnRelease':
        this.doRelease(c, true);
        break;
      case 'writeCitation':
        this.doCitation(c);
        break;
      case 'notifyGuardian':
        c.guardianNotifiedAt = this.t.sim + GUARDIAN_DELAY_S;
        this.line(c, 'system', 'Guardian notified; they are on their way.');
        break;
      case 'useTranslationApp':
        this.doCommMode(c.id, 'translationApp');
        this.line(c, 'system', 'Using the translation app.');
        break;
      case 'requestInterpreter':
        if (c.callId > 0 && this.deps.interpreterAvailable(c.callId)) {
          this.doCommMode(c.id, 'interpreter');
          this.line(c, 'system', 'The interpreter joins the conversation.');
        } else {
          this.line(c, 'system', 'Interpreter requested.');
          this.emitFlag(c, 'interpreterRequested');
        }
        break;
      case 'seize':
        this.doSeize(c);
        break;
    }
    this.rev++;
  }

  /** Items found: facts (weapons, drugs, drinking, vehicle contents) and flags. */
  private noteFinding(c: Contact, item: CarriedItem, how: string, fromVehicle: boolean): void {
    const def = itemDef(item.item);
    const detail = `${def.label.toLowerCase()} found during ${how}`;
    if (def.weapon) this.addFact(c, 'weapons', 'yes', 'evidence', `Weapon found: ${def.label}`, detail);
    else if (def.category === 'drugs' || def.category === 'paraphernalia') this.addFact(c, 'drugs', 'yes', 'evidence', `Found: ${def.label}`, detail);
    else if (def.category === 'alcohol') this.addFact(c, 'drinking', 'yes', 'evidence', `Found: ${def.label}`, detail);
    if (fromVehicle) this.addFact(c, 'vehicleContents', `item:${def.id}`, 'evidence', `Found in vehicle: ${def.label}`, detail);
    if (def.weapon) this.flagOnce(c, 'weaponFound');
    if (def.contraband) this.flagOnce(c, 'contrabandFound');
    this.emitFlag(c, `itemFound:${def.id}`);
    this.line(c, 'system', `Found: ${def.label}.`);
  }

  private rememberFound(c: Contact, items: readonly CarriedItem[]): void {
    for (const i of items) if (!c.found.includes(i.instance)) c.found.push(i.instance);
  }

  private doFrisk(c: Contact, subject: SubjectProfile): void {
    c.flags.add('frisked');
    const found = friskTool(subject.items, this.rng);
    this.line(c, 'system', found.length === 0 ? 'Frisk: nothing found.' : `Frisk: ${found.length} item${found.length === 1 ? '' : 's'} found.`);
    const weapons: CarriedItem[] = [];
    const other: CarriedItem[] = [];
    for (const it of found) {
      this.noteFinding(c, it, 'a frisk', false);
      (itemDef(it.item).weapon ? weapons : other).push(it);
    }
    this.rememberFound(c, other);
    if (weapons.length > 0) this.collect(c, weapons);
    this.emitFlag(c, 'frisked');
  }

  private doSearchPerson(c: Contact, subject: SubjectProfile): void {
    c.flags.add('searched');
    const found = searchTool(subject.items, this.rng);
    this.line(c, 'system', found.length === 0 ? 'Search: nothing found.' : `Search: ${found.length} item${found.length === 1 ? '' : 's'} found.`);
    for (const it of found) this.noteFinding(c, it, 'a search', false);
    this.rememberFound(c, found);
    this.emitFlag(c, 'searched');
  }

  private doSearchVehicle(c: Contact, subject: SubjectProfile): void {
    c.flags.add('vehicleSearched');
    const found = searchTool(subject.vehicleItems, this.rng);
    this.line(c, 'system', found.length === 0 ? 'Vehicle search: nothing found.' : `Vehicle search: ${found.length} item${found.length === 1 ? '' : 's'} found.`);
    for (const it of found) this.noteFinding(c, it, 'a vehicle search', true);
    this.rememberFound(c, found);
    this.emitFlag(c, 'searched');
  }

  private doVisualCheck(c: Contact, subject: SubjectProfile): void {
    c.flags.add('visualChecked');
    const seen = visualTool(subject.vehicleItems);
    this.line(c, 'system', seen.length === 0 ? 'Nothing unusual in plain view.' : 'Something is in plain view.');
    for (const it of seen) this.noteFinding(c, it, 'a look into the vehicle', true);
    this.rememberFound(c, seen);
  }

  private doPbt(c: Contact, subject: SubjectProfile): void {
    c.flags.add('pbt');
    const reading = pbtReading(subject.intoxication.bac, this.rng);
    const text = reading.toFixed(3);
    this.line(c, 'system', `PBT: ${text}`);
    if (reading >= BAC_YES) {
      this.addFact(c, 'drinking', reading >= BAC_OVER ? 'heavy' : 'yes', 'evidence', `Breath test ${text}`, `PBT ${text}`);
    }
    this.emitFlag(c, 'pbt');
    if (reading >= BAC_OVER) this.emitFlag(c, 'bacOver');
  }

  private doSfst(c: Contact, subject: SubjectProfile): void {
    c.sfst = new SfstSession(subject.intoxication.bac, subject.intoxication.drug, subject.identity.health, this.rng);
    c.sfstDoneSim = -1;
    this.line(c, 'system', 'Field sobriety tests begin.');
  }

  private stepSfst(c: Contact, dt: number): void {
    const s = c.sfst;
    if (!s) return;
    if (c.sfstDoneSim < 0) {
      // A key press can finish the last test too, so the end is checked after the timers either way.
      if (s.result() === null) s.step(dt);
      if (s.result() !== null) {
        this.finishSfst(c, s);
        return;
      }
      // The prompt timer runs continuously: keep the revision moving so the panel redraws.
      this.rev++;
      return;
    }
    if (this.t.sim - c.sfstDoneSim >= SFST_LINGER_S) {
      c.sfst = null;
      this.rev++;
    }
  }

  private finishSfst(c: Contact, s: SfstSession): void {
    const result = s.result();
    c.sfstDoneSim = this.t.sim;
    c.flags.add('sfst');
    this.rev++;
    if (!result) return;
    for (const text of result.summary) this.line(c, 'system', text);
    if (result.indicates) {
      let strong = 0;
      for (const def of TOOLS.sfst.tests) {
        if (result.administered[def.id] && result.clues[def.id] >= def.threshold) strong++;
      }
      this.addFact(c, 'drinking', strong >= 2 ? 'heavy' : 'yes', 'evidence', 'Failed sobriety tests', result.summary.join('; '));
      this.emitFlag(c, 'sfst');
      this.emitFlag(c, 'sfstFail');
    } else {
      this.emitFlag(c, 'sfst');
    }
  }

  private doCheckId(c: Contact): void {
    const claim = c.memory.identity;
    if (!claim) return;
    this.line(c, 'system', `ID card: ${claimName(claim).toUpperCase()}, DOB ${formatDate(claim.dob)}, number ${claim.dlNumber}.`);
    this.documentFacts(c, claim);
    this.flagOnce(c, 'identified');
  }

  private doRunName(c: Contact): void {
    const claim = c.memory.identity;
    if (!claim) return;
    const records = this.deps.records;
    const found = records.findPersons({ last: claim.last, first: claim.first }, 50, this.t.game);
    const asked = formatDate(claim.dob);
    const sameDob = found.filter((s) => s.dob === asked);
    // Several people can share a name and birth date: the lookup shows the one the claim describes first.
    const match = sameDob.find((s) => s.personId === claim.personId) ?? sameDob[0] ?? found.find((s) => s.personId === claim.personId) ?? found[0];
    if (!match) {
      this.addFact(c, 'name', 'NOTONFILE', 'record', 'No record on file', `no record for ${nameValue(claim.first, claim.last)}`);
      this.line(c, 'system', `No record for ${nameValue(claim.first, claim.last)}.`);
      return;
    }
    this.recordFacts(c, match.personId);
    this.line(c, 'system', `Record found: ${match.name}, DOB ${match.dob}.`);
    this.deps.request({ kind: 'runPerson', personId: match.personId });
    if (sameDob.length > 0) this.flagOnce(c, 'identified');
  }

  private doRunId(c: Contact): void {
    const claim = c.memory.identity;
    if (!claim || claim.dlNumber === '') return;
    const id = personIdFromDl(this.deps.seed, claim.dlNumber);
    if (id === null) {
      this.addFact(c, 'idCard', 'notOnFile', 'record', `DL ${claim.dlNumber}: not on file`, `number ${claim.dlNumber} is not on file`);
      this.line(c, 'system', `DL ${claim.dlNumber}: no record on file.`);
      return;
    }
    const rec = this.deps.records.peekPerson(id);
    const name = nameValue(rec.first, rec.last);
    this.addFact(c, 'idCard', `onFile:${name}`, 'record', `DL ${claim.dlNumber}: ${name}`, `number ${claim.dlNumber} is registered to ${name}`);
    this.addFact(c, 'appearance', recordAppearance(rec, ageOn(rec.dob, epochDayOfGameSeconds(this.t.game))), 'record', 'Record description', 'record on file');
    this.line(c, 'system', `DL ${claim.dlNumber}: ${displayName(rec)}.`);
    this.deps.request({ kind: 'runPerson', personId: id });
  }

  /** Name, date of birth, address and description of a record as record facts. */
  private recordFacts(c: Contact, personId: number): void {
    const rec = this.deps.records.peekPerson(personId);
    const age = ageOn(rec.dob, epochDayOfGameSeconds(this.t.game));
    const look = recordAppearance(rec, age);
    this.addFact(c, 'name', nameValue(rec.first, rec.last), 'record', displayName(rec));
    this.addFact(c, 'dob', String(rec.dob), 'record', formatDate(rec.dob));
    this.addFact(c, 'address', rec.address.toUpperCase(), 'record', rec.address);
    this.addFact(c, 'appearance', look, 'record', appearanceText(look, false), 'record on file');
  }

  private ownerFact(c: Contact): void {
    if (!isRegistered(c.vehicleId)) return;
    const reg = this.deps.records.registration(c.vehicleId);
    const owner = this.deps.records.peekPerson(reg.ownerId);
    this.addFact(c, 'vehicleOwner', `owner:${reg.ownerId}`, 'record', `Registered owner: ${displayName(owner)}`, 'registration check');
  }

  private doRunPlate(c: Contact): void {
    const reg = this.deps.records.registration(c.vehicleId);
    this.deps.request({ kind: 'runPlate', plate: reg.plate, vehicleId: c.vehicleId });
    this.line(c, 'system', `Plate ${reg.plate} run.`);
    this.ownerFact(c);
  }

  private doCheckVin(c: Contact): void {
    if (c.stop && this.deps.stopVehicleId() === c.vehicleId) {
      this.deps.request({ kind: 'stopContact', action: 'vin' });
      this.line(c, 'system', 'VIN check requested.');
    } else {
      const res = this.deps.records.runVin(vinOf(this.deps.seed, c.vehicleId), this.t.game);
      this.line(c, 'system', res.found ? `VIN ${res.vin}: registered.` : `VIN ${res.vin}: no record.`);
    }
    this.ownerFact(c);
  }

  // --- Custody, escort, release, cage --------------------------------------------------------

  private doCuff(c: Contact): void {
    const npc = this.deps.npc;
    const result = npc.cuff(c.actorId);
    if (result === 'ok') {
      this.deps.people.setCustody(c.personId, 'arrested');
      this.line(c, 'system', 'Subject handcuffed.');
      this.emitFlag(c, 'custody');
      if (c.flags.has('resisted')) {
        c.flags.delete('resisted');
        this.emitFlag(c, 'forceUsed');
        this.emitForce(c, 'cuff');
      }
      if (c.stop && this.isDriver(c)) this.deps.request({ kind: 'stopContact', action: 'arrest' });
    } else if (result === 'resist') {
      c.flags.add('resisted');
      this.line(c, 'system', 'The subject resists!');
      this.emitForce(c, 'struggle');
    } else {
      this.line(c, 'system', 'The subject is not ready: order them to stop or show their hands first.');
    }
  }

  /** `force:used` is declared by the scene module; the contact only emits it (a Phase 5 hook). */
  private emitForce(c: Contact, kind: 'cuff' | 'struggle'): void {
    (this.deps.bus as unknown as { emit(topic: string, payload: unknown): void }).emit('force:used', { kind, personId: c.personId, callId: c.callId });
  }

  private doUncuff(c: Contact): void {
    if (this.deps.npc.uncuff(c.actorId)) {
      this.deps.people.setCustody(c.personId, 'none');
      this.line(c, 'system', 'Handcuffs removed.');
    }
  }

  private doEscort(c: Contact, on: boolean): void {
    if (this.deps.npc.follow(c.actorId, on)) {
      this.line(c, 'system', on ? 'Escorting the subject.' : 'No longer escorting.');
    } else {
      this.line(c, 'system', 'The subject will not follow.');
    }
  }

  private doRelease(c: Contact, warn: boolean): void {
    const npc = this.deps.npc;
    const people = this.deps.people;
    const delta = clamp(c.memory.rapport * 0.25, -0.3, 0.3);
    const a = this.actorOf(c);
    if (a && a.cuffed && npc.uncuff(c.actorId)) people.setCustody(c.personId, 'none');
    if (warn) {
      this.emitFlag(c, 'warned');
      if (c.stop) this.deps.request({ kind: 'stopContact', action: 'warn' });
    }
    people.recordContact(c.personId, warn ? 'warned' : 'released', delta);
    this.line(c, 'system', warn ? 'Warned and released.' : 'Released.');
    const atStop = c.stop && c.vehicleId >= 0 && this.deps.stopVehicleId() === c.vehicleId;
    if (atStop && this.isDriver(c)) {
      // The whole stop ends once everybody sits in the car again.
      c.flags.add('releasing');
      this.sendBack(c.vehicleId);
      this.progressRelease(c);
      return;
    }
    if (atStop && c.actorId > 0) npc.applyCommand(c.actorId, 'returnToVehicle', 'comply');
    else if (c.actorId > 0) npc.applyCommand(c.actorId, 'release', 'comply');
    this.emitFlag(c, 'released');
    this.removeContact(c);
  }

  /** Orders everybody who stepped out of the stopped car back in. */
  private sendBack(vehicleId: number): void {
    const npc = this.deps.npc;
    const ids = npc.occupantsOf(vehicleId);
    for (let seat = 0; seat < ids.length; seat++) {
      if (!npc.isOut(vehicleId, seat)) continue;
      const actor = npc.actorOfPerson(ids[seat] as number);
      if (actor > 0) npc.applyCommand(actor, 'returnToVehicle', 'comply');
    }
  }

  /** True when everybody who can sit in the stopped car is seated (prisoners excluded). */
  private allSeated(vehicleId: number): boolean {
    const npc = this.deps.npc;
    const ids = npc.occupantsOf(vehicleId);
    for (let seat = 0; seat < ids.length; seat++) {
      if (!npc.isOut(vehicleId, seat)) continue;
      const custody = this.deps.people.state(ids[seat] as number).custody;
      if (custody === 'none' || custody === 'released' || custody === 'detained') return false;
    }
    return true;
  }

  /** Finishes a stop release once everybody is back in the car. */
  private progressRelease(c: Contact): void {
    if (!c.flags.has('releasing')) return;
    if (this.deps.stopVehicleId() !== c.vehicleId) {
      this.removeContact(c);
      return;
    }
    if (!this.allSeated(c.vehicleId)) return;
    this.deps.request({ kind: 'stopContact', action: 'release' });
    this.emitFlag(c, 'released');
    for (const other of this.contacts.slice()) {
      if (other !== c && other.vehicleId === c.vehicleId && other.stop) {
        this.deps.people.recordContact(other.personId, 'released', 0);
        this.emitFlag(other, 'released');
        this.removeContact(other);
      }
    }
    this.removeContact(c);
  }

  private doCage(vehicleIndex: number): void {
    const id = this.escorting();
    if (id === 0) return;
    const c = this.contacts.find((x) => x.actorId === id);
    if (!c) return;
    this.deps.npc.removeActor(id);
    this.deps.people.setCustody(c.personId, 'arrested');
    this.deps.people.recordContact(c.personId, 'arrested', -0.2);
    c.actorId = 0;
    this.line(c, 'system', 'Subject placed in the patrol car.');
    this.deps.bus.emit('contact:caged', { personId: c.personId, vehicleIndex, callId: c.callId });
    this.emitFlag(c, 'caged');
    this.removeContact(c);
  }

  private doCitation(c: Contact): void {
    const claim = c.memory.identity;
    this.deps.bus.emit('contact:openForm', {
      kind: 'citation',
      personId: claim && claim.personId >= 0 ? claim.personId : c.personId,
      vehicleId: c.vehicleId,
      callId: c.callId,
    });
    this.line(c, 'system', 'Opening the citation form.');
  }

  // --- Evidence --------------------------------------------------------------------------------

  /** Seizes `items` now: removed from their owner and recorded as finalized evidence documents. */
  private collect(c: Contact, items: readonly CarriedItem[]): void {
    const { cad, people } = this.deps;
    const officer = this.deps.officer();
    this.deps.officerPosition(this.opos);
    const call = c.callId > 0 ? cad.call(c.callId) : null;
    const foundAt = call ? call.location.text : this.deps.districtOf(this.opos.x, this.opos.z);
    const claim = c.memory.identity;
    for (const it of items) {
      const vehicle = it.instance.startsWith('v');
      const ownerId = Number(it.instance.slice(1, it.instance.indexOf(':')));
      if (Number.isInteger(ownerId)) people.seize({ kind: vehicle ? 'vehicle' : 'person', id: ownerId }, it.instance);
      const def = itemDef(it.item);
      const who = vehicle ? 'the vehicle' : claim ? claimName(claim) : 'an unidentified subject';
      const doc = cad.docs.create(
        'evidence',
        {
          description: `${def.label}, taken from ${who}`,
          category: evidenceCategoryOf(def.category),
          foundAt,
          custody: [{ game: this.t.game, action: 'collected', by: officer.name, note: `Collected by ${officer.name}` }],
          callId: c.callId > 0 ? c.callId : null,
        },
        this.t,
        `${officer.name} #${officer.badge}`,
      );
      try {
        cad.docs.finalize(doc.id, this.t);
      } catch {
        /* stays a draft the officer can complete in the MDT */
      }
    }
    this.line(c, 'system', `${items.length} item${items.length === 1 ? '' : 's'} seized as evidence.`);
  }

  private doSeize(c: Contact): void {
    const have = new Map<string, CarriedItem>();
    const subject = this.subjectOf(c);
    for (const it of subject.items) have.set(it.instance, it);
    for (const it of subject.vehicleItems) have.set(it.instance, it);
    const items: CarriedItem[] = [];
    for (const instance of c.found) {
      const it = have.get(instance);
      if (it) items.push(it);
    }
    c.found = [];
    if (items.length === 0) {
      this.line(c, 'system', 'Nothing left to seize.');
      return;
    }
    this.collect(c, items);
  }

  /** A final booking: the true identity is recorded against the person's incident (identityVsBooking). */
  private bookingFact(docId: string): void {
    const doc = this.deps.cad.docs.get(docId);
    if (!doc || doc.kind !== 'booking' || doc.personId < 0) return;
    const pid = doc.personId;
    const open = this.byPerson.get(pid);
    let incident = open?.incident ?? '';
    if (incident === '') {
      const all = this.deps.people.facts(pid);
      incident = all.length > 0 ? ((all[all.length - 1] as { incident: string }).incident) : '';
    }
    if (incident === '') return;
    const rec = this.deps.records.peekPerson(pid);
    this.storeFact(pid, incident, 'identity', String(pid), 'booking', `${displayName(rec)}, ${formatDate(rec.dob)}`, '');
    if (open) this.checkInconsistencies(open);
    this.rev++;
  }

  // --- Maintenance -----------------------------------------------------------------------------

  /** Drops contacts whose person left, attaches actors that appeared, and finishes stop releases. */
  private maintain(): void {
    const npc = this.deps.npc;
    for (const c of this.contacts.slice()) {
      if (c.flags.has('releasing')) {
        this.progressRelease(c);
        continue;
      }
      if (c.actorId > 0 && this.actorOf(c) === null) {
        // The actor is gone: re-seated, transported, left or caged by somebody else.
        c.actorId = 0;
        if (c.target.kind !== 'occupant' || npc.isOut(c.target.vehicleId, c.target.seat)) {
          this.removeContact(c);
          continue;
        }
      } else if (c.actorId === 0 && c.target.kind === 'occupant') {
        const id = npc.actorOfPerson(c.personId);
        if (id > 0) c.actorId = id;
      } else if (c.actorId === 0) {
        this.removeContact(c);
      }
    }
  }
}
