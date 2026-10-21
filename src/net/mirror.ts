/**
 * Client mirror (Phase 8 §8.3): turns the server's snapshot / events / presence into calls on a `MirrorPort` that the
 * game wires to its local CAD. Pure bookkeeping: no clock, no randomness, no allocation per presence update.
 */
import type { NetCall, NetUnit, PresenceEntry, RoomEvent, RoomSnapshot } from './protocol.ts';

export interface MirrorPort {
  /** Create the call locally; returns the local call id. */
  createCall(c: NetCall): number;
  assign(localCallId: number, callsign: string, self: boolean): void;
  unassign(localCallId: number, callsign: string, self: boolean): void;
  setPriority(localCallId: number, p: 1 | 2 | 3 | 4): void;
  addNote(localCallId: number, by: string, text: string): void;
  close(localCallId: number, disposition: string): void;
  /** Remote units only (never self). The object is reused by the mirror: copy it if you keep it. */
  upsertUnit(u: NetUnit): void;
  removeUnit(callsign: string): void;
  /** Only orders addressed to self. */
  order(o: Extract<RoomEvent, { k: 'order' }>): void;
  radio(from: string, channel: 'main' | 'tac', text: string): void;
}

interface Tracked {
  local: number;
  units: string[];
  notes: number;
  priority: 1 | 2 | 3 | 4;
  closed: boolean;
}

export class CoopMirror {
  private readonly self: string;
  private readonly netToCall = new Map<number, Tracked>();
  private readonly localToNet = new Map<number, number>();
  private readonly pendingRefs = new Map<string, number>();
  private readonly units = new Map<string, NetUnit>();

  constructor(selfCallsign: string) {
    this.self = selfCallsign;
  }

  /** A call this client proposed (callCreate.ref) is already local: map it instead of creating a duplicate. */
  expectOwn(ref: string, localCallId: number): void {
    this.pendingRefs.set(ref, localCallId);
  }

  /** Initial sync (also safe to repeat after a reconnect): creates missing open calls, units and assignments and
   *  reconciles the ones already known. Closed calls that were never mirrored are skipped. */
  applySnapshot(s: RoomSnapshot, port: MirrorPort): void {
    const seen = new Set<string>();
    for (const u of s.units) {
      if (u.callsign === this.self) continue;
      seen.add(u.callsign);
      this.putUnit(u, port);
    }
    for (const cs of Array.from(this.units.keys())) {
      if (!seen.has(cs)) this.dropUnit(cs, port);
    }
    for (const c of s.calls) {
      let t = this.netToCall.get(c.id);
      if (!t) {
        if (c.status === 'closed') continue;
        t = this.createTracked(c, port);
      }
      if (t.closed) continue;
      this.reconcile(t, c, port);
    }
  }

  applyEvent(ev: RoomEvent, port: MirrorPort): void {
    switch (ev.k) {
      case 'joined':
        if (ev.unit.callsign !== this.self) this.putUnit(ev.unit, port);
        return;
      case 'left':
        this.dropUnit(ev.callsign, port);
        return;
      case 'host':
        return;
      case 'unitStatus': {
        const u = this.units.get(ev.callsign);
        if (!u) return;
        u.status = ev.status;
        u.callId = ev.callId;
        port.upsertUnit(u);
        return;
      }
      case 'callCreated': {
        if (this.netToCall.has(ev.call.id)) return;
        this.createTracked(ev.call, port);
        return;
      }
      case 'callAssigned': {
        const t = this.openCall(ev.callId);
        if (!t) return;
        if (!t.units.includes(ev.callsign)) t.units.push(ev.callsign);
        const u = this.units.get(ev.callsign);
        if (u) u.callId = ev.callId;
        port.assign(t.local, ev.callsign, ev.callsign === this.self);
        return;
      }
      case 'callUnassigned': {
        const t = this.openCall(ev.callId);
        if (!t) return;
        t.units = t.units.filter((c) => c !== ev.callsign);
        const u = this.units.get(ev.callsign);
        if (u && u.callId === ev.callId) u.callId = null;
        port.unassign(t.local, ev.callsign, ev.callsign === this.self);
        return;
      }
      case 'callPriority': {
        const t = this.openCall(ev.callId);
        if (!t) return;
        t.priority = ev.priority;
        port.setPriority(t.local, ev.priority);
        return;
      }
      case 'callNote': {
        const t = this.openCall(ev.callId);
        if (!t) return;
        t.notes++;
        port.addNote(t.local, ev.note.by, ev.note.text);
        return;
      }
      case 'callClosed': {
        const t = this.openCall(ev.callId);
        if (!t) return;
        t.closed = true;
        for (const cs of t.units) {
          const u = this.units.get(cs);
          if (u && u.callId === ev.callId) u.callId = null;
        }
        port.close(t.local, ev.disposition);
        return;
      }
      case 'order':
        if (ev.to === this.self) port.order(ev);
        return;
      case 'partnered':
        this.setPartner(ev.a, ev.b, port);
        this.setPartner(ev.b, ev.a, port);
        return;
      case 'radio':
        port.radio(ev.from, ev.channel, ev.text);
        return;
    }
  }

