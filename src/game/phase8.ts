import '../career/events';
import '../training/events';
import '../worldstate/events';
import type { CadState } from '../cad/cadState';
import { findCallType, statute } from '../cad/data';
import type { CadCall } from '../cad/types';
import {
  CareerState, assignmentEffects, legacyCareerSave, newCareerSave,
  type CareerRank, type CareerSave, type CareerStage, type DutyAssignment, type EligibilityContext, type PerformanceMods,
} from '../career';
import type { ConductState } from '../conduct';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { CourtState } from '../court';
import type { Dispatcher } from '../dispatch/dispatcher';
import type { ForceSystem } from '../force';
import type { InvestigationSystem } from '../investigation';
import { activeModRefs, modOverlay } from '../mods/registry';
import type { ModRef } from '../mods/types';
import type { Population } from '../people/population';
import { epochDayOfGameSeconds } from '../records/calendar';
import type { RecordsDb } from '../records/db';
import type { SceneDirector } from '../scene';
import {
  BUILTIN_SCRIPTS, DispatchTraining, DrivingCourseRun, ScriptRunner, findCourse,
  parseDispatchScript, defaultScriptContext,
  type CourseAnchor, type CoopRole, type DispatchScript, type DispatchScriptStep, type GameMode, type ModeSave, type SandboxScenario,
} from '../training';
import { WORLD_CONFIG, type OffenseClass, WorldState, premiseFlagsFor, type ClosedCallInfo, type WorldStateSave } from '../worldstate';

/** Everything the Phase 8 systems read of the rest of the session (the session fills it). */
export interface Phase8Host {
  readonly seed: number;
  readonly rng: Rng;
  readonly bus: EventBus<EventMap>;
  readonly cad: CadState;
  readonly dispatcher: Dispatcher;
  readonly scene: SceneDirector;
  readonly force: ForceSystem;
  readonly conduct: ConductState;
  readonly court: CourtState;
  readonly people: Population;
  readonly records: RecordsDb;
  readonly investigation: InvestigationSystem;
  /** Roster officer names (trainee and bidder names). */
  officerNames(): string[];
  /** Game seconds now. */
  nowGame(): number;
  /** Sim seconds now. */
  nowSim(): number;
  /** HUD flash line. */
  flash(text: string, severity?: 'ok' | 'warn' | 'bad'): void;
  /** Applies the career rank to the officer's character profile and fleet class. */
  applyRank(rank: CareerRank, stage: CareerStage, assignment: DutyAssignment): void;
  /** Lowercase district id at a position. */
  districtAt(x: number, z: number): string;
  /** The straight road segment a driving course sits on. */
  courseAnchor(): CourseAnchor | null;
  /** Resolves a script step location to a world point; null when it cannot. */
  resolveNear(near: DispatchScriptStep['near']): { x: number; z: number } | null;
  /** The player's callsign. */
  readonly callsign: string;
}

/** Scratch step list for the script runner. */
const dueScratch: DispatchScriptStep[] = [];

/** The mode state of one session, as `ModeSave` keeps it (runtime objects instead of save blocks). */
export interface ModeRuntime {
  id: GameMode;
  course: DrivingCourseRun | null;
  courseId: string | null;
  anchor: CourseAnchor | null;
  script: ScriptRunner | null;
  dispatch: DispatchTraining | null;
  scenario: SandboxScenario | null;
  coopRole: CoopRole | null;
}

/** The scripts a player can run: the shipped ones plus the enabled mods' (validated at boot, parsed again here). */
export function availableScripts(): DispatchScript[] {
  const out: DispatchScript[] = [...BUILTIN_SCRIPTS];
  const ctx = defaultScriptContext();
  for (const json of modOverlay().dispatchScripts) {
    const r = parseDispatchScript(json, ctx);
    if (r.ok && !out.some((s) => s.id === r.value.id)) out.push(r.value);
  }
  return out;
}

/**
 * Phase 8 of one session (design §20.3): the career, the persistent world, the mode block (training objects), the
 * hooks into the dispatcher, scene and force systems and the bridges of design §14.
 */
