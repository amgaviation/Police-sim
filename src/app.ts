import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { createAudioCommands } from './audio/commands';
import { AudioEngine } from './audio/engine';
import type { SirenEmitter } from './audio/math';
import { createCadCommands } from './cad/commands';
import './cad/events';
import type { RadioMode } from './cad/types';
import type { EventMap } from './core/event-map';
import { bus, type EventBus } from './core/events';
import { log } from './core/log';
import { GameLoop, type LoopHooks } from './core/loop';
import { createRng, normalizeSeed } from './core/rng';
import { DebugConsole, type Command } from './debug/console';
import { PerfOverlay, type PerfSample } from './debug/perfOverlay';
import { createWorldCommands, type WorldCommandDeps } from './debug/worldCommands';
import { createCallsCommands } from './calls/commands';
import { createDispatchCommands } from './dispatch/commands';
import { Transform } from './ecs/components';
import './indoors/events';
import './investigation/events';
import './station/events';
import './tactical/events';
import './npc/events';
import { SystemRegistry, copyPrevTransform, integrateVelocity, type System } from './ecs/systems';
import { clearWorld, createGameWorld, entityCount, type GameWorld } from './ecs/world';
import { EnvironmentRenderer } from './environment/render/environmentRenderer';
import { createCommands } from './game/commands';
import { HudFeed, interactPrompt, keyLabel } from './game/hudFeed';
import { createMdtDeps } from './game/mdtDeps';
import { createNpcCommands } from './npc/commands';
import { createPeopleCommands } from './people/commands';
import { createSceneCommands } from './scene/commands';
import { PatrolPanels } from './game/panels';
import { createPatrolCommands } from './game/patrolCommands';
import { PauseMenu } from './game/pauseMenu';
import { createPhase3Commands } from './game/phase3Commands';
import { createPhase4Commands } from './game/phase4Commands';
import { Phase4Presenter } from './game/phase4Presenter';
import { PeoplePresenter } from './game/peoplePresenter';
import type { MoveInput } from './game/playerController';
import { MARKER_CAPACITY, PoliceFeed } from './game/policeFeed';
import { distanceToPolyline } from './game/route';
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
import { TargetTracker, type TargetInfo } from './game/target';
import { WorldView } from './game/worldView';
import { InputManager } from './input/input';
import { initRapier, type PhysicsWorld, type Vec3 } from './physics/physics';
import { CAMERA_MODE, CAMERA_MODE_NAMES, CameraRig, type CameraRaycast, type FollowTarget, type LookInput } from './player/cameraRig';
import { readDriverInput } from './player/driverInput';
import { createPoliceCommands } from './police/commands';
import { PoliceLights, SIREN_FLAG, hasPoliceLights } from './police/components';
import { createPoliceInput, readPoliceInput } from './police/controls';
import { SIREN_TONES, SPOTLIGHT } from './police/equipment';
import { RadioController } from './radio/controller';
import { RADIO_CONFIG, channelDef } from './radio/data';
import './radio/events';
import { RadioPlayer } from './radio/player';
import type { Transmission } from './radio/types';
import { createRecordsCommands } from './records/commands';
import { MeshRegistry, interpolateTransform } from './render/meshSync';
import { CockpitRenderer } from './render/police/cockpitRenderer';
import { MdtScreen } from './render/police/mdtScreen';
import { Renderer } from './render/renderer';
import { CarRenderer } from './render/vehicles/carRenderer';
import { MIGRATION_FAILURES, SaveMigrationError } from './save/migrations';
import type { SaveGame } from './save/schema';
import { SaveManager, SaveNotFoundError } from './save/saveManager';
import { SettingsStore } from './settings/settings';
import { SpeechIn } from './speech/recognition';
import { SpeechOut } from './speech/synthesis';
import { createTrafficCommands } from './traffic/commands';
import { PULLOVER } from './traffic/data';
import { vehicleIdFromPlate, vehicleRecord } from './traffic/registry';
import { Hud } from './ui/hud/hud';
import { createMinimapMarkers, type TrafficDots } from './ui/hud/minimap';
import { MainMenu } from './ui/mainMenu';
import { MdtOverlay } from './ui/mdt/overlay';
import { ActionPanel } from './ui/panels/actionPanel';
import { RadioMenuView } from './ui/panels/radioMenuView';
import { RadioPanel } from './ui/panels/radioPanel';
import type { RadioLine, RadioStatusView } from './ui/panels/text';
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
/** Index of the mouse button for `officer.fire` is handled by the input layer; this is the horizontal aim length floor. */
const MIN_AIM = 1e-6;
const FIXED_DT = 1 / SIM_HZ;
/** Holding the interact key this long (ms) at a door opens the door panel instead of toggling it. */
const DOOR_HOLD_MS = 400;
const QUICKSAVE_SLOT = 'quicksave';
const DETERMINISM_SEED = 12345;
const DETERMINISM_SAMPLES = 8;
/** The reticle target is picked at this interval (10 Hz). */
const TARGET_INTERVAL_MS = 100;
/** The route to the player's call is re-planned this often (ms) ... */
const ROUTE_REPLAN_MS = 10_000;
/** ... or as soon as the player is this far off it (m). */
const ROUTE_OFF_M = 60;
/** A radio caption stays up for the transmission plus this long (ms). */
const CAPTION_LINGER_MS = 1500;
/** Radio log lines shown again after a load. */
const RADIO_LOG_RESTORE = 6;

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchDir = new THREE.Vector3();
const scratchUp = new THREE.Vector3();
const scratchVel: Vec3 = { x: 0, y: 0, z: 0 };
const scratchPoint = { x: 0, z: 0 };
const scratchDest = { x: 0, z: 0 };


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
  /** Sirens and radio effects (Web Audio; a no-op without `AudioContext`). */
  readonly audio: AudioEngine;
  /** Spoken radio (text-to-speech; a no-op without `speechSynthesis`). */
  readonly speechOut: SpeechOut;
  /** Push-to-talk voice commands (off unless `audio.voiceCommands`). */
  readonly speechIn: SpeechIn;
  /** Plays audible transmissions (FX + TTS); presentation only. */
  readonly radioPlayer: RadioPlayer;
  /** Number-key radio menu display (left column). */
  readonly radioMenuView: RadioMenuView;
  /** Trunk, equipment and driver-contact panels (one non-pausing action panel). */
  readonly panels: PatrolPanels;
  /** In-car laptop canvas (shown on the cockpit's screen). */
  readonly mdtScreen: MdtScreen;
  /** Patrol-car interior in cockpit view (null without a renderer). */
  readonly cockpit: CockpitRenderer | null;
  /**
   * Dev and test switch: calls bind to building interiors (default). False keeps the Phase 3 outdoor scenes for the
   * next new or loaded session (the browser smoke test uses it for the Phase 1-3 flows, which were written for them).
   */
  indoorScenes = true;
  /** Phase 4 presentation: interiors, flashlight, fade, briefing, viewfinder, case file, dusting, labels, thumbnails. */
  readonly phase4: Phase4Presenter;

  private sessionValue: GameSession | null = null;
  /** Per-session Phase 2 presentation: MDT overlay, radio log, radio controller, HUD feed, target lock. */
  private mdtValue: MdtOverlay | null = null;
  private radioPanelValue: RadioPanel | null = null;
  private radioCtl: RadioController | null = null;
  private policeFeedValue: PoliceFeed | null = null;
  private targets: TargetTracker | null = null;
  private readonly actionPanel: ActionPanel;
  /** People layer presentation: figures, props, dialogue and SFST panels, subtitles. */
  readonly presenter: PeoplePresenter;
  private readonly policeInput = createPoliceInput();
  /** Interact key held at a door since this time (ms), -1 when not pending: a tap toggles, a hold opens the door panel. */
  private doorHoldMs = -1;
  private readonly markers = createMinimapMarkers(MARKER_CAPACITY);
  /** Siren emitters rebuilt every frame (reused objects; grows only when more police cars exist). */
  private readonly emitters: SirenEmitter[] = [];
  private readonly radioStatus: { -readonly [K in keyof RadioStatusView]: RadioStatusView[K] } = {
    channel: '',
    scanning: false,
    tx: false,
    rx: false,
    busy: false,
    emergency: false,
    mode: 'tenCode',
    voice: 'unavailable',
    emergencyCharge: 0,
  };
  private radioMode: RadioMode = 'tenCode';
  private subtitles = true;
  private radioMenuKey = 'T';
  /** `hintSeq` of the last radio hint flashed. */
  private lastRadioHint = 0;
  private nextTargetMs = 0;
  /** Route to the player's call, re-planned every `ROUTE_REPLAN_MS` or when off it. */
  private autoRoute: Float32Array | null = null;
  private autoRouteX = NaN;
  private autoRouteZ = NaN;
  private nextRouteMs = 0;
  private cockpitEid = 0;
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
    this.mdtScreen = new MdtScreen();
    this.cockpit = this.renderer ? new CockpitRenderer(this.scene) : null;
    this.cockpit?.setScreenSource(this.mdtScreen.canvas);

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
    this.audio = new AudioEngine();
    this.speechOut = new SpeechOut();
    this.speechIn = new SpeechIn();
    this.radioPlayer = new RadioPlayer({
      bus: this.bus,
      audio: this.audio,
      speech: this.speechOut,
      selected: () => this.sessionValue?.radio.selected ?? RADIO_CONFIG.defaultSelected,
    });
    this.radioMenuView = new RadioMenuView(this.ui.hud);
    this.actionPanel = new ActionPanel(this.ui);
    this.panels = new PatrolPanels(this.actionPanel, {
      session: () => this.sessionValue,
      openCitation: () => {
        const mdt = this.mdtValue;
        if (!mdt) return;
        mdt.open('reports');
        mdt.writeCitation();
      },
      flash: (text) => this.flash(text),
      openMdt: () => this.mdtValue?.open(),
      openCamera: () => {
        const session = this.sessionValue;
        if (session) this.phase4.openCamera(session);
      },
      openCaseFile: () => {
        const session = this.sessionValue;
        if (session) this.phase4.openCaseFile(session);
      },
    });
    this.phase4 = new Phase4Presenter(this.renderer ? this.scene : null, this.renderer, this.envRenderer, this.ui, this.ui.hud, {
      session: () => this.sessionValue,
      flash: (text) => this.flash(text),
      baseFov: () => settings.get('graphics.fov'),
    });
    this.presenter = new PeoplePresenter(
      this.renderer ? this.scene : null,
      this.ui,
      this.speechOut,
      {
        session: () => this.sessionValue,
        flash: (text) => this.flash(text),
        openForm: (kind, personId, vehicleId, callId) => this.openMdtForm(kind, personId, vehicleId, callId),
      },
      false,
    );
    for (const command of createCommands(this)) this.console.register(command);
    for (const command of createWorldCommands(this.worldCommandDeps())) this.console.register(command);
    for (const command of this.patrolCommands()) this.console.register(command);

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

  /** The running session's MDT overlay (Tab in a patrol car), null without a session. */
  get mdt(): MdtOverlay | null {
    return this.mdtValue;
  }

  /** The running session's radio log and channel strip, null without a session. */
  get radioPanel(): RadioPanel | null {
    return this.radioPanelValue;
  }

  /** HUD, minimap and MDT-screen feed of the running session, null without a session. */
  get policeFeed(): PoliceFeed | null {
    return this.policeFeedValue;
  }

  /** The car under the reticle (picked at 10 Hz), null when none. */
  get target(): TargetInfo | null {
    return this.targets?.target ?? null;
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
    // A document form being typed in the MDT is kept as a draft.
    this.mdtValue?.flushDraft();
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
    this.radioPlayer.dispose();
    this.radioMenuView.dispose();
    this.speechIn.dispose();
    this.speechOut.dispose();
    this.audio.dispose();
    this.presenter.dispose();
    this.phase4.dispose();
    this.hud.dispose();
    this.console.dispose();
    this.perf.dispose();
    this.ui.dispose();
    this.envRenderer?.dispose();
    this.carRenderer?.dispose();
    this.cockpit?.dispose();
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

  /**
   * Frame order (Phase 1 §13, Phase 2 §15): input, toggles, actions (police toggles, MDT, plate run),
   * controls (driving, siren holds, spotlight aim), radio controller, camera, target pick (10 Hz), MDT
   * and panels, environment and city, cars (+ spotlight), cockpit and MDT screen, audio, HUD and radio panel.
   */
  private update(dt: number, alpha: number): void {
    this.input.update();
    this.handleToggles();
    this.menuChangedSinceUpdate = false;
    const session = this.sessionValue;
    if (!session) return;

    const controlsActive = !this.ui.isMenuOpen() && !this.console.isOpen();
    const debugCam = this.renderer?.debugCameraEnabled ?? false;
    const police = readPoliceInput(this.input, this.policeInput);
    if (controlsActive) this.handleActions(session);
    this.phase4.updateInput(session, this.input, controlsActive, () => this.panels.openTools(), () => this.panels.openPartner());
    if (this.phase4.camera.isOpen && this.input.wasPressed('officer.fire')) this.phase4.shutter();
    this.readControls(session, dt, controlsActive && !debugCam);
    this.updateRadio(session, dt, controlsActive);
    // Holding the spotlight-aim button steers the spotlight with the mouse instead of the camera.
    const spotAim = controlsActive && police.spotAim && session.drivenEquipment !== null;
    if (this.renderer && !debugCam) this.updateCamera(session, this.renderer.camera, dt, alpha, controlsActive && !spotAim);
    const now = performance.now();
    this.updateTarget(session, now);
    this.mdtValue?.update(now);
    this.panels.update(now);
    this.phase4.updatePanels(session, now);
    this.presenter.updateMenus(now);
    this.updateWorld(session, dt, alpha);
    this.updateCockpit(session, alpha, now);
    this.updateAudio(session);
    this.updateHud(session);
    this.updateRadioPanel(now);
  }

  private render(alpha: number): void {
    this.meshes.syncFromEcs(alpha);
    this.renderer?.render();
    // The drawing buffer is not preserved: a pending photo thumbnail is read in the same task as the render.
    this.phase4.afterRender(this.sessionValue, this.renderer?.canvas ?? null);
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
      // A menu that closed itself on this key press (e.g. Settings, the MDT or a panel on Escape) must not re-toggle.
      // Escape closes the radio menu first, then (handled by the menus themselves) a panel or the MDT, then pauses.
      const radioMenu = this.sessionValue?.radio.menu;
      if (!this.ui.isMenuOpen() && radioMenu?.isOpen) radioMenu.close();
      else if (!this.ui.isMenuOpen()) this.pauseMenu.open();
      else if (this.ui.top === this.pauseMenu) this.pauseMenu.close();
    }
  }

  /**
   * Mode actions: interact (enter, exit, refuel, trunk, driver contact), map zoom, MDT, plate run, and
   * while driving camera, headlights, light bar and the patrol car's siren, pattern, spotlight and
   * equipment panel.
   */
  private handleActions(session: GameSession): void {
    const input = this.input;
    this.handleInteractKey(session);
    if (input.wasPressed('map.toggle')) this.view?.minimap.toggleZoom();
    if (input.wasPressed('mdt.toggle')) {
      if (session.mdtReachable()) this.mdtValue?.open();
      else this.flash('No MDT within reach (get in a patrol car)');
    }
    if (input.wasPressed('target.runPlate')) this.runTargetPlate(session);
    if (input.wasPressed('scene.menu')) this.panels.openScene();
    if (!session.driving) {
      if (input.wasPressed('camera.toggle')) this.phase4.toggleView();
      this.handleOfficerActions(session);
      return;
    }
    if (input.wasPressed('camera.toggle')) {
      this.rig.cycleVehicleMode();
      session.cameraMode = this.rig.vehicleMode;
    }
    if (input.wasPressed('vehicle.headlights')) session.toggleHeadlights();
    if (input.wasPressed('vehicle.lights')) session.toggleLightbar();
    const eq = session.drivenEquipment;
    if (!eq) return;
    const p = this.policeInput;
    if (p.toggleSiren) eq.toggleSiren();
    if (p.cycleTone) eq.cycleTone();
    if (p.cyclePattern) eq.cyclePattern();
    if (p.toggleSpot) eq.toggleSpot();
    if (p.equipmentPanel) this.panels.openEquipment();
  }

  /** On foot: weapon, fire (mouse 0, only with a weapon drawn), tackle and shout become scene requests. */
  private handleOfficerActions(session: GameSession): void {
    const input = this.input;
    const scene = session.scene;
    // Gamepad Start is both menu.toggle and the default officer.weapon: a menu press never cycles the weapon.
    if (input.wasPressed('officer.weapon') && !input.wasPressed('menu.toggle')) scene.request({ kind: 'weapon' });
    if (input.wasPressed('officer.fire') && scene.officerWeapon !== 'none') {
      const dir = this.aimDirection(session);
      scene.request({ kind: 'fire', dirX: dir.x, dirZ: dir.z });
    }
    if (input.wasPressed('officer.tackle')) scene.request({ kind: 'tackle' });
    if (input.wasPressed('officer.shout')) scene.request({ kind: 'shout' });
  }

  /** The camera's horizontal forward direction (the officer's heading headless). */
  private aimDirection(session: GameSession): { x: number; z: number } {
    const out = scratchPoint;
    const camera = this.renderer?.activeCamera;
    if (camera) {
      camera.getWorldDirection(scratchDir);
      out.x = scratchDir.x;
      out.z = scratchDir.z;
    } else {
      out.x = -Math.sin(session.controller.yaw);
      out.z = -Math.cos(session.controller.yaw);
    }
    const len = Math.hypot(out.x, out.z);
    if (len < MIN_AIM) {
      out.x = -Math.sin(session.controller.yaw);
      out.z = -Math.cos(session.controller.yaw);
    } else {
      out.x /= len;
      out.z /= len;
    }
    return out;
  }

  /** `contact:openForm` / `scene:openForm`: the MDT's citation or report form for the person, written on the spot. */
  private openMdtForm(kind: 'citation' | 'report', personId: number, vehicleId: number, callId: number): void {
    const mdt = this.mdtValue;
    const session = this.sessionValue;
    if (!mdt || !session) return;
    const stop = session.cad.trafficStop;
    const onStop = stop !== null && stop.outcome === 'active' && (vehicleId < 0 || stop.vehicleId === vehicleId);
    mdt.open('reports');
    let opened: boolean;
    if (kind === 'citation' && !onStop) {
      const call = callId > 0 ? session.cad.call(callId) : null;
      opened = mdt.openForm('citation', {
        callId: call ? call.id : null,
        personId: personId >= 0 ? personId : -1,
        vehicleId: vehicleId >= 0 ? vehicleId : -1,
        location: call?.location.text ?? '',
      });
    } else {
      opened = mdt.openForm(kind);
    }
    if (!opened) this.flash('Finish the open document first');
  }

  /**
   * The interact key: a tap acts at once, except near a door where a tap acts on release and holding the key
   * for `DOOR_HOLD_MS` opens the door panel (design §13).
   */
  private handleInteractKey(session: GameSession): void {
    const input = this.input;
    const now = performance.now();
    if (input.wasPressed('interact')) {
      // Near a door a tap acts on release and a hold opens the door panel (also when a person at the door wins the tap).
      if (session.doorTarget() !== null) this.doorHoldMs = now;
      else this.interact(session);
    }
    if (this.doorHoldMs < 0) return;
    if (!input.isDown('interact')) {
      this.doorHoldMs = -1;
      this.interact(session);
    } else if (now - this.doorHoldMs >= DOOR_HOLD_MS) {
      this.doorHoldMs = -1;
      this.openDoorPanel(session);
    }
  }

  private openDoorPanel(session: GameSession): void {
    const target = session.doorTarget();
    if (target) this.panels.openDoor(target);
    else this.flash('No door within reach');
  }

  private interact(session: GameSession): void {
    const result = session.interact();
    if (result === 'entered') this.rig.setVehicle(session.drivenVehicle?.model.body ?? null);
    else if (result === 'exited') this.rig.setVehicle(null);
    else if (result === 'trunk') {
      const car = session.trunkVehicle();
      if (car) this.panels.openTrunk(car);
    } else if (result === 'cage') this.flash('Placing the prisoner in the patrol car');
    else if (result === 'doorPanel') this.openDoorPanel(session);
    else if (result === 'locker') this.panels.openLocker();
    else if (result === 'armory') this.panels.openArmory();
    else if (result === 'interview') this.panels.openInterview();
    else if (result === 'briefing') this.phase4.openBriefing(session);
    else if (result === 'reportDesk') this.mdtValue?.open();
    else if (result === 'cell') this.flash(session.contact.escorting() > 0 ? 'Placing the prisoner in a cell' : 'Holding cell');
    const flash = INTERACT_FLASH[result];
    if (flash !== undefined) this.flash(flash);
  }

  /** `target.runPlate`: the reticle car, else the stopped car; the dispatcher answers on the HUD / MDT (silent on the radio). */
  private runTargetPlate(session: GameSession): void {
    const target = this.targets?.target ?? null;
    const stop = session.cad.trafficStop;
    const vehicleId = target ? target.vehicleId : stop && stop.outcome === 'active' ? stop.vehicleId : -1;
    const plate = target ? target.plate : stop && stop.outcome === 'active' ? stop.plate : '';
    if (vehicleId < 0 || plate === '') {
      this.flash('No vehicle targeted');
      return;
    }
    session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'runPlate', plate, vehicleId }, 'key');
    this.flash(`Running plate ${plate}`);
  }

  /** On foot: mouse/stick look and movement keys. Driving: pedals, steering, handbrake for the next fixed steps. */
  private readControls(session: GameSession, dt: number, active: boolean): void {
    const move = this.moveInput;
    move.forward = 0;
    move.strafe = 0;
    move.sprint = false;
    const drive = session.driverInput;
    const eq = session.drivenEquipment;
    const police = this.policeInput;
    // Held this frame; the session applies them to the driven patrol car in the next fixed steps.
    session.sirenHeld.horn = active && eq !== null && police.horn;
    session.sirenHeld.manual = active && eq !== null && police.manual;
    if (active && session.driving) {
      readDriverInput(this.input, drive);
      if (eq && police.spotAim) {
        // Mouse right turns the beam right (yaw + is left), mouse up raises it.
        const mouse = this.input.mouseDelta();
        eq.aimSpot(-mouse.x * SPOTLIGHT.aimRate, -mouse.y * SPOTLIGHT.aimRate);
      }
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
      // Indoors (or with V on foot) the camera is at the officer's eyes with the tactical lean and stance.
      const first = this.phase4.firstPerson(session);
      this.presenter.setFirstPerson(first);
      if (first) this.phase4.updateFirstPerson(session, scratchPos, this.rig, camera);
      else this.rig.updateOnFoot(scratchPos, session.controller.yaw, session.controller.pitch, camera);
      return;
    }
    this.presenter.setFirstPerson(false);
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
      this.view?.setIndoor(session.officerBuilding >= 0);
      this.view?.update(camera.position.x, camera.position.z, this.envRenderer.viewDistance, session.clock.simTime, lighting);
      this.phase4.updateWorld(session, dt, camera);
      this.phase4.updateLabels(session, camera, renderer.canvas, performance.now());
      // Once the first ring of chunks is in (session start), so a later heat spell does not stall mid-drive.
      const chunks = this.view?.streamer?.stats;
      if (!this.hazeWarm && chunks && chunks.loaded > 0 && chunks.inFlight === 0) {
        this.hazeWarm = true;
        this.envRenderer.prewarmHaze(camera);
      }
    }
    if (renderer) {
      const cam = renderer.activeCamera;
      this.presenter.render(session, alpha, cam.position.x, cam.position.z, lighting.nightFactor, dt);
    }
    const cars = this.carRenderer;
    if (!cars) return;
    const ownCar = session.drivenVehicle?.eid ?? session.lastVehicle?.eid ?? 0;
    cars.setHeadlightTarget(ownCar);
    // The one police spotlight follows the driven (else last driven) car; it shines only when that car has one switched on.
    cars.setSpotlightTarget(ownCar);
    cars.update(alpha, lighting.nightFactor, this.renderTime, this.reducedFlash);
  }

  /** Radio keys (only while gameplay controls are active), the radio menu display and one-off hints. */
  private updateRadio(session: GameSession, dt: number, active: boolean): void {
    const ctl = this.radioCtl;
    const feed = this.policeFeedValue;
    if (!ctl || !feed) return;
    const state = ctl.update(dt, active, feed.radioContext(this.radioMode, this.targets?.target ?? null));
    this.radioMenuView.show(state.menu);
    if (state.hintSeq !== this.lastRadioHint) {
      this.lastRadioHint = state.hintSeq;
      if (state.hint !== null) this.flash(state.hint);
    }
    const s = this.radioStatus;
    const radio = session.radio;
    s.channel = channelDef(radio.selected).short;
    s.scanning = radio.scanning;
    s.tx = radio.transmitting;
    s.busy = radio.busy;
    s.emergency = radio.isHeld('dispatch') || (session.cad.unit(session.dispatcher.playerCallsign)?.emergency ?? false);
    s.mode = this.radioMode;
    s.voice = state.voice;
    s.emergencyCharge = state.emergencyCharge;
  }

  /** The reticle target at 10 Hz: a 2D ray from the camera along its forward direction. */
  private updateTarget(session: GameSession, now: number): void {
    const targets = this.targets;
    if (!targets || now < this.nextTargetMs) return;
    // Indoors no vehicle is in sight.
    if (session.officerBuilding >= 0) {
      this.nextTargetMs = now + TARGET_INTERVAL_MS;
      targets.clear();
      return;
    }
    this.nextTargetMs = now + TARGET_INTERVAL_MS;
    const camera = this.renderer?.activeCamera;
    let ox: number, oz: number, dx: number, dz: number;
    if (camera) {
      camera.getWorldPosition(scratchPos);
      camera.getWorldDirection(scratchDir);
      ox = scratchPos.x;
      oz = scratchPos.z;
      dx = scratchDir.x;
      dz = scratchDir.z;
    } else {
      // Headless: from the officer (or the driven car) along its heading.
      const at = session.playerPosition(scratchPoint);
      const v = session.drivenVehicle;
      const yaw = v ? headingOf(Transform.qx[v.eid] ?? 0, Transform.qy[v.eid] ?? 0, Transform.qz[v.eid] ?? 0, Transform.qw[v.eid] ?? 1) : session.controller.yaw;
      ox = at.x;
      oz = at.z;
      dx = -Math.sin(yaw);
      dz = -Math.cos(yaw);
    }
    targets.update(session.traffic.view, ox, oz, dx, dz, now);
  }

  /** Cockpit interior and the laptop screen, in cockpit view of a patrol car only. */
  private updateCockpit(session: GameSession, alpha: number, now: number): void {
    const cockpit = this.cockpit;
    const feed = this.policeFeedValue;
    if (!cockpit || !feed) return;
    const driven = session.drivenVehicle;
    const eid = driven?.eid ?? 0;
    if (eid !== this.cockpitEid) {
      this.cockpitEid = eid;
      cockpit.setVehicle(eid, driven?.model ?? null);
    }
    const visible = this.rig.mode === CAMERA_MODE.cockpit && session.inPatrolCar;
    cockpit.update(alpha, visible, feed.cockpitState(visible));
    if (visible && this.mdtScreen.paint(feed.screenModel(now), now)) cockpit.markScreenDirty();
  }

  /** Listener from the camera; one siren emitter per police car with `PoliceLights` (the driven one in the cabin). */
  private updateAudio(session: GameSession): void {
    const audio = this.audio;
    if (!audio.unlocked) return;
    const camera = this.renderer?.activeCamera;
    if (camera) {
      camera.getWorldPosition(scratchPos);
      camera.getWorldDirection(scratchDir);
      scratchUp.copy(camera.up).applyQuaternion(camera.getWorldQuaternion(scratchQuat));
      audio.setListener(scratchPos.x, scratchPos.y, scratchPos.z, scratchDir.x, scratchDir.y, scratchDir.z, scratchUp.x, scratchUp.y, scratchUp.z);
    } else {
      const at = session.playerPosition(scratchPoint);
      scratchPos.set(at.x, 1.6, at.z);
      audio.setListener(at.x, 1.6, at.z, 0, 0, -1, 0, 1, 0);
    }
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
    audio.sirens.update(this.emitters, n, scratchPos.x, scratchPos.z);
  }

  /** Writes emitter `n` from the `PoliceLights` of `eid` (skipped without the component); returns the new count. */
  private addEmitter(n: number, eid: number, inCabin: boolean): number {
    if (!hasPoliceLights(this.world, eid)) return n;
    let e = this.emitters[n];
    if (!e) {
      e = { id: 0, x: 0, y: 0, z: 0, tone: null, horn: false, manual: false, inCabin: false };
      this.emitters.push(e);
    }
    const siren = PoliceLights.siren[eid] ?? 0;
    const flags = PoliceLights.sirenFlags[eid] ?? 0;
    e.id = eid;
    e.x = Transform.x[eid] ?? 0;
    e.y = Transform.y[eid] ?? 0;
    e.z = Transform.z[eid] ?? 0;
    e.tone = siren > 0 ? (SIREN_TONES[siren - 1] ?? null) : null;
    e.horn = (flags & SIREN_FLAG.horn) !== 0;
    e.manual = (flags & SIREN_FLAG.manual) !== 0;
    e.inCabin = inCabin;
    return n + 1;
  }

  /** Radio channel strip (self-throttled to 4 Hz) and the caption timeout. */
  private updateRadioPanel(now: number): void {
    const panel = this.radioPanelValue;
    const feed = this.policeFeedValue;
    if (!panel || !feed) return;
    this.radioStatus.rx = feed.receiving();
    panel.setStatus(this.radioStatus, now);
    panel.update(now);
  }

  /** HUD and minimap at 10 Hz (the road lookup and prompt strings only run at that rate). */
  private updateHud(session: GameSession): void {
    const now = performance.now();
    if (now < this.nextHudMs) return;
    this.nextHudMs = now + HUD_INTERVAL_MS;
    const prompt = now < this.flashUntilMs ? this.flashText : interactPrompt(session.interactHint(), this.interactKey);
    const snapshot = this.hudFeed.fill(session, CAMERA_MODE_NAMES[this.rig.mode] ?? 'onFoot', prompt);
    const feed = this.policeFeedValue;
    feed?.fillHud(snapshot, this.targets?.target ?? null, this.radioMenuKey, now);
    this.presenter.fillHud(snapshot, session);
    this.phase4.fillHud(snapshot, session);
    this.hud.update(snapshot, now);
    const view = this.view;
    if (!view) return;
    const at = session.playerPosition(scratchPoint);
    // Indoors the minimap draws the building's floor plan.
    const building = session.officerBuilding;
    view.minimap.setFloorPlan(building >= 0 ? session.interiors.floorPlan(building) : null, at.x, at.z);
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
    // A route plotted with the console wins; otherwise the route to the player's call.
    const route = this.route ?? this.updateAutoRoute(session, at.x, at.z, now);
    view.minimap.update(at.x, at.z, yaw, dots, route, now, feed ? this.presenter.fillMarkers(feed.fillMarkers(this.markers), session) : null);
  }

  /**
   * Route line to the player's destination (the assigned call): re-planned every `ROUTE_REPLAN_MS`,
   * when the destination moves, or when the player is `ROUTE_OFF_M` off it; null without a destination.
   */
  private updateAutoRoute(session: GameSession, x: number, z: number, now: number): Float32Array | null {
    const dest = scratchDest;
    if (!session.dispatcher.playerDestination(dest)) {
      this.autoRoute = null;
      this.autoRouteX = NaN;
      return null;
    }
    const moved = Math.hypot(dest.x - this.autoRouteX, dest.z - this.autoRouteZ) > 1 || !Number.isFinite(this.autoRouteX);
    // A failed plan (no road near either end) waits for the next interval instead of retrying every tick.
    const off = this.autoRoute !== null && distanceToPolyline(this.autoRoute, x, z) > ROUTE_OFF_M;
    if (moved || off || now >= this.nextRouteMs) {
      this.autoRoute = session.city.graph.routeBetweenPoints(x, z, dest.x, dest.z)?.polyline ?? null;
      this.autoRouteX = dest.x;
      this.autoRouteZ = dest.z;
      this.nextRouteMs = now + ROUTE_REPLAN_MS;
    }
    return this.autoRoute;
  }

  private updatePerfExtras(): void {
    const now = performance.now();
    if (now < this.nextPerfExtrasMs) return;
    this.nextPerfExtrasMs = now + PERF_EXTRAS_INTERVAL_MS;
    const chunks = this.view?.streamer?.stats;
    this.perf.setExtra('chunks', chunks ? `${String(chunks.loaded)} loaded (lod0 ${String(chunks.lod0)}), ${String(chunks.inFlight)} in flight` : undefined);
    const session = this.sessionValue;
    const traffic = session?.traffic.stats;
    this.perf.setExtra('traffic', traffic ? `${String(traffic.active)} active, ${String(traffic.proxies)} proxies` : undefined);
    const cars = this.carRenderer?.stats;
    this.perf.setExtra('cars', cars && session ? `${String(cars.cars)} drawn, ${String(cars.drawCalls)} draw calls` : undefined);
    const d = session?.dispatcher.stats;
    this.perf.setExtra('dispatch', d ? `${String(d.generated)} calls, ${String(d.open)} open, ${String(d.aiBusy)} AI units busy` : undefined);
    const radio = session?.radio;
    this.perf.setExtra(
      'radio',
      radio ? `${channelDef(radio.selected).short}${radio.scanning ? ' scan' : ''}, ${String(radio.onAir.length)} on air, ${String(radio.queued)} queued` : undefined,
    );
    const a = this.audio;
    this.perf.setExtra(
      'audio',
      !a.available ? 'unavailable' : a.unlocked ? `${String(a.stats.active)}/${String(a.stats.voices)} siren voices` : 'waiting for input',
    );
    const npc = session?.npc.stats;
    this.perf.setExtra('npc', npc ? `${String(npc.peds)} peds, ${String(npc.actors)} actors, ${String(npc.occupants)} occupants, ${npc.stepMs.toFixed(2)} ms` : undefined);
    const sc = session?.scene.stats;
    this.perf.setExtra('scene', sc ? `${String(sc.scenarios)} scenarios, ${String(sc.materialized)} on scene` : undefined);
    const pp = this.presenter.stats;
    this.perf.setExtra(
      'people',
      session ? `${String(session.people.touchedCount)} touched, ${String(pp.figures)} drawn, ${String(pp.props)} props, ${String(pp.drawCalls)} draw calls` : undefined,
    );
    const interiors = session?.interiors.stats;
    this.perf.setExtra('interiors', interiors ? `${String(interiors.resident)} resident, ${String(interiors.colliders)} colliders, ${String(interiors.occupants)} occupants, ${interiors.stepMs.toFixed(3)} ms` : undefined);
    const inv = session?.investigation;
    this.perf.setExtra('investigation', inv && session ? `${String(inv.store.files().length)} files, ${String(session.investigation.ledger.entries().length)} custody entries, rev ${String(inv.revision)}` : undefined);
    const tac = session?.tactical;
    this.perf.setExtra('tactical', tac ? `noise ${tac.noise.toFixed(2)}, vis ${tac.visibility.toFixed(2)}${tac.stance.crouched ? ', crouched' : ''}${tac.flashlightOn ? ', light' : ''}` : undefined);
    const idraw = this.phase4.interiorRenderer?.drawCalls ?? 0;
    this.perf.setExtra('interior draw', idraw > 0 ? `${String(idraw)} draw calls` : undefined);
    const cockpit = this.cockpit?.stats.drawCalls ?? 0;
    this.perf.setExtra('cockpit', cockpit > 0 ? `${String(cockpit)} draw calls` : undefined);
  }

  /** Replaces the prompt line with `text` for a moment. */
  private flash(text: string): void {
    this.flashText = text;
    this.flashUntilMs = performance.now() + FLASH_MS;
    this.nextHudMs = 0;
  }

  // --- sessions ---------------------------------------------------------------

  private context(seed: number): GameContext {
    return {
      world: this.world,
      physics: this.physicsValue,
      meshes: this.meshes,
      bus: this.bus,
      city: this.cityFor(seed),
      radioMode: () => this.radioMode,
      indoorScenes: this.indoorScenes,
    };
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
    this.beginPatrol(session);
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
      this.endPatrol();
      for (const vehicle of session.vehicles) this.carRenderer?.setDrivable(vehicle.eid, null);
      this.carRenderer?.setHeadlightTarget(0);
      this.carRenderer?.setSpotlightTarget(0);
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

  /** Per-session Phase 2 presentation: HUD feed, target lock, MDT overlay, radio log (with the saved log's last lines) and radio keys. */
  private beginPatrol(session: GameSession): void {
    this.policeFeedValue = new PoliceFeed(session, this.bus);
    this.targets = new TargetTracker(session.seed);
    this.mdtValue = new MdtOverlay(
      this.ui,
      createMdtDeps(session, {
        target: () => this.targets?.target ?? null,
        bookingCompleted: (_id, released) => this.flash(released >= 0 ? 'Booking complete: prisoner handed over' : 'Booking complete'),
      }),
    );
    const panel = new RadioPanel(this.ui.hud);
    for (const tx of session.radio.log.filter((t) => t.audible).slice(-RADIO_LOG_RESTORE)) panel.addLine(radioLine(tx));
    this.radioPanelValue = panel;
    this.radioCtl = new RadioController({
      input: this.input,
      radio: session.radio,
      speechIn: this.speechIn.available ? this.speechIn : null,
    });
    this.presenter.begin(session);
    this.phase4.begin();
    this.doorHoldMs = -1;
    this.lastRadioHint = 0;
    this.autoRoute = null;
    this.autoRouteX = NaN;
    this.nextRouteMs = 0;
    this.nextTargetMs = 0;
    this.cockpitEid = -1;
  }

  private endPatrol(): void {
    this.panels.close();
    this.presenter.end();
    this.phase4.end();
    this.mdtValue?.dispose();
    this.mdtValue = null;
    this.radioCtl?.dispose();
    this.radioCtl = null;
    this.radioPanelValue?.dispose();
    this.radioPanelValue = null;
    this.radioMenuView.show(null);
    this.policeFeedValue?.dispose();
    this.policeFeedValue = null;
    this.targets = null;
    this.autoRoute = null;
    this.cockpit?.setVehicle(0, null);
    this.cockpitEid = 0;
    // The radio player outlives the session: forget its transmissions, pending tone and utterance.
    this.radioPlayer.reset();
  }

  /** Phase 2 console commands: records, CAD, traffic, police, audio, dispatch, radio and the patrol shortcuts. */
  private patrolCommands(): Command[] {
    const session = (): GameSession | null => this.sessionValue;
    const position = (): { x: number; z: number } | null => session()?.playerPosition({ x: 0, z: 0 }) ?? null;
    return [
      ...createRecordsCommands({ records: () => session()?.records ?? null, seed: () => session()?.seed ?? null }),
      ...createCadCommands({ cad: () => session()?.cad ?? null }),
      ...createTrafficCommands({
        traffic: () => session()?.traffic ?? null,
        playerPosition: position,
        playerHeading: () => {
          const s = session();
          if (!s) return null;
          const v = s.drivenVehicle;
          return v ? headingOf(Transform.qx[v.eid] ?? 0, Transform.qy[v.eid] ?? 0, Transform.qz[v.eid] ?? 0, Transform.qw[v.eid] ?? 1) : s.controller.yaw;
        },
      }),
      ...createPoliceCommands({ equipment: () => session()?.lastEquipment ?? null }),
      ...createAudioCommands({ audio: () => this.audio, speech: () => this.speechOut }),
      ...createDispatchCommands({ dispatcher: () => session()?.dispatcher ?? null, now: () => session()?.now() ?? null, playerPosition: position }),
      ...createPatrolCommands({ session }),
      ...createPeopleCommands({ people: () => session()?.people ?? null }),
      ...createNpcCommands({ npc: () => session()?.npc ?? null }),
      ...createSceneCommands({ scene: () => session()?.scene ?? null, now: () => session()?.now() ?? null, playerPosition: position }),
      ...createCallsCommands(),
      ...createPhase3Commands({ session }),
      ...createPhase4Commands({ session, flash: (text) => this.flash(text) }),
    ];
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

  /**
   * Single owner of `loop.paused`: paused by the console command or while a pausing menu is open (the
   * MDT and the action panels set `pausesGame` false: the world keeps running behind them). Audio and
   * speech follow the pause.
   */
  private refreshPause(): void {
    const paused = this.userPausedValue || this.ui.menuStack.some((m) => m.pausesGame !== false);
    if (paused === this.loop.paused) return;
    this.loop.paused = paused;
    if (paused) this.audio.suspend();
    else this.audio.resume();
    this.radioPlayer.setPaused(paused);
    this.bus.emit('app:pause', { paused });
  }

  /**
   * The browser swallows the Escape that releases pointer lock, so treat losing the lock as Escape:
   * close the radio menu when it is open, else pause.
   */
  private onPointerLockLost(): void {
    const playing = this.inGame && !this.ui.isMenuOpen() && !this.console.isOpen();
    if (!playing || (this.renderer?.debugCameraEnabled ?? false)) return;
    const radioMenu = this.sessionValue?.radio.menu;
    if (radioMenu?.isOpen) radioMenu.close();
    else this.pauseMenu.open();
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
          this.radioMenuKey = keyLabel(bindings['radio.menu']);
        }
        if (all || change.path === 'controls.gamepadDeadzone') {
          this.input.setDeadzone(settings.get('controls.gamepadDeadzone'));
        }
        if (all || change.path === 'controls.mouseSensitivity') this.mouseSensitivity = settings.get('controls.mouseSensitivity');
        if (all || change.path === 'controls.invertY') this.invertY = settings.get('controls.invertY');
        if (all || change.path === 'accessibility.reducedFlash') this.reducedFlash = settings.get('accessibility.reducedFlash');
        if (all || change.path.startsWith('audio.') || change.path === 'accessibility.subtitles') this.applyAudioSettings();
      }),
      this.ui.onMenuChange(() => {
        this.menuChangedSinceUpdate = true;
        this.refreshPause();
        this.refreshPointerLock();
      }),
      this.input.onPointerLockLost(() => this.onPointerLockLost()),
      this.bus.on('save:completed', () => void this.refreshSaveList()),
      // Radio log and captions (written on events, presentation only).
      this.bus.on('radio:start', (e) => this.onRadioStart(e.tx)),
      this.bus.on('radio:blocked', (e) => {
        for (const id of e.ids) this.radioPanelValue?.markBlocked(id);
      }),
      // Phase 4 one-off lines: door and interior messages, investigation messages.
      this.bus.on('interior:flash', (e) => this.flash(e.text)),
      this.bus.on('investigation:flash', (e) => this.flash(e.text)),
      // MDT requests are answered silently (design §8, §9.3): the dispatcher's answer, a refusal above all, shows on the MDT.
      this.bus.on('dispatch:ack', (e) => {
        const session = this.sessionValue;
        if (session && e.callsign === session.dispatcher.playerCallsign) this.mdtValue?.notify(e.text, e.ok);
      }),
      // A plate run from the keys or the MDT is silent on the radio: a hit beeps here (radio runs beep in RadioPlayer).
      this.bus.on('dispatch:plateResult', (e) => {
        if ((e.via === 'key' || e.via === 'mdt') && e.readback.hits.length > 0 && e.readback.severity !== 'clear') this.audio.radio.alertTone('hit');
      }),
    );
    this.interactKey = keyLabel(settings.get('controls.bindings').interact);
    this.radioMenuKey = keyLabel(settings.get('controls.bindings')['radio.menu']);
    this.applyAudioSettings();
    // Web Audio may only start from a user gesture: every pointer or key press (re)tries (idempotent and cheap).
    const unlockAudio = (): void => this.audio.unlock();
    window.addEventListener('pointerdown', unlockAudio, true);
    window.addEventListener('keydown', unlockAudio, true);
    this.disposers.push(() => {
      window.removeEventListener('pointerdown', unlockAudio, true);
      window.removeEventListener('keydown', unlockAudio, true);
    });
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

  /** Volumes, text-to-speech, voice commands, radio language and captions from the settings. */
  private applyAudioSettings(): void {
    const a = this.settings.get().audio;
    this.audio.setVolumes({ master: a.master, sfx: a.sfx, radio: a.radio });
    this.speechOut.enabled = a.tts;
    // Switching spoken radio off also stops the (paused) utterance, so it does not resume later.
    if (!a.tts) this.speechOut.cancel();
    this.speechOut.preferredVoice = a.ttsVoice;
    // Speech does not go through the Web Audio radio bus, so it gets the same volume product here.
    this.speechOut.volume = a.master * a.radio;
    this.speechIn.enabled = a.voiceCommands;
    this.radioMode = a.radioMode;
    this.subtitles = this.settings.get('accessibility.subtitles');
    this.presenter.setSubtitles(this.subtitles);
    if (!this.subtitles) this.radioPanelValue?.setCaption(null, 0);
  }

  /** An audible transmission started: radio log line, and the caption when captions are on. */
  private onRadioStart(tx: Readonly<Transmission>): void {
    const panel = this.radioPanelValue;
    if (!panel || !tx.audible) return;
    panel.addLine(radioLine(tx));
    if (this.subtitles) panel.setCaption(`${tx.speaker}: ${tx.text}`, performance.now() + tx.duration * 1000 + CAPTION_LINGER_MS);
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

/** Radio log line of a transmission (channel short tag, own lines marked). */
function radioLine(tx: Readonly<Transmission>): RadioLine {
  return {
    id: tx.id,
    channel: channelDef(tx.channel).short,
    speaker: tx.speaker,
    text: tx.text,
    clock: tx.clock,
    blocked: tx.blocked,
    priority: tx.priority,
    self: tx.speakerKind === 'player',
  };
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
