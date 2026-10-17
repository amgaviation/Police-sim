import { statusLabel, statusText } from '../cad/codes';
import '../cad/events';
import type { CadCall, PlateReadback, RadioMode } from '../cad/types';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { LIGHTBAR_PATTERNS } from '../police/lightbar';
import { RACK_ITEMS, SIREN_TONES } from '../police/equipment';
import { TRUNK_ITEMS } from '../police/inventory';
import { channelDef } from '../radio/data';
import type { RadioControllerContext } from '../radio/controller';
import { formatClockTime } from '../records/calendar';
import { PERSON_POPULATION } from '../records/ids';
import { displayName, personIdentity } from '../records/person';
import type { CockpitState } from '../render/police/cockpitParts';
import type { MdtScreenModel } from '../render/police/mdtScreen';
import type { HudSnapshot } from '../ui/hud/hud';
import { MARKER, type MinimapMarkers } from '../ui/hud/minimap';
import type { HudCall, HudPolice, HudTarget, HudUnit, TargetSeverity } from '../ui/hud/police';
import type { GameSession } from './session';
import type { TargetInfo } from './target';

/** Markers the minimap draws at most (calls, AI units, the stop). */
export const MARKER_CAPACITY = 72;
/** How long an alert line stays on the in-car MDT screen (ms). */
const ALERT_MS = 20_000;

/** `CockpitState` with writable fields (one reused object). */
interface MutableCockpitState {
  sirenOn: boolean;
  tone: number;
  horn: boolean;
  lightsOn: boolean;
  pattern: number;
  spotOn: boolean;
  rackLocked: boolean;
  racked: boolean[];
  caged: boolean;
  radioChannel: string;
  radioTx: boolean;
  radioRx: boolean;
  scanning: boolean;
  emergency: boolean;
}

/** `RadioControllerContext` with writable fields (one reused object). */
interface MutableRadioContext {
  mode: RadioMode;
  hasTarget: boolean;
  hasStop: boolean;
  pendingOffer: boolean;
  onCall: boolean;
  emergency: boolean;
  offerCallId: number;
  fallbackPlate: string | null;
  fallbackVehicleId: number;
}

/** The latest plate run of a vehicle, for the HUD target line. */
export interface PlateRunView {
  readonly result: string;
  readonly severity: TargetSeverity;
}

/** HUD result line of a plate run: 'NO RECORD', the first hits, or 'CLEAR'. */
export function plateResultText(r: PlateReadback): string {
  if (!r.found) return 'NO RECORD';
  if (r.hits.length === 0) return 'CLEAR';
  return r.hits.length > 2 ? `${r.hits.slice(0, 2).join(' · ')} +${String(r.hits.length - 2)}` : r.hits.join(' · ');
}

/** 'SMITH, JOHN A' without touching the records snapshot (identity is a pure function of the id). */
export function personName(seed: number, personId: number): string {
  if (!Number.isInteger(personId) || personId < 0 || personId >= PERSON_POPULATION) return '';
  return displayName(personIdentity(seed, personId));
}

/** Carried line: 'Traffic cones ×2 · Patrol shotgun · Prisoner SMITH, JOHN A' ('' when nothing). */
export function carriedText(session: GameSession): string {
  const kit = session.officerKit;
  const parts: string[] = [];
  for (const item of TRUNK_ITEMS) {
    const n = kit.carried(item.id);
    if (n > 0) parts.push(n > 1 ? `${item.label} ×${String(n)}` : item.label);
  }
  const gun = kit.longGun;
  if (gun !== null) parts.push(RACK_ITEMS.find((r) => r.id === gun)?.label ?? gun);
  const prisoner = session.prisoner();
  if (prisoner >= 0) parts.push(`Prisoner ${personName(session.seed, prisoner)}`);
  return parts.join(' · ');
}

/** The call offered to `callsign`, null when none. */
export function offeredCall(session: GameSession, callsign: string): CadCall | null {
  for (const c of session.cad.calls()) if (c.status !== 'closed' && c.offeredTo === callsign) return c;
  return null;
}

/**
 * Presentation state of the patrol job for one session (design §13.3): the HUD's police, unit, call,
 * offer, target and carried lines, minimap markers, the in-car MDT screen model, the cockpit state and
 * the radio menu context. It listens to dispatcher results on the bus but never changes the simulation:
 * names come from pure identities, never from record lookups (which would touch the saved snapshot).
 */
