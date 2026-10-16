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
import { advanceTime, createGameWorld, entityCount, type GameWorld } from './ecs/world';
import { createCommands } from './game/commands';
import { PauseMenu } from './game/pauseMenu';
import { cameraPosition, type MoveInput } from './game/playerController';
import { GameSession, loadGame, serializeGame, startNewGame } from './game/testScene';
import { InputManager } from './input/input';
import { PhysicsWorld } from './physics/physics';
import { MeshRegistry, interpolateTransform } from './render/meshSync';
import { Renderer, createTestScene } from './render/renderer';
import type { SaveGameV1 } from './save/schema';
import { SaveManager } from './save/saveManager';
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
/** Fixed steps allowed per loop step when the time scale is above 1. */
const MAX_SIM_STEPS_PER_UPDATE = 4;
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
  readonly physics: PhysicsWorld;
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
  private simAccumulator = 0;
  private readonly moveInput: MoveInput = { forward: 0, strafe: 0, sprint: false };
  private readonly perfSample: PerfSample;
  private menuChangedSinceUpdate = false;
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  private constructor(settings: SettingsStore, physics: PhysicsWorld) {
    this.settings = settings;
    this.physics = physics;
    this.world = createGameWorld();

    this.renderer = createRenderer(settings);
    this.scene = this.renderer?.scene ?? new THREE.Scene();
    createTestScene(this.scene);
    this.renderer?.setShadows(settings.get('graphics.shadows'));
    this.physics.addGround(100, 0);

    this.meshes = new MeshRegistry(this.scene, { world: this.world });
    this.input = new InputManager({ bus: this.bus, bindings: settings.get('controls.bindings') });

    this.ui = new UIRoot();
    this.disposers.push(this.ui.bindSettings(settings));
    this.perf = new PerfOverlay({ parent: this.ui.hud });
    this.console = new DebugConsole({ parent: this.ui.hud, bus: this.bus });
    for (const command of createCommands(this)) this.console.register(command);

    this.saves = new SaveManager({ bus: this.bus });
    this.settingsMenu = new SettingsMenu(this.ui, settings, this.input);
    this.mainMenu = new MainMenu(this.ui, {
      newGame: (seed) => this.newGame(seed),
      continueGame: (slot) => void this.loadGame(slot),
      openSettings: () => this.settingsMenu.open(),
      deleteSave: (slot) => void this.deleteSave(slot),
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
      fixedUpdate: (dt, step) => this.fixedUpdate(dt, step),
      update: (dt, alpha) => this.update(dt, alpha),
      render: (alpha) => this.render(alpha),
    };
    this.loop = new GameLoop({ hooks, simHz: SIM_HZ });

    this.worker = createWorker();
    this.wireEvents();
  }

  /** Loads settings, initialises Rapier and builds the app. */
  static async create(): Promise<App> {
    const settings = new SettingsStore();
    await settings.load();
    const physics = await PhysicsWorld.create({ x: 0, y: -9.81, z: 0 }, 1 / SIM_HZ);
    return new App(settings, physics);
  }

  get session(): GameSession | null {
    return this.sessionValue;
  }

  get inGame(): boolean {
    return this.sessionValue !== null;
  }

  /** Attaches input, shows the title screen and starts the loop. */
  start(): void {
    const target = this.renderer?.canvas ?? window;
    this.input.attach(target);
    this.loop.paused = true;
    this.mainMenu.open();
    void this.refreshSaveList();
    this.startWorkerPing();
    this.loop.start();
    this.bus.emit('app:ready', {});
    log.info('Patrol ready', this.renderer ? '(WebGL)' : '(no renderer)');
  }

  /** Replaces the running session with a fresh deterministic scene. */
  newGame(seed: number | string): GameSession {
    this.endSession();
    const session = startNewGame(this.context(), seed);
    this.beginSession(session);
    log.info(`New game, seed ${String(session.seed)}`);
    return session;
  }

  /** Serializes the running session (throws when none is running). */
  serializeGame(): SaveGameV1 {
    if (!this.sessionValue) throw new Error('No game running');
    return serializeGame(this.sessionValue);
  }

  async saveGame(slot: string): Promise<void> {
    await this.saves.save(slot, this.serializeGame());
  }

  /** Loads `slot` and rebuilds the scene from it. */
  async loadGame(slot: string): Promise<GameSession> {
    const envelope = await this.saves.load(slot);
    this.endSession();
    const session = loadGame(this.context(), envelope);
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
    this.physics.dispose();
    this.saves.close();
    this.settings.dispose();
  }

  // --- loop hooks -------------------------------------------------------------

  private fixedUpdate(dt: number, step: number): void {
    this.bus.emit('loop:fixed', { dt, step });
    const session = this.sessionValue;
    if (!session) return;
    this.simAccumulator += session.clock.advance(dt);
    const fixedDt = this.physics.fixedDt;
    let steps = 0;
    while (this.simAccumulator + 1e-6 >= fixedDt && steps < MAX_SIM_STEPS_PER_UPDATE) {
      this.simAccumulator -= fixedDt;
      steps += 1;
      advanceTime(this.world, fixedDt);
      session.fixedUpdate(this.moveInput);
      this.systems.runAll(this.world, fixedDt);
    }
    if (steps === MAX_SIM_STEPS_PER_UPDATE) this.simAccumulator = 0;
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
      session.controller.lookByStick(input.axis('look.x'), input.axis('look.y'), dt, invertY);
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
    // A menu that closed itself on this key press (e.g. Settings on Escape) must not re-toggle.
    if (input.wasPressed('menu.toggle') && this.inGame && !this.menuChangedSinceUpdate) {
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
    return { world: this.world, physics: this.physics, meshes: this.meshes };
  }

  private beginSession(session: GameSession): void {
    this.sessionValue = session;
    this.simAccumulator = 0;
    this.ui.closeAll();
    this.loop.paused = false;
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
        this.physics.step();
        this.physics.syncToEcs(Transform);
      },
    };
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
        if (all || change.path === 'controls.bindings') this.input.setBindings(settings.get('controls.bindings'));
      }),
      this.ui.onMenuChange((stack) => {
        this.menuChangedSinceUpdate = true;
        this.loop.paused = stack.length > 0;
        this.refreshPointerLock();
      }),
      this.bus.on('save:completed', () => void this.refreshSaveList()),
    );
    const onUnload = (): void => void this.settings.flush();
    window.addEventListener('beforeunload', onUnload);
    this.disposers.push(() => window.removeEventListener('beforeunload', onUnload));
  }

  private startWorkerPing(): void {
    const worker = this.worker;
    if (!worker) return;
    void this.checkWorkerDeterminism(worker);
    const ping = (): void => {
      worker.call('ping', { t: performance.now() }).then(
        () => this.perf.setExtra('worker', `${worker.lastRoundTripMs.toFixed(2)} ms`),
        (error: unknown) => {
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

function createRenderer(settings: SettingsStore): Renderer | null {
  try {
    return new Renderer({
      renderScale: settings.get('graphics.renderScale'),
      fov: settings.get('graphics.fov'),
      shadows: settings.get('graphics.shadows'),
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
