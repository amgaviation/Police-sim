import { createRng, type Rng, type RngState } from '../core/rng';
import { itemDef } from '../people/items';
import type { CarriedItem, DrugKind, HealthCondition, Intoxication } from '../people';
import { SFST_TESTS, TOOLS, type SfstKey, type SfstTestDef, type SfstTestId } from './data';

/**
 * Field tools (design §9.6): PBT, odor, frisk, search, visual vehicle check and the SFST minigame model.
 * Pure: random draws come from the `Rng` argument (the SFST session derives its own stream from one draw).
 */

export { SFST_TESTS, type SfstTestId };

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- PBT ---------------------------------------------------------------------------

/** Preliminary breath test reading: `max(0, bac + N(0, noiseSd))` rounded to `pbt.round`; below `minReportable` reads 0. */
export function pbtReading(bac: number, rng: Rng): number {
  const t = TOOLS.pbt;
  const noisy = Math.max(0, bac + rng.gaussian(0, t.noiseSd));
  const rounded = Math.round(noisy / t.round) * t.round;
  const value = Math.round(rounded * 1e6) / 1e6;
  return value < t.minReportable ? 0 : value;
}

// --- Odor --------------------------------------------------------------------------

/** Odors an officer within `odor.distanceM` notices: alcohol from the BAC, cannabis from carried cannabis or recent use. */
export function odorOf(items: readonly CarriedItem[], intox: Intoxication): ('alcohol' | 'cannabis')[] {
  const out: ('alcohol' | 'cannabis')[] = [];
  if (intox.bac >= TOOLS.odor.alcoholBac) out.push('alcohol');
  if (intox.drug === 'cannabis' || items.some((i) => itemDef(i.item).odor === 'cannabis')) out.push('cannabis');
  return out;
}

// --- Frisk, search, visual check ---------------------------------------------------

/** Large items a pat-down finds (a bag is felt even when its contents are not). */
const LARGE_ITEMS: readonly string[] = ['backpack', 'stolenGoods'];

/**
 * Pat-down: weapons carried on the body are found with `weaponFindBase - concealment * concealmentFactor`
 * (visible ones always), large items with `largeItemFind`. One draw per candidate, in item order.
 */
export function frisk(items: readonly CarriedItem[], rng: Rng): CarriedItem[] {
  const t = TOOLS.frisk;
  const found: CarriedItem[] = [];
  for (const it of items) {
    const d = itemDef(it.item);
    let p: number;
    if (LARGE_ITEMS.includes(it.item)) p = t.largeItemFind;
    else if (d.weapon && it.where !== 'bag') p = it.visible ? 1 : t.weaponFindBase - d.concealment * t.concealmentFactor;
    else continue;
    if (rng.chance(p)) found.push(it);
  }
  return found;
}

/** Full search: every item is found with `findBase - concealment * concealmentFactor` (one draw per item, in item order). */
export function search(items: readonly CarriedItem[], rng: Rng): CarriedItem[] {
  const t = TOOLS.search;
  const found: CarriedItem[] = [];
  for (const it of items) {
    const p = t.findBase - itemDef(it.item).concealment * t.concealmentFactor;
    if (rng.chance(p)) found.push(it);
  }
  return found;
}

/** Looking into a vehicle from outside: visible items, and poorly concealed ones lying in the cabin. */
export function visualCheck(vehicleItems: readonly CarriedItem[]): CarriedItem[] {
  const limit = TOOLS.visual.revealBelowConcealment;
  return vehicleItems.filter((it) => it.visible || (it.where === 'cabin' && itemDef(it.item).concealment < limit));
}

// --- SFST --------------------------------------------------------------------------

export interface SfstPrompt {
  readonly key: string;
  readonly label: string;
  readonly remainingS: number;
}

export interface SfstResult {
  readonly clues: Readonly<Record<SfstTestId, number>>;
  readonly administered: Readonly<Record<SfstTestId, boolean>>;
  readonly indicates: boolean;
  readonly summary: readonly string[];
}