export class Phase8 {
  readonly career: CareerState;
  readonly world: WorldState;
  readonly mode: ModeRuntime;
  /** Performance penalties of the current wellbeing (refreshed every career step). */
  readonly perf: PerformanceMods = { aimSpread: 1, steerLagS: 0, vignette: 0 };
  /** Arrest requests of this shift per district (the world evolves from them at the rollover). */
  readonly arrestsByDistrict: Record<string, number> = {};
  /** Calls where the officer was wounded (premise flag), not saved. */
  private readonly woundedCalls = new Set<number>();
  private readonly host: Phase8Host;
  private readonly offs: (() => void)[] = [];
  private lastCourseScore = -1;
  private scriptGeneratorOff = false;
  private coopManual = false;
  private manualApplied = false;

  constructor(host: Phase8Host, save?: { career: CareerSave; worldState: WorldStateSave; mode: ModeSave }) {
    this.host = host;
    this.career = new CareerState(
      { bus: host.bus, rng: host.rng.stream('career'), names: host.officerNames() },
      save?.career,
    );
    const baseCrime: Record<string, number> = { ...WORLD_CONFIG.neighborhoods.baseCrime };
    for (const [d, patch] of Object.entries(modOverlay().districts)) {
      if (patch.crimeFactor !== undefined && baseCrime[d] !== undefined) baseCrime[d] = (baseCrime[d] ?? 0) * patch.crimeFactor;
    }
    this.world = new WorldState({ bus: host.bus, rng: host.rng.stream('worldstate'), baseCrime }, save?.worldState);
    this.mode = { id: 'freePatrol', course: null, courseId: null, anchor: null, script: null, dispatch: null, scenario: null, coopRole: null };
    if (save) this.restoreMode(save.mode);
    this.career.performance(this.perf);
    this.installHooks();
    this.wireBridges();
  }

  // --- Hooks -----------------------------------------------------------------------------------

  private installHooks(): void {
    const h = this.host;
    h.scene.setPersonBias((callId, district, fits, draw) => this.world.pickPerson(callId, district, h.nowGame(), fits, draw));
    h.dispatcher.setLocationBias((draw) => this.world.pickRepeatLocation(draw));
    h.dispatcher.setCrimeFactor((d) => h.conduct.effects(d).crimeFactor * this.world.crimeFactor(d));
    h.force.setAccuracyFactor(() => this.perf.aimSpread);
    this.applyAssignment();
    this.applyMode();
  }

  /** Dispatcher category weights of the current specialty (null for patrol: the plain generator). */
  private applyAssignment(): void {
    const weights = assignmentEffects(this.career.view.assignment).callWeights;
    this.host.dispatcher.setCategoryWeights(Object.keys(weights).length === 0 ? null : (category) => weights[category] ?? 1);
  }

  /** Re-applies the dispatcher flags of the mode (not saved by the dispatcher): manual dispatch, generator. */
  applyMode(): void {
    const d = this.host.dispatcher;
    const m = this.mode;
    this.setManual(m.id === 'dispatchOnly' || (m.id === 'coop' && this.coopManual));
    if (m.id === 'dispatchOnly') {
      this.scriptGeneratorOff = m.script !== null && m.script.script.generator === 'off';
      d.setGeneratorEnabled(!this.scriptGeneratorOff);
    } else if (m.id === 'sandbox' || m.id === 'drivingAcademy') {
      d.setGeneratorEnabled(false);
    } else {
      d.setGeneratorEnabled(true);
    }
  }

  /** Manual dispatch only when it changes (the dispatcher marks its assignment pass dirty on every call). */
  private setManual(on: boolean): void {
    if (on === this.manualApplied) return;
    this.manualApplied = on;
    this.host.dispatcher.setManualDispatch(on);
  }

  /** Co-op: manual dispatch on or off (the host keeps the generator only without a dispatcher player). */
  setCoopDispatch(manual: boolean, generator: boolean): void {
    this.coopManual = manual;
    this.setManual(manual);
    this.host.dispatcher.setGeneratorEnabled(generator);
  }

  // --- Mode --------------------------------------------------------------------------------------

  /** Sets the mode id (new game, load, console). */
  setMode(id: GameMode): void {
    const m = this.mode;
    m.id = id;
    if (id !== 'drivingAcademy' && id !== 'career') this.stopCourse();
    if (id !== 'dispatchOnly') {
      m.script = null;
      m.dispatch = null;
    } else if (m.dispatch === null) {
      m.dispatch = new DispatchTraining(this.host.bus);
    }
    this.applyMode();
  }

