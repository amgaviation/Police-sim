import { el, type Menu, type UIRoot } from '../ui/ui';

export interface PauseMenuCallbacks {
  resume(): void;
  quickSave(): void;
  openSettings(): void;
  quitToTitle(): void;
}

/** In-game pause screen. Escape is swallowed here; the app toggles it through the `menu.toggle` action. */
export class PauseMenu implements Menu {
  readonly id = 'pause';
  readonly element: HTMLElement;
  private readonly ui: UIRoot;
  private readonly status: HTMLElement;

  constructor(ui: UIRoot, callbacks: PauseMenuCallbacks) {
    this.ui = ui;
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
    this.ui.push(this);
  }

  close(): void {
    this.ui.pop(this);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    return event.key === 'Escape';
  }
}
