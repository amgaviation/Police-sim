/**
 * Menu key audit (Phase 9, design §7.4): every `Menu` must (a) close or go back on Escape, (b) move a highlight or focus with
 * the arrow keys (its own handling, or the UIRoot fallback over its real buttons: a menu that returns false for an arrow key
 * lets `UIRoot` move focus, see test/ui9/focus.test.ts) and (c) activate with Enter or a focused button (a menu that
 * returns false for Enter on a BUTTON target leaves the click to the button). Digit-only choice menus keep their digits.
 *
 * Audit result  (O = own handling, F = UIRoot arrow fallback over real buttons, * = changed in Phase 9)
 *
 *   menu                       Escape                         arrows            Enter / activate
 *   career/academy             leave (host.close)             F (Start rows)    focused button; digits 1-5
 *   career/apartment *         close (was ignored)            F                 focused button
 *   career/careerScreen        host.close                     O left/right tabs, F up/down   focused button
 *   career/summary *           continue (was ignored)         F                 Enter continues
 *   career/trainee             close                          O up/down rows, left/right rating   submit
 *   character/characterCreator cancel                         F                 focused button
 *   coop/lobby                 cancel                         F                 focused button
 *   coop/prompt                cancel                         text field        form submit
 *   court/courtroomPanel *     leave at the rulings; Backspace-like step back later (was a dead key)
 *                                                             F (answer buttons, focus follows the page)   focused button (Enter on a button is no longer eaten); digits 1-3
 *   dialogue/dialoguePanel *   back / close                   O up/down rows, left/right tone   Enter = highlighted row; Tab / Shift+Tab (pad RB / LB) switch tabs
 *   dialogue/sfstPanel *       close                          O (test keys)     Enter = Space of the test, closes when finished
 *   dispatch/console *         leave                          O up/down calls, left/right units   Enter = assign (A); on a button: its click
 *   investigation/cameraOverlay   close                       O up/down zoom    Enter = shutter
 *   investigation/caseFilePanel   close                       O up/down rows, left/right tabs   Enter = next custody step
 *   investigation/fingerprintPanel cancel                     O move cursor     Enter = lift
 *   livery/liveryEditor        cancel                         F                 focused button
 *   mdt/overlay                close (a form first)           O tabs / list rows   Enter on a row
 *   mods/modManager            leave                          F                 focused button
 *   panels/actionPanel         close                          O up/down rows    Enter = highlighted option; digits
 *   review/reviewPanel         close                          O left/right scrub, up/down events   digits pick; focused button
 *   sandbox/editor             leave (a field first)          F                 focused button
 *   settingsMenu *             close (capture takes Escape)   F (all keys consumed while a rebind captures)   focused button
 *   station/briefingScreen     close                          -                 Enter closes
 *
 * `game/pauseMenu.ts` and `ui/mainMenu.ts` are buttons only: they work through the UIRoot fallback.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateOfficerLoadout, officerPreset, validateVehicleLoadout } from '../../src/gear';
import type { VehicleLoadout } from '../../src/gear';
import { DEFAULT_LIVERIES, defaultLivery, type LiveryDoc } from '../../src/livery';
import { defaultCharacter } from '../../src/uniform';
import { vehicleModel } from '../../src/vehicles/model';
import { SettingsStore } from '../../src/settings/settings';
import type { InputManager } from '../../src/input/input';
import { AcademyScreen, ApartmentScreen, CareerScreen, ShiftSummaryScreen, TraineeEvalPanel } from '../../src/ui/career';
import type { AcademyHost } from '../../src/ui/career';
import { CharacterCreator, type CreatorHost } from '../../src/ui/character';
import { CoopLobby, LinePrompt } from '../../src/ui/coop';
import { CourtroomPanel, courtroomViewOf, reduceCourtKey } from '../../src/ui/court/courtroomPanel';
import { DialoguePanel } from '../../src/ui/dialogue/dialoguePanel';
import { SfstPanel } from '../../src/ui/dialogue/sfstPanel';
import { DispatchConsole } from '../../src/ui/dispatch/console';
import { CameraOverlay } from '../../src/ui/investigation/cameraOverlay';
import { FingerprintPanel } from '../../src/ui/investigation/fingerprintPanel';
import { reduceCaseKey } from '../../src/ui/investigation/caseFilePanel';
import { LiveryEditor, type LiveryEditorHost } from '../../src/ui/livery';
import { MdtOverlay } from '../../src/ui/mdt';
import { ModManager, type ModManagerHost } from '../../src/ui/mods/modManager';
import { ActionPanel } from '../../src/ui/panels/actionPanel';
import { EvidenceReviewPanel } from '../../src/ui/review';
import { ScenarioEditor, type EditorHost } from '../../src/ui/sandbox/editor';
import { SettingsMenu } from '../../src/ui/settingsMenu';
import { BriefingScreen } from '../../src/ui/station/briefingScreen';
import type { UIRoot } from '../../src/ui/ui';
import type { RoadGraph } from '../../src/world/roadGraph';
import { defaultScenarioContext } from '../../src/training/scenario';
import { CAREER_CONFIG, ACADEMY_MODULES, type AcademyModule, type AcademyRecord } from '../../src/career';
import { handlers as dialogueHandlers, keyEvent as dialogueKey, sfst, view as dialogueView } from '../dialogueui/fixtures';
import { FakePort, call, unit } from '../uimodes/helpers';
import { key as mdtKey, fixture as mdtFixture } from '../mdt/helpers';
import { key as reviewKey, makeFooter, makeSource } from '../review/helpers';
import { FakeElement, fakeUi, findAll, installFakeDom } from '../ui7/fakeDom';
import { key as careerKey, offDutyHarness } from '../uicareer/helpers';

/** A KeyboardEvent stand-in: `{ key, code, preventDefault }` plus the usual flags. */
function ev(key: string, extra: Record<string, unknown> = {}): KeyboardEvent {
  return { key, code: key, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: null, preventDefault: () => undefined, ...extra } as unknown as KeyboardEvent;
}

