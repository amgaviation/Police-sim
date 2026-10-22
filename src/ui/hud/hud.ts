import { formatClock, type GameTime } from '../../environment/time';
import type { WeatherState } from '../../environment/weather';
import type { VehicleTelemetry } from '../../vehicles/drivableVehicle';
import { formatFuel, formatGear, formatSpeedMph, limitSignText } from './format';
import {
  LEGAL_COLORS,
  LEGAL_MARKS,
  TRUST_COLORS,
  TRUST_MARKS,
  camChipState,
  camChipText,
  dashChipText,
  forceChipText,
  forceEpisodeText,
  legalLineText,
  trustBand,
  trustChipText,
  type CamChipState,
  type HudCam,
  type HudForce,
  type HudLegal,
  type HudTrust,
  type LegalSeverity,
  type TrustBand,
} from './law';
import {
  SEVERITY_COLORS,
  SEVERITY_MARKS,
  callStripText,
  clampPriority,
  createCallStripText,
  createTargetText,
  policeStatusText,
  priorityColor,
  targetText,
  unitChipText,
  type HudCall,
  type HudPolice,
  type HudTarget,
  type HudUnit,
  type TargetSeverity,
} from './police';
import {
  SCENE_LINES,
  contactChipText,
  createSceneText,
  sceneText,
  weaponChipText,
  type HudContact,
  type HudOfficer,
  type HudScene,
} from './scene';
import {
  NOISE_STEPS,
  bodycamChipText,
  locationChipText,
  noiseMeterText,
  noiseSteps,
  tacticalChipsText,
  visibilityText,
} from './tactical';
import { BACKUP_HUD_LINES, PURSUIT_VERDICT_MS } from './phase6';
import { altitudeText, batteryText, fleetChipText, gearWarningText, oilLowFlag, tyresWornFlag, type HudWear } from './phase7';
import { CHIP_MARKS, vignetteOpacity, wellbeingChip, type ChipSeverity, type HudCareer } from './phase8';
import type { HudBodycam, HudLocation, HudTactical } from './types';

/** Everything the HUD shows; the integrator may reuse one object per frame. */
export interface HudSnapshot {
  /** `remote`: the officer flies a drone (the telemetry is the drone's). */
  mode: 'onFoot' | 'driving' | 'remote';
  telemetry: Readonly<VehicleTelemetry> | null;
  time: Readonly<GameTime>;
  weather: Readonly<WeatherState>;
  /** Nearest street name, '' when off-road. */
  roadName: string;
  /** Effective limit now (school zone and construction applied), 0 = none. */
  speedLimitMph: number;
  schoolZoneActive: boolean;
  construction: boolean;
  /** Context hint, e.g. "E  Enter vehicle"; null hides the line. */
  prompt: string | null;
  cameraMode: string;
  headlights: boolean;
  // Phase 2 (design §13.3): all optional so a Phase 1 feed keeps compiling; absent or null hides the element.
  /** Equipment of the driven patrol car. */
  police?: Readonly<HudPolice> | null;
  /** Locked target vehicle and its plate-run result. */
  target?: Readonly<HudTarget> | null;
  /** The player's active call. */
  call?: Readonly<HudCall> | null;
  /** The player's unit (status chip). */
  unit?: Readonly<HudUnit> | null;
  /** Offer line under the call strip, e.g. 'OFFER C-00043 P3 Alarm  7 Accept · 8 Decline'. */
  offer?: string | null;
  /** Carried items, e.g. 'Flashlight · Cuffs ×2'. */
  carried?: string;
  // Phase 3 (design §12.4): optional as well.
  /** The officer's drawn weapon (chip 'SIDEARM' / 'CED'). */
  officer?: Readonly<HudOfficer> | null;
  /** The person in contact (chip 'Name · state · 4 m'). */
  contact?: Readonly<HudContact> | null;
  /** The call scene: title and up to four objectives (done ones struck through). */
  scene?: Readonly<HudScene> | null;
  /** Pursuit line (red), e.g. 'PURSUIT  Foot  suspect fleeing north'; null hides it. */
  pursuit?: string | null;
  // Phase 4 (design §11.3): optional as well.
  /** Stance and exposure on foot (chips CROUCH / LEAN L·R / SLICE / LIGHT, noise meter, visibility). */
  tactical?: Readonly<HudTactical> | null;
  /** Bodycam: red '● REC' while recording, grey 'CAM' when worn and off. */
  bodycam?: Readonly<HudBodycam> | null;
  /** Shift objective line under the call strip, e.g. 'Shift: attend roll call (E at the podium)'. */
  shift?: string | null;
  /** Building and room the officer is in (chip 'House · Kitchen'). */
  location?: Readonly<HudLocation> | null;
  /** Case line, e.g. 'Case C-00042 · 3 items · 1 photo'. */
  caseLine?: string | null;
  // Phase 5 (design §12.4): optional as well; the integrator's feed fills them.
  /** Force tool chip ('CED 2/2'); replaces the Phase 3 weapon chip when present. */
  force?: Readonly<HudForce> | null;
  /** Camera chips REC / MUTED / DASH; replaces the Phase 4 bodycam chip when present. */
  cam?: Readonly<HudCam> | null;
  /** Last force verdict / advisory line. */
  legal?: Readonly<HudLegal> | null;
  /** Duty status line ('SUSPENDED until Tue 06:00'); null when on duty. */
  duty?: string | null;
  /** Next court hearing ('COURT 14:00 · CR-0003 · in 1 h 20 min'). */
  court?: string | null;
  /** Trust of the district the officer is in. */
  trust?: Readonly<HudTrust> | null;
  // Phase 6 (design §12.4): optional as well; absent or null hides the element.
  /** Up to 4 lines: '21 Alvarez · COVER', '23 Park · SECONDARY · chasing', posts 'TCP 2/4'. */
  backup?: readonly string[] | null;
  /** 'PURSUIT · 62 mph · risk 0.48 · SGT-1 monitoring · AIR on target'. */
  pursuit6?: string | null;
  /** Last pursuit tactic verdict ('PIT: within policy'); the HUD hides it `PURSUIT_VERDICT_MS` after it changed. */
  pursuitVerdict?: string | null;
  /** 'MEDIC-2 ETA 3:10'. */
  resourceEta?: string | null;
  /** Command chip ('ICS · DISASTER · RED 3 YEL 4 GRN 2 BLK 1 · EVAC 60%'). */
  command?: string | null;
  /** FLIR overlay on (the app swaps the camera). */
  flir?: boolean;
  // Phase 7 (design §12.4): optional as well; absent or null hides the element.
  /** Oil level and lowest tyre tread of the driven vehicle: chips 'OIL LOW' / 'TYRES WORN' below 25 %. */
  wear?: Readonly<HudWear> | null;
  /** Aircraft altitude in metres (chip 'ALT 120 m'). */
  altitude?: number | null;
  /** Drone battery 0..1: the fuel gauge shows 'BATT 64 %' instead of the fuel percentage. */
  battery?: number | null;
  /** Fleet chip ('P-101 · damage report due'). */
  fleet?: string | null;
  /** Gear warning line in the legal-line style ('Loadout: overweight 15.2 / 14 kg'). */
  gearWarning?: string | null;
}

export interface HudOptions {
  /** DOM refresh rate in updates per second. Default 10. */
  updateHz?: number;
}

/** Fuel fraction below which the fuel warning shows. */
export const FUEL_LOW_FRACTION = 0.15;
/** Engine health below which the engine warning shows (also shown when the engine is off). */
export const ENGINE_WARN_HEALTH = 0.3;
/** Brake temperature (°C) from which the brakes-hot warning shows (also on any fade). */
export const BRAKES_HOT_C = 300;
/** Worst body-zone damage (0..1) from which the damage readout shows. */
export const DAMAGE_SHOW_FRACTION = 0.05;

