import type { RngState } from '../core/rng';
import { FORCE_CONFIG } from './data';
import { FORCE_TOOLS, type ForceConfig, type ForceRequest } from './types';

/** Persisted state of the force system (design 6.5). */
export interface ForceSave {
  version: 1;
  rng: RngState;
  tool: string;
  seq: number;
  cartridges: number;
  rounds: { firearm: number; lessLethal: number; ocSpray: number };
  attached: { personId: number; actorId: number; sinceSim: number } | null;
  /** personId, count, last sim. */
  cycles: [number, number, number][];
  /** Person ids seen assaultive / lethal. */
  violent: number[];
  /** Person ids already rolled for a fellow episode. */
  rolled: number[];
  episode: { personId: number; actorId: number; callId: number; officer: string; nextSim: number; strikes: number; firstSeq: number } | null;
  /** Tools whose armory item was held at the last step. */
  armorySeen: string[];
  queue: ForceRequest[];
  /** Phase 7: seconds left of the sidearm draw (absent in older saves = 0). */
  drawingS?: number;
}

/** A fresh shift: no tool, full ammo from the configuration, nothing attached or rolled. */
export function defaultForceSave(rng: RngState, cfg: ForceConfig = FORCE_CONFIG): ForceSave {
  const tool = (id: string): number => {
    const def = cfg.tools.find((t) => t.id === id);
    return def?.rounds ?? def?.uses ?? 0;
  };
  return {
    version: 1,
    rng,
    tool: 'none',
    seq: 0,
    cartridges: cfg.taser.cartridges,
    rounds: { firearm: tool('firearm'), lessLethal: tool('lessLethal'), ocSpray: tool('ocSpray') },
    attached: null,
    cycles: [],
    violent: [],
    rolled: [],
    episode: null,
    armorySeen: [],
    queue: [],
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function int(v: unknown): v is number {
  return num(v) && Number.isInteger(v);
}

function isRngState(v: unknown): boolean {
  if (!isRecord(v) || !int(v.seed)) return false;
  const s = v.s;
  return Array.isArray(s) && s.length === 4 && s.every((x) => int(x) && x >= 0 && x < 4294967296);
}

function isRequest(v: unknown): boolean {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case 'cycleTool':
    case 'intervene':
    case 'fellowTest':
      return true;
    case 'selectTool':
      return typeof v.tool === 'string' && (FORCE_TOOLS as readonly string[]).includes(v.tool);
    case 'apply':
      return num(v.dirX) && num(v.dirZ);
    default:
      return false;
  }
}

function isIntList(v: unknown): boolean {
  return Array.isArray(v) && v.every(int);
}

/** Is `x` shaped like a `ForceSave`? */
export function isForceSave(x: unknown): x is ForceSave {
  if (!isRecord(x) || x.version !== 1) return false;
  const r = x.rounds;
  const a = x.attached;
  const e = x.episode;
  return (
    isRngState(x.rng) && typeof x.tool === 'string' && int(x.seq) && int(x.cartridges) &&
    isRecord(r) && int(r.firearm) && int(r.lessLethal) && int(r.ocSpray) &&
    (a === null || (isRecord(a) && int(a.personId) && int(a.actorId) && num(a.sinceSim))) &&
    Array.isArray(x.cycles) && x.cycles.every((c) => Array.isArray(c) && c.length === 3 && int(c[0]) && int(c[1]) && num(c[2])) &&
    isIntList(x.violent) && isIntList(x.rolled) &&
    (e === null || (isRecord(e) && int(e.personId) && int(e.actorId) && int(e.callId) && typeof e.officer === 'string' && num(e.nextSim) && int(e.strikes) && int(e.firstSeq))) &&
    Array.isArray(x.armorySeen) && x.armorySeen.every((s) => typeof s === 'string') &&
    Array.isArray(x.queue) && x.queue.every(isRequest) &&
    (x.drawingS === undefined || (num(x.drawingS) && x.drawingS >= 0))
  );
}
