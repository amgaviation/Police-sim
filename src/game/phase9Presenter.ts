import '../tutorial/events';
import '../force/events';
import '../npc/events';
import '../traffic/events';
import '../vehicles/events';
import type * as THREE from 'three';
import type { AudioEngine } from '../audio/engine';
import type { SirenEmitter } from '../audio/math';
import type { AmbienceParams } from '../audio/ambienceMath';
import { engineProfileFor, type DrivenAudioState, type TrafficAudioSource } from '../audio';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { PrevTransform, Transform } from '../ecs/components';
import type { GameWorld } from '../ecs/world';
import type { WeatherState } from '../environment/weather';
import type { Binding } from '../input/bindings';
import type { NpcSystem } from '../npc';
import type { ActorInfo } from '../npc/types';
import { PoliceLights, SIREN_FLAG, hasPoliceLights } from '../police/components';
import { SIREN_TONES } from '../police/equipment';
import { VfxSystem } from '../render/vfx';
import { PULLOVER } from '../traffic/data';
import { INACTIVE_TUTORIAL_VIEW } from '../tutorial';
import { TutorialCard, TutorialDialog } from '../ui/tutorial';
import type { UIRoot } from '../ui/ui';
import { DISTRICT_NAMES, SURFACE } from '../world/ids';
import { keyLabel } from './hudFeed';
import type { GameSession } from './session';
import { headingOf } from './session';

/** The simulation step rate (Transform - PrevTransform is the velocity per step). */
const STEP_HZ = 60;
/** Velocity components are clamped to this (m/s): a teleport must not become a Doppler shriek. */
const MAX_AUDIO_SPEED = 100;
/** Off-road wheel dust: at most one burst per this many seconds (10 Hz). */
const DUST_PERIOD_S = 0.1;
/** Driven-car speed (m/s) above which loose surfaces throw dust. */
const DUST_MIN_SPEED = 5;
/** Impact speed (m/s) a traffic collision needs to throw sparks. */
const SPARK_MIN_SPEED = 3;
/** Impact speed (m/s) that maps to full spark intensity. */
const SPARK_FULL_SPEED = 15;
const MUZZLE_Y = 1.4;
const CHEST_Y = 1.2;
/** Where the TASER probes leave the officer (m ahead of the officer along the aim). */
const HAND_REACH = 0.4;

const LOOSE_SURFACES: readonly number[] = [SURFACE.gravel, SURFACE.dirt, SURFACE.sand, SURFACE.grass];

/** What the presentation reads of the app. */
export interface Phase9PresenterDeps {
  session(): GameSession | null;
  flash(text: string): void;
  /** The camera's horizontal forward direction (the aim of a shot). */
  aim(): { x: number; z: number };
  /** The player's bindings (tutorial key labels). */
  bindings(): Readonly<Record<string, readonly Binding[] | undefined>>;
}

function clamp(v: number, lim: number): number {
  return v < -lim ? -lim : v > lim ? lim : v;
}

/**
 * Phase 9 presentation (design §13, §19.3): the effects system and its bridges from simulation events, the audio frame
 * (listener and emitter velocities, driven engine state, traffic engines, ambience) and the tutorial card and dialog. Reads
 * the session, never writes simulation state (the tutorial buttons queue commands the runner applies in its fixed step).
 */
export class Phase9Presenter {
  readonly vfx: VfxSystem;
  readonly card: TutorialCard;
  readonly dialog: TutorialDialog;
  /** Siren emitters rebuilt every frame (reused objects). */
  private readonly emitters: SirenEmitter[] = [];
  private readonly driven: DrivenAudioState = {
    active: false,
    profile: null,
    rpm: 0,
    throttle: 0,
    running: false,
    speed: 0,
    groundSpeed: 0,
    brake: 0,
    handbrake: false,
    absActive: false,
    surface: 0,
    airborne: false,
    inCabin: false,
    x: 0,
    y: 0,
    z: 0,
  };
  private readonly traffic: TrafficAudioSource[] = [];
  private readonly ambience: AmbienceParams = { district: 'downtown', hour: 12, weather: 'clear', rain: 0, wind: 0, indoor: false, inCabin: false };
  private readonly actor = {} as ActorInfo;
  private readonly hand: { x: number; y: number; z: number } = { x: 0, y: MUZZLE_Y, z: 0 };
  private readonly chest: { x: number; y: number; z: number } = { x: 0, y: CHEST_Y, z: 0 };
  private readonly at = { x: 0, z: 0 };
  private readonly offs: (() => void)[] = [];
  private readonly deps: Phase9PresenterDeps;
  private readonly world: GameWorld;
  private readonly audio: AudioEngine;
  private readonly labelOf: (actionId: string) => string;
  /** The actor the last TASER shot hit (the arc ends on it while the probes are attached). */
  private arcActor = -1;
  private nextDustS = 0;
  private dustRight = false;
  private clockS = 0;

