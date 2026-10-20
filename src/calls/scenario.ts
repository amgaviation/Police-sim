/**
 * Scenario builder (Phase 3 design §6.3): the hidden truth of a call as a pure function of the input
 * and an `Rng` (the scene passes `createRng(seed).stream('scenario:' + callId)`). Nothing here touches
 * THREE, the DOM or the clock.
 *
 * Draw order (fixed; tests replay it):
 *  1. `pickVariants`: 3 draws (exclusive group, duplicate, escalation/de-escalation).
 *  2. Branch: 1 draw (`pickBranch`), none for derived families.
 *  3. Dispatch-error rolls: wrongAddress, wrongDescription, missingWeapon (3 draws).
 *  4. Anchor: side, address shift magnitude, address shift sign (3 draws).
 *  5. Vehicles in role order (count, then `pickVehicle` unless forced).
 *  6. Participants in role order (count, person, items, intoxication, injured).
 *  7. Evidence chances; then the timeline: description (a replacement colour when wrong), corrections,
 *     escalation / de-escalation, duplicate callers, the linked call, the ambush.
 */
import type { Rng } from '../core/rng';
import type { RoadEdge, RoadGraph } from '../world/roadGraph';
import { CALL_CATALOG, callTypeDef, familyForType } from './catalog';
import { applyVariantRoles, branchFlagsFor, effectiveRoles, effectiveVehicles } from './effective';
import type {
  BranchDef,
  CallTypeDef,
  FamilyDef,
  PersonConstraint,
  RoleDef,
  Spot,
  VariantConfig,
  VariantKind,
} from './types';

export interface PersonDescription {
  readonly sex: 'M' | 'F';
  readonly ageBand: string;
  readonly top: string;
  readonly bottom: string;
  readonly hair: string;
  readonly heightText: string;
}

export interface ScenarioInput {
  readonly seed: number;
  readonly callId: number;
  readonly typeId: string;
  readonly priority: number;
  readonly location: {
    readonly x: number;
    readonly z: number;
    readonly edge: number;
    readonly text: string;
    readonly near: string;
    readonly street: string;
  };
  /** CAD caller person id, -1 when not a citizen. */
  readonly callerPersonId: number;
  /** CAD call vehicles[0] (the narrative `{plate}` car) or -1. */
  readonly reportedVehicleId: number;
  /** An active traffic car the scenario is about (stop, pursuit) or -1: the first vehicle role uses it (`existing`). */
  readonly existingVehicleId: number;
  /** Person ids for `person: "given"` roles, in role order. */
  readonly given: readonly number[];
  /** For `derived` families. */
  readonly derivedBranch: string | null;
  /** Only `edges` is read (point projection and length). */
  readonly graph: Pick<RoadGraph, 'edges'>;
  /** Scene: constraint search, excludes busy persons. */
  pickPerson(c: PersonConstraint, rng: Rng): number;
  /** `occupantsOf(...)[0]` of the vehicle. */
  driverOf(vehicleId: number): number;
  /** A registry vehicle that can be on the road. */
  pickVehicle(rng: Rng): number;
  describe(personId: number): PersonDescription;
  /** CAD `addressOnEdge` text. */
  addressAt(edge: number, s: number): string;
  /** Optional: age in years, used for `juvenile:<role>` flags (else inferred from `describe().ageBand`). */
  ageOf?(personId: number): number;
  /**
   * Optional (default 1): multiplies the three `dispatchErrors` rates (`wrongAddress`, `wrongDescription`,
   * `missingWeapon`) before they are compared with their draws (community trust: poor trust means worse tips). The draws
   * are the same with any scale, only the comparisons move. 0 gives no dispatch errors at all.
   */
  readonly errorScale?: number;
}

export interface Participant {
  readonly index: number;
  readonly role: string;
  /** -1 for animals. */
  readonly personId: number;
  readonly profile: string;
  readonly spot: Spot;
  /** nth participant on that spot. */
  readonly spotIndex: number;
  readonly items: readonly string[];
  readonly weapon: string | null;
  readonly intoxication: { readonly bac: number; readonly drug: string } | null;
  readonly injured: boolean;
  readonly deceased: boolean;
  readonly body: 'human' | 'dog';
  /** Scenario vehicle index, -1. */
  readonly vehicle: number;
  /** Seat in that vehicle, -1. */
  readonly seat: number;
}

export interface SceneVehicleSpec {
  readonly index: number;
  readonly role: string;
  readonly vehicleId: number;
  readonly mode: 'driving' | 'parked' | 'crashed';
  readonly behavior: 'normal' | 'dui';
  readonly flee: number;
  readonly reported: boolean;
  /** Never spawned (an active traffic car). */
  readonly existing: boolean;
}

