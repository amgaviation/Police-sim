import type { CadTime } from '../cad/types';
import type { EventBus } from '../core/events';
import type { EventMap } from '../core/event-map';
import type { Rng } from '../core/rng';
import { CRIME_DISTRICTS } from '../environment/crime';
import { applyCaseUpdate, caseFromRequest, formatCaseId, isActiveCase } from './cases';
import { WORLD_CONFIG, type WorldConfig } from './data';
import { evolveWorld } from './evolve';
import './events';
import { crimeFactor, newNeighborhood } from './neighborhoods';
import { offenderRisk, pickRecidivist, releaseAfterVerdict } from './offenders';
import { addPremiseEntry, premiseKey } from './premises';
import { MAX_BIAS, MAX_NEWS, newWorldStateSave, type WorldStateSave } from './save';
import {
  PREMISE_FLAGS,
  type CaseRecord, type EvolveInput, type EvolveResult, type NeighborhoodState, type OffenderRecord, type PremiseEntry,
  type PremiseFlag, type PremiseRecord, type WitnessRecord, type WorldRequest,
} from './types';

/** The persistent world (Phase 8 design §6.4): premise history, case register, offenders, witnesses, neighborhoods. */

const DAY_S = 86400;
const NO_ENTRIES: readonly PremiseEntry[] = [];
const NO_FLAGS: readonly PremiseFlag[] = [];
const NEUTRAL: Readonly<NeighborhoodState> = Object.freeze({ crime: 0, trend: 0, history: [] as number[] });

export interface WorldDeps {
  readonly bus: EventBus<EventMap>;
  /** The session's 'worldstate' stream. */
  readonly rng: Rng;
  readonly config?: WorldConfig;
  /** Base crime per district (the mods district table); default `config.neighborhoods.baseCrime`. */
  readonly baseCrime?: Readonly<Record<string, number>>;
}

export class WorldState {
  private readonly bus: EventBus<EventMap>;
  private readonly rng: Rng;
  private readonly cfg: WorldConfig;
  private readonly base: Readonly<Record<string, number>>;
  private readonly premiseMap = new Map<string, PremiseRecord>();
  private caseList: CaseRecord[] = [];
  private readonly caseByCall = new Map<number, CaseRecord>();
  /** Sorted by personId. */
  private offenderList: OffenderRecord[] = [];
  private readonly offenderMap = new Map<number, OffenderRecord>();
  private witnessList: WitnessRecord[] = [];
  private readonly witnessMap = new Map<number, WitnessRecord>();
  private neighborhoods: Record<string, NeighborhoodState> = {};
  private readonly biasMap = new Map<number, number>();
  private newsList: { game: number; text: string }[] = [];
  private queue: WorldRequest[] = [];
  private lastEvolveGame = 0;
  private nextCase = 1;
  private rev = 1;
  private repeatCache: PremiseRecord[] = [];
  private repeatRev = 0;

  constructor(deps: WorldDeps, save?: WorldStateSave) {
    this.bus = deps.bus;
    this.rng = deps.rng;
    this.cfg = deps.config ?? WORLD_CONFIG;
    // A district table mod can scale the base crime (crimeFactor up to 3): the level stays within the neighborhood range,
    // which is also what the save validator accepts.
    const base: Record<string, number> = { ...this.cfg.neighborhoods.baseCrime, ...deps.baseCrime };
    for (const d of Object.keys(base)) base[d] = Math.min(this.cfg.neighborhoods.max, Math.max(0, base[d] ?? 0));
    this.base = base;
    this.load(save ?? newWorldStateSave(deps.rng.state(), this.base));
    if (save !== undefined) this.rng.restore(save.rng);
  }

  /** Increases on every state change (the UI rebuilds on it). */
  get revision(): number {
    return this.rev;
  }

  /** Queues a request, applied at the start of the next `step`. */
  request(r: WorldRequest): void {
    this.queue.push(r);
  }

