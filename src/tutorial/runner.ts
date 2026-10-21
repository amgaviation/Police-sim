import type { EventBus } from '../core/events';
import type { EventMap } from '../core/event-map';
import './events';
import { TUTORIAL_PENDING_MAX, TUTORIAL_PROBE_PERIOD, TUTORIAL_QUEUE_MAX, type TutorialCommand, type TutorialSave } from './save';
import { getTutorialScript } from './script';
import type { TutorialAction, TutorialEventMatch, TutorialProbe, TutorialScript, TutorialStep } from './types';

/** What the runner needs from the game (the integrator implements it; simulation state only). */
export interface TutorialPorts {
  playerCallsign(): string;
  /** Simulation state only (never DOM / UI state). Booleans as 0 / 1. `distanceToCallM`: Infinity when unbound. */
  probe(id: TutorialProbe, callId: number): number;
  /** Creates a call of `typeId` minM..maxM from the player and offers it to the player unit; returns the call id or -1. */
  createCall(typeId: string, minM: number, maxM: number): number;
}

/** What the current step shows. */
export interface TutorialStepView {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly hint: string;
  /** The step waits for the player to press Continue. */
  readonly ack: boolean;
  readonly skippable: boolean;
}

/** Read-only state for the card and the dialog. A new object on every change; the same one while nothing changes. */
export interface TutorialView {
  readonly active: boolean;
  readonly done: boolean;
  readonly completed: boolean;
  readonly scriptId: string;
  readonly title: string;
  readonly index: number;
  readonly count: number;
  readonly step: TutorialStepView | null;
  /** Bumps on every change of the fields above (derived from the state, so a loaded runner reports the same number). */
  readonly revision: number;
}

/** The view of "no tutorial" (revision -1): what the UI gets when the game has no runner. */
export const INACTIVE_TUTORIAL_VIEW: TutorialView = {
  active: false,
  done: false,
  completed: false,
  scriptId: '',
  title: '',
  index: 0,
  count: 0,
  step: null,
  revision: -1,
};

const MAX_DEPTH = 8;

/** JSON-safe deep copy of a payload: strings, finite numbers, booleans, nested plain objects; arrays and the rest dropped. */
function copyObject(src: object, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (key === '__proto__') continue;
    const v = (src as Record<string, unknown>)[key];
    if (typeof v === 'string' || typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[key] = v;
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v) && depth < MAX_DEPTH) out[key] = copyObject(v, depth + 1);
  }
  return out;
}

function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  let start = 0;
  for (;;) {
    const dot = path.indexOf('.', start);
    const key = dot === -1 ? path.slice(start) : path.slice(start, dot);
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (dot === -1) return cur;
    start = dot + 1;
  }
}

/**
 * The guided-shift runner (Phase 9 design §8.3). Simulation: deterministic, draws no random numbers, bus handlers only
 * enqueue (`onEvent`), all state is the serializable `TutorialSave`. `step()` runs in the fixed step and allocates nothing
 * while no event, command or step change happens.
 */
export class TutorialRunner {
  private readonly bus: EventBus<EventMap>;
  private readonly ports: TutorialPorts;
  private readonly script: TutorialScript;
  private readonly save: TutorialSave;
  private readonly stepViews: TutorialStepView[];
  private current: TutorialView;

  constructor(bus: EventBus<EventMap>, ports: TutorialPorts, save: TutorialSave, script?: TutorialScript) {
    const found = script ?? getTutorialScript(save.scriptId);
    if (found === undefined) throw new Error(`TutorialRunner: unknown script "${save.scriptId}"`);
    if (found.id !== save.scriptId) throw new Error(`TutorialRunner: save is for "${save.scriptId}", script is "${found.id}"`);
    this.bus = bus;
    this.ports = ports;
    this.script = found;
    this.save = structuredClone(save);
    this.save.index = Math.min(Math.max(this.save.index, 0), found.steps.length);
    this.stepViews = found.steps.map((s) => ({
      id: s.id,
      title: s.title,
      text: s.text,
      hint: s.hint ?? '',
      ack: 'ack' in s.until,
      skippable: s.skippable === true,
    }));
    this.current = this.buildView();
  }

  /**
   * Bus forwarding: copies the payload (JSON-safe fields only) into the queue; drops it beyond 64 queued events and once
   * the tutorial is done. Allocates (a rare event).
   */
  onEvent(topic: string, payload: unknown): void {
    const s = this.save;
    if (s.done || s.queue.length >= TUTORIAL_QUEUE_MAX) return;
    const copy = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? copyObject(payload, 0) : {};
    s.queue.push({ topic, payload: copy });
  }

  /** The player pressed Continue (applied at the next step). */
  ack(): void {
    this.command('ack');
  }

  /** Skip the current step (ignored unless it is skippable; applied at the next step). */
  skip(): void {
    this.command('skip');
  }

  /** End the tutorial (applied at the next step; `completed` stays false). */
  end(): void {
    this.command('end');
  }

