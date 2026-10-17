import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { EventMap } from './core/event-map';
import { bus, type EventBus } from './core/events';
import { log } from './core/log';
import { GameLoop, type LoopHooks } from './core/loop';
import { createRng, normalizeSeed } from './core/rng';
import { DebugConsole } from './debug/console';
import { PerfOverlay, type PerfSample } from './debug/perfOverlay';
import { createWorldCommands, type WorldCommandDeps } from './debug/worldCommands';
import { Transform } from './ecs/components';
import { SystemRegistry, copyPrevTransform, integrateVelocity, type System } from './ecs/systems';
import { clearWorld, createGameWorld, entityCount, type GameWorld } from './ecs/world';
import { EnvironmentRenderer } from './environment/render/environmentRenderer';
import { createCommands } from './game/commands';
import { HudFeed, interactPrompt, keyLabel } from './game/hudFeed';
import { PauseMenu } from './game/pauseMenu';
import type { MoveInput } from './game/playerController';
import {
  GameSession,
  createScenePhysics,
  headingOf,
  loadGame,
  serializeGame,
  startNewGame,
  type GameContext,
  type InteractResult,
} from './game/session';
import { WorldView } from './game/worldView';
import { InputManager } from './input/input';
import { initRapier, type PhysicsWorld, type Vec3 } from './physics/physics';
import { CAMERA_MODE_NAMES, CameraRig, type CameraRaycast, type FollowTarget, type LookInput } from './player/cameraRig';
import { readDriverInput } from './player/driverInput';
import { MeshRegistry, interpolateTransform } from './render/meshSync';
import { Renderer } from './render/renderer';
import { CarRenderer } from './render/vehicles/carRenderer';
import { MIGRATION_FAILURES, SaveMigrationError } from './save/migrations';
import type { SaveGame } from './save/schema';
import { SaveManager, SaveNotFoundError } from './save/saveManager';
import { SettingsStore } from './settings/settings';
import { vehicleIdFromPlate, vehicleRecord } from './traffic/registry';
import { Hud } from './ui/hud/hud';
import type { TrafficDots } from './ui/hud/minimap';
import { MainMenu } from './ui/mainMenu';
import { SettingsMenu } from './ui/settingsMenu';
import { UIRoot } from './ui/ui';
import { vehicleModel } from './vehicles/model';
import { createSimWorker } from './workers/createSimWorker';
import type { WorkerRequestMap } from './workers/protocol';
import type { WorkerClient } from './workers/workerClient';
import type { City } from './world/city';
import { generateCity } from './world/generate';
import type { ChunkWorkerMap } from './world/render/chunkProtocol';
import { createChunkWorker } from './world/render/createChunkWorker';

export const SIM_HZ = 60;
export const AUTOSAVE_INTERVAL_MS = 60_000;
export const WORKER_PING_INTERVAL_MS = 2_000;
/** HUD, minimap and road lookups refresh at this interval (10 Hz). */
export const HUD_INTERVAL_MS = 100;
/** Perf overlay extras (chunks, traffic, cars) refresh at this interval. */
const PERF_EXTRAS_INTERVAL_MS = 250;
/** How long a one-off hint (exit blocked, refuelled, repaired) replaces the prompt line. */
const FLASH_MS = 2500;
const FIXED_DT = 1 / SIM_HZ;
const QUICKSAVE_SLOT = 'quicksave';
const DETERMINISM_SEED = 12345;
const DETERMINISM_SAMPLES = 8;

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchVel: Vec3 = { x: 0, y: 0, z: 0 };
const scratchPoint = { x: 0, z: 0 };

/** Player-facing line for an `interact` that did something other than get in or out. */
const INTERACT_FLASH: Partial<Record<InteractResult, string>> = {
  exitBlocked: 'Both doors are blocked',
  tooFast: 'Stop the vehicle to get out',
  refuelled: 'Refuelled',
  repaired: 'Repaired and refuelled',
};

/**
 * Composition root: owns every subsystem and wires them into the game loop.
 * Create with `App.create()`, then `start()`; `dispose()` tears everything down.
 */
export class App {
  readonly bus: EventBus<EventMap> = bus;
  readonly settings: SettingsStore;
  readonly input: InputManager;
  /** Null when WebGL could not be created; the simulation still runs headless. */
  readonly renderer: Renderer | null;
  readonly scene: THREE.Scene;
  readonly world: GameWorld;
  readonly systems = new SystemRegistry();
  readonly meshes: MeshRegistry;
  readonly loop: GameLoop;
  readonly perf: PerfOverlay;
  readonly console: DebugConsole;
  readonly ui: UIRoot;
  readonly mainMenu: MainMenu;
  readonly settingsMenu: SettingsMenu;
  readonly pauseMenu: PauseMenu;
  readonly saves: SaveManager;
  readonly worker: WorkerClient<WorkerRequestMap> | null;
  /** Chunk meshing worker shared by every session's streamer; null without workers or a renderer. */
  readonly chunkWorker: WorkerClient<ChunkWorkerMap> | null;
  readonly rig: CameraRig;
  readonly hud: Hud;
  /** Sky, sun/moon, fog and precipitation (null without a renderer). */
  readonly envRenderer: EnvironmentRenderer | null;
  readonly carRenderer: CarRenderer | null;