/** Strings and flags derived from a snapshot; compared field by field before touching the DOM. */
export interface HudText {
  driving: boolean;
  speed: string;
  gear: string;
  abs: boolean;
  /** Percentage, also the fuel bar width, e.g. "57%". */
  fuel: string;
  fuelLow: boolean;
  engineWarn: boolean;
  tyreWarn: boolean;
  brakesWarn: boolean;
  /** "DAMAGE 35%" (worst body zone), '' below `DAMAGE_SHOW_FRACTION`. */
  damage: string;
  status: string;
  clock: string;
  weather: string;
  road: string;
  limit: string;
  showLimit: boolean;
  schoolZone: boolean;
  construction: boolean;
  prompt: string;
  /** Police status line ('LIGHTS ALT · SIREN WAIL · HORN · SPOT'); '' hides it. Driving only. */
  police: string;
  /** Unit chip ('12 · 10-8 AVAILABLE'); '' hides the unit row. */
  unit: string;
  unitEmergency: boolean;
  unitStatusCheck: boolean;
  /** Call strip lines; an empty title hides the strip. */
  callTitle: string;
  callAddress: string;
  callStatus: string;
  /** 1..4 (strip accent colour). */
  callPriority: number;
  /** Offer line; '' hides it. */
  offer: string;
  /** Target reticle and its lines. */
  targetShow: boolean;
  targetLabel: string;
  /** '' hides the result line. */
  targetResult: string;
  targetSeverity: TargetSeverity;
  /** Carried items line; '' hides it. */
  carried: string;
  /** Weapon chip ('SIDEARM' / 'CED'); '' hides it. */
  weapon: string;
  /** Contact chip; '' hides it. */
  contact: string;
  /** Objective box title; '' hides the box. */
  sceneTitle: string;
  /** `SCENE_LINES` objective lines ('' = unused) and whether each is done. */
  sceneLines: string[];
  sceneDone: boolean[];
  /** Red pursuit line; '' hides it. */
  pursuit: string;
  /** Active stance chips ('CROUCH · LEAN L · SLICE · LIGHT'); '' hides them. */
  tactical: string;
  /** Lit noise steps (0..`NOISE_STEPS`) and the meter text ('■■■□□'); the meter text is '' without tactical state. */
  noise: number;
  noiseMeter: string;
  /** 'VIS 60%'; '' without tactical state. */
  visibility: string;
  /** '● REC' / 'CAM'; '' hides the chip. */
  bodycam: string;
  bodycamRecording: boolean;
  /** Shift objective line; '' hides it. */
  shift: string;
  /** Location chip ('House · Kitchen'); '' hides it. */
  location: string;
  /** Case line; '' hides it. */
  caseLine: string;
  /** Bodycam chip is amber (muted). */
  bodycamMuted: boolean;
  /** 'DASH'; '' hides the chip. */
  dash: string;
  /** Force tool chip ('CED 2/2 · PROBES'); '' hides it. */
  force: string;
  /** Fellow-officer misconduct episode chip; '' hides it. */
  episode: string;
  /** Legal line and its severity; '' hides the line. */
  legal: string;
  legalSeverity: LegalSeverity;
  /** Duty status line; '' hides it. */
  duty: string;
  /** Court line; '' hides it. */
  court: string;
  /** Trust chip ('Trust · Suburbs 62 %'); '' hides it. */
  trust: string;
  trustBand: TrustBand;
  /** Backup roster lines (`BACKUP_HUD_LINES`, '' = unused). */
  backup: string[];
  /** Phase 6 pursuit line; '' hides it. */
  pursuit6: string;
  /** Last tactic verdict; '' hides it. */
  pursuitVerdict: string;
  /** Next resource ETA chip; '' hides it. */
  resourceEta: string;
  /** Command chip; '' hides it. */
  command: string;
  /** FLIR chip. */
  flir: boolean;
  /** 'OIL LOW' / 'TYRES WORN' chips (driving only). */
  oilLow: boolean;
  tyresWorn: boolean;
  /** 'ALT 120 m'; '' hides the chip. */
  altitude: string;
  /** 'BATT 64 %' replaces the fuel gauge label; '' keeps the fuel label. */
  battery: string;
  /** Fleet chip; '' hides it. */
  fleet: string;
  /** Gear warning line; '' hides it. */
  gearWarning: string;
  // Phase 8 (design §11.3): set through `Hud.setCareer` / `setCourseLine` / `setCoopChip` / `setOrderLine`.
  /** Wellbeing chip ('FATIGUE 72 %'); '' hides it. */
  careerChip: string;
  careerSeverity: ChipSeverity;
  /** Career shift line ('Shift 06:00-14:00' / 'OT +0:35'); '' hides it. */
  careerShift: string;
  /** Vignette strength 0..1 (hundredths); 0 hides the overlay. */
  vignette: number;
  /** Driving course line; '' hides it. */
  courseLine: string;
  /** Co-op chip; '' hides it. */
  coopChip: string;
  /** Dispatcher order line (co-op); '' hides it. */
  orderLine: string;
}

export function createHudText(): HudText {
  return {
    driving: false,
    speed: '',
    gear: '',
    abs: false,
    fuel: '',
    fuelLow: false,
    engineWarn: false,
    tyreWarn: false,
    brakesWarn: false,
    damage: '',
    status: '',
    clock: '',
    weather: '',
    road: '',
    limit: '',
    showLimit: false,
    schoolZone: false,
    construction: false,
    prompt: '',
    police: '',
    unit: '',
    unitEmergency: false,
    unitStatusCheck: false,
    callTitle: '',
    callAddress: '',
    callStatus: '',
    callPriority: 4,
    offer: '',
    targetShow: false,
    targetLabel: '',
    targetResult: '',
    targetSeverity: 'none',
    carried: '',
    weapon: '',
    contact: '',
    sceneTitle: '',
    sceneLines: new Array<string>(SCENE_LINES).fill(''),
    sceneDone: new Array<boolean>(SCENE_LINES).fill(false),
    pursuit: '',
    tactical: '',
    noise: 0,
    noiseMeter: '',
    visibility: '',
    bodycam: '',
    bodycamRecording: false,
    shift: '',
    location: '',
    caseLine: '',
    bodycamMuted: false,
    dash: '',
    force: '',
    episode: '',
    legal: '',
    legalSeverity: 'ok',
    duty: '',
    court: '',
    trust: '',
    trustBand: 'high',
    backup: new Array<string>(BACKUP_HUD_LINES).fill(''),
    pursuit6: '',
    pursuitVerdict: '',
    resourceEta: '',
    command: '',
    flir: false,
    oilLow: false,
    tyresWorn: false,
    altitude: '',
    battery: '',
    fleet: '',
    gearWarning: '',
    careerChip: '',
    careerSeverity: 'clear',
    careerShift: '',
    vignette: 0,
    courseLine: '',
    coopChip: '',
    orderLine: '',
  };
}

// Scratch for the multi-line helpers (hudText runs on the main thread at the HUD rate).
const CALL_SCRATCH = createCallStripText();
const TARGET_SCRATCH = createTargetText();
const SCENE_SCRATCH = createSceneText();

function weatherText(w: Readonly<WeatherState>): string {
  const kind = w.kind.charAt(0).toUpperCase() + w.kind.slice(1);
  return `${kind}  ${String(Math.round(w.temperatureC))}°C`;
}

