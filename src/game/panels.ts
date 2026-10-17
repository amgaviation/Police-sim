import type { StopAction, TrafficStopInfo } from '../cad/types';
import { RACK_ITEMS, type PatrolEquipment } from '../police/equipment';
import { TRUNK_ITEMS, type OfficerKit } from '../police/inventory';
import type { ActionPanel, ActionPanelModel, PanelOption } from '../ui/panels/actionPanel';
import type { DrivableVehicle } from '../vehicles/drivableVehicle';
import { personName } from './policeFeed';
import { ARREST_CAR_DISTANCE, type GameSession } from './session';
import { describeTarget } from './target';

/** The open panel is rebuilt at most this often (ms). */
export const PANEL_REFRESH_MS = 100;

/** Which interaction panel is open (design §13.4). */
export type PatrolPanelKind = 'trunk' | 'equipment' | 'contact';

/** Trunk panel, level 1 (`item` null: every item with its counts) or level 2 (take / stow one of `item`). */
export function trunkPanelModel(eq: PatrolEquipment, kit: OfficerKit, item: string | null): ActionPanelModel {
  const def = item === null ? undefined : TRUNK_ITEMS.find((it) => it.id === item);
  if (!def) {
    return {
      title: 'Trunk',
      subtitle: 'Pick an item to take or stow',
      options: TRUNK_ITEMS.map(
        (it): PanelOption => ({ label: it.label, detail: `trunk ${String(eq.trunkCount(it.id))} · carried ${String(kit.carried(it.id))}/${String(it.carryMax)}` }),
      ),
    };
  }
  const inTrunk = eq.trunkCount(def.id);
  const carried = kit.carried(def.id);
  return {
    title: def.label,
    subtitle: `In the trunk ${String(inTrunk)} · carried ${String(carried)} of ${String(def.carryMax)}`,
    options: [
      { label: 'Take one', enabled: inTrunk > 0 && carried < def.carryMax },
      { label: 'Stow one', enabled: carried > 0 },
      { label: 'Back' },
    ],
    footer: '1-3 select · Esc close',
  };
}

/** Equipment panel (X in a patrol car): rack lock, long guns, spotlight, prisoner. */
export function equipmentPanelModel(eq: PatrolEquipment, kit: OfficerKit, prisonerName: string): ActionPanelModel {
  const spec = eq.spec;
  const options: PanelOption[] = [
    {
      label: eq.rackLocked ? 'Unlock gun rack' : 'Lock gun rack',
      detail: spec.rack ? (eq.rackLocked ? 'Locked' : 'Unlocked') : 'No rack',
      enabled: spec.rack,
    },
  ];
  for (const r of RACK_ITEMS) {
    const racked = eq.rackHas(r.id);
    const carried = kit.longGun === r.id;
    options.push(
      racked
        ? { label: `Check out ${r.label.toLowerCase()}`, detail: 'In the rack', enabled: spec.rack && !eq.rackLocked && kit.longGun === null }
        : { label: `Check in ${r.label.toLowerCase()}`, detail: carried ? 'Carried' : 'Out', enabled: spec.rack && carried },
    );
  }
  options.push({ label: eq.spotOn ? 'Spotlight off' : 'Spotlight on', detail: spec.spotlight ? (eq.spotOn ? 'On' : 'Off') : 'None', enabled: spec.spotlight });
  options.push({
    label: 'Rear seat',
    detail: !spec.partition ? 'No partition' : eq.prisoner >= 0 ? prisonerName : 'Empty',
    enabled: false,
  });
  return {
    title: 'Equipment',
    subtitle: eq.prisoner >= 0 ? 'Book the prisoner at the station (MDT, Reports)' : undefined,
    options,
  };
}

/** Indices of the contact panel's options, in order. */
export const CONTACT_ACTIONS = ['license', 'vin', 'citation', 'warnRelease', 'release', 'arrest'] as const;
export type ContactAction = (typeof CONTACT_ACTIONS)[number];

/** Traffic-stop driver contact panel (at the stopped car's driver window). */
export function contactPanelModel(stop: TrafficStopInfo, description: string, driverName: string, canArrest: boolean): ActionPanelModel {
  return {
    title: `Traffic stop · ${stop.plate}`,
    subtitle: `${description} · ${stop.driverId >= 0 ? `Driver ${driverName}` : 'Driver not identified'}`,
    options: [
      { label: 'Request licence', detail: stop.driverId >= 0 ? 'Identified' : '' },
      { label: 'Check VIN', detail: stop.vinChecked ? 'Checked' : '' },
      { label: 'Write citation', detail: stop.citations.length > 0 ? `${String(stop.citations.length)} issued` : 'Opens the MDT' },
      { label: 'Warn and release' },
      { label: 'Release' },
      { label: 'Arrest', detail: canArrest ? 'Rear seat free' : `No free cage within ${String(ARREST_CAR_DISTANCE)} m`, enabled: canArrest },
    ],
  };
}

/** What the panels need from the app. */
export interface PatrolPanelHost {
  session(): GameSession | null;
  /** Opens the MDT on a citation prefilled from the stop. */
  openCitation(): void;
  /** One-off HUD line. */
  flash(text: string): void;
}

/**
 * The three interaction panels on one `ActionPanel` (design §13.4): the trunk (take / stow, two
 * levels), the equipment panel (rack, long guns, spotlight, cage) and the traffic-stop driver contact
 * (requests queued for the dispatcher's next step). `update` refreshes the open panel every frame and
 * closes the contact panel once the stop is over.
 */
