/**
 * Presentation of Phase 4 (design §13, §15, §20.4): the interior meshes and pooled lights, the flashlight, the fade,
 * the first-person camera, the tactical inputs, the briefing screen, the viewfinder, the case file and dusting panels,
 * evidence marker labels, thumbnails and the HUD additions. It changes the simulation only through request queues.
 */
import * as THREE from 'three';
import { crimeWeight, CRIME_CATEGORIES } from '../environment/crime';
import type { EnvironmentRenderer } from '../environment/render/environmentRenderer';
import type { InputManager } from '../input/input';
import type { CameraRig } from '../player/cameraRig';
import { epochDayOfGameSeconds } from '../records/calendar';
import { buildBriefing } from '../station';
import { InteriorLightPool, InteriorRenderer } from '../render/interior';
import { FlashlightRig } from '../render/tactical';
import type { Renderer } from '../render/renderer';
import { BriefingScreen } from '../ui/station';
import { CameraOverlay, CaseFilePanel, FingerprintPanel, MarkerLabels, type MarkerLabel } from '../ui/investigation';
import { FadeOverlay } from '../ui/hud';
import type { HudSnapshot } from '../ui/hud/hud';
import type { HudBodycam, HudLocation, HudTactical } from '../ui/hud/types';
import type { UIRoot } from '../ui/ui';
import { DISTRICT_NAMES } from '../world/ids';
import { PLAYER_SIZE, type GameSession } from './session';
import { buildingLabel } from './stationPanels';

/** Evidence marker labels are projected at this interval (ms; 10 Hz). */
const LABEL_INTERVAL_MS = 100;
/** Markers within this distance (m) get a number label. */
const LABEL_RANGE_M = 8;
const THUMB_W = 160;
const THUMB_H = 90;
const THUMB_QUALITY = 0.6;
/** Case file panel refresh and dust panel refresh intervals (ms). */
const PANEL_INTERVAL_MS = 100;

const scratchEye = { x: 0, y: 0, z: 0, roll: 0 };
const scratchV = new THREE.Vector3();
const scratchCamera = new THREE.PerspectiveCamera();

/** What the presenter needs from the app. */
export interface Phase4Host {
  session(): GameSession | null;
  /** One-off HUD line. */
  flash(text: string): void;
  /** Camera vertical field of view of the game settings (restored when the viewfinder closes). */
  baseFov(): number;
}

export class Phase4Presenter {
  readonly briefing: BriefingScreen;
  readonly camera: CameraOverlay;
  readonly caseFile: CaseFilePanel;
  readonly dust: FingerprintPanel;
  readonly fade: FadeOverlay;
  readonly labels: MarkerLabels;
  interiorRenderer: InteriorRenderer | null;
  lightPool: InteriorLightPool | null;
  flashlight: FlashlightRig | null;

  private readonly host: Phase4Host;
  private readonly scene: THREE.Scene | null;
  private readonly renderer: Renderer | null;
  private readonly env: EnvironmentRenderer | null;
  private readonly hudTactical: HudTactical = { crouched: false, lean: 0, flashlight: false, noise: 0, visibility: 0, slicing: false };
  private readonly hudBodycam: HudBodycam = { recording: false };
  private readonly hudLocation: HudLocation = { building: '', room: '' };
  private readonly markerBuf: { no: number; x: number; y: number; z: number }[] = [];
  private toggleFirstPerson = false;
  private nextLabelMs = 0;
  private nextPanelMs = 0;
  private caseRevision = -1;
  private caseCall = -1;
  private thumbCanvas: HTMLCanvasElement | null = null;
  private lastFade = 0;

  constructor(scene: THREE.Scene | null, renderer: Renderer | null, env: EnvironmentRenderer | null, ui: UIRoot, hudParent: HTMLElement, host: Phase4Host) {
    this.host = host;
    this.scene = scene;
    this.renderer = renderer;
    this.env = env;
    this.briefing = new BriefingScreen(ui);
    this.camera = new CameraOverlay(ui);
    this.caseFile = new CaseFilePanel(ui);
    this.dust = new FingerprintPanel(ui);
    this.fade = new FadeOverlay(hudParent);
    this.labels = new MarkerLabels(hudParent);
    this.interiorRenderer = scene ? new InteriorRenderer(scene) : null;
    this.lightPool = scene ? new InteriorLightPool(scene) : null;
    this.flashlight = scene ? new FlashlightRig(scene) : null;
  }

  dispose(): void {
    this.closePanels();
    this.briefing.dispose();
    this.fade.dispose();
    this.labels.dispose();
    this.interiorRenderer?.dispose();
    this.lightPool?.dispose();
    this.flashlight?.dispose();
  }