  get modeId(): GameMode {
    return this.mode.id;
  }

  /** Starts a driving course run on the arterial segment near the station; null with the reason when it cannot. */
  startCourse(courseId: string): string | null {
    const course = findCourse(courseId);
    if (!course) return `Unknown course: ${courseId}`;
    const anchor = this.mode.anchor ?? this.host.courseAnchor();
    if (!anchor) return 'No straight road long enough near the station';
    this.mode.anchor = anchor;
    this.mode.courseId = courseId;
    this.mode.course = new DrivingCourseRun(course, anchor, this.host.bus);
    this.lastCourseScore = -1;
    return null;
  }

  stopCourse(): void {
    this.mode.course = null;
    this.mode.courseId = null;
  }

  /** The score of a finished course run (else -1), consumed once. */
  takeCourseScore(): number {
    const run = this.mode.course;
    if (!run || !run.done || this.lastCourseScore >= 0) return -1;
    this.lastCourseScore = run.result().score;
    return this.lastCourseScore;
  }

  /** Starts script `id` (dispatch-only mode); null when started, else the reason. */
  startScript(id: string): string | null {
    const script = availableScripts().find((s) => s.id === id);
    if (!script) return `Unknown script: ${id}`;
    const m = this.mode;
    if (m.dispatch === null) m.dispatch = new DispatchTraining(this.host.bus);
    m.script = new ScriptRunner(script);
    m.script.start(this.host.nowSim());
    this.applyMode();
    return null;
  }

  stopScript(): void {
    this.mode.script = null;
    this.applyMode();
  }

  // --- Steps -------------------------------------------------------------------------------------

  /** Fixed step -654. */
  stepCareer(dt: number, t: { sim: number; game: number }): void {
    this.career.step(dt, t);
    this.career.performance(this.perf);
  }

  /** Fixed step -653. */
  stepWorld(dt: number, t: { sim: number; game: number }): void {
    this.world.step(dt, t);
  }

  /** Fixed step -652: the course run (driven vehicle) and the dispatch script runner. Allocation-free unless a step is due. */
  stepTraining(x: number, z: number, speed: number, t: { sim: number; game: number }): void {
    const m = this.mode;
    if (m.course !== null && !m.course.done && !m.course.aborted) m.course.step(x, z, speed, t.sim);
    const script = m.script;
    if (script !== null && !script.finished) {
      dueScratch.length = 0;
      if (script.due(t.sim, dueScratch) > 0) {
        for (const step of dueScratch) this.spawnScripted(step, t);
        dueScratch.length = 0;
      }
    }
  }

  private spawnScripted(step: DispatchScriptStep, t: { sim: number; game: number }): void {
    const at = this.host.resolveNear(step.near);
    if (!at) return;
    const h = this.host;
    const call = h.dispatcher.createScriptedCall(
      {
        typeId: step.typeId,
        ...(step.priority !== null ? { priority: step.priority } : {}),
        x: at.x,
        z: at.z,
        ...(step.narrative !== null ? { narrative: step.narrative } : {}),
      },
      t,
    );
    if (!call) return;
    if (step.radio !== null) h.bus.emit('training:flash', { text: step.radio });
    this.noteCreated(call, t.sim);
  }

  /** Dispatch training: a call exists (script or console). */
  noteCreated(call: CadCall, sim: number): void {
    const d = this.mode.dispatch;
    if (d === null) return;
    const units = findCallType(call.typeId)?.units[0] ?? 1;
    d.onCreated(call.id, call.number, call.priority, units, sim);
  }

  // --- Eligibility context -------------------------------------------------------------------

  /** The conduct values the career eligibility checks read. */
  eligibility(): EligibilityContext {
    const c = this.host.conduct.career;
    const grades = c.reports;
    let sum = 0;
    for (const g of grades) sum += g.score;
    const game = this.host.nowGame();
    const since = game - 20 * 86400;
    let sustained = 0;
    for (const ia of c.ia) if (ia.finding === 'sustained' && ia.closedGame >= since) sustained++;
    return { points: c.points, credibility: c.credibility, sustainedIaRecent: sustained, avgReport: grades.length === 0 ? 0 : sum / grades.length };
  }