  constructor(scene: THREE.Scene | null, ui: UIRoot, bus: EventBus<EventMap>, audio: AudioEngine, world: GameWorld, deps: Phase9PresenterDeps) {
    this.deps = deps;
    this.world = world;
    this.audio = audio;
    this.vfx = new VfxSystem(scene);
    this.card = new TutorialCard(ui.hud);
    this.dialog = new TutorialDialog(ui, {
      ack: () => this.deps.session()?.phase9.runner?.ack(),
      end: () => this.deps.session()?.phase9.runner?.end(),
    });
    this.labelOf = (actionId) => {
      const bindings = this.deps.bindings()[actionId];
      if (bindings === undefined) return '';
      const label = keyLabel(bindings);
      return label === '?' ? '' : label;
    };
    this.offs.push(
      bus.on('tutorial:flash', (e) => this.deps.flash(e.text)),
      bus.on('tutorial:done', (e) => this.deps.flash(e.completed ? 'Tutorial complete' : 'Tutorial ended')),
      bus.on('force:applied', (e) => this.onForce(e.tool, e.actorId, e.hit)),
      bus.on('npc:attack', (e) => {
        if (e.kind === 'fire') this.onNpcFire(e.actorId);
      }),
      bus.on('vehicle:damaged', (e) => this.onVehicleDamaged(e.eid, e.zone, e.impactSpeed)),
      bus.on('traffic:collision', (e) => {
        if (e.impactSpeed > SPARK_MIN_SPEED) {
          this.vfx.burst('spark', Transform.x[e.eid] ?? 0, 0.5, Transform.z[e.eid] ?? 0, 0, 0, 0, clamp01(e.impactSpeed / SPARK_FULL_SPEED));
        }
      }),
    );
  }

  /** A new session starts: nothing carried over. */
  begin(): void {
    this.arcActor = -1;
    this.nextDustS = 0;
    this.dialog.close();
  }

  /** The session ends. */
  end(): void {
    this.arcActor = -1;
    this.vfx.arc(null);
    this.card.update(INACTIVE_TUTORIAL_VIEW, this.labelOf);
    this.dialog.sync(INACTIVE_TUTORIAL_VIEW, this.labelOf);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.card.dispose();
    this.dialog.dispose();
    this.vfx.dispose();
  }

  // --- tutorial ----------------------------------------------------------------

  /** Card and dialog follow the runner's view (both are revision-driven and cheap when nothing changed). */
  updateTutorial(session: GameSession): void {
    const view = session.phase9.runner?.view ?? INACTIVE_TUTORIAL_VIEW;
    this.card.update(view, this.labelOf);
    this.dialog.sync(view, this.labelOf);
  }

  // --- effects -----------------------------------------------------------------

  /** Per frame after the car renderer: TASER arc, off-road dust and the effects update. */
  updateVfx(session: GameSession, camera: THREE.Camera, dt: number, weather: Readonly<WeatherState>, night: number): void {
    this.clockS += dt;
    this.updateArc(session);
    this.updateDust(session);
    const rain = Math.min(1, weather.precipitation) * (1 - weather.precipSnow);
    this.vfx.update(camera, dt, night, weather.fogDensity, rain);
  }

  private updateArc(session: GameSession): void {
    const force = session.force;
    if (!force.hud.attached || this.arcActor < 0) {
      this.vfx.arc(null);
      return;
    }
    const npc: NpcSystem = session.npc;
    const info = npc.actor(this.arcActor, this.actor);
    if (!info || info.hidden) {
      this.vfx.arc(null);
      return;
    }
    const at = session.playerPosition(this.at);
    const aim = this.deps.aim();
    const hand = this.hand;
    hand.x = at.x + aim.x * HAND_REACH;
    hand.z = at.z + aim.z * HAND_REACH;
    const chest = this.chest;
    chest.x = info.x;
    chest.z = info.z;
    this.vfx.arc(hand, chest);
  }

  private updateDust(session: GameSession): void {
    const car = session.drivenVehicle;
    if (car === null || this.clockS < this.nextDustS) return;
    const tel = car.telemetry;
    if (tel.airborne || tel.groundSpeed < DUST_MIN_SPEED) return;
    const rl = LOOSE_SURFACES.includes(tel.wheelSurface[2]);
    const rr = LOOSE_SURFACES.includes(tel.wheelSurface[3]);
    if (!rl && !rr) return;
    this.nextDustS = this.clockS + DUST_PERIOD_S;
    this.dustRight = rl && rr ? !this.dustRight : rr;
    const eid = car.eid;
    const yaw = headingOf(Transform.qx[eid] ?? 0, Transform.qy[eid] ?? 0, Transform.qz[eid] ?? 0, Transform.qw[eid] ?? 1);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const back = car.model.body.wheelbase / 2;
    const side = (car.model.body.track / 2) * (this.dustRight ? 1 : -1);
    // Forward is (-sin, -cos); right is (cos, -sin).
    const x = (Transform.x[eid] ?? 0) + sin * back + cos * side;
    const z = (Transform.z[eid] ?? 0) + cos * back - sin * side;
    this.vfx.burst('dust', x, 0.15, z, 0, 0, 0, 0.3);
  }

