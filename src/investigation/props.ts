/** Investigation props (design phase 4 §10.1): evidence markers, items lying in place and scene tape, as a `PropSource`. */
import type { CaseFile } from '../evidence';
import { isItemId, itemDef } from '../people/items';
import { PROP, PROP_BY_NAME, type PropSource } from '../render/people/pose';
import type { SavedTape } from './save';
import { layTape } from './tape';

/** Props the source can hold (markers, then items, then tape). */
export const PROP_CAPACITY = 512;

export type MutableProps = PropSource & { count: number };

/** Prop kind of an evidence item: its people item `prop`, else a bag; 0 (nothing drawn) for lifted prints. */
export function itemPropKind(item: string): number {
  if (item === 'latentPrint') return 0;
  const name = isItemId(item) ? itemDef(item).prop : null;
  return (name !== null ? PROP_BY_NAME[name] : undefined) ?? PROP.bag;
}

function put(out: MutableProps, x: number, y: number, z: number, yaw: number, kind: number): boolean {
  const i = out.count;
  if (i >= out.kind.length) return false;
  out.x[i] = x;
  out.y[i] = y;
  out.z[i] = z;
  out.yaw[i] = yaw;
  out.kind[i] = kind;
  out.count = i + 1;
  return true;
}

/**
 * Refills `out` for the level the officer is on (`building`, -1 outdoors): markers, then uncollected items that
 * are in view (not concealed in a closed container, unless already found), then the tape (outdoors only).
 */
export function buildProps(out: MutableProps, files: readonly CaseFile[], tapes: readonly SavedTape[], building: number): void {
  out.count = 0;
  for (const f of files) {
    for (const m of f.markers) {
      if (m.buildingId === building && !put(out, m.x, m.y, m.z, 0, PROP.marker)) return;
    }
  }
  for (const f of files) {
    for (const it of f.items) {
      if (it.state === 'collected' || it.buildingId !== building) continue;
      if (it.concealed && it.state !== 'found') continue;
      const kind = itemPropKind(it.item);
      if (kind !== 0 && !put(out, it.x, it.y, it.z, 0, kind)) return;
    }
  }
  if (building >= 0) return;
  for (const tape of tapes) {
    let full = false;
    layTape(tape.points, tape.closed, (x, z, yaw) => {
      full = !put(out, x, 0, z, yaw, PROP.tape);
      return !full;
    });
    if (full) return;
  }
}
