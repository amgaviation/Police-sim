/** Investigation save block (design phase 4 §10.3). */
import type { RngState } from '../core/rng';
import {
  CUSTODY_ACTIONS,
  PRINT_SURFACES,
  isCaseFile,
  type CaseFile,
  type CustodyEntry,
  type DustState,
  type K9Alert,
} from '../evidence';
import type { InvestigationRequest } from './types';

/** Queued requests kept in a save. */
export const MAX_QUEUE = 64;

export interface SavedTape {
  callId: number;
  /** x, z pairs. */
  points: number[];
  closed: boolean;
}

export type SavedDust = DustState & { callId: number; buildingId: number; furniture: number };

export interface SavedK9 {
  callId: number;
  startedSim: number;
  alerts: K9Alert[];
  fired: number;
  order: number[];
}

export interface InvestigationSave {
  version: 1;
  rng: RngState;
  files: CaseFile[];
  ledger: CustodyEntry[];
  tapes: SavedTape[];
  /** Index into `tapes` of the tape being laid, -1 none. */
  activeTape: number;
  bodycam: boolean;
  /** Item ids held by the officer. */
  held: string[];
  dust: SavedDust | null;
  k9: SavedK9 | null;
  scanTimer: number;
  /** [callId, personId, buildingId, room, sim] */
  arrests: [number, number, number, number, number][];
  queue: InvestigationRequest[];
}

/** A save with no cases, tapes or sweeps. */
export function emptyInvestigationSave(rng: RngState): InvestigationSave {
  return {
    version: 1,
    rng: { seed: rng.seed, s: [rng.s[0], rng.s[1], rng.s[2], rng.s[3]] },
    files: [],
    ledger: [],
    tapes: [],
    activeTape: -1,
    bodycam: false,
    held: [],
    dust: null,
    k9: null,
    scanTimer: 0,
    arrests: [],
    queue: [],
  };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isNonNegInt = (x: unknown): x is number => isInt(x) && x >= 0;
const isUint32 = (x: unknown): boolean => isInt(x) && x >= 0 && x < 4294967296;
const isStr = (x: unknown): x is string => typeof x === 'string';

function isRngState(x: unknown): boolean {
  return isObj(x) && isUint32(x['seed']) && Array.isArray(x['s']) && x['s'].length === 4 && x['s'].every(isUint32);
}

const DIRS: readonly unknown[] = ['up', 'down', 'left', 'right'];

function isRequest(x: unknown): x is InvestigationRequest {
  if (!isObj(x)) return false;
  switch (x['kind']) {
    case 'marker':
    case 'deposit':
    case 'dustLift':
    case 'dustCancel':
    case 'tapePost':
    case 'tapeClose':
    case 'tapeClear':
      return true;
    case 'removeMarker':
      return isNonNegInt(x['no']);
    case 'photo':
      return isNum(x['fovDeg']);
    case 'collect':
    case 'bag':
    case 'tag':
      return isStr(x['itemId']);
    case 'transfer':
      return isStr(x['itemId']) && isStr(x['to']);
    case 'search':
      return isInt(x['buildingId']) && isInt(x['furniture']) && typeof x['force'] === 'boolean';
    case 'dustStart':
      return isInt(x['buildingId']) && isInt(x['furniture']);
    case 'dustMove':
      return DIRS.includes(x['dir']);
    case 'dustBrush':
      return isNum(x['seconds']);
    case 'bodycam':
      return typeof x['on'] === 'boolean';
    case 'canvass':
      return isInt(x['buildingId']);
    default:
      return false;
  }
}

function isLedgerEntry(x: unknown): x is CustodyEntry {
  return (
    isObj(x) &&
    isNonNegInt(x['seq']) &&
    isStr(x['itemId']) &&
    (CUSTODY_ACTIONS as readonly unknown[]).includes(x['action']) &&
    isStr(x['from']) &&
    isStr(x['to']) &&
    isNum(x['sim']) &&
    isNum(x['game']) &&
    isStr(x['location']) &&
    isStr(x['note']) &&
    isStr(x['prevHash']) &&
    isStr(x['hash'])
  );
}

function isTape(x: unknown): x is SavedTape {
  return (
    isObj(x) &&
    isInt(x['callId']) &&
    Array.isArray(x['points']) &&
    x['points'].length % 2 === 0 &&
    x['points'].every(isNum) &&
    typeof x['closed'] === 'boolean'
  );
}

function isDust(x: unknown): x is SavedDust {
  return (
    isObj(x) &&
    (PRINT_SURFACES as readonly unknown[]).includes(x['surface']) &&
    typeof x['hasPrint'] === 'boolean' &&
    isInt(x['personId']) &&
    isNum(x['base']) &&
    Array.isArray(x['coverage']) &&
    x['coverage'].length === 16 &&
    x['coverage'].every(isNum) &&
    isNonNegInt(x['cursor']) &&
    x['cursor'] < 16 &&
    isNum(x['overbrush']) &&
    typeof x['lifted'] === 'boolean' &&
    isInt(x['callId']) &&
    isInt(x['buildingId']) &&
    isInt(x['furniture'])
  );
}

function isAlert(x: unknown): x is K9Alert {
  return (
    isObj(x) &&
    isStr(x['ref']) &&
    (x['kind'] === 'person' || x['kind'] === 'item') &&
    isInt(x['room']) &&
    isNum(x['x']) &&
    isNum(x['z']) &&
    isNum(x['atS'])
  );
}

function isK9(x: unknown): x is SavedK9 {
  return (
    isObj(x) &&
    isInt(x['callId']) &&
    isNum(x['startedSim']) &&
    Array.isArray(x['alerts']) &&
    x['alerts'].every(isAlert) &&
    isNonNegInt(x['fired']) &&
    x['fired'] <= x['alerts'].length &&
    Array.isArray(x['order']) &&
    x['order'].every(isInt)
  );
}

/** Structural check of a saved investigation block. */
export function isInvestigationSave(x: unknown): x is InvestigationSave {
  if (!isObj(x) || x['version'] !== 1 || !isRngState(x['rng'])) return false;
  if (!Array.isArray(x['files']) || !x['files'].every(isCaseFile)) return false;
  if (!Array.isArray(x['ledger']) || !x['ledger'].every(isLedgerEntry)) return false;
  if (!Array.isArray(x['tapes']) || !x['tapes'].every(isTape)) return false;
  const active = x['activeTape'];
  if (!isInt(active) || active < -1 || active >= x['tapes'].length) return false;
  if (typeof x['bodycam'] !== 'boolean') return false;
  if (!Array.isArray(x['held']) || !x['held'].every(isStr)) return false;
  if (x['dust'] !== null && !isDust(x['dust'])) return false;
  if (x['k9'] !== null && !isK9(x['k9'])) return false;
  if (!isNum(x['scanTimer'])) return false;
  if (!Array.isArray(x['arrests']) || !x['arrests'].every((a) => Array.isArray(a) && a.length === 5 && a.every(isNum))) return false;
  return Array.isArray(x['queue']) && x['queue'].length <= MAX_QUEUE && x['queue'].every(isRequest);
}
