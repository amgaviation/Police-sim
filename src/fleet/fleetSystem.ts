import type { CadTime } from '../cad/types';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import { defaultVehicleLoadout, validateVehicleLoadout } from '../gear/validate';
import type { LoadoutValidation, VehicleLoadout } from '../gear/types';
import { DEFAULT_LIVERIES, defaultLivery } from '../livery/defaults';
import { parseLivery } from '../livery/schema';
import type { LiveryDoc } from '../livery/types';
import { applyPronouns, CHARACTER_LINES, pronounLabel } from '../uniform/pronouns';
import type { PronounSet } from '../uniform/types';
import { ZONE_NAMES } from '../vehicles/damage';
import type { SerializedVehicle, VehicleCondition } from '../vehicles/drivableVehicle';
import { VEHICLE_MODELS, type VehicleModel } from '../vehicles/model';
import { chargePoints, damageCost, FleetLedger, isWreck, serviceQuote } from './accounting';
import { FLEET_DATA, INSPECTION_ITEMS, MAINTENANCE, unitNumber } from './data';
import type {} from './events';
import { runInspection, type InspectionInput, type InspectionResult } from './inspection';
import { MAX_LIBRARY, type FleetSave, type FleetUnitSave } from './save';
import type {
  DamageIncident, DamageReport, FleetConfigs, FleetRequest, FleetService, FleetUnitDef, FleetUnitView, LedgerKind, Quote,
} from './types';

/**
 * Fleet roster, damage incidents, service, inspection and the shift-end charge (Phase 7 design §9.5). Event driven:
 * the bus handlers only enqueue; `step` (order -655) does the work. No randomness is drawn.
 */

/** The part of a `DrivableVehicle` the fleet uses (it satisfies it structurally). */
export interface FleetVehiclePort {
  readonly eid: number;
  readonly model: { readonly id: string; readonly fuel: { readonly capacityL: number } };
  condition(out?: VehicleCondition): VehicleCondition;
  refuel(liters?: number): void;
  changeOil(): void;
  replaceTires(wheels?: readonly number[]): void;
  /** Body zones and engine only: flat tyres stay flat (they are priced and fixed by `replaceTires`). */
  repairBody(): void;
}

export interface FleetDeps {
  readonly bus: EventBus<EventMap>;
  /** `session.rng.stream('fleet')`: its state is saved; nothing is drawn today. */
  readonly rng: Rng;
  /** The spawned vehicle of a unit. */
  vehicleOf(unitId: string): FleetVehiclePort | null;
  /** Is the unit's vehicle in the yard (service happens only there)? Absent: always. */
  inYard?(unitId: string): boolean;
  damageContext(eid: number): { pursuit: boolean; emergency: boolean; callId: number };
  officer(): { name: string; badge: string; pronouns: PronounSet };
  readonly config?: Partial<FleetConfigs>;
}

type ZoneName = (typeof ZONE_NAMES)[number];

interface PendingHit {
  eid: number;
  zone: ZoneName;
  amount: number;
  impactSpeed: number;
}

interface UnitState {
  readonly def: FleetUnitDef;
  readonly model: VehicleModel;
  liveryId: string;
  loadout: VehicleLoadout | null;
  /** Bound vehicle entity, -1 when none. */
  eid: number;
  /** `vehicleIndex` of a loaded save until the unit is bound or unbound. */
  savedIndex: number;
  stored: SerializedVehicle | null;
  /** Condition at bind / after the last closed incident or service; null before the first bind. */
  baseline: VehicleCondition | null;
  open: DamageIncident | null;
  readonly view: FleetUnitView;
}

const WHEELS = 4;
/** A body zone above this reads as damaged. */
const DAMAGED_ZONE = 0.05;
const DAMAGED_ENGINE = 0.6;
const LOW_FUEL = 0.25;
const LOW_OIL = 0.3;
const LOW_TREAD = 0.3;

function newCondition(): VehicleCondition {
  return {
    modelId: '',
    fuelFraction: 1,
    fuelL: 0,
    oilFraction: 1,
    tread: [1, 1, 1, 1],
    flats: [false, false, false, false],
    zones: [0, 0, 0, 0],
    engineHealth: 1,
    engineFailed: false,
    odometerKm: 0,
  };
}

