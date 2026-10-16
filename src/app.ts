import * as THREE from 'three';
import type { EventMap } from './core/event-map';
import { bus, type EventBus } from './core/events';
import { log } from './core/log';
import { GameLoop, type LoopHooks } from './core/loop';
import { createRng } from './core/rng';
import { DebugConsole } from './debug/console';
import { PerfOverlay, type PerfSample } from './debug/perfOverlay';
import { PrevTransform, Transform } from './ecs/components';
import { SystemRegistry, copyPrevTransform, integrateVelocity, type System } from './ecs/systems';
import { clearWorld, createGameWorld, entityCount, type GameWorld } from './ecs/world';
import { createCommands } from './game/commands';
import { PauseMenu } from './game/pauseMenu';
import { cameraPosition, type MoveInput } from './game/playerController';
import { GameSession, createScenePhysics, loadGame, serializeGame, startNewGame } from './game/testScene';
import { InputManager } from './input/input';
import { initRapier, type PhysicsWorld } from './physics/physics';
import { MeshRegistry, interpolateTransform } from './render/meshSync';
import { Renderer, createTestScene } from './render/renderer';
import { MIGRATION_FAILURES, SaveMigrationError } from './save/migrations';
import type { SaveGame } from './save/schema';
import { SaveManager, SaveNotFoundError } from './save/saveManager';
import { SettingsStore } from './settings/settings';
import { MainMenu } from './ui/mainMenu';
import { SettingsMenu } from './ui/settingsMenu';
import { UIRoot } from './ui/ui';
import { createSimWorker } from './workers/createSimWorker';
import type { WorkerRequestMap } from './workers/protocol';
import type { WorkerClient } from './workers/workerClient';