export interface GroundItemSpec {
  readonly item: string;
  readonly spot: Spot;
  readonly spotIndex: number;
}

export type TimelineKind =
  | 'describe'
  | 'narrative'
  | 'priority'
  | 'escalate'
  | 'deescalate'
  | 'duplicateCaller'
  | 'linkedCall'
  | 'correction'
  | 'unitReport'
  | 'ambush';

/** Start of the narrative that corrects a wrong dispatch address (the scene then moves the call). */
export const LOCATION_CORRECTION = 'Correction: RP advises the location is';

export interface TimelineEntry {
  /** Sim seconds after creation. */
  readonly atS: number;
  readonly kind: TimelineKind;
  readonly text: string;
  /** 0 = none. */
  readonly priority: number;
  /** -1 = none. */
  readonly callerPersonId: number;
}

export interface Anchor {
  readonly x: number;
  readonly z: number;
  readonly edge: number;
  /** Metres along the edge. */
  readonly s: number;
  readonly side: 1 | -1;
}

export interface Scenario {
  readonly version: 1;
  readonly callId: number;
  readonly typeId: string;
  readonly family: string;
  readonly variants: readonly VariantKind[];
  readonly branch: string;
  /** The true anchor. */
  readonly anchor: Anchor;
  /** Where dispatch said it was (differs with `errors.wrongAddress`). */
  readonly reported: Anchor;
  readonly participants: readonly Participant[];
  readonly vehicles: readonly SceneVehicleSpec[];
  readonly evidence: readonly GroundItemSpec[];
  readonly timeline: readonly TimelineEntry[];
  readonly flags: readonly string[];
  readonly errors: { readonly wrongAddress: boolean; readonly wrongDescription: boolean; readonly missingWeapon: boolean };
}

// --- Variants and branch --------------------------------------------------------------------------

/**
 * Variants of a call: the exclusive group `false | swatting | ambush` first (one draw), then `duplicate`
 * independently, then one draw for `escalation` vs `deescalation` (neither after an exclusive kind).
 * Always three draws, so the stream does not depend on the multipliers. `multipliers` scale the rates.
 */
export function pickVariants(
  rates: VariantConfig['rates'],
  multipliers: Readonly<Record<VariantKind, number>>,
  rng: Rng,
): VariantKind[] {
  const out: VariantKind[] = [];
  const uExclusive = rng.next();
  const uDuplicate = rng.next();
  const uEscalate = rng.next();
  const pFalse = rates.false * multipliers.false;
  const pSwat = rates.swatting * multipliers.swatting;
  const pAmbush = rates.ambush * multipliers.ambush;
  let exclusive = false;
  if (uExclusive < pFalse) {
    out.push('false');
    exclusive = true;
  } else if (uExclusive < pFalse + pSwat) {
    out.push('swatting');
    exclusive = true;
  } else if (uExclusive < pFalse + pSwat + pAmbush) {
    out.push('ambush');
    exclusive = true;
  }
  if (uDuplicate < rates.duplicate * multipliers.duplicate) out.push('duplicate');
  if (!exclusive) {
    const pEsc = rates.escalation * multipliers.escalation;
    const pDe = rates.deescalation * multipliers.deescalation;
    if (uEscalate < pEsc) out.push('escalation');
    else if (uEscalate < pEsc + pDe) out.push('deescalation');
  }
  return out;
}

/** Branch by weight (the type's `branchWeights` override the family's); one draw. */
export function pickBranch(family: FamilyDef, type: CallTypeDef | null, rng: Rng): BranchDef {
  const u = rng.next();
  let total = 0;
  const weights = family.branches.map((b) => {
    const w = type?.branchWeights[b.id] ?? b.weight;
    total += w;
    return w;
  });
  const first = family.branches[0];
  if (!first) throw new Error(`Family ${family.id} has no branches`);
  if (total <= 0) return first;
  let x = u * total;
  for (let i = 0; i < family.branches.length; i++) {
    x -= weights[i] ?? 0;
    if (x < 0) return family.branches[i] ?? first;
  }
  let last = first;
  for (let i = 0; i < family.branches.length; i++) if ((weights[i] ?? 0) > 0) last = family.branches[i] ?? last;
  return last;
}

// --- Geometry -------------------------------------------------------------------------------------