  private onForce(tool: string, actorId: number, hit: boolean): void {
    const session = this.deps.session();
    if (!session) return;
    const at = session.playerPosition(this.at);
    const aim = this.deps.aim();
    if (tool === 'firearm' || tool === 'lessLethal') {
      this.vfx.muzzle(at.x, MUZZLE_Y, at.z, aim.x, aim.z);
      if (hit) this.hitDust(session, actorId);
    } else if (tool === 'taser') {
      this.vfx.burst('taser', at.x + aim.x * HAND_REACH, MUZZLE_Y - 0.15, at.z + aim.z * HAND_REACH, aim.x, 0, aim.z, 1);
      if (hit) this.arcActor = actorId;
    }
  }

  private hitDust(session: GameSession, actorId: number): void {
    const info = actorId >= 0 ? session.npc.actor(actorId, this.actor) : null;
    if (info) this.vfx.burst('dust', info.x, CHEST_Y, info.z, 0, 0, 0, 0.4);
  }

  private onNpcFire(actorId: number): void {
    const session = this.deps.session();
    const info = session && actorId >= 0 ? session.npc.actor(actorId, this.actor) : null;
    if (!info) return;
    this.vfx.muzzle(info.x, MUZZLE_Y, info.z, -Math.sin(info.yaw), -Math.cos(info.yaw));
  }

  /** Sparks and dust at the damaged zone: the vehicle's position plus half its length (front / rear) or width (left / right). */
  private onVehicleDamaged(eid: number, zone: string, impactSpeed: number): void {
    const session = this.deps.session();
    const car = session?.vehicles.find((v) => v.eid === eid);
    if (!car) return;
    const yaw = headingOf(Transform.qx[eid] ?? 0, Transform.qy[eid] ?? 0, Transform.qz[eid] ?? 0, Transform.qw[eid] ?? 1);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const half = zone === 'front' || zone === 'rear' ? car.model.body.length / 2 : car.model.body.width / 2;
    const sign = zone === 'front' || zone === 'right' ? 1 : -1;
    const along = zone === 'front' || zone === 'rear';
    const x = (Transform.x[eid] ?? 0) + (along ? fx : rx) * half * sign;
    const z = (Transform.z[eid] ?? 0) + (along ? fz : rz) * half * sign;
    const intensity = clamp01(impactSpeed / SPARK_FULL_SPEED);
    this.vfx.burst('spark', x, 0.5, z, 0, 0, 0, intensity);
    this.vfx.burst('dust', x, 0.5, z, 0, 0, 0, intensity * 0.6);
  }

  // --- audio -------------------------------------------------------------------

  /**
   * Per frame, before the HUD: the listener (camera; the officer's eyes headless) with its velocity, the siren emitters with
   * their velocities, the driven engine and the nearby traffic engines, the ambience. All AudioParam writes; a no-op until
   * the engine is unlocked.
   */
  updateAudio(session: GameSession, camera: THREE.Camera | null, dt: number, inCabin: boolean): void {
    const audio = this.audio;
    if (!audio.unlocked) return;
    let lx: number;
    let lz: number;
    if (camera) {
      camera.updateMatrixWorld();
      const e = camera.matrixWorld.elements;
      // Camera looks down -Z, up is +Y (matrix columns: right, up, back, position).
      lx = e[12] ?? 0;
      lz = e[14] ?? 0;
      audio.setListener(lx, e[13] ?? 0, lz, -(e[8] ?? 0), -(e[9] ?? 0), -(e[10] ?? 1), e[4] ?? 0, e[5] ?? 1, e[6] ?? 0);
    } else {
      const at = session.playerPosition(this.at);
      lx = at.x;
      lz = at.z;
      audio.setListener(lx, 1.6, lz, 0, 0, -1, 0, 1, 0);
    }
    const controlled = session.controlledVehicle;
    const body = controlled ? session.physics.getBody(controlled.eid) : undefined;
    if (body) {
      const v = body.linvel();
      audio.setListenerVelocity(clamp(v.x, MAX_AUDIO_SPEED), clamp(v.y, MAX_AUDIO_SPEED), clamp(v.z, MAX_AUDIO_SPEED));
    } else {
      const eid = session.player;
      audio.setListenerVelocity(
        clamp(((Transform.x[eid] ?? 0) - (PrevTransform.x[eid] ?? 0)) * STEP_HZ, MAX_AUDIO_SPEED),
        0,
        clamp(((Transform.z[eid] ?? 0) - (PrevTransform.z[eid] ?? 0)) * STEP_HZ, MAX_AUDIO_SPEED),
      );
    }
    this.updateSirens(session, lx, lz);
    this.updateEngines(session, inCabin);
    this.updateAmbience(session, lx, lz, dt, inCabin);
  }

