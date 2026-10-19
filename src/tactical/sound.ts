/**
 * Sound propagation (design §7.1). Pure: sound levels are in dB (a relative SPL-like scale), spreading is
 * inverse-square (-20 log10 of the distance, floored at 1 m) and every room boundary costs a fixed attenuation:
 * an open door a little, a closed door more, a bare wall a lot. The rooms of a building form a graph; all-pairs
 * shortest attenuation (Floyd-Warshall) is cached per door revision, so a sound is one table lookup per listener.
 */
import type { InteriorDoor, InteriorLayout, DoorKind } from '../interior/types';
import type { TacticsConfig } from './data';
import type { DoorStateName } from './types';

export const SOUND_KINDS = ['footstep', 'doorOpen', 'doorClose', 'knock', 'kick', 'ram', 'radioChirp', 'voiceTalk', 'voiceShout', 'announce', 'taser', 'flashlightClick'] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

/** Attenuation matrix between the rooms of a layout plus the outside node (index = rooms.length). */
export interface SoundGraph {
  readonly n: number;
  /** n * n dB, Infinity = no path. */
  readonly att: Float32Array;
  readonly revision: number;
}

/** Edge cost (dB) of a door: open / broken / wide `doorOpenDb`, a closed or locked cell door `cellDoorDb`, other closed or locked doors `doorClosedDb`. */
export function doorAttenuation(state: DoorStateName, kind: DoorKind, cfg: TacticsConfig): number {
  const s = cfg.sound;
  if (kind === 'wide' || state === 'open' || state === 'broken') return s.doorOpenDb;
  return kind === 'cell' ? s.cellDoorDb : s.doorClosedDb;
}

/** Walls this close (m) count as shared (room rects are on a 0.05 m grid; allow float noise). */
const TOUCH = 1e-3;
/** Shared wall length (m) below which two rooms are not coupled through the wall. */
const MIN_SHARED = 0.5;

function edge(att: Float32Array, n: number, a: number, b: number, db: number): void {
  if (db < (att[a * n + b] as number)) {
    att[a * n + b] = db;
    att[b * n + a] = db;
  }
}

/**
 * Edges: rooms joined by a door cost the minimum over their doors of `doorAttenuation`; rooms sharing a wall (overlap
 * of at least 0.5 m) cost `wallDb`; a room is joined to the outside node through its exterior doors and through
 * exterior walls (`exteriorWallDb`, where it touches the interior extent). Then all-pairs shortest path (n is a few
 * dozen). When `out` already holds `revision` it is returned untouched; otherwise it is overwritten in place (a new
 * object only when its array is too small).
 */
export function buildSoundGraph(layout: InteriorLayout, state: (door: number) => DoorStateName, cfg: TacticsConfig, revision: number, out?: SoundGraph): SoundGraph {
  const rooms = layout.rooms;
  const n = rooms.length + 1;
  if (out !== undefined && out.revision === revision && out.n === n) return out;
  const size = n * n;
  let g: { n: number; att: Float32Array; revision: number };
  if (out !== undefined && out.att.length >= size) {
    g = out;
    g.n = n;
    g.revision = revision;
  } else {
    g = { n, att: new Float32Array(size), revision };
  }
  const att = g.att;
  att.fill(Infinity, 0, size);
  for (let i = 0; i < n; i++) att[i * n + i] = 0;
  const outside = n - 1;

  // Walls: rooms touching along a boundary, and rooms touching the interior extent.
  const ext = layout.rect;
  for (let i = 0; i < rooms.length; i++) {
    const a = (rooms[i] as InteriorLayout['rooms'][number]).rect;
    for (let j = i + 1; j < rooms.length; j++) {
      const b = (rooms[j] as InteriorLayout['rooms'][number]).rect;
      const alongZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      const alongX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const sideX = Math.abs(a.maxX - b.minX) < TOUCH || Math.abs(b.maxX - a.minX) < TOUCH;
      const sideZ = Math.abs(a.maxZ - b.minZ) < TOUCH || Math.abs(b.maxZ - a.minZ) < TOUCH;
      if ((sideX && alongZ >= MIN_SHARED) || (sideZ && alongX >= MIN_SHARED)) edge(att, n, i, j, cfg.sound.wallDb);
    }
    const exposed =
      (Math.abs(a.minX - ext.minX) < TOUCH || Math.abs(a.maxX - ext.maxX) < TOUCH ? a.maxZ - a.minZ : 0) >= MIN_SHARED ||
      (Math.abs(a.minZ - ext.minZ) < TOUCH || Math.abs(a.maxZ - ext.maxZ) < TOUCH ? a.maxX - a.minX : 0) >= MIN_SHARED;
    if (exposed) edge(att, n, i, outside, cfg.sound.exteriorWallDb);
  }
  // Doors (always at most the wall cost, but take the minimum anyway).
  for (let d = 0; d < layout.doors.length; d++) {
    const door = layout.doors[d] as InteriorDoor;
    edge(att, n, door.a, door.b < 0 ? outside : door.b, doorAttenuation(state(d), door.kind, cfg));
  }
  // Floyd-Warshall.
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const ik = att[i * n + k] as number;
      if (ik === Infinity) continue;
      for (let j = 0; j < n; j++) {
        const v = ik + (att[k * n + j] as number);
        if (v < (att[i * n + j] as number)) att[i * n + j] = v;
      }
    }
  }
  return g;
}