/** Metres along the edge of the point on its polyline nearest (x, z). */
function projectOnEdge(e: RoadEdge, x: number, z: number): number {
  const p = e.points;
  let best = Infinity;
  let bestS = 0;
  let run = 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i] ?? 0, az = p[i + 1] ?? 0, bx = p[i + 2] ?? 0, bz = p[i + 3] ?? 0;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const t = len > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (len * len))) : 0;
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < best) {
      best = d;
      bestS = run + len * t;
    }
    run += len;
  }
  return Math.min(Math.max(bestS, 0), e.length);
}

/** Centreline point `s` metres along the edge (clamped). */
function pointAlongEdge(e: RoadEdge, s: number): { x: number; z: number } {
  const p = e.points;
  let rest = Math.max(0, s);
  let x = p[0] ?? 0;
  let z = p[1] ?? 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i] ?? 0, az = p[i + 1] ?? 0, bx = p[i + 2] ?? 0, bz = p[i + 3] ?? 0;
    const len = Math.hypot(bx - ax, bz - az);
    if (rest <= len || i + 4 >= p.length) {
      const t = len > 0 ? Math.min(1, rest / len) : 0;
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t };
    }
    rest -= len;
    x = bx;
    z = bz;
  }
  return { x, z };
}

// --- Text -----------------------------------------------------------------------------------------

/** Top colour names of the people palette (a wrong description picks another). */
/** "a blue top" / "an orange top": one phrase for the radio, the correction and the foot-pursuit call. */
export function topPhrase(colour: string): string {
  return `${/^[aeiou]/i.test(colour) ? 'an' : 'a'} ${colour} top`;
}

const TOP_NAMES = ['black', 'white', 'gray', 'red', 'blue', 'green', 'yellow', 'brown', 'navy', 'orange'] as const;

const WEAPON_LABEL: Readonly<Record<string, string>> = {
  knife: 'knife',
  handgun: 'handgun',
  brassKnuckles: 'set of brass knuckles',
};

function weaponLabel(item: string): string {
  return Object.hasOwn(WEAPON_LABEL, item) ? (WEAPON_LABEL[item] ?? item) : item;
}

function isJuvenile(input: ScenarioInput, personId: number): boolean {
  if (input.ageOf) return input.ageOf(personId) < 18;
  return /teen|juvenile|minor/i.test(input.describe(personId).ageBand);
}

function between(rng: Rng, range: readonly [number, number]): number {
  return range[0] === range[1] ? range[0] : rng.nextFloat(range[0], range[1]);
}

// --- Builder --------------------------------------------------------------------------------------

