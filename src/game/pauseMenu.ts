import { el, type Menu, type UIRoot } from '../ui/ui';

/**
 * A panel the pause menu can open (Phase 9 review): a pad has no key for the MDT, the scene panel and the other openers, so the
 * pause menu offers them as buttons. `open` runs after the pause menu has closed.
 */
export interface PausePanel {
  readonly label: string;
  open(): void;
  /** False hides the button (e.g. the co-op panel outside a co-op session); default: shown. */
  available?(): boolean;
}

export interface PauseMenuCallbacks {
  resume(): void;
  quickSave(): void;
  openSettings(): void;
  quitToTitle(): void;
  /** Phase 8: the career / schedule screen. */
  openCareer?(): void;
  /** Phase 8: the scenario editor. */
  openEditor?(): void;
  /** False hides the scenario editor button (a career or co-op session); default: shown. */
  editorAvailable?(): boolean;
  /** Phase 9: a tutorial is running (shows its two buttons); default: no tutorial. */
  tutorialActive?(): boolean;
  /** Phase 9: skip the current tutorial step. */
  skipTutorialStep?(): void;
  /** Phase 9: end the tutorial. */
  endTutorial?(): void;
  /** Phase 9 review: the panels with keyboard-only openers (MDT, scene, investigation, ...), so a gamepad can reach them. */
  panels?: readonly PausePanel[];
}

/** In-game pause screen. Escape is swallowed here; the app toggles it through the `menu.toggle` action. */
export class PauseMenu implements Menu {
  readonly id = 'pause';
  readonly element: HTMLElement;
  private readonly ui: UIRoot;
  private readonly status: HTMLElement;
  private readonly editorButton: HTMLElement | null;
  private readonly tutorialButtons: HTMLElement[];
  private readonly panelButtons: { readonly panel: PausePanel; readonly button: HTMLElement }[];
  private readonly callbacks: PauseMenuCallbacks;

  constructor(ui: UIRoot, callbacks: PauseMenuCallbacks) {
    this.ui = ui;
    this.callbacks = callbacks;
    this.editorButton = callbacks.openEditor ? el('button', { onclick: () => callbacks.openEditor?.() }, 'Scenario editor') : null;
    this.tutorialButtons = [
      ...(callbacks.skipTutorialStep ? [el('button', { onclick: () => callbacks.skipTutorialStep?.() }, 'Skip tutorial step')] : []),
      ...(callbacks.endTutorial ? [el('button', { onclick: () => callbacks.endTutorial?.() }, 'End tutorial')] : []),
    ];
    this.panelButtons = (callbacks.panels ?? []).map((panel) => ({
      panel,
      button: el(
        'button',
        {
          onclick: () => {
            this.close();
            panel.open();
          },
        },
        panel.label,
      ),
    }));
    this.status = el('p', { class: 'hint' });
    this.element = el(
      'div',
      { class: 'panel pause-menu', role: 'dialog', 'aria-label': 'Paused' },
      el('h1', null, 'Paused'),
      el(
        'div',
        { class: 'stack' },
        el('button', { class: 'primary', autofocus: true, onclick: () => callbacks.resume() }, 'Resume'),
        el('button', { onclick: () => callbacks.quickSave() }, 'Quick save'),
        el('button', { onclick: () => callbacks.openSettings() }, 'Settings'),
        ...(callbacks.openCareer ? [el('button', { onclick: () => callbacks.openCareer?.() }, 'Career / schedule')] : []),
        ...(this.editorButton ? [this.editorButton] : []),
        ...this.tutorialButtons,
        ...(this.panelButtons.length > 0
          ? [
              el('p', { class: 'hint' }, 'Panels (no key needed)'),
              el('div', { class: 'pause-panels', role: 'group', 'aria-label': 'Panels' }, ...this.panelButtons.map((p) => p.button)),
            ]
          : []),
        el('button', { class: 'danger', onclick: () => callbacks.quitToTitle() }, 'Quit to title'),
      ),
      this.status,
      el('p', { class: 'hint' }, 'On foot: WASD move · Shift sprint · mouse look · E enter a car or refuel at a pump'),
      el('p', { class: 'hint' }, 'Driving: W/S throttle and brake (hold S to reverse) · A/D steer · Space handbrake · E get out'),
      el('p', { class: 'hint' }, 'V camera · H headlights · L light bar · M map zoom · F3 perf · ` console · Esc resume'),
      el('p', { class: 'hint' }, 'Patrol car: Q siren · R tone · G horn · F manual · K light pattern · J spotlight (hold right mouse to aim) · X equipment · Tab MDT · P run plate'),
      el('p', { class: 'hint' }, 'Radio: T menu, then 1-9 · B push-to-talk · hold Z emergency · [ ] channel · \\ scan · E at a trunk or a stopped driver'),
    );
  }

  /** Short status line under the buttons (e.g. "Saved to quicksave"). */
  setStatus(text: string): void {
    this.status.textContent = text;
  }

  open(): void {
    this.setStatus('');
    if (this.editorButton) this.editorButton.hidden = this.callbacks.editorAvailable?.() === false;
    const tutorial = this.callbacks.tutorialActive?.() === true;
    for (const b of this.tutorialButtons) b.hidden = !tutorial;
    for (const { panel, button } of this.panelButtons) button.hidden = panel.available?.() === false;
    this.ui.push(this);
  }

  close(): void {
    this.ui.pop(this);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    return event.key === 'Escape';
  }
}