  // --- Bridges (design §14) ------------------------------------------------------------------

  private wireBridges(): void {
    const bus = this.host.bus;
    const h = this.host;
    const career = this.career;
    const stat = (key: 'calls' | 'arrests' | 'reports' | 'reportSum' | 'forceEvents' | 'unjustifiedForce' | 'unlawfulDeterminations' | 'pursuits' | 'fleetPoints' | 'trustDelta', delta: number): void => {
      if (delta !== 0) career.request({ kind: 'stat', key, delta });
    };
    this.offs.push(
      bus.on('force:applied', (e) => {
        career.request({ kind: 'stress', event: e.tool === 'firearm' ? 'firearmDischarged' : 'forceUsed' });
        stat('forceEvents', 1);
      }),
      bus.on('incident:forceVerdict', (e) => {
        if (e.verdict === 'excessive' || e.verdict === 'questionable') stat('unjustifiedForce', 1);
      }),
      bus.on('scene:pursuit', (e) => {
        if (!e.active) return;
        career.request({ kind: 'stress', event: 'pursuit' });
        stat('pursuits', 1);
      }),
      bus.on('scene:outcome', (e) => {
        if (e.outcome.resolvedBy !== 'player') return;
        for (const p of h.scene.participants(e.outcome.callId)) {
          if (p.deceased) {
            career.request({ kind: 'stress', event: 'deceasedOnScene' });
            break;
          }
        }
      }),
      bus.on('conduct:ia', () => career.request({ kind: 'stress', event: 'iaOpened' })),
      bus.on('conduct:iaResolved', (e) => {
        if (e.finding === 'sustained') career.request({ kind: 'stress', event: 'iaSustained' });
      }),
      bus.on('conduct:commendation', () => career.request({ kind: 'stress', event: 'commendation' })),
      bus.on('court:verdict', (e) => {
        const c = h.court.cases().find((x) => x.id === e.caseId);
        if (c && c.personId >= 0) {
          const verdict = e.verdict === 'acquitted' ? 'acquitted' : e.verdict === 'dismissed' ? 'dismissed' : 'convicted';
          this.world.request({ kind: 'verdict', personId: c.personId, verdict, game: h.nowGame() });
        }
        if ((e.verdict === 'acquitted' || e.verdict === 'dismissed') && (e.impeached || e.missed || e.credibilityDelta < 0)) {
          career.request({ kind: 'stress', event: 'courtLoss' });
        }
      }),
      bus.on('command:post', (e) => {
        if (e.open && (e.level === 'major' || e.level === 'disaster')) career.request({ kind: 'stress', event: 'criticalIncident' });
      }),
      bus.on('cad:documentSaved', (e) => {
        if (e.kind !== 'booking' || !e.final) return;
        const doc = h.cad.docs.get(e.id);
        if (doc?.kind !== 'booking' || doc.personId < 0) return;
        this.onBooked(doc.personId, doc.charges, doc.arrestedGame);
      }),
      bus.on('cad:callClosed', (e) => this.onCallClosed(e.callId, e.disposition)),
      bus.on('cad:callCreated', () => undefined),
      bus.on('cad:unitAssigned', (e) => {
        if (e.callsign !== h.callsign) return;
        // The player took a call: nothing to record; stats count on close.
      }),
      bus.on('investigation:canvass', (e) => {
        if (e.personId < 0) return;
        this.world.request({ kind: 'witness', personId: e.personId, callId: e.callId, addressText: h.records.person(e.personId).address });
      }),
      bus.on('conduct:report', (e) => {
        stat('reports', 1);
        stat('reportSum', e.score);
      }),
      bus.on('incident:closed', (e) => stat('unlawfulDeterminations', e.unlawful)),
      bus.on('conduct:trust', (e) => stat('trustDelta', e.delta)),
      bus.on('fleet:charge', (e) => stat('fleetPoints', e.points)),
      bus.on('fleet:shiftEnd', () => {
        career.request({ kind: 'endShift', ctx: this.eligibility(), suspended: h.conduct.dutyStatus(h.nowGame()).status !== 'active' });
      }),
      bus.on('career:points', (e) => h.conduct.request({ kind: 'points', delta: e.delta, reason: e.reason, key: e.key })),
      bus.on('career:stage', (e) => {
        h.applyRank(e.rank, e.stage, e.assignment);
        this.applyAssignment();
      }),
      bus.on('career:flash', (e) => h.flash(e.text)),
      bus.on('world:flash', (e) => h.flash(e.text)),
      bus.on('training:flash', (e) => h.flash(e.text)),
      bus.on('world:recidivist', (e) => {
        h.flash(`Known offender: ${displayOf(h.records, e.personId)}, ${String(e.arrests)} prior arrest${e.arrests === 1 ? '' : 's'}`, 'warn');
      }),
    );
  }