/**
 * `level - 20 log10(max(1, distance)) - att[src][dst]`, -Infinity when there is no path. Distance is the straight 2D
 * distance. A node below 0 is the outside node. `g` null means both points are outdoors (pure distance).
 */
export function receivedLevel(level: number, srcNode: number, sx: number, sz: number, dstNode: number, lx: number, lz: number, g: SoundGraph | null): number {
  const d = Math.hypot(lx - sx, lz - sz);
  const spread = level - 20 * Math.log10(d > 1 ? d : 1);
  if (g === null) return spread;
  const a = srcNode < 0 ? g.n - 1 : srcNode;
  const b = dstNode < 0 ? g.n - 1 : dstNode;
  if (a >= g.n || b >= g.n) return -Infinity;
  const att = g.att[a * g.n + b] as number;
  return att === Infinity ? -Infinity : spread - att;
}

/** Quietest level (dB) a listener reacts to: 20 normal, 40 hard of hearing, never when deaf; asleep adds 20. */
export function hearingThreshold(hearing: 'normal' | 'hardOfHearing' | 'deaf', asleep: boolean, cfg: TacticsConfig): number {
  if (hearing === 'deaf') return Infinity;
  const h = cfg.sound.hearing;
  return (hearing === 'normal' ? h.normal : h.hardOfHearing) + (asleep ? h.asleepBonus : 0);
}

/** 0 below the threshold, else `min(1, (level - threshold) / stimulusRangeDb)`. */
export function stimulus(level: number, threshold: number, cfg: TacticsConfig): number {
  if (!(level > threshold)) return 0;
  const s = (level - threshold) / cfg.sound.stimulusRangeDb;
  return s > 1 ? 1 : s;
}

/** Footstep level (dB at 1 m): surface base, +8 running (> 5 m/s), -6 creeping (< 1.6 m/s), -10 crouched; -Infinity when (nearly) still. */
export function footstepLevel(surface: string, speed: number, crouched: boolean, cfg: TacticsConfig): number {
  if (!(speed >= 0.3)) return -Infinity;
  const base = cfg.sound.footstepDb[surface] ?? cfg.sound.footstepDb['concrete'] ?? 38;
  return base + (speed > 5 ? 8 : speed < 1.6 ? -6 : 0) + (crouched ? -10 : 0);
}

/** Source level (dB at 1 m) of a sound kind; a footstep (normally leveled by `footstepLevel`) reads as concrete at walking pace. */
export function sourceLevel(kind: SoundKind, cfg: TacticsConfig): number {
  return kind === 'footstep' ? (cfg.sound.footstepDb['concrete'] ?? 38) : cfg.sound.sources[kind];
}
