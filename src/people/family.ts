import { CALENDAR, ageOn } from '../records/calendar';
import { hash3 } from '../records/hash';
import { lastNameIndex, personDob } from '../records/person';
import { NameIndex } from '../records/search';
import { PEOPLE_DATA } from './data';
import { SALT } from './salt';
import type { FamilyLink, Relation } from './types';

/** Symmetric, deterministic family clusters inside last-name buckets (design §5.2). */

const ADULT_AGE = 18;
const PARENT_GAP: readonly [number, number] = [18, 45];
const PARTNER_MAX_GAP = 12;
const SIBLING_MAX_GAP = 15;

const indexes = new Map<number, NameIndex>();

/** Memoised name index of `seed` (a handful of seeds per run). */
export function nameIndexFor(seed: number): NameIndex {
  let idx = indexes.get(seed);
  if (!idx) {
    if (indexes.size >= 8) indexes.clear();
    idx = new NameIndex(seed);
    indexes.set(seed, idx);
  }
  return idx;
}

/** One cluster: member ids (ascending); ages and the partner pair are computed on first use. */
interface Cluster {
  readonly ids: number[];
  ages: number[] | null;
  pa: number;
  pb: number;
}

/** Clusters of one bucket: `keys` cluster keys, key -> cluster. */
interface BucketClusters {
  readonly keys: number;
  readonly byKey: Map<number, Cluster>;
}
/** Keyed `seed * 65536 + lastIdx` (300 last names per seed); several seeds fit. */
const clusterMemo = new Map<number, BucketClusters>();
const CLUSTER_MEMO_CAP = 2048;

function clustersOf(seed: number, lastIdx: number, index: NameIndex): BucketClusters {
  const memoKey = seed * 65536 + lastIdx;
  let c = clusterMemo.get(memoKey);
  if (c) return c;
  const ids = index.bucket(lastIdx, []);
  const keys = Math.max(1, Math.ceil(ids.length / PEOPLE_DATA.family.clusterSize));
  const byKey = new Map<number, Cluster>();
  for (const id of ids) {
    const k = hash3(seed, SALT.family, id) % keys;
    const cluster = byKey.get(k);
    if (cluster) cluster.ids.push(id);
    else byKey.set(k, { ids: [id], ages: null, pa: -1, pb: -1 });
  }
  c = { keys, byKey };
  if (clusterMemo.size >= CLUSTER_MEMO_CAP) clusterMemo.clear();
  clusterMemo.set(memoKey, c);
  return c;
}

/** Age in whole years on game day 0 (stable: relations never change with the calendar). */
function baseAge(seed: number, id: number): number {
  return ageOn(personDob(seed, id), CALENDAR.startEpochDay);
}

/** Relation of `b` seen from `a` given the cluster's partner pair. */
function relationOf(ageA: number, ageB: number, isPartnerPair: boolean): Relation {
  const diff = ageA - ageB;
  const gap = Math.abs(diff);
  if (gap >= PARENT_GAP[0] && gap <= PARENT_GAP[1]) return diff > 0 ? 'child' : 'parent';
  if (isPartnerPair) return 'partner';
  return gap <= SIBLING_MAX_GAP ? 'sibling' : 'relative';
}

/**
 * Relatives of `id` (ascending person id), each with the relation seen from `id`'s point of view. Inside a
 * last-name bucket a person's cluster is the members whose `hash3(family) % max(1, ceil(size / clusterSize))`
 * key matches. The partner pair of a cluster is the adult pair (both >= 18, age gap <= 12) with the smallest
 * gap (ties: lowest ids). Relatives may live at different addresses; nothing may claim they live together.
 */
export function familyOf(seed: number, id: number, index: NameIndex): FamilyLink[] {
  const lastIdx = lastNameIndex(seed, id);
  const clusters = clustersOf(seed, lastIdx, index);
  const cluster = clusters.byKey.get(hash3(seed, SALT.family, id) % clusters.keys);
  if (!cluster || cluster.ids.length < 2) return [];
  const members = cluster.ids;
  if (!cluster.ages) {
    const ages = members.map((m) => baseAge(seed, m));
    // Partner pair: adults with the smallest gap.
    let best = Infinity;
    for (let i = 0; i < members.length; i++) {
      const ai = ages[i] ?? 0;
      if (ai < ADULT_AGE) continue;
      for (let j = i + 1; j < members.length; j++) {
        const aj = ages[j] ?? 0;
        if (aj < ADULT_AGE) continue;
        const gap = Math.abs(ai - aj);
        if (gap <= PARTNER_MAX_GAP && gap < best) {
          best = gap;
          cluster.pa = members[i] ?? -1;
          cluster.pb = members[j] ?? -1;
        }
      }
    }
    cluster.ages = ages;
  }
  const ages = cluster.ages;
  const ageSelf = ages[members.indexOf(id)] ?? 0;
  const out: FamilyLink[] = [];
  for (let i = 0; i < members.length; i++) {
    const other = members[i] ?? -1;
    if (other === id) continue;
    const partner = (id === cluster.pa && other === cluster.pb) || (id === cluster.pb && other === cluster.pa);
    out.push({ personId: other, relation: relationOf(ageSelf, ages[i] ?? 0, partner) });
  }
  return out;
}

/** The oldest `parent` link's id (ties: lowest id), or -1. */
export function oldestParent(seed: number, family: readonly FamilyLink[]): number {
  let best = -1;
  let bestDob = Infinity;
  for (const l of family) {
    if (l.relation !== 'parent') continue;
    const dob = personDob(seed, l.personId);
    if (dob < bestDob) {
      bestDob = dob;
      best = l.personId;
    }
  }
  return best;
}