export class PatrolPanels {
  private readonly panel: ActionPanel;
  private readonly host: PatrolPanelHost;
  private kindValue: PatrolPanelKind | null = null;
  private trunkCar: DrivableVehicle | null = null;
  private trunkItem: string | null = null;
  /** Change key of the shown model; the panel DOM is refreshed only when it changes. */
  private shownKey = '';
  private nextRefreshMs = 0;

  constructor(panel: ActionPanel, host: PatrolPanelHost) {
    this.panel = panel;
    this.host = host;
  }

  get kind(): PatrolPanelKind | null {
    return this.panel.isOpen ? this.kindValue : null;
  }

  get isOpen(): boolean {
    return this.panel.isOpen;
  }

  openTrunk(vehicle: DrivableVehicle): void {
    const session = this.host.session();
    const eq = session?.equipmentOf(vehicle);
    if (!session || !eq) return;
    this.trunkCar = vehicle;
    this.trunkItem = null;
    this.show('trunk', trunkPanelModel(eq, session.officerKit, null));
  }

  openEquipment(): void {
    const session = this.host.session();
    const eq = session?.drivenEquipment;
    if (!session || !eq) return;
    this.show('equipment', equipmentPanelModel(eq, session.officerKit, personName(session.seed, eq.prisoner)));
  }

  openContact(): void {
    const model = this.contactModel();
    if (model) this.show('contact', model);
  }

  close(): void {
    this.panel.close();
  }

  /**
   * Per frame while open: at most every `PANEL_REFRESH_MS` (and right after a selection) refreshes the
   * model (counts, CAD stop) and closes a panel whose subject is gone (the stop ended, no patrol car).
   */
  update(nowMs = Infinity): void {
    if (!this.panel.isOpen || nowMs < this.nextRefreshMs) return;
    this.nextRefreshMs = Number.isFinite(nowMs) ? nowMs + PANEL_REFRESH_MS : 0;
    const model = this.currentModel();
    if (!model) {
      this.panel.close();
      return;
    }
    const key = modelKey(model);
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.panel.update(model);
  }

  private show(kind: PatrolPanelKind, model: ActionPanelModel): void {
    this.kindValue = kind;
    this.shownKey = modelKey(model);
    this.panel.open(model, (index) => this.select(kind, index), () => {
      if (this.kindValue === kind) this.kindValue = null;
    });
  }

  private currentModel(): ActionPanelModel | null {
    const session = this.host.session();
    if (!session) return null;
    switch (this.kindValue) {
      case 'trunk': {
        const eq = session.equipmentOf(this.trunkCar);
        return eq ? trunkPanelModel(eq, session.officerKit, this.trunkItem) : null;
      }
      case 'equipment': {
        const eq = session.drivenEquipment;
        return eq ? equipmentPanelModel(eq, session.officerKit, personName(session.seed, eq.prisoner)) : null;
      }
      case 'contact':
        return this.contactModel();
      default:
        return null;
    }
  }

  private contactModel(): ActionPanelModel | null {
    const session = this.host.session();
    const stop = session?.cad.trafficStop;
    if (!session || !stop || stop.outcome !== 'active') return null;
    const description = describeTarget(session.seed, stop.vehicleId, 0).description;
    return contactPanelModel(stop, description, personName(session.seed, stop.driverId), session.arrestVehicle() !== null);
  }

  private select(kind: PatrolPanelKind, index: number): void {
    const session = this.host.session();
    if (!session) return;
    if (kind === 'trunk') this.selectTrunk(session, index);
    else if (kind === 'equipment') this.selectEquipment(session, index);
    else this.selectContact(session, index);
    this.update();
  }

  private selectTrunk(session: GameSession, index: number): void {
    const eq = session.equipmentOf(this.trunkCar);
    if (!eq) return;
    const item = this.trunkItem;
    if (item === null) {
      this.trunkItem = TRUNK_ITEMS[index]?.id ?? null;
      return;
    }
    const kit = session.officerKit;
    if (index === 0 && !eq.take(item, kit)) this.host.flash('Cannot take more');
    else if (index === 1 && !eq.stow(item, kit)) this.host.flash('Nothing to stow');
    else if (index === 2) this.trunkItem = null;
  }

  private selectEquipment(session: GameSession, index: number): void {
    const eq = session.drivenEquipment;
    if (!eq) return;
    const kit = session.officerKit;
    if (index === 0) {
      if (!eq.toggleRackLock(session.stopped)) this.host.flash('Stop the vehicle to unlock the rack');
      return;
    }
    const rack = RACK_ITEMS[index - 1];
    if (rack) {
      const ok = eq.rackHas(rack.id) ? eq.checkOut(rack.id, kit) : eq.checkIn(rack.id, kit);
      if (!ok) this.host.flash(eq.rackLocked ? 'The rack is locked' : 'Not possible now');
      return;
    }
    if (index === RACK_ITEMS.length + 1) eq.toggleSpot();
  }

  private selectContact(session: GameSession, index: number): void {
    const action = CONTACT_ACTIONS[index];
    const send = (a: StopAction): void => session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'stopContact', action: a }, 'key');
    switch (action) {
      case 'license':
      case 'vin':
        send(action);
        return;
      case 'citation':
        this.panel.close();
        this.host.openCitation();
        return;
      case 'warnRelease':
        send('warn');
        send('release');
        this.panel.close();
        return;
      case 'release':
        send('release');
        this.panel.close();
        return;
      case 'arrest':
        send('arrest');
        this.host.flash('Suspect cuffed; seated in the patrol car');
        this.panel.close();
        return;
      default:
        return;
    }
  }
}

function modelKey(m: ActionPanelModel): string {
  let key = `${m.title}|${m.subtitle ?? ''}|${m.footer ?? ''}`;
  for (const o of m.options) key += `|${o.label}:${o.detail ?? ''}:${o.enabled === false ? 0 : 1}`;
  return key;
}