  private updateSirens(session: GameSession, lx: number, lz: number): void {
    const driven = session.drivenVehicle?.eid ?? 0;
    let n = 0;
    for (const vehicle of session.vehicles) {
      if (session.equipmentOf(vehicle)) n = this.addEmitter(n, vehicle.eid, vehicle.eid === driven);
    }
    const traffic = session.traffic;
    for (let i = 0; i < PULLOVER.fleet.maxCars; i++) {
      const eid = traffic.fleetEntity(i);
      if (eid !== 0) n = this.addEmitter(n, eid, false);
    }
    this.audio.sirens.update(this.emitters, n, lx, lz);
  }

  /** Writes emitter `n` from the `PoliceLights` of `eid` (skipped without the component); returns the new count. */
  private addEmitter(n: number, eid: number, inCabin: boolean): number {
    if (!hasPoliceLights(this.world, eid)) return n;
    let e = this.emitters[n];
    if (!e) {
      e = { id: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, tone: null, horn: false, manual: false, inCabin: false };
      this.emitters.push(e);
    }
    const siren = PoliceLights.siren[eid] ?? 0;
    const flags = PoliceLights.sirenFlags[eid] ?? 0;
    const x = Transform.x[eid] ?? 0;
    const y = Transform.y[eid] ?? 0;
    const z = Transform.z[eid] ?? 0;
    e.id = eid;
    e.x = x;
    e.y = y;
    e.z = z;
    e.vx = clamp((x - (PrevTransform.x[eid] ?? x)) * STEP_HZ, MAX_AUDIO_SPEED);
    e.vy = clamp((y - (PrevTransform.y[eid] ?? y)) * STEP_HZ, MAX_AUDIO_SPEED);
    e.vz = clamp((z - (PrevTransform.z[eid] ?? z)) * STEP_HZ, MAX_AUDIO_SPEED);
    e.tone = siren > 0 ? (SIREN_TONES[siren - 1] ?? null) : null;
    e.horn = (flags & SIREN_FLAG.horn) !== 0;
    e.manual = (flags & SIREN_FLAG.manual) !== 0;
    e.inCabin = inCabin;
    return n + 1;
  }

  private updateEngines(session: GameSession, inCabin: boolean): void {
    const d = this.driven;
    const car = session.controlledVehicle;
    if (car === null) {
      d.active = false;
    } else {
      const tel = car.telemetry;
      d.active = true;
      d.profile = engineProfileFor(car.model.control, car.model.body.style);
      d.rpm = tel.rpm;
      d.throttle = tel.throttle;
      d.running = tel.engineRunning;
      d.speed = tel.speed;
      d.groundSpeed = tel.groundSpeed;
      d.brake = tel.brake;
      d.handbrake = tel.handbrake;
      d.absActive = tel.absActive;
      d.surface = tel.wheelSurface[0];
      d.airborne = tel.airborne;
      d.inCabin = inCabin;
      d.x = Transform.x[car.eid] ?? 0;
      d.y = Transform.y[car.eid] ?? 0;
      d.z = Transform.z[car.eid] ?? 0;
    }
    const view = session.traffic.view;
    const count = view.count;
    while (this.traffic.length < count) this.traffic.push({ id: 0, x: 0, y: 0.6, z: 0, speed: 0 });
    for (let i = 0; i < count; i++) {
      const t = this.traffic[i] as TrafficAudioSource;
      t.id = view.eid[i] ?? 0;
      t.x = view.x[i] ?? 0;
      t.z = view.z[i] ?? 0;
      t.speed = view.speed[i] ?? 0;
    }
    this.audio.vehicles.update(d, this.traffic, count);
  }

  private updateAmbience(session: GameSession, lx: number, lz: number, dt: number, inCabin: boolean): void {
    const p = this.ambience;
    const env = session.env;
    const weather = env.weather;
    p.district = DISTRICT_NAMES[session.city.districtAt(lx, lz)] ?? 'water';
    p.hour = env.time.hour;
    p.weather = weather.kind;
    p.rain = Math.min(1, weather.precipitation) * (1 - weather.precipSnow);
    p.wind = Math.hypot(weather.windX, weather.windZ);
    p.indoor = session.officerBuilding >= 0;
    p.inCabin = inCabin;
    this.audio.ambience.update(p, dt);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
