import { formatClock, type GameTime } from '../../environment/time';
import type { WeatherState } from '../../environment/weather';
import type { VehicleTelemetry } from '../../vehicles/drivableVehicle';
import { formatFuel, formatGear, formatSpeedMph, limitSignText } from './format';
import {
  SEVERITY_COLORS,
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

/** Everything the HUD shows; the integrator may reuse one object per frame. */
export interface HudSnapshot {
  mode: 'onFoot' | 'driving';
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
  /** The officer's drawn weapon (chip 'SIDEARM' / 'TASER'). */
  officer?: Readonly<HudOfficer> | null;
  /** The person in contact (chip 'Name · state · 4 m'). */
  contact?: Readonly<HudContact> | null;
  /** The call scene: title and up to four objectives (done ones struck through). */
  scene?: Readonly<HudScene> | null;
  /** Pursuit line (red), e.g. 'PURSUIT  Foot  suspect fleeing north'; null hides it. */
  pursuit?: string | null;
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
  /** Weapon chip ('SIDEARM' / 'TASER'); '' hides it. */
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
  const t = s.mode === 'driving' ? s.telemetry : null;
  out.driving = t !== null;
  out.speed = t ? formatSpeedMph(t.speedMph) : '';
  out.gear = t ? formatGear(t.gear) : '';
  out.abs = t ? t.absActive : false;
  out.fuel = t ? formatFuel(t.fuelFraction) : '';
  out.fuelLow = t ? t.fuelFraction < FUEL_LOW_FRACTION : false;
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
  out.weapon = weaponChipText(s.officer);
  out.contact = contactChipText(s.contact);
  const scene = sceneText(s.scene, SCENE_SCRATCH);
  out.sceneTitle = scene.title;
  for (let i = 0; i < SCENE_LINES; i++) {
    out.sceneLines[i] = scene.lines[i] ?? '';
    out.sceneDone[i] = scene.done[i] ?? false;
  }
  out.pursuit = s.pursuit ?? '';
  return out;
}

// --- DOM ---------------------------------------------------------------------------

// Sizes scale with the accessibility text size (--text-scale on <html>).
const px = (n: number): string => `calc(${String(n)}px * var(--text-scale, 1))`;

const ROOT_STYLE = [
  'position:absolute',
  'inset:0',
  'z-index:900',
  'pointer-events:none',
  'color:#f2f2f2',
  'font-family:ui-sans-serif, system-ui, sans-serif',
  'text-shadow:0 1px 2px rgba(0,0,0,0.8)',
  'user-select:none',
].join(';');

const PANEL = 'position:absolute;background:rgba(0,0,0,0.5);border-radius:6px;padding:6px 10px';

const STYLES = {
  bottomRight: 'position:absolute;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:6px',
  speedPanel: `${PANEL};position:relative;min-width:${px(150)};text-align:right`,
  speed: `font:700 ${px(44)}/1 ui-monospace, Menlo, Consolas, monospace`,
  unit: `font-size:${px(13)};opacity:0.8;margin-left:4px`,
  row: `display:flex;justify-content:flex-end;gap:8px;align-items:center;margin-top:4px;font-size:${px(13)}`,
  gear: `font:700 ${px(18)}/1 ui-monospace, Menlo, Consolas, monospace`,
  chip: `padding:1px 5px;border-radius:3px;font-weight:700;font-size:${px(11)}`,
  fuelTrack: `width:${px(90)};height:${px(6)};background:rgba(255,255,255,0.2);border-radius:3px;overflow:hidden`,
  fuelBar: 'height:100%;width:0;background:#7ed37e',
  fuelText: `font-size:${px(12)};min-width:${px(34)}`,
  warnings: 'display:flex;justify-content:flex-end;gap:4px;margin-top:4px',
  status: `font-size:${px(11)};opacity:0.75;margin-top:4px;letter-spacing:0.05em`,
  topRight: `${PANEL};right:16px;top:16px;text-align:right;font-size:${px(14)}`,
  clock: `font:700 ${px(18)}/1.2 ui-monospace, Menlo, Consolas, monospace`,
  bottomCentre: `${PANEL};left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:10px`,
  road: `font-size:${px(16)};font-weight:600;white-space:nowrap`,
  sign: `display:flex;flex-direction:column;align-items:center;min-width:${px(40)};padding:2px 4px;border:2px solid #111;border-radius:4px;color:#111;text-shadow:none;line-height:1`,
  signCaption: `font-size:${px(8)};font-weight:700`,
  signValue: `font:700 ${px(20)}/1 ui-sans-serif, system-ui, sans-serif`,
  workTag: `padding:2px 6px;border-radius:3px;background:#f08a24;color:#111;text-shadow:none;font-weight:700;font-size:${px(11)}`,
  prompt: `position:absolute;left:50%;bottom:${px(84)};transform:translateX(-50%);padding:4px 10px;border-radius:4px;background:rgba(0,0,0,0.55);font-size:${px(15)}`,
  police: `font-size:${px(12)};font-weight:700;color:#9fd0ff;margin-top:3px;letter-spacing:0.05em`,
  unitRow: `${PANEL};position:relative;display:flex;gap:6px;align-items:center;padding:4px 8px;font-size:${px(13)};font-weight:700`,
  carried: `${PANEL};position:relative;padding:3px 8px;font-size:${px(12)};opacity:0.9`,
  topLeft: `position:absolute;left:16px;top:16px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;max-width:${px(380)}`,
  callPanel: `${PANEL};position:relative;border-left:4px solid #9a9a9a;font-size:${px(13)}`,
  callTitle: `font-weight:700;font-size:${px(15)};white-space:nowrap`,
  callStatus: `font-size:${px(12)};opacity:0.85;letter-spacing:0.05em`,
  offer: `${PANEL};position:relative;background:rgba(80,56,0,0.7);color:#ffd27a;font-weight:700;font-size:${px(13)}`,
  reticle: `position:absolute;left:50%;top:50%;width:${px(90)};height:${px(56)};transform:translate(-50%,-50%)`,
  corner: `position:absolute;width:${px(14)};height:${px(14)};border:0 solid rgba(255,255,255,0.9)`,
  targetInfo: `position:absolute;left:50%;top:calc(50% + ${px(36)});transform:translateX(-50%);text-align:center;white-space:nowrap`,
  targetLabel: `${PANEL};position:relative;display:inline-block;padding:2px 8px;font:700 ${px(14)}/1.3 ui-monospace, Menlo, Consolas, monospace`,
  targetResult: `margin-top:4px;font-weight:700;font-size:${px(13)}`,
  chipRow: 'display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap',
  contact: `${PANEL};position:relative;padding:3px 8px;font-size:${px(13)};font-weight:600`,
  scenePanel: `${PANEL};position:relative;border-left:4px solid #3b9eff;font-size:${px(13)}`,
  sceneTitle: `font-weight:700;font-size:${px(14)};white-space:nowrap`,
  sceneLine: 'display:flex;gap:6px;align-items:baseline',
  sceneMark: `font-weight:700;min-width:${px(12)}`,
  pursuit: `${PANEL};left:50%;top:16px;transform:translateX(-50%);background:rgba(120,10,10,0.8);color:#ffd9d9;font-weight:700;font-size:${px(15)};letter-spacing:0.05em;white-space:nowrap`,
} as const;

/** Corner bracket borders of the target reticle (top-left, top-right, bottom-left, bottom-right). */
const CORNERS = [
  'left:0;top:0;border-left-width:2px;border-top-width:2px',
  'right:0;top:0;border-right-width:2px;border-top-width:2px',
  'left:0;bottom:0;border-left-width:2px;border-bottom-width:2px',
  'right:0;bottom:0;border-right-width:2px;border-bottom-width:2px',
] as const;

const SIGN_WHITE = '#f4f4f4';
const SIGN_YELLOW = '#f5d63d';

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
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, style: string, parent: HTMLElement | null, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.setAttribute('style', style);
  if (text !== '') e.textContent = text;
  parent?.appendChild(e);
  return e;
}