const button = { tagName: 'BUTTON' };
const field = { tagName: 'INPUT', type: 'text' };

let undoDom: () => void = () => undefined;
beforeAll(() => {
  undoDom = installFakeDom();
});
afterAll(() => undoDom());

// --- changed menus -------------------------------------------------------------------------------------------------------------

describe('apartment (changed)', () => {
  function make() {
    const h = offDutyHarness();
    const calls: string[] = [];
    const screen = new ApartmentScreen(null, {
      view: () => h.career.view,
      plan: (a, hours) => h.career.planActivity(a, hours),
      courtLines: () => [],
      reportForDuty: () => {
        calls.push('report');
        return { ok: true, reason: '' };
      },
      openCareer: () => calls.push('career'),
    });
    return { screen, calls };
  }

  it('Escape closes the apartment (it can be reopened with the career key); arrows and Enter stay with the buttons', () => {
    const { screen } = make();
    screen.open();
    for (const k of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter']) expect(screen.onKeyDown(ev(k)), k).toBe(false);
    expect(screen.isOpen).toBe(true);
    expect(screen.onKeyDown(ev('Escape'))).toBe(true);
    expect(screen.isOpen).toBe(false);
    expect(screen.onKeyDown(ev('Escape'))).toBe(false);
  });
});

describe('shift summary (changed)', () => {
  // The screen reads the tag through `instanceof HTMLElement`: give node one.
  class FakeHtml {
    readonly tagName = 'BUTTON';
    readonly dataset: Record<string, string> = {};
  }
  const g = globalThis as unknown as { HTMLElement?: unknown };

  it('Escape and Enter both continue, once; a focused button keeps its own Enter', () => {
    const before = g.HTMLElement;
    g.HTMLElement = FakeHtml;
    const summary = offDutyHarness().summary;
    const got: unknown[] = [];
    const screen = new ShiftSummaryScreen(null, { continue: (s) => got.push(s) });
    screen.open(summary);
    expect(screen.onKeyDown(ev('Enter', { target: new FakeHtml() }))).toBe(false);
    if (before === undefined) delete g.HTMLElement;
    else g.HTMLElement = before;
    expect(screen.onKeyDown(ev('ArrowDown'))).toBe(false);
    expect(screen.onKeyDown(ev('Escape', { repeat: true }))).toBe(true); // a held key does not continue
    expect(got).toEqual([]);
    expect(screen.onKeyDown(ev('Escape'))).toBe(true);
    expect(got).toEqual([summary]);
    screen.open(summary);
    expect(screen.onKeyDown(ev('Enter'))).toBe(true);
    expect(got).toHaveLength(2);
  });
});

describe('courtroom (changed)', () => {
  const view = courtroomViewOf({
    id: 'CR-1',
    personLabel: 'DOE, JANE',
    motions: [{ text: 'Suppress the stop', granted: false }] as never,
    questions: [
      { id: 'q1', text: 'Did you see it?' },
      { id: 'q2', text: 'Was it dark?' },
    ] as never,
  });

  it('Escape leaves at the rulings, then steps back one question (never abandons the testimony)', () => {
    const submits: unknown[] = [];
    const p = new CourtroomPanel(null, (id, answers) => submits.push([id, answers]));
    p.open(view);
    p.onKeyDown(ev('Enter')); // begin
    p.onKeyDown(ev('1'));
    expect(p.state).toMatchObject({ phase: 'questions', index: 1 });
    expect(p.onKeyDown(ev('Escape'))).toBe(true);
    expect(p.state).toMatchObject({ phase: 'questions', index: 0 });
    expect(p.onKeyDown(ev('Escape'))).toBe(true); // first question: consumed, nothing happens
    expect(p.state).toMatchObject({ phase: 'questions', index: 0 });
    expect(p.isOpen).toBe(true);
    p.onKeyDown(ev('1'));
    p.onKeyDown(ev('2'));
    expect(p.state.phase).toBe('review');
    p.onKeyDown(ev('Escape'));
    expect(p.state).toMatchObject({ phase: 'questions', index: 1 });
    expect(submits).toEqual([]);
  });

  it('Enter on a focused button is the button\'s click (the answer), Enter elsewhere keeps its meaning', () => {
    const p = new CourtroomPanel(null, () => undefined);
    p.open(view);
    expect(p.onKeyDown(ev('Enter', { target: button }))).toBe(false);
    expect(p.state.phase).toBe('motions');
    expect(p.press('Enter')).toBe(true); // what the button's click does
    expect(p.state.phase).toBe('questions');
    expect(p.onKeyDown(ev('Enter', { target: button }))).toBe(false);
    expect(p.onKeyDown(ev('ArrowDown'))).toBe(false); // the UIRoot fallback moves focus over the answer buttons
    expect(p.onKeyDown(ev('3'))).toBe(true); // digits keep working
    expect(p.state.answers[0]).toBe('dontRecall');
  });

  it('the pure reducer treats Escape like Backspace after the rulings', () => {
    const s = { phase: 'review' as const, index: 1, answers: ['yes', 'no'] as ('yes' | 'no' | null)[] };
    expect(reduceCourtKey(s, view, 'Escape').state).toEqual({ phase: 'questions', index: 1, answers: ['yes', 'no'] });
    expect(reduceCourtKey(s, view, 'Escape')).toEqual(reduceCourtKey(s, view, 'Backspace'));
  });
});

describe('SFST panel (changed)', () => {
  it('Enter is the Space key of the test, closes a finished test, and ignores a held key', () => {
    const { handlers, calls } = dialogueHandlers();
    const keys: string[] = [];
    const closes: number[] = [];
    const p = new SfstPanel(null);
    p.open(sfst(), { key: (k) => keys.push(k), close: () => closes.push(1) });
    expect(calls).toBeDefined();
    expect(handlers).toBeDefined();
    expect(p.onKeyDown(dialogueKey('Enter'))).toBe(true);
    expect(keys).toEqual(['space']);
    expect(p.onKeyDown(dialogueKey('Enter', { repeat: true }))).toBe(true);
    expect(keys).toEqual(['space']);
    // arrows stay the test's own A / D / W keys
    expect(p.onKeyDown(dialogueKey('ArrowLeft'))).toBe(true);
    expect(p.onKeyDown(dialogueKey('ArrowRight'))).toBe(true);
    expect(p.onKeyDown(dialogueKey('ArrowUp'))).toBe(true);
    expect(keys).toEqual(['space', 'a', 'd', 'w']);
    p.update(sfst({ finished: true, prompt: null, summary: ['Pass'] }));
    expect(p.onKeyDown(dialogueKey('Enter'))).toBe(true);
    expect(closes).toEqual([1]);
    expect(p.isOpen).toBe(false);
  });

  it('Escape still closes', () => {
    const closes: number[] = [];
    const p = new SfstPanel(null);
    p.open(sfst(), { key: () => undefined, close: () => closes.push(1) });
    expect(p.onKeyDown(dialogueKey('Escape'))).toBe(true);
    expect(closes).toEqual([1]);
  });
});

describe('dispatch console (changed)', () => {
  const graph = { edges: [] } as unknown as RoadGraph;
  function make() {
    const port = new FakePort();
    port.callList = [call(1, { priority: 1, nature: 'Robbery', units: ['N1'], status: 'active' }), call(2, { priority: 3, nature: 'Noise' })];
    port.unitList = [unit('N1', { status: 'enRoute', callId: 1 }), unit('N2', {})];
    let left = 0;
    const c = new DispatchConsole(null, port, graph, () => void left++);
    c.open();
    return { c, port, left: () => left };
  }

  it('arrows pick the call and the unit, Enter assigns like A, Escape leaves', () => {
    const { c, port, left } = make();
    expect(c.onKeyDown(ev('ArrowDown'))).toBe(true);
    expect(c.onKeyDown(ev('ArrowRight'))).toBe(true);
    expect(c.uiState.sel).toEqual({ callId: 2, unit: 'N2' });
    expect(c.onKeyDown(ev('Enter'))).toBe(true);
    expect(port.log.assign).toEqual([[2, 'N2']]);
    expect(c.onKeyDown(ev('Escape'))).toBe(true);
    expect(left()).toBe(1);
  });

  it('Enter on a focused button is the button\'s click, and in a text field it types', () => {
    const { c, port } = make();
    expect(c.onKeyDown(ev('Enter', { target: button }))).toBe(false);
    expect(c.onKeyDown(ev('Enter', { target: field }))).toBe(false);
    expect(port.log.assign).toEqual([]);
  });
});

describe('dialogue panel (changed)', () => {
  it('Tab and Shift+Tab (the pad\'s RB and LB) switch the tabs forward and back', () => {
    const { handlers } = dialogueHandlers();
    const p = new DialoguePanel(null);
    p.open(dialogueView(), handlers);
    expect(p.state.tab).toBe('talk');
    expect(p.onKeyDown(dialogueKey('Tab'))).toBe(true);
    expect(p.state.tab).toBe('actions');
    expect(p.onKeyDown(dialogueKey('Tab'))).toBe(true);
    expect(p.state.tab).toBe('notes');
    expect(p.onKeyDown(dialogueKey('Tab', { shiftKey: true }))).toBe(true);
    expect(p.state.tab).toBe('actions');
    expect(p.onKeyDown(dialogueKey('Tab', { shiftKey: true }))).toBe(true);
    expect(p.state.tab).toBe('talk');
    expect(p.onKeyDown(dialogueKey('Tab', { shiftKey: true }))).toBe(true);
    expect(p.state.tab).toBe('notes'); // wraps
  });

  it('arrows move the highlight, Enter activates it, digits still work, Escape goes back then closes', () => {
    const { handlers, calls } = dialogueHandlers();
    const p = new DialoguePanel(null);
    p.open(dialogueView(), handlers);
    expect(p.onKeyDown(dialogueKey('ArrowDown'))).toBe(true);
    expect(p.state.focus).toBe(1);
    expect(p.onKeyDown(dialogueKey('Enter'))).toBe(true); // opens topic 2
    expect(p.state.topic).toBe(1);
    expect(p.onKeyDown(dialogueKey('Escape'))).toBe(true);
    expect(p.state.topic).toBe(-1);
    expect(p.onKeyDown(dialogueKey('Escape'))).toBe(true);
    expect(p.isOpen).toBe(false);
    expect(calls.close).toBe(1);
  });
});

describe('settings menu (changed): a rebind capture owns every key', () => {
  class Html {}
  const g = globalThis as unknown as { HTMLElement?: unknown };
  const before = g.HTMLElement;
  afterAll(() => {
    if (before === undefined) delete g.HTMLElement;
    else g.HTMLElement = before;
  });

  it('consumes the keys (so the arrows do not move focus) while capturing, and Escape closes otherwise', () => {
    g.HTMLElement = Html;
    const store = new SettingsStore({ storage: { read: () => Promise.resolve(undefined), write: () => Promise.resolve() }, autosaveDelayMs: 0 });
    let captureCb: ((b: unknown) => void) | null = null;
    const input = {
      setBindings: () => undefined,
      captureNext: (cb: (b: unknown) => void) => {
        captureCb = cb;
        return () => {
          captureCb = null;
        };
      },
    } as unknown as InputManager;
    const ui = fakeUi();
    const menu = new SettingsMenu(ui as unknown as UIRoot, store, input);
    menu.open('controls');
    const root = menu.element as unknown as FakeElement;
    expect(menu.onKeyDown(ev('ArrowDown'))).toBe(false); // not capturing: the UIRoot fallback moves focus over the controls
    const chip = findAll(root, (e) => e.tagName === 'button' && e.dataset['bind'] === 'interact:0')[0];
    expect(chip).toBeDefined();
    chip?.click();
    expect(captureCb).not.toBeNull();
    for (const k of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'KeyW']) expect(menu.onKeyDown(ev(k)), k).toBe(true);
    expect(ui.isOpen(menu)).toBe(true); // Escape went to the capture, not the menu
    (captureCb as unknown as (b: unknown) => void)(null);
    expect(menu.onKeyDown(ev('Escape'))).toBe(true);
    expect(ui.isOpen(menu)).toBe(false);
    store.dispose();
  });

  it('lists the Phase 9 settings in the Audio and Graphics tabs', () => {
    g.HTMLElement = Html;
    const store = new SettingsStore({ storage: { read: () => Promise.resolve(undefined), write: () => Promise.resolve() }, autosaveDelayMs: 0 });
    const menu = new SettingsMenu(fakeUi() as unknown as UIRoot, store, {} as unknown as InputManager);
    const root = menu.element as unknown as FakeElement;
    const labels = (): string[] => findAll(root, (e) => e.tagName === 'label').map((e) => e.textContent);
    menu.showSection('audio');
    expect(labels()).toContain('Ambience volume');
    expect(labels()).toContain('Interface sounds volume');
    menu.showSection('graphics');
    expect(labels()).toContain('Effects (glow, light cones, particles)');
    const options = findAll(root, (e) => e.tagName === 'option').map((e) => e.textContent);
    expect(options).toEqual(expect.arrayContaining(['Off', 'Low', 'High']));
    store.dispose();
  });
});