/** Fills `out` with the HUD text for `s` (pure; builds strings, so call it at the throttled rate). */
export function hudText(s: HudSnapshot, out: HudText = createHudText()): HudText {
  const t = s.mode === 'driving' || s.mode === 'remote' ? s.telemetry : null;
  out.driving = t !== null;
  out.speed = t ? formatSpeedMph(t.speedMph) : '';
  out.gear = t ? formatGear(t.gear) : '';
  out.abs = t ? t.absActive : false;
  // A drone's battery replaces the fuel gauge (same bar and low warning).
  const battery = t && s.battery !== null && s.battery !== undefined && Number.isFinite(s.battery) ? s.battery : null;
  const gauge = battery ?? (t ? t.fuelFraction : 0);
  out.battery = battery === null ? '' : batteryText(battery);
  out.fuel = t ? formatFuel(gauge) : '';
  out.fuelLow = t ? gauge < FUEL_LOW_FRACTION : false;
  out.engineWarn = t ? !t.engineRunning || t.engineHealth < ENGINE_WARN_HEALTH : false;
  out.tyreWarn = t ? t.tireFlat[0] || t.tireFlat[1] || t.tireFlat[2] || t.tireFlat[3] : false;
  out.brakesWarn = t ? t.brakeTempC >= BRAKES_HOT_C || t.brakeEfficiency < 0.999 : false;
  const worst = t ? Math.max(t.damage[0], t.damage[1], t.damage[2], t.damage[3]) : 0;
  out.damage = worst >= DAMAGE_SHOW_FRACTION ? `DAMAGE ${String(Math.round(worst * 100))}%` : '';
  out.status = t ? `${s.cameraMode.toUpperCase()}${s.headlights ? '  LIGHTS' : ''}` : '';
  out.clock = formatClock(s.time);
  out.weather = weatherText(s.weather);
  out.road = s.roadName;
  out.showLimit = s.roadName !== '' && s.speedLimitMph > 0;
  out.limit = limitSignText(s.speedLimitMph);
  out.schoolZone = s.schoolZoneActive;
  out.construction = s.construction;
  out.prompt = s.prompt ?? '';

  out.police = t ? policeStatusText(s.police) : '';
  const unit = s.unit ?? null;
  out.unit = unitChipText(unit);
  out.unitEmergency = unit ? unit.emergency : false;
  out.unitStatusCheck = unit ? unit.statusCheck : false;
  const call = callStripText(s.call, CALL_SCRATCH);
  out.callTitle = call.title;
  out.callAddress = call.address;
  out.callStatus = call.status;
  out.callPriority = s.call ? clampPriority(s.call.priority) : 4;
  out.offer = s.offer ?? '';
  const target = targetText(s.target, TARGET_SCRATCH);
  out.targetShow = target.show;
  out.targetLabel = target.label;
  out.targetResult = target.result;
  out.targetSeverity = target.severity;
  out.carried = s.carried ?? '';
  // The force tool chip replaces the Phase 3 weapon chip once the force feed exists.
  out.weapon = s.force ? '' : weaponChipText(s.officer);
  out.contact = contactChipText(s.contact);
  const scene = sceneText(s.scene, SCENE_SCRATCH);
  out.sceneTitle = scene.title;
  for (let i = 0; i < SCENE_LINES; i++) {
    out.sceneLines[i] = scene.lines[i] ?? '';
    out.sceneDone[i] = scene.done[i] ?? false;
  }
  out.pursuit = s.pursuit ?? '';
  const tac = s.tactical ?? null;
  out.tactical = tacticalChipsText(tac);
  out.noise = tac ? noiseSteps(tac.noise) : 0;
  out.noiseMeter = tac ? noiseMeterText(tac.noise) : '';
  out.visibility = visibilityText(tac);
  // The camera chips replace the Phase 4 bodycam chip once the camera feed exists.
  const cam = s.cam ?? null;
  const camState: CamChipState = camChipState(cam);
  out.bodycam = cam ? camChipText(cam) : bodycamChipText(s.bodycam);
  out.bodycamRecording = cam ? camState === 'rec' : s.bodycam ? s.bodycam.recording : false;
  out.bodycamMuted = camState === 'muted';
  out.dash = dashChipText(cam);
  out.shift = s.shift ?? '';
  out.location = locationChipText(s.location);
  out.caseLine = s.caseLine ?? '';
  out.force = forceChipText(s.force);
  out.episode = forceEpisodeText(s.force);
  out.legal = legalLineText(s.legal);
  out.legalSeverity = s.legal ? s.legal.severity : 'ok';
  out.duty = s.duty ?? '';
  out.court = s.court ?? '';
  out.trust = trustChipText(s.trust);
  out.trustBand = s.trust ? trustBand(s.trust.value) : 'high';
  const backup = s.backup ?? null;
  for (let i = 0; i < BACKUP_HUD_LINES; i++) out.backup[i] = backup?.[i] ?? '';
  out.pursuit6 = s.pursuit6 ?? '';
  out.pursuitVerdict = s.pursuitVerdict ?? '';
  out.resourceEta = s.resourceEta ?? '';
  out.command = s.command ?? '';
  out.flir = s.flir === true;
  out.oilLow = t ? oilLowFlag(s.wear) : false;
  out.tyresWorn = t ? tyresWornFlag(s.wear) : false;
  out.altitude = t ? altitudeText(s.altitude) : '';
  out.fleet = fleetChipText(s.fleet);
  out.gearWarning = gearWarningText(s.gearWarning);
  return out;
}

// --- DOM ---------------------------------------------------------------------------

// Sizes are rem of the root font, which carries the accessibility text size (--text-scale on <html>, styles.css): 1 rem = 14 px
// at text size 1, so `px(13)` is 13 px at 1x and scales with the setting. Colours are the tokens of styles.css (the
// colour-vision palettes apply to the HUD too); every line may wrap (`overflow-wrap:anywhere`) and is capped in vw / rem so
// text at scale 1.6 never leaves the screen.
const px = (n: number): string => `${String(Math.round((n / 14) * 1000) / 1000)}rem`;

const ROOT_STYLE = [
  'position:absolute',
  'inset:0',
  'z-index:900',
  'pointer-events:none',
  'color:var(--fg-strong)',
  'font-family:var(--font-ui)',
  'text-shadow:0 1px 2px var(--text-shadow-ink)',
  'user-select:none',
  'overflow-wrap:anywhere',
].join(';');

const PANEL = `position:absolute;background:var(--hud-bg-soft);border-radius:var(--radius);padding:${px(6)} ${px(10)}`;
/** A centred single line: as wide as its text, at most 90 vw, wrapping instead of leaving the screen. */
const LINE = `width:max-content;max-width:min(90vw, 46rem);overflow-wrap:anywhere`;
/** The dark label colour on a coloured chip. */
const ON_CHIP = 'var(--bg)';

