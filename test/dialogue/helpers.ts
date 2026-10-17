import { createRng, type Rng } from '../../src/core/rng';
import type { DialogueContext, DialogueDirectory, SubjectMemory, SubjectProfile } from '../../src/dialogue';
import { initialMemory } from '../../src/dialogue';
import { personIdFromDl } from '../../src/records/ids';
import type { CarriedItem, NpcIdentity } from '../../src/people';
import { makeRig, SEED, type Rig } from '../people/helpers';

export { SEED };

let shared: Rig | null = null;

/** One records database + population for the whole test file (identity generation is lazy and cached). */
export function rig(): Rig {
  shared ??= makeRig(SEED, 0);
  return shared;
}

export function rngFor(name: string): Rng {
  return createRng(1234).stream(name);
}

export function item(name: string, where: CarriedItem['where'] = 'pocket', visible = false): CarriedItem {
  return { instance: `p0:${name}:0`, item: name, where, visible };
}

/** A real, generated identity with some traits overridden (identities are readonly records, so a copy). */
export function identityOf(id: number, over: Partial<NpcIdentity> = {}): NpcIdentity {
  return { ...rig().pop.identity(id), ...over };
}

export function subjectOf(id: number, over: Partial<SubjectProfile> = {}, identityOver: Partial<NpcIdentity> = {}): SubjectProfile {
  return {
    personId: id,
    identity: identityOf(id, { language: { id: 'english', label: 'English', english: 'fluent' }, hearing: 'normal', dementia: false, juvenile: false, wanted: false, ...identityOver }),
    intoxication: { bac: 0, drug: 'none', level: 0 },
    demeanor: 'nervous',
    role: 'suspect',
    items: [],
    vehicleItems: [],
    vehicleOwnerId: -1,
    guilty: false,
    injured: false,
    inVehicle: false,
    restrained: false,
    ...over,
  };
}

export function ctxOf(over: Partial<DialogueContext> = {}): DialogueContext {
  return {
    tone: 'neutral',
    commMode: 'verbal',
    hour: 14,
    officerName: 'Officer Hart',
    presence: { lights: false, backup: 0, weapon: 'none', uniform: true },
    history: { count: 0, lastGame: 0, lastOutcome: '', rapport: 0 },
    trust: 0.5,
    truth: { destination: 'home', origin: 'work', account: 'It got loud.', suspectWhereabouts: 'They ran that way.', reason: 'a noise complaint' },
    guardianPresent: false,
    interpreterAvailable: false,
    ...over,
  };
}

/** Memory with fixed rapport and stress (everything else initial). */
export function memoryOf(subject: SubjectProfile, ctx: DialogueContext, rapport = 0, stress = 0.2): SubjectMemory {
  const m = initialMemory(subject, ctx);
  m.rapport = rapport;
  m.stress = stress;
  return m;
}

/** Directory over the shared records database (touches records; fine in tests). */
export function directory(): DialogueDirectory {
  const r = rig();
  return {
    person(id: number) {
      const p = r.records.person(id);
      return { first: p.first, middle: p.middle, last: p.last, dob: p.dob, address: p.address, dlNumber: p.license.number };
    },
    dlOnFile: (dl: string) => personIdFromDl(SEED, dl) !== null,
  };
}

let relatives: number[] | null = null;

/** Ids (searched from 0) that have a sibling or relative link, so identity lies can pick a relative. */
export function idsWithRelatives(count: number): number[] {
  if (relatives === null) {
    relatives = [];
    for (let id = 0; id < 4000 && relatives.length < 40; id++) {
      const idn = rig().pop.identity(id);
      if (idn.family.some((l) => l.relation === 'sibling' || l.relation === 'relative')) relatives.push(id);
    }
  }
  return relatives.slice(0, count);
}