export class PoliceFeed {
  private readonly session: GameSession;
  private readonly offs: (() => void)[] = [];
  private readonly plateRuns = new Map<number, PlateRunView>();
  private alertText: string | null = null;
  private alertUntilMs = 0;
  private alertPending: string | null = null;
  private readonly police: HudPolice = { lights: false, pattern: '', siren: '', horn: false, spot: false };
  private readonly unit: HudUnit = { callsign: '', status: '', emergency: false, statusCheck: false };
  private readonly call: HudCall = { number: '', priority: 4, nature: '', address: '', status: '', distanceM: -1 };
  private readonly target: HudTarget = { plate: '', description: '', result: '', severity: 'none' };
  private readonly cockpit: MutableCockpitState = {
    sirenOn: false,
    tone: 0,
    horn: false,
    lightsOn: false,
    pattern: 0,
    spotOn: false,
    rackLocked: true,
    racked: RACK_ITEMS.map(() => false),
    caged: false,
    radioChannel: '',
    radioTx: false,
    radioRx: false,
    scanning: false,
    emergency: false,
  };
  private readonly radioCtx: MutableRadioContext = {
    mode: 'tenCode',
    hasTarget: false,
    hasStop: false,
    pendingOffer: false,
    onCall: false,
    emergency: false,
    offerCallId: -1,
    fallbackPlate: null,
    fallbackVehicleId: -1,
  };
  private screen: MdtScreenModel | null = null;
  private screenRevision = -1;
  private screenMinute = -1;
  private screenAlert: string | null = null;
  /** The stop the screen model was built for (primitives: no per-frame key string). */
  private screenStopActive = false;
  private screenStopPlate = '';
  private screenStopDriver = -1;
  private screenStopCitations = -1;

  constructor(session: GameSession, bus: EventBus<EventMap>) {
    this.session = session;
    const player = session.dispatcher.playerCallsign;
    // Whether a status check is pending is the dispatcher's (saved) state; a loaded game shows it again.
    if (session.dispatcher.statusCheckPending) this.alertPending = 'STATUS CHECK';
    this.offs.push(
      bus.on('dispatch:plateResult', (e) => {
        if (e.callsign !== player) return;
        const r = e.readback;
        const severity: TargetSeverity = r.severity;
        if (e.vehicleId >= 0) this.plateRuns.set(e.vehicleId, { result: plateResultText(r), severity });
        if (severity === 'alert') this.alertPending = `HIT ${r.plate}: ${r.hits[0] ?? 'see MDT'}`;
      }),
      bus.on('dispatch:statusCheck', (e) => {
        if (e.callsign !== player) return;
        this.alertPending = e.escalated ? 'STATUS CHECK - UNITS SENT' : 'STATUS CHECK';
      }),
      bus.on('dispatch:personResult', (e) => {
        if (e.callsign === player && e.readback.severity === 'alert') this.alertPending = `WANTS ${e.readback.name}: ${e.readback.hits[0] ?? ''}`;
      }),
    );
  }

  /** Latest plate run of `vehicleId` (any via), null when not run this session. */
  plateRun(vehicleId: number): PlateRunView | null {
    return this.plateRuns.get(vehicleId) ?? null;
  }

  /** A status check is waiting for the player's answer. */
  get statusCheck(): boolean {
    return this.session.dispatcher.statusCheckPending;
  }

