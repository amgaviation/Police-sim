/**
 * Incident command (Phase 6 design §11.3): command post, START triage, EMS / fire coordination, traffic control points,
 * evacuation, containment, the negotiation minigame, SWAT forwarding and resource needs. Fixed-step system (order -662);
 * every random draw comes from the injected `command` stream, vitals are pure per (seed, personId). Requests are queued
 * and applied at the start of the next `step`; the slow work (timers, port polling, flags) runs at 4 Hz on accumulated time.
 */
import type { CadTime } from '../cad/types';
import type { Rng } from '../core/rng';
import { ACTOR_STATE, type ActorInfo } from '../npc/types';
import type { DialogueView, NoteLine, TranscriptLine } from '../ui/dialogue/types';
import { unitType } from '../units/data';
import { COMMAND_CONFIG, NEGOTIATION_DATA } from './data';
import { circleZone, evacProgress, innerPosts, postSpot, tcpPoints } from './geometry';
import { commandLevel, resourceNeeds } from './levels';
import { negotiationOptions, negotiationTurn, newNegotiation } from './negotiation';
import { emptyCommandSave, type CommandSave, type CommandSaveVictim } from './save';
import { startTriage, transportOrder, victimVitals } from './triage';
import {
  TRIAGE_TAGS,
  type CommandBoard,
  type CommandConfig,
  type CommandContext,
  type CommandDeps,
  type CommandLevel,
  type CommandPostView,
  type CommandRequest,
  type NegSubject,
  type NegTone,
  type NegState,
  type NegotiationData,
  type PostSpec,
  type TriagePrompt,
  type TriageTag,
  type VictimRow,
  type Vitals,
} from './types';


/** Seconds of simulated time between two slow-work ticks. */
const WORK_S = 0.25;
/** Seconds between two automatic ambulance requests for patients left on scene. */
const SHUTTLE_S = 20;
/** Player distance to the incident that opens the post automatically. */
const AUTO_RANGE_M = 80;
/** Outer perimeter radius of a containment. */
const OUTER_PERIMETER_M = 150;
/** Seconds between attempts to staff a post nobody could take. */
const RETRY_STAFF_S = 10;
/** Seconds between two scans of the evacuation zone for actors to move. */
const EVAC_SCAN_S = 2;
/** Seconds between two lookups of scene participants while a victim's actor is still missing. */
const SYNC_S = 2;
/** Player distance to a traffic control point that counts as working it. */
const TCP_STAND_M = 6;
/** Drunk threshold for the subject bias of a negotiation. */
const BAC_THRESHOLD = 0.08;
/** Distance to the door at which a surrendering subject raises their hands. */
const DOOR_ARRIVE_M = 2.5;
/** A surrendering subject raises their hands after this long wherever they are. */
const SURRENDER_MAX_S = 40;
/** Id of the evacuation no-go zone of a call: this plus the call id. */
export const EVAC_ZONE_BASE_ID = 6_000_000;
/** Roles of people who leave an evacuated zone. */
const EVAC_ROLES: readonly string[] = ['bystander', 'caller', 'resident', 'crowd'];

const TAG_WORD: Readonly<Record<TriageTag, string>> = { minor: 'GREEN', delayed: 'YELLOW', immediate: 'RED', expectant: 'BLACK' };
const STATUS_INDEX: Readonly<Record<string, number>> = { available: 1, enRoute: 2, onScene: 3, busy: 4, outOfService: 5, transporting: 6 };

/** A wrong tag: the next one in the order immediate -> delayed -> minor -> immediate (black becomes red). */
function wrongTag(tag: TriageTag): TriageTag {
  return tag === 'immediate' ? 'delayed' : tag === 'delayed' ? 'minor' : 'immediate';
}