const STYLES = {
  bottomRight: `position:absolute;right:${px(16)};bottom:${px(16)};display:flex;flex-direction:column;align-items:flex-end;gap:${px(6)};max-width:min(92vw, 30rem)`,
  speedPanel: `${PANEL};position:relative;min-width:${px(150)};max-width:100%;text-align:right`,
  speed: `font:700 ${px(44)}/1 var(--font-mono)`,
  unit: `font-size:${px(13)};opacity:0.8;margin-left:${px(4)}`,
  row: `display:flex;justify-content:flex-end;gap:${px(8)};align-items:center;margin-top:${px(4)};font-size:${px(13)}`,
  gear: `font:700 ${px(18)}/1 var(--font-mono)`,
  chip: `padding:${px(1)} ${px(5)};border-radius:var(--radius);font-weight:700;font-size:${px(11)}`,
  fuelTrack: `width:${px(90)};height:${px(6)};background:var(--track);border-radius:${px(3)};overflow:hidden`,
  fuelBar: 'height:100%;width:0;background:var(--c-ok)',
  fuelText: `font-size:${px(12)};min-width:${px(34)}`,
  warnings: `display:flex;flex-wrap:wrap;justify-content:flex-end;gap:${px(4)};margin-top:${px(4)}`,
  status: `font-size:${px(11)};opacity:0.75;margin-top:${px(4)};letter-spacing:0.05em`,
  topRight: `${PANEL};right:${px(16)};top:${px(16)};max-width:45vw;text-align:right;font-size:${px(14)}`,
  clock: `font:700 ${px(18)}/1.2 var(--font-mono)`,
  bottomCentre: `${PANEL};left:50%;bottom:${px(16)};transform:translateX(-50%);display:flex;align-items:center;gap:${px(10)};width:max-content;max-width:min(60vw, 40rem)`,
  road: `font-size:${px(16)};font-weight:600`,
  sign: `display:flex;flex-direction:column;align-items:center;min-width:${px(40)};padding:${px(2)} ${px(4)};border:${px(2)} solid var(--sign-ink);border-radius:var(--radius);color:var(--sign-ink);text-shadow:none;line-height:1`,
  signCaption: `font-size:${px(8)};font-weight:700`,
  signValue: `font:700 ${px(20)}/1 var(--font-ui)`,
  workTag: `padding:${px(2)} ${px(6)};border-radius:var(--radius);background:var(--c-p2);color:${ON_CHIP};text-shadow:none;font-weight:700;font-size:${px(11)}`,
  prompt: `position:absolute;left:50%;bottom:${px(84)};transform:translateX(-50%);padding:${px(4)} ${px(10)};border-radius:var(--radius);background:var(--hud-bg);font-size:${px(15)};text-align:center;${LINE}`,
  police: `font-size:${px(12)};font-weight:700;color:var(--info);margin-top:${px(3)};letter-spacing:0.05em`,
  unitRow: `${PANEL};position:relative;display:flex;flex-wrap:wrap;gap:${px(6)};align-items:center;padding:${px(4)} ${px(8)};font-size:${px(13)};font-weight:700;max-width:100%`,
  carried: `${PANEL};position:relative;padding:${px(3)} ${px(8)};font-size:${px(12)};opacity:0.9;max-width:100%`,
  topLeft: `position:absolute;left:${px(16)};top:${px(16)};display:flex;flex-direction:column;align-items:flex-start;gap:${px(6)};max-width:min(92vw, 27rem)`,
  callPanel: `${PANEL};position:relative;border-left:${px(4)} solid var(--fg-dim);font-size:${px(13)};max-width:100%`,
  callTitle: `font-weight:700;font-size:${px(15)}`,
  callStatus: `font-size:${px(12)};opacity:0.85;letter-spacing:0.05em`,
  offer: `${PANEL};position:relative;background:var(--hud-bg);color:var(--c-caution);border-left:${px(4)} solid var(--c-caution);font-weight:700;font-size:${px(13)};max-width:100%`,
  reticle: `position:absolute;left:50%;top:50%;width:${px(90)};height:${px(56)};transform:translate(-50%,-50%)`,
  corner: `position:absolute;width:${px(14)};height:${px(14)};border:0 solid var(--fg-strong)`,
  targetInfo: `position:absolute;left:50%;top:calc(50% + ${px(36)});transform:translateX(-50%);text-align:center;${LINE}`,
  targetLabel: `${PANEL};position:relative;display:inline-block;padding:${px(2)} ${px(8)};font:700 ${px(14)}/1.3 var(--font-mono)`,
  targetResult: `margin-top:${px(4)};font-weight:700;font-size:${px(13)}`,
  chipRow: `display:flex;gap:${px(6)};align-items:center;justify-content:flex-end;flex-wrap:wrap`,
  contact: `${PANEL};position:relative;padding:${px(3)} ${px(8)};font-size:${px(13)};font-weight:600;max-width:100%`,
  scenePanel: `${PANEL};position:relative;border-left:${px(4)} solid var(--accent);font-size:${px(13)};max-width:100%`,
  sceneTitle: `font-weight:700;font-size:${px(14)}`,
  sceneLine: `display:flex;gap:${px(6)};align-items:baseline`,
  sceneMark: `font-weight:700;min-width:${px(12)}`,
  tacticalRow: `display:flex;gap:${px(6)};align-items:center;justify-content:flex-end;flex-wrap:wrap`,
  tacticalChips: `${PANEL};position:relative;padding:${px(2)} ${px(8)};font-size:${px(12)};font-weight:700;letter-spacing:0.05em`,
  meter: `${PANEL};position:relative;padding:${px(2)} ${px(8)};font:700 ${px(12)}/1.3 var(--font-mono);letter-spacing:0.05em`,
  shiftLine: `${PANEL};position:relative;border-left:${px(4)} solid var(--c-caution);font-size:${px(13)};font-weight:600;max-width:100%`,
  caseLine: `${PANEL};position:relative;border-left:${px(4)} solid var(--info);font-size:${px(12)};max-width:100%`,
  location: `margin-top:${px(4)};font-size:${px(12)};font-weight:700;opacity:0.9`,
  legalLine: `${PANEL};left:50%;bottom:${px(122)};transform:translateX(-50%);border-left:${px(4)} solid var(--c-ok);font-size:${px(14)};font-weight:700;${LINE}`,
  dutyLine: `${PANEL};position:relative;border-left:${px(4)} solid var(--c-alert);font-size:${px(13)};font-weight:700;letter-spacing:0.04em;max-width:100%`,
  courtLine: `${PANEL};position:relative;border-left:${px(4)} solid var(--info);font-size:${px(13)};font-weight:600;max-width:100%`,
  trust: `margin-top:${px(4)};font-size:${px(12)};font-weight:700`,
  pursuit: `${PANEL};left:50%;top:${px(16)};transform:translateX(-50%);background:var(--hud-bg);border:${px(2)} solid var(--c-alert);color:var(--fg-strong);font-weight:700;font-size:${px(15)};letter-spacing:0.05em;${LINE}`,
  pursuit6: `${PANEL};left:50%;top:${px(56)};transform:translateX(-50%);background:var(--hud-bg);border:${px(2)} solid var(--c-alert);color:var(--fg-strong);font-weight:700;font-size:${px(14)};letter-spacing:0.05em;${LINE}`,
  pursuitVerdict: `${PANEL};left:50%;top:${px(92)};transform:translateX(-50%);border-left:${px(4)} solid var(--c-caution);font-weight:700;font-size:${px(14)};${LINE}`,
  backupPanel: `${PANEL};position:relative;border-left:${px(4)} solid var(--c-unit);font-size:${px(12)};font-weight:600;max-width:100%`,
  gearLine: `${PANEL};left:50%;bottom:${px(160)};transform:translateX(-50%);border-left:${px(4)} solid var(--c-caution);font-size:${px(14)};font-weight:700;${LINE}`,
  careerShift: `${PANEL};position:relative;border-left:${px(4)} solid var(--c-unit);font-size:${px(13)};font-weight:600;max-width:100%`,
  courseLine: `${PANEL};left:50%;top:${px(128)};transform:translateX(-50%);border-left:${px(4)} solid var(--c-ok);font:700 ${px(15)}/1.3 var(--font-mono);${LINE}`,
  orderLine: `${PANEL};left:50%;top:${px(164)};transform:translateX(-50%);border-left:${px(4)} solid var(--c-caution);font-weight:700;font-size:${px(14)};${LINE}`,
  vignette: 'position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center, transparent 40%, var(--black) 100%)',
  commandLine: `${PANEL};position:relative;border-left:${px(4)} solid var(--c-caution);font-size:${px(12)};font-weight:700;letter-spacing:0.04em;max-width:100%`,
} as const;

/** Corner bracket borders of the target reticle (top-left, top-right, bottom-left, bottom-right). */
const CORNERS = [
  'left:0;top:0;border-left-width:2px;border-top-width:2px',
  'right:0;top:0;border-right-width:2px;border-top-width:2px',
  'left:0;bottom:0;border-left-width:2px;border-bottom-width:2px',
  'right:0;bottom:0;border-right-width:2px;border-bottom-width:2px',
] as const;

const SIGN_WHITE = 'var(--sign-bg)';
const SIGN_YELLOW = 'var(--sign-warn)';