  /** Per-session reset (the interior meshes and lights are rebuilt: they cache by the previous session's revisions). */
  begin(): void {
    this.interiorRenderer?.dispose();
    this.lightPool?.dispose();
    this.interiorRenderer = this.scene ? new InteriorRenderer(this.scene) : null;
    this.lightPool = this.scene ? new InteriorLightPool(this.scene) : null;
    this.toggleFirstPerson = false;
    this.caseRevision = -1;
    this.caseCall = -1;
    this.nextLabelMs = 0;
  }

  /** Session end: panels closed, lights off, the fade cleared. */
  end(): void {
    this.closePanels();
    this.fade.set(0);
    this.labels.update([]);
    this.env?.setIndoor(false);
    this.flashlight?.update(false, scratchCamera);
    this.interiorRenderer?.dispose();
    this.lightPool?.dispose();
    this.interiorRenderer = null;
    this.lightPool = null;
  }

  private closePanels(): void {
    this.briefing.close();
    this.camera.close();
    this.caseFile.close();
    this.dust.close();
    this.restoreFov();
  }

  // --- Input ------------------------------------------------------------------------------

  /** V on foot: the first-person camera outdoors as well. */
  toggleView(): void {
    this.toggleFirstPerson = !this.toggleFirstPerson;
  }

  /** The camera sits at the officer's eyes: indoors, or the V toggle on foot. */
  firstPerson(session: GameSession): boolean {
    return !session.driving && (session.officerBuilding >= 0 || this.toggleFirstPerson);
  }

  /**
   * Per frame: the held lean / slice inputs (zero while a menu is up or in a car) and the presses of the Phase 4 actions
   * (on foot, except the bodycam). `openTools` / `openPartner` open the panels.
   */
  updateInput(session: GameSession, input: InputManager, active: boolean, openTools: () => void, openPartner: () => void): void {
    const onFoot = !session.driving;
    let lean: -1 | 0 | 1 = 0;
    let slice = false;
    if (active && onFoot) {
      if (input.isDown('officer.leanLeft')) lean = -1;
      if (input.isDown('officer.leanRight')) lean = lean === -1 ? 0 : 1;
      slice = input.isDown('officer.slice');
    }
    session.tactical.setHeld(lean, slice);
    if (!active) return;
    if (input.wasPressed('officer.bodycam')) this.toggleBodycam(session);
    if (!onFoot) return;
    if (input.wasPressed('officer.crouch')) session.tactical.request({ kind: 'crouch' });
    if (input.wasPressed('officer.flashlight')) session.tactical.request({ kind: 'flashlight' });
    if (input.wasPressed('investigate.menu')) openTools();
    if (input.wasPressed('camera.photo')) this.openCamera(session);
    if (input.wasPressed('partner.menu')) openPartner();
  }

  toggleBodycam(session: GameSession): void {
    if (session.station.loadout.bodycamMount === 'none') {
      this.host.flash('No bodycam mount chosen at the locker');
      return;
    }
    session.investigation.request({ kind: 'bodycam', on: !session.investigation.bodycamOn });
  }

  // --- Panels -------------------------------------------------------------------------------

  /** The roll-call sheet (the podium); closing it completes the `briefing` step. */
  openBriefing(session: GameSession): void {
    const at = session.playerPosition({ x: 0, z: 0 });
    const t = session.env.time;
    const district = DISTRICT_NAMES[session.city.districtAt(at.x, at.z)] ?? 'downtown';
    const unit = session.cad.unit(session.dispatcher.playerCallsign);
    const view = buildBriefing({
      seed: session.seed,
      gameSeconds: t.totalSeconds,
      officer: session.officer,
      unit: { callsign: unit?.callsign ?? session.dispatcher.playerCallsign, beat: unit?.beat ?? district },
      district,
      bolos: session.records.bolos(epochDayOfGameSeconds(t.totalSeconds)),
      openCalls: session.cad.openCalls().map((c) => ({ number: c.number, label: c.nature, priority: c.priority, location: c.location.text })),
      roster: session.cad.units().map((u) => ({ callsign: u.callsign, beat: u.beat, status: u.status })),
      crime: CRIME_CATEGORIES.map((category) => ({ category, weight: crimeWeight(category, t.hour, t.weekday, district) })),
    });
    this.briefing.open(view, () => session.station.request({ kind: 'complete', step: 'briefing' }));
  }