function copyCondition(dst: VehicleCondition, src: VehicleCondition): void {
  dst.modelId = src.modelId;
  dst.fuelFraction = src.fuelFraction;
  dst.fuelL = src.fuelL;
  dst.oilFraction = src.oilFraction;
  dst.engineHealth = src.engineHealth;
  dst.engineFailed = src.engineFailed;
  dst.odometerKm = src.odometerKm;
  for (let i = 0; i < WHEELS; i++) {
    dst.tread[i] = src.tread[i] ?? 1;
    dst.flats[i] = src.flats[i] ?? false;
    dst.zones[i] = src.zones[i] ?? 0;
  }
}

function copyLoadout(l: VehicleLoadout): VehicleLoadout {
  return { trunk: { ...l.trunk }, rack: [...l.rack] };
}

/** Wheel (FL FR RL RR) to the body zone shown for a tyre-burst-only incident. */
function wheelZone(wheel: number): ZoneName {
  return wheel >= 2 ? 'rear' : 'front';
}

export class FleetSystem {
  private readonly deps: FleetDeps;
  private readonly cfg: FleetConfigs;
  private readonly unitList: UnitState[] = [];
  private readonly unitById = new Map<string, UnitState>();
  private readonly eidToUnit = new Map<number, string>();
  private readonly views: FleetUnitView[] = [];
  private readonly ids: string[] = [];
  private readonly scratch = newCondition();
  private readonly unsubscribe: (() => void)[] = [];
  private pending: PendingHit[] = [];
  private queue: FleetRequest[] = [];
  private incidentList: DamageIncident[] = [];
  private openList: DamageIncident[] = [];
  private reportList: DamageReport[] = [];
  private custom: LiveryDoc[] = [];
  private libraryCache: LiveryDoc[] | null = null;
  private lastResult: InspectionResult | null = null;
  private assignedId: string | null = null;
  private shift = 1;
  private shiftStartGame = 0;
  private nextIncident = 1;
  private nextReport = 1;
  private rev = 1;
  private viewRev = 0;
  readonly ledger: FleetLedger;

  constructor(deps: FleetDeps, save?: FleetSave) {
    this.deps = deps;
    this.cfg = {
      fleet: deps.config?.fleet ?? FLEET_DATA,
      maintenance: deps.config?.maintenance ?? MAINTENANCE,
      inspection: deps.config?.inspection ?? INSPECTION_ITEMS,
    };
    for (const def of this.cfg.fleet.units) {
      const model = VEHICLE_MODELS.find((m) => m.id === def.model);
      if (model === undefined) throw new Error(`FleetSystem: unknown vehicle model "${def.model}" for unit ${def.id}`);
      const u: UnitState = {
        def,
        model,
        liveryId: def.livery,
        loadout: null,
        eid: -1,
        savedIndex: -1,
        stored: null,
        baseline: null,
        open: null,
        view: {
          id: def.id, number: unitNumber(def.id), modelId: def.model, label: model.name, cls: def.cls, liveryId: def.livery,
          spawned: false, assigned: false, fuel: 1, oil: 1, tread: 1, damage: 0, status: 'ready',
        },
      };
      this.unitList.push(u);
      this.unitById.set(def.id, u);
      this.views.push(u.view);
      this.ids.push(def.id);
    }
    const ledgerLimit = this.cfg.maintenance.limits.ledger;
    this.ledger = save === undefined ? new FleetLedger(ledgerLimit) : FleetLedger.restore(save.ledger, ledgerLimit);
    if (save !== undefined) this.load(save);
    this.unsubscribe.push(
      deps.bus.on('vehicle:damaged', (e) => {
        if (this.eidToUnit.has(e.eid)) this.pending.push({ eid: e.eid, zone: e.zone, amount: e.amount, impactSpeed: e.impactSpeed });
      }),
      deps.bus.on('vehicle:tireBurst', (e) => {
        if (this.eidToUnit.has(e.eid)) this.pending.push({ eid: e.eid, zone: wheelZone(e.wheel), amount: 0, impactSpeed: 0 });
      }),
    );
  }