interface HudView {
  root: HTMLDivElement;
  speedPanel: HTMLDivElement;
  speed: HTMLSpanElement;
  gear: HTMLSpanElement;
  abs: HTMLSpanElement;
  fuelBar: HTMLDivElement;
  fuel: HTMLSpanElement;
  engine: HTMLSpanElement;
  tyre: HTMLSpanElement;
  brakes: HTMLSpanElement;
  fuelLow: HTMLSpanElement;
  damage: HTMLSpanElement;
  status: HTMLDivElement;
  clock: HTMLDivElement;
  weather: HTMLDivElement;
  roadPanel: HTMLDivElement;
  road: HTMLSpanElement;
  sign: HTMLDivElement;
  signCaption: HTMLSpanElement;
  signValue: HTMLSpanElement;
  workTag: HTMLSpanElement;
  prompt: HTMLDivElement;
  police: HTMLDivElement;
  unitRow: HTMLDivElement;
  unit: HTMLSpanElement;
  unitEmergency: HTMLSpanElement;
  unitStatusCheck: HTMLSpanElement;
  carried: HTMLDivElement;
  callPanel: HTMLDivElement;
  callTitle: HTMLDivElement;
  callAddress: HTMLDivElement;
  callStatus: HTMLDivElement;
  offer: HTMLDivElement;
  reticle: HTMLDivElement;
  targetInfo: HTMLDivElement;
  targetLabel: HTMLDivElement;
  targetResult: HTMLDivElement;
  weapon: HTMLSpanElement;
  contact: HTMLDivElement;
  scenePanel: HTMLDivElement;
  sceneTitle: HTMLDivElement;
  sceneRows: HTMLDivElement[];
  sceneMarks: HTMLSpanElement[];
  sceneTexts: HTMLSpanElement[];
  pursuit: HTMLDivElement;
  tacticalRow: HTMLDivElement;
  tactical: HTMLDivElement;
  noise: HTMLDivElement;
  visibility: HTMLDivElement;
  bodycam: HTMLSpanElement;
  shift: HTMLDivElement;
  caseLine: HTMLDivElement;
  location: HTMLDivElement;
  dash: HTMLSpanElement;
  forceChip: HTMLSpanElement;
  episode: HTMLSpanElement;
  legal: HTMLDivElement;
  duty: HTMLDivElement;
  court: HTMLDivElement;
  trust: HTMLDivElement;
  backupPanel: HTMLDivElement;
  backupRows: HTMLDivElement[];
  pursuit6: HTMLDivElement;
  pursuitVerdict: HTMLDivElement;
  resourceEta: HTMLSpanElement;
  command: HTMLDivElement;
  flirChip: HTMLSpanElement;
  oilChip: HTMLSpanElement;
  wornChip: HTMLSpanElement;
  altChip: HTMLSpanElement;
  fleetChip: HTMLSpanElement;
  gearLine: HTMLDivElement;
  careerChip: HTMLSpanElement;
  coopChip: HTMLSpanElement;
  careerShift: HTMLDivElement;
  courseLine: HTMLDivElement;
  orderLine: HTMLDivElement;
  vignette: HTMLDivElement;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, style: string, parent: HTMLElement | null, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.setAttribute('style', style);
  if (text !== '') e.textContent = text;
  parent?.appendChild(e);
  return e;
}

function chip(text: string, background: string, parent: HTMLElement): HTMLSpanElement {
  const e = node('span', `${STYLES.chip};background:${background};color:${ON_CHIP};text-shadow:none`, parent, text);
  e.style.display = 'none';
  return e;
}

function buildView(parent: HTMLElement): HudView {
  const root = node('div', ROOT_STYLE, null);
  root.id = 'hud';

  const bottomRight = node('div', STYLES.bottomRight, root);
  const chipRow = node('div', STYLES.chipRow, bottomRight);
  const contact = node('div', STYLES.contact, chipRow);
  contact.style.display = 'none';
  const weapon = chip('', 'var(--c-p2)', chipRow);
  const bodycam = chip('', 'var(--fg-dim)', chipRow);
  const dash = chip('', 'var(--info)', chipRow);
  const forceChip = chip('', 'var(--c-p2)', chipRow);
  const episode = chip('', 'var(--c-emergency)', chipRow);
  const resourceEta = chip('', 'var(--info)', chipRow);
  const flirChip = chip('IR', 'var(--flir)', chipRow);
  const fleetChip = chip('', 'var(--c-caution)', chipRow);
  const careerChip = chip('', 'var(--c-caution)', chipRow);
  const coopChip = chip('', 'var(--c-unit)', chipRow);
  const tacticalRow = node('div', STYLES.tacticalRow, bottomRight);
  tacticalRow.style.display = 'none';
  const tactical = node('div', STYLES.tacticalChips, tacticalRow);
  tactical.style.display = 'none';
  const noise = node('div', STYLES.meter, tacticalRow);
  const visibility = node('div', STYLES.meter, tacticalRow);
  const carried = node('div', STYLES.carried, bottomRight);
  carried.style.display = 'none';
  const unitRow = node('div', STYLES.unitRow, bottomRight);
  unitRow.style.display = 'none';
  const unit = node('span', '', unitRow);
  const unitEmergency = chip('! EMERGENCY', 'var(--c-emergency)', unitRow);
  const unitStatusCheck = chip('? STATUS CHECK', 'var(--c-caution)', unitRow);
  const speedPanel = node('div', STYLES.speedPanel, bottomRight);
  const speedLine = node('div', '', speedPanel);
  const speed = node('span', STYLES.speed, speedLine, '0');
  node('span', STYLES.unit, speedLine, 'mph');
  const row = node('div', STYLES.row, speedPanel);
  const abs = chip('ABS', 'var(--c-caution)', row);
  const fuelTrack = node('div', STYLES.fuelTrack, row);
  const fuelBar = node('div', STYLES.fuelBar, fuelTrack);
  const fuel = node('span', STYLES.fuelText, row);
  const gear = node('span', STYLES.gear, row, 'N');
  const warnings = node('div', STYLES.warnings, speedPanel);
  const engine = chip('! ENGINE', 'var(--c-alert)', warnings);
  const tyre = chip('! TYRE', 'var(--c-alert)', warnings);
  const brakes = chip('BRAKES HOT', 'var(--c-p2)', warnings);
  const fuelLow = chip('FUEL LOW', 'var(--c-p2)', warnings);
  const oilChip = chip('OIL LOW', 'var(--c-p2)', warnings);
  const wornChip = chip('TYRES WORN', 'var(--c-p2)', warnings);
  const altChip = chip('', 'var(--info)', warnings);
  const damage = chip('', 'var(--fg)', warnings);
  const status = node('div', STYLES.status, speedPanel);
  const police = node('div', STYLES.police, speedPanel);
  police.style.display = 'none';

  const topLeft = node('div', STYLES.topLeft, root);
  const callPanel = node('div', STYLES.callPanel, topLeft);
  callPanel.style.display = 'none';
  const callTitle = node('div', STYLES.callTitle, callPanel);
  const callAddress = node('div', '', callPanel);
  const callStatus = node('div', STYLES.callStatus, callPanel);
  const offer = node('div', STYLES.offer, topLeft);
  offer.style.display = 'none';
  const shift = node('div', STYLES.shiftLine, topLeft);
  shift.style.display = 'none';
  const careerShift = node('div', STYLES.careerShift, topLeft);
  careerShift.style.display = 'none';
  const scenePanel = node('div', STYLES.scenePanel, topLeft);
  scenePanel.style.display = 'none';
  const sceneTitle = node('div', STYLES.sceneTitle, scenePanel);
  const sceneRows: HTMLDivElement[] = [];
  const sceneMarks: HTMLSpanElement[] = [];
  const sceneTexts: HTMLSpanElement[] = [];
  for (let i = 0; i < SCENE_LINES; i++) {
    const row = node('div', STYLES.sceneLine, scenePanel);
    row.style.display = 'none';
    sceneMarks.push(node('span', STYLES.sceneMark, row));
    sceneTexts.push(node('span', '', row));
    sceneRows.push(row);
  }
  const caseLine = node('div', STYLES.caseLine, topLeft);
  caseLine.style.display = 'none';
  const duty = node('div', STYLES.dutyLine, topLeft);
  duty.style.display = 'none';
  const court = node('div', STYLES.courtLine, topLeft);
  court.style.display = 'none';
  const backupPanel = node('div', STYLES.backupPanel, topLeft);
  backupPanel.style.display = 'none';
  const backupRows: HTMLDivElement[] = [];
  for (let i = 0; i < BACKUP_HUD_LINES; i++) {
    const r = node('div', '', backupPanel);
    r.style.display = 'none';
    backupRows.push(r);
  }
  const command = node('div', STYLES.commandLine, topLeft);
  command.style.display = 'none';
  const pursuit = node('div', STYLES.pursuit, root);
  pursuit.style.display = 'none';
  const pursuit6 = node('div', STYLES.pursuit6, root);
  pursuit6.style.display = 'none';
  const pursuitVerdict = node('div', STYLES.pursuitVerdict, root);
  pursuitVerdict.style.display = 'none';

  const courseLine = node('div', STYLES.courseLine, root);
  courseLine.style.display = 'none';
  const orderLine = node('div', STYLES.orderLine, root);
  orderLine.style.display = 'none';

  const reticle = node('div', STYLES.reticle, root);
  for (const corner of CORNERS) node('div', `${STYLES.corner};${corner}`, reticle);
  reticle.style.display = 'none';
  const targetInfo = node('div', STYLES.targetInfo, root);
  targetInfo.style.display = 'none';
  const targetLabel = node('div', STYLES.targetLabel, targetInfo);
  const targetResult = node('div', STYLES.targetResult, targetInfo);
  targetResult.style.display = 'none';

  const topRight = node('div', STYLES.topRight, root);
  const clock = node('div', STYLES.clock, topRight);
  const weather = node('div', '', topRight);
  const location = node('div', STYLES.location, topRight);
  location.style.display = 'none';
  const trust = node('div', STYLES.trust, topRight);
  trust.style.display = 'none';

  const roadPanel = node('div', STYLES.bottomCentre, root);
  const road = node('span', STYLES.road, roadPanel);
  const sign = node('div', `${STYLES.sign};background:${SIGN_WHITE}`, roadPanel);
  const signCaption = node('span', STYLES.signCaption, sign, 'LIMIT');
  const signValue = node('span', STYLES.signValue, sign);
  const workTag = node('span', STYLES.workTag, roadPanel, 'WORK ZONE');
  workTag.style.display = 'none';

  const prompt = node('div', STYLES.prompt, root);
  prompt.style.display = 'none';
  const legal = node('div', STYLES.legalLine, root);
  legal.style.display = 'none';
  const gearLine = node('div', STYLES.gearLine, root);
  gearLine.style.display = 'none';
  // Last child, so it dims the other elements; opacity only, never animated.
  const vignette = node('div', STYLES.vignette, root);

  parent.appendChild(root);
  return {
    root, speedPanel, speed, gear, abs, fuelBar, fuel, engine, tyre, brakes, fuelLow, damage, status,
    clock, weather, roadPanel, road, sign, signCaption, signValue, workTag, prompt,
    police, unitRow, unit, unitEmergency, unitStatusCheck, carried, callPanel, callTitle, callAddress, callStatus,
    offer, reticle, targetInfo, targetLabel, targetResult,
    weapon, contact, scenePanel, sceneTitle, sceneRows, sceneMarks, sceneTexts, pursuit,
    tacticalRow, tactical, noise, visibility, bodycam, shift, caseLine, location,
    dash, forceChip, episode, legal, duty, court, trust,
    backupPanel, backupRows, pursuit6, pursuitVerdict, resourceEta, command, flirChip,
    oilChip, wornChip, altChip, fleetChip, gearLine,
    careerChip, coopChip, careerShift, courseLine, orderLine, vignette,
  };
}