function newActorInfo(): ActorInfo {
  return {
    id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

interface Victim {
  personId: number;
  actorId: number;
  role: string;
  injured: boolean;
  label: string;
  vitals: Vitals;
  tag: TriageTag | null;
  by: 'player' | 'ems' | null;
  correct: boolean | null;
  transported: boolean;
}

interface PostState {
  callId: number;
  level: CommandLevel;
  x: number;
  z: number;
  commander: string;
}

interface Load {
  callsign: string;
  personIds: number[];
  t: number;
}

interface StaffPost {
  readonly spec: PostSpec;
  assigned: string | null;
  warned: boolean;
}

interface Assessing {
  personId: number;
  progress: number;
  ax: number;
  az: number;
  anchored: boolean;
}

interface EvacState {
  radiusM: number;
  clearedS: number;
  buildings: number;
  x: number;
  z: number;
}

type NegSession = NegState & { open: boolean; subjectPersonId: number };
type Zone = { id: number; points: Float32Array; minX: number; minZ: number; maxX: number; maxZ: number };

function levelPhrase(level: CommandLevel): string {
  return level === 'incident' ? 'incident' : `${level} incident`;
}

/** Incident command, triage, containment and negotiation of the player's call. */
export class CommandSystem {
  private readonly deps: CommandDeps;
  private readonly cfg: CommandConfig;
  private readonly data: NegotiationData = NEGOTIATION_DATA;
  private readonly rng: Rng;

  private rev = 0;
  private blockRev = 0;
  private queue: CommandRequest[] = [];
  private acc = 0;
  private declinedCall = 0;

  private ps: PostState | null = null;
  private family = '';
  private readonly sent = new Set<string>();

  private victims: Victim[] = [];
  private victimsBuilt = false;
  private syncT = 0;
  private assessing: Assessing | null = null;
  private emsCallsigns: string[] = [];
  private emsTimers: number[] = [];
  private loads: Load[] = [];
  private fireTimer = 0;
  /** Seconds until the next automatic ambulance request (patients wait, no ambulance is on scene or coming). */
  private shuttleT = 0;

  private tcpOn = false;
  private tcpPts: { x: number; z: number; yaw: number }[] = [];
  private blockadeList: { x: number; z: number; radius: number }[] = [];
  private staffPosts: StaffPost[] = [];
  private retryT = 0;

  private evac: EvacState | null = null;
  private evacBucket = -1;
  private evacScanT = 0;
  private zoneList: Zone[] = [];
  private contain = false;

  private neg: NegSession | null = null;
  private surrenderDone = true;
  private surrenderT = 0;
  private surrenderActor = -1;
  private swatSeen = false;
  private lastSig = 0;

  private readonly info = newActorInfo();
  private readonly scratchNames: string[] = [];
  private readonly scratchEms: string[] = [];
  private readonly scratchIds: number[] = [];

  private boardRev = -1;
  private boardCache: CommandBoard | null = null;
  private viewRev = -1;
  private viewCache: DialogueView | null = null;
  private hudRev = -1;
  private hudCache: string | null = null;
  private prompt: TriagePrompt | null = null;
  private promptRev = -1;

  constructor(deps: CommandDeps) {
    this.deps = deps;
    this.cfg = deps.config ?? COMMAND_CONFIG;
    this.rng = deps.rng;
  }

  // --- Public API --------------------------------------------------------------------------------------

  /** Bumps on every board change (rebuild the UI models when it differs). */
  get revision(): number {
    return this.rev;
  }

  /** Bumps when the traffic blockades (`blockades()`) change. */
  get blockadesRevision(): number {
    return this.blockRev;
  }

  /** Queues a request; it is applied at the start of the next `step`. */
  request(r: CommandRequest): void {
    this.queue.push(r);
  }

  /** The open command post of the player's call, null none. */
  post(): CommandPostView | null {
    const p = this.ps;
    return p ? { callId: p.callId, level: p.level, x: p.x, z: p.z, commander: p.commander } : null;
  }

  /** Is the call's command post open? */
  hasPost(callId?: number): boolean {
    return this.ps !== null && (callId === undefined || this.ps.callId === callId);
  }

  /** One fixed step (order -662). */
  step(dt: number, t: CadTime, ctx: CommandContext): void {
    if (this.queue.length > 0) {
      const q = this.queue;
      this.queue = [];
      for (let i = 0; i < q.length; i++) this.handle(q[i] as CommandRequest, t, ctx);
    }
    this.acc += dt;
    if (this.acc >= WORK_S) {
      const span = this.acc;
      this.acc = 0;
      this.work(span, t, ctx);
    }
  }

  /** The triage panel model: the victim being assessed, or null. */
  triage(): TriagePrompt | null {
    if (this.promptRev !== this.rev) {
      this.promptRev = this.rev;
      const a = this.assessing;
      const v = a ? this.find(a.personId) : null;
      if (!a || !v) this.prompt = null;
      else {
        this.prompt = {
          personId: v.personId,
          label: v.label,
          progress: Math.min(1, a.progress),
          vitals: a.progress >= 1 ? { ...v.vitals } : null,
          tag: v.tag,
        };
      }
    }
    return this.prompt;
  }

  /** The MDT Command tab model (rebuilt on revision). */
  board(): CommandBoard {
    if (this.boardCache && this.boardRev === this.rev) return this.boardCache;
    this.boardRev = this.rev;
    this.boardCache = this.buildBoard();
    return this.boardCache;
  }

  /** DialogueView for the DialoguePanel while the negotiation is open, else null (built on revision change only). */
  negotiationView(): DialogueView | null {
    if (this.viewRev !== this.rev) {
      this.viewRev = this.rev;
      this.viewCache = this.buildView();
    }
    return this.viewCache;
  }

  /** Trust of the negotiation on `callId`, 0 without one. */
  negotiationTrust(callId: number): number {
    return this.neg !== null && this.ps !== null && this.ps.callId === callId ? this.neg.trust : 0;
  }

  /** No-go zones of evacuation zones (merged by the integrator with the investigation tape zones). */
  zones(): readonly Zone[] {
    return this.zoneList;
  }

  /** Traffic control points as blockades for `traffic.setBlockades` (a new list only when `blockadesRevision` changes). */
  blockades(): readonly { x: number; z: number; radius: number }[] {
    return this.blockadeList;
  }

  /** HUD line, e.g. `ICS · DISASTER · RED 3 YEL 4 GRN 2 BLK 1 · EMS 2 en route · EVAC 60%`, null without a post. */
  hud(): string | null {
    if (this.hudRev !== this.rev) {
      this.hudRev = this.rev;
      this.hudCache = this.buildHud();
    }
    return this.hudCache;
  }

  /** Persisted state (the vitals are rebuilt from the seed). */
  serialize(): CommandSave {
    const s = emptyCommandSave(this.rng.state());
    const p = this.ps;
    if (p) s.post = { callId: p.callId, level: p.level, x: p.x, z: p.z, commander: p.commander };
    s.victims = this.victims.map(
      (v): CommandSaveVictim => ({
        personId: v.personId, actorId: v.actorId, role: v.role, injured: v.injured, tag: v.tag, by: v.by, correct: v.correct,
        trapped: v.vitals.trapped, contaminated: v.vitals.contaminated, transported: v.transported,
      }),
    );
    if (this.assessing) s.assessing = { personId: this.assessing.personId, progress: this.assessing.progress };
    s.emsTimers = this.emsCallsigns.map((c, i) => [c, this.emsTimers[i] ?? 0]);
    s.fireTimer = this.fireTimer;
    s.shuttleT = this.shuttleT;
    s.loads = this.loads.map((l) => ({ callsign: l.callsign, personIds: l.personIds.slice(), t: l.t }));
    s.tcp = { on: this.tcpOn, points: this.tcpPts.map((q): [number, number, number] => [q.x, q.z, q.yaw]) };
    if (this.evac) s.evac = { ...this.evac };
    s.contain = this.contain;
    if (this.neg) s.negotiation = { ...this.neg, history: this.neg.history.slice() };
    s.declinedCall = this.declinedCall;
    s.requests = this.queue.slice();
    return s;
  }

  /** Restores a saved state; no events are emitted. */
  restore(s: CommandSave): void {
    this.rng.restore(s.rng);
    this.reset();
    this.queue = s.requests.slice();
    this.declinedCall = s.declinedCall;
    if (s.post) {
      this.ps = { callId: s.post.callId, level: s.post.level as CommandLevel, x: s.post.x, z: s.post.z, commander: s.post.commander };
      this.family = this.deps.scene.familyOf(s.post.callId) ?? '';
    }
    this.victims = s.victims.map((v, i) => {
      const vitals = victimVitals(this.deps.seed, v.personId, v.role, v.injured ? 1 : 0, { trapped: false, hazmat: false });
      vitals.trapped = v.trapped;
      vitals.contaminated = v.contaminated;
      return {
        personId: v.personId, actorId: v.actorId, role: v.role, injured: v.injured, label: `Patient ${i + 1}`, vitals,
        tag: v.tag, by: v.by === 'player' || v.by === 'ems' ? v.by : null, correct: v.correct, transported: v.transported,
      };
    });
    this.victimsBuilt = this.victims.length > 0;
    if (s.assessing) this.assessing = { personId: s.assessing.personId, progress: s.assessing.progress, ax: 0, az: 0, anchored: false };
    for (const [c, tm] of s.emsTimers) {
      this.emsCallsigns.push(c);
      this.emsTimers.push(tm);
    }
    this.fireTimer = s.fireTimer;
    this.shuttleT = s.shuttleT ?? 0;
    this.loads = s.loads.map((l) => ({ callsign: l.callsign, personIds: l.personIds.slice(), t: l.t }));
    this.tcpOn = s.tcp.on;
    this.tcpPts = s.tcp.points.map(([x, z, yaw]) => ({ x, z, yaw }));
    this.evac = s.evac ? { ...s.evac } : null;
    this.contain = s.contain;
    if (s.negotiation) {
      this.neg = { ...s.negotiation, history: s.negotiation.history.slice() };
      this.surrenderDone = s.negotiation.outcome !== 'surrender';
      this.surrenderActor = -1;
    }
    if (this.ps) {
      this.rebuildBlockades();
      this.rebuildStaffSpecs();
      if (this.evac) this.zoneList = [this.makeZone(this.ps.callId, this.evac)];
    }
    this.rev++;
    this.blockRev++;
  }

  /** Drops every reference; no events are emitted. */
  dispose(): void {
    this.reset();
    this.queue = [];
  }

  // --- Requests ----------------------------------------------------------------------------------------

  private handle(r: CommandRequest, t: CadTime, ctx: CommandContext): void {
    if (r.kind === 'establish') {
      this.establish(r.callId ?? ctx.callId, t, ctx, true);
      return;
    }
    if (!this.ps) {
      this.flash('No command post. Establish command first.');
      return;
    }
    switch (r.kind) {
      case 'assess':
        this.startAssess(ctx);
        break;
      case 'tag':
        this.tagVictim(r.personId, r.tag, 'player', '');
        break;
      case 'tcp':
        if (r.on) this.enableTcp(this.cfg.tcp.radiusM);
        else this.disableTcp();
        break;
      case 'evacuate':
        this.startEvac();
        break;
      case 'contain':
        this.startContain();
        break;
      case 'requestNeeds':
        this.requestNeeds();
        break;
      case 'negotiationOpen':
        this.openNegotiation();
        break;
      case 'negotiationClose':
        if (this.neg && this.neg.open) {
          this.neg.open = false;
          this.rev++;
        }
        break;
      case 'negotiate':
        this.negotiate(r.optionId, r.tone);
        break;
      case 'swat':
        this.flash(this.deps.backup.swat(this.ps.callId, r.command, r.plan));
        break;
      case 'standDown':
        this.closePost('standDown');
        break;
    }
  }

  // --- Post --------------------------------------------------------------------------------------------

  private playerCallsign(): string {
    return this.deps.cad.playerUnit()?.callsign ?? 'Unit';
  }

  private unitsOnScene(callId: number): number {
    const call = this.deps.cad.call(callId);
    if (!call) return 0;
    let n = 0;
    for (let i = 0; i < call.units.length; i++) if (this.deps.cad.unit(call.units[i] as string)?.status === 'onScene') n++;
    return n;
  }

  private autoEstablish(t: CadTime, ctx: CommandContext): void {
    if (!this.cfg.post.autoOnArrival || ctx.callId <= 0 || ctx.callId === this.declinedCall) return;
    const call = this.deps.cad.call(ctx.callId);
    if (!call || call.status === 'closed') return;
    if (Math.hypot(ctx.x - call.location.x, ctx.z - call.location.z) > AUTO_RANGE_M) return;
    if (!this.deps.scene.hasScenario(ctx.callId)) return;
    const fam = this.deps.scene.familyOf(ctx.callId) ?? '';
    if (commandLevel(fam, this.unitsOnScene(ctx.callId), this.cfg) === 'none') return;
    this.establish(ctx.callId, t, ctx, false);
  }

  private establish(callId: number, _t: CadTime, ctx: CommandContext, manual: boolean): void {
    const call = callId > 0 ? this.deps.cad.call(callId) : null;
    if (!call || call.status === 'closed') {
      if (manual) this.flash('No active call to command.');
      return;
    }
    if (this.ps && this.ps.callId === callId) {
      if (manual) this.flash('The command post is already established.');
      return;
    }
    if (this.ps) this.closePost('moved');
    if (manual) this.declinedCall = 0;
    const family = this.deps.scene.familyOf(callId) ?? '';
    let level = commandLevel(family, this.unitsOnScene(callId), this.cfg);
    if (level === 'none') level = 'incident';
    const spot = postSpot(this.deps.graph, call.location.x, call.location.z, ctx.x, ctx.z, this.cfg.post.standoffM);
    const cs = this.playerCallsign();
    this.ps = { callId, level, x: spot.x, z: spot.z, commander: cs };
    this.family = family;
    this.setFlag('commandPost');
    if (family === 'massCasualty') this.setFlag('icsTransport');
    this.deps.bus.emit('command:post', { callId, level, x: spot.x, z: spot.z, open: true });
    this.radio('dispatch', cs, `${cs}, establishing command at ${call.location.near}, ${levelPhrase(level)}.`);
    const flags = this.deps.scene.flagsOf(callId);
    if (flags && (flags.has('roadway') || flags.has('hazmat'))) this.enableTcp(this.cfg.tcp.radiusM);
    if (family === 'barricade') this.startContain();
    this.rev++;
  }

  private closePost(reason: 'closed' | 'standDown' | 'moved'): void {
    const p = this.ps;
    if (!p) return;
    this.deps.bus.emit('command:post', { callId: p.callId, level: p.level, x: p.x, z: p.z, open: false });
    this.deps.backup.clearPosts();
    if (reason === 'standDown') {
      this.declinedCall = p.callId;
      this.flash('Command post stood down.');
    }
    const hadBlockades = this.blockadeList.length > 0;
    this.reset();
    if (hadBlockades) this.blockRev++;
    this.rev++;
  }

  private reset(): void {
    this.ps = null;
    this.family = '';
    this.sent.clear();
    this.victims = [];
    this.victimsBuilt = false;
    this.syncT = 0;
    this.assessing = null;
    this.emsCallsigns = [];
    this.emsTimers = [];
    this.loads = [];
    this.fireTimer = 0;
    this.shuttleT = 0;
    this.tcpOn = false;
    this.tcpPts = [];
    this.blockadeList = [];
    this.staffPosts = [];
    this.retryT = 0;
    this.evac = null;
    this.evacBucket = -1;
    this.evacScanT = 0;
    this.zoneList = [];
    this.contain = false;
    this.neg = null;
    this.surrenderDone = true;
    this.surrenderT = 0;
    this.surrenderActor = -1;
    this.swatSeen = false;
    this.lastSig = 0;
  }

  private setFlag(flag: string): void {
    const p = this.ps;
    if (!p || this.sent.has(flag)) return;
    if (this.deps.scene.flagsOf(p.callId)?.has(flag)) {
      this.sent.add(flag);
      return;
    }
    this.sent.add(flag);
    this.deps.scene.request({ kind: 'commandFlag', callId: p.callId, flag });
  }

  private radio(channel: 'dispatch' | 'tac' | 'fireEms', speaker: string, text: string): void {
    this.deps.bus.emit('command:radio', { channel, speaker, text });
  }

  private flash(text: string): void {
    if (text.length > 0) this.deps.bus.emit('command:flash', { text });
  }

  // --- Slow work ---------------------------------------------------------------------------------------

  private work(dt: number, t: CadTime, ctx: CommandContext): void {
    const p = this.ps;
    if (!p) {
      this.autoEstablish(t, ctx);
      return;
    }
    const call = this.deps.cad.call(p.callId);
    if (!call || call.status === 'closed') {
      this.closePost('closed');
      return;
    }
    if (this.family === '') this.family = this.deps.scene.familyOf(p.callId) ?? '';
    this.refreshCommander(p);
    this.buildVictims(p, dt);
    this.tickAssess(dt, ctx);
    this.tickCrews(p, dt);
    this.tickShuttle(p, dt);
    this.tickFire(p, dt);
    this.tickPosts(dt, ctx);
    this.tickEvac(p, dt);
    this.tickNegotiation(p, dt);
    this.tickSwat(p);
    this.updateFlags();
    this.tickSignature(p);
  }

  private refreshCommander(p: PostState): void {
    const res = this.deps.resources;
    let name = this.playerCallsign();
    for (const type of ['chief', 'lieutenant'] as const) {
      if (res.onScene(p.callId, type) > 0) {
        const first = res.onSceneUnits(p.callId, type, this.scratchNames)[0];
        if (first !== undefined) {
          name = first;
          break;
        }
      }
    }
    if (name === p.commander) return;
    p.commander = name;
    if (name !== this.playerCallsign()) this.radio('tac', name, `${name} assuming command.`);
    this.rev++;
  }

  private updateFlags(): void {
    if (this.victims.length === 0) return;
    let all = true;
    let red = 0;
    let redDone = 0;
    for (let i = 0; i < this.victims.length; i++) {
      const v = this.victims[i] as Victim;
      if (v.tag === null) all = false;
      else if (v.tag === 'immediate') {
        red++;
        if (v.transported) redDone++;
      }
    }
    if (!all) return;
    this.setFlag('triaged');
    if (red > 0 && redDone === red) this.setFlag('transportedRed');
  }

  private tickSignature(p: PostState): void {
    const call = this.deps.cad.call(p.callId);
    let sig = this.deps.resources.onScene(p.callId, 'ems') * 7 + this.deps.resources.onScene(p.callId, 'fire') * 31;
    if (call) {
      for (let i = 0; i < call.units.length; i++) {
        const u = this.deps.cad.unit(call.units[i] as string);
        if (!u) continue;
        sig += (STATUS_INDEX[u.status] ?? 0) * (i + 3);
        if (u.status === 'enRoute' && this.deps.eta) sig += Math.floor(Math.max(0, this.deps.eta(u.callsign)) / 10) * 101;
      }
    }
    sig += this.deps.backup.staffed('tcp') * 1009 + this.deps.backup.staffed('inner') * 2003 + this.deps.backup.staffed('evac') * 4001;
    const phase = this.deps.backup.swatPhase(p.callId);
    sig += phase === null ? 0 : 8009 + phase.length * 13 + phase.charCodeAt(0);
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.rev++;
    }
  }

  // --- Victims and triage ------------------------------------------------------------------------------

  private find(personId: number): Victim | null {
    for (let i = 0; i < this.victims.length; i++) if ((this.victims[i] as Victim).personId === personId) return this.victims[i] as Victim;
    return null;
  }

  private buildVictims(p: PostState, dt: number): void {
    if (this.victimsBuilt) {
      let missing = false;
      for (let i = 0; i < this.victims.length; i++) if ((this.victims[i] as Victim).actorId <= 0) missing = true;
      if (!missing) return;
      this.syncT += dt;
      if (this.syncT < SYNC_S) return;
      this.syncT = 0;
      for (const part of this.deps.scene.participants(p.callId)) {
        const v = this.find(part.personId);
        if (v && v.actorId <= 0 && part.actorId > 0) v.actorId = part.actorId;
      }
      return;
    }
    if (!this.deps.scene.hasScenario(p.callId)) return;
    const parts = this.deps.scene.participants(p.callId);
    if (parts.length === 0) return;
    const flags = this.deps.scene.flagsOf(p.callId);
    const rf = { trapped: flags?.has('trapped') === true, hazmat: flags?.has('hazmat') === true };
    for (const part of parts) {
      if (!this.cfg.triage.roles.includes(part.role)) continue;
      this.victims.push({
        personId: part.personId,
        actorId: part.actorId,
        role: part.role,
        injured: part.injured,
        label: `Patient ${this.victims.length + 1}`,
        vitals: victimVitals(this.deps.seed, part.personId, part.role, part.injured ? 1 : 0, rf),
        tag: null,
        by: null,
        correct: null,
        transported: false,
      });
    }
    this.victimsBuilt = true;
    this.rev++;
  }

  private startAssess(ctx: CommandContext): void {
    if (!ctx.onFoot) {
      this.flash('Get out of the vehicle to assess a patient.');
      return;
    }
    let best: Victim | null = null;
    let bestD = this.cfg.triage.rangeM;
    for (let i = 0; i < this.victims.length; i++) {
      const v = this.victims[i] as Victim;
      if (v.tag !== null || v.transported || v.actorId <= 0) continue;
      if (!this.deps.npc.actor(v.actorId, this.info)) continue;
      const d = Math.hypot(this.info.x - ctx.x, this.info.z - ctx.z);
      if (d <= bestD) {
        bestD = d;
        best = v;
      }
    }
    if (!best) {
      this.flash('No untagged patient within reach.');
      return;
    }
    this.assessing = { personId: best.personId, progress: this.cfg.triage.assessS > 0 ? 0 : 1, ax: ctx.x, az: ctx.z, anchored: true };
    this.rev++;
  }

  private tickAssess(dt: number, ctx: CommandContext): void {
    const a = this.assessing;
    if (!a) return;
    const v = this.find(a.personId);
    if (!v || v.tag !== null || v.transported || !ctx.onFoot || !this.deps.npc.actor(v.actorId, this.info)) {
      this.cancelAssess(a);
      return;
    }
    if (!a.anchored) {
      a.ax = ctx.x;
      a.az = ctx.z;
      a.anchored = true;
    }
    const far = Math.hypot(this.info.x - ctx.x, this.info.z - ctx.z) > this.cfg.triage.rangeM + 1;
    const moved = Math.hypot(ctx.x - a.ax, ctx.z - a.az) > 1;
    if (far || (moved && a.progress < 1)) {
      this.cancelAssess(a);
      return;
    }
    if (a.progress < 1) {
      a.progress = this.cfg.triage.assessS > 0 ? Math.min(1, a.progress + dt / this.cfg.triage.assessS) : 1;
      if (a.progress >= 1) this.flash(`${v.label}: assessment complete.`);
      this.rev++;
    }
  }

  private cancelAssess(a: Assessing): void {
    if (a.progress < 1) this.flash('Assessment interrupted.');
    this.assessing = null;
    this.rev++;
  }

  private tagVictim(personId: number, tag: TriageTag, by: 'player' | 'ems', unit: string): void {
    const p = this.ps;
    const v = this.find(personId);
    if (!p || !v || v.transported || !(TRIAGE_TAGS as readonly string[]).includes(tag)) {
      if (by === 'player') this.flash('No such patient.');
      return;
    }
    const answer = startTriage(v.vitals);
    v.tag = tag;
    v.by = by;
    v.correct = tag === answer;
    if (this.assessing && this.assessing.personId === personId) this.assessing = null;
    this.deps.bus.emit('command:triage', { callId: p.callId, personId, tag, correct: v.correct, by });
    if (by === 'player') this.flash(v.correct ? `Tagged ${TAG_WORD[tag]}: correct.` : `Tagged ${TAG_WORD[tag]}: START says ${TAG_WORD[answer]}.`);
    else this.radio('fireEms', unit, `${unit}, ${v.label.toLowerCase()} tagged ${TAG_WORD[tag].toLowerCase()}.`);
    this.rev++;
    this.updateFlags();
  }

  // --- EMS and fire --------------------------------------------------------------------------------------

  private isReachable(v: Victim): boolean {
    return !v.transported && !v.vitals.trapped && !v.vitals.contaminated;
  }

  private nextUntagged(): Victim | null {
    for (let i = 0; i < this.victims.length; i++) {
      const v = this.victims[i] as Victim;
      if (v.tag === null && this.isReachable(v)) return v;
    }
    return null;
  }

  private reserved(personId: number): boolean {
    for (let i = 0; i < this.loads.length; i++) if ((this.loads[i] as Load).personIds.includes(personId)) return true;
    return false;
  }

  private anyTransportable(): boolean {
    for (let i = 0; i < this.victims.length; i++) {
      const v = this.victims[i] as Victim;
      if (v.tag !== null && v.tag !== 'expectant' && this.isReachable(v) && !this.reserved(v.personId)) return true;
    }
    return false;
  }

  private emsTimerIndex(callsign: string): number {
    let i = this.emsCallsigns.indexOf(callsign);
    if (i < 0) {
      i = this.emsCallsigns.length;
      this.emsCallsigns.push(callsign);
      this.emsTimers.push(0);
    }
    return i;
  }

  private tickCrews(p: PostState, dt: number): void {
    const units = this.deps.resources.onSceneUnits(p.callId, 'ems', this.scratchEms);
    // Units that left take their timers and reservations with them.
    for (let i = this.emsCallsigns.length - 1; i >= 0; i--) {
      if (!units.includes(this.emsCallsigns[i] as string)) {
        this.emsCallsigns.splice(i, 1);
        this.emsTimers.splice(i, 1);
      }
    }
    for (let i = this.loads.length - 1; i >= 0; i--) {
      if (!units.includes((this.loads[i] as Load).callsign)) {
        this.loads.splice(i, 1);
        this.rev++;
      }
    }
    for (let k = 0; k < units.length; k++) {
      const cs = units[k] as string;
      const load = this.loads.find((l) => l.callsign === cs);
      if (load) {
        load.t += dt;
        if (load.t >= this.cfg.transport.loadS) this.completeLoad(load);
        continue;
      }
      if (this.nextUntagged() !== null) {
        const idx = this.emsTimerIndex(cs);
        const timer = (this.emsTimers[idx] as number) + dt;
        if (timer >= this.cfg.triage.aiAssessS) {
          this.emsTimers[idx] = 0;
          const target = this.nextUntagged();
          if (target) {
            const answer = startTriage(target.vitals);
            const wrong = this.rng.next() < this.cfg.triage.aiErrorRate;
            this.tagVictim(target.personId, wrong ? wrongTag(answer) : answer, 'ems', cs);
          }
        } else this.emsTimers[idx] = timer;
        continue;
      }
      const idx = this.emsCallsigns.indexOf(cs);
      if (idx >= 0) this.emsTimers[idx] = 0;
      if (this.anyTransportable()) this.startLoad(cs);
    }
  }

  /**
   * An ambulance that transported a patient is gone for the round trip: while patients still wait and no ambulance is on
   * scene or on its way (a request for an assigned type is a no-op), the next one is called without the player asking again.
   */
  private tickShuttle(p: PostState, dt: number): void {
    this.shuttleT -= dt;
    if (this.shuttleT > 0 || !this.victims.some((v) => v.transported) || !this.anyTransportable()) return;
    if (this.deps.resources.onScene(p.callId, 'ems') > 0) return;
    this.shuttleT = SHUTTLE_S;
    this.deps.resources.requestType('ems', p.callId, 'auto');
  }

  private startLoad(callsign: string): void {
    const cand = this.victims
      .filter((v) => !this.reserved(v.personId))
      .map((v) => ({ personId: v.personId, tag: v.tag, transported: v.transported, trapped: v.vitals.trapped, contaminated: v.vitals.contaminated }));
    const order = transportOrder(cand);
    const first = order[0];
    if (first === undefined) return;
    const tag = this.find(first)?.tag;
    if (!tag || tag === 'expectant') return;
    const take: number[] = [];
    for (const id of order) {
      if (take.length >= this.cfg.transport.perUnit[tag]) break;
      if (this.find(id)?.tag === tag) take.push(id);
    }
    this.loads.push({ callsign, personIds: take, t: 0 });
    this.rev++;
  }

  private completeLoad(load: Load): void {
    const i = this.loads.indexOf(load);
    if (i >= 0) this.loads.splice(i, 1);
    const firstId = load.personIds[0];
    if (firstId === undefined || !this.deps.resources.transport(load.callsign, firstId)) {
      this.rev++;
      return;
    }
    for (let k = 0; k < load.personIds.length; k++) {
      const v = this.find(load.personIds[k] as number);
      if (!v) continue;
      v.transported = true;
      if (k > 0 && v.actorId > 0) this.deps.npc.removeActor(v.actorId);
    }
    const n = load.personIds.length;
    const tag = this.find(firstId)?.tag ?? 'delayed';
    this.radio('fireEms', load.callsign, `${load.callsign}, transporting ${n} ${TAG_WORD[tag].toLowerCase()} patient${n === 1 ? '' : 's'} to the hospital.`);
    this.rev++;
    this.updateFlags();
  }

  private tickFire(p: PostState, dt: number): void {
    const n = this.deps.resources.onScene(p.callId, 'fire');
    if (n <= 0) {
      this.fireTimer = 0;
      return;
    }
    let target: Victim | null = null;
    let freeing = true;
    for (let i = 0; i < this.victims.length && !target; i++) {
      const v = this.victims[i] as Victim;
      if (!v.transported && v.vitals.trapped) target = v;
    }
    if (!target) {
      freeing = false;
      for (let i = 0; i < this.victims.length && !target; i++) {
        const v = this.victims[i] as Victim;
        if (!v.transported && v.vitals.contaminated) target = v;
      }
    }
    if (!target) {
      this.fireTimer = 0;
      return;
    }
    this.fireTimer += dt * n;
    const need = freeing ? this.cfg.fire.extricateS : this.cfg.fire.deconS;
    if (this.fireTimer < need) return;
    this.fireTimer -= need;
    if (freeing) target.vitals.trapped = false;
    else target.vitals.contaminated = false;
    const cs = this.deps.resources.onSceneUnits(p.callId, 'fire', this.scratchNames)[0] ?? 'ENGINE';
    this.radio('fireEms', cs, `${cs}, one patient ${freeing ? 'extricated' : 'decontaminated'}.`);
    this.rev++;
  }

  // --- Posts: traffic control, evacuation, containment --------------------------------------------------

  private incident(p: PostState): { x: number; z: number } {
    const call = this.deps.cad.call(p.callId);
    return call ? call.location : p;
  }

  private rebuildBlockades(): void {
    this.blockadeList = this.tcpOn ? this.tcpPts.map((q) => ({ x: q.x, z: q.z, radius: this.cfg.tcp.blockadeRadiusM })) : [];
  }

  private addStaffPost(spec: PostSpec): void {
    const sp: StaffPost = { spec, assigned: null, warned: false };
    this.staffPosts.push(sp);
    this.tryStaff(sp);
  }

  private tryStaff(sp: StaffPost): void {
    sp.assigned = this.deps.backup.staffPost(sp.spec);
    if (sp.assigned === null && !sp.warned) {
      sp.warned = true;
      const word = sp.spec.kind === 'tcp' ? 'TCP' : sp.spec.kind === 'inner' ? 'Inner post' : 'Evacuation post';
      this.flash(`${word} ${sp.spec.id.replace(/^\D+/, '')} unstaffed. Request backup.`);
    }
  }

  /**
   * Rebuilds the post specs after a restore. They start unassigned and are re-asserted by the retry tick (the backup
   * module keeps a post per id, so asking again for a staffed post just returns its officer).
   */
  private rebuildStaffSpecs(): void {
    const p = this.ps;
    this.staffPosts = [];
    this.retryT = 0;
    if (!p) return;
    const specs: PostSpec[] = [];
    if (this.tcpOn) this.tcpPts.forEach((q, i) => specs.push({ id: `tcp${i + 1}`, x: q.x, z: q.z, yaw: q.yaw, kind: 'tcp' }));
    if (this.contain) specs.push(...this.innerSpecs(p));
    if (this.evac) specs.push(...this.evacSpecs(this.evac));
    for (const spec of specs) this.staffPosts.push({ spec, assigned: null, warned: true });
  }

  private innerSpecs(p: PostState): PostSpec[] {
    const bid = this.deps.scene.buildingOfCall(p.callId);
    const b = bid >= 0 ? this.deps.building(bid) : null;
    const inc = this.incident(p);
    const rect = b ?? { minX: inc.x - 10, minZ: inc.z - 10, maxX: inc.x + 10, maxZ: inc.z + 10 };
    return innerPosts(rect, this.cfg.inner.offsetM).map((q, i) => ({ id: `inner${i + 1}`, x: q.x, z: q.z, yaw: q.yaw, kind: 'inner' as const }));
  }

  private evacSpecs(e: EvacState): PostSpec[] {
    return [
      { id: 'evac1', x: e.x + e.radiusM, z: e.z, yaw: Math.atan2(e.radiusM, 0), kind: 'evac' },
      { id: 'evac2', x: e.x - e.radiusM, z: e.z, yaw: Math.atan2(-e.radiusM, 0), kind: 'evac' },
    ];
  }

  private enableTcp(radiusM: number): void {
    const p = this.ps;
    if (!p || this.tcpOn) return;
    const inc = this.incident(p);
    this.tcpPts = tcpPoints(this.deps.graph, inc.x, inc.z, radiusM, this.cfg.tcp.max).map((q) => ({ x: q.x, z: q.z, yaw: q.yaw }));
    this.tcpOn = true;
    this.rebuildBlockades();
    if (this.tcpPts.length === 0) this.flash('No traffic control points found around the scene.');
    else this.flash(`Traffic control: ${this.tcpPts.length} points.`);
    this.tcpPts.forEach((q, i) => this.addStaffPost({ id: `tcp${i + 1}`, x: q.x, z: q.z, yaw: q.yaw, kind: 'tcp' }));
    this.blockRev++;
    this.rev++;
  }

  private disableTcp(): void {
    if (!this.tcpOn) return;
    this.tcpOn = false;
    this.tcpPts = [];
    this.blockadeList = [];
    this.staffPosts = this.staffPosts.filter((s) => s.spec.kind !== 'tcp');
    this.deps.backup.clearPosts('tcp');
    this.flash('Traffic control released.');
    this.blockRev++;
    this.rev++;
  }

  private startContain(): void {
    const p = this.ps;
    if (!p || this.contain) return;
    this.contain = true;
    for (const sp of this.innerSpecs(p)) this.addStaffPost(sp);
    if (!this.tcpOn) this.enableTcp(OUTER_PERIMETER_M);
    this.flash('Containing the location.');
    this.rev++;
  }

  private makeZone(callId: number, e: EvacState): Zone {
    return circleZone(EVAC_ZONE_BASE_ID + callId, e.x, e.z, e.radiusM, this.cfg.evac.segments);
  }

  private startEvac(): void {
    const p = this.ps;
    if (!p) return;
    if (this.evac) {
      this.flash('Evacuation is already under way.');
      return;
    }
    const flags = this.deps.scene.flagsOf(p.callId);
    const r = this.cfg.evac.radiusM;
    const radiusM = flags?.has('hazmat') ? r.hazmat : flags?.has('package') ? r.package : this.family === 'barricade' ? r.barricade : r.default;
    const inc = this.incident(p);
    this.evac = { radiusM, clearedS: 0, buildings: this.deps.buildingsNear(inc.x, inc.z, radiusM), x: inc.x, z: inc.z };
    this.zoneList = [this.makeZone(p.callId, this.evac)];
    this.evacBucket = -1;
    this.evacScanT = EVAC_SCAN_S;
    for (const sp of this.evacSpecs(this.evac)) this.addStaffPost(sp);
    this.flash(`Evacuating ${this.evac.buildings} buildings within ${Math.round(radiusM)} m.`);
    this.rev++;
  }

  private tickPosts(dt: number, ctx: CommandContext): void {
    this.retryT += dt;
    if (this.retryT >= RETRY_STAFF_S) {
      this.retryT = 0;
      for (let i = 0; i < this.staffPosts.length; i++) {
        const sp = this.staffPosts[i] as StaffPost;
        if (sp.assigned === null) this.tryStaff(sp);
      }
    }
    const backup = this.deps.backup;
    if (this.tcpOn && this.tcpPts.length > 0) {
      let stand = false;
      for (let i = 0; i < this.tcpPts.length && !stand; i++) {
        const q = this.tcpPts[i] as { x: number; z: number };
        stand = Math.hypot(ctx.x - q.x, ctx.z - q.z) <= TCP_STAND_M;
      }
      const tcpOk = backup.staffed('tcp') >= Math.min(2, this.tcpPts.length);
      if (tcpOk || stand) this.setFlag('trafficControl');
      if (this.contain && tcpOk) this.setFlag('perimeter');
    }
    if (this.contain && backup.staffed('inner') >= 2) this.setFlag('contained');
  }

  private tickEvac(p: PostState, dt: number): void {
    const e = this.evac;
    if (!e) return;
    if (this.evacProgressNow(e) >= 1) {
      this.setFlag('evacuated');
      return;
    }
    e.clearedS += dt * (this.deps.backup.staffed('evac') + 1 + this.cfg.evac.fireFactor * this.deps.resources.onScene(p.callId, 'fire'));
    this.evacScanT += dt;
    if (this.evacScanT >= EVAC_SCAN_S) {
      this.evacScanT = 0;
      this.sendAwayBystanders(p, e);
    }
    const progress = this.evacProgressNow(e);
    if (progress >= 1) {
      this.setFlag('evacuated');
      this.flash('Evacuation complete.');
      this.evacBucket = 20;
      this.rev++;
    } else {
      const bucket = Math.floor(progress * 20);
      if (bucket !== this.evacBucket) {
        this.evacBucket = bucket;
        this.rev++;
      }
    }
  }

  private evacProgressNow(e: EvacState): number {
    return evacProgress(e.clearedS, e.buildings, this.cfg.evac.buildingS);
  }

  private sendAwayBystanders(p: PostState, e: EvacState): void {
    const ids = this.deps.npc.actorsOfCall(p.callId, this.scratchIds);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as number;
      const a = this.deps.npc.actor(id, this.info);
      if (!a || !EVAC_ROLES.includes(a.role) || a.state === ACTOR_STATE.leave) continue;
      if (Math.hypot(a.x - e.x, a.z - e.z) <= e.radiusM) this.deps.npc.forceState(id, 'leave');
    }
  }

  // --- Needs ---------------------------------------------------------------------------------------------

  /** Counts for `resourceNeeds`: untagged patients count as delayed until they are triaged. */
  private needsNow(p: PostState | null): { ems: number; fire: number; supervisor: number } {
    let immediate = 0;
    let delayed = 0;
    let trapped = 0;
    for (let i = 0; i < this.victims.length; i++) {
      const v = this.victims[i] as Victim;
      if (v.transported) continue;
      if (v.vitals.trapped) trapped++;
      if (v.tag === 'immediate') immediate++;
      else if (v.tag === 'delayed' || v.tag === null) delayed++;
    }
    const res = this.deps.resources;
    const cid = p ? p.callId : 0;
    return resourceNeeds(
      {
        immediate, delayed, trapped,
        hazmat: p ? this.deps.scene.flagsOf(cid)?.has('hazmat') === true : false,
        onSceneEms: p ? res.onScene(cid, 'ems') : 0,
        onSceneFire: p ? res.onScene(cid, 'fire') : 0,
        supervisor: p ? res.supervisorFor(cid) !== null : false,
      },
      this.cfg,
    );
  }

  private requestNeeds(): void {
    const p = this.ps;
    if (!p) return;
    const n = this.needsNow(p);
    for (let i = 0; i < n.ems; i++) this.deps.resources.requestType('ems', p.callId, 'mdt');
    for (let i = 0; i < n.fire; i++) this.deps.resources.requestType('fire', p.callId, 'mdt');
    for (let i = 0; i < n.supervisor; i++) this.deps.resources.requestType('supervisor', p.callId, 'mdt');
    if (n.ems + n.fire + n.supervisor === 0) this.flash('No additional resources needed.');
    else this.flash(`Requested EMS ${n.ems}, fire ${n.fire}, supervisor ${n.supervisor}.`);
  }

  // --- Negotiation and SWAT -------------------------------------------------------------------------------

  private openNegotiation(): void {
    const p = this.ps;
    if (!p) return;
    if (this.family !== 'barricade') {
      this.flash('There is no barricaded subject to negotiate with.');
      return;
    }
    if (this.neg && this.neg.outcome !== 'ongoing') {
      this.flash('The negotiation has ended.');
      return;
    }
    const subject = this.deps.scene.participants(p.callId).find((q) => q.role === 'subject');
    if (!subject) {
      this.flash('No subject to negotiate with.');
      return;
    }
    if (!this.neg) this.neg = { ...newNegotiation(this.cfg, this.data), open: true, subjectPersonId: subject.personId };
    else this.neg.open = true;
    this.deps.bus.emit('command:negotiation', { callId: p.callId, outcome: this.neg.outcome, trust: this.neg.trust, agitation: this.neg.agitation });
    this.rev++;
  }

  private negotiate(optionId: string, tone: NegTone): void {
    const p = this.ps;
    const neg = this.neg;
    if (!p || !neg || !neg.open) {
      this.flash('Open the negotiation line first.');
      return;
    }
    if (neg.outcome !== 'ongoing') return;
    if (!this.data.categories.some((c) => c.options.some((o) => o.id === optionId))) {
      this.flash('Unknown negotiation option.');
      return;
    }
    const parts = this.deps.scene.participants(p.callId);
    const subjectPart = parts.find((q) => q.role === 'subject');
    const id = subjectPart ? this.deps.people.identity(subjectPart.personId) : null;
    const subject: NegSubject = {
      temperament: id ? id.temperament : 'calm',
      hostage: parts.some((q) => q.role === 'hostage'),
      intoxicated: subjectPart ? this.deps.people.intoxication(subjectPart.personId).bac > BAC_THRESHOLD : false,
      crisis: id ? id.mental !== 'none' : false,
    };
    const onScene = this.deps.resources.onScene(p.callId, 'negotiator') > 0;
    negotiationTurn(neg, optionId, tone, subject, onScene, this.rng, this.cfg, this.data);
    this.deps.bus.emit('command:negotiation', { callId: p.callId, outcome: neg.outcome, trust: neg.trust, agitation: neg.agitation });
    this.rev++;
    this.afterOutcome(p, neg, subjectPart ? subjectPart.actorId : 0);
  }

  private afterOutcome(p: PostState, neg: NegSession, subjectActor: number): void {
    const cs = this.playerCallsign();
    if (neg.outcome === 'surrender') {
      this.setFlag('negotiated');
      this.radio('tac', cs, `${cs}, the subject is surrendering and coming out.`);
      this.surrenderDone = false;
      this.surrenderT = 0;
      this.surrenderActor = subjectActor > 0 ? subjectActor : -1;
      this.sendOut(p);
    } else if (neg.outcome === 'breakdown') {
      this.radio('tac', cs, `${cs}, negotiations have broken down.`);
      if (this.deps.resources.onScene(p.callId, 'swat') > 0) this.flash(this.deps.backup.swat(p.callId, 'stack'));
      else this.flash('Negotiations have broken down. Request SWAT.');
    } else if (neg.outcome === 'stalled') {
      this.flash('The negotiation has stalled.');
    }
  }

  /** Tells the surrendering subject to walk to the door. */
  private sendOut(p: PostState): void {
    if (this.surrenderActor <= 0) return;
    const bid = this.deps.scene.buildingOfCall(p.callId);
    const door = (bid >= 0 ? this.deps.building(bid) : null)?.door;
    if (door) this.deps.npc.walkTo(this.surrenderActor, door.x, door.z);
  }

  private tickNegotiation(p: PostState, dt: number): void {
    const neg = this.neg;
    if (!neg || neg.outcome !== 'surrender' || this.surrenderDone) return;
    if (this.surrenderActor <= 0) {
      const part = this.deps.scene.participants(p.callId).find((q) => q.role === 'subject');
      this.surrenderActor = part && part.actorId > 0 ? part.actorId : -1;
      if (this.surrenderActor <= 0) {
        this.surrenderDone = true;
        return;
      }
      this.sendOut(p);
    }
    this.surrenderT += dt;
    const a = this.deps.npc.actor(this.surrenderActor, this.info);
    if (!a || a.state === ACTOR_STATE.handsUp || a.cuffed) {
      this.surrenderDone = true;
      return;
    }
    const bid = this.deps.scene.buildingOfCall(p.callId);
    const door = (bid >= 0 ? this.deps.building(bid) : null)?.door;
    const arrived = door ? Math.hypot(a.x - door.x, a.z - door.z) <= DOOR_ARRIVE_M : false;
    if (arrived || this.surrenderT >= SURRENDER_MAX_S) {
      this.deps.npc.forceState(this.surrenderActor, 'handsUp');
      this.surrenderDone = true;
    }
  }

  private tickSwat(p: PostState): void {
    if (!this.swatSeen && this.deps.backup.swatPhase(p.callId) !== null) this.swatSeen = true;
    if (this.swatSeen && this.deps.scene.flagsOf(p.callId)?.has('custody:subject')) this.setFlag('swatResolved');
  }

  // --- Views ---------------------------------------------------------------------------------------------

  private countTags(): Record<TriageTag | 'untagged', number> {
    const counts: Record<TriageTag | 'untagged', number> = { minor: 0, delayed: 0, immediate: 0, expectant: 0, untagged: 0 };
    for (let i = 0; i < this.victims.length; i++) {
      const v = this.victims[i] as Victim;
      counts[v.tag ?? 'untagged']++;
    }
    return counts;
  }

  private buildBoard(): CommandBoard {
    const p = this.ps;
    const b = this.deps.backup;
    const units: { callsign: string; label: string; status: string; etaS: number }[] = [];
    if (p) {
      const call = this.deps.cad.call(p.callId);
      for (const cs of call ? call.units : []) {
        const u = this.deps.cad.unit(cs);
        const status = u ? u.status : 'unknown';
        units.push({ callsign: cs, label: u ? u.officer : cs, status, etaS: status === 'onScene' ? 0 : status === 'enRoute' && this.deps.eta ? this.deps.eta(cs) : -1 });
      }
    }
    const e = this.evac;
    const neg = this.neg;
    return {
      post: this.post(),
      victims: this.victims.map(
        (v): VictimRow => ({
          personId: v.personId, actorId: v.actorId, label: v.label, tag: v.tag, by: v.by, correct: v.correct,
          trapped: v.vitals.trapped, contaminated: v.vitals.contaminated, transported: v.transported,
        }),
      ),
      counts: this.countTags(),
      tcps: { staffed: p ? b.staffed('tcp') : 0, total: this.tcpPts.length },
      evac: e ? { progress: this.evacProgressNow(e), radiusM: e.radiusM } : null,
      inner: this.contain ? { staffed: b.staffed('inner'), total: this.staffPosts.filter((s) => s.spec.kind === 'inner').length } : null,
      swat: p ? b.swatPhase(p.callId) : null,
      negotiation: neg ? { trust: neg.trust, agitation: neg.agitation, outcome: neg.outcome, stage: neg.stage } : null,
      needs: this.needsNow(p),
      units,
    };
  }

  private buildHud(): string | null {
    const p = this.ps;
    if (!p) return null;
    const parts = ['ICS', p.level.toUpperCase()];
    if (this.victims.length > 0) {
      const c = this.countTags();
      parts.push(`RED ${c.immediate} YEL ${c.delayed} GRN ${c.minor} BLK ${c.expectant}`);
    }
    const ems = unitType('ems')?.callsign.replace('{n}', '') ?? 'MEDIC-';
    const call = this.deps.cad.call(p.callId);
    let enRoute = 0;
    for (const cs of call ? call.units : []) if (cs.startsWith(ems) && this.deps.cad.unit(cs)?.status === 'enRoute') enRoute++;
    if (enRoute > 0) parts.push(`EMS ${enRoute} en route`);
    if (this.evac) parts.push(`EVAC ${Math.floor(this.evacProgressNow(this.evac) * 100)}%`);
    if (this.neg && this.neg.outcome === 'ongoing') parts.push(`NEG ${Math.round(this.neg.trust * 100)}%`);
    return parts.join(' · ');
  }

  private buildView(): DialogueView | null {
    const neg = this.neg;
    if (!neg || !neg.open || !this.ps) return null;
    const ongoing = neg.outcome === 'ongoing';
    const lines: TranscriptLine[] = [{ id: 0, speaker: 'system', text: 'The subject is on the line.', pending: false }];
    neg.history.forEach((text, i) => lines.push({ id: i + 1, speaker: i % 2 === 0 ? 'officer' : 'subject', text, pending: false }));
    if (!ongoing) lines.push({ id: lines.length, speaker: 'system', text: neg.outcome === 'surrender' ? 'The subject agreed to come out.' : neg.outcome === 'breakdown' ? 'The subject ended the conversation.' : 'The conversation went nowhere.', pending: false });
    const assisted = this.deps.resources.onScene(this.ps.callId, 'negotiator') > 0;
    const pct = (x: number): string => `${Math.round(x * 100)}%`;
    const facts: NoteLine[] = [
      { text: `Trust ${pct(neg.trust)}`, severity: 'info' },
      { text: `Agitation ${pct(neg.agitation)}`, severity: neg.agitation > 0.8 ? 'alert' : neg.agitation > 0.6 ? 'caution' : 'info' },
    ];
    return {
      contactId: neg.subjectPersonId,
      title: 'Negotiation',
      subtitle: `${neg.stage[0]?.toUpperCase() ?? ''}${neg.stage.slice(1)} stage${assisted ? ' · negotiator assisting' : ''}`,
      tone: 'neutral',
      commMode: 'verbal',
      commModes: ['verbal'],
      topics: negotiationOptions(neg, this.data).map((c) => ({
        id: c.category,
        label: c.label,
        options: c.options.map((o) => ({ id: o.id, label: o.text, enabled: ongoing, ...(o.hint ? { hint: o.hint } : {}) })),
      })),
      actions: [],
      transcript: lines,
      statements: [],
      facts,
      inconsistencies: [],
      busy: false,
    };
  }
}
