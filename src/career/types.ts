/**
 * Career types (Phase 8 design §4 and §5.1). The id lists are contracts shared with the other Phase 8 modules.
 * Units: game seconds for times, hours for wellbeing rates, whole game dollars for money, 0..1 for wellbeing values.
 */

export const CAREER_STAGES = ['academy', 'probation', 'patrol', 'separated'] as const;
export type CareerStage = (typeof CAREER_STAGES)[number];

/** A subset of the uniform `RANK_IDS`, lowest first. */
export const CAREER_RANKS = ['officer', 'corporal', 'sergeant', 'lieutenant', 'captain'] as const;
export type CareerRank = (typeof CAREER_RANKS)[number];

export const SPECIALTY_IDS = ['traffic', 'k9', 'detective', 'swat', 'narcotics', 'air'] as const;
export type SpecialtyId = (typeof SPECIALTY_IDS)[number];

export const DUTY_ASSIGNMENTS = ['patrol', 'fto', ...SPECIALTY_IDS] as const;
export type DutyAssignment = (typeof DUTY_ASSIGNMENTS)[number];

export const ACADEMY_MODULES = ['driving', 'firearms', 'defensive', 'report', 'legal'] as const;
export type AcademyModule = (typeof ACADEMY_MODULES)[number];

/** Start hours 6, 14, 22; 8 h each (`career.json`). */
export const SHIFT_SLOTS = ['day', 'swing', 'night'] as const;
export type ShiftSlot = (typeof SHIFT_SLOTS)[number];

export const BEATS = ['downtown', 'suburbs', 'industrial', 'highway'] as const;
export type Beat = (typeof BEATS)[number];

export const OFF_DUTY_ACTIVITIES = ['rest', 'exercise', 'family', 'secondJob'] as const;
export type OffDutyActivity = (typeof OFF_DUTY_ACTIVITIES)[number];

export const STRESS_EVENTS = [
  'forceUsed', 'firearmDischarged', 'officerInjured', 'pursuit', 'deceasedOnScene', 'iaOpened', 'iaSustained',
  'courtLoss', 'commendation', 'criticalIncident', 'arrestMade', 'callCleared',
] as const;
export type StressEvent = (typeof STRESS_EVENTS)[number];

export const DOR_CATEGORIES = ['safety', 'procedure', 'reports', 'community', 'driving'] as const;
export type DorCategory = (typeof DOR_CATEGORIES)[number];

export const CAREER_EVENT_KINDS = [
  'graduated', 'probationPassed', 'probationExtended', 'separated', 'promoted', 'assigned', 'bidAwarded', 'stressLeave',
  'rent', 'note',
] as const;
export type CareerEventKind = (typeof CAREER_EVENT_KINDS)[number];

/** All values 0..1 except `sleepDebtH` (0..24 hours). */
export interface Wellbeing {
  fatigue: number;
  stress: number;
  health: number;
  fitness: number;
  family: number;
  sleepDebtH: number;
}

/** `aimSpread` >= 1 (1 = no penalty); `steerLagS` seconds of steering lag; `vignette` 0..1. */
export interface PerformanceMods {
  aimSpread: number;
  steerLagS: number;
  vignette: number;
}

/** What the integrator reads from conduct and records for eligibility checks. */
export interface EligibilityContext {
  points: number;
  credibility: number;
  sustainedIaRecent: number;
  avgReport: number;
}

export interface Eligibility {
  ok: boolean;
  reasons: string[];
}

/** `best` 0..100, -1 = never tried. */
export interface AcademyRecord {
  best: number;
  attempts: number;
  passed: boolean;
}

export interface ShiftAssignment {
  slot: ShiftSlot;
  beat: Beat;
}

export interface ShiftClock {
  onDuty: boolean;
  shiftNo: number;
  startGame: number;
  endGame: number;
  overFlashed: boolean;
}

export interface ShiftStats {
  calls: number;
  arrests: number;
  reports: number;
  /** `reportSum / reports` = average grade 0..100. */
  reportSum: number;
  forceEvents: number;
  unjustifiedForce: number;
  unlawfulDeterminations: number;
  pursuits: number;
  fleetPoints: number;
  trustDelta: number;
  courtMinutes: number;
  overtimeMinutes: number;
}

export interface PayBreakdown {
  shiftNo: number;
  hours: number;
  base: number;
  night: number;
  specialty: number;
  fto: number;
  overtime: number;
  court: number;
  deductions: number;
  total: number;
}

export interface DorReport {
  shiftNo: number;
  scores: Record<DorCategory, number>;
  average: number;
  notes: string[];
}

export interface CareerEvent {
  game: number;
  kind: CareerEventKind;
  text: string;
}

export interface BidPref {
  slot: ShiftSlot;
  beat: Beat;
}

export interface Bidder {
  id: string;
  name: string;
  seniority: number;
  probation: boolean;
  prefs: readonly BidPref[];
}

/** `prefRank` 0-based, -1 = fallback position. */
export interface BidAward {
  id: string;
  slot: ShiftSlot;
  beat: Beat;
  prefRank: number;
}

export interface OffDutyPlanItem {
  activity: OffDutyActivity;
  hours: number;
}

/** FTO assignment: the hidden true DOR scores of the trainee the player rates. */
export interface Trainee {
  name: string;
  truth: Record<DorCategory, number>;
}