  /**
   * Fills the Phase 2 HUD fields (call at the HUD rate): the driven patrol car's equipment, the
   * player's unit, call and offer, the target and what the officer carries. `menuKey` labels the
   * radio menu key in the offer line.
   */
  fillHud(s: HudSnapshot, target: TargetInfo | null, menuKey: string, nowMs: number): void {
    const session = this.session;
    const cad = session.cad;
    const player = session.dispatcher.playerCallsign;
    this.promoteAlert(nowMs);

    const driven = session.drivenVehicle;
    const eq = session.drivenEquipment;
    if (driven && eq) {
      const p = this.police;
      p.lights = driven.lightbar;
      p.pattern = LIGHTBAR_PATTERNS[eq.pattern]?.id ?? '';
      p.siren = eq.sirenOn ? eq.tone : '';
      p.horn = eq.horn;
      p.spot = eq.spotOn;
      s.police = p;
    } else {
      s.police = null;
    }

    const pu = cad.unit(player);
    if (pu) {
      const u = this.unit;
      u.callsign = pu.callsign;
      u.status = statusLabel(pu.status);
      u.emergency = pu.emergency;
      u.statusCheck = session.dispatcher.statusCheckPending;
      s.unit = u;
    } else {
      s.unit = null;
    }

    const call = pu && pu.callId !== null ? cad.call(pu.callId) : null;
    if (call && call.status !== 'closed' && pu) {
      const c = this.call;
      c.number = call.number;
      c.priority = call.priority;
      c.nature = call.nature;
      c.address = call.location.text;
      c.status = statusText(pu.status, 'plain');
      const at = session.playerUnit;
      c.distanceM = Math.hypot(call.location.x - at.x, call.location.z - at.z);
      s.call = c;
    } else {
      s.call = null;
    }

    const offer = offeredCall(session, player);
    s.offer = offer ? `OFFER ${offer.number} P${String(offer.priority)} ${offer.nature} · ${menuKey} 7 accept · ${menuKey} 8 decline` : null;

    if (target) {
      const t = this.target;
      t.plate = target.plate;
      t.description = target.description;
      const run = this.plateRuns.get(target.vehicleId);
      t.result = run?.result ?? '';
      t.severity = run?.severity ?? 'none';
      s.target = t;
    } else {
      s.target = null;
    }
    s.carried = carriedText(session);
  }

  /** Minimap markers: open calls (by priority), AI units (by status), the traffic stop. */
  fillMarkers(m: MinimapMarkers): MinimapMarkers {
    const cad = this.session.cad;
    const cap = m.x.length;
    let n = 0;
    const calls = cad.calls();
    for (let i = 0; i < calls.length && n < cap; i++) {
      const c = calls[i] as CadCall;
      if (c.status === 'closed') continue;
      m.x[n] = c.location.x;
      m.z[n] = c.location.z;
      m.kind[n] = c.priority === 1 ? MARKER.callP1 : c.priority === 2 ? MARKER.callP2 : c.priority === 3 ? MARKER.callP3 : MARKER.callP4;
      n++;
    }
    const units = cad.units();
    for (let i = 0; i < units.length && n < cap; i++) {
      const u = units[i];
      if (!u || u.kind !== 'ai') continue;
      m.x[n] = u.x;
      m.z[n] = u.z;
      m.kind[n] = u.emergency ? MARKER.unitEmergency : u.status === 'available' ? MARKER.unitAvailable : MARKER.unitBusy;
      n++;
    }
    const stop = cad.trafficStop;
    if (stop && stop.outcome === 'active' && n < cap) {
      m.x[n] = stop.x;
      m.z[n] = stop.z;
      m.kind[n] = MARKER.stop;
      n++;
    }
    m.count = n;
    return m;
  }

  /**
   * The in-car laptop screen (design §12): rebuilt only when the CAD revision, the clock minute, the
   * alert or the stop changed, so a caller may ask every frame.
   */
  screenModel(nowMs: number): MdtScreenModel {
    const session = this.session;
    const cad = session.cad;
    this.promoteAlert(nowMs);
    const game = session.env.time.totalSeconds;
    const minute = Math.floor(game / 60);
    const stop = cad.trafficStop;
    const active = stop !== null && stop.outcome === 'active';
    const plate = active ? stop.plate : '';
    const driver = active ? stop.driverId : -1;
    const citations = active ? stop.citations.length : -1;
    if (
      this.screen &&
      this.screenRevision === cad.revision &&
      this.screenMinute === minute &&
      this.screenAlert === this.alertText &&
      this.screenStopActive === active &&
      this.screenStopPlate === plate &&
      this.screenStopDriver === driver &&
      this.screenStopCitations === citations
    ) {
      return this.screen;
    }
    this.screenRevision = cad.revision;
    this.screenMinute = minute;
    this.screenAlert = this.alertText;
    this.screenStopActive = active;
    this.screenStopPlate = plate;
    this.screenStopDriver = driver;
    this.screenStopCitations = citations;
    const player = session.dispatcher.playerCallsign;
    const pu = cad.unit(player);
    const own = pu && pu.callId !== null ? cad.call(pu.callId) : null;
    const queue: { priority: number; nature: string; address: string }[] = [];
    for (const c of cad.openCalls()) {
      if (c === own) continue;
      queue.push({ priority: c.priority, nature: c.nature, address: c.location.text });
      if (queue.length >= 4) break;
    }
    const offer = offeredCall(session, player);
    this.screen = {
      callsign: player,
      status: pu ? statusLabel(pu.status) : '',
      clock: formatClockTime(game),
      call:
        own && own.status !== 'closed'
          ? { number: own.number, priority: own.priority, nature: own.nature, address: own.location.text, status: own.status.toUpperCase() }
          : null,
      queue,
      offer: offer ? `OFFER ${offer.number} P${String(offer.priority)} ${offer.nature}` : null,
      alert: this.alertText,
      stop:
        stop && stop.outcome === 'active'
          ? `STOP ${stop.plate}${stop.driverId >= 0 ? ` · ${personName(session.seed, stop.driverId)}` : ''}${stop.citations.length > 0 ? ` · ${String(stop.citations.length)} cited` : ''}`
          : null,
    };
    return this.screen;
  }

