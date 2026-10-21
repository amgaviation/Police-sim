/**
 * Presentation of Phase 7 (design §12, §13, §20.3): the fleet panels (garage, service, inspection, shift summary) on a
 * non-pausing `ActionPanel`, the livery editor with its orbit preview, the character creator of the locker, and the
 * livery decal shells. It changes the simulation only through the session's check-out / check-in and `fleet.request`
 * (applied at the next fixed step); the editor and the renderers never feed back.
 */
import * as THREE from 'three';
import type { EntityId } from 'bitecs';
import type { FleetShiftEndEvent } from '../fleet/events';
import { unitNumber } from '../fleet/data';
import type { FleetService, FleetUnitView, Quote } from '../fleet/types';
import { FLEET_SERVICES } from '../fleet/types';
import { OFFICER_PRESETS, validateOfficerLoadout, validateVehicleLoadout, type OfficerLoadout } from '../gear';
import type { LiveryDoc } from '../livery';
import { Transform } from '../ecs/components';
import { LiveryRenderer } from '../render/livery';
import { CharacterCreator, extraVestSlots } from '../ui/character';
import {
  garagePanelModel,
  garagePanelPick,
  inspectionPanelModel,
  inspectionPanelPick,
  servicePanelModel,
  servicePanelPick,
  shiftSummaryModel,
  shiftSummaryPick,
  toggleExpanded,
  type FleetIntent,
  type GarageContext,
} from '../ui/fleet';
import { LiveryEditor, createOrbit, liveryPreviewPose, orbitBy, type LiveryEditorHost, type OrbitState, type PreviewPose } from '../ui/livery';
import { ActionPanel, type ActionPanelModel } from '../ui/panels/actionPanel';
import type { UIRoot } from '../ui/ui';
import { restHeight } from '../vehicles/model';
import type { DrivableVehicle } from '../vehicles/drivableVehicle';
import { headingOf, type GameSession } from './session';

/** The panels refresh at most this often (ms). */
const PANEL_INTERVAL_MS = 250;
/** A unit's vehicle counts as "next to" the officer within this distance (m) of its body edge. */
const NEAR_UNIT_M = 6;
/** The department printed on the liveries (`{dept}`). */
const DEPT = 'City Police';

type PanelKind = 'garage' | 'service' | 'inspection' | 'summary';

/** What the presenter needs from the app. */
export interface Phase7Host {
  session(): GameSession | null;
  /** One-off HUD line. */
  flash(text: string): void;
  /** Closes the patrol panels (trunk, equipment, scene ...) so the fleet panel can take their place. */
  closePatrolPanels(): void;
}

const scratchPoint = { x: 0, z: 0 };
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

export class Phase7Presenter {
  readonly panel: ActionPanel;
  readonly liveries: LiveryRenderer | null;
  /** The livery editor while it is open. */
  editor: LiveryEditor | null = null;
  /** The locker's character creator while it is open. */
  creator: CharacterCreator | null = null;

  private readonly host: Phase7Host;
  private readonly ui: UIRoot | null;
  private kind: PanelKind | null = null;
  private unit: string | null = null;
  private expanded: string | null = null;
  private summary: FleetShiftEndEvent | null = null;
  private inspectedAt = -1;
  private shownKey = '';
  private nextPanelMs = 0;
  private editorUnit: string | null = null;
  private readonly orbit: OrbitState = createOrbit();
  private readonly pose: PreviewPose = { x: 0, y: 0, z: 0, lookX: 0, lookY: 0, lookZ: 0 };
  /** Per vehicle: handed to the car renderer, and the livery document last given to the shell renderer (a new one repaints). */
  private readonly tracked = new Map<EntityId, { vehicle: DrivableVehicle; doc: LiveryDoc | null; unit: string; gen: number }>();
  private generation = 0;
  private offs: (() => void)[] = [];
  private onDrivable: ((eid: EntityId, vehicle: DrivableVehicle | null) => void) | null = null;

  constructor(scene: THREE.Scene | null, ui: UIRoot | null, host: Phase7Host) {
    this.host = host;
    this.ui = ui;
    this.panel = new ActionPanel(ui);
    this.liveries = scene ? new LiveryRenderer(scene) : null;
  }

  /** The car renderer's `setDrivable`: called when a vehicle appears in or leaves the session's list. */
  setDrivableSink(sink: (eid: EntityId, vehicle: DrivableVehicle | null) => void): void {
    this.onDrivable = sink;
  }

