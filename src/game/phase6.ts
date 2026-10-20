import '../backup/events';
import '../command/events';
import '../pursuit/events';
import '../resources/events';
import { BackupSystem, emptyBackupSave, type BackupContext, type BackupSave } from '../backup';
import type { CadState } from '../cad/cadState';
import { callNumber } from '../cad/cadState';
import { CommandSystem, emptyCommandSave, type CommandContext, type CommandSave } from '../command';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { GameWorld } from '../ecs/world';
import type { Environment } from '../environment/environment';
import type { FellowOfficer } from '../force';
import { hourOf, type InteriorSystem } from '../indoors';
import type { IncidentSystem } from '../incidents';
import type { NoGoZone } from '../investigation';
import { allowedOverMph } from '../legal';
import type { ContactManager } from '../contact';
import type { NpcSystem } from '../npc';
import type { Population } from '../people';
import {
  emptyPursuitSave,
  PursuitSystem,
  type CarPose,
  type PursuitContext,
  type PursuitSave,
  type PursuitTactic,
} from '../pursuit';
import type { RadioSystem } from '../radio/radioSystem';
import { emptyResourceSave, ResourceSystem, type ResourceSave } from '../resources';
import type { SceneDirector } from '../scene';
import { DENSITY, PULLOVER } from '../traffic/data';
import { vehicleRecord } from '../traffic/registry';
import type { FleetState, StopState, TrafficSystem } from '../traffic/trafficSystem';
import type { RadioRequestType } from '../radio/requestTypes';
import { RosterState, UNIT_TYPES, requestableTypes, resourceSlots, unitType } from '../units';
import type { RosterSave } from '../units';
import type { BuildingIndex, BuildingInfo } from '../world/buildings';
import type { City } from '../world/city';
import { DISTRICT_NAMES } from '../world/ids';
import type { RoadHit } from '../world/roadGraph';
import type { Dispatcher } from '../dispatch/dispatcher';

/** The player as the Phase 6 systems see them (filled by the session every step). */
export interface Phase6Player {
  x: number;
  z: number;
  yaw: number;
  onFoot: boolean;
  /** Building the officer is in, -1 outdoors. */
  building: number;
  /** The player's current call, 0 none. */
  callId: number;
  /** Person id of the open contact, -1 none. */
  contactPersonId: number;
  /** The driven police car, valid when `inCar`. */
  inCar: boolean;
  car: CarPose;
  /** Entity id of the driven car, 0 none. */
  carId: number;
  lights: boolean;
  siren: boolean;
  carryingStrip: boolean;
}

/** Everything the Phase 6 systems read of the rest of the session (the session fills it). */
export interface Phase6Host {
  readonly seed: number;
  readonly rng: Rng;
  readonly bus: EventBus<EventMap>;
  readonly cad: CadState;
  readonly city: City;
  readonly world: GameWorld;
  readonly traffic: TrafficSystem;
  readonly scene: SceneDirector;
  readonly dispatcher: Dispatcher;
  readonly npc: NpcSystem;
  readonly people: Population;
  readonly interiors: InteriorSystem;
  readonly buildings: BuildingIndex;
  readonly contact: ContactManager;
  readonly radio: RadioSystem;
  readonly env: Environment;
  readonly incidents: IncidentSystem;
  /** The roster is created first (the dispatcher names its AI units from it). */
  readonly roster: RosterState;
  /** Fills the player's situation. */
  fillPlayer(out: Phase6Player): Phase6Player;
  /** Bursts the driven car's front tyres (spike strip hit). */
  burstPlayerTires(): void;
  /** Takes a spike strip out of the kit; false when the officer carries none. */
  takeStrip(): boolean;
  /** Shows a line on the HUD legal line. */
  flash(text: string, severity?: 'ok' | 'warn' | 'bad'): void;
}

const NIGHT_FACTOR = 0.5;
const WET_ROAD = 0.3;
const PURSUIT_ROAD_RADIUS = 40;