  private sessionValue: GameSession | null = null;
  /** Replaced for every session: Rapier does not return to a pristine state after bodies are removed. */
  private physicsValue: PhysicsWorld;
  /** Render side of the running session's city (chunks, signals, streetlights, minimap). */
  private view: WorldView | null = null;
  /** Last generated city; `generateCity` is pure, so a session with the same seed reuses it. */
  private cityCache: City | null = null;
  private detachSystems: (() => void) | null = null;
  /** Route polyline set by the `route` command, drawn on the minimap. */
  private route: Float32Array | null = null;
  /** Pause requested from the console; the loop is paused while this or a menu is up. */
  private userPausedValue = false;
  private readonly moveInput: MoveInput = { forward: 0, strafe: 0, sprint: false };
  private readonly perfSample: PerfSample;
  private readonly hudFeed = new HudFeed();
  private readonly follow: FollowTarget = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vz: 0 };
  private readonly look: LookInput = { mouseX: 0, mouseY: 0, stickX: 0, stickY: 0, sensitivity: 1, invertY: false };
  private readonly trafficDots: TrafficDots = { count: 0, x: new Float32Array(0), z: new Float32Array(0) };
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  /** Chase-camera wall test: static colliders only, so neither the driven car nor traffic pulls it in. */
  private readonly cameraRaycast: CameraRaycast;
  private flashText = '';
  private flashUntilMs = 0;
  /** The heat-haze programs were compiled for this session's city (`prewarmHaze`). */
  private hazeWarm = false;
  private interactKey = 'E';
  /** Settings read every frame, cached here (refreshed by the settings subscription) so frames do not allocate. */
  private mouseSensitivity = 1;
  private invertY = false;
  private reducedFlash = false;
  private nextHudMs = 0;
  private nextPerfExtrasMs = 0;
  /** Real seconds of rendered frames (drives light-bar and hazard flashing). */
  private renderTime = 0;
  private menuChangedSinceUpdate = false;
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  private constructor(settings: SettingsStore) {
    this.settings = settings;
    this.physicsValue = createScenePhysics(FIXED_DT);
    this.world = createGameWorld();

    this.renderer = createRenderer(settings);
    this.scene = this.renderer?.scene ?? new THREE.Scene();
    const shadows = settings.get('graphics.shadows');
    this.renderer?.setShadows(shadows);
    this.renderer?.setDrawDistance(settings.get('graphics.drawDistance'));
    this.envRenderer = this.renderer ? new EnvironmentRenderer(this.scene, this.renderer, { shadows }) : null;
    this.carRenderer = this.renderer ? new CarRenderer(this.scene, this.world, { shadows: shadows === 'high' }) : null;

    this.meshes = new MeshRegistry(this.scene, { world: this.world });
    this.input = new InputManager({
      bus: this.bus,
      bindings: settings.get('controls.bindings'),
      deadzone: settings.get('controls.gamepadDeadzone'),
    });
    this.rig = new CameraRig(this.bus);
    this.cameraRaycast = (ox, oy, oz, dx, dy, dz, maxDistance) => {
      const ray = this.ray;
      ray.origin.x = ox;
      ray.origin.y = oy;
      ray.origin.z = oz;
      ray.dir.x = dx;
      ray.dir.y = dy;
      ray.dir.z = dz;
      const hit = this.physicsValue.raw.castRay(ray, maxDistance, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
      return hit ? hit.timeOfImpact : Infinity;
    };

    this.ui = new UIRoot();
    this.disposers.push(this.ui.bindSettings(settings));
    this.perf = new PerfOverlay({ parent: this.ui.hud });
    this.console = new DebugConsole({ parent: this.ui.hud, bus: this.bus });
    this.hud = new Hud(this.ui.hud);
    this.hud.setVisible(false);
    for (const command of createCommands(this)) this.console.register(command);
    for (const command of createWorldCommands(this.worldCommandDeps())) this.console.register(command);

    this.saves = new SaveManager({ bus: this.bus });
    this.settingsMenu = new SettingsMenu(this.ui, settings, this.input);
    this.mainMenu = new MainMenu(this.ui, {
      newGame: (seed) => {
        // Generating the city blocks the main thread for a moment: show why first.
        this.mainMenu.setStatus('Generating city...');
        afterPaint(() => {
          try {
            this.newGame(seed);
          } catch (error) {
            log.error('New game failed:', error);
            this.mainMenu.setStatus('Could not start a new shift; see console');
          }
        });
      },
      continueGame: (slot) => {
        this.mainMenu.setStatus(`Loading '${slot}'...`);
        this.loadGame(slot).catch((error: unknown) => {
          log.error(`Load '${slot}' failed:`, error);
          this.mainMenu.setStatus(describeLoadError(slot, error));
        });
      },
      openSettings: () => this.settingsMenu.open(),
      deleteSave: (slot) => {
        this.deleteSave(slot).catch((error: unknown) => {
          log.error(`Delete '${slot}' failed:`, error);
          this.mainMenu.setStatus(`Could not delete '${slot}'; see console`);
        });
      },
    });
    this.pauseMenu = new PauseMenu(this.ui, {
      resume: () => this.pauseMenu.close(),
      quickSave: () => void this.quickSave(),
      openSettings: () => this.settingsMenu.open(),
      quitToTitle: () => this.quitToTitle(),
    });

    this.systems.register(copyPrevTransform, -1000);
    this.systems.register(integrateVelocity, 0);
    this.systems.register(this.physicsSystem(), 100);

    this.perfSample = { fps: 0, frameMs: 0, simMs: 0, steps: 0, drawCalls: 0, triangles: 0, entities: 0, systemTimings: this.systems.timings };
    const hooks: LoopHooks = {
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      update: (dt, alpha) => this.update(dt, alpha),
      render: (alpha) => this.render(alpha),
    };
    this.loop = new GameLoop({ hooks, simHz: SIM_HZ });
    this.loop.frameCap = settings.get('graphics.frameCap');

    this.worker = createWorker();
    this.chunkWorker = this.renderer ? createChunkWorkerOrNull() : null;
    this.wireEvents();
  }

  /** Loads settings (defaults if storage is unavailable), initialises Rapier and builds the app. */
  static async create(): Promise<App> {
    const settings = new SettingsStore();
    await settings.load();
    await initRapier();
    return new App(settings);
  }

  get session(): GameSession | null {
    return this.sessionValue;
  }

  /** Physics world of the current session (a fresh one is created for every session). */
  get physics(): PhysicsWorld {
    return this.physicsValue;
  }

  /** Render side of the running session's city, null without a session. */
  get worldView(): WorldView | null {
    return this.view;
  }

  /** Console-requested pause, independent of menus. */
  get userPaused(): boolean {
    return this.userPausedValue;
  }

  setUserPaused(paused: boolean): void {
    this.userPausedValue = paused;
    this.refreshPause();
  }

  /** Sets the running session's time scale (0 freezes the simulation). */
  setTimeScale(scale: number): void {
    const session = this.sessionValue;
    if (!session) throw new Error('No game running');
    session.clock.setTimeScale(scale);
    this.loop.timeScale = scale;
  }

  get inGame(): boolean {
    return this.sessionValue !== null;
  }

  /** Attaches input, shows the title screen and starts the loop. */
  start(): void {
    const target = this.renderer?.canvas ?? window;
    this.input.attach(target);
    this.mainMenu.open(); // pauses the loop through refreshPause
    void this.refreshSaveList();
    this.startWorkerPing();
    this.loop.start();
    this.bus.emit('app:ready', {});
    log.info('Patrol ready', this.renderer ? '(WebGL)' : '(no renderer)');
  }

  /** Replaces the running session with a fresh shift in the city of `seed`. */
  newGame(seed: number | string): GameSession {
    this.endSession();
    this.resetSimulation();
    const session = startNewGame(this.context(normalizeSeed(seed)), seed);
    this.beginSession(session);
    log.info(`New game, seed ${String(session.seed)}`);
    return session;
  }

  /** Serializes the running session (throws when none is running). */
  serializeGame(): SaveGame {
    if (!this.sessionValue) throw new Error('No game running');
    return serializeGame(this.sessionValue);
  }

  async saveGame(slot: string): Promise<void> {
    await this.saves.save(slot, this.serializeGame());
  }

  /**
   * Loads `slot` and rebuilds the session from it (the city is regenerated from its seed).
   * A save that cannot be read leaves the running session untouched; one that fails
   * while rebuilding returns to the title screen. Either way the promise rejects.
   */
  async loadGame(slot: string): Promise<GameSession> {
    const envelope = await this.saves.load(slot);
    this.endSession();
    this.resetSimulation();
    let session: GameSession;
    try {
      session = loadGame(this.context(normalizeSeed(envelope.data.seed)), envelope);
    } catch (error) {
      this.quitToTitle();
      throw error;
    }
    this.beginSession(session);
    log.info(`Loaded '${slot}' (seed ${String(session.seed)}, ${String(session.entityCount)} entities)`);
    return session;
  }

  async deleteSave(slot: string): Promise<void> {
    await this.saves.delete(slot);
    await this.refreshSaveList();
  }

  /** Ends the session and returns to the title screen. */
  quitToTitle(): void {
    this.endSession();
    this.ui.closeAll();
    this.mainMenu.open();
    void this.refreshSaveList();
  }

  /** Seats the officer in the session's vehicle `index` without walking to it (scripts, smoke test). */
  enterVehicle(index = 0): boolean {
    const session = this.requireSession();
    const vehicle = session.vehicles[index];
    if (!vehicle || !session.enterVehicle(vehicle)) return false;
    this.rig.setVehicle(vehicle.model.body);
    return true;
  }

  /** Moves the officer (or the driven car) to (x, z), optionally facing `yaw`, with colliders and traffic around the new spot. */
  teleport(x: number, z: number, yaw?: number): void {
    this.requireSession().teleport(x, z, yaw);
    this.rig.snap();
  }

  /** Pointer lock is wanted only while playing with no menu, console or debug camera active. */
  refreshPointerLock(): void {
    const wanted = this.inGame && !this.ui.isMenuOpen() && !this.console.isOpen() && !(this.renderer?.debugCameraEnabled ?? false);
    this.input.setPointerLockEnabled(wanted);
  }

  /** Stops the loop and releases every resource; the instance is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    if (this.workerTimer !== null) clearInterval(this.workerTimer);
    this.endSession();
    for (const dispose of this.disposers) dispose();
    this.worker?.terminate();
    this.chunkWorker?.terminate();
    this.input.detach();
    this.hud.dispose();
    this.console.dispose();
    this.perf.dispose();
    this.ui.dispose();
    this.envRenderer?.dispose();
    this.carRenderer?.dispose();
    this.meshes.dispose();
    this.renderer?.dispose();
    this.physicsValue.dispose();
    this.saves.close();
    this.settings.dispose();
  }

  // --- loop hooks -------------------------------------------------------------

  /**
   * Exactly one simulation step per loop step: the time scale is applied by
   * the loop, so its interpolation alpha always matches Prev/Transform.
   */
  private fixedUpdate(dt: number): void {
    const session = this.sessionValue;
    if (!session) return;
    session.fixedUpdate(this.moveInput);
    this.systems.runAll(this.world, dt);
    this.bus.emit('loop:fixed', { dt, step: this.world.time.step });
  }

  /** Design §13 frame order: input, actions, controls, camera, environment and city, cars, HUD. */
  private update(dt: number, alpha: number): void {
    this.input.update();
    this.handleToggles();
    this.menuChangedSinceUpdate = false;
    const session = this.sessionValue;
    if (!session) return;

    const controlsActive = !this.ui.isMenuOpen() && !this.console.isOpen();
    const debugCam = this.renderer?.debugCameraEnabled ?? false;
    if (controlsActive) this.handleActions(session);
    this.readControls(session, dt, controlsActive && !debugCam);
    if (this.renderer && !debugCam) this.updateCamera(session, this.renderer.camera, dt, alpha, controlsActive);
    this.updateWorld(session, dt, alpha);
    this.updateHud(session);
  }

  private render(alpha: number): void {
    this.meshes.syncFromEcs(alpha);
    this.renderer?.render();
    const s = this.perfSample;
    const stats = this.loop.stats;
    s.fps = stats.fps;
    s.frameMs = stats.frameMs;
    s.simMs = stats.simMs;
    s.steps = stats.stepsLastFrame;
    s.drawCalls = this.renderer?.stats.drawCalls ?? 0;
    s.triangles = this.renderer?.stats.triangles ?? 0;
    s.entities = entityCount(this.world);
    this.perf.record(s);
    if (this.perf.visible) this.updatePerfExtras();
  }

  private handleToggles(): void {
    const input = this.input;
    if (input.wasPressed('perf.toggle')) this.perf.toggle();
    if (input.wasPressed('console.toggle')) {
      this.console.toggle();
      this.refreshPointerLock();
    }
    if (input.wasPressed('menu.toggle') && this.console.isOpen()) {
      // Escape typed into the console closes the console, not the menu underneath.
      this.console.close();
      this.refreshPointerLock();
    } else if (input.wasPressed('menu.toggle') && this.inGame && !this.menuChangedSinceUpdate) {
      // A menu that closed itself on this key press (e.g. Settings on Escape) must not re-toggle.
      if (!this.ui.isMenuOpen()) this.pauseMenu.open();
      else if (this.ui.top === this.pauseMenu) this.pauseMenu.close();
    }
  }

  /** Mode actions: interact (enter, exit, refuel), map zoom, and while driving camera, headlights, light bar. */
  private handleActions(session: GameSession): void {
    const input = this.input;
    if (input.wasPressed('interact')) this.interact(session);
    if (input.wasPressed('map.toggle')) this.view?.minimap.toggleZoom();
    if (!session.driving) return;
    if (input.wasPressed('camera.toggle')) {
      this.rig.cycleVehicleMode();
      session.cameraMode = this.rig.vehicleMode;
    }
    if (input.wasPressed('vehicle.headlights')) session.toggleHeadlights();
    if (input.wasPressed('vehicle.lights')) session.toggleLightbar();
  }

  private interact(session: GameSession): void {
    const result = session.interact();
    if (result === 'entered') this.rig.setVehicle(session.drivenVehicle?.model.body ?? null);
    else if (result === 'exited') this.rig.setVehicle(null);
    const flash = INTERACT_FLASH[result];
    if (flash !== undefined) this.flash(flash);
  }

  /** On foot: mouse/stick look and movement keys. Driving: pedals, steering, handbrake for the next fixed steps. */
  private readControls(session: GameSession, dt: number, active: boolean): void {
    const move = this.moveInput;
    move.forward = 0;
    move.strafe = 0;
    move.sprint = false;
    const drive = session.driverInput;
    if (active && session.driving) {
      readDriverInput(this.input, drive);
      return;
    }
    drive.accelerate = 0;
    drive.brake = 0;
    drive.steer = 0;
    drive.handbrake = false;
    if (!active) return;
    const input = this.input;
    const sensitivity = this.mouseSensitivity;
    const invertY = this.invertY;
    const mouse = input.mouseDelta();
    session.controller.lookByMouse(mouse.x, mouse.y, sensitivity, invertY);
    // Mouse movement is applied above; the stick rate excludes it so it is not counted twice.
    session.controller.lookByStick(input.stickAxis('look.x'), input.stickAxis('look.y'), dt, invertY);
    move.forward = (input.isDown('move.forward') ? 1 : 0) - (input.isDown('move.back') ? 1 : 0);
    move.strafe = (input.isDown('move.right') ? 1 : 0) - (input.isDown('move.left') ? 1 : 0);
    move.sprint = input.isDown('move.sprint');
  }

  /** On foot: the Phase 0 orbit camera. Driving: the rig's chase/hood/cockpit view of the interpolated car. */
  private updateCamera(session: GameSession, camera: THREE.PerspectiveCamera, dt: number, alpha: number, lookActive: boolean): void {
    const vehicle = session.drivenVehicle;
    if (!vehicle) {
      if (session.player === 0) return;
      interpolateTransform(session.player, alpha, scratchPos, scratchQuat);
      this.rig.updateOnFoot(scratchPos, session.controller.yaw, session.controller.pitch, camera);
      return;
    }
    interpolateTransform(vehicle.eid, alpha, scratchPos, scratchQuat);
    const target = this.follow;
    target.x = scratchPos.x;
    target.y = scratchPos.y;
    target.z = scratchPos.z;
    target.qx = scratchQuat.x;
    target.qy = scratchQuat.y;
    target.qz = scratchQuat.z;
    target.qw = scratchQuat.w;
    const velocity = session.physics.getBody(vehicle.eid)?.linvel(scratchVel);
    target.vx = velocity?.x ?? 0;
    target.vz = velocity?.z ?? 0;
    const look = this.look;
    const mouse = this.input.mouseDelta();
    look.mouseX = lookActive ? mouse.x : 0;
    look.mouseY = lookActive ? mouse.y : 0;
    look.stickX = lookActive ? this.input.stickAxis('look.x') : 0;
    look.stickY = lookActive ? this.input.stickAxis('look.y') : 0;
    look.sensitivity = this.mouseSensitivity;
    look.invertY = this.invertY;
    this.rig.updateVehicle(dt, target, look, camera, this.cameraRaycast);
  }

  /** Render side: sky and fog, chunk streaming, signal lamps, streetlights and every car. */
  private updateWorld(session: GameSession, dt: number, alpha: number): void {
    this.renderTime += dt;
    const lighting = session.env.lighting;
    const renderer = this.renderer;
    if (renderer && this.envRenderer) {
      const camera = renderer.activeCamera;
      interpolateTransform(session.player, alpha, scratchPos, scratchQuat);
      this.envRenderer.update(session.env, camera, scratchPos, dt);
      this.view?.update(camera.position.x, camera.position.z, this.envRenderer.viewDistance, session.clock.simTime, lighting);
      // Once the first ring of chunks is in (session start), so a later heat spell does not stall mid-drive.
      const chunks = this.view?.streamer?.stats;
      if (!this.hazeWarm && chunks && chunks.loaded > 0 && chunks.inFlight === 0) {
        this.hazeWarm = true;
        this.envRenderer.prewarmHaze(camera);
      }
    }
    const cars = this.carRenderer;
    if (!cars) return;
    cars.setHeadlightTarget(session.drivenVehicle?.eid ?? session.lastVehicle?.eid ?? 0);
    cars.update(alpha, lighting.nightFactor, this.renderTime, this.reducedFlash);
  }

  /** HUD and minimap at 10 Hz (the road lookup and prompt strings only run at that rate). */
  private updateHud(session: GameSession): void {
    const now = performance.now();
    if (now < this.nextHudMs) return;
    this.nextHudMs = now + HUD_INTERVAL_MS;
    const prompt = now < this.flashUntilMs ? this.flashText : interactPrompt(session.interactHint(), this.interactKey);
    this.hud.update(this.hudFeed.fill(session, CAMERA_MODE_NAMES[this.rig.mode] ?? 'onFoot', prompt), now);
    const view = this.view;
    if (!view) return;
    const at = session.playerPosition(scratchPoint);
    const vehicle = session.drivenVehicle;
    const eid = vehicle?.eid ?? 0;
    const yaw = vehicle
      ? headingOf(Transform.qx[eid] ?? 0, Transform.qy[eid] ?? 0, Transform.qz[eid] ?? 0, Transform.qw[eid] ?? 1)
      : session.controller.yaw;
    const traffic = session.traffic.view;
    const dots = this.trafficDots;
    dots.count = traffic.count;
    dots.x = traffic.x;
    dots.z = traffic.z;
    view.minimap.update(at.x, at.z, yaw, dots, this.route, now);
  }

  private updatePerfExtras(): void {
    const now = performance.now();
    if (now < this.nextPerfExtrasMs) return;
    this.nextPerfExtrasMs = now + PERF_EXTRAS_INTERVAL_MS;
    const chunks = this.view?.streamer?.stats;
    this.perf.setExtra('chunks', chunks ? `${String(chunks.loaded)} loaded (lod0 ${String(chunks.lod0)}), ${String(chunks.inFlight)} in flight` : undefined);
    const traffic = this.sessionValue?.traffic.stats;
    this.perf.setExtra('traffic', traffic ? `${String(traffic.active)} active, ${String(traffic.proxies)} proxies` : undefined);
    const cars = this.carRenderer?.stats;
    this.perf.setExtra('cars', cars && this.sessionValue ? `${String(cars.cars)} drawn, ${String(cars.drawCalls)} draw calls` : undefined);
  }

  /** Replaces the prompt line with `text` for a moment. */
  private flash(text: string): void {
    this.flashText = text;
    this.flashUntilMs = performance.now() + FLASH_MS;
    this.nextHudMs = 0;
  }

  // --- sessions ---------------------------------------------------------------

  private context(seed: number): GameContext {
    return { world: this.world, physics: this.physicsValue, meshes: this.meshes, bus: this.bus, city: this.cityFor(seed) };
  }

  private cityFor(seed: number): City {
    if (this.cityCache?.seed !== seed) {
      const start = performance.now();
      this.cityCache = generateCity(seed);
      log.info(`Generated city ${String(seed)} in ${(performance.now() - start).toFixed(0)} ms`);
    }
    return this.cityCache;
  }

  private requireSession(): GameSession {
    const session = this.sessionValue;
    if (!session) throw new Error('No game running');
    return session;
  }

  /** Fresh physics world and an emptied ECS world, so the same seed replays identically. */
  private resetSimulation(): void {
    this.physicsValue.dispose();
    this.physicsValue = createScenePhysics(FIXED_DT);
    clearWorld(this.world);
  }

  private beginSession(session: GameSession): void {
    this.sessionValue = session;
    this.detachSystems = session.attachSystems(this.systems);
    this.rig.setVehicleMode(session.cameraMode);
    this.rig.setVehicle(session.drivenVehicle?.model.body ?? null);
    for (const vehicle of session.vehicles) this.carRenderer?.setDrivable(vehicle.eid, vehicle);
    this.view = new WorldView(session.city, this.renderer ? this.scene : null, this.ui.hud, {
      worker: this.chunkWorker,
      shadows: this.settings.get('graphics.shadows'),
    });
    this.route = null;
    this.flashUntilMs = 0;
    this.hazeWarm = false;
    this.nextHudMs = 0;
    this.hud.setVisible(true);
    this.loop.timeScale = session.clock.timeScale;
    this.userPausedValue = false;
    this.ui.closeAll();
    this.refreshPause();
    this.refreshPointerLock();
    this.saves.startAutosave(AUTOSAVE_INTERVAL_MS, () => this.serializeGame());
  }

  /** Session teardown: systems, traffic and vehicles, then the city's render side; the physics world goes with the next reset. */
  private endSession(): void {
    this.saves.stopAutosave();
    const session = this.sessionValue;
    if (session) {
      this.detachSystems?.();
      this.detachSystems = null;
      for (const vehicle of session.vehicles) this.carRenderer?.setDrivable(vehicle.eid, null);
      this.carRenderer?.setHeadlightTarget(0);
      session.dispose();
      this.view?.dispose();
      this.view = null;
      // No vehicle entities are left: one update empties every car instance mesh.
      this.carRenderer?.update(0, 0, this.renderTime, false);
    }
    this.sessionValue = null;
    this.route = null;
    this.hud.setVisible(false);
    this.moveInput.forward = 0;
    this.moveInput.strafe = 0;
    this.moveInput.sprint = false;
    this.refreshPointerLock();
  }

  private async quickSave(): Promise<void> {
    try {
      await this.saveGame(QUICKSAVE_SLOT);
      this.pauseMenu.setStatus(`Saved to '${QUICKSAVE_SLOT}'`);
    } catch (error) {
      this.pauseMenu.setStatus('Save failed; see console');
      log.error('Quick save failed:', error);
    }
  }

  private async refreshSaveList(): Promise<void> {
    try {
      this.mainMenu.setSaves(await this.saves.list());
    } catch (error) {
      log.error('Could not list saves:', error);
    }
  }

  private physicsSystem(): System {
    return {
      name: 'physics',
      run: () => {
        this.physicsValue.step();
        this.physicsValue.syncToEcs(Transform);
      },
    };
  }

  /** What the Phase 1 world commands (time, weather, tp, route, road, car, traffic, plate, chunks) reach. */
  private worldCommandDeps(): WorldCommandDeps {
    return {
      city: () => this.sessionValue?.city ?? null,
      playerPosition: () => this.sessionValue?.playerPosition({ x: 0, z: 0 }) ?? null,
      environment: () => this.sessionValue?.env ?? null,
      teleport: (x, z) => this.teleport(x, z),
      setRoute: (polyline) => {
        this.route = polyline;
      },
      vehicle: () => this.sessionValue?.drivenVehicle ?? null,
      spawnVehicle: (modelId) => {
        const vehicle = this.requireSession().spawnVehicleNearPlayer(vehicleModel(modelId));
        this.carRenderer?.setDrivable(vehicle.eid, vehicle);
      },
      trafficStats: () => this.sessionValue?.traffic.stats ?? null,
      clearTraffic: () => this.requireSession().traffic.clear(true),
      setTrafficDensity: (scale) => {
        this.requireSession().traffic.densityScale = scale;
      },
      trafficCars: (limit) => this.sessionValue?.trafficCars(limit) ?? null,
      lookupPlate: (plate) => {
        const session = this.sessionValue;
        const id = session ? vehicleIdFromPlate(session.seed, plate) : null;
        return session && id !== null ? { ...vehicleRecord(session.seed, id) } : null;
      },
      chunkStats: () => this.view?.streamer?.stats ?? null,
    };
  }

  /** Single owner of `loop.paused`: paused by the console command or while any menu is open. */
  private refreshPause(): void {
    const paused = this.userPausedValue || this.ui.isMenuOpen();
    if (paused === this.loop.paused) return;
    this.loop.paused = paused;
    this.bus.emit('app:pause', { paused });
  }

  /** The browser swallows the Escape that releases pointer lock, so treat losing the lock as "pause". */
  private onPointerLockLost(): void {
    const playing = this.inGame && !this.ui.isMenuOpen() && !this.console.isOpen();
    if (playing && !(this.renderer?.debugCameraEnabled ?? false)) this.pauseMenu.open();
  }

  // --- wiring -----------------------------------------------------------------

  private wireEvents(): void {
    const settings = this.settings;
    this.disposers.push(
      settings.subscribe((change) => {
        const all = change.path === '*';
        const renderer = this.renderer;
        if (renderer) {
          if (all || change.path === 'graphics.renderScale') renderer.setRenderScale(settings.get('graphics.renderScale'));
          if (all || change.path === 'graphics.fov') renderer.fov = settings.get('graphics.fov');
          // Draw distance sets the camera far plane; the environment derives the fog and the streaming radius from it.
          if (all || change.path === 'graphics.drawDistance') renderer.setDrawDistance(settings.get('graphics.drawDistance'));
        }
        if (all || change.path === 'graphics.shadows') this.applyShadows();
        if (all || change.path === 'graphics.frameCap') this.loop.frameCap = settings.get('graphics.frameCap');
        if (all || change.path === 'controls.bindings') {
          const bindings = settings.get('controls.bindings');
          this.input.setBindings(bindings);
          this.interactKey = keyLabel(bindings.interact);
        }
        if (all || change.path === 'controls.gamepadDeadzone') {
          this.input.setDeadzone(settings.get('controls.gamepadDeadzone'));
        }
        if (all || change.path === 'controls.mouseSensitivity') this.mouseSensitivity = settings.get('controls.mouseSensitivity');
        if (all || change.path === 'controls.invertY') this.invertY = settings.get('controls.invertY');
        if (all || change.path === 'accessibility.reducedFlash') this.reducedFlash = settings.get('accessibility.reducedFlash');
      }),
      this.ui.onMenuChange(() => {
        this.menuChangedSinceUpdate = true;
        this.refreshPause();
        this.refreshPointerLock();
      }),
      this.input.onPointerLockLost(() => this.onPointerLockLost()),
      this.bus.on('save:completed', () => void this.refreshSaveList()),
    );
    this.interactKey = keyLabel(settings.get('controls.bindings').interact);
    this.mouseSensitivity = settings.get('controls.mouseSensitivity');
    this.invertY = settings.get('controls.invertY');
    this.reducedFlash = settings.get('accessibility.reducedFlash');
    // pagehide/hidden fire reliably on navigation and tab close (beforeunload does not on mobile),
    // and the settings storage keeps its connection open so the write starts synchronously here.
    const flushSettings = (): void => {
      this.settings.flush().catch((error: unknown) => log.error('Settings flush failed:', error));
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushSettings();
    };
    window.addEventListener('pagehide', flushSettings);
    document.addEventListener('visibilitychange', onVisibility);
    this.disposers.push(() => {
      window.removeEventListener('pagehide', flushSettings);
      document.removeEventListener('visibilitychange', onVisibility);
    });
  }

  /**
   * The shadows setting is the lighting quality: shadow maps (off/1024/2048), LOD0 chunk
   * casters, car shadows on high, and the streetlight pool size.
   */
  private applyShadows(): void {
    const quality = this.settings.get('graphics.shadows');
    this.renderer?.setShadows(quality);
    this.envRenderer?.setShadowQuality(quality);
    this.carRenderer?.setShadows(quality === 'high');
    this.view?.setShadows(quality);
  }

  private startWorkerPing(): void {
    const worker = this.worker;
    if (!worker) return;
    void this.checkWorkerDeterminism(worker);
    const ping = (): void => {
      worker.call('ping', { t: performance.now() }).then(
        () => this.perf.setExtra('worker', `${worker.lastRoundTripMs.toFixed(2)} ms`),
        (error: unknown) => {
          if (worker.isFailed) {
            // A worker that never started will not recover: stop pinging it.
            if (this.workerTimer !== null) clearInterval(this.workerTimer);
            this.workerTimer = null;
            this.perf.setExtra('worker', 'unavailable');
            log.error('Simulation worker unavailable:', error);
            return;
          }
          this.perf.setExtra('worker', 'error');
          log.warn('Worker ping failed:', error);
        },
      );
    };
    ping();
    this.workerTimer = setInterval(ping, WORKER_PING_INTERVAL_MS);
  }

  /** Confirms the worker's RNG matches the main thread's for the same seed. */
  private async checkWorkerDeterminism(worker: WorkerClient<WorkerRequestMap>): Promise<void> {
    try {
      const { values } = await worker.call('rng.sample', { seed: DETERMINISM_SEED, count: DETERMINISM_SAMPLES });
      const local = createRng(DETERMINISM_SEED);
      const expected = Array.from({ length: DETERMINISM_SAMPLES }, () => local.next());
      const same = values.length === expected.length && values.every((v, i) => v === expected[i]);
      if (same) log.info('Worker RNG matches main thread');
      else log.error('Worker RNG mismatch', { values, expected });
    } catch (error) {
      log.warn('Worker determinism check failed:', error);
    }
  }
}