/** Builds the hidden truth of a call (draw order in the file header). Throws for a type without a family. */
export function buildScenario(input: ScenarioInput, rng: Rng): Scenario {
  const family = familyForType(input.typeId);
  if (!family) throw new Error(`Call type ${JSON.stringify(input.typeId)} has no scenario family`);
  const type = callTypeDef(input.typeId);
  const cfg = CALL_CATALOG.variants;

  // 1. Variants and branch.
  const variants = pickVariants(cfg.rates, type?.variants ?? family.variants, rng);
  let branch: BranchDef;
  if (family.derived) {
    const found = family.branches.find((b) => b.id === input.derivedBranch);
    const first = family.branches[0];
    if (!found && !first) throw new Error(`Family ${family.id} has no branches`);
    branch = found ?? (first as BranchDef);
  } else {
    branch = pickBranch(family, type, rng);
  }

  // 2. Dispatch errors (raw rolls; the anchor decides whether an address error applies).
  const uAddress = rng.next();
  const uDescription = rng.next();
  const uWeapon = rng.next();

  // 3. Anchor.
  const edge = input.location.edge >= 0 ? input.graph.edges[input.location.edge] : undefined;
  const side: 1 | -1 = rng.next() < 0.5 ? 1 : -1;
  const shiftM = between(rng, cfg.dispatchErrors.addressShiftM);
  const shiftSign = rng.next() < 0.5 ? 1 : -1;
  const errorScale = input.errorScale ?? 1;
  const wrongAddress = uAddress < cfg.dispatchErrors.wrongAddress * errorScale && !family.derived && edge !== undefined && edge.length >= 10;
  let reported: Anchor;
  let anchor: Anchor;
  if (edge) {
    const s = projectOnEdge(edge, input.location.x, input.location.z);
    const at = pointAlongEdge(edge, s);
    reported = { x: at.x, z: at.z, edge: edge.id, s, side };
    if (wrongAddress) {
      const s2 = Math.min(Math.max(s + shiftSign * shiftM, 5), edge.length - 5);
      const at2 = pointAlongEdge(edge, s2);
      anchor = { x: at2.x, z: at2.z, edge: edge.id, s: s2, side };
    } else {
      anchor = reported;
    }
  } else {
    reported = { x: input.location.x, z: input.location.z, edge: -1, s: 0, side };
    anchor = reported;
  }
  const errors = {
    wrongAddress,
    wrongDescription: uDescription < cfg.dispatchErrors.wrongDescription * errorScale,
    missingWeapon: uWeapon < cfg.dispatchErrors.missingWeapon * errorScale,
  };

  // 4. Effective roles and vehicles.
  const effective = applyVariantRoles(effectiveRoles(family, branch), effectiveVehicles(family, branch), variants);

  // 5. Vehicles.
  const vehicles: SceneVehicleSpec[] = [];
  const vehicleOfRole = new Map<string, number>();
  let forcedExisting = input.existingVehicleId >= 0;
  for (const v of effective.vehicles) {
    const count = rng.nextInt(v.count[0], v.count[1]);
    for (let k = 0; k < count; k++) {
      let vehicleId: number;
      let existing = false;
      if (forcedExisting) {
        vehicleId = input.existingVehicleId;
        existing = true;
        forcedExisting = false;
      } else if (v.reported && input.reportedVehicleId >= 0 && !vehicles.some((x) => x.reported)) {
        vehicleId = input.reportedVehicleId;
      } else {
        vehicleId = input.pickVehicle(rng);
      }
      const index = vehicles.length;
      if (!vehicleOfRole.has(v.role)) vehicleOfRole.set(v.role, index);
      vehicles.push({ index, role: v.role, vehicleId, mode: v.mode, behavior: v.behavior, flee: v.flee, reported: v.reported, existing });
    }
  }

  // 6. Participants.
  const participants: Participant[] = [];
  const used = new Set<number>();
  const spotCount = new Map<Spot, number>();
  const seatCount = new Map<number, number>();
  let givenAt = 0;
  const pick = (c: PersonConstraint): number => {
    let id = input.pickPerson(c, rng);
    for (let attempt = 0; attempt < 4 && used.has(id); attempt++) id = input.pickPerson(c, rng);
    used.add(id);
    return id;
  };
  const resolvePerson = (role: RoleDef, k: number, vehicleIndex: number): number => {
    const src = role.person;
    if (src === 'caller') {
      if (k === 0 && input.callerPersonId >= 0 && !used.has(input.callerPersonId)) {
        used.add(input.callerPersonId);
        return input.callerPersonId;
      }
      return pick({ minAge: 18 });
    }
    if (src === 'driver') {
      const v = vehicles[vehicleIndex];
      if (v && k === 0) {
        const id = input.driverOf(v.vehicleId);
        used.add(id);
        return id;
      }
      return pick({ minAge: 16 });
    }
    if (src === 'given') {
      const id = input.given[givenAt++];
      if (id !== undefined) {
        used.add(id);
        return id;
      }
      return pick({});
    }
    return pick(src);
  };
  for (const role of effective.roles) {
    const count = rng.nextInt(role.count[0], role.count[1]);
    const vehicleIndex = role.vehicle !== null ? (vehicleOfRole.get(role.vehicle) ?? -1) : -1;
    const spot: Spot = role.spot === 'vehicle' && vehicleIndex < 0 ? 'curb' : role.spot;
    for (let k = 0; k < count; k++) {
      const personId = role.body === 'dog' ? -1 : resolvePerson(role, k, vehicleIndex);
      const items: string[] = [];
      for (const it of role.items) if (it.chance > 0 && rng.next() < it.chance) items.push(it.item);
      let intoxication: Participant['intoxication'] = null;
      if (role.intoxication && role.intoxication.chance > 0 && rng.next() < role.intoxication.chance) {
        const [lo, hi] = role.intoxication.bac;
        intoxication = { bac: lo === hi ? lo : rng.nextFloat(lo, hi), drug: role.intoxication.drug };
      }
      const injured = role.injured > 0 && rng.next() < role.injured;
      const spotIndex = spotCount.get(spot) ?? 0;
      spotCount.set(spot, spotIndex + 1);
      let seat = -1;
      if (spot === 'vehicle' && vehicleIndex >= 0) {
        const n = seatCount.get(vehicleIndex) ?? 0;
        seatCount.set(vehicleIndex, n + 1);
        seat = n <= 3 ? n : -1;
      }
      participants.push({
        index: participants.length,
        role: role.role,
        personId,
        profile: role.profile,
        spot,
        spotIndex,
        items,
        weapon: role.weapon,
        intoxication,
        injured,
        deceased: role.deceased,
        body: role.body,
        vehicle: spot === 'vehicle' || role.vehicle !== null ? vehicleIndex : -1,
        seat,
      });
    }
  }

  // 7. Evidence.
  const evidence: GroundItemSpec[] = [];
  const evidenceCount = new Map<Spot, number>();
  for (const e of family.evidence) {
    if (e.chance > 0 && rng.next() < e.chance) {
      const spotIndex = evidenceCount.get(e.spot) ?? 0;
      evidenceCount.set(e.spot, spotIndex + 1);
      evidence.push({ item: e.item, spot: e.spot, spotIndex });
    }
  }

  // 8. Flags.
  const flags = new Set<string>();
  flags.add(`branch:${branch.id}`);
  for (const v of variants) flags.add(`variant:${v}`);
  for (const p of participants) {
    flags.add(`role:${p.role}`);
    if (p.body === 'human' && p.personId >= 0 && isJuvenile(input, p.personId)) flags.add(`juvenile:${p.role}`);
  }
  for (const f of branchFlagsFor(branch, variants)) flags.add(f);

  // 9. Timeline.
  const timeline: TimelineEntry[] = [];
  const entry = (atS: number, kind: TimelineKind, text: string, priority = 0, callerPersonId = -1): void => {
    timeline.push({ atS, kind, text, priority, callerPersonId });
  };
  const described = family.describe === null ? undefined : participants.find((p) => p.role === family.describe && p.body === 'human');
  if (described) {
    const d = input.describe(described.personId);
    let top = d.top;
    if (errors.wrongDescription) {
      top = rng.pick(TOP_NAMES.filter((t) => t !== d.top));
    }
    const sexWord = d.sex === 'M' ? 'male' : 'female';
    const weaponText = described.weapon !== null && !errors.missingWeapon ? `, armed with a ${weaponLabel(described.weapon)}` : '';
    entry(0, 'describe', `RP describes the subject as a ${sexWord} ${d.ageBand}, ${d.heightText}, wearing ${topPhrase(top)} and ${d.bottom}${weaponText}.`);
    const dc = cfg.dispatchErrors.correctionDelayS;
    if (errors.wrongDescription) entry(between(rng, dc), 'correction', `Correction: subject is wearing ${topPhrase(d.top)}.`);
    if (errors.missingWeapon && described.weapon !== null) {
      entry(between(rng, dc), 'correction', `Update: second caller advises the subject has a ${weaponLabel(described.weapon)}.`);
    }
  }
  if (errors.wrongAddress) {
    entry(between(rng, cfg.dispatchErrors.correctionDelayS), 'correction', `${LOCATION_CORRECTION} ${input.addressAt(anchor.edge, anchor.s)}.`);
  }
  if (variants.includes('escalation') && family.escalation) {
    entry(between(rng, cfg.escalation.delayS), 'escalate', rng.pick(family.escalation.narratives), Math.max(1, input.priority + cfg.escalation.priorityDelta));
  }
  if (variants.includes('deescalation') && family.deescalation) {
    entry(between(rng, cfg.deescalation.delayS), 'deescalate', rng.pick(family.deescalation.narratives), Math.min(4, input.priority + cfg.deescalation.priorityDelta));
  }
  if (variants.includes('duplicate')) {
    const n = rng.nextInt(cfg.duplicate.callers[0], cfg.duplicate.callers[1]);
    const delays: number[] = [];
    for (let i = 0; i < n; i++) delays.push(between(rng, cfg.duplicate.delayS));
    delays.sort((a, b) => a - b);
    for (const d of delays) {
      entry(d, 'duplicateCaller', 'Additional caller {name} reports the same incident.', 0, pick({ minAge: 18 }));
    }
    if (rng.next() < cfg.duplicate.linkedCallChance) {
      entry(between(rng, cfg.duplicate.delayS), 'linkedCall', 'Duplicate report', 0, pick({ minAge: 18 }));
    }
  }
  if (variants.includes('ambush')) {
    entry(between(rng, cfg.ambush.delayS), 'ambush', 'Ambush armed');
  }
  const ordered = timeline.map((t, i) => ({ t, i })).sort((a, b) => a.t.atS - b.t.atS || a.i - b.i).map((x) => x.t);

  return {
    version: 1,
    callId: input.callId,
    typeId: input.typeId,
    family: family.id,
    variants,
    branch: branch.id,
    anchor,
    reported,
    participants,
    vehicles,
    evidence,
    timeline: ordered,
    flags: [...flags],
    errors,
  };
}