export const SIM_HZ = 60;
export const AUTOSAVE_INTERVAL_MS = 60_000;
export const WORKER_PING_INTERVAL_MS = 2_000;
const FIXED_DT = 1 / SIM_HZ;
const QUICKSAVE_SLOT = 'quicksave';
const DETERMINISM_SEED = 12345;
const DETERMINISM_SAMPLES = 8;

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchCam = new THREE.Vector3();
const scratchLook = new THREE.Vector3();

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

  private sessionValue: GameSession | null = null;
  /** Replaced for every session: Rapier does not return to a pristine state after bodies are removed. */
  private physicsValue: PhysicsWorld;
  /** Pause requested from the console; the loop is paused while this or a menu is up. */
  private userPausedValue = false;
  private readonly moveInput: MoveInput = { forward: 0, strafe: 0, sprint: false };
  private readonly perfSample: PerfSample;
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
    createTestScene(this.scene);
    this.renderer?.setShadows(settings.get('graphics.shadows'));
    this.renderer?.setDrawDistance(settings.get('graphics.drawDistance'));

    this.meshes = new MeshRegistry(this.scene, { world: this.world });
    this.input = new InputManager({
      bus: this.bus,
      bindings: settings.get('controls.bindings'),
      deadzone: settings.get('controls.gamepadDeadzone'),
    });

    this.ui = new UIRoot();
    this.disposers.push(this.ui.bindSettings(settings));
    this.perf = new PerfOverlay({ parent: this.ui.hud });
    this.console = new DebugConsole({ parent: this.ui.hud, bus: this.bus });
    for (const command of createCommands(this)) this.console.register(command);

    this.saves = new SaveManager({ bus: this.bus });
    this.settingsMenu = new SettingsMenu(this.ui, settings, this.input);
    this.mainMenu = new MainMenu(this.ui, {
      newGame: (seed) => this.newGame(seed),
      continueGame: (slot) => {
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

  /** Replaces the running session with a fresh deterministic scene. */
  newGame(seed: number | string): GameSession {
    this.endSession();
    this.resetSimulation();
    const session = startNewGame(this.context(), seed);
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
   * Loads `slot` and rebuilds the scene from it. A save that cannot be read
   * leaves the running session untouched; one that fails while rebuilding
   * returns to the title screen. Either way the promise rejects.
   */
  async loadGame(slot: string): Promise<GameSession> {
    const envelope = await this.saves.load(slot);
    this.endSession();
    this.resetSimulation();
    let session: GameSession;
    try {
      session = loadGame(this.context(), envelope);
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
    this.input.detach();
    this.console.dispose();
    this.perf.dispose();
    this.ui.dispose();
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

  private update(dt: number, alpha: number): void {
    this.input.update();
    this.handleToggles();
    this.menuChangedSinceUpdate = false;
    const session = this.sessionValue;
    if (!session) return;

    const controlsActive = !this.ui.isMenuOpen() && !this.console.isOpen();
    const debugCam = this.renderer?.debugCameraEnabled ?? false;
    if (controlsActive && !debugCam) {
      const input = this.input;
      const sensitivity = this.settings.get('controls.mouseSensitivity');
      const invertY = this.settings.get('controls.invertY');
      const mouse = input.mouseDelta();
      session.controller.lookByMouse(mouse.x, mouse.y, sensitivity, invertY);
      // Mouse movement is applied above; the stick rate excludes it so it is not counted twice.
      session.controller.lookByStick(input.stickAxis('look.x'), input.stickAxis('look.y'), dt, invertY);
      this.moveInput.forward = (input.isDown('move.forward') ? 1 : 0) - (input.isDown('move.back') ? 1 : 0);
      this.moveInput.strafe = (input.isDown('move.right') ? 1 : 0) - (input.isDown('move.left') ? 1 : 0);
      this.moveInput.sprint = input.isDown('move.sprint');
    } else {
      this.moveInput.forward = 0;
      this.moveInput.strafe = 0;
      this.moveInput.sprint = false;
    }

    if (this.renderer && !debugCam) this.followPlayer(session, alpha, this.renderer.camera);
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

  private followPlayer(session: GameSession, alpha: number, camera: THREE.PerspectiveCamera): void {
    if (session.player === 0) return;
    interpolateTransform(session.player, alpha, scratchPos, scratchQuat, PrevTransform, Transform);
    cameraPosition(scratchPos, session.controller.yaw, session.controller.pitch, scratchCam);
    camera.position.copy(scratchCam);
    scratchLook.set(scratchPos.x, scratchPos.y + 1, scratchPos.z);
    camera.lookAt(scratchLook);
  }

  // --- sessions ---------------------------------------------------------------

  private context() {
    return { world: this.world, physics: this.physicsValue, meshes: this.meshes };
  }

  /** Fresh physics world and an emptied ECS world, so the same seed replays identically. */
  private resetSimulation(): void {
    this.physicsValue.dispose();
    this.physicsValue = createScenePhysics(FIXED_DT);
    clearWorld(this.world);
  }

  private beginSession(session: GameSession): void {
    this.sessionValue = session;
    this.loop.timeScale = session.clock.timeScale;
    this.userPausedValue = false;
    this.ui.closeAll();
    this.refreshPause();
    this.refreshPointerLock();
    this.saves.startAutosave(AUTOSAVE_INTERVAL_MS, () => this.serializeGame());
  }

  private endSession(): void {
    this.saves.stopAutosave();
    this.sessionValue?.dispose();
    this.sessionValue = null;
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
          if (all || change.path === 'graphics.shadows') renderer.setShadows(settings.get('graphics.shadows'));
          if (all || change.path === 'graphics.fov') renderer.fov = settings.get('graphics.fov');
        }
        if (renderer && (all || change.path === 'graphics.drawDistance')) {
          renderer.setDrawDistance(settings.get('graphics.drawDistance'));
        }
        if (all || change.path === 'graphics.frameCap') this.loop.frameCap = settings.get('graphics.frameCap');
        if (all || change.path === 'controls.bindings') this.input.setBindings(settings.get('controls.bindings'));
        if (all || change.path === 'controls.gamepadDeadzone') {
          this.input.setDeadzone(settings.get('controls.gamepadDeadzone'));
        }
      }),
      this.ui.onMenuChange(() => {
        this.menuChangedSinceUpdate = true;
        this.refreshPause();
        this.refreshPointerLock();
      }),
      this.input.onPointerLockLost(() => this.onPointerLockLost()),
      this.bus.on('save:completed', () => void this.refreshSaveList()),
    );
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