/** Rank of a resource slot's unit type (`null` = patrol officer). */
function rankOfSlot(typeId: string): 'officer' | 'sergeant' | 'lieutenant' | 'chief' {
  const r = unitType(typeId)?.rank;
  return r === 'sergeant' || r === 'lieutenant' || r === 'chief' ? r : 'officer';
}

/** 'a K9 unit', 'an EMS', 'a supervisor': the player's radio line names the unit with an article. */
function requestLabel(label: string): string {
  const text = /^[A-Z][a-z]/.test(label) ? `${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
  return `${/^[aeiouAEIOU]/.test(text) ? 'an' : 'a'} ${text}`;
}

/**
 * The radio menu / voice request types (design 14): the patrol types map to the Phase 2 requests (backup code 2, code 3,
 * officer needs assistance), every other requestable type to `{ kind: 'resource', typeId }`. Set once at app start with
 * `setRadioRequestTypes`.
 */
export function radioRequestTypeList(): RadioRequestType[] {
  return requestableTypes().map((t) => {
    let request: RadioRequestType['request'];
    if (t.send === 'backup2') request = { kind: 'backup', code: 2 };
    else if (t.send === 'backup3') request = { kind: 'backup', code: 3 };
    else if (t.send === 'emergency') request = { kind: 'emergency' };
    else request = { kind: 'resource', typeId: t.id };
    return { id: t.id, menu: t.menu, label: requestLabel(t.label), voice: t.voice.map((v) => v.toLowerCase()), request };
  });
}

/** The save blocks the v8 schema adds. */
export interface Phase6Save {
  roster: RosterSave;
  resources: ResourceSave;
  backup: BackupSave;
  pursuit: PursuitSave;
  command: CommandSave;
}

/**
 * The Phase 6 systems of one session (design 20): roster, resources, pursuit, backup and command, their ports over the
 * Phase 2-5 objects and the bridges of design 14.
 */
export class Phase6 {
  readonly roster: RosterState;
  readonly resources: ResourceSystem;
  readonly pursuit: PursuitSystem;
  readonly backup: BackupSystem;
  readonly command: CommandSystem;
  private readonly host: Phase6Host;
  private readonly offs: (() => void)[] = [];
  private readonly player: Phase6Player = {
    x: 0, z: 0, yaw: 0, onFoot: true, building: -1, callId: 0, contactPersonId: -1, inCar: false,
    car: { x: 0, z: 0, yaw: 0, speed: 0, halfLength: 2.4, halfWidth: 1 }, carId: 0, lights: false, siren: false, carryingStrip: false,
  };
  private readonly pursuitCtx: PursuitContext = {
    car: null, carId: 0, lights: false, siren: false, onFoot: true, x: 0, z: 0, yaw: 0, carryingStrip: false, playerCallsign: '',
  };
  private readonly backupCtx: BackupContext = { x: 0, z: 0, yaw: 0, building: -1, onFoot: true, callId: 0, contactPersonId: -1, subject: null, game: 0 };
  private readonly subject = { x: 0, z: 0 };
  private readonly commandCtx: CommandContext = { x: 0, z: 0, yaw: 0, onFoot: true, building: -1, callId: 0 };
  private readonly fleetScratch: FleetState = {
    eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1,
  };
  private readonly stopScratch: StopState = { vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 };
  private readonly poseScratch = { x: 0, z: 0, yaw: 0, speed: 0 };
  private readonly roadHit: RoadHit = { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
  private readonly roadOut = { district: '', limitMph: 0 };
  private readonly envOut = { wetness: 0, night: false };
  private readonly pursuitEnv = { wet: false, night: false };
  private readonly fellowsOut: FellowOfficer[] = [];
  private readonly nearScratch: BuildingInfo[] = [];
  private lastMinute = -1;
  private lastBlockRev = -1;
  private lastCommandZones: unknown = null;
  private investigationZones: readonly NoGoZone[] = [];

  constructor(host: Phase6Host) {
    this.host = host;
    const { seed, bus, rng, cad, city, dispatcher, scene, npc, people, interiors, buildings } = host;
    if (UNIT_TYPES.maxFleetCars !== PULLOVER.fleet.maxCars) throw new Error('units maxFleetCars differs from the traffic fleet size');
    this.roster = host.roster;
    const trafficDensity = (x: number, z: number): number => this.trafficDensity(x, z);
    this.resources = new ResourceSystem({
      seed,
      bus,
      rng: rng.stream('resources'),
      cad,
      city,
      world: host.world,
      traffic: host.traffic,
      scene: {
        request: (r) => scene.request(r),
        hasScenario: (id) => scene.hasScenario(id),
        serviceRequested: (id, kind) => scene.serviceRequested(id, kind),
      },
      dispatch: {
        playerCallsign: dispatcher.playerCallsign,
        openSelfInitiated: (typeId, priority, at, narrative, t) => dispatcher.openSelfInitiated(typeId, priority, at, narrative, t),
        locate: (x, z) => dispatcher.locate(x, z),
      },
      npc,
      people,
      roster: this.roster,
      env: () => {
        this.envOut.wetness = host.env.weather.wetness;
        this.envOut.night = host.env.lighting.nightFactor > NIGHT_FACTOR;
        return this.envOut;
      },
      trafficDensity,
    });
    this.pursuit = new PursuitSystem({
      seed,
      bus,
      rng: rng.stream('pursuit'),
      graph: city.graph,
      cad,
      traffic: host.traffic,
      dispatcher,
      resources: this.resources,
      scene: { request: (r) => scene.request(r) },
      npc,
      rules: {
        allowedOffenses: () => host.incidents.ruleset.pursuit.allowedOffenses,
        maxDurationS: () => host.incidents.ruleset.pursuit.maxDurationS,
        terminateGraceS: () => host.incidents.ruleset.pursuit.terminateGraceS,
        allowedOverMph: (district, wet, night) => allowedOverMph(host.incidents.ruleset, district, wet, night),
        offense: (callId) => {
          const a = host.incidents.assessment(callNumber(callId));
          const list = a?.pursuits;
          if (!list || list.length === 0) return null;
          return list[list.length - 1]?.offense ?? null;
        },
      },
      modelOf: (vehicleId) => vehicleRecord(seed, vehicleId).modelId,
      roadAt: (x, z) => this.roadAt(x, z),
      env: () => {
        this.pursuitEnv.wet = host.env.weather.wetness > WET_ROAD;
        this.pursuitEnv.night = host.env.lighting.nightFactor > NIGHT_FACTOR;
        return this.pursuitEnv;
      },
      trafficDensity,
    });
    this.pursuit.takeStripFromKit = () => host.takeStrip();
    this.pursuit.burstPlayerTires = () => host.burstPlayerTires();
    this.backup = new BackupSystem({
      seed,
      bus,
      rng: rng.stream('backup'),
      roster: this.roster,
      cad,
      npc,
      unitCar: (callsign, out) => this.unitCar(callsign, out),
      interiors,
      doorRequest: (buildingId, door, action) => {
        // The team is not the officer: it works the door itself (no reach check, no ram in the player's kit).
        const state = interiors.doorState(buildingId, door);
        if (state === 'broken') return;
        if (action === 'open') {
          if (state === 'closed') interiors.setDoorState(buildingId, door, 'open');
        } else interiors.setDoorState(buildingId, door, 'broken');
      },
      building: (id) => buildings.building(id),
      callBuilding: (callId) => scene.buildingOfCall(callId),
      swatOnScene: (callId) => this.resources.onScene(callId, 'swat'),
      negotiationTrust: (callId) => this.command.negotiationTrust(callId),
    });
    this.command = new CommandSystem({
      seed,
      bus,
      rng: rng.stream('command'),
      graph: city.graph,
      cad,
      scene,
      npc,
      people,
      resources: this.resources,
      backup: this.backup,
      buildingsNear: (x, z, r) => buildings.near(x, z, r, this.nearScratch).length,
      building: (id) => buildings.building(id),
      eta: (callsign) => this.resources.eta(callsign),
    });
    // The dispatcher picks and holds units through the Phase 6 systems.
    dispatcher.setUnitRanker((callsign, x, z, urgency) => this.resources.rankPatrol(callsign, x, z, urgency));
    dispatcher.setUnitHold((callsign) => this.backup.onFoot(callsign));
    scene.setServiceProvider((callId, kind) => this.resources.provide(callId, kind));
    this.wireBridges();
  }

  // --- Roster -----------------------------------------------------------------------------------

  /** The AI patrol units and the ranked resource slots get their profiles (names come from them). */
  ensureRoster(): void {
    for (const u of this.host.cad.units()) {
      if (u.kind === 'ai') this.roster.ensure(u.callsign, 'officer');
    }
    for (const slot of resourceSlots()) this.roster.ensure(slot.callsign, rankOfSlot(slot.typeId));
  }

  /** The dispatcher's `officerName` dep: AI units are named by their profile. */
  officerName(callsign: string): string | null {
    return this.roster.ensure(callsign, 'officer').name;
  }

  startShift(): void {
    this.roster.startShift();
  }

  // --- Start / restore ----------------------------------------------------------------------------

  /** New game: registers the resource units (after `dispatcher.start`). */
  start(t: { sim: number; game: number }): void {
    this.ensureRoster();
    this.resources.start(t);
  }

  // --- Requests ---------------------------------------------------------------------------------

  /**
   * The MDT / console request of a unit type for the player's call: patrol types go through the dispatcher (backup,
   * officer needs assistance), every other type through the resources module. False for an unknown or non-requestable type.
   */
  requestType(typeId: string, via: 'mdt' | 'radio' = 'mdt'): boolean {
    const t = unitType(typeId);
    if (!t) return false;
    const player = this.host.dispatcher.playerCallsign;
    if (t.send === 'backup2') this.host.dispatcher.request(player, { kind: 'backup', code: 2 }, via);
    else if (t.send === 'backup3') this.host.dispatcher.request(player, { kind: 'backup', code: 3 }, via);
    else if (t.send === 'emergency') this.host.dispatcher.request(player, { kind: 'emergency' }, via);
    else this.resources.request({ kind: 'request', typeId, callId: 0, via });
    return true;
  }

  // --- Fixed steps (orders -698, -678, -665, -662) ------------------------------------------------

  stepResources(dt: number, t: { sim: number; game: number }): void {
    const p = this.host.fillPlayer(this.player);
    this.resources.step(dt, t, p);
  }

  stepPursuit(dt: number, t: { sim: number; game: number }): void {
    const p = this.player;
    this.host.fillPlayer(p);
    const c = this.pursuitCtx;
    c.car = p.inCar ? p.car : null;
    c.carId = p.carId;
    c.lights = p.lights;
    c.siren = p.siren;
    c.onFoot = p.onFoot;
    c.x = p.x;
    c.z = p.z;
    c.yaw = p.yaw;
    c.carryingStrip = p.carryingStrip;
    c.playerCallsign = this.host.dispatcher.playerCallsign;
    this.pursuit.step(dt, t, c);
  }

  stepBackup(dt: number, t: { sim: number; game: number }): void {
    // The roster ticks once per whole game minute, before the officers (design 15).
    const minute = Math.floor(t.game / 60);
    if (this.lastMinute < 0) this.lastMinute = minute;
    else if (minute !== this.lastMinute) {
      this.roster.stepMinutes(minute - this.lastMinute);
      this.lastMinute = minute;
    }
    const p = this.player;
    this.host.fillPlayer(p);
    const c = this.backupCtx;
    c.x = p.x;
    c.z = p.z;
    c.yaw = p.yaw;
    c.building = p.building;
    c.onFoot = p.onFoot;
    c.callId = p.callId;
    c.contactPersonId = p.contactPersonId;
    c.game = t.game;
    // A driver still in the stopped car is not a scene actor: the cover officer takes cover against the car.
    const stop = p.contactPersonId >= 0 ? this.host.traffic.stopState(this.stopScratch) : null;
    if (stop && stop.phase === 'stopped') {
      this.subject.x = stop.x;
      this.subject.z = stop.z;
      c.subject = this.subject;
    } else c.subject = null;
    this.backup.step(dt, t, c);
  }

  stepCommand(dt: number, t: { sim: number; game: number }): void {
    const p = this.player;
    this.host.fillPlayer(p);
    const c = this.commandCtx;
    c.x = p.x;
    c.z = p.z;
    c.yaw = p.yaw;
    c.onFoot = p.onFoot;
    c.building = p.building;
    c.callId = p.callId;
    this.command.step(dt, t, c);
    if (this.command.blockadesRevision !== this.lastBlockRev) {
      this.lastBlockRev = this.command.blockadesRevision;
      this.host.traffic.setBlockades(this.command.blockades());
    }
    if (this.command.zones() !== this.lastCommandZones) this.applyZones();
  }

  // --- No-go zones ------------------------------------------------------------------------------

  /** The investigation module's tape zones (the session's port); merged with the evacuation zones. */
  setInvestigationZones(zones: readonly NoGoZone[]): void {
    this.investigationZones = zones;
    this.applyZones();
  }

  private applyZones(): void {
    const mine = this.command.zones();
    this.lastCommandZones = mine;
    this.host.npc.setNoGoZones(mine.length === 0 ? this.investigationZones : this.investigationZones.concat(mine));
  }

  // --- Fellows for the force system --------------------------------------------------------------

  /** The force system's fellows: the partner plus the backup officers on foot (a reused array). */
  mergeFellows(partner: readonly FellowOfficer[]): readonly FellowOfficer[] {
    const backup = this.backup.fellows();
    if (backup.length === 0) return partner;
    if (partner.length === 0) return backup;
    const out = this.fellowsOut;
    out.length = 0;
    for (const f of partner) out.push(f);
    for (const f of backup) out.push(f);
    return out;
  }

  // --- Save -------------------------------------------------------------------------------------

  serialize(): Phase6Save {
    return {
      roster: this.roster.serialize(),
      resources: this.resources.serialize(),
      backup: this.backup.serialize(),
      pursuit: this.pursuit.serialize(),
      command: this.command.serialize(),
    };
  }

  /** Load order (design 16): roster, resources, backup, pursuit, command (after the court). */
  restore(save: Phase6Save, t: { sim: number; game: number }): void {
    this.roster.restore(save.roster);
    // A migrated save has an empty roster: every AI patrol officer and ranked slot gets its profile again.
    this.ensureRoster();
    this.resources.restore(save.resources, t);
    this.backup.restore(save.backup);
    this.pursuit.restore(save.pursuit);
    this.command.restore(save.command);
    this.lastMinute = -1;
    this.lastBlockRev = -1;
    this.host.traffic.setBlockades(this.command.blockades());
    this.lastBlockRev = this.command.blockadesRevision;
    this.applyZones();
  }

  /** A fresh game's blocks (what `migrateV7ToV8` writes). */
  static freshSave(rng: (name: string) => ReturnType<Rng['state']>): Phase6Save {
    return {
      roster: { version: 1, officers: [] },
      resources: emptyResourceSave(rng('resources')),
      backup: emptyBackupSave(rng('backup')),
      pursuit: emptyPursuitSave(rng('pursuit')),
      command: emptyCommandSave(rng('command')),
    };
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.command.dispose();
    this.backup.dispose();
    this.pursuit.dispose();
    this.resources.dispose();
  }

  // --- Ports ------------------------------------------------------------------------------------

  /** District traffic density times the hour factor at (x, z) (design 20). */
  private trafficDensity(x: number, z: number): number {
    const h = this.host;
    const hour = hourOf(h.env.time.totalSeconds);
    return (DENSITY.district[h.city.districtAt(x, z)] ?? 1) * (DENSITY.hourMultiplier[hour] ?? 1);
  }

  private roadAt(x: number, z: number): { district: string; limitMph: number } {
    const h = this.host;
    const graph = h.city.graph;
    const hit = graph.nearestEdge(x, z, PURSUIT_ROAD_RADIUS, this.roadHit);
    this.roadOut.limitMph = hit ? graph.effectiveSpeedLimitMph(hit.edge, h.env.time) : 0;
    this.roadOut.district = DISTRICT_NAMES[h.city.districtAt(x, z)] ?? '';
    return this.roadOut;
  }

  /** Pose of a unit's car: AI patrol cars through their fleet slot, resource units through the resources module. */
  private unitCar(callsign: string, out: { x: number; z: number; yaw: number }): boolean {
    const u = this.host.cad.unit(callsign);
    if (!u) return false;
    if (u.kind === 'resource') {
      const p = this.poseScratch;
      if (!this.resources.unitPose(callsign, p)) return false;
      out.x = p.x;
      out.z = p.z;
      out.yaw = p.yaw;
      return true;
    }
    if (u.fleetIndex === undefined || u.fleetIndex < 0) return false;
    const fs = this.host.traffic.fleetState(u.fleetIndex, this.fleetScratch);
    if (!fs) return false;
    out.x = fs.x;
    out.z = fs.z;
    out.yaw = fs.yaw;
    return true;
  }

  // --- Bridges (design 14) ----------------------------------------------------------------------

  private wireBridges(): void {
    const h = this.host;
    const bus = h.bus;
    const line = (e: { channel: 'dispatch' | 'tac' | 'car' | 'fireEms' | 'county' | 'state' | 'current'; speaker: string; text: string }): void => {
      h.radio.say(e.channel === 'current' ? h.radio.selected : e.channel, e.text, e.speaker);
    };
    const tacticSeverity = (verdict: string): 'ok' | 'warn' | 'bad' => (verdict === 'outsidePolicy' ? 'bad' : verdict === 'failed' ? 'warn' : 'ok');
    this.offs.push(
      bus.on('resource:radio', line),
      bus.on('backup:radio', line),
      bus.on('pursuit:radio', line),
      bus.on('command:radio', line),
      bus.on('resource:flash', (e) => h.flash(e.text)),
      bus.on('backup:flash', (e) => h.flash(e.text)),
      bus.on('pursuit:flash', (e) => h.flash(e.text)),
      bus.on('command:flash', (e) => h.flash(e.text)),
      bus.on('pursuit:tactic', (e: { tactic: PursuitTactic; verdict: string; text: string }) => h.flash(e.text, tacticSeverity(e.verdict))),
      bus.on('backup:custody', (e) => h.scene.request({ kind: 'custody', callId: e.callId, personId: e.personId, by: e.by })),
      // A call that is over counts as handled for the AI officers who worked it (stress relief, fatigue, the call count).
      bus.on('cad:callClosed', (e) => {
        const call = h.cad.call(e.callId);
        if (!call) return;
        for (const cs of call.units) if (h.cad.unit(cs)?.kind === 'ai') this.roster.applyEvent(cs, 'callHandled');
      }),
      // Radio, voice and MDT requests for a resource unit type go to the resources module (callId 0 = the player's call).
      bus.on('unit:request', (e) => {
        if (e.request.kind !== 'resource') return;
        this.resources.request({ kind: 'request', typeId: e.request.typeId, callId: 0, via: e.via === 'mdt' ? 'mdt' : 'radio' });
      }),
    );
  }
}
