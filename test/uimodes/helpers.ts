import type { ConsoleCall, ConsoleUnit, DispatchConsolePort } from '../../src/ui/dispatch/model';

export function call(id: number, over: Partial<ConsoleCall> = {}): ConsoleCall {
  return {
    id,
    number: `25-${String(id).padStart(4, '0')}`,
    nature: 'Disturbance',
    priority: 3,
    status: 'pending',
    address: '12 Main St',
    district: 'downtown',
    ageS: 60,
    units: [],
    x: 0,
    z: 0,
    premise: [],
    notes: [],
    ...over,
  };
}

export function unit(callsign: string, over: Partial<ConsoleUnit> = {}): ConsoleUnit {
  return { callsign, label: `Unit ${callsign}`, status: 'available', callId: null, x: 0, z: 0, etaS: -1, kind: 'ai', ...over };
}

export interface PortLog {
  assign: [number, string][];
  unassign: [number, string][];
  priority: [number, number][];
  note: [number, string][];
  close: [number, string][];
  create: [string, number, number, number][];
  order: [string, string, number | null][];
}

/** A scriptable port: mutate `calls` / `units` / `rev` between steps. */
export class FakePort implements DispatchConsolePort {
  title = 'Dispatch';
  canCreate = true;
  orders: readonly string[] = ['respond', 'returnToStation'];
  dispositions = [
    { id: 'handled', label: 'Handled' },
    { id: 'cancelled', label: 'Cancelled' },
  ];
  rev = 1;
  callList: ConsoleCall[] = [];
  unitList: ConsoleUnit[] = [];
  scoreText: string | null = null;
  log: PortLog = { assign: [], unassign: [], priority: [], note: [], close: [], create: [], order: [] };

  revision(): number {
    return this.rev;
  }
  calls(): readonly ConsoleCall[] {
    return this.callList;
  }
  units(): readonly ConsoleUnit[] {
    return this.unitList;
  }
  callTypes(): readonly { id: string; label: string }[] {
    return [
      { id: 'noise', label: 'Noise complaint' },
      { id: 'theft', label: 'Theft' },
    ];
  }
  score(): string | null {
    return this.scoreText;
  }
  assign(callId: number, callsign: string): void {
    this.log.assign.push([callId, callsign]);
  }
  unassign(callId: number, callsign: string): void {
    this.log.unassign.push([callId, callsign]);
  }
  setPriority(callId: number, p: 1 | 2 | 3 | 4): void {
    this.log.priority.push([callId, p]);
  }
  note(callId: number, text: string): void {
    this.log.note.push([callId, text]);
  }
  close(callId: number, disposition: string): void {
    this.log.close.push([callId, disposition]);
  }
  create(typeId: string, priority: 1 | 2 | 3 | 4, x: number, z: number): void {
    this.log.create.push([typeId, priority, x, z]);
  }
  order(callsign: string, order: string, callId: number | null): void {
    this.log.order.push([callsign, order, callId]);
  }
}