  private load(save: FleetSave): void {
    this.deps.rng.restore(save.rng);
    this.shift = save.shift;
    this.shiftStartGame = save.shiftStartGame;
    this.nextIncident = save.nextIncident;
    this.nextReport = save.nextReport;
    this.custom = save.liveries.map((l) => structuredClone(l));
    for (const s of save.units) {
      const u = this.unitById.get(s.id);
      if (u === undefined) continue;
      u.liveryId = this.hasLivery(s.liveryId) ? s.liveryId : u.def.livery;
      u.loadout = s.loadout === null ? null : copyLoadout(s.loadout);
      u.savedIndex = s.vehicleIndex;
      u.stored = s.stored === null ? null : structuredClone(s.stored);
    }
    this.assignedId = save.assigned !== null && this.unitById.has(save.assigned) ? save.assigned : null;
    this.incidentList = save.incidents.map((i) => structuredClone(i));
    for (const inc of this.incidentList) {
      const u = this.unitById.get(inc.unitId);
      if (!inc.closed && u !== undefined && u.open === null) {
        u.open = inc;
        this.openList.push(inc);
      }
    }
    this.reportList = save.reports.map((r) => ({ ...r }));
    this.lastResult = save.lastInspection === null ? null : structuredClone(save.lastInspection);
    this.queue = save.queue.map((r) => structuredClone(r));
  }

  get revision(): number {
    return this.rev;
  }

  // --- Roster ---------------------------------------------------------------------------------

  /** Cached views, one per unit; spawned units are refreshed in place on every call. */
  units(): readonly FleetUnitView[] {
    const all = this.viewRev !== this.rev;
    for (const u of this.unitList) if (all || u.eid >= 0) this.fillView(u);
    this.viewRev = this.rev;
    return this.views;
  }

  unitIds(): readonly string[] {
    return this.ids;
  }

  unitOfEid(eid: number): string | null {
    return this.eidToUnit.get(eid) ?? null;
  }

  private unit(unitId: string): UnitState {
    const u = this.unitById.get(unitId);
    if (u === undefined) throw new Error(`Unknown fleet unit "${unitId}"`);
    return u;
  }

  /** Binds the spawned / restored vehicle of a unit; its condition becomes the damage baseline. */
  bindVehicle(unitId: string, eid: number): void {
    const u = this.unit(unitId);
    if (u.eid >= 0 && u.eid !== eid) this.eidToUnit.delete(u.eid);
    u.eid = eid;
    u.stored = null;
    u.savedIndex = -1;
    this.eidToUnit.set(eid, unitId);
    this.captureBaseline(u);
    this.rev++;
  }

  /** The unit's vehicle was despawned: closes its open incident and keeps `stored` for the next spawn. */
  unbindVehicle(unitId: string, stored: SerializedVehicle | null): void {
    const u = this.unit(unitId);
    if (u.open !== null) {
      const inc = u.open;
      this.closeIncident(inc, u, stored !== null && u.baseline !== null ? this.conditionOfStored(stored, this.scratch) : null);
    }
    if (u.eid >= 0) this.eidToUnit.delete(u.eid);
    u.eid = -1;
    u.savedIndex = -1;
    u.stored = stored === null ? null : structuredClone(stored);
    this.rev++;
  }

  storedVehicle(unitId: string): SerializedVehicle | null {
    return this.unitById.get(unitId)?.stored ?? null;
  }

  assigned(): string | null {
    return this.assignedId;
  }

  assign(unitId: string | null): void {
    if (unitId !== null && !this.unitById.has(unitId)) return;
    this.assignedId = unitId;
    this.rev++;
  }

  // --- Liveries and loadouts ------------------------------------------------------------------

  private hasLivery(id: string): boolean {
    return this.custom.some((l) => l.id === id) || DEFAULT_LIVERIES.some((l) => l.id === id);
  }

