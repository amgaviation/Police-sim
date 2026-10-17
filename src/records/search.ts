import { NAMES } from './data';
import { PERSON_POPULATION } from './ids';
import { lastNameIndex } from './person';

/**
 * Person name index (design §5.1): person ids bucketed by last-name index with a counting sort
 * (`Int32Array`s), built once from the integer-hash identities (a few ms for 100 000 persons).
 */
export class NameIndex {
  /** Person ids grouped by last-name index, ascending id within a bucket. */
  private readonly order: Int32Array;
  /** Bucket b spans order[starts[b] .. starts[b + 1]). */
  private readonly starts: Int32Array;
  private readonly upperLast: readonly string[] = NAMES.last.map((n) => n.toUpperCase());

  constructor(seed: number) {
    const buckets = NAMES.last.length;
    const lastOf = new Int32Array(PERSON_POPULATION);
    const starts = new Int32Array(buckets + 1);
    for (let id = 0; id < PERSON_POPULATION; id++) {
      const b = lastNameIndex(seed, id);
      lastOf[id] = b;
      starts[b + 1] = (starts[b + 1] ?? 0) + 1;
    }
    for (let b = 0; b < buckets; b++) starts[b + 1] = (starts[b + 1] ?? 0) + (starts[b] ?? 0);
    const fill = starts.slice(0, buckets);
    const order = new Int32Array(PERSON_POPULATION);
    for (let id = 0; id < PERSON_POPULATION; id++) {
      const b = lastOf[id] ?? 0;
      const at = fill[b] ?? 0;
      order[at] = id;
      fill[b] = at + 1;
    }
    this.order = order;
    this.starts = starts;
  }

  /** Appends to `out` the ids whose last-name index is exactly `lastIndex`, ascending; `out` is returned. */
  bucket(lastIndex: number, out: number[]): number[] {
    if (!Number.isInteger(lastIndex) || lastIndex < 0 || lastIndex >= this.upperLast.length) return out;
    const end = this.starts[lastIndex + 1] ?? 0;
    for (let i = this.starts[lastIndex] ?? 0; i < end; i++) out.push(this.order[i] ?? 0);
    return out;
  }

  /** Appends to `out` the ids whose last name equals or starts with `query` (case-insensitive). */
  candidates(query: string, out: number[]): number[] {
    const q = query.trim().toUpperCase();
    if (q === '') return out;
    for (let b = 0; b < this.upperLast.length; b++) {
      if (!(this.upperLast[b] ?? '').startsWith(q)) continue;
      const end = this.starts[b + 1] ?? 0;
      for (let i = this.starts[b] ?? 0; i < end; i++) out.push(this.order[i] ?? 0);
    }
    return out;
  }
}
