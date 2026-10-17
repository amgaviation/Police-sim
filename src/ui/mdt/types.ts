import type { CadState } from '../../cad/cadState';
import type { CadTime, UnitRequest } from '../../cad/types';
import type { PlateSummary, RecordsDb } from '../../records/db';
import type { ObservedVehicle } from '../../records/vehicle';
import type { RoadGraph } from '../../world/roadGraph';

/** What the MDT needs from the session (design §13.2). Everything is read on demand. */
export interface MdtDeps {
  readonly cad: CadState;
  readonly records: RecordsDb;
  readonly graph: RoadGraph;
  /** The player's unit callsign ("12"). */
  readonly callsign: string;
  officer(): { name: string; badge: string };
  now(): CadTime;
  /** Queued for the dispatcher's next fixed step (`dispatcher.request(player, r, 'mdt')`). */
  request(r: UnitRequest): void;
  /** The car under the reticle, null when none. */
  target(): { vehicleId: number; plate: string; description: string } | null;
  /** Records `observedVehicle(seed, id)` for registry ids, null otherwise. */
  observed(vehicleId: number): ObservedVehicle | null;
  /** Violations the player saw this car commit: kind -> count. */
  observedViolations(vehicleId: number): Readonly<Partial<Record<string, number>>>;
  /** Radar/pace reading for the car, null when none. */
  observedSpeed(vehicleId: number): { speedMph: number; limitMph: number } | null;
  /** Person id seated in the cage, -1 when empty. */
  prisoner(): number;
  atStation(): boolean;
  completeBooking(bookingId: string): void;
  /**
   * A plate run made on the MDT (reported like a dispatcher run, `dispatch:plateResult` via 'mdt', so
   * the hit tone, the HUD target result and the in-car alert follow it). Optional: headless tests.
   */
  plateRun?(vehicleId: number, readback: PlateSummary): void;
  /** The disposition the dispatcher would use to clear this call (a stop's citation / warning). Optional: headless tests. */
  defaultDisposition?(callId: number): string;
}

export const MDT_TABS = ['queue', 'call', 'units', 'map', 'person', 'vehicle', 'bolo', 'reports', 'stop'] as const;
export type MdtTab = (typeof MDT_TABS)[number];

export const MDT_TAB_LABELS: Readonly<Record<MdtTab, string>> = {
  queue: 'Queue',
  call: 'Call',
  units: 'Units',
  map: 'Map',
  person: 'Person',
  vehicle: 'Vehicle',
  bolo: 'BOLO',
  reports: 'Reports',
  stop: 'Stop',
};
