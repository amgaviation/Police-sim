import { OFFENSES, type IndicatorDef, type Offense, type Ruleset } from './types';

interface Entry {
  indicator: string; eventId: number; t: number; tainted: boolean;
  /** Null for an indicator the ruleset does not know. */
  def: IndicatorDef | null;
  /** Index into `OFFENSES` of the offense it counts toward (-1 none). */
  off: number;
}

/**
 * Indicator book (design §5.5): the suspicion evidence recorded per person. Tainted indicators (fruit of an unlawful act)
 * never count. Entries of person -1 apply to every person of the incident.
 */
export class IndicatorBook {
  private readonly set: Ruleset;
  private family = '';
  private readonly roles = new Map<number, string>();
  private readonly own = new Map<number, Entry[]>();
  private readonly shared: Entry[] = [];
  private readonly scratch = new Float64Array(OFFENSES.length);

  constructor(rs: Ruleset) {
    this.set = rs;
  }

  /** The call family (resolves `callSuspect`'s offense through `rs.familyOffense`). */
  setFamily(family: string): void {
    this.family = family;
    const refresh = (entries: Entry[]): void => {
      for (const en of entries) if (en.indicator === 'callSuspect') en.off = this.offenseIndex(en.indicator);
    };
    refresh(this.shared);
    for (const entries of this.own.values()) refresh(entries);
  }

  /** A person's role (`licenseInvalid` counts only for role `driver`). */
  setRole(personId: number, role: string): void {
    this.roles.set(personId, role);
  }

  /** Records an indicator for `personId` (-1 = applies to every person of the incident). */
  add(personId: number, indicator: string, eventId: number, t: number, tainted: boolean): void {
    const entry: Entry = { indicator, eventId, t, tainted, def: this.set.indicators[indicator] ?? null, off: this.offenseIndex(indicator) };
    if (personId === -1) {
      this.shared.push(entry);
      return;
    }
    const list = this.own.get(personId);
    if (list) list.push(entry);
    else this.own.set(personId, [entry]);
  }

  /** The offense an indicator counts toward (`callSuspect` follows the call family). */
  offenseOf(indicator: string): Offense | null {
    const def = this.set.indicators[indicator];
    if (!def) return null;
    if (indicator === 'callSuspect') return this.set.familyOffense[this.family] ?? def.offense;
    return def.offense;
  }

  private offenseIndex(indicator: string): number {
    const off = this.offenseOf(indicator);
    return off === null ? -1 : OFFENSES.indexOf(off);
  }

  /** Whether `entry` counts for `personId` at `t`. */
  private counts(entry: Entry, personId: number, t: number): boolean {
    if (entry.tainted || entry.t > t || entry.def === null) return false;
    return entry.indicator !== 'licenseInvalid' || this.roles.get(personId) === 'driver';
  }

  private sum(personId: number, t: number, field: 'rs' | 'pc' | 'armed', offense: Offense | null): number {
    let total = 0;
    const offenseIdx = offense === null ? -1 : OFFENSES.indexOf(offense);
    const list = personId === -1 ? undefined : this.own.get(personId);
    for (let pass = 0; pass < 2; pass++) {
      const entries = pass === 0 ? list : this.shared;
      if (!entries) continue;
      for (let i = 0; i < entries.length; i++) {
        const en = entries[i];
        if (!en || !this.counts(en, personId, t)) continue;
        if (offenseIdx >= 0 && en.off !== offenseIdx) continue;
        if (en.def) total += en.def[field];
      }
    }
    return total;
  }

  /** Sum of reasonable-suspicion weights over untainted entries with t' <= `t` for the person plus person -1. */
  rs(personId: number, t: number): number {
    return this.sum(personId, t, 'rs', null);
  }

  /** Probable-cause weight toward `offense`. */
  pc(personId: number, offense: Offense, t: number): number {
    return this.sum(personId, t, 'pc', offense);
  }

  /** Armed-and-dangerous weight. */
  armed(personId: number, t: number): number {
    return this.sum(personId, t, 'armed', null);
  }

  /**
   * The pc per offense (index = `OFFENSES` order) as a scratch array that the next query overwrites: copy what you need.
   */
  pcTable(personId: number, t: number): Float64Array {
    this.scratch.fill(0);
    const list = personId === -1 ? undefined : this.own.get(personId);
    for (let pass = 0; pass < 2; pass++) {
      const entries = pass === 0 ? list : this.shared;
      if (!entries) continue;
      for (let i = 0; i < entries.length; i++) {
        const en = entries[i];
        if (!en || !this.counts(en, personId, t)) continue;
        if (!en.def || en.off < 0) continue;
        this.scratch[en.off] = (this.scratch[en.off] ?? 0) + en.def.pc;
      }
    }
    return this.scratch;
  }

  /**
   * Offense with the highest pc at `t` among those with pc >= thresholds.pc, filtered by `arrestable` when asked; ties
   * go to the more severe offense. Null when none.
   */
  bestPc(personId: number, t: number, arrestableOnly: boolean): Offense | null {
    const all = this.pcTable(personId, t);
    let best: Offense | null = null;
    let bestPc = 0;
    for (let i = 0; i < OFFENSES.length; i++) {
      const o = OFFENSES[i];
      const v = all[i];
      if (o === undefined || v === undefined || v < this.set.thresholds.pc) continue;
      const def = this.set.offenses[o];
      if (arrestableOnly && !def.arrestable) continue;
      if (best === null || v > bestPc || (v === bestPc && def.severity > this.set.offenses[best].severity)) {
        best = o;
        bestPc = v;
      }
    }
    return best;
  }

  /** Highest-severity offense with any untainted indicator (pc > 0 or rs > 0) at `t`, null when none. */
  knownOffense(personId: number, t: number): Offense | null {
    let best: Offense | null = null;
    const list = personId === -1 ? undefined : this.own.get(personId);
    for (let pass = 0; pass < 2; pass++) {
      const entries = pass === 0 ? list : this.shared;
      if (!entries) continue;
      for (let i = 0; i < entries.length; i++) {
        const en = entries[i];
        if (!en || !this.counts(en, personId, t)) continue;
        const def = en.def;
        const off = en.off >= 0 ? OFFENSES[en.off] : undefined;
        if (!def || off === undefined || (def.pc <= 0 && def.rs <= 0)) continue;
        if (best === null || this.set.offenses[off].severity > this.set.offenses[best].severity) best = off;
      }
    }
    return best;
  }

  /** Untainted only. */
  has(personId: number, indicator: string, t: number): boolean {
    const list = personId === -1 ? undefined : this.own.get(personId);
    for (let pass = 0; pass < 2; pass++) {
      const entries = pass === 0 ? list : this.shared;
      if (!entries) continue;
      for (let i = 0; i < entries.length; i++) {
        const en = entries[i];
        if (en && en.indicator === indicator && this.counts(en, personId, t)) return true;
      }
    }
    return false;
  }

  /** Distinct untainted indicator ids counting for the person at `t`, in the order first recorded (for reasons / UI). */
  indicators(personId: number, t: number): string[] {
    const out: string[] = [];
    const list = personId === -1 ? undefined : this.own.get(personId);
    for (let pass = 0; pass < 2; pass++) {
      const entries = pass === 0 ? list : this.shared;
      if (!entries) continue;
      for (let i = 0; i < entries.length; i++) {
        const en = entries[i];
        if (en && this.counts(en, personId, t) && !out.includes(en.indicator)) out.push(en.indicator);
      }
    }
    return out;
  }
}