  /** The unit's livery: the library doc, else the default of its id, else the unit's own default. */
  livery(unitId: string): LiveryDoc {
    const u = this.unit(unitId);
    return (
      this.custom.find((l) => l.id === u.liveryId) ??
      DEFAULT_LIVERIES.find((l) => l.id === u.liveryId) ??
      defaultLivery(u.def.livery)
    );
  }

  /**
   * Stores `doc` in the library (replacing the same id; an unchanged default is not copied) and points the unit at it.
   * Returns false when the doc is invalid or the library of 32 custom docs is full of liveries in use.
   */
  setLivery(unitId: string, doc: LiveryDoc): boolean {
    const u = this.unit(unitId);
    const parsed = parseLivery(doc);
    if (!parsed.ok) return false;
    const next = parsed.livery;
    const index = this.custom.findIndex((l) => l.id === next.id);
    const shipped = DEFAULT_LIVERIES.find((l) => l.id === next.id);
    if (index < 0 && shipped !== undefined && JSON.stringify(shipped) === JSON.stringify(next)) {
      u.liveryId = next.id;
    } else if (index >= 0) {
      this.custom[index] = next;
      u.liveryId = next.id;
    } else {
      if (this.custom.length >= MAX_LIBRARY) {
        const free = this.custom.findIndex((l) => !this.unitList.some((x) => x.liveryId === l.id));
        if (free < 0) return false;
        this.custom.splice(free, 1);
      }
      this.custom.push(next);
      u.liveryId = next.id;
    }
    this.libraryCache = null;
    this.rev++;
    return true;
  }

  /** Custom docs (at most 32), then the defaults that no custom doc shadows. */
  library(): readonly LiveryDoc[] {
    if (this.libraryCache === null) {
      this.libraryCache = [...this.custom, ...DEFAULT_LIVERIES.filter((d) => !this.custom.some((c) => c.id === d.id))];
    }
    return this.libraryCache;
  }

  /** Removes a custom doc; units using it fall back to their default livery. */
  removeLivery(id: string): boolean {
    const index = this.custom.findIndex((l) => l.id === id);
    if (index < 0) return false;
    this.custom.splice(index, 1);
    for (const u of this.unitList) if (u.liveryId === id) u.liveryId = u.def.livery;
    this.libraryCache = null;
    this.rev++;
    return true;
  }

  /** The unit's custom loadout, else the shipped default (a copy either way). */
  loadout(unitId: string): VehicleLoadout {
    const u = this.unit(unitId);
    if (u.loadout !== null) return copyLoadout(u.loadout);
    const cargo = u.model.cargo;
    const def = defaultVehicleLoadout(u.def.trunk, cargo.rackSlots > 0);
    def.rack = def.rack.slice(0, cargo.rackSlots);
    return def;
  }

  /** Drops the unit's custom loadout: the shipped default applies again. */
  clearLoadout(unitId: string): void {
    const u = this.unit(unitId);
    if (u.loadout === null) return;
    u.loadout = null;
    this.rev++;
  }

  /** Validates against the vehicle's cargo and the class; the loadout is stored only when valid. */
  setLoadout(unitId: string, l: VehicleLoadout): LoadoutValidation {
    const u = this.unit(unitId);
    const result = validateVehicleLoadout(l, u.model.cargo, u.def.cls);
    if (result.ok) {
      u.loadout = copyLoadout(l);
      this.rev++;
    }
    return result;
  }

  // --- Incidents and reports ------------------------------------------------------------------

  incidents(): readonly DamageIncident[] {
    return this.incidentList;
  }

  /** Incidents not yet reported and not yet charged. */
  openReports(): number {
    let n = 0;
    for (const i of this.incidentList) if (!i.reported && !i.charged) n++;
    return n;
  }

  reports(): readonly DamageReport[] {
    return this.reportList;
  }

  lastInspection(): InspectionResult | null {
    return this.lastResult;
  }

  /** Quote for a spawned unit (null when not spawned). */
  quote(unitId: string, service: FleetService): Quote | null {
    const u = this.unitById.get(unitId);
    const port = u === undefined || u.eid < 0 ? null : this.deps.vehicleOf(unitId);
    if (u === undefined || port === null) return null;
    return serviceQuote(service, port.condition(this.scratch), port.model.fuel.capacityL, u.def.cls, this.cfg.maintenance);
  }