// --- audit probes of the other menus ----------------------------------------------------------------------------------------------

describe('audit probes (Escape closes, arrows move or fall through, Enter activates)', () => {
  const records = (): Record<AcademyModule, AcademyRecord> =>
    Object.fromEntries(ACADEMY_MODULES.map((m) => [m, { best: 0, attempts: 0, passed: false }])) as Record<AcademyModule, AcademyRecord>;

  it('academy: Escape leaves; arrows and Enter fall through to the Start buttons; digits start modules', () => {
    const log: string[] = [];
    const recs = records();
    const host: AcademyHost = {
      standalone: false,
      seed: () => 1,
      records: () => recs,
      mods: () => ({ aimSpread: 1, steerLagS: 0, vignette: 0 }),
      submit: () => undefined,
      startDrivingCourse: (id) => log.push(`drive ${id}`),
      canGraduate: () => false,
      graduate: () => undefined,
      close: () => log.push('close'),
    };
    const s = new AcademyScreen(null, host);
    s.open();
    expect(CAREER_CONFIG.academy.pass).toBeDefined();
    for (const k of ['ArrowDown', 'ArrowUp', 'Enter']) expect(s.onKeyDown(careerKey(k)), k).toBe(false);
    expect(s.onKeyDown(careerKey('1'))).toBe(true);
    expect(log).toEqual(['drive basic']);
    expect(s.onKeyDown(careerKey('Escape'))).toBe(true);
    expect(log.at(-1)).toBe('close');
  });

  it('career screen: Escape closes through the host, left / right switch tabs, up / down fall through', () => {
    const h = offDutyHarness();
    const closed: number[] = [];
    const screen = new CareerScreen(null, {
      view: () => h.career.view,
      eligibility: () => ({}) as never,
      names: () => [],
      request: () => undefined,
      startExam: () => undefined,
      close: () => closed.push(1),
    });
    screen.open();
    const tab = screen.tab;
    expect(screen.onKeyDown(careerKey('ArrowRight'))).toBe(true);
    expect(screen.tab).not.toBe(tab);
    expect(screen.onKeyDown(careerKey('ArrowDown'))).toBe(false);
    expect(screen.onKeyDown(careerKey('ArrowUp'))).toBe(false);
    expect(screen.onKeyDown(careerKey('Escape'))).toBe(true);
    expect(closed).toEqual([1]);
  });

  it('trainee evaluation: Escape closes, arrows highlight and rate, Enter submits', () => {
    const closed: number[] = [];
    const requests: unknown[] = [];
    const p = new TraineeEvalPanel(null, {
      trainee: () => ({ name: 'Riley', truth: { safety: 4, procedure: 2, reports: 5, community: 3, driving: 1 } }),
      request: (r) => requests.push(r),
      close: () => closed.push(1),
    });
    p.open();
    expect(p.onKeyDown(careerKey('ArrowDown'))).toBe(true);
    expect(p.onKeyDown(careerKey('ArrowRight'))).toBe(true);
    expect(p.onKeyDown(careerKey('Enter'))).toBe(true);
    expect(requests).toHaveLength(1);
    p.open();
    expect(p.onKeyDown(careerKey('Escape'))).toBe(true);
    expect(closed.length).toBeGreaterThanOrEqual(1);
  });

  it('coop lobby and line prompt: Escape cancels', () => {
    const calls: string[] = [];
    const lobby = new CoopLobby(
      null,
      { connect: () => undefined, status: () => ({ state: 'idle', text: '' }), start: () => undefined, cancel: () => calls.push('cancel') },
      { getItem: () => null, setItem: () => undefined },
    );
    lobby.open();
    expect(lobby.onKeyDown(ev('ArrowDown'))).toBe(false);
    expect(lobby.onKeyDown(ev('Escape'))).toBe(true);
    expect(calls).toEqual(['cancel']);
    const prompt = new LinePrompt(null);
    let cancelled = 0;
    prompt.open(() => undefined, () => void cancelled++);
    expect(prompt.onKeyDown(ev('ArrowDown'))).toBe(false);
    expect(prompt.onKeyDown(ev('Escape'))).toBe(true);
    expect(cancelled).toBe(1);
  });

  it('camera overlay: Escape closes, up / down zoom, Enter takes the photo', () => {
    const log: string[] = [];
    const c = new CameraOverlay(null);
    c.open({ caseLabel: 'C-1', room: 'Kitchen', caption: '' }, { shutter: () => log.push('shutter'), fov: () => log.push('fov'), close: () => log.push('close') });
    expect(c.onKeyDown(ev('ArrowUp'))).toBe(true);
    expect(c.onKeyDown(ev('Enter'))).toBe(true);
    expect(c.onKeyDown(ev('Escape'))).toBe(true);
    expect(log).toEqual(['fov', 'fov', 'shutter', 'close']);
  });

  it('case file: Escape closes, Enter and the arrows are the reducer\'s (rows, tabs, next custody step)', () => {
    const s = { tab: 0, focus: 0 };
    expect(reduceCaseKey(s, {} as never, 'Escape')).toMatchObject({ emit: { kind: 'close' }, consumed: true });
    expect(reduceCaseKey(s, {} as never, 'ArrowRight')).toMatchObject({ consumed: true });
    expect(reduceCaseKey(s, {} as never, 'ArrowLeft')).toMatchObject({ consumed: true });
  });

  it('fingerprint panel: Escape cancels, arrows move the cursor, Enter lifts', () => {
    const log: string[] = [];
    const p = new FingerprintPanel(null);
    p.open(
      { surface: 'glass', label: 'table', cursor: 0, coverage: new Array<number>(16).fill(0), quality: 0, overbrush: 0 },
      { move: (d) => log.push(`move ${d}`), lift: () => log.push('lift'), cancel: () => log.push('cancel') },
    );
    expect(p.onKeyDown(ev('ArrowRight'))).toBe(true);
    expect(p.onKeyDown(ev('Enter'))).toBe(true);
    expect(log).toEqual(['move right', 'lift']);
    p.open(
      { surface: 'glass', label: 'table', cursor: 0, coverage: new Array<number>(16).fill(0), quality: 0, overbrush: 0 },
      { move: () => undefined, lift: () => undefined, cancel: () => log.push('cancel') },
    );
    expect(p.onKeyDown(ev('Escape'))).toBe(true);
    expect(log.at(-1)).toBe('cancel');
  });

  it('action panel: Escape closes, arrows highlight, Enter selects the highlighted option, digits select', () => {
    const picked: number[] = [];
    let closed = 0;
    const p = new ActionPanel(null);
    p.open({ title: 'Trunk', options: [{ label: 'A' }, { label: 'B', enabled: false }, { label: 'C' }] }, (i) => picked.push(i), () => void closed++);
    expect(p.onKeyDown(ev('ArrowDown'))).toBe(true);
    expect(p.onKeyDown(ev('Enter'))).toBe(true);
    expect(picked).toEqual([2]); // the disabled row is skipped
    expect(p.onKeyDown(ev('1'))).toBe(true);
    expect(picked).toEqual([2, 0]);
    expect(p.onKeyDown(ev('Escape'))).toBe(true);
    expect(closed).toBe(1);
  });

  it('briefing: Enter and Escape close', () => {
    for (const k of ['Enter', 'Escape']) {
      const b = new BriefingScreen(null);
      const log: string[] = [];
      b.open({ title: 't', date: 'd', assignment: 'a', sections: [] }, () => log.push('closed'));
      expect(b.onKeyDown(ev(k)), k).toBe(true);
      expect(log).toEqual(['closed']);
    }
  });

  it('evidence review: Escape closes, left / right scrub, digits pick a footer option', () => {
    const p = new EvidenceReviewPanel(null);
    const footer = makeFooter();
    p.open(makeSource(), footer);
    expect(p.onKeyDown(reviewKey('ArrowRight'))).toBe(true);
    expect(p.time).toBeGreaterThan(0);
    expect(p.onKeyDown(reviewKey('1'))).toBe(true);
    expect(footer.picks).toEqual([0]);
    expect(p.onKeyDown(reviewKey('Escape'))).toBe(true);
    expect(p.isOpen).toBe(false);
  });

  it('mdt: Escape closes, left / right switch tabs', () => {
    const f = mdtFixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open();
    const before = mdt.tab;
    expect(mdt.onKeyDown(mdtKey('ArrowRight'))).toBe(true);
    expect(mdt.tab).not.toBe(before);
    expect(mdt.onKeyDown(mdtKey('Escape'))).toBe(true);
    expect(mdt.isOpen).toBe(false);
  });

  it('mod manager and scenario editor: Escape leaves; arrows fall through to the buttons', async () => {
    const log: string[] = [];
    const host: ModManagerHost = {
      store: {
        list: () => Promise.resolve([]),
        put: () => Promise.resolve(),
        remove: () => Promise.resolve(),
        enabled: () => [],
        setEnabled: () => undefined,
      },
      context: () => ({}) as never,
      active: () => [],
      bootErrors: () => [],
      safeMode: () => false,
      reload: () => undefined,
      close: () => log.push('mods closed'),
    };
    const mm = new ModManager(null, host);
    await mm.open();
    expect(mm.onKeyDown(ev('ArrowDown'))).toBe(false);
    expect(mm.onKeyDown(ev('Escape'))).toBe(true);
    expect(log).toEqual(['mods closed']);

    const edHost: EditorHost = {
      graph: { edges: [] } as unknown as RoadGraph,
      context: defaultScenarioContext(),
      anchor: () => ({ x: 0, z: 0 }),
      run: () => undefined,
      close: () => log.push('editor closed'),
    };
    const ed = new ScenarioEditor(null, edHost, { getItem: () => null, setItem: () => undefined });
    ed.open();
    expect(ed.onKeyDown(ev('ArrowDown'))).toBe(false);
    expect(ed.onKeyDown(ev('Escape'))).toBe(true);
    expect(log.at(-1)).toBe('editor closed');
  });

  it('character creator and livery editor: Escape cancels', () => {
    const model = vehicleModel('patrol_sedan');
    let creatorCancels = 0;
    const creatorHost: CreatorHost = {
      mode: 'newGame',
      validateGear: (l, extra) => validateOfficerLoadout(l, { extraVestSlots: extra }),
      done: () => undefined,
      cancel: () => void creatorCancels++,
    };
    const creator = new CharacterCreator(fakeUi() as unknown as UIRoot, creatorHost, { profile: defaultCharacter(), gear: officerPreset('patrolStandard') });
    creator.open();
    expect(creator.onKeyDown(ev('ArrowDown'))).toBe(false);
    expect(creator.onKeyDown(ev('Escape'))).toBe(true);
    expect(creatorCancels).toBe(1);

    let liveryCancels = 0;
    const host: LiveryEditorHost = {
      unitId: 'P-101', unitNumber: '101', dept: 'City Police', model, fleetClass: 'patrol', capacity: model.cargo,
      library: () => DEFAULT_LIVERIES,
      validateLoadout: (l: VehicleLoadout) => validateVehicleLoadout(l, model.cargo, 'patrol'),
      preview: () => undefined,
      save: (_d: LiveryDoc) => undefined,
      cancel: () => void liveryCancels++,
      sirenPreview: () => undefined,
      orbit: () => undefined,
    };
    const editor = new LiveryEditor(fakeUi() as unknown as UIRoot, host, defaultLivery('patrolMarked'));
    editor.open();
    expect(editor.onKeyDown(ev('ArrowDown'))).toBe(false);
    expect(editor.onKeyDown(ev('Escape'))).toBe(true);
    expect(liveryCancels).toBe(1);
  });
});

describe('the audit table is complete', () => {
  it('names every Menu of the design list in the file header and every one exists', () => {
    const text = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const header = text.slice(0, text.indexOf('*/'));
    const menus = [
      'career/academy', 'career/apartment', 'career/careerScreen', 'career/summary', 'career/trainee', 'character/characterCreator',
      'coop/lobby', 'coop/prompt', 'court/courtroomPanel', 'dialogue/dialoguePanel', 'dialogue/sfstPanel', 'dispatch/console',
      'investigation/cameraOverlay', 'investigation/caseFilePanel', 'investigation/fingerprintPanel', 'livery/liveryEditor', 'mdt/overlay',
      'mods/modManager', 'panels/actionPanel', 'review/reviewPanel', 'sandbox/editor', 'settingsMenu', 'station/briefingScreen',
    ];
    for (const m of menus) {
      expect(header, m).toContain(m);
      expect(existsSync(fileURLToPath(new URL(`../../src/ui/${m}.ts`, import.meta.url))), m).toBe(true);
    }
  });
});
