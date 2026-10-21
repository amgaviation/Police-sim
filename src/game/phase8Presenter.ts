/**
 * Presentation of Phase 8 (design §11-§13, §20.4): the academy, career, apartment, shift-summary and trainee screens and
 * their hosts, the driving course cones and result flow, the dispatch console (local and co-op ports), the scenario editor,
 * the mod manager, the co-op lobby and panel and the HUD / MDT feed. It changes the simulation only through career and
 * world requests, `Dispatcher` calls and the session's mode helpers.
 */
import * as THREE from 'three';
import { UNITS_DATA } from '../dispatch/data';
import { SECONDS_PER_DAY } from '../environment/time';
import { academyPassed } from '../career';
import type { AcademyModule, CareerRank, CareerRequest, ShiftSummary } from '../career';
import { activeModRefs } from '../mods/registry';
import { defaultModContext } from '../mods/schema';
import { ModStore } from '../mods/store';
import type { BootResult } from '../mods/boot';
import { ConeRenderer } from '../render/training/coneRenderer';
import { defaultScenarioContext, conePositions, findCourse, type SandboxScenario } from '../training';
import {
  AcademyScreen, ApartmentScreen, CareerScreen, LegalQuizScreen, ReportExerciseScreen, ShiftSummaryScreen, TraineeEvalPanel,
  examLevelFor, standaloneAcademyHost, type AcademyHost, type CareerTab,
} from '../ui/career';
import { courseLine, coopChip, shiftLine } from '../ui/hud/phase8';
import type { Hud } from '../ui/hud/hud';
import { CoopLobby, CoopPanel, type CoopLobbyHost } from '../ui/coop';
import { DispatchConsole } from '../ui/dispatch';
import type { DispatchConsolePort } from '../ui/dispatch/model';
import { ModManager } from '../ui/mods';
import { ScenarioEditor } from '../ui/sandbox';
import type { UIRoot } from '../ui/ui';
import { NetClient, PROTOCOL_VERSION } from '../net';
import { CoopSession, NetConsolePort } from './coop';
import { LocalConsolePort } from './consolePorts';
import { leaveDrivingCourse, runScenario, startDrivingCourse } from './modes';
import type { GameSession } from './session';

/** What the presenter needs from the app. */
export interface Phase8PresenterHost {
  session(): GameSession | null;
  /** One-off HUD line. */
  flash(text: string): void;
  /** Report for duty: starts the next shift (asynchronously) or returns why not. */
  reportForDuty(): { ok: boolean; reason: string } | undefined;
  /** Closes the Phase 7 fleet panel (the career summary replaces it). */
  closeFleetPanel(): void;
  /** The co-op lobby's Start: a new co-op game with this client (the room's seed). */
  startCoop(client: NetClient): void;
  /** Cone rendering needs the scene (null headless). */
  scene(): THREE.Scene | null;
  /** Mods booted for this page. */
  boot(): BootResult;
}

const PANEL_INTERVAL_MS = 250;
/** The driving course result stays on the HUD line for this long (ms) after the run. */
const COURSE_RESULT_MS = 6000;

/** Court dates for the apartment, one line per scheduled case. */
function courtLines(session: GameSession): string[] {
  const out: string[] = [];
  for (const c of session.court.cases()) {
    if (c.status !== 'scheduled' && c.status !== 'pending') continue;
    out.push(`${c.id}: ${c.personLabel} — hearing ${c.hearingGame > 0 ? clockOf(c.hearingGame) : 'not set'}`);
  }
  return out;
}