function show(e: HTMLElement, visible: boolean, display = 'block'): void {
  e.style.display = visible ? display : 'none';
}

/**
 * Driving and world HUD: speed, gear, ABS, fuel and warnings bottom-right, clock and
 * weather top-right, road name and limit sign bottom-centre, and a prompt line. Phase 2
 * adds (when the optional snapshot fields are set) the police status line and the unit chip
 * and carried line above the speed panel, the call strip and offer line top-left, and the
 * target reticle with its plate/description and run result at the screen centre.
 * Elements are built once; `update` recomputes the text at most `updateHz` times per
 * second and writes only the fields that changed. Headless (no `document`) it keeps
 * the text model but touches no DOM.
 */
export class Hud {
  private readonly view: HudView | null;
  private readonly intervalMs: number;
  private readonly next = createHudText();
  private readonly shown = createHudText();
  private lastRender = -Infinity;
  private visible = true;
  private renderCount = 0;
  /** True until the first render, so every field is written once. */
  private dirty = true;
  /** The tactic verdict last seen and when it first appeared (it hides `PURSUIT_VERDICT_MS` later). */
  private verdictSeen = '';
  private verdictAtMs = 0;
  // Phase 8 inputs (set by the integrator's feed, merged into the text model at each throttled update).
  private career: Readonly<HudCareer> | null = null;
  private courseText = '';
  private coopText = '';
  private orderText = '';

  constructor(parent: HTMLElement, options: HudOptions = {}) {
    this.intervalMs = 1000 / Math.max(0.1, options.updateHz ?? 10);
    this.view = typeof document === 'undefined' ? null : buildView(parent);
  }

  /** Throttled renders so far (tests and diagnostics). */
  get renders(): number {
    return this.renderCount;
  }

  /** The text model as last rendered. */
  get text(): Readonly<HudText> {
    return this.shown;
  }

  update(snapshot: HudSnapshot, nowMs: number): void {
    if (!this.visible || nowMs - this.lastRender < this.intervalMs) return;
    this.lastRender = nowMs;
    this.renderCount += 1;
    hudText(snapshot, this.next);
    this.mergePhase8();
    this.expireVerdict(nowMs);
    this.apply();
  }

  /** Career wellbeing chip, shift line and vignette (null hides them). Applied at the next throttled update. */
  setCareer(c: Readonly<HudCareer> | null): void {
    this.career = c;
  }

  /** Driving course line (use `courseLine`); '' hides it. */
  setCourseLine(text: string): void {
    this.courseText = text;
  }

  /** Co-op chip (use `coopChip`); '' hides it. */
  setCoopChip(text: string): void {
    this.coopText = text;
  }