  /** The officer was wounded (Phase 7 hit result): injury and stress. */
  officerWounded(): void {
    this.career.request({ kind: 'injury', amount: 0.4 });
    this.career.request({ kind: 'stress', event: 'officerInjured' });
    const id = this.host.cad.unit(this.host.callsign)?.callId;
    if (id !== undefined && id !== null) this.woundedCalls.add(id);
  }

  private onBooked(personId: number, charges: readonly string[], arrestedGame: number): void {
    const h = this.host;
    this.career.request({ kind: 'stress', event: 'arrestMade' });
    this.career.request({ kind: 'stat', key: 'arrests', delta: 1 });
    const p = h.records.person(personId);
    let cls: OffenseClass = 'misdemeanor';
    const order = { infraction: 0, misdemeanor: 1, felony: 2, warrant: 3 } as const;
    let best = -1;
    for (const id of charges) {
      let c: OffenseClass;
      try {
        c = statute(id).cls;
      } catch {
        continue;
      }
      if (order[c] > best) {
        best = order[c];
        cls = c;
      }
    }
    const today = epochDayOfGameSeconds(h.nowGame());
    const juvenile = (today - p.dob) / 365.25 < 18;
    const pos = h.cad.unit(h.callsign);
    const x = pos?.x ?? 0;
    const z = pos?.z ?? 0;
    const district = h.districtAt(x, z);
    if (district !== '') this.arrestsByDistrict[district] = (this.arrestsByDistrict[district] ?? 0) + 1;
    this.world.request({
      kind: 'arrest', personId, district, callNumber: lastCallNumber(h.cad, personId), x, z, game: arrestedGame > 0 ? arrestedGame : h.nowGame(),
      offenseClass: cls, juvenile, priors: p.priors.length,
    });
  }

  private onCallClosed(callId: number, disposition: string): void {
    const h = this.host;
    const call = h.cad.call(callId);
    if (!call) return;
    const mine = call.units.includes(h.callsign) || (call.selfInitiated && call.primary === h.callsign);
    if (mine) {
      this.career.request({ kind: 'stat', key: 'calls', delta: 1 });
      this.career.request({ kind: 'stress', event: 'callCleared' });
    }
    this.mode.dispatch?.onClosed(callId, h.nowSim());
    const type = findCallType(call.typeId);
    const category = type?.category ?? '';
    const flags = h.scene.flagsOf(callId);
    const info: ClosedCallInfo = {
      callId,
      number: call.number,
      typeId: call.typeId,
      nature: call.nature,
      category,
      x: call.location.x,
      z: call.location.z,
      edge: call.location.edge,
      text: call.location.text,
      district: call.location.district,
      disposition,
      flags: premiseFlagsFor({
        disposition,
        category,
        familyId: h.scene.familyOf(callId),
        weaponSeen: flags?.has('weaponFound') === true || flags?.has('shotsFired') === true,
        forceUsed: flags?.has('forceUsed') === true,
        officerInjured: this.woundedCalls.has(callId),
        drugsFound: flags?.has('contrabandFound') === true,
      }),
      persons: [...call.persons],
      game: h.nowGame(),
    };
    this.world.request({ kind: 'callClosed', call: info });
    this.woundedCalls.delete(callId);
    if (disposition !== 'arrestMade' && WORLD_CONFIG.cases.categories.includes(category)) this.maybeOpenCase(call, info);
  }

