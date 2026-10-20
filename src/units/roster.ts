/**
 * The officer roster (design §5.4): profiles are pure functions of the seed and callsign (never saved);
 * the dynamic state (stress, fatigue, loyalty and counters) is what `serialize` stores.
 */
import { ROSTER_CONFIG } from './data';
import { officerStart } from './personality';
import { RANKS, type OfficerDynamic, type OfficerProfile, type Rank, type RosterConfig, type RosterEvent, type RosterSave } from './types';

interface Entry {
  readonly profile: OfficerProfile;
  readonly dyn: OfficerDynamic;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The AI officers of a session: ensured on demand, stepped per game minute, saved as `RosterSave`. */
export class RosterState {
  /** Bumped on every change (for cheap UI refresh checks). */
  revision = 0;
  private readonly byCallsign = new Map<string, Entry>();
  /** Insertion order; iterated by index so `stepMinutes` allocates nothing. */
  private readonly entries: Entry[] = [];
  private readonly names: string[] = [];

  private readonly seed: number;
  private readonly cfg: RosterConfig;

  constructor(seed: number, cfg: RosterConfig = ROSTER_CONFIG) {
    this.seed = seed;
    this.cfg = cfg;
  }

  /** Adds the officer if missing (dynamic state from the profile: stress/fatigue start, loyalty from its range using the profile stream). */
  ensure(callsign: string, rank: Rank): OfficerProfile {
    const have = this.byCallsign.get(callsign);
    if (have) return have.profile;
    const { profile, loyalty } = officerStart(this.seed, callsign, rank, this.cfg);
    const dyn: OfficerDynamic = {
      stress: this.cfg.stress.start,
      fatigue: this.cfg.fatigue.start,
      loyalty,
      calls: 0,
      mistakes: 0,
      arrivals: 0,
    };
    this.add({ profile, dyn });
    return profile;
  }

  profile(callsign: string): OfficerProfile | null {
    return this.byCallsign.get(callsign)?.profile ?? null;
  }

  /** The live dynamic state (mutated by the roster; read it, do not write it). */
  dynamic(callsign: string): OfficerDynamic | null {
    return this.byCallsign.get(callsign)?.dyn ?? null;
  }

  /** Applies the data delta of `kind` (clamped 0..1); 'callHandled' also adds fatigue.perCall and calls += 1. */
  applyEvent(callsign: string, kind: RosterEvent): void {
    const e = this.byCallsign.get(callsign);
    if (!e) return;
    const ds = this.cfg.stress.events[kind];
    if (ds !== undefined) e.dyn.stress = clamp(e.dyn.stress + ds, 0, 1);
    const dl = this.cfg.loyalty.events[kind];
    if (dl !== undefined) e.dyn.loyalty = clamp(e.dyn.loyalty + dl, 0, 1);
    if (kind === 'callHandled') {
      e.dyn.fatigue = clamp(e.dyn.fatigue + this.cfg.fatigue.perCall, 0, this.cfg.fatigue.max);
      e.dyn.calls += 1;
    }
    this.revision++;
  }

  /** Bumps the arrival counter and returns the new value (the `seq` of rollMistakes); 0 for an unknown callsign. */
  nextArrival(callsign: string): number {
    const e = this.byCallsign.get(callsign);
    if (!e) return 0;
    e.dyn.arrivals += 1;
    this.revision++;
    return e.dyn.arrivals;
  }

  noteMistake(callsign: string): void {
    const e = this.byCallsign.get(callsign);
    if (!e) return;
    e.dyn.mistakes += 1;
    this.revision++;
  }

  /** Per game minute (call with whole minutes elapsed): stress -= decayPerMin * (0.5 + composure), fatigue += perHour / 60. */
  stepMinutes(minutes: number): void {
    if (!(minutes > 0) || this.entries.length === 0) return;
    const { decayPerMin } = this.cfg.stress;
    const { perHour, max } = this.cfg.fatigue;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e) continue;
      e.dyn.stress = Math.max(0, e.dyn.stress - decayPerMin * (0.5 + e.profile.traits.composure) * minutes);
      e.dyn.fatigue = Math.min(max, e.dyn.fatigue + (perHour / 60) * minutes);
    }
    this.revision++;
  }

  /** New shift: fatigue = start, stress = start (loyalty kept). */
  startShift(): void {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e) continue;
      e.dyn.stress = this.cfg.stress.start;
      e.dyn.fatigue = this.cfg.fatigue.start;
    }
    this.revision++;
  }

  /** Callsigns in the order they were added. */
  callsigns(): readonly string[] {
    return this.names;
  }

  serialize(): RosterSave {
    return {
      version: 1,
      officers: this.entries.map((e) => ({
        callsign: e.profile.callsign,
        rank: e.profile.rank,
        stress: e.dyn.stress,
        fatigue: e.dyn.fatigue,
        loyalty: e.dyn.loyalty,
        calls: e.dyn.calls,
        mistakes: e.dyn.mistakes,
        arrivals: e.dyn.arrivals,
      })),
    };
  }

  /** Replaces the roster: profiles are rebuilt from the seed, the dynamic state comes from `s` (values clamped). */
  restore(s: RosterSave): void {
    this.byCallsign.clear();
    this.entries.length = 0;
    this.names.length = 0;
    for (const o of s.officers) {
      if (this.byCallsign.has(o.callsign)) continue;
      const { profile } = officerStart(this.seed, o.callsign, o.rank, this.cfg);
      this.add({
        profile,
        dyn: {
          stress: clamp(o.stress, 0, 1),
          fatigue: clamp(o.fatigue, 0, this.cfg.fatigue.max),
          loyalty: clamp(o.loyalty, 0, 1),
          calls: Math.max(0, Math.floor(o.calls)),
          mistakes: Math.max(0, Math.floor(o.mistakes)),
          arrivals: Math.max(0, Math.floor(o.arrivals)),
        },
      });
    }
    this.revision++;
  }

  private add(e: Entry): void {
    this.byCallsign.set(e.profile.callsign, e);
    this.entries.push(e);
    this.names.push(e.profile.callsign);
    this.revision++;
  }
}

function isCount(x: unknown): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

function isUnit(x: unknown): boolean {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
}

/** Structural check of a saved roster (version 1, unique callsigns, values in range). */
export function isRosterSave(x: unknown): x is RosterSave {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as { version?: unknown; officers?: unknown };
  if (r.version !== 1 || !Array.isArray(r.officers)) return false;
  const seen = new Set<string>();
  for (const raw of r.officers as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return false;
    const o = raw as Record<string, unknown>;
    if (typeof o.callsign !== 'string' || o.callsign === '' || seen.has(o.callsign)) return false;
    seen.add(o.callsign);
    if (typeof o.rank !== 'string' || !(RANKS as readonly string[]).includes(o.rank)) return false;
    if (!isUnit(o.stress) || !isUnit(o.fatigue) || !isUnit(o.loyalty)) return false;
    if (!isCount(o.calls) || !isCount(o.mistakes) || !isCount(o.arrivals)) return false;
  }
  return true;
}

/** `{ version: 1, officers: [] }`. */
export function emptyRosterSave(): RosterSave {
  return { version: 1, officers: [] };
}