  /** Dispatcher order line (co-op); '' hides it. */
  setOrderLine(text: string): void {
    this.orderText = text;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.view) show(this.view.root, visible);
    if (visible) this.lastRender = -Infinity;
  }

  dispose(): void {
    this.view?.root.remove();
  }

  /** Copies the Phase 8 inputs into the next text model. */
  private mergePhase8(): void {
    const n = this.next;
    const c = this.career;
    const chip = c ? wellbeingChip(c.fatigue, c.stress) : null;
    n.careerChip = chip?.text ?? '';
    n.careerSeverity = chip?.severity ?? 'clear';
    n.careerShift = c?.shiftLine ?? '';
    n.vignette = c ? vignetteOpacity(c.vignette) : 0;
    n.courseLine = this.courseText;
    n.coopChip = this.coopText;
    n.orderLine = this.orderText;
  }

  /** Hides the pursuit verdict `PURSUIT_VERDICT_MS` after the text last changed. */
  private expireVerdict(nowMs: number): void {
    const v = this.next.pursuitVerdict;
    if (v !== this.verdictSeen) {
      this.verdictSeen = v;
      this.verdictAtMs = nowMs;
    }
    if (v !== '' && nowMs - this.verdictAtMs >= PURSUIT_VERDICT_MS) this.next.pursuitVerdict = '';
  }

  /** Copies `next` into `shown`, writing the DOM only where a field changed. */
  private apply(): void {
    const n = this.next;
    const o = this.shown;
    const v = this.view;
    const all = this.dirty;
    this.dirty = false;
    if (all || n.driving !== o.driving) {
      o.driving = n.driving;
      if (v) show(v.speedPanel, n.driving);
    }
    if (all || n.speed !== o.speed) {
      o.speed = n.speed;
      if (v) v.speed.textContent = n.speed;
    }
    if (all || n.gear !== o.gear) {
      o.gear = n.gear;
      if (v) v.gear.textContent = n.gear;
    }
    if (all || n.fuel !== o.fuel || n.battery !== o.battery) {
      o.fuel = n.fuel;
      o.battery = n.battery;
      if (v) {
        v.fuel.textContent = n.battery !== '' ? n.battery : n.fuel;
        v.fuelBar.style.width = n.fuel;
        v.fuelLow.textContent = n.battery !== '' ? 'BATT LOW' : 'FUEL LOW';
      }
    }
    if (all || n.fuelLow !== o.fuelLow) {
      o.fuelLow = n.fuelLow;
      if (v) {
        show(v.fuelLow, n.fuelLow, 'inline');
        v.fuelBar.style.background = n.fuelLow ? 'var(--c-p2)' : 'var(--c-ok)';
      }
    }
    if (all || n.abs !== o.abs) {
      o.abs = n.abs;
      if (v) show(v.abs, n.abs, 'inline');
    }
    if (all || n.engineWarn !== o.engineWarn) {
      o.engineWarn = n.engineWarn;
      if (v) show(v.engine, n.engineWarn, 'inline');
    }
    if (all || n.tyreWarn !== o.tyreWarn) {
      o.tyreWarn = n.tyreWarn;
      if (v) show(v.tyre, n.tyreWarn, 'inline');
    }
    if (all || n.brakesWarn !== o.brakesWarn) {
      o.brakesWarn = n.brakesWarn;
      if (v) show(v.brakes, n.brakesWarn, 'inline');
    }
    if (all || n.damage !== o.damage) {
      o.damage = n.damage;
      if (v) {
        v.damage.textContent = n.damage;
        show(v.damage, n.damage !== '', 'inline');
      }
    }
    if (all || n.status !== o.status) {
      o.status = n.status;
      if (v) v.status.textContent = n.status;
    }
    if (all || n.clock !== o.clock) {
      o.clock = n.clock;
      if (v) v.clock.textContent = n.clock;
    }
    if (all || n.weather !== o.weather) {
      o.weather = n.weather;
      if (v) v.weather.textContent = n.weather;
    }
    if (all || n.road !== o.road) {
      o.road = n.road;
      if (v) {
        v.road.textContent = n.road;
        show(v.roadPanel, n.road !== '', 'flex');
      }
    }
    if (all || n.showLimit !== o.showLimit) {
      o.showLimit = n.showLimit;
      if (v) show(v.sign, n.showLimit, 'flex');
    }
    if (all || n.limit !== o.limit) {
      o.limit = n.limit;
      if (v) v.signValue.textContent = n.limit;
    }
    if (all || n.schoolZone !== o.schoolZone) {
      o.schoolZone = n.schoolZone;
      if (v) {
        v.sign.style.background = n.schoolZone ? SIGN_YELLOW : SIGN_WHITE;
        v.signCaption.textContent = n.schoolZone ? 'SCHOOL' : 'LIMIT';
      }
    }
    if (all || n.construction !== o.construction) {
      o.construction = n.construction;
      if (v) show(v.workTag, n.construction, 'inline');
    }
    if (all || n.prompt !== o.prompt) {
      o.prompt = n.prompt;
      if (v) {
        v.prompt.textContent = n.prompt;
        show(v.prompt, n.prompt !== '');
      }
    }
    this.applyPolice(all);
    this.applyScene(all);
    this.applyTactical(all);
    this.applyLaw(all);
    this.applyPhase6(all);
    this.applyPhase7(all);
    this.applyPhase8(all);
  }

  /** Phase 2 fields (police line, unit chip, call strip, offer, target, carried). */
  private applyPolice(all: boolean): void {
    const n = this.next;
    const o = this.shown;
    const v = this.view;
    if (all || n.police !== o.police) {
      o.police = n.police;
      if (v) {
        v.police.textContent = n.police;
        show(v.police, n.police !== '');
      }
    }
    if (all || n.unit !== o.unit) {
      o.unit = n.unit;
      if (v) {
        v.unit.textContent = n.unit;
        show(v.unitRow, n.unit !== '', 'flex');
      }
    }
    if (all || n.unitEmergency !== o.unitEmergency) {
      o.unitEmergency = n.unitEmergency;
      if (v) show(v.unitEmergency, n.unitEmergency, 'inline');
    }
    if (all || n.unitStatusCheck !== o.unitStatusCheck) {
      o.unitStatusCheck = n.unitStatusCheck;
      if (v) show(v.unitStatusCheck, n.unitStatusCheck, 'inline');
    }
    if (all || n.callTitle !== o.callTitle) {
      o.callTitle = n.callTitle;
      if (v) {
        v.callTitle.textContent = n.callTitle;
        show(v.callPanel, n.callTitle !== '');
      }
    }
    if (all || n.callAddress !== o.callAddress) {
      o.callAddress = n.callAddress;
      if (v) v.callAddress.textContent = n.callAddress;
    }
    if (all || n.callStatus !== o.callStatus) {
      o.callStatus = n.callStatus;
      if (v) v.callStatus.textContent = n.callStatus;
    }
    if (all || n.callPriority !== o.callPriority) {
      o.callPriority = n.callPriority;
      if (v) v.callPanel.style.borderLeftColor = priorityColor(n.callPriority);
    }
    if (all || n.offer !== o.offer) {
      o.offer = n.offer;
      if (v) {
        v.offer.textContent = n.offer;
        show(v.offer, n.offer !== '');
      }
    }
    if (all || n.targetShow !== o.targetShow) {
      o.targetShow = n.targetShow;
      if (v) {
        show(v.reticle, n.targetShow);
        show(v.targetInfo, n.targetShow);
      }
    }
    if (all || n.targetLabel !== o.targetLabel) {
      o.targetLabel = n.targetLabel;
      if (v) v.targetLabel.textContent = n.targetLabel;
    }
    if (all || n.targetResult !== o.targetResult || n.targetSeverity !== o.targetSeverity) {
      o.targetResult = n.targetResult;
      o.targetSeverity = n.targetSeverity;
      if (v) {
        v.targetResult.textContent = n.targetResult === '' ? '' : `${SEVERITY_MARKS[n.targetSeverity]}${n.targetResult}`;
        v.targetResult.style.color = SEVERITY_COLORS[n.targetSeverity];
        show(v.targetResult, n.targetResult !== '');
      }
    }
    if (all || n.carried !== o.carried) {
      o.carried = n.carried;
      if (v) {
        v.carried.textContent = n.carried;
        show(v.carried, n.carried !== '');
      }
    }
  }

  /** Phase 3 fields (weapon and contact chips, objective box, pursuit line). */
  private applyScene(all: boolean): void {
    const n = this.next;
    const o = this.shown;
    const v = this.view;
    if (all || n.weapon !== o.weapon) {
      o.weapon = n.weapon;
      if (v) {
        v.weapon.textContent = n.weapon;
        show(v.weapon, n.weapon !== '', 'inline');
      }
    }
    if (all || n.contact !== o.contact) {
      o.contact = n.contact;
      if (v) {
        v.contact.textContent = n.contact;
        show(v.contact, n.contact !== '');
      }
    }
    if (all || n.sceneTitle !== o.sceneTitle) {
      o.sceneTitle = n.sceneTitle;
      if (v) {
        v.sceneTitle.textContent = n.sceneTitle;
        show(v.scenePanel, n.sceneTitle !== '');
      }
    }
    for (let i = 0; i < SCENE_LINES; i++) {
      const text = n.sceneLines[i] ?? '';
      const done = n.sceneDone[i] ?? false;
      if (!all && text === o.sceneLines[i] && done === o.sceneDone[i]) continue;
      o.sceneLines[i] = text;
      o.sceneDone[i] = done;
      const row = v?.sceneRows[i];
      const label = v?.sceneTexts[i];
      const mark = v?.sceneMarks[i];
      if (!row || !label || !mark) continue;
      label.textContent = text;
      label.style.textDecoration = done ? 'line-through' : 'none';
      label.style.opacity = done ? '0.6' : '1';
      mark.textContent = done ? '\u2713' : '\u2022';
      show(row, text !== '', 'flex');
    }
    if (all || n.pursuit !== o.pursuit) {
      o.pursuit = n.pursuit;
      if (v) {
        v.pursuit.textContent = n.pursuit;
        show(v.pursuit, n.pursuit !== '');
      }
    }
  }

  /** Phase 4 fields (stance chips and meters, bodycam chip, shift line, location chip, case line). */
  private applyTactical(all: boolean): void {
    const n = this.next;
    const o = this.shown;
    const v = this.view;
    if (all || n.tactical !== o.tactical) {
      o.tactical = n.tactical;
      if (v) {
        v.tactical.textContent = n.tactical;
        show(v.tactical, n.tactical !== '');
      }
    }
    if (all || n.noiseMeter !== o.noiseMeter || n.noise !== o.noise) {
      o.noiseMeter = n.noiseMeter;
      o.noise = n.noise;
      if (v) {
        v.noise.textContent = `NOISE ${n.noiseMeter}`;
        // Loud (4+ of 5 steps) turns amber.
        v.noise.style.color = n.noise >= NOISE_STEPS - 1 ? 'var(--c-p2)' : 'var(--fg-strong)';
        show(v.noise, n.noiseMeter !== '');
      }
    }
    if (all || n.visibility !== o.visibility) {
      o.visibility = n.visibility;
      if (v) {
        v.visibility.textContent = n.visibility;
        show(v.visibility, n.visibility !== '');
        show(v.tacticalRow, n.visibility !== '', 'flex');
      }
    }
    if (all || n.bodycam !== o.bodycam || n.bodycamRecording !== o.bodycamRecording || n.bodycamMuted !== o.bodycamMuted) {
      o.bodycam = n.bodycam;
      o.bodycamRecording = n.bodycamRecording;
      o.bodycamMuted = n.bodycamMuted;
      if (v) {
        v.bodycam.textContent = n.bodycam;
        v.bodycam.style.background = n.bodycamRecording ? 'var(--c-emergency)' : n.bodycamMuted ? 'var(--c-p2)' : 'var(--fg-dim)';
        show(v.bodycam, n.bodycam !== '', 'inline');
      }
    }
    if (all || n.shift !== o.shift) {
      o.shift = n.shift;
      if (v) {
        v.shift.textContent = n.shift;
        show(v.shift, n.shift !== '');
      }
    }
    if (all || n.location !== o.location) {
      o.location = n.location;
      if (v) {
        v.location.textContent = n.location;
        show(v.location, n.location !== '');
      }
    }
    if (all || n.caseLine !== o.caseLine) {
      o.caseLine = n.caseLine;
      if (v) {
        v.caseLine.textContent = n.caseLine;
        show(v.caseLine, n.caseLine !== '');
      }
    }
  }

  /** Phase 5 fields (force tool, dash and episode chips, legal line, duty, court, trust). */
  private applyLaw(all: boolean): void {
    const n = this.next;
    const o = this.shown;
    const v = this.view;
    if (all || n.dash !== o.dash) {
      o.dash = n.dash;
      if (v) {
        v.dash.textContent = n.dash;
        show(v.dash, n.dash !== '', 'inline');
      }
    }
    if (all || n.force !== o.force) {
      o.force = n.force;
      if (v) {
        v.forceChip.textContent = n.force;
        show(v.forceChip, n.force !== '', 'inline');
      }
    }
    if (all || n.episode !== o.episode) {
      o.episode = n.episode;
      if (v) {
        v.episode.textContent = n.episode === '' ? '' : `! ${n.episode}`;
        show(v.episode, n.episode !== '', 'inline');
      }
    }
    if (all || n.legal !== o.legal || n.legalSeverity !== o.legalSeverity) {
      o.legal = n.legal;
      o.legalSeverity = n.legalSeverity;
      if (v) {
        v.legal.textContent = n.legal === '' ? '' : `${LEGAL_MARKS[n.legalSeverity]}${n.legal}`;
        v.legal.style.borderLeftColor = LEGAL_COLORS[n.legalSeverity];
        show(v.legal, n.legal !== '');
      }
    }
    if (all || n.duty !== o.duty) {
      o.duty = n.duty;
      if (v) {
        v.duty.textContent = n.duty;
        show(v.duty, n.duty !== '');
      }
    }
    if (all || n.court !== o.court) {
      o.court = n.court;
      if (v) {
        v.court.textContent = n.court;
        show(v.court, n.court !== '');
      }
    }
    if (all || n.trust !== o.trust || n.trustBand !== o.trustBand) {
      o.trust = n.trust;
      o.trustBand = n.trustBand;
      if (v) {
        v.trust.textContent = n.trust === '' ? '' : `${TRUST_MARKS[n.trustBand]}${n.trust}`;
        v.trust.style.color = TRUST_COLORS[n.trustBand];
        show(v.trust, n.trust !== '');
      }
    }
  }
  /** Phase 6 fields (backup lines, pursuit line and verdict, resource ETA chip, command line, FLIR chip). */
  private applyPhase6(all: boolean): void {
    const n = this.next;
    const o = this.shown;
    const v = this.view;
    let anyBackup = false;
    let backupChanged = all;
    for (let i = 0; i < BACKUP_HUD_LINES; i++) {
      const text = n.backup[i] ?? '';
      if (text !== '') anyBackup = true;
      if (!all && text === o.backup[i]) continue;
      backupChanged = true;
      o.backup[i] = text;
      const row = v?.backupRows[i];
      if (!row) continue;
      row.textContent = text;
      show(row, text !== '');
    }
    if (v && backupChanged) show(v.backupPanel, anyBackup);
    if (all || n.pursuit6 !== o.pursuit6) {
      o.pursuit6 = n.pursuit6;
      if (v) {
        v.pursuit6.textContent = n.pursuit6;
        show(v.pursuit6, n.pursuit6 !== '');
      }
    }
    if (all || n.pursuitVerdict !== o.pursuitVerdict) {
      o.pursuitVerdict = n.pursuitVerdict;
      if (v) {
        v.pursuitVerdict.textContent = n.pursuitVerdict;
        show(v.pursuitVerdict, n.pursuitVerdict !== '');
      }
    }
    if (all || n.resourceEta !== o.resourceEta) {
      o.resourceEta = n.resourceEta;
      if (v) {
        v.resourceEta.textContent = n.resourceEta;
        show(v.resourceEta, n.resourceEta !== '', 'inline');
      }
    }
    if (all || n.command !== o.command) {
      o.command = n.command;
      if (v) {
        v.command.textContent = n.command;
        show(v.command, n.command !== '');
      }
    }
    if (all || n.flir !== o.flir) {
      o.flir = n.flir;
      if (v) show(v.flirChip, n.flir, 'inline');
    }
  }

  /** Phase 7 fields (wear and altitude chips, fleet chip, gear warning line). */
  private applyPhase7(all: boolean): void {
    const n = this.next;
    const o = this.shown;
    const v = this.view;
    if (all || n.oilLow !== o.oilLow) {
      o.oilLow = n.oilLow;
      if (v) show(v.oilChip, n.oilLow, 'inline');
    }
    if (all || n.tyresWorn !== o.tyresWorn) {
      o.tyresWorn = n.tyresWorn;
      if (v) show(v.wornChip, n.tyresWorn, 'inline');
    }
    if (all || n.altitude !== o.altitude) {
      o.altitude = n.altitude;
      if (v) {
        v.altChip.textContent = n.altitude;
        show(v.altChip, n.altitude !== '', 'inline');
      }
    }
    if (all || n.fleet !== o.fleet) {
      o.fleet = n.fleet;
      if (v) {
        v.fleetChip.textContent = n.fleet;
        show(v.fleetChip, n.fleet !== '', 'inline');
      }
    }
    if (all || n.gearWarning !== o.gearWarning) {
      o.gearWarning = n.gearWarning;
      if (v) {
        v.gearLine.textContent = n.gearWarning;
        show(v.gearLine, n.gearWarning !== '');
      }
    }
  }

  /** Phase 8 fields (wellbeing chip, career shift line, vignette, course line, co-op chip, order line). */
  private applyPhase8(all: boolean): void {
    const n = this.next;
    const o = this.shown;
    const v = this.view;
    if (all || n.careerChip !== o.careerChip || n.careerSeverity !== o.careerSeverity) {
      o.careerChip = n.careerChip;
      o.careerSeverity = n.careerSeverity;
      if (v) {
        v.careerChip.textContent = n.careerChip === '' ? '' : `${CHIP_MARKS[n.careerSeverity]}${n.careerChip}`;
        v.careerChip.style.background = n.careerSeverity === 'alert' ? 'var(--c-alert)' : 'var(--c-caution)';
        show(v.careerChip, n.careerChip !== '', 'inline');
      }
    }
    if (all || n.careerShift !== o.careerShift) {
      o.careerShift = n.careerShift;
      if (v) {
        v.careerShift.textContent = n.careerShift;
        show(v.careerShift, n.careerShift !== '');
      }
    }
    if (all || n.vignette !== o.vignette) {
      o.vignette = n.vignette;
      if (v) v.vignette.style.opacity = String(n.vignette);
    }
    if (all || n.courseLine !== o.courseLine) {
      o.courseLine = n.courseLine;
      if (v) {
        v.courseLine.textContent = n.courseLine;
        show(v.courseLine, n.courseLine !== '');
      }
    }
    if (all || n.coopChip !== o.coopChip) {
      o.coopChip = n.coopChip;
      if (v) {
        v.coopChip.textContent = n.coopChip;
        show(v.coopChip, n.coopChip !== '', 'inline');
      }
    }
    if (all || n.orderLine !== o.orderLine) {
      o.orderLine = n.orderLine;
      if (v) {
        v.orderLine.textContent = n.orderLine;
        show(v.orderLine, n.orderLine !== '');
      }
    }
  }
}