  /** Marks the shift start (incidents after it belong to this shift). */
  startShift(t: CadTime): void {
    this.shiftStartGame = t.game;
  }

  /** Queues a request, applied at the start of the next `step`. */
  request(r: FleetRequest): void {
    this.queue.push(r);
  }

  /** `vehicleIndex` of a loaded save for a unit; -1 when none (the integrator binds restored vehicles with it). */
  savedVehicleIndex(unitId: string): number {
    return this.unitById.get(unitId)?.savedIndex ?? -1;
  }

  // --- Step -----------------------------------------------------------------------------------

  /**
   * Fixed step (order -655): closes incidents `incidentMergeS` after their last hit, merges the new hits, applies the
   * queued requests. Allocation-free when nothing is pending.
   */
  step(_dt: number, t: CadTime): void {
    if (this.openList.length > 0) this.closeDue(t);
    if (this.pending.length > 0) this.applyPending(t);
    if (this.queue.length > 0) this.applyQueue(t);
  }

  private applyPending(t: CadTime): void {
    const hits = this.pending;
    this.pending = [];
    for (const hit of hits) {
      const unitId = this.eidToUnit.get(hit.eid);
      const u = unitId === undefined ? undefined : this.unitById.get(unitId);
      if (u === undefined) continue;
      let inc = u.open;
      if (inc === null) {
        const ctx = this.deps.damageContext(hit.eid);
        inc = {
          id: this.nextIncident++, unitId: u.def.id, shift: this.shift, startSim: t.sim, lastSim: t.sim, game: t.game,
          zoneDelta: [0, 0, 0, 0], engineDelta: 0, newFlats: 0, engineFailed: false, maxImpact: hit.impactSpeed,
          pursuit: ctx.pursuit, emergency: ctx.emergency, callId: ctx.callId, closed: false, cost: 0, wreck: false,
          reported: false, charged: false,
        };
        u.open = inc;
        this.incidentList.push(inc);
        this.openList.push(inc);
        this.evictIncidents();
        this.deps.bus.emit('fleet:damage', {
          unitId: u.def.id, incidentId: inc.id, zone: hit.zone, amount: hit.amount, impactSpeed: hit.impactSpeed,
          pursuit: inc.pursuit, emergency: inc.emergency,
        });
      } else {
        inc.lastSim = t.sim;
        if (hit.impactSpeed > inc.maxImpact) inc.maxImpact = hit.impactSpeed;
      }
      const cond = this.read(u);
      if (cond !== null) this.measure(inc, u, cond);
      this.rev++;
    }
  }

  private closeDue(t: CadTime): void {
    const merge = this.cfg.maintenance.incidentMergeS;
    for (let i = this.openList.length - 1; i >= 0; i--) {
      const inc = this.openList[i];
      if (inc === undefined || t.sim - inc.lastSim < merge) continue;
      const u = this.unit(inc.unitId);
      this.closeIncident(inc, u, this.read(u));
    }
  }

  private applyQueue(t: CadTime): void {
    const batch = this.queue;
    this.queue = [];
    for (const r of batch) {
      switch (r.kind) {
        case 'service':
          this.doService(r.unitId, r.service, t);
          break;
        case 'report':
          this.doReport(r.incidentId, t);
          break;
        case 'inspect':
          this.doInspect(r.unitId, r.input);
          break;
        case 'endShift':
          this.doEndShift(t);
          break;
      }
    }
  }

  // --- Incident internals ---------------------------------------------------------------------

  /** The unit's current condition in the shared scratch object (consume it at once), or null when not spawned. */
  private read(u: UnitState): VehicleCondition | null {
    if (u.eid < 0) return null;
    const port = this.deps.vehicleOf(u.def.id);
    return port === null ? null : port.condition(this.scratch);
  }

  private captureBaseline(u: UnitState): void {
    const port = this.deps.vehicleOf(u.def.id);
    if (port === null) return;
    if (u.baseline === null) u.baseline = newCondition();
    port.condition(u.baseline);
  }