  /** Local id of a net call, -1 when unknown. */
  localIdOf(netCallId: number): number {
    return this.netToCall.get(netCallId)?.local ?? -1;
  }

  /** Net id of a local call, -1 when unknown. */
  netIdOf(localCallId: number): number {
    return this.localToNet.get(localCallId) ?? -1;
  }

  /** Move known remote units; unknown callsigns and self are ignored. Allocation free. */
  applyPresence(units: readonly PresenceEntry[], port: MirrorPort): void {
    for (let i = 0; i < units.length; i++) {
      const p = units[i] as PresenceEntry;
      if (p.callsign === this.self) continue;
      const u = this.units.get(p.callsign);
      if (!u) continue;
      u.x = p.x;
      u.z = p.z;
      u.heading = p.heading;
      u.speed = p.speed;
      u.driving = p.driving;
      port.upsertUnit(u);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------

  private openCall(netId: number): Tracked | null {
    const t = this.netToCall.get(netId);
    return t && !t.closed ? t : null;
  }

  private putUnit(u: NetUnit, port: MirrorPort): void {
    const own = { ...u };
    this.units.set(u.callsign, own);
    port.upsertUnit(own);
  }

  private dropUnit(callsign: string, port: MirrorPort): void {
    if (!this.units.delete(callsign)) return;
    port.removeUnit(callsign);
  }

  private setPartner(callsign: string, partner: string, port: MirrorPort): void {
    const u = this.units.get(callsign);
    if (!u) return;
    u.partner = partner;
    port.upsertUnit(u);
  }

  private createTracked(c: NetCall, port: MirrorPort): Tracked {
    const own = this.pendingRefs.get(c.ref);
    let local: number;
    if (own !== undefined && c.createdBy === this.self) {
      this.pendingRefs.delete(c.ref);
      local = own;
    } else {
      local = port.createCall(c);
    }
    const t: Tracked = { local, units: [], notes: 0, priority: c.priority, closed: false };
    this.netToCall.set(c.id, t);
    this.localToNet.set(local, c.id);
    return t;
  }

  /** Bring a tracked call in line with the server's copy: priority, assignments, notes, closure. */
  private reconcile(t: Tracked, c: NetCall, port: MirrorPort): void {
    if (t.priority !== c.priority) {
      t.priority = c.priority;
      port.setPriority(t.local, c.priority);
    }
    for (const cs of t.units.slice()) {
      if (c.units.includes(cs)) continue;
      t.units = t.units.filter((u) => u !== cs);
      port.unassign(t.local, cs, cs === this.self);
    }
    for (const cs of c.units) {
      if (t.units.includes(cs)) continue;
      t.units.push(cs);
      port.assign(t.local, cs, cs === this.self);
    }
    for (let i = t.notes; i < c.notes.length; i++) {
      const n = c.notes[i];
      if (n) port.addNote(t.local, n.by, n.text);
    }
    t.notes = Math.max(t.notes, c.notes.length);
    if (c.status === 'closed') {
      t.closed = true;
      port.close(t.local, c.disposition ?? 'handled');
    }
  }
}