function clockOf(game: number): string {
  const day = Math.floor(game / SECONDS_PER_DAY);
  const s = ((Math.floor(game) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `day ${String(day)} ${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`;
}

export class Phase8Presenter {
  readonly academy: AcademyScreen;
  readonly careerScreen: CareerScreen;
  readonly apartment: ApartmentScreen;
  readonly summary: ShiftSummaryScreen;
  readonly trainee: TraineeEvalPanel;
  readonly modManager: ModManager;
  readonly lobby: CoopLobby;
  readonly cones: ConeRenderer | null;
  /** The scenario editor (created per session: it needs the road graph). */
  editor: ScenarioEditor | null = null;
  /** The dispatch console while it exists. */
  console: DispatchConsole | null = null;
  coopPanel: CoopPanel | null = null;
  coop: CoopSession | null = null;
  /** A standalone (no session) minigame or academy hub from the title screen. */
  standalone: AcademyScreen | null = null;
  reportScreen: ReportExerciseScreen | null = null;
  quizScreen: LegalQuizScreen | null = null;
  /** The lobby's client while it connects. */
  lobbyClient: NetClient | null = null;
  lobbyText = '';

  private readonly host: Phase8PresenterHost;
  private readonly ui: UIRoot;
  private readonly store = new ModStore();
  private offs: (() => void)[] = [];
  private lastCourse: { gate: number; gates: number; cones: number; timeS: number } | null = null;
  private courseUntilMs = 0;
  private courseText = '';
  private orderLine = '';
  private orderUntilMs = 0;
  private coopStatus: { connected: boolean; unit: string; members: number } | null = null;
  private coneXz = new Float32Array(128);
  private coneKnocked = -1;
  private nextPanelMs = 0;
  private lastSummary: ShiftSummary | null = null;
  private lobbyStarted = false;

  constructor(ui: UIRoot, host: Phase8PresenterHost) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.ui = ui;
    this.host = host;
    const scene = host.scene();
    this.cones = scene ? new ConeRenderer(scene) : null;
    this.academy = new AcademyScreen(ui, this.academyHost());
    this.careerScreen = new CareerScreen(ui, this.careerHost());
    this.apartment = new ApartmentScreen(ui, {
      view: () => this.p8().career.view,
      plan: (a, h) => this.p8().career.planActivity(a, h),
      courtLines: () => {
        const s = host.session();
        return s ? courtLines(s) : [];
      },
      reportForDuty: () => host.reportForDuty(),
      openCareer: () => this.careerScreen.open(),
      neglect: () => this.p8().career.serialize().neglect,
    });
    this.summary = new ShiftSummaryScreen(ui, {
      continue: () => {
        this.summary.close();
        this.apartment.open();
      },
      // The rating button shows only for an officer who is a field training officer.
      get rateTrainee(): (() => void) | undefined {
        return self.p8Safe()?.career.view.assignment === 'fto' ? () => void self.trainee.open() : undefined;
      },
    });
    this.trainee = new TraineeEvalPanel(ui, {
      trainee: () => this.p8().career.view.trainee,
      request: (r) => this.request(r),
      close: () => this.trainee.close(),
    });
    this.modManager = new ModManager(ui, {
      store: this.store,
      context: () => defaultModContext(),
      active: () => activeModRefs(),
      bootErrors: () => host.boot().errors,
      safeMode: () => host.boot().safeMode,
      reload: () => location.reload(),
      close: () => undefined,
    });
    this.lobby = new CoopLobby(ui, this.lobbyHost());
  }

  private p8Safe(): GameSession['phase8'] | null {
    return this.host.session()?.phase8 ?? null;
  }

  private p8(): GameSession['phase8'] {
    const s = this.host.session();
    if (!s) throw new Error('No game running');
    return s.phase8;
  }

  /** Queues a career request and drains it at once (the screens pause the game, so the career step does not run). */
  request(r: CareerRequest): void {
    const s = this.host.session();
    if (!s) return;
    s.phase8.career.request(r);
    s.phase8.career.step(0, s.now());
  }

  // --- Hosts ----------------------------------------------------------------------------------------

  private academyHost(): AcademyHost {
    const host = this.host;
    return {
      standalone: false,
      seed: () => host.session()?.seed ?? 0,
      records: () => this.p8().career.view.academy,
      mods: () => this.p8().perf,
      submit: (module: AcademyModule, score: number) => this.request({ kind: 'academyScore', module, score }),
      startDrivingCourse: (courseId: string) => this.beginCourse(courseId),
      canGraduate: () => academyPassed(this.p8().career.view.academy),
      graduate: () => {
        this.request({ kind: 'graduate' });
        this.academy.close();
      },
      close: () => this.academy.close(),
    };
  }

  private careerHost(): import('../ui/career').CareerHost {
    return {
      view: () => this.p8().career.view,
      eligibility: () => this.p8().eligibility(),
      names: () => UNITS_DATA.units.map((u) => u.officer),
      request: (r) => this.request(r),
      startExam: (rank: CareerRank, done) => {
        const s = this.host.session();
        if (!s) return;
        const screen = new LegalQuizScreen(this.ui, {
          mode: 'exam',
          level: examLevelFor(rank),
          seed: s.seed,
          attempt: s.phase8.career.view.history.length,
          onScore: done,
          onExit: () => screen.close(),
        });
        this.quizScreen = screen;
        screen.open();
      },
      close: () => this.careerScreen.close(),
    };
  }

  private lobbyHost(): CoopLobbyHost {
    return {
      connect: (url, room, name, role) => {
        this.lobbyClient?.close();
        const client = new NetClient();
        this.lobbyClient = client;
        this.lobbyStarted = false;
        client.connect(url, { t: 'hello', v: PROTOCOL_VERSION, name, role, room });
      },
      status: () => {
        const c = this.lobbyClient;
        if (!c) return { state: 'idle', text: '' };
        const w = c.welcome;
        const text =
          c.state === 'joined' && w
            ? `Joined room ${w.snapshot.room} as ${w.callsign} (${String(w.snapshot.units.length)} online)`
            : c.state === 'failed' || c.state === 'closed'
              ? `Could not join: ${c.reason === '' ? 'connection closed' : c.reason}`
              : c.state === 'connecting'
                ? 'Connecting...'
                : '';
        return { state: c.state, text };
      },
      start: () => {
        const c = this.lobbyClient;
        if (!c || c.state !== 'joined' || this.lobbyStarted) return;
        this.lobbyStarted = true;
        this.lobbyClient = null;
        this.host.startCoop(c);
      },
      cancel: () => {
        this.lobbyClient?.close();
        this.lobbyClient = null;
      },
    };
  }

  // --- Session lifecycle ----------------------------------------------------------------------------

  /** Session start: bridges that open the screens. */
  begin(session: GameSession): void {
    this.end();
    const bus = session.bus;
    this.offs.push(
      bus.on('career:shiftSummary', (s) => {
        this.lastSummary = s;
        this.host.closeFleetPanel();
        this.summary.open(s);
      }),
      bus.on('training:course', (e) => {
        this.lastCourse = { gate: e.gate, gates: e.gates, cones: e.cones, timeS: e.timeS };
        if (e.done) this.courseUntilMs = performance.now() + COURSE_RESULT_MS;
        this.syncCones(session);
      }),
      bus.on('coop:status', (e) => {
        this.coopStatus = e;
      }),
      bus.on('coop:order', (e) => {
        this.orderLine = e.line;
        this.orderUntilMs = performance.now() + 8000;
      }),
      bus.on('coop:flash', (e) => this.host.flash(e.text)),
    );
    // The editor needs the road graph of this city.
    this.editor = new ScenarioEditor(this.ui, {
      graph: session.city.graph,
      context: defaultScenarioContext(),
      anchor: () => session.playerPosition({ x: 0, z: 0 }),
      run: (doc) => this.runScenarioDoc(doc),
      close: () => this.editor?.close(),
    });
    this.coneKnocked = -1;
  }

  end(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.closeConsole();
    this.editor?.close();
    this.editor = null;
    this.coopPanel = null;
    this.coop?.dispose();
    this.coop = null;
    this.coopStatus = null;
    this.lastCourse = null;
    this.courseText = '';
    this.orderLine = '';
    this.cones?.clear();
    for (const m of [this.academy, this.careerScreen, this.apartment, this.summary, this.trainee]) if (m.isOpen) m.close();
  }

  dispose(): void {
    this.end();
    this.cones?.dispose();
    this.lobbyClient?.close();
  }

  // --- Career screens -------------------------------------------------------------------------------

  openAcademy(): void {
    this.academy.open();
  }

  openCareer(tab?: CareerTab): void {
    this.careerScreen.open(tab);
  }

  openApartment(): void {
    this.apartment.open();
  }

  /** Training > Academy drills from the title screen: the hub over stored records, no world. */
  openStandaloneAcademy(): void {
    let storage: Pick<Storage, 'getItem' | 'setItem'> | null;
    try {
      storage = typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      storage = null;
    }
    const host = standaloneAcademyHost(storage, () => this.standalone?.close());
    this.standalone = new AcademyScreen(this.ui, host);
    this.standalone.open();
  }

  /** Training > Report writing from the title screen. */
  openStandaloneReport(): void {
    const seed = 20_240_601;
    const screen = new ReportExerciseScreen(this.ui, { seed, attempt: 0, onScore: () => undefined, onExit: () => screen.close() });
    this.reportScreen = screen;
    screen.open();
  }

  // --- Driving course -------------------------------------------------------------------------------

  /** Starts the course (academy hub or console): the hub closes and the officer is seated in the car at the start. */
  beginCourse(courseId: string): string | null {
    const s = this.host.session();
    if (!s) return 'No game running';
    this.academy.close();
    const reason = startDrivingCourse(s, courseId);
    if (reason !== null) {
      this.host.flash(reason);
      return reason;
    }
    this.coneKnocked = -1;
    this.lastCourse = null;
    this.syncCones(s);
    return null;
  }

  /** Cones in the world follow the run: positions once, knocked cones on every course event. */
  private syncCones(session: GameSession): void {
    const cones = this.cones;
    const m = session.phase8.mode;
    if (!cones) return;
    const run = m.course;
    const course = m.courseId === null ? undefined : findCourse(m.courseId);
    if (!run || !course || !m.anchor) {
      cones.clear();
      return;
    }
    const n = conePositions(m.anchor, course, this.coneXz);
    const knocked = run.coneHits().reduce((a, b) => a + b, 0);
    if (knocked === this.coneKnocked) return;
    this.coneKnocked = knocked;
    cones.set(this.coneXz, n, run.coneHits(), 0);
  }

  /** Called every frame: the run ended -> the score goes to the academy (career) or the result flash; back to the lot. */
  private finishCourse(session: GameSession): void {
    const p8 = session.phase8;
    const run = p8.mode.course;
    if (!run || (!run.done && !run.aborted)) return;
    const result = run.result();
    const career = p8.career.view.academy.driving;
    const inCareer = p8.mode.id === 'career' && career !== undefined;
    const text = run.aborted ? 'Course aborted' : `Course complete: score ${String(result.score)} (${String(result.cones)} cones, ${String(result.missed)} missed gates, ${result.timeS.toFixed(1)} s)`;
    this.host.flash(text);
    this.courseText = text;
    this.courseUntilMs = performance.now() + COURSE_RESULT_MS;
    if (!run.aborted) {
      if (inCareer) this.request({ kind: 'academyScore', module: 'driving', score: result.score });
      p8.takeCourseScore();
    }
    this.cones?.clear();
    this.coneKnocked = -1;
    p8.stopCourse();
    leaveDrivingCourse(session);
    if (inCareer) this.academy.open();
  }

  // --- Dispatch console -----------------------------------------------------------------------------

  /** The console port of the running session: the co-op room for a dispatcher / supervisor, else the local CAD. */
  private consolePort(session: GameSession): DispatchConsolePort | null {
    const coop = this.coop;
    if (coop?.connected === true && coop.role !== 'patrol') return new NetConsolePort(coop, () => performance.now());
    if (session.phase8.modeId === 'dispatchOnly') return new LocalConsolePort(session);
    return null;
  }

  openConsole(): boolean {
    const s = this.host.session();
    if (!s) return false;
    if (this.console?.isOpen === true) return true;
    const port = this.consolePort(s);
    if (!port) {
      this.host.flash('The dispatch console is for dispatch-only mode and the co-op dispatcher / supervisor');
      return false;
    }
    this.console = new DispatchConsole(this.ui, port, s.city.graph, () => this.closeConsole());
    this.console.open();
    return true;
  }

  closeConsole(): void {
    this.console?.close();
    this.console = null;
  }

  toggleConsole(): void {
    if (this.console?.isOpen === true) this.closeConsole();
    else this.openConsole();
  }

  // --- Sandbox --------------------------------------------------------------------------------------

  openEditor(doc?: SandboxScenario): void {
    this.editor?.open(doc);
  }

  /** The editor's Run: the editor closes, the scenario is spawned into the world. */
  runScenarioDoc(doc: SandboxScenario): void {
    const s = this.host.session();
    this.editor?.close();
    if (!s) return;
    const err = runScenario(s, doc);
    this.host.flash(err ?? `Scenario ${doc.name} running`);
  }

  // --- Co-op ----------------------------------------------------------------------------------------

  /** A co-op game started with `client`: the layer, the panel and (for a dispatcher / supervisor) the console. */
  beginCoop(session: GameSession, client: NetClient): void {
    this.coop?.dispose();
    this.coop = new CoopSession(session, client, {
      flash: (t) => this.host.flash(t),
      disconnected: () => {
        this.closeConsole();
      },
    });
    this.coopPanel = new CoopPanel(this.ui, {
      state: () => this.coop?.panelState() ?? { members: [], self: '', partner: null, orders: [] },
      requestPartner: (u) => this.coop?.requestPartner(u),
      sendRadio: (t) => this.coop?.sendRadio(t),
      disconnect: () => {
        this.coop?.disconnect();
        this.coopPanel?.close();
      },
    });
    if (this.coop.role !== 'patrol') this.openConsole();
  }

  openCoopPanel(): void {
    if (!this.coop || !this.coopPanel) {
      this.host.flash('Not in a co-op session (main menu > Multiplayer)');
      return;
    }
    if (this.coopPanel.isOpen) this.coopPanel.close();
    else this.coopPanel.open();
  }

  // --- Per frame ------------------------------------------------------------------------------------

  /** Called every frame of a running session. */
  update(session: GameSession, nowMs: number): void {
    this.coop?.update(nowMs);
    if (this.console?.isOpen === true) this.console.update(nowMs);
    this.editor?.update();
    if (session.phase8.mode.course !== null) this.finishCourse(session);
    if (nowMs < this.nextPanelMs) return;
    this.nextPanelMs = nowMs + PANEL_INTERVAL_MS;
    if (this.apartment.isOpen) this.apartment.update(nowMs);
    if (this.coopPanel?.isOpen === true) this.coopPanel.update();
  }

  /** HUD fields of the career, course and co-op chips (called at the HUD rate). */
  feedHud(hud: Hud, session: GameSession, nowMs: number): void {
    const p8 = session.phase8;
    const v = p8.career.view;
    if (v.shift.onDuty && p8.modeId !== 'dispatchOnly' && p8.modeId !== 'sandbox' && p8.modeId !== 'drivingAcademy') {
      hud.setCareer({
        fatigue: v.wellbeing.fatigue,
        stress: v.wellbeing.stress,
        shiftLine: shiftLine(session.now().game, v.shift.startGame, v.shift.endGame),
        vignette: p8.perf.vignette,
      });
    } else {
      hud.setCareer(null);
    }
    const running = p8.mode.course !== null;
    hud.setCourseLine(running ? courseLine(this.lastCourse ?? { gate: 0, gates: findCourse(p8.mode.courseId ?? '')?.gates.length ?? 0, cones: 0, timeS: 0 }) : nowMs < this.courseUntilMs ? this.courseText : '');
    hud.setCoopChip(this.coopStatus ? coopChip(this.coopStatus) : '');
    hud.setOrderLine(nowMs < this.orderUntilMs ? this.orderLine : '');
  }

  /** The last shift summary (tests, console). */
  get summaryShown(): ShiftSummary | null {
    return this.lastSummary;
  }
}