/** Runs `fn` once the browser has painted (so a status line set just before is visible). */
function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

/** Player-facing reason a save could not be loaded. */
function describeLoadError(slot: string, error: unknown): string {
  if (error instanceof SaveNotFoundError) return `Save '${slot}' no longer exists`;
  if (error instanceof SaveMigrationError) {
    if (error.reason === MIGRATION_FAILURES.futureVersion) return `Save '${slot}' was made by a newer version of Patrol`;
    return `Save '${slot}' is damaged and cannot be loaded`;
  }
  return `Could not load '${slot}'; see console`;
}

function createRenderer(settings: SettingsStore): Renderer | null {
  try {
    return new Renderer({
      renderScale: settings.get('graphics.renderScale'),
      fov: settings.get('graphics.fov'),
      shadows: settings.get('graphics.shadows'),
      drawDistance: settings.get('graphics.drawDistance'),
    });
  } catch (error) {
    log.error('Renderer unavailable, continuing without rendering:', error);
    return null;
  }
}

function createWorker(): WorkerClient<WorkerRequestMap> | null {
  if (typeof Worker === 'undefined') {
    log.warn('Web Workers unavailable');
    return null;
  }
  try {
    return createSimWorker();
  } catch (error) {
    log.error('Could not start the simulation worker:', error);
    return null;
  }
}

/** The chunk meshing worker, or null (chunks are then meshed on the main thread). */
function createChunkWorkerOrNull(): WorkerClient<ChunkWorkerMap> | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return createChunkWorker();
  } catch (error) {
    log.warn('Chunk worker unavailable, meshing chunks on the main thread:', error);
    return null;
  }
}
