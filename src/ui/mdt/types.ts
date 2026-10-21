import type { CadState } from '../../cad/cadState';
import type { CadTime, UnitRequest } from '../../cad/types';
import type { CareerView } from '../../conduct/types';
import type { CommandBoard, CommandRequest } from '../../command/types';
import type { CourtCase } from '../../court/types';
import type { PlateSummary, RecordsDb } from '../../records/db';
import type { ObservedVehicle } from '../../records/vehicle';
import type { ResourceUnitView } from '../../resources/types';
import type { RoadGraph } from '../../world/roadGraph';
import type { MdtFleetDeps } from './career';
import type { ChoiceInfo, ReportGradeView } from './statements';

/** Career tab feed (design phase 5 §12.1): conduct and court, read on demand. */
export interface MdtCareerDeps {
  /** Changes whenever the conduct state or the court cases change (e.g. conduct.revision * 4096 + court.revision, or their sum). */
  revision(): number;
  view(): CareerView;
  /** Newest first (`CourtState.cases()`). */
  cases(): readonly CourtCase[];
  canAttend(caseId: string): boolean;
  /** Queues a court `attend` request. */
  attend(caseId: string): void;
  /** The app opens the IA review (bodycam timeline and statement) for an open case. */
  openIa(caseId: string): void;
  /** Recorded incidents, newest first (for the Incident footage list). */
  incidents?(): readonly { key: string; typeId: string; district: string; game: number; closed: boolean }[];
  /** Whether the incident's record is still on file. */
  canReview?(key: string): boolean;
  /** The app opens the read-only evidence review (timeline, events, snapshots) of an incident. */
  openReview?(key: string): void;
  jurisdiction(): { id: string; name: string };
  now(): CadTime;
}

/** Community tab feed: trust per district (`ConductState.trustRows()`). */
export interface MdtCommunityDeps {
  revision(): number;
  rows(): readonly { district: string; value: number; baseline: number; trend: number }[];
}

/** One requestable unit type of the Resources tab (menu order; `resolves` is the unit type's description). */
export interface MdtResourceType {
  readonly id: string;
  readonly label: string;
  readonly resolves: string;
  readonly send: string;
}

/** One row of the worker's ETA board (presentation only, never fed back into the simulation). */
export interface MdtEtaRow {
  readonly callsign: string;
  readonly label: string;
  readonly etaS: number;
}

/** Resources tab feed (design phase 6 §12.3). */
export interface MdtResourcesDeps {
  /** Changes whenever the unit list changes (`ResourceSystem.revision`). */
  revision(): number;
  units(): readonly ResourceUnitView[];
  /** Requestable types in menu order. */
  types(): readonly MdtResourceType[];
  /** Queues a request for the player's call (resource types via ResourceSystem, patrol types via the dispatcher). */
  request(typeId: string): void;
  /** Presentation-only ETA board from the worker: rows for `callId` (empty when the worker is unavailable). */
  etaBoard?(callId: number): Promise<readonly MdtEtaRow[]>;
}

/** Command tab feed (design phase 6 §12.3). */
export interface MdtCommandDeps {
  revision(): number;
  board(): CommandBoard;
  request(r: CommandRequest): void;
}

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
  /** The person in a cage (the last-driven car first), -1 when none; `preferId`: that person when they sit in any cage (a van holds several). */
  prisoner(preferId?: number): number;
  atStation(): boolean;
  completeBooking(bookingId: string): void;
  /**
   * A plate run made on the MDT (reported like a dispatcher run, `dispatch:plateResult` via 'mdt', so
   * the hit tone, the HUD target result and the in-car alert follow it). Optional: headless tests.
   */
  plateRun?(vehicleId: number, readback: PlateSummary): void;
  /** The disposition the dispatcher would use to clear this call (a stop's citation / warning). Optional: headless tests. */
  defaultDisposition?(callId: number): string;
  // Phase 5 (design §12.1): all optional, so Phase 1-4 callers and headless tests keep working.
  /** Career tab. Without it the tab explains that no career data exists. */
  career?: MdtCareerDeps;
  /** Phase 7: the fleet's charges and damage summary on the Career tab. */
  fleet?: MdtFleetDeps;
  /** Phase 7: the reporting-officer line that opens a report narrative ('Reporting officer: ... (they/them), badge 4071.'). */
  reportHeader?(): string;
  /** Community tab. */
  community?: MdtCommunityDeps;
  /** The statements of fact the officer may assert for the incident of `callId` (hidden `truth` stripped); [] when none. */
  reportChoices?(callId: number): readonly ChoiceInfo[];
  /** Called after a report with a call is finalized: the checked statement ids go to the incident and conduct systems. */
  submitReport?(docId: string, callId: number, assertionIds: readonly string[]): void;
  /** The graded report, null while ungraded. */
  reportGrade?(docId: string): ReportGradeView | null;
  // Phase 6 (design §12.3): all optional too.
  /** Live ETA (s) of an en-route unit, -1 unknown. Fills the ETA column of the Units tab and the Call tab's unit list. */
  eta?(callsign: string): number;
  /** Resources tab. Without it the tab explains that no resources exist. */
  resources?: MdtResourcesDeps;
  /** Command tab. Without it the tab explains that no incident command exists. */
  command?: MdtCommandDeps;
}

/** Digits 1-9 reach the first nine tabs, 0 the Career tab, and the arrows all of them (Community, Resources, Command). */
export const MDT_TABS = ['queue', 'call', 'units', 'map', 'person', 'vehicle', 'bolo', 'reports', 'stop', 'career', 'community', 'resources', 'command'] as const;
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
  career: 'Career',
  community: 'Community',
  resources: 'Resources',
  command: 'Command',
};

/** The key shown on a tab button: 1-9, then 0 for Career; '' for tabs reached with the arrows only. */
export function tabKeyLabel(tab: MdtTab): string {
  const i = MDT_TABS.indexOf(tab);
  return i < 9 ? String(i + 1) : tab === 'career' ? '0' : '';
}