  /** Cockpit LEDs, rack, cage and radio head of the driven patrol car (one reused object; `refresh` false returns it as is). */
  cockpitState(refresh = true): CockpitState {
    const s = this.cockpit;
    if (!refresh) return s;
    const session = this.session;
    const eq = session.drivenEquipment;
    const radio = session.radio;
    if (eq) {
      s.sirenOn = eq.sirenOn;
      s.tone = Math.max(0, SIREN_TONES.indexOf(eq.tone));
      s.horn = eq.horn;
      s.lightsOn = session.drivenVehicle?.lightbar ?? false;
      s.pattern = eq.pattern;
      s.spotOn = eq.spotOn;
      s.rackLocked = eq.rackLocked;
      for (let i = 0; i < RACK_ITEMS.length; i++) s.racked[i] = eq.rackHas((RACK_ITEMS[i] as { id: string }).id);
      s.caged = eq.prisoner >= 0;
    }
    s.radioChannel = channelDef(radio.selected).short;
    s.radioTx = radio.transmitting;
    s.radioRx = this.receiving();
    s.scanning = radio.scanning;
    s.emergency = session.cad.unit(session.dispatcher.playerCallsign)?.emergency ?? false;
    return s;
  }

  /** An audible transmission from someone else is on the air. */
  receiving(): boolean {
    for (const tx of this.session.radio.onAir) if (tx.audible && tx.speakerKind !== 'player') return true;
    return false;
  }

  /** The radio menu / voice context of this frame (one reused object): target or stop plate, offer, call, emergency. */
  radioContext(mode: RadioMode, target: TargetInfo | null): RadioControllerContext {
    const session = this.session;
    const cad = session.cad;
    const player = session.dispatcher.playerCallsign;
    const c = this.radioCtx;
    const stop = cad.trafficStop;
    const activeStop = stop !== null && stop.outcome === 'active';
    const pu = cad.unit(player);
    c.mode = mode;
    c.hasStop = activeStop;
    c.hasTarget = target !== null || activeStop;
    c.onCall = pu !== null && pu.callId !== null;
    c.emergency = pu?.emergency ?? false;
    const offer = offeredCall(session, player);
    c.pendingOffer = offer !== null;
    c.offerCallId = offer?.id ?? -1;
    if (target) {
      c.fallbackPlate = target.plate;
      c.fallbackVehicleId = target.vehicleId;
    } else if (stop && activeStop) {
      c.fallbackPlate = stop.plate;
      c.fallbackVehicleId = stop.vehicleId;
    } else {
      c.fallbackPlate = null;
      c.fallbackVehicleId = -1;
    }
    return c;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.plateRuns.clear();
  }

  /** Alerts arrive in the fixed step; they are timed against the frame clock when first shown. */
  private promoteAlert(nowMs: number): void {
    if (this.alertPending !== null) {
      this.alertText = this.alertPending;
      this.alertUntilMs = nowMs + ALERT_MS;
      this.alertPending = null;
    } else if (this.alertText !== null && nowMs >= this.alertUntilMs) {
      this.alertText = null;
    }
  }
}
