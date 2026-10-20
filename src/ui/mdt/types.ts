import type { CadState } from '../../cad/cadState';
import type { CadTime, UnitRequest } from '../../cad/types';
import type { CareerView } from '../../conduct/types';
import type { CourtCase } from '../../court/types';
import type { PlateSummary, RecordsDb } from '../../records/db';
import type { ObservedVehicle } from '../../records/vehicle';
import type { RoadGraph } from '../../world/roadGraph';
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
  jurisdiction(): { id: string; name: string };
  now(): CadTime;
}

/** Community tab feed: trust per district (`ConductState.trustRows()`). */
export interface MdtCommunityDeps {
  revision(): number;
  rows(): readonly { district: string; value: number; baseline: number; trend: number }[];
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
  // Phase 5 (design §12.1): all optional, so Phase 1-4 callers and headless tests keep working.
  /** Career tab. Without it the tab explains that no career data exists. */
  career?: MdtCareerDeps;
  /** Community tab. */
  community?: MdtCommunityDeps;
  /** The statements of fact the officer may assert for the incident of `callId` (hidden `truth` stripped); [] when none. */
  reportChoices?(callId: number): readonly ChoiceInfo[];
  /** Called after a report with a call is finalized: the checked statement ids go to the incident and conduct systems. */
  submitReport?(docId: string, callId: number, assertionIds: readonly string[]): void;
  /** The graded report, null while ungraded. */
  reportGrade?(docId: string): ReportGradeView | null;
}

/** Digits 1-9 reach the first nine tabs, 0 the Career tab, and the arrows all of them. */
export const MDT_TABS = ['queue', 'call', 'units', 'map', 'person', 'vehicle', 'bolo', 'reports', 'stop', 'career', 'community'] as const;
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
};

/** The key shown on a tab button: 1-9, then 0 for Career; '' for tabs reached with the arrows only. */
export function tabKeyLabel(tab: MdtTab): string {
  const i = MDT_TABS.indexOf(tab);
  return i < 9 ? String(i + 1) : tab === 'career' ? '0' : '';
}