const KEY_LABEL: Readonly<Record<SfstKey, string>> = { a: 'Left (A)', d: 'Right (D)', w: 'Step (W)', space: 'Hold (Space)' };

/** Plain JSON snapshot of a session (saved with the contact). The session owns a private stream, saved here. */
export interface SfstSave {
  version: 1;
  bac: number;
  drug: DrugKind;
  health: HealthCondition[];
  rng: RngState;
  /** Index into the three tests; 3 = done. */
  testIndex: number;
  phase: 'gap' | 'window';
  timer: number;
  promptIndex: number;
  hits: number;
  key: string;
  /** Clue count rolled when each started test began (index = test). */
  clues: number[];
  /** Hits per finished test. */
  testHits: number[];
}

const DEF: readonly SfstTestDef[] = TOOLS.sfst.tests;
const DONE = DEF.length;

/** True when `x` has the shape of an `SfstSave`. */
export function isSfstSave(x: unknown): x is SfstSave {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const rng = s.rng as Record<string, unknown> | undefined;
  return (
    s.version === 1 &&
    num(s.bac) &&
    typeof s.drug === 'string' &&
    Array.isArray(s.health) &&
    typeof rng === 'object' &&
    rng !== null &&
    num(rng.seed) &&
    Array.isArray(rng.s) &&
    rng.s.length === 4 &&
    num(s.testIndex) &&
    s.testIndex >= 0 &&
    s.testIndex <= DONE &&
    (s.phase === 'gap' || s.phase === 'window') &&
    num(s.timer) &&
    num(s.promptIndex) &&
    num(s.hits) &&
    typeof s.key === 'string' &&
    Array.isArray(s.clues) &&
    s.clues.every(num) &&
    Array.isArray(s.testHits) &&
    s.testHits.every(num)
  );
}

/**
 * Field sobriety test model: three tests in order (HGN, walk and turn, one-leg stand), each a series of
 * timed key prompts. A hit needs the right key inside the window; a late or wrong key is a miss. Clues are
 * rolled when a test starts from the BAC, drug and health (§9.6); a test counts only when at least
 * `minHitShare` of its prompts were hit.
 */
export class SfstSession {
  private readonly bac: number;
  private readonly drug: DrugKind;
  private readonly health: readonly HealthCondition[];
  private readonly rng: Rng;
  private testIndex = 0;
  private phase: 'gap' | 'window' = 'gap';
  private timer = TOOLS.sfst.promptGapS;
  private promptIndex = 0;
  private hits = 0;
  private key = '';
  private clues: number[] = [];
  private testHits: number[] = [];

  constructor(bac: number, drug: DrugKind, health: readonly HealthCondition[], rng: Rng) {
    this.bac = bac;
    this.drug = drug;
    this.health = health;
    // One draw from the caller's stream seeds a private one, so the session saves and restores on its own.
    this.rng = createRng(rng.nextInt(0, 0xffffffff));
    this.startTest();
  }

  /** The running test, or `'done'`. */
  get test(): SfstTestId | 'done' {
    return DEF[this.testIndex]?.id ?? 'done';
  }

  /** The key to press now (inside its window), else null. */
  get prompt(): SfstPrompt | null {
    const def = DEF[this.testIndex];
    if (!def || this.phase !== 'window') return null;
    return { key: this.key, label: KEY_LABEL[this.key as SfstKey] ?? this.key, remainingS: Math.max(0, this.timer) };
  }

  /** Progress through the running test (prompts answered or missed over prompts), 1 when done. */
  get progress(): number {
    const def = DEF[this.testIndex];
    return def ? this.promptIndex / def.prompts : 1;
  }

  get instruction(): string {
    return DEF[this.testIndex]?.instruction ?? '';
  }

  get title(): string {
    return DEF[this.testIndex]?.label ?? 'Sobriety tests complete';
  }

