import { CALL_TYPES, DISPOSITIONS } from '../cad/data';
import type { CadCall, CadUnit } from '../cad/types';
import { districtLabel as modDistrictLabel } from '../mods/registry';
import { formatStamp } from '../records/calendar';
import type { ConsoleCall, ConsolePriority, ConsoleUnit, DispatchConsolePort } from '../ui/dispatch/model';
import type { GameSession } from './session';

/** Seconds between periodic revision bumps (unit movement redraws the map list). */
const MOVE_TICK_S = 1.5;
/** Premise lines shown under a call. */
const PREMISE_LINES = 3;

/** The CAD status of a call as the console shows it. */
function callStatus(c: CadCall): ConsoleCall['status'] {
  return c.status === 'closed' ? 'closed' : c.units.length > 0 ? 'active' : 'pending';
}

/**
 * The dispatch console's port over the local CAD (dispatch-only mode, design §12.1): AI units from the dispatcher,
 * assignments through `Dispatcher.assignUnit` (scored by `DispatchTraining`), no orders.
 */
export class LocalConsolePort implements DispatchConsolePort {
  readonly title = 'Dispatch';
  readonly canCreate = true;
  readonly orders: readonly string[] = [];
  readonly dispositions = DISPOSITIONS.map((d) => ({ id: d.id, label: d.label }));
  private readonly session: GameSession;
  private readonly types = CALL_TYPES.filter((t) => t.generated).map((t) => ({ id: t.id, label: t.label }));

  constructor(session: GameSession) {
    this.session = session;
  }

  revision(): number {
    const s = this.session;
    return s.cad.revision * 4096 + (Math.floor(s.now().sim / MOVE_TICK_S) & 4095);
  }

  calls(): readonly ConsoleCall[] {
    const s = this.session;
    const now = s.now();
    const out: ConsoleCall[] = [];
    for (const c of s.cad.calls()) {
      if (c.status === 'closed') continue;
      const premise = s.phase8.world
        .premiseHistory(c.location.text)
        .slice(-PREMISE_LINES)
        .reverse()
        .map((e) => `${formatStamp(e.game)} ${e.nature}: ${e.disposition}`);
      out.push({
        id: c.id,
        number: c.number,
        nature: c.nature,
        priority: c.priority,
        status: callStatus(c),
        address: c.location.text,
        district: modDistrictLabel(c.location.district),
        ageS: Math.max(0, now.sim - c.created.sim),
        units: [...c.units],
        x: c.location.x,
        z: c.location.z,
        premise,
        notes: c.narrative.slice(-6).map((n) => n.text),
      });
    }
    return out;
  }

  units(): readonly ConsoleUnit[] {
    const out: ConsoleUnit[] = [];
    for (const u of this.session.cad.units()) {
      if (u.kind === 'resource') continue;
      out.push(this.unitRow(u));
    }
    return out;
  }

  private unitRow(u: CadUnit): ConsoleUnit {
    return {
      callsign: u.callsign,
      label: u.officer,
      status: u.status,
      callId: u.callId,
      x: u.x,
      z: u.z,
      etaS: -1,
      kind: u.kind === 'player' ? 'player' : 'ai',
    };
  }

  callTypes(): readonly { id: string; label: string }[] {
    return this.types;
  }

  score(): string | null {
    const d = this.session.phase8.mode.dispatch;
    if (d === null) return null;
    return `${d.grade()}  ${String(Math.round(d.average()))} %`;
  }

  assign(callId: number, callsign: string): void {
    const s = this.session;
    const call = s.cad.call(callId);
    const unit = s.cad.unit(callsign);
    if (!call || !unit) return;
    const now = s.now();
    const dist = Math.hypot(unit.x - call.location.x, unit.z - call.location.z);
    const nearest = s.dispatcher.nearestAvailableDistance(call.location.x, call.location.z);
    if (s.dispatcher.assignUnit(callsign, callId, now)) s.phase8.mode.dispatch?.onAssigned(callId, now.sim, dist, nearest);
  }

  unassign(_callId: number, callsign: string): void {
    this.session.dispatcher.unassignUnit(callsign, this.session.now());
  }

  setPriority(callId: number, p: ConsolePriority): void {
    this.session.dispatcher.setCallPriority(callId, p, this.session.now());
  }

  note(callId: number, text: string): void {
    this.session.cad.addNarrative(callId, 'Dispatch', text, this.session.now());
  }

  close(callId: number, disposition: string): void {
    this.session.cad.closeCall(callId, disposition, this.session.now());
  }

  create(typeId: string, priority: ConsolePriority, x: number, z: number): void {
    const s = this.session;
    const call = s.dispatcher.createScriptedCall({ typeId, priority, x, z }, s.now());
    if (call) s.phase8.noteCreated(call, s.now().sim);
  }

  order(): void {
    // No orders in the local console.
  }
}
