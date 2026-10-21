import '../conduct/events';
import '../fleet/events';
import type { CadTime } from '../cad/types';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import { FleetSystem, type FleetSave, type FleetVehiclePort } from '../fleet';
import { GEAR_POLICY, OfficerGear, defaultGearSave, officerHit, validateOfficerLoadout, type GearSave } from '../gear';
import type { LiveryDoc } from '../livery';
import type { PatrolEquipmentOptions, VehicleEquipmentSpec } from '../police/equipment';
import {
  CHARACTER_LINES,
  aiOutfitSpec,
  applyPronouns,
  buildOutfit,
  characterFromLegacy,
  displayName,
  figureAppearance,
  pronounLabel,
  uniformAllowed,
  type CharacterProfile,
  type FigureAppearance,
  type OutfitDef,
} from '../uniform';
import type { VehicleLoadout } from '../gear/types';
import { extraVestSlots } from '../ui/character/creatorState';
import type { VehicleModel } from '../vehicles/model';

/** Outcome of a round fired at the officer (design §14). */
export type OfficerHitOutcome = 'miss' | 'stopped' | 'wounded';

/**
 * The deduplicated table of outfits the people renderer draws (`PeopleRenderer.setOutfits`): index 0 is always `null`
 * (no accessories). Outfits are keyed by id, colours and shin colour, so two figures in the same uniform share a row.
 */
export class OutfitTable {
  /** Table rows; index 0 is null. Replaced (not mutated) when a row is added so a renderer can compare references. */
  defs: readonly (OutfitDef | null)[] = [null];
  private readonly index = new Map<string, number>();

  /** The row of `def`, added when new. */
  intern(def: OutfitDef): number {
    const key = `${def.id}|${String(def.top)}|${String(def.bottom)}|${String(def.shins)}|${def.hideHair ? 1 : 0}`;
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.defs.length;
      this.defs = [...this.defs, def];
      this.index.set(key, i);
    }
    return i;
  }
}

/** The reads and effects Phase 7 needs of the session. */
export interface Phase7Host {
  readonly seed: number;
  readonly rng: Rng;
  readonly bus: EventBus<EventMap>;
  /** The spawned vehicle of a fleet unit (a `FleetVehiclePort`). */
  unitVehicle(unitId: string): FleetVehiclePort | null;
  /** Pursuit / emergency state of the vehicle `eid` for the damage charge. */
  damageContext(eid: number): { pursuit: boolean; emergency: boolean; callId: number };
  /** Outdoor temperature (C) for AI cold-weather gear. */
  temperatureC(): number;
  /** Shows a HUD legal-line flash. */
  flash(text: string, severity?: 'ok' | 'warn' | 'bad'): void;
  /** The player's radio line on the dispatch channel. */
  say(text: string): void;
  /** The dispatcher's emergency request for the player. */
  emergency(): void;
  /** Places the career points request with the conduct state. */
  careerPoints(delta: number, reason: string, key: string): void;
  /** Distance (m) from the officer on foot to the actor, -1 when the officer is not on foot or the actor is gone. */
  attackerDistance(actorId: number): number;
  /** Where the officer is, in words ("Oak Street at 5th Street"). */
  officerNear(): string;
  /** The player's callsign. */
  readonly callsign: string;
}

/** Per-step reads for the gear warning HUD line. */
export interface GearWarning {
  text: string;
  severity: 'error' | 'warning';
}

/**
 * The gear a new game starts with: the standard patrol loadout plus the evidence kit (the scene kit the Phase 4 work needs),
 * or the plain standard loadout when the kit does not fit.
 */
export function startingGear(): GearSave {
  const save = defaultGearSave();
  const withKit = { assignment: save.loadout.assignment, items: [...save.loadout.items, { id: 'evidenceKit', count: 1 }] };
  return validateOfficerLoadout(withKit, {}).ok ? { ...save, loadout: withKit } : save;
}

/** Livery equipment flags applied to a model's equipment spec: a spotlight or partition the livery leaves off is removed. */
export function equipmentSpecFor(model: VehicleModel, doc: LiveryDoc | null): VehicleEquipmentSpec | null {
  const spec = model.equipment;
  if (!spec) return null;
  if (!doc) return spec;
  return { ...spec, spotlight: spec.spotlight && doc.equipment.spotlight, partition: spec.partition && doc.equipment.partition };
}

/** Spawn options of a unit's equipment: cage seats of the model, trunk and rack of the fleet loadout. */
export function equipmentOptions(model: VehicleModel, loadout: VehicleLoadout | null): PatrolEquipmentOptions {
  return loadout ? { cageSeats: model.patrol.cageSeats, trunk: loadout.trunk, rack: loadout.rack } : { cageSeats: model.patrol.cageSeats };
}

/**
 * Phase 7 of one session (design §20): the officer's character and gear, the fleet system, the outfit table, the
 * officer-hit rolls and the bridges of design §14. Spawning, check-out and the drone live in the session (they own the
 * vehicle lists).
 */