  private maybeOpenCase(call: CadCall, info: ClosedCallInfo): void {
    const h = this.host;
    const parts = h.scene.participants(call.id);
    const suspects: number[] = [];
    const witnesses: number[] = [];
    for (const p of parts) {
      if (p.personId < 0) continue;
      if (p.role === 'suspect') suspects.push(p.personId);
      else if (p.role === 'witness' || p.role === 'bystander' || p.role === 'reporter') witnesses.push(p.personId);
    }
    const file = h.investigation.store.files().find((f) => f.callId === call.id);
    const evidence = file ? file.items.length : 0;
    if (suspects.length === 0 && evidence === 0) return;
    this.world.request({
      kind: 'caseOpen', callId: call.id, number: call.number, typeId: call.typeId, nature: call.nature, game: info.game,
      locationText: call.location.text, x: call.location.x, z: call.location.z, suspects, witnesses, evidence,
    });
  }

  // --- Persistence -----------------------------------------------------------------------------

  serializeMode(): ModeSave {
    const m = this.mode;
    return {
      version: 1,
      id: m.id,
      course: m.course ? m.course.serialize() : null,
      courseId: m.courseId,
      script: m.script ? m.script.serialize() : null,
      dispatch: m.dispatch ? m.dispatch.serialize() : null,
      scenario: m.scenario ? structuredClone(m.scenario) : null,
      coopRole: m.coopRole,
    };
  }

  /** The Phase 8 blocks of a save. */
  serialize(): { career: CareerSave; worldState: WorldStateSave; mode: ModeSave; mods: ModRef[] } {
    return {
      career: this.career.serialize(),
      worldState: this.world.serialize(),
      mode: this.serializeMode(),
      mods: activeModRefs().map((r) => ({ ...r })),
    };
  }

  /** Replaces the Phase 8 state with a save's (load): career, world, mode; the dispatcher flags follow the mode. */
  restore(save: { career: CareerSave; worldState: WorldStateSave; mode: ModeSave }): void {
    this.career.restore(save.career);
    this.world.restore(save.worldState);
    this.restoreMode(save.mode);
    this.career.performance(this.perf);
    this.applyAssignment();
    this.applyMode();
  }

  /**
   * New game (design §20.3): the career (a fresh academy career for the career and driving-academy modes, `career` when
   * given, else a patrol officer on duty from now) and the mode.
   */
  begin(mode: GameMode, career: CareerSave | null): void {
    const now = this.host.nowGame();
    const rng = this.career.serialize().rng;
    let save = career;
    if (save === null) {
      save = mode === 'career' ? newCareerSave(rng, { stage: 'academy', startGame: now }) : legacyCareerSave(rng, now);
    }
    this.career.restore(save);
    this.career.performance(this.perf);
    this.mode.id = mode;
    this.applyAssignment();
    this.setMode(mode);
  }

  private restoreMode(save: ModeSave): void {
    const m = this.mode;
    m.id = save.id === 'coop' ? 'freePatrol' : save.id;
    m.coopRole = null;
    m.scenario = save.scenario ? structuredClone(save.scenario) : null;
    m.course = null;
    m.courseId = null;
    m.script = null;
    m.dispatch = null;
    if (save.courseId !== null && save.course !== null) {
      const course = findCourse(save.courseId);
      const anchor = this.host.courseAnchor();
      if (course && anchor) {
        m.anchor = anchor;
        m.courseId = save.courseId;
        m.course = new DrivingCourseRun(course, anchor, this.host.bus, save.course);
      }
    }
    if (save.script !== null) {
      const script = availableScripts().find((s) => s.id === save.script?.scriptId);
      if (script) m.script = new ScriptRunner(script, save.script);
    }
    if (m.id === 'dispatchOnly' || save.dispatch !== null) m.dispatch = new DispatchTraining(this.host.bus, save.dispatch ?? undefined);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    const h = this.host;
    h.scene.setPersonBias(null);
    h.dispatcher.setLocationBias(null);
    h.dispatcher.setCategoryWeights(null);
    h.force.setAccuracyFactor(null);
    this.setManual(false);
    h.dispatcher.setGeneratorEnabled(true);
  }
}

function displayOf(records: RecordsDb, personId: number): string {
  const p = records.person(personId);
  return `${p.first} ${p.last}`.trim();
}

function lastCallNumber(cad: CadState, personId: number): string {
  let best = '';
  for (const c of cad.calls()) if (c.persons.includes(personId)) best = c.number;
  return best;
}