export interface ShiftSummary {
  shiftNo: number;
  pay: PayBreakdown;
  dor: DorReport | null;
  stats: ShiftStats;
  events: CareerEvent[];
  wellbeing: Wellbeing;
  nextStartGame: number;
  nextEndGame: number;
}

export interface OffDutyState {
  hoursLeft: number;
  plan: OffDutyPlanItem[];
  nextStartGame: number;
  nextEndGame: number;
}

/** Read-only snapshot, rebuilt by `CareerState` whenever its revision changes (references, not copies). */
export interface CareerView {
  readonly stage: CareerStage;
  readonly rank: CareerRank;
  readonly assignment: DutyAssignment;
  readonly seniorityShifts: number;
  readonly probationShiftsLeft: number;
  readonly academy: Readonly<Record<AcademyModule, AcademyRecord>>;
  readonly wellbeing: Readonly<Wellbeing>;
  readonly money: number;
  readonly shift: Readonly<ShiftClock>;
  readonly slot: Readonly<ShiftAssignment>;
  readonly bid: Readonly<{ nextBidShift: number; prefs: readonly BidPref[]; lastAwards: readonly BidAward[] }>;
  readonly stats: Readonly<ShiftStats>;
  readonly pay: readonly PayBreakdown[];
  readonly dor: readonly DorReport[];
  readonly history: readonly CareerEvent[];
  readonly offDuty: Readonly<OffDutyState> | null;
  readonly trainee: Readonly<Trainee> | null;
  readonly performance: Readonly<PerformanceMods>;
}

// --- Data shapes (src/data/career/*.json) ----------------------------------------------------------

export interface ActivityDef {
  fatigue: number;
  stress: number;
  fitness: number;
  family: number;
  money: number;
  /** Hours of sleep per hour of the activity. */
  sleep: number;
  maxPerDay: number;
}

export interface WellbeingConfig {
  fatiguePerHour: number;
  slotFactor: Record<ShiftSlot, number>;
  sleepDebtFactor: number;
  stressDecayOnDutyPerHour: number;
  stress: Record<StressEvent, number>;
  activities: Record<OffDutyActivity, ActivityDef>;
  idle: { fatigue: number; stress: number; sleep: number };
  neglect: {
    familyPerDay: number;
    familyStressBelow: number;
    familyStress: number;
    exerciseGraceDays: number;
    fitnessPerDay: number;
    debtStress: number;
    sleepNeedH: number;
    healthRecoveryPerDay: number;
  };
  performance: { aimFatigue: number; aimStress: number; lagMaxS: number; lagFrom: number; vignetteFrom: number };
  fit: { minHealth: number; maxStress: number };
}

export interface PromotionDef {
  minSeniorityShifts: number;
  minPoints: number;
  /** Exam pass mark; 0 = no exam. */
  exam: number;
  maxSustainedIa: number;
}

export interface CareerConfig {
  academy: { pass: Record<AcademyModule, number>; quizQuestions: number };
  probation: { shifts: number; passAverage: number; extensionShifts: number };
  shift: { hours: number; startHour: Record<ShiftSlot, number>; rotation: number[]; minRestH: number; commuteH: number };
  bidding: { everyShifts: number; capacity: number; maxPrefs: number; syntheticBidders: number };
  pay: {
    hourly: Record<CareerRank, number>;
    nightPerHour: number;
    ftoPerHour: number;
    overtimeMultiplier: number;
    courtMultiplier: number;
    rentPerWeek: number;
    startingMoney: number;
  };
  wellbeing: WellbeingConfig;
  range: { targets: number; noShoot: number; durationS: number; radius: number; showS: [number, number]; swayBase: number };
  fto: { minSeniorityShifts: number; minAvgReport: number; minPoints: number; pointsPerAccuracy: number };
  promotions: Record<Exclude<CareerRank, 'officer'>, PromotionDef>;
}

export interface SpecialtyDef {
  label: string;
  description: string;
  minSeniorityShifts: number;
  minRank: CareerRank;
  /** Minimum best score per academy module. */
  academy: Partial<Record<AcademyModule, number>>;
  minPoints: number;
  maxSustainedIa: number;
  minHealth: number;
  minFitness: number;
  payPerHour: number;
  fleetClass: string;
  uniformClass: string;
  /** Crime category -> call mix multiplier. */
  callWeights: Record<string, number>;
}

export const QUIZ_LEVELS = ['academy', 'sergeant', 'lieutenant', 'captain'] as const;
export type QuizLevel = (typeof QUIZ_LEVELS)[number];

export interface QuizQuestion {
  id: string;
  level: QuizLevel;
  topic: string;
  q: string;
  options: [string, string, string, string];
  answer: number;
  explain: string;
}

export const RESISTANCE_LEVELS = ['compliant', 'passive', 'active', 'assaultive', 'lethal'] as const;
export type ResistanceLevel = (typeof RESISTANCE_LEVELS)[number];
export const DRILL_GRADES = ['correct', 'partial', 'wrong'] as const;
export type DrillGrade = (typeof DRILL_GRADES)[number];

export interface DefensiveOption {
  text: string;
  grade: DrillGrade;
}

export interface DefensiveDrill {
  id: string;
  situation: string;
  resistance: ResistanceLevel;
  options: DefensiveOption[];
}

export interface DefensiveData {
  timeLimitS: number;
  drills: DefensiveDrill[];
}

export interface ReportStatement {
  id: string;
  text: string;
  truth: boolean;
  key: boolean;
}

export interface ReportExercise {
  id: string;
  title: string;
  narrative: string[];
  statements: ReportStatement[];
}