  /** The evidence camera: a viewfinder with a zoomable field of view; the shutter queues a `photo` request. */
  openCamera(session: GameSession): void {
    if (this.camera.isOpen) return;
    if (session.investigation.toolsModel().options[1]?.enabled === false) {
      this.host.flash('You need the evidence camera');
      return;
    }
    const info = this.cameraInfo(session);
    this.camera.open(
      info,
      {
        shutter: (fovDeg) => session.investigation.request({ kind: 'photo', fovDeg }),
        fov: (fovDeg) => this.setHorizontalFov(fovDeg),
        close: () => this.restoreFov(),
      },
    );
  }

  private cameraInfo(session: GameSession): { caseLabel: string; room: string; caption: string } {
    const callId = session.cad.unit(session.dispatcher.playerCallsign)?.callId ?? 0;
    const layout = session.officerBuilding >= 0 ? session.interiors.layout(session.officerBuilding) : null;
    const room = session.officerRoom();
    const photos = session.investigation.store.get(callId)?.photos ?? [];
    return {
      caseLabel: callId > 0 ? `C-${String(callId).padStart(5, '0')}` : 'Field case',
      room: layout && room >= 0 ? (layout.rooms[room]?.label ?? '') : 'Outdoors',
      caption: photos[photos.length - 1]?.caption ?? '',
    };
  }

  private setHorizontalFov(horizontalDeg: number): void {
    const r = this.renderer;
    if (!r) return;
    const aspect = r.camera.aspect > 0 ? r.camera.aspect : 16 / 9;
    const v = 2 * Math.atan(Math.tan((horizontalDeg * Math.PI) / 360) / aspect);
    r.fov = (v * 180) / Math.PI;
  }

  private restoreFov(): void {
    if (this.renderer) this.renderer.fov = this.host.baseFov();
  }

  /** Mouse shutter while the viewfinder is open. */
  shutter(): void {
    this.camera.shutter();
  }

  /** The case file of the current call (else the field case, else the newest file). */
  openCaseFile(session: GameSession): void {
    const callId = this.caseFileCall(session);
    const view = callId >= 0 ? session.investigation.caseView(callId) : null;
    if (!view) {
      this.host.flash('No case file yet: place a marker or collect evidence');
      return;
    }
    this.caseCall = callId;
    this.caseRevision = session.investigation.revision;
    this.caseFile.open(view, {
      custody: (itemId, action) => this.custody(session, itemId, action),
      close: () => {
        this.caseCall = -1;
      },
    });
  }

  private caseFileCall(session: GameSession): number {
    const store = session.investigation.store;
    const current = session.cad.unit(session.dispatcher.playerCallsign)?.callId ?? 0;
    if (current > 0 && store.get(current)) return current;
    if (store.get(0)) return 0;
    const files = store.files();
    return files.length > 0 ? (files[files.length - 1]?.callId ?? -1) : -1;
  }

  private custody(session: GameSession, itemId: string, action: string): void {
    const inv = session.investigation;
    switch (action) {
      case 'collect':
      case 'bag':
      case 'tag':
        inv.request({ kind: action, itemId });
        return;
      case 'deposit':
        // Deposit has no location check in the system: only at the evidence room's point.
        if (session.nearEvidenceRoom()) inv.request({ kind: 'deposit' });
        else this.host.flash('Deposit evidence at the station evidence room');
        return;
      default:
        this.host.flash('Transfers are not available yet');
    }
  }

  /** Per frame: the fingerprint panel follows `investigation.dust`; the case file refreshes when its revision changes. */
  updatePanels(session: GameSession, nowMs: number): void {
    const inv = session.investigation;
    const dust = inv.dust;
    if (dust && !this.dust.isOpen) {
      this.dust.open(dust, {
        move: (dir) => inv.request({ kind: 'dustMove', dir }),
        brush: (seconds) => inv.request({ kind: 'dustBrush', seconds }),
        lift: () => inv.request({ kind: 'dustLift' }),
        cancel: () => inv.request({ kind: 'dustCancel' }),
      });
    } else if (!dust && this.dust.isOpen) {
      this.dust.close();
    }
    if (nowMs < this.nextPanelMs) return;
    this.nextPanelMs = nowMs + PANEL_INTERVAL_MS;
    if (this.dust.isOpen && dust) this.dust.update(dust);
    if (this.caseFile.isOpen && this.caseCall >= 0 && inv.revision !== this.caseRevision) {
      this.caseRevision = inv.revision;
      const view = inv.caseView(this.caseCall);
      if (view) this.caseFile.update(view);
    }
    if (this.camera.isOpen) this.camera.update(this.cameraInfo(session));
  }

  // --- Camera and world ----------------------------------------------------------------------