function chip(text: string, background: string, parent: HTMLElement): HTMLSpanElement {
  const e = node('span', `${STYLES.chip};background:${background};color:#111;text-shadow:none`, parent, text);
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
  const weapon = chip('', '#ff9a3c', chipRow);
  const carried = node('div', STYLES.carried, bottomRight);
  carried.style.display = 'none';
  const unitRow = node('div', STYLES.unitRow, bottomRight);
  unitRow.style.display = 'none';
  const unit = node('span', '', unitRow);
  const unitEmergency = chip('EMERGENCY', '#ff4d4d', unitRow);
  const unitStatusCheck = chip('STATUS CHECK', '#f2c14e', unitRow);
  const speedPanel = node('div', STYLES.speedPanel, bottomRight);
  const speedLine = node('div', '', speedPanel);
  const speed = node('span', STYLES.speed, speedLine, '0');
  node('span', STYLES.unit, speedLine, 'mph');
  const row = node('div', STYLES.row, speedPanel);
  const abs = chip('ABS', '#f5c542', row);
  const fuelTrack = node('div', STYLES.fuelTrack, row);
  const fuelBar = node('div', STYLES.fuelBar, fuelTrack);
  const fuel = node('span', STYLES.fuelText, row);
  const gear = node('span', STYLES.gear, row, 'N');
  const warnings = node('div', STYLES.warnings, speedPanel);
  const engine = chip('ENGINE', '#ff6b4a', warnings);
  const tyre = chip('TYRE', '#ff6b4a', warnings);
  const brakes = chip('BRAKES HOT', '#ffa34a', warnings);
  const fuelLow = chip('FUEL LOW', '#ffa34a', warnings);
  const damage = chip('', '#d9d9d9', warnings);
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
  const pursuit = node('div', STYLES.pursuit, root);
  pursuit.style.display = 'none';

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

  const roadPanel = node('div', STYLES.bottomCentre, root);
  const road = node('span', STYLES.road, roadPanel);
  const sign = node('div', `${STYLES.sign};background:${SIGN_WHITE}`, roadPanel);
  const signCaption = node('span', STYLES.signCaption, sign, 'LIMIT');
  const signValue = node('span', STYLES.signValue, sign);
  const workTag = node('span', STYLES.workTag, roadPanel, 'WORK ZONE');
  workTag.style.display = 'none';

  const prompt = node('div', STYLES.prompt, root);
  prompt.style.display = 'none';

  parent.appendChild(root);
  return {
    root, speedPanel, speed, gear, abs, fuelBar, fuel, engine, tyre, brakes, fuelLow, damage, status,
    clock, weather, roadPanel, road, sign, signCaption, signValue, workTag, prompt,
    police, unitRow, unit, unitEmergency, unitStatusCheck, carried, callPanel, callTitle, callAddress, callStatus,
    offer, reticle, targetInfo, targetLabel, targetResult,
    weapon, contact, scenePanel, sceneTitle, sceneRows, sceneMarks, sceneTexts, pursuit,
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
    this.apply();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.view) show(this.view.root, visible);
    if (visible) this.lastRender = -Infinity;
  }

  dispose(): void {
    this.view?.root.remove();
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
    if (all || n.fuel !== o.fuel) {
      o.fuel = n.fuel;
      if (v) {
        v.fuel.textContent = n.fuel;
        v.fuelBar.style.width = n.fuel;
      }
    }
    if (all || n.fuelLow !== o.fuelLow) {
      o.fuelLow = n.fuelLow;
      if (v) {
        show(v.fuelLow, n.fuelLow, 'inline');
        v.fuelBar.style.background = n.fuelLow ? '#ffa34a' : '#7ed37e';
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
    if (all || n.targetResult !== o.targetResult) {
      o.targetResult = n.targetResult;
      if (v) {
        v.targetResult.textContent = n.targetResult;
        show(v.targetResult, n.targetResult !== '');
      }
    }
    if (all || n.targetSeverity !== o.targetSeverity) {
      o.targetSeverity = n.targetSeverity;
      if (v) v.targetResult.style.color = SEVERITY_COLORS[n.targetSeverity];
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
}