  /** Advances the timers by `dt` seconds: a gap ends with a prompt; an unanswered window is a miss. */
  step(dt: number): void {
    let left = dt;
    while (left > 0 && this.testIndex < DONE) {
      if (left < this.timer) {
        this.timer -= left;
        return;
      }
      left -= this.timer;
      if (this.phase === 'gap') {
        const def = DEF[this.testIndex] as SfstTestDef;
        this.key = this.rng.pick(def.keys);
        this.phase = 'window';
        this.timer = TOOLS.sfst.promptWindowS;
      } else {
        this.advance(false);
      }
    }
  }

  /** The player pressed `key`: the right key inside a window is a hit, a wrong one a miss; outside a window nothing happens. */
  press(key: string): void {
    if (this.testIndex >= DONE || this.phase !== 'window') return;
    this.advance(key === this.key);
  }

  /** Clues, which tests counted and the summary lines; null until all three tests ended. */
  result(): SfstResult | null {
    if (this.testIndex < DONE) return null;
    const clues = { hgn: 0, walkTurn: 0, oneLeg: 0 };
    const administered = { hgn: false, walkTurn: false, oneLeg: false };
    const summary: string[] = [];
    let indicates = false;
    for (const [i, def] of DEF.entries()) {
      const ok = (this.testHits[i] ?? 0) / def.prompts >= TOOLS.sfst.minHitShare;
      const n = this.clues[i] ?? 0;
      administered[def.id] = ok;
      if (ok) {
        clues[def.id] = n;
        if (n >= def.threshold) indicates = true;
        summary.push(`${def.short}: ${n}/${def.maxClues} clues`);
      } else summary.push(`${def.short}: not administered correctly`);
    }
    return { clues, administered, indicates, summary };
  }

  serialize(): SfstSave {
    return {
      version: 1,
      bac: this.bac,
      drug: this.drug,
      health: [...this.health],
      rng: this.rng.state(),
      testIndex: this.testIndex,
      phase: this.phase,
      timer: this.timer,
      promptIndex: this.promptIndex,
      hits: this.hits,
      key: this.key,
      clues: [...this.clues],
      testHits: [...this.testHits],
    };
  }

  static restore(s: SfstSave): SfstSession {
    const session = new SfstSession(s.bac, s.drug, s.health, createRng(0));
    session.rng.restore(s.rng);
    session.testIndex = clamp(Math.floor(s.testIndex), 0, DONE);
    session.phase = s.phase;
    session.timer = s.timer;
    session.promptIndex = s.promptIndex;
    session.hits = s.hits;
    session.key = s.key;
    session.clues = [...s.clues];
    session.testHits = [...s.testHits];
    return session;
  }

  /** Records the answer to the current prompt and moves to the next gap, the next test or the end. */
  private advance(hit: boolean): void {
    const def = DEF[this.testIndex] as SfstTestDef;
    if (hit) this.hits += 1;
    this.promptIndex += 1;
    if (this.promptIndex >= def.prompts) {
      this.testHits[this.testIndex] = this.hits;
      this.testIndex += 1;
      this.promptIndex = 0;
      this.hits = 0;
      this.key = '';
      this.phase = 'gap';
      this.timer = TOOLS.sfst.promptGapS;
      if (this.testIndex < DONE) this.startTest();
      return;
    }
    this.phase = 'gap';
    this.timer = TOOLS.sfst.promptGapS;
    this.key = '';
  }

  /** Rolls the clues of the test that starts now: `round(expected + N(0, clueSd))` clamped to [0, maxClues]. */
  private startTest(): void {
    const def = DEF[this.testIndex] as SfstTestDef;
    const t = TOOLS.sfst;
    let expected = def.maxClues * clamp((this.bac - def.bacStart) / def.bacSpan, 0, 1);
    expected += t.drugClues.get(this.drug)?.get(def.id) ?? 0;
    if (this.health.includes('diabetic') && this.rng.next() < t.diabeticChance) expected += t.diabeticClues.get(def.id) ?? 0;
    this.clues[this.testIndex] = clamp(Math.round(expected + this.rng.gaussian(0, t.clueSd)), 0, def.maxClues);
    this.phase = 'gap';
    this.timer = t.promptGapS;
    this.promptIndex = 0;
    this.hits = 0;
  }
}
