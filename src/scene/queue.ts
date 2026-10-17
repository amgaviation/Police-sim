/**
 * Queued bus events of the scene director (design §2: bus handlers only enqueue, `step` applies them).
 * Plain data so the queue is saved with the scene (`SceneSave.eventQueue`).
 */

export type NpcEventKind = 'fled' | 'caught' | 'escaped' | 'surrendered' | 'attack' | 'left' | 'revealed' | 'weaponDropped';

export type QueuedEvent =
  | { t: 'created'; callId: number }
  | { t: 'closed'; callId: number; disposition: string }
  | { t: 'onScene'; callsign: string; callId: number }
  | { t: 'stop'; active: boolean; callId: number; vehicleId: number }
  | { t: 'pulling'; vehicleId: number }
  | { t: 'fleeEnded'; vehicleId: number; reason: string; x: number; z: number }
  | { t: 'contact'; callId: number; incident: string; personId: number; role: string; flag: string }
  | { t: 'needsCall'; personId: number; x: number; z: number; incident: string }
  | { t: 'npc'; kind: NpcEventKind; actorId: number; personId: number; callId: number; extra: string; x: number; z: number }
  | { t: 'doc'; id: string; kind: string }
  | { t: 'force'; kind: string; personId: number; callId: number };

const KINDS: ReadonlySet<string> = new Set(['created', 'closed', 'onScene', 'stop', 'pulling', 'fleeEnded', 'contact', 'needsCall', 'npc', 'doc', 'force']);

/** True for a plain object with a known `t` tag (restore drops anything else). */
export function isQueuedEvent(x: unknown): x is QueuedEvent {
  return typeof x === 'object' && x !== null && typeof (x as { t?: unknown }).t === 'string' && KINDS.has((x as { t: string }).t);
}