  /** First-person camera at the interpolated officer position (`pos` is the body centre). */
  updateFirstPerson(session: GameSession, pos: THREE.Vector3, rig: CameraRig, camera: THREE.PerspectiveCamera): void {
    const yaw = session.controller.yaw;
    session.tactical.eye(yaw, scratchEye);
    rig.updateFirstPerson(pos.x, pos.y - PLAYER_SIZE.y / 2, pos.z, yaw, session.controller.pitch, scratchEye, camera);
  }

  /** Per frame after the camera moved: interior meshes and lights, the flashlight, the fade and the environment flag. */
  updateWorld(session: GameSession, dt: number, camera: THREE.PerspectiveCamera): void {
    const interiors = session.interiors;
    const x = camera.position.x;
    const z = camera.position.z;
    this.interiorRenderer?.update(interiors, dt, x, z);
    this.lightPool?.update(interiors, x, z);
    this.flashlight?.update(session.tactical.flashlightOn, camera);
    const fade = interiors.fade;
    if (fade !== this.lastFade) {
      this.lastFade = fade;
      this.fade.set(fade);
    }
    this.env?.setIndoor(interiors.officerBuilding >= 0);
  }

  /** Marker number labels (10 Hz): projects markers within 8 m to screen pixels. */
  updateLabels(session: GameSession, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement | null, nowMs: number): void {
    if (nowMs < this.nextLabelMs) return;
    this.nextLabelMs = nowMs + LABEL_INTERVAL_MS;
    if (!canvas) {
      this.labels.update([]);
      return;
    }
    const at = session.playerPosition({ x: 0, z: 0 });
    const n = session.investigation.nearbyMarkers(at.x, at.z, session.officerBuilding, LABEL_RANGE_M, this.markerBuf);
    const out: MarkerLabel[] = [];
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    for (let i = 0; i < n; i++) {
      const m = this.markerBuf[i];
      if (!m) continue;
      // The label sits above the tent.
      scratchV.set(m.x, m.y + 0.35, m.z).project(camera);
      if (scratchV.z < -1 || scratchV.z > 1 || Math.abs(scratchV.x) > 1.1 || Math.abs(scratchV.y) > 1.1) continue;
      out.push({ x: (scratchV.x * 0.5 + 0.5) * w, y: (-scratchV.y * 0.5 + 0.5) * h, text: String(m.no) });
    }
    this.labels.update(out);
  }

  /** After `renderer.render()` in the same task: a pending photo gets its 160x90 JPEG thumbnail (null when it fails). */
  afterRender(session: GameSession | null, canvas: HTMLCanvasElement | null): void {
    if (!session || !canvas) return;
    const id = session.investigation.pendingThumbnail();
    if (id === null) return;
    let url: string | null = null;
    try {
      const t = (this.thumbCanvas ??= document.createElement('canvas'));
      t.width = THUMB_W;
      t.height = THUMB_H;
      const ctx = t.getContext('2d');
      if (ctx) {
        // Centre crop to 16:9.
        const sw = Math.min(canvas.width, (canvas.height * THUMB_W) / THUMB_H);
        const sh = (sw * THUMB_H) / THUMB_W;
        ctx.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, 0, 0, THUMB_W, THUMB_H);
        url = t.toDataURL('image/jpeg', THUMB_QUALITY);
      }
    } catch {
      url = null;
    }
    session.investigation.attachThumbnail(id, url);
  }

  // --- HUD ----------------------------------------------------------------------------------

  /** HUD additions at the HUD rate: stance chips, noise and visibility, bodycam, shift objective, location, case line. */
  fillHud(s: HudSnapshot, session: GameSession): void {
    const tac = session.tactical;
    const t = this.hudTactical;
    const st = tac.stance;
    t.crouched = st.crouched;
    t.lean = st.lean < -0.3 ? -1 : st.lean > 0.3 ? 1 : 0;
    t.flashlight = tac.flashlightOn;
    t.noise = tac.noise;
    t.visibility = tac.visibility;
    t.slicing = tac.slicing;
    s.tactical = session.driving ? null : t;
    if (session.station.loadout.bodycamMount !== 'none') {
      this.hudBodycam.recording = session.investigation.bodycamOn;
      s.bodycam = this.hudBodycam;
    } else {
      s.bodycam = null;
    }
    s.shift = session.station.flow.step === 'onPatrol' ? null : session.station.flow.objective();
    const b = session.officerBuilding;
    if (b >= 0) {
      const layout = session.interiors.layout(b);
      const room = session.officerRoom();
      this.hudLocation.building = layout ? buildingLabel(layout.kind) : '';
      this.hudLocation.room = layout && room >= 0 ? (layout.rooms[room]?.label ?? '') : '';
      s.location = this.hudLocation;
    } else {
      s.location = null;
    }
    s.caseLine = session.investigation.hud();
  }
}