  /** Session start: listens for the shift summary. */
  begin(session: GameSession): void {
    this.end();
    this.offs.push(
      session.bus.on('fleet:shiftEnd', (e) => {
        this.summary = e;
        this.show('summary');
      }),
    );
  }

  /** Session end: panels, editor and creator off, shells removed. */
  end(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.panel.isOpen) this.panel.close();
    this.kind = null;
    this.unit = null;
    this.expanded = null;
    this.summary = null;
    this.editor = null;
    this.creator = null;
    this.editorUnit = null;
    for (const [eid] of this.tracked) {
      this.liveries?.remove(eid);
      this.onDrivable?.(eid, null);
    }
    this.tracked.clear();
  }

  dispose(): void {
    this.end();
    this.liveries?.dispose();
  }

  get panelKind(): PanelKind | null {
    return this.panel.isOpen ? this.kind : null;
  }

  // --- Panels --------------------------------------------------------------------------------

  /** The fleet garage (`'` anywhere, E at the station's service point). */
  openGarage(): void {
    this.host.closePatrolPanels();
    this.unit = null;
    this.expanded = null;
    this.show('garage');
  }

  /** Picks row `index` of the open fleet panel (tests and scripts; the panel's keys do the same). */
  pick(index: number): void {
    this.select(index);
  }

  private context(session: GameSession): GarageContext {
    const driving = session.unitOf(session.drivenVehicle);
    let near: string | null = null;
    let best = Infinity;
    const at = session.playerPosition(scratchPoint);
    for (const v of session.vehicles) {
      const id = session.unitOf(v);
      if (id === null || id === driving) continue;
      const d = Math.hypot((Transform.x[v.eid] ?? 0) - at.x, (Transform.z[v.eid] ?? 0) - at.z) - v.model.body.length / 2;
      if (d <= NEAR_UNIT_M && d < best) {
        best = d;
        near = id;
      }
    }
    return {
      atStation: session.atStation() || session.nearServicePoint(),
      driving,
      nearUnit: near,
      expanded: this.expanded,
      incidents: session.fleet.incidents(),
    };
  }

  private unitView(session: GameSession, id: string): FleetUnitView | null {
    return session.fleet.units().find((u) => u.id === id) ?? null;
  }

  private quotes(session: GameSession, id: string): Record<FleetService, Quote | null> {
    const out = {} as Record<FleetService, Quote | null>;
    for (const s of FLEET_SERVICES) out[s] = session.fleet.quote(id, s);
    return out;
  }

  private modelOf(session: GameSession): ActionPanelModel | null {
    switch (this.kind) {
      case 'garage':
        return garagePanelModel(session.fleet.units(), this.context(session));
      case 'service': {
        const u = this.unit === null ? null : this.unitView(session, this.unit);
        return u && this.unit !== null ? servicePanelModel(u, this.quotes(session, this.unit)) : null;
      }
      case 'inspection': {
        if (this.unit === null) return null;
        const result = session.fleet.revision === this.inspectedAt ? null : session.fleet.lastInspection();
        return inspectionPanelModel(result, session.fleet.incidents().filter((i) => i.unitId === this.unit), this.unit, session.atStation());
      }
      case 'summary':
        return this.summary ? shiftSummaryModel(this.summary, session.fleet.ledger.entries()) : null;
      default:
        return null;
    }
  }

  private show(kind: PanelKind): void {
    const session = this.host.session();
    if (!session) return;
    this.kind = kind;
    const model = this.modelOf(session);
    if (!model) return;
    this.shownKey = modelKey(model);
    this.panel.open(model, (index) => this.select(index), () => {
      if (this.kind === kind) this.kind = null;
    });
  }

  private select(index: number): void {
    const session = this.host.session();
    if (!session) return;
    let intent: FleetIntent | null;
    switch (this.kind) {
      case 'garage':
        intent = garagePanelPick(index, session.fleet.units(), this.context(session));
        break;
      case 'service': {
        const u = this.unit === null ? null : this.unitView(session, this.unit);
        intent = u ? servicePanelPick(index, u) : null;
        break;
      }
      case 'inspection': {
        if (this.unit === null) return;
        const result = session.fleet.revision === this.inspectedAt ? null : session.fleet.lastInspection();
        intent = inspectionPanelPick(index, result, session.fleet.incidents().filter((i) => i.unitId === this.unit), this.unit, session.atStation());
        break;
      }
      case 'summary':
        intent = shiftSummaryPick(index, session.fleet.ledger.entries());
        break;
      default:
        return;
    }
    if (intent) this.apply(session, intent);
    this.refresh(session, true);
  }

  private apply(session: GameSession, intent: FleetIntent): void {
    switch (intent.kind) {
      case 'select':
        this.expanded = toggleExpanded(this.expanded, intent.unitId);
        return;
      case 'checkout':
        this.host.flash(session.checkOut(intent.unitId).message);
        return;
      case 'checkin':
        this.host.flash(session.checkIn(intent.unitId).message);
        return;
      case 'customize':
        this.openEditor(session, intent.unitId);
        return;
      case 'service':
        this.unit = intent.unitId;
        this.show('service');
        return;
      case 'inspect': {
        const input = session.inspectionInput(intent.unitId);
        if (!input) {
          this.host.flash(`${intent.unitId} is in the yard: check it out first`);
          return;
        }
        session.fleet.request({ kind: 'inspect', unitId: intent.unitId, input });
        this.unit = intent.unitId;
        this.inspectedAt = session.fleet.revision;
        this.show('inspection');
        return;
      }
      case 'report':
        session.fleet.request({ kind: 'report', incidentId: intent.incidentId });
        return;
      case 'request':
        session.fleet.request(intent.request);
        return;
      case 'endShift':
        session.fleet.request({ kind: 'endShift' });
        return;
      case 'back':
        if (this.kind === 'summary') this.panel.close();
        else this.show('garage');
        return;
    }
  }

  private refresh(session: GameSession, force: boolean): void {
    if (!this.panel.isOpen) return;
    const model = this.modelOf(session);
    if (!model) {
      this.panel.close();
      return;
    }
    const key = modelKey(model);
    if (!force && key === this.shownKey) return;
    this.shownKey = key;
    this.panel.update(model);
  }

  /** Per frame: refreshes the open panel at most every `PANEL_INTERVAL_MS`. */
  updatePanels(session: GameSession, nowMs: number): void {
    if (!this.panel.isOpen || nowMs < this.nextPanelMs) return;
    this.nextPanelMs = nowMs + PANEL_INTERVAL_MS;
    this.refresh(session, false);
  }

  // --- Livery editor ---------------------------------------------------------------------------

  /** True while the livery editor is open (the app swaps the camera). */
  get editorOpen(): boolean {
    return this.editor?.isOpen === true;
  }

  private openEditor(session: GameSession, unitId: string): void {
    const vehicle = session.unitVehicle(unitId);
    const ui = this.ui;
    if (!vehicle) {
      this.host.flash(`${unitId} is in the yard: check it out first`);
      return;
    }
    this.panel.close();
    const model = vehicle.model;
    const cls = session.fleetClassOf(vehicle) ?? 'patrol';
    const number = unitNumber(unitId);
    const set = (doc: LiveryDoc): void => this.liveries?.set(vehicle.eid, model, doc, number, DEPT);
    const host: LiveryEditorHost = {
      unitId,
      unitNumber: number,
      dept: DEPT,
      model,
      fleetClass: cls,
      capacity: model.cargo,
      library: () => session.fleet.library(),
      validateLoadout: (l) => validateVehicleLoadout(l, model.cargo, cls),
      preview: (doc) => {
        session.previewLivery(unitId, doc);
        set(doc);
      },
      save: (doc) => {
        if (!session.fleet.setLivery(unitId, doc)) {
          this.host.flash('The livery library is full');
          return;
        }
        if (doc.loadout !== null) session.fleet.setLoadout(unitId, doc.loadout);
        session.applyUnitLivery(unitId);
        const t = this.tracked.get(vehicle.eid);
        if (t) t.doc = null;
        this.host.flash(`${doc.name} saved to ${unitId}`);
      },
      cancel: () => {
        session.applyUnitLivery(unitId);
        const t = this.tracked.get(vehicle.eid);
        if (t) t.doc = null;
      },
      orbit: (dYaw, dPitch, dZoom) => {
        orbitBy(this.orbit, dYaw, dPitch, dZoom);
      },
    };
    this.editorUnit = unitId;
    Object.assign(this.orbit, createOrbit());
    this.editor = new LiveryEditor(ui, host, session.fleet.livery(unitId));
    this.editor.open();
  }

  /**
   * The editor's camera pose around the unit's live vehicle (interpolated), written into the returned pose; null when the
   * editor is closed.
   */
  editorPose(session: GameSession, alpha: number): PreviewPose | null {
    if (!this.editorOpen || this.editorUnit === null) return null;
    const v = session.unitVehicle(this.editorUnit);
    if (!v) return null;
    const eid = v.eid;
    const x = Transform.x[eid] ?? 0;
    const z = Transform.z[eid] ?? 0;
    scratchPos.set(x, Transform.y[eid] ?? 0, z);
    scratchQuat.set(Transform.qx[eid] ?? 0, Transform.qy[eid] ?? 0, Transform.qz[eid] ?? 0, Transform.qw[eid] ?? 1);
    const yaw = headingOf(scratchQuat.x, scratchQuat.y, scratchQuat.z, scratchQuat.w);
    void alpha;
    const ground = (Transform.y[eid] ?? 0) - restHeight(v.model);
    return liveryPreviewPose({ x, y: ground, z, yaw }, v.model.body, this.orbit.yaw, this.orbit.pitch, this.orbit.zoom, this.pose);
  }

  // --- Character creator (locker) ----------------------------------------------------------------

  /** The locker's "Uniform & gear..." row: the creator on the officer, with a live 3D preview. */
  openCharacter(session: GameSession): void {
    this.panel.close();
    const original = structuredClone(session.character);
    const start: { profile: typeof original; gear: OfficerLoadout } = { profile: structuredClone(original), gear: structuredClone(session.gear.loadout) };
    this.creator = new CharacterCreator(
      this.ui,
      {
        mode: 'locker',
        validateGear: (l, extra) => validateOfficerLoadout(l, { extraVestSlots: extra }),
        preview: (profile) => session.phase7.setProfile(profile),
        done: (profile, gear) => {
          session.setCharacter(profile);
          session.gear.setLoadout(gear);
          session.gear.setExtraVestSlots(extraVestSlots(profile));
          this.creator = null;
          this.host.flash('Uniform and gear updated');
        },
        cancel: () => {
          session.phase7.setProfile(original);
          this.creator = null;
        },
      },
      start,
    );
    this.creator.open();
  }

  /** The preset ids the console and scripts can load. */
  get presetIds(): string[] {
    return Object.keys(OFFICER_PRESETS);
  }

  // --- Livery shells / drivables ---------------------------------------------------------------

  /**
   * Per frame, before `CarRenderer.update`: hands new vehicles to the car renderer (and drops removed ones) and gives
   * every fleet vehicle its livery shell document when it changed. Allocation-free while the vehicle list is stable.
   */
  syncVehicles(session: GameSession): void {
    const gen = ++this.generation;
    for (const v of session.vehicles) {
      let t = this.tracked.get(v.eid);
      if (t?.vehicle !== v) {
        t = { vehicle: v, doc: null, unit: '', gen };
        this.tracked.set(v.eid, t);
        this.onDrivable?.(v.eid, v);
      }
      t.gen = gen;
      const unit = session.unitOf(v);
      if (unit === null) continue;
      const doc = session.fleet.livery(unit);
      if (t.doc !== doc || t.unit !== unit) {
        t.doc = doc;
        t.unit = unit;
        this.liveries?.set(v.eid, v.model, doc, unitNumber(unit), DEPT);
      }
    }
    for (const [eid, t] of this.tracked) {
      if (t.gen === gen) continue;
      this.tracked.delete(eid);
      this.onDrivable?.(eid, null);
      this.liveries?.remove(eid);
    }
  }

  /** Per frame, after `CarRenderer.update`: places the decal shells of the nearest liveried vehicles. */
  updateShells(alpha: number, camX: number, camZ: number, night: number): void {
    this.liveries?.update(alpha, camX, camZ, night);
  }
}

/** Cheap change key of a panel model (the DOM is rebuilt only when it changes). */
function modelKey(m: ActionPanelModel): string {
  let key = `${m.title}|${m.subtitle ?? ''}|${m.footer ?? ''}`;
  for (const o of m.options) key += `|${o.label}:${o.detail ?? ''}:${o.enabled === false ? 0 : 1}`;
  return key;
}
