import { createRng, type Rng } from '../../src/core/rng';
import { callTypeDef, familyForType } from '../../src/calls/catalog';
import { applyVariantRoles, effectiveRoles, effectiveVehicles } from '../../src/calls/effective';
import type { PersonDescription, Scenario, ScenarioInput } from '../../src/calls/scenario';
import type { BranchDef, PersonConstraint, RoleDef } from '../../src/calls/types';

export interface Traits {
  readonly age: number;
  readonly warrant: boolean;
  readonly mentalHealth: boolean;
  readonly risk: boolean;
  readonly sex: 'M' | 'F';
}

/** Deterministic person table of the stub world. */
export function traits(id: number): Traits {
  return {
    age: 16 + ((id * 37) % 70),
    warrant: id % 11 === 0,
    mentalHealth: id % 7 === 0,
    risk: id % 3 === 0,
    sex: id % 2 === 0 ? 'M' : 'F',
  };
}

export function satisfies(id: number, c: PersonConstraint): boolean {
  const t = traits(id);
  return (c.minAge === undefined || t.age >= c.minAge) && (c.maxAge === undefined || t.age <= c.maxAge) &&
    (c.warrant === undefined || t.warrant === c.warrant) && (c.mentalHealth === undefined || t.mentalHealth === c.mentalHealth) &&
    (c.risk === undefined || t.risk === c.risk) && (c.sex === undefined || t.sex === c.sex);
}

const TOPS = ['black', 'white', 'gray', 'red', 'blue', 'green', 'yellow', 'brown', 'navy', 'orange'];

/** A road edge along +x from (0, 0) to (length, 0); the structural subset of RoadGraph the builder reads. */
export function stubGraph(length = 300): ScenarioInput['graph'] {
  const edge = {
    id: 3,
    length,
    points: new Float32Array([0, 0, length / 2, 0, length, 0]),
  };
  const edges: unknown[] = [];
  edges[3] = edge;
  return { edges } as unknown as ScenarioInput['graph'];
}

export interface StubOptions {
  typeId: string;
  callId?: number;
  seed?: number;
  priority?: number;
  callerPersonId?: number;
  reportedVehicleId?: number;
  existingVehicleId?: number;
  given?: number[];
  derivedBranch?: string | null;
  edge?: number;
  age?: (id: number) => number;
}

export function stubInput(o: StubOptions): ScenarioInput {
  return {
    seed: o.seed ?? 1234,
    callId: o.callId ?? 1,
    typeId: o.typeId,
    priority: o.priority ?? 2,
    location: { x: 100, z: 6, edge: o.edge ?? 3, text: '100 N Test Street', near: '100 block of N Test Street', street: 'Test Street' },
    callerPersonId: o.callerPersonId ?? 4242,
    reportedVehicleId: o.reportedVehicleId ?? -1,
    existingVehicleId: o.existingVehicleId ?? -1,
    given: o.given ?? [],
    derivedBranch: o.derivedBranch ?? null,
    graph: stubGraph(),
    pickPerson(c: PersonConstraint, rng: Rng): number {
      for (let i = 0; i < 5000; i++) {
        const id = rng.nextInt(0, 99999);
        if (satisfies(id, c)) return id;
      }
      throw new Error(`no stub person for ${JSON.stringify(c)}`);
    },
    driverOf: (vehicleId: number) => 60000 + vehicleId,
    pickVehicle: (rng: Rng) => rng.nextInt(0, 99999),
    describe(id: number): PersonDescription {
      const t = traits(id);
      return {
        sex: t.sex,
        ageBand: t.age < 18 ? 'teen' : t.age < 40 ? 'adult in their 30s' : 'older adult',
        top: TOPS[id % TOPS.length] ?? 'black',
        bottom: 'blue jeans',
        hair: 'brown hair',
        heightText: 'about 5 feet 10 inches',
      };
    },
    addressAt: (edge: number, s: number) => `${Math.round(s)} Test Street (edge ${edge})`,
    ...(o.age ? { ageOf: o.age } : { ageOf: (id: number) => traits(id).age }),
  };
}

/** Builds with the scene's stream convention. */
export function rngFor(seed: number, callId: number): Rng {
  return createRng(seed).stream(`scenario:${callId}`);
}

/** Effective (post-variant) roles of a built scenario, to check participants against their constraints. */
export function rolesOf(s: Scenario): RoleDef[] {
  const family = familyForType(s.typeId);
  if (!family) throw new Error(s.typeId);
  const branch = family.branches.find((b: BranchDef) => b.id === s.branch);
  if (!branch) throw new Error(s.branch);
  return applyVariantRoles(effectiveRoles(family, branch), effectiveVehicles(family, branch), s.variants).roles;
}

export function typeOf(id: string): ReturnType<typeof callTypeDef> {
  return callTypeDef(id);
}