  /** Fixed step (order -653): drains the requests; nothing else happens per step. */
  step(_dt: number, _t: CadTime): void {
    if (this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    for (const r of pending) this.apply(r);
    this.rev++;
  }

  // --- Queries --------------------------------------------------------------------------------

  /** Closed calls at an address, oldest first; `[]` when unknown. */
  premiseHistory(text: string): readonly PremiseEntry[] {
    return this.premiseMap.get(premiseKey(text))?.entries ?? NO_ENTRIES;
  }

  /** Union of the flags of the address's entries, in `PREMISE_FLAGS` order. */
  premiseFlags(text: string): readonly PremiseFlag[] {
    const p = this.premiseMap.get(premiseKey(text));
    if (p === undefined || p.entries.length === 0) return NO_FLAGS;
    return PREMISE_FLAGS.filter((f) => p.entries.some((e) => e.flags.includes(f)));
  }

  cases(): readonly CaseRecord[] {
    return this.caseList;
  }

  caseOfCall(callId: number): CaseRecord | null {
    return this.caseByCall.get(callId) ?? null;
  }

  offender(personId: number): OffenderRecord | null {
    return this.offenderMap.get(personId) ?? null;
  }

  /** Every offender record, in personId order. */
  offenders(): readonly OffenderRecord[] {
    return this.offenderList;
  }

  /** The district's state; a neutral frozen state for an unknown district. */
  neighborhood(district: string): Readonly<NeighborhoodState> {
    return this.neighborhoods[district] ?? NEUTRAL;
  }

  /** Crime multiplier of a district: crime / base clamped to the factor range; 1 for unknown districts. */
  crimeFactor(district: string): number {
    const n = this.neighborhoods[district];
    return n === undefined ? 1 : crimeFactor(n, this.base[district] ?? 0, this.cfg.neighborhoods);
  }

  news(): readonly { game: number; text: string }[] {
    return this.newsList;
  }

  // --- Simulation hooks -----------------------------------------------------------------------

  /**
   * Scene hook: a designated person for `callId` (bias map; removed when used and it fits `fitsDesignated`, default
   * `fits`), else `pickRecidivist` (which uses `fits`); emits
   * `world:recidivist` when an offender was picked. -1 = no pick. Draws only through `draw`, and only for a non-empty pool.
   */
  pickPerson(
    callId: number, district: string, game: number, fits: (personId: number) => boolean, draw: () => number,
    fitsDesignated: (personId: number) => boolean = fits,
  ): number {
    const designated = this.biasMap.get(callId);
    if (designated !== undefined && fitsDesignated(designated)) {
      this.biasMap.delete(callId);
      this.rev++;
      return designated;
    }
    const id = pickRecidivist(this.offenderList, game, district, fits, draw, this.cfg.recidivism);
    if (id >= 0) {
      this.bus.emit('world:recidivist', { personId: id, callId, arrests: this.offenderMap.get(id)?.arrests ?? 0 });
    }
    return id;
  }

  /**
   * Dispatcher hook: premises with at least `repeatCalls.minEntries` entries (sorted by key); none -> null without
   * drawing; `draw() >= chance` -> null; else the premise at `floor(draw() * n)` as `{ x, z }`.
   */
  pickRepeatLocation(draw: () => number): { x: number; z: number } | null {
    if (this.repeatRev !== this.rev) {
      this.repeatCache = [];
      for (const p of this.premiseMap.values()) if (p.entries.length >= this.cfg.repeatCalls.minEntries) this.repeatCache.push(p);
      this.repeatCache.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      this.repeatRev = this.rev;
    }
    const n = this.repeatCache.length;
    if (n === 0) return null;
    if (draw() >= this.cfg.repeatCalls.chance) return null;
    const p = this.repeatCache[Math.min(n - 1, Math.floor(draw() * n))] as PremiseRecord;
    return { x: p.x, z: p.z };
  }

  /** A follow-up call created by the integrator gets its suspect: bias `[callId, personId]` (used once by `pickPerson`). */
  bindPerson(callId: number, personId: number): void {
    this.biasMap.delete(callId);
    this.biasMap.set(callId, personId);
    while (this.biasMap.size > MAX_BIAS) {
      for (const oldest of this.biasMap.keys()) {
        this.biasMap.delete(oldest);
        break;
      }
    }
    this.rev++;
  }

  /**
   * Rollover: evolves the world from the last evolved time (`fromGame` the first time) to `toGame` (see `evolveWorld`),
   * so the part of a day left over by one rollover is carried to the next instead of being lost. Uses only the
   * 'worldstate' stream. The integrator applies the result (people custody, record addresses, trust, follow-up calls +
   * `bindPerson`).
   */
  evolve(input: EvolveInput): EvolveResult {
    const last = this.lastEvolveGame;
    const from = last > 0 && last <= input.fromGame ? last : input.fromGame;
    const result = evolveWorld(
      { cases: this.caseList, offenders: this.offenderList, witnesses: this.witnessList, neighborhoods: this.neighborhoods },
      { ...input, fromGame: from },
      {
        rng: this.rng, cfg: this.cfg, baseCrime: this.base, offenderOf: (id) => this.offenderMap.get(id) ?? null,
        onCase: (c) => this.bus.emit('world:case', { caseId: c.id, callId: c.callId, status: c.status }),
      },
    );
    for (const text of result.news) this.addNews(input.toGame, text);
    // Whole days are consumed, the remainder stays for the next rollover (a gap over the clamp is dropped).
    const whole = Math.floor((input.toGame - from) / DAY_S);
    this.lastEvolveGame = !Number.isFinite(whole) || whole < 0 ? input.toGame : whole > result.days ? input.toGame : from + whole * DAY_S;
    this.rev++;
    return result;
  }

  // --- Save -----------------------------------------------------------------------------------

  serialize(): WorldStateSave {
    return structuredClone<WorldStateSave>({
      version: 1,
      rng: this.rng.state(),
      lastEvolveGame: this.lastEvolveGame,
      nextCase: this.nextCase,
      premises: [...this.premiseMap.values()],
      cases: this.caseList,
      offenders: this.offenderList,
      witnesses: this.witnessList,
      neighborhoods: this.neighborhoods,
      bias: [...this.biasMap.entries()],
      news: this.newsList,
      queue: this.queue,
    });
  }

  restore(s: WorldStateSave): void {
    this.load(s);
    this.rng.restore(s.rng);
  }

  private load(source: WorldStateSave): void {
    const s = structuredClone(source);
    this.lastEvolveGame = s.lastEvolveGame;
    this.nextCase = s.nextCase;
    this.premiseMap.clear();
    for (const p of s.premises) this.premiseMap.set(p.key, p);
    this.caseList = s.cases;
    this.caseByCall.clear();
    for (const c of this.caseList) this.caseByCall.set(c.callId, c);
    this.offenderList = s.offenders.sort((a, b) => a.personId - b.personId);
    this.offenderMap.clear();
    for (const o of this.offenderList) this.offenderMap.set(o.personId, o);
    this.witnessList = s.witnesses;
    this.witnessMap.clear();
    for (const w of this.witnessList) this.witnessMap.set(w.personId, w);
    this.neighborhoods = s.neighborhoods;
    for (const d of [...CRIME_DISTRICTS, ...Object.keys(this.base)]) {
      if (this.neighborhoods[d] === undefined) this.neighborhoods[d] = newNeighborhood(this.base[d] ?? 0);
    }
    this.biasMap.clear();
    for (const [callId, personId] of s.bias) this.biasMap.set(callId, personId);
    this.newsList = s.news;
    this.queue = s.queue;
    this.rev++;
  }

  // --- Requests -------------------------------------------------------------------------------

  private apply(r: WorldRequest): void {
    switch (r.kind) {
      case 'callClosed':
        this.applyCallClosed(r.call);
        break;
      case 'arrest':
        this.applyArrest(r);
        break;
      case 'verdict': {
        const o = this.offenderMap.get(r.personId);
        if (o !== undefined) releaseAfterVerdict(o, r.verdict, r.game, this.cfg.offenders);
        break;
      }
      case 'caseOpen':
        this.applyCaseOpen(r);
        break;
      case 'caseUpdate': {
        const c = this.caseByCall.get(r.callId);
        if (c === undefined) break;
        const changed = applyCaseUpdate(c, r);
        this.linkWitnesses(c, r.witnessesAdd ?? []);
        if (changed) this.bus.emit('world:case', { caseId: c.id, callId: c.callId, status: c.status });
        break;
      }
      case 'witness':
        this.applyWitness(r);
        break;
    }
  }

  private applyCallClosed(call: Extract<WorldRequest, { kind: 'callClosed' }>['call']): void {
    const key = premiseKey(call.text);
    if (key === '') return;
    let p = this.premiseMap.get(key);
    if (p === undefined) {
      if (this.premiseMap.size >= this.cfg.premises.max) this.evictPremise();
      p = { key, text: call.text.trim(), x: call.x, z: call.z, edge: call.edge, district: call.district, entries: [] };
      this.premiseMap.set(key, p);
    }
    addPremiseEntry(
      p,
      { game: call.game, callNumber: call.number, typeId: call.typeId, nature: call.nature, disposition: call.disposition, flags: [...call.flags] },
      this.cfg.premises,
    );
  }

  private evictPremise(): void {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, p] of this.premiseMap) {
      const last = p.entries.length === 0 ? -Infinity : (p.entries[p.entries.length - 1] as PremiseEntry).game;
      if (last < oldest || oldestKey === null) {
        oldest = last;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.premiseMap.delete(oldestKey);
  }

  private applyArrest(r: Extract<WorldRequest, { kind: 'arrest' }>): void {
    let o = this.offenderMap.get(r.personId);
    if (o === undefined) {
      if (this.offenderList.length >= this.cfg.offenders.max) this.evictOffender();
      o = {
        personId: r.personId, arrests: 0, lastArrestGame: r.game, custody: 'jailed', releaseGame: r.game, risk: 0, district: r.district,
        lastCallNumber: r.callNumber, x: r.x, z: r.z, juvenile: r.juvenile, offenseClass: r.offenseClass, convicted: false,
      };
      this.offenderMap.set(r.personId, o);
      this.insertOffender(o);
    }
    o.arrests++;
    o.lastArrestGame = r.game;
    o.custody = 'jailed';
    o.releaseGame = r.game + this.cfg.offenders.pendingReleaseDays * DAY_S;
    o.district = r.district;
    o.lastCallNumber = r.callNumber;
    o.x = r.x;
    o.z = r.z;
    o.juvenile = r.juvenile;
    o.offenseClass = r.offenseClass;
    o.risk = offenderRisk(o.arrests - 1 + r.priors, r.juvenile, o.convicted, this.cfg.offenders);
    for (const c of this.caseList) {
      if (isActiveCase(c.status) && c.suspects.includes(r.personId)) {
        c.status = 'cleared';
        c.lastGame = r.game;
        this.bus.emit('world:case', { caseId: c.id, callId: c.callId, status: 'cleared' });
      }
    }
  }

  private insertOffender(o: OffenderRecord): void {
    let lo = 0;
    let hi = this.offenderList.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.offenderList[mid] as OffenderRecord).personId < o.personId) lo = mid + 1;
      else hi = mid;
    }
    this.offenderList.splice(lo, 0, o);
  }

  private evictOffender(): void {
    let at = 0;
    for (let i = 1; i < this.offenderList.length; i++) {
      if ((this.offenderList[i] as OffenderRecord).releaseGame < (this.offenderList[at] as OffenderRecord).releaseGame) at = i;
    }
    const [gone] = this.offenderList.splice(at, 1);
    if (gone !== undefined) this.offenderMap.delete(gone.personId);
  }

  private applyCaseOpen(r: Extract<WorldRequest, { kind: 'caseOpen' }>): void {
    if (this.caseByCall.has(r.callId)) return;
    if (this.caseList.length >= this.cfg.cases.max) {
      let at = 0;
      for (let i = 1; i < this.caseList.length; i++) {
        if ((this.caseList[i] as CaseRecord).lastGame < (this.caseList[at] as CaseRecord).lastGame) at = i;
      }
      const [gone] = this.caseList.splice(at, 1);
      if (gone !== undefined) this.caseByCall.delete(gone.callId);
    }
    const c = caseFromRequest(formatCaseId(this.nextCase++), r);
    this.caseList.push(c);
    this.caseByCall.set(c.callId, c);
    this.linkWitnesses(c, c.witnesses);
    this.bus.emit('world:case', { caseId: c.id, callId: c.callId, status: c.status });
  }

  /** Witnesses recorded before their case existed get its id. */
  private linkWitnesses(c: CaseRecord, ids: readonly number[]): void {
    for (const id of ids) {
      const w = this.witnessMap.get(id);
      if (w !== undefined && w.caseId === '') w.caseId = c.id;
    }
  }

  private applyWitness(r: Extract<WorldRequest, { kind: 'witness' }>): void {
    const caseId = this.caseByCall.get(r.callId)?.id ?? '';
    const w = this.witnessMap.get(r.personId);
    if (w !== undefined) {
      w.caseId = caseId !== '' ? caseId : w.caseId;
      w.addressText = r.addressText;
      return;
    }
    if (this.witnessList.length >= this.cfg.witnesses.max) {
      let at = 0;
      for (let i = 1; i < this.witnessList.length; i++) {
        if ((this.witnessList[i] as WitnessRecord).movedGame < (this.witnessList[at] as WitnessRecord).movedGame) at = i;
      }
      const [gone] = this.witnessList.splice(at, 1);
      if (gone !== undefined) this.witnessMap.delete(gone.personId);
    }
    const nw: WitnessRecord = { personId: r.personId, caseId, addressText: r.addressText, movedGame: -1 };
    this.witnessList.push(nw);
    this.witnessMap.set(nw.personId, nw);
  }

  private addNews(game: number, text: string): void {
    this.newsList.push({ game, text });
    while (this.newsList.length > MAX_NEWS) this.newsList.shift();
  }
}