  /** Accumulates the damage gained since the baseline into the incident (deltas only grow). */
  private measure(inc: DamageIncident, u: UnitState, cond: VehicleCondition): void {
    const base = u.baseline;
    if (base === null) return;
    let flats = 0;
    for (let i = 0; i < WHEELS; i++) {
      const d = (cond.zones[i] ?? 0) - (base.zones[i] ?? 0);
      if (d > (inc.zoneDelta[i] ?? 0)) inc.zoneDelta[i] = d;
      if (cond.flats[i] === true && base.flats[i] !== true) flats++;
    }
    const engine = base.engineHealth - cond.engineHealth;
    if (engine > inc.engineDelta) inc.engineDelta = engine;
    if (flats > inc.newFlats) inc.newFlats = flats;
    if (cond.engineFailed && !base.engineFailed) inc.engineFailed = true;
  }

  private closeIncident(inc: DamageIncident, u: UnitState, cond: VehicleCondition | null): void {
    if (cond !== null) this.measure(inc, u, cond);
    const cfg = this.cfg.maintenance;
    inc.cost = damageCost(inc.zoneDelta, inc.engineDelta, inc.newFlats, inc.engineFailed, u.def.cls, cfg);
    const base = u.baseline;
    const zonesAfter: number[] = [0, 0, 0, 0];
    for (let i = 0; i < WHEELS; i++) zonesAfter[i] = cond !== null ? (cond.zones[i] ?? 0) : Math.min(1, (base?.zones[i] ?? 0) + (inc.zoneDelta[i] ?? 0));
    inc.wreck = isWreck(zonesAfter, inc.engineFailed, cfg);
    inc.closed = true;
    u.open = null;
    const at = this.openList.indexOf(inc);
    if (at >= 0) this.openList.splice(at, 1);
    if (cond !== null) {
      if (u.baseline === null) u.baseline = newCondition();
      copyCondition(u.baseline, cond);
    }
    this.deps.bus.emit('fleet:incident', { unitId: u.def.id, incidentId: inc.id, cost: inc.cost, wreck: inc.wreck });
    this.deps.bus.emit('fleet:flash', { text: `Damage to ${u.def.id}: file a damage report (fleet panel)` });
    this.rev++;
  }

  /** Drops the oldest incidents beyond the limit, but never one that is open or not yet charged. */
  private evictIncidents(): void {
    const limit = this.cfg.maintenance.limits.incidents;
    while (this.incidentList.length > limit) {
      const i = this.incidentList.findIndex((x) => x.closed && x.charged);
      if (i < 0) return;
      this.incidentList.splice(i, 1);
    }
  }

  // --- Requests -------------------------------------------------------------------------------

  private doService(unitId: string, service: FleetService, t: CadTime): void {
    const u = this.unitById.get(unitId);
    const port = u === undefined || u.eid < 0 ? null : this.deps.vehicleOf(unitId);
    if (u === undefined || port === null) return;
    if (this.deps.inYard && !this.deps.inYard(unitId)) {
      this.deps.bus.emit('fleet:flash', { text: `Bring ${unitId} to the yard to service it` });
      return;
    }
    const quote = serviceQuote(service, port.condition(this.scratch), port.model.fuel.capacityL, u.def.cls, this.cfg.maintenance);
    const all = service === 'all';
    if (all || service === 'refuel') port.refuel();
    if (all || service === 'oil') port.changeOil();
    if (all || service === 'tires') port.replaceTires();
    if (all || service === 'repair') port.repairBody();
    const kinds: LedgerKind[] = [];
    const costs: number[] = [];
    const notes: string[] = [];
    for (const line of quote.lines) {
      const kind: LedgerKind = line.kind === 'tire' ? 'tire' : line.kind === 'body' || line.kind === 'engine' ? 'repair' : line.kind;
      const at = kinds.indexOf(kind);
      if (at < 0) {
        kinds.push(kind);
        costs.push(line.cost);
        notes.push(line.label);
      } else {
        costs[at] = (costs[at] ?? 0) + line.cost;
        notes[at] = `${notes[at] ?? ''}, ${line.label}`;
      }
    }
    kinds.forEach((kind, i) => {
      this.ledger.add({ game: t.game, unitId, kind, cost: costs[i] ?? 0, points: 0, note: notes[i] ?? '' });
    });
    this.captureBaseline(u);
    this.deps.bus.emit('fleet:service', { unitId, service, cost: quote.total });
    this.deps.bus.emit('fleet:flash', { text: `Serviced ${unitId}: $${quote.total}` });
    this.rev++;
  }