export class Phase7 {
  fleet: FleetSystem;
  readonly outfits = new OutfitTable();
  /** Table index of the officer's outfit and its figure appearance (refreshed by `refreshCharacter`). */
  playerOutfit = 0;
  playerAppearance: FigureAppearance | null = null;
  /** Bumped whenever the profile changes (renderers rebuild the officer figure). */
  characterRevision = 0;
  /** The last shift summary (console, HUD). */
  lastShiftEnd: EventMap['fleet:shiftEnd'] | null = null;
  private gearValue: OfficerGear;
  private profileValue: CharacterProfile;
  private readonly host: Phase7Host;
  private readonly gearRng: Rng;
  private readonly fleetRng: Rng;
  private readonly offs: (() => void)[] = [];
  private readonly attackers: number[] = [];
  private readonly aiLook = new Map<string, number>();
  private readonly appearanceCache = new Map<string, { outfit: number; top: number; bottom: number }>();
  /** Policy flash shown for this uniform and fleet class (once per pair). */
  private policyFlashed = '';
  private warning: GearWarning | null = null;
  private warningFor: unknown = null;

  constructor(host: Phase7Host, character: CharacterProfile, gear: GearSave | null, fleet: FleetSave | null) {
    this.host = host;
    this.gearRng = host.rng.stream('gear');
    this.fleetRng = host.rng.stream('fleet');
    this.gearValue = OfficerGear.restore(gear ?? startingGear());
    this.profileValue = character;
    this.fleet = this.buildFleet(fleet);
    this.refreshCharacter();
    this.wireBridges();
  }

  /** The officer's loadout. */
  get gear(): OfficerGear {
    return this.gearValue;
  }

  /** Replaces the gear (new game from the creator, load); the uniform's carrier bonus is applied again. */
  restoreGear(save: GearSave): void {
    this.gearValue = OfficerGear.restore(save);
    this.gearValue.setExtraVestSlots(extraVestSlots(this.profileValue));
  }

  /** A loaded profile (the session's `officer` record is restored separately). */
  restoreProfile(profile: CharacterProfile): void {
    this.setProfile(profile);
  }

  // --- Character ---------------------------------------------------------------------------

  get profile(): CharacterProfile {
    return this.profileValue;
  }

  /** Replaces the officer's profile (name, badge, pronouns, body, uniform) and rebuilds the figure. */
  setProfile(profile: CharacterProfile): void {
    this.profileValue = profile;
    this.refreshCharacter();
  }

  /** The officer's outfit def and figure appearance, interned in the table. */
  refreshCharacter(): void {
    const p = this.profileValue;
    const def = buildOutfit(p.outfit, { lastName: p.lastName, rank: p.rank });
    this.playerOutfit = this.outfits.intern(def);
    this.playerAppearance = figureAppearance(p, def);
    this.gear.setExtraVestSlots(extraVestSlots(p));
    this.characterRevision++;
  }

  /** Display name and badge as the session's `officer` record keeps them. */
  officerRecord(): { name: string; badge: string } {
    return { name: displayName(this.profileValue), badge: this.profileValue.badge };
  }

  /** Reporting-officer line for MDT reports ("Reporting officer: Officer A B (they/them), badge 4071."). */
  reportHeader(): string {
    const p = this.profileValue;
    return applyPronouns(CHARACTER_LINES.reportHeader ?? '', p.pronouns, {
      name: displayName(p),
      pronouns: pronounLabel(p.pronouns),
      badge: p.badge,
    });
  }

  /**
   * The outfit of an AI officer (cached per callsign): `aiOutfitSpec` from the session seed and the weather at the first call.
   * `swat` operators wear the SWAT class, sergeants a peaked cap.
   */
  appearanceOf(callsign: string, role: 'patrol' | 'supervisor' | 'swat'): { outfit: number; top: number; bottom: number } {
    const key = `${callsign}|${role}`;
    const cached = this.appearanceCache.get(key);
    if (cached) return cached;
    const spec = aiOutfitSpec(this.host.seed, callsign, role, this.host.temperatureC());
    const def = buildOutfit(spec, { lastName: callsign, rank: role === 'supervisor' ? 'sergeant' : 'officer' });
    const look = { outfit: this.outfits.intern(def), top: def.top, bottom: def.bottom };
    this.appearanceCache.set(key, look);
    return look;
  }

  /** Outfit table index of a named AI figure (partner, station staff), cached. */
  aiOutfit(name: string, role: 'patrol' | 'supervisor' | 'swat' | 'detective'): number {
    const key = `${name}|${role}`;
    let i = this.aiLook.get(key);
    if (i === undefined) {
      const spec = aiOutfitSpec(this.host.seed, name, role, this.host.temperatureC());
      i = this.outfits.intern(buildOutfit(spec, { lastName: name, rank: role === 'supervisor' ? 'sergeant' : 'officer' }));
      this.aiLook.set(key, i);
    }
    return i;
  }

  // --- Gear ----------------------------------------------------------------------------------

