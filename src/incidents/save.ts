import { INCIDENT_EVENT_KINDS, type IncidentLog } from '../legal/types';
import type { IncidentRequest } from './types';

/** Persisted state of the incident recorder (design 9.4). Logs are plain JSON. */
export interface IncidentsSave {
  version: 1;
  jurisdiction: string;
  nextEventId: number;
  nextAdhoc: number;
  logs: IncidentLog[];
  /** Merged field-contact keys -> call keys. */
  aliases: [string, string][];
  cam: { body: boolean; muted: boolean; dashManual: boolean };
  violations: { vehicleId: number; kind: string; sim: number }[];
  pursuit: { key: string; callId: number; nextSampleSim: number; advised: boolean } | null;
  assessQueue: string[];
  /** key, personId, aggressiveLines, lastResistanceRank (-1 unknown). */
  personState: [string, number, number, number][];
  queue: IncidentRequest[];
}

/** A fresh game: no logs, cameras off. */
export function emptyIncidentsSave(jurisdiction = 'generic'): IncidentsSave {
  return {
    version: 1,
    jurisdiction,
    nextEventId: 1,
    nextAdhoc: 1,
    logs: [],
    aliases: [],
    cam: { body: false, muted: false, dashManual: false },
    violations: [],
    pursuit: null,
    assessQueue: [],
    personState: [],
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

function str(v: unknown): v is string {
  return typeof v === 'string';
}

function isEvent(v: unknown): boolean {
  return isRecord(v) && int(v.id) && num(v.t) && num(v.game) && int(v.personId) && int(v.cam) && str(v.kind) && (INCIDENT_EVENT_KINDS as readonly string[]).includes(v.kind);
}

function isLog(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return (
    str(v.key) && int(v.callId) && str(v.typeId) && str(v.family) && str(v.district) && num(v.openedSim) && num(v.openedGame) &&
    typeof v.closed === 'boolean' && num(v.closedSim) && num(v.closedGame) &&
    Array.isArray(v.events) && v.events.every(isEvent) &&
    Array.isArray(v.people) && v.people.every((p) => isRecord(p) && int(p.personId) && str(p.role) && str(p.label)) &&
    Array.isArray(v.reports) && v.reports.every((r) => isRecord(r) && str(r.docId) && Array.isArray(r.assertions) && r.assertions.every(str) && num(r.sim) && num(r.game))
  );
}

function isRequest(v: unknown): boolean {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case 'mute':
    case 'dashManual':
      return typeof v.on === 'boolean';
    case 'report':
      return str(v.key) && str(v.docId) && Array.isArray(v.assertions) && v.assertions.every(str);
    case 'jurisdiction':
      return str(v.id);
    case 'close':
      return str(v.key);
    default:
      return false;
  }
}

/** Shallow validator: versions, array shapes, and numeric base fields plus a known kind on every event. */
export function isIncidentsSave(x: unknown): x is IncidentsSave {
  if (!isRecord(x) || x.version !== 1) return false;
  if (!str(x.jurisdiction) || !int(x.nextEventId) || x.nextEventId < 1 || !int(x.nextAdhoc) || x.nextAdhoc < 1) return false;
  if (!Array.isArray(x.logs) || !x.logs.every(isLog)) return false;
  if (!Array.isArray(x.aliases) || !x.aliases.every((a) => Array.isArray(a) && a.length === 2 && str(a[0]) && str(a[1]))) return false;
  const cam = x.cam;
  if (!isRecord(cam) || typeof cam.body !== 'boolean' || typeof cam.muted !== 'boolean' || typeof cam.dashManual !== 'boolean') return false;
  if (!Array.isArray(x.violations) || !x.violations.every((v) => isRecord(v) && int(v.vehicleId) && str(v.kind) && num(v.sim))) return false;
  const p = x.pursuit;
  if (p !== null && !(isRecord(p) && str(p.key) && int(p.callId) && num(p.nextSampleSim) && typeof p.advised === 'boolean')) return false;
  if (!Array.isArray(x.assessQueue) || !x.assessQueue.every(str)) return false;
  if (!Array.isArray(x.personState) || !x.personState.every((s) => Array.isArray(s) && s.length === 4 && str(s[0]) && int(s[1]) && int(s[2]) && int(s[3]))) return false;
  return Array.isArray(x.queue) && x.queue.every(isRequest);
}