  private doReport(incidentId: number, t: CadTime): void {
    const inc = this.incidentList.find((i) => i.id === incidentId);
    if (inc === undefined || inc.reported) return;
    const u = this.unitById.get(inc.unitId);
    if (!inc.closed && u !== undefined) {
      const cond = this.read(u);
      if (cond !== null) this.measure(inc, u, cond);
    }
    inc.reported = true;
    const officer = this.deps.officer();
    let zone = -1;
    let most = 0;
    inc.zoneDelta.forEach((d, i) => {
      if (d > most) {
        most = d;
        zone = i;
      }
    });
    const context = inc.pursuit ? ' during a pursuit' : inc.emergency ? ' on an emergency run' : '';
    const text = applyPronouns(CHARACTER_LINES.damageReport ?? '', officer.pronouns, {
      name: officer.name,
      pronouns: pronounLabel(officer.pronouns),
      unit: inc.unitId,
      zone: zone < 0 ? 'minor' : (ZONE_NAMES[zone] ?? 'minor'),
      speed: String(Math.round(inc.maxImpact * 3.6)),
      context,
    });
    this.reportList.push({ id: this.nextReport++, incidentId, unitId: inc.unitId, game: t.game, text });
    const limit = this.cfg.maintenance.limits.reports;
    if (this.reportList.length > limit) this.reportList.splice(0, this.reportList.length - limit);
    this.deps.bus.emit('fleet:flash', { text: `Damage report filed for ${inc.unitId}` });
    this.rev++;
  }

  private doInspect(unitId: string, input: Omit<InspectionInput, 'condition' | 'unreportedIncidents'>): void {
    const u = this.unitById.get(unitId);
    const cond = u === undefined ? null : this.read(u);
    if (u === undefined || cond === null) return;
    let unreported = 0;
    for (const i of this.incidentList) if (i.unitId === unitId && !i.reported && !i.charged) unreported++;
    const result = runInspection({ ...input, condition: cond, unreportedIncidents: unreported }, this.cfg.inspection);
    this.lastResult = result;
    this.deps.bus.emit('fleet:inspection', { unitId, passed: result.passed, failed: [...result.failed] });
    this.deps.bus.emit('fleet:flash', { text: `Inspection ${unitId}: ${result.passed}/${result.rows.length} passed` });
    this.rev++;
  }

  private doEndShift(t: CadTime): void {
    for (let i = this.openList.length - 1; i >= 0; i--) {
      const inc = this.openList[i];
      if (inc === undefined) continue;
      const u = this.unit(inc.unitId);
      this.closeIncident(inc, u, this.read(u));
    }
    const cfg = this.cfg.maintenance;
    let points = 0;
    let incidents = 0;
    let unreported = 0;
    for (const inc of this.incidentList) {
      if (inc.shift !== this.shift) continue;
      incidents++;
      if (!inc.reported) unreported++;
      if (inc.charged) continue;
      inc.charged = true;
      const p = chargePoints(inc.cost, inc, cfg);
      if (p === 0) continue;
      points += p;
      const reason =
        `${inc.wreck ? 'Wrecked' : 'Damaged'} ${inc.unitId}${inc.pursuit ? ' in a pursuit' : inc.emergency ? ' on an emergency run' : ''}` +
        (inc.reported ? '' : ' (unreported)');
      this.ledger.add({ game: t.game, unitId: inc.unitId, kind: 'charge', cost: inc.cost, points: p, note: reason });
      this.deps.bus.emit('fleet:charge', { unitId: inc.unitId, incidentId: inc.id, points: p, cost: inc.cost, reason });
    }
    let departmentCost = 0;
    for (const e of this.ledger.entries()) if (e.kind !== 'charge' && e.game >= this.shiftStartGame) departmentCost += e.cost;
    this.deps.bus.emit('fleet:shiftEnd', { points, departmentCost, incidents, unreported });
    this.shift++;
    this.shiftStartGame = t.game;
    this.rev++;
  }