  /** The first gear error (else a warning) as a HUD line; null when the loadout is fine. Cached until the loadout changes. */
  gearWarning(): GearWarning | null {
    const v = this.gear.validation;
    if (v !== this.warningFor) {
      this.warningFor = v;
      const e = v.errors[0];
      const w = v.warnings[0];
      this.warning = e ? { text: e.message, severity: 'error' } : w ? { text: w.message, severity: 'warning' } : null;
    }
    return this.warning;
  }

  /** Flashes the gear policy errors once (shift start). */
  flashGearErrors(): void {
    const e = this.gear.validation.errors[0];
    if (e) this.host.flash(`Gear: ${e.message}`, 'warn');
  }

  // --- Uniform policy --------------------------------------------------------------------------

  /** Entering a unit of `fleetClass`: a one-time flash when the officer's uniform class breaks its rule. Returns whether it flashed. */
  checkUniformPolicy(fleetClass: string): boolean {
    const uniform = this.profileValue.outfit.uniform;
    if (uniformAllowed(uniform, fleetClass)) return false;
    const key = `${uniform}|${fleetClass}`;
    if (this.policyFlashed === key) return false;
    this.policyFlashed = key;
    this.host.flash(`Policy: the ${fleetClass} unit calls for a different uniform`, 'warn');
    return true;
  }

  // --- Officer hits ------------------------------------------------------------------------------

  /**
   * Resolves the shots queued since the last step against the officer (design §14): each one in range draws two
   * numbers from the `'gear'` stream. Called once per fixed step by the session.
   */
  resolveHits(): void {
    if (this.attackers.length === 0) return;
    const ids = this.attackers.splice(0, this.attackers.length);
    for (const id of ids) {
      const d = this.host.attackerDistance(id);
      if (d < 0 || d > GEAR_POLICY.ballistics.maxRangeM) continue;
      this.hit(this.gear.protection(), d);
    }
  }

  /** Rolls one round fired at the officer from `distanceM` and applies the outcome (radio, dispatch, flash). */
  hit(protection: number, distanceM: number): OfficerHitOutcome {
    const u1 = this.gearRng.next();
    const u2 = this.gearRng.next();
    const outcome = officerHit(u1, u2, protection, distanceM);
    if (outcome === 'miss') return outcome;
    const p = this.profileValue;
    const vars = { name: displayName(p), pronouns: pronounLabel(p.pronouns), callsign: this.host.callsign, near: this.host.officerNear() };
    if (outcome === 'wounded') {
      this.host.say(applyPronouns(CHARACTER_LINES.officerDown ?? '', p.pronouns, vars));
      this.host.emergency();
      this.host.flash('Officer down: you were hit', 'bad');
    } else {
      this.host.say(applyPronouns(CHARACTER_LINES.vestStopped ?? '', p.pronouns, vars));
      this.host.flash('The vest stopped the round', 'ok');
    }
    return outcome;
  }

  // --- Fleet -----------------------------------------------------------------------------------

  /** Builds the fleet system (from a save when given); the previous one must be disposed first. */
  private buildFleet(save: FleetSave | null): FleetSystem {
    return new FleetSystem(
      {
        bus: this.host.bus,
        rng: this.fleetRng,
        vehicleOf: (unitId) => this.host.unitVehicle(unitId),
        damageContext: (eid) => this.host.damageContext(eid),
        officer: () => ({ name: displayName(this.profileValue), badge: this.profileValue.badge, pronouns: this.profileValue.pronouns }),
      },
      save ?? undefined,
    );
  }

  /** Replaces the fleet with one restored from `save` (load; call before any unit is bound). */
  restoreFleet(save: FleetSave): void {
    this.fleet.dispose();
    this.fleet = this.buildFleet(save);
  }

  step(dt: number, t: CadTime): void {
    this.fleet.step(dt, t);
  }

  // --- Bridges (design §14) -------------------------------------------------------------------

  private wireBridges(): void {
    const bus = this.host.bus;
    this.offs.push(
      bus.on('fleet:charge', (e) => this.host.careerPoints(e.points, e.reason, `fleet:${String(e.incidentId)}`)),
      bus.on('fleet:flash', (e) => this.host.flash(e.text)),
      bus.on('conduct:points', (e) => this.host.flash(`Career points ${e.delta > 0 ? '+' : ''}${String(e.delta)}: ${e.reason}`, e.delta < 0 ? 'warn' : 'ok')),
      bus.on('fleet:shiftEnd', (e) => {
        this.lastShiftEnd = e;
      }),
      bus.on('station:loadout', (e) => this.gear.setVest(e.loadout.vest)),
      bus.on('npc:attack', (e) => {
        if (e.kind === 'fire') this.attackers.push(e.actorId);
      }),
    );
  }

  /** Re-derives a character-less default (legacy officer record). */
  static legacyProfile(name: string, badge: string): CharacterProfile {
    return characterFromLegacy(name, badge);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.fleet.dispose();
  }
}