  /** The fixed step: commands, enter actions, queued events, then the probe check every 15 steps. */
  step(): void {
    const s = this.save;
    if (s.done) {
      if (s.pending.length > 0) s.pending.length = 0;
      if (s.queue.length > 0) s.queue.length = 0;
      return;
    }
    if (s.index >= this.script.steps.length) {
      this.finish(true);
      return;
    }
    if (s.pending.length > 0) this.applyPending();
    if (s.done) return;
    if (!s.entered) this.enterStep();
    if (s.queue.length > 0) this.matchQueue();
    if (s.done) return;
    s.probeTick += 1;
    if (s.probeTick >= TUTORIAL_PROBE_PERIOD) {
      s.probeTick = 0;
      this.checkProbe();
    }
  }

  /** Current state for the UI; changes (new object, higher revision) only when a step changes or the tutorial ends. */
  get view(): TutorialView {
    return this.current;
  }

  /** Deep copy of the state (the save block). */
  serialize(): TutorialSave {
    return structuredClone(this.save);
  }

  private command(c: TutorialCommand): void {
    const s = this.save;
    if (s.done || s.pending.length >= TUTORIAL_PENDING_MAX) return;
    s.pending.push(c);
  }

  private currentStep(): TutorialStep | undefined {
    return this.script.steps[this.save.index];
  }

  private applyPending(): void {
    const s = this.save;
    for (let i = 0; i < s.pending.length && !s.done; i++) {
      const cmd = s.pending[i];
      const step = this.currentStep();
      if (step === undefined) break;
      if (cmd === 'end') this.finish(false);
      else if (cmd === 'ack') {
        if ('ack' in step.until) this.advance();
      } else if (step.skippable === true) {
        s.skipped.push(step.id);
        this.advance();
      }
    }
    s.pending.length = 0;
  }

  /** Runs the current step's enter actions once and announces the step. */
  private enterStep(): void {
    const s = this.save;
    const step = this.currentStep();
    if (step === undefined) return;
    s.entered = true;
    if (step.enter !== undefined) for (const action of step.enter) this.runAction(action);
    this.bus.emit('tutorial:step', { scriptId: s.scriptId, index: s.index, id: step.id, count: this.script.steps.length });
  }

  private runAction(action: TutorialAction): void {
    if (action.do === 'createCall') this.save.callId = this.ports.createCall(action.typeId, action.minM, action.maxM);
    else this.bus.emit('tutorial:flash', { text: action.text });
  }

  /** Completes the current step: the next one is entered at once (its enter actions run before further matching). */
  private advance(): void {
    const s = this.save;
    s.index += 1;
    s.entered = false;
    if (s.index >= this.script.steps.length) {
      this.finish(true);
      return;
    }
    this.current = this.buildView();
    this.enterStep();
  }

  private finish(completed: boolean): void {
    const s = this.save;
    s.done = true;
    s.completed = completed;
    if (completed) s.index = this.script.steps.length;
    s.pending.length = 0;
    s.queue.length = 0;
    this.current = this.buildView();
    this.bus.emit('tutorial:done', { scriptId: s.scriptId, completed, skipped: s.skipped.length });
  }

  private matchQueue(): void {
    const s = this.save;
    const q = s.queue;
    for (let i = 0; i < q.length && !s.done; i++) {
      const ev = q[i];
      const step = this.currentStep();
      if (ev === undefined || step === undefined) break;
      const until = step.until;
      if ('any' in until && this.matchesAny(until.any, ev.topic, ev.payload)) this.advance();
    }
    q.length = 0;
  }

  private matchesAny(list: readonly TutorialEventMatch[], topic: string, payload: Record<string, unknown>): boolean {
    for (const m of list) {
      if (m.topic !== topic) continue;
      if (m.where === undefined || this.whereHolds(m.where, payload)) return true;
    }
    return false;
  }

  private whereHolds(where: Readonly<Record<string, string | number | boolean>>, payload: Record<string, unknown>): boolean {
    for (const key in where) {
      const want = where[key];
      let expected: string | number | boolean | undefined = want;
      if (want === '$player') expected = this.ports.playerCallsign();
      else if (want === '$call') {
        if (this.save.callId < 0) return false;
        expected = this.save.callId;
      }
      if (getPath(payload, key) !== expected) return false;
    }
    return true;
  }

  private checkProbe(): void {
    const step = this.currentStep();
    if (step === undefined || !('probe' in step.until)) return;
    const u = step.until;
    const value = this.ports.probe(u.probe, this.save.callId);
    if ((u.gte === undefined || value >= u.gte) && (u.lte === undefined || value <= u.lte)) this.advance();
  }

  private buildView(): TutorialView {
    const s = this.save;
    const count = this.script.steps.length;
    return {
      active: !s.done,
      done: s.done,
      completed: s.completed,
      scriptId: s.scriptId,
      title: this.script.title,
      index: s.index,
      count,
      step: s.done ? null : (this.stepViews[s.index] ?? null),
      revision: s.index * 2 + (s.done ? 1 : 0),
    };
  }
}