  // --- Views ----------------------------------------------------------------------------------

  private conditionOfStored(s: SerializedVehicle, out: VehicleCondition): VehicleCondition {
    out.modelId = s.modelId;
    out.fuelL = s.fuelL;
    out.engineHealth = s.engineHealth;
    out.engineFailed = s.engineFailed;
    for (let i = 0; i < WHEELS; i++) {
      out.zones[i] = s.zones[i] ?? 0;
      out.flats[i] = s.tireFlat[i] === true;
      out.tread[i] = s.wear?.tread[i] ?? 1;
    }
    return out;
  }

  private fillView(u: UnitState): void {
    const v = u.view;
    v.liveryId = u.liveryId;
    v.assigned = this.assignedId === u.def.id;
    let cond: VehicleCondition | null = null;
    let spawned = false;
    if (u.eid >= 0) {
      const port = this.deps.vehicleOf(u.def.id);
      if (port !== null) {
        cond = port.condition(this.scratch);
        spawned = true;
      }
    }
    if (cond === null && u.stored !== null) {
      cond = this.conditionOfStored(u.stored, this.scratch);
      const capacity = u.model.fuel.capacityL;
      cond.fuelFraction = capacity > 0 ? u.stored.fuelL / capacity : 1;
      cond.oilFraction = u.stored.wear !== undefined && u.model.wear.oilL > 0 ? u.stored.wear.oilL / u.model.wear.oilL : 1;
    }
    v.spawned = spawned;
    if (cond === null) {
      v.fuel = 1;
      v.oil = 1;
      v.tread = 1;
      v.damage = 0;
      v.status = 'ready';
      return;
    }
    let tread = 1;
    let damage = 0;
    let flat = false;
    for (let i = 0; i < WHEELS; i++) {
      tread = Math.min(tread, cond.tread[i] ?? 1);
      damage = Math.max(damage, cond.zones[i] ?? 0);
      if (cond.flats[i] === true) flat = true;
    }
    v.fuel = cond.fuelFraction;
    v.oil = cond.oilFraction;
    v.tread = tread;
    v.damage = damage;
    if (damage > DAMAGED_ZONE || flat || cond.engineFailed || cond.engineHealth < DAMAGED_ENGINE) v.status = 'damaged';
    else if (v.fuel < LOW_FUEL || v.oil < LOW_OIL || tread < LOW_TREAD) v.status = 'service';
    else v.status = 'ready';
  }

  // --- Save -----------------------------------------------------------------------------------

  /** `indexOfEid` maps a bound eid to its `session.vehicles` index (-1 none). */
  serialize(indexOfEid: (eid: number) => number): FleetSave {
    const units: FleetUnitSave[] = this.unitList.map((u) => ({
      id: u.def.id,
      liveryId: u.liveryId,
      loadout: u.loadout === null ? null : copyLoadout(u.loadout),
      vehicleIndex: u.eid >= 0 ? indexOfEid(u.eid) : u.savedIndex,
      stored: u.stored === null ? null : structuredClone(u.stored),
    }));
    return {
      version: 1,
      rng: this.deps.rng.state(),
      shift: this.shift,
      shiftStartGame: this.shiftStartGame,
      assigned: this.assignedId,
      units,
      liveries: this.custom.map((l) => structuredClone(l)),
      incidents: this.incidentList.map((i) => structuredClone(i)),
      reports: this.reportList.map((r) => ({ ...r })),
      ledger: this.ledger.serialize(),
      lastInspection: this.lastResult === null ? null : structuredClone(this.lastResult),
      queue: this.queue.map((r) => structuredClone(r)),
      nextIncident: this.nextIncident,
      nextReport: this.nextReport,
    };
  }

  /** Unsubscribes from the bus. */
  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.pending = [];
  }
}
