import '../panels/panels.css';
import './dialogue.css';
import type { Menu, UIRoot } from '../ui';
import { div, setClass, setText } from '../panels/dom';
import { panelBadge, panelKeyToIndex } from '../panels/text';
import type {
  CommMode,
  DialogueEmit,
  DialogueHandlers,
  DialogueKeyResult,
  DialogueOptionView,
  DialoguePanelState,
  DialogueTab,
  DialogueView,
  NoteLine,
  Tone,
  TranscriptLine,
} from './types';

/** Tones in selector order (Left / Right wrap around). */
export const TONES: readonly Tone[] = ['polite', 'neutral', 'commanding', 'aggressive'];
export const DIALOGUE_TABS: readonly DialogueTab[] = ['talk', 'actions', 'notes'];
export const TONE_LABELS: Readonly<Record<Tone, string>> = { polite: 'Polite', neutral: 'Neutral', commanding: 'Commanding', aggressive: 'Aggressive' };
export const TAB_LABELS: Readonly<Record<DialogueTab, string>> = { talk: 'Talk', actions: 'Actions', notes: 'Notes' };
export const COMM_MODE_LABELS: Readonly<Record<CommMode, string>> = {
  verbal: 'Verbal',
  written: 'Written notes',
  gesture: 'Gestures',
  translationApp: 'Translation app',
  interpreter: 'Interpreter',
};
/** Transcript lines shown. */
export const TRANSCRIPT_LINES = 8;
/** Notes shown per section. */
export const NOTE_LINES = 12;
const FOOTER = '1-9 pick · ↑↓ Enter · ←→ tone · Tab tab · M mode · Backspace back · Esc close';

/** The panel state for a conversation that starts with `tone`. */
export function createDialogueState(tone: Tone): DialoguePanelState {
  return { tab: 'talk', topic: -1, tone, focus: 0 };
}

/** Rows of the list the keys act on: topics, the options of the open topic, or the actions. */
function currentOptions(state: DialoguePanelState, view: DialogueView): readonly DialogueOptionView[] | null {
  if (state.tab === 'actions') return view.actions;
  if (state.tab === 'talk' && state.topic >= 0) return view.topics[state.topic]?.options ?? [];
  return null;
}

/** Number of rows in the current list (0 on the notes tab). */
function listLength(state: DialoguePanelState, view: DialogueView): number {
  if (state.tab === 'notes') return 0;
  return currentOptions(state, view)?.length ?? view.topics.length;
}

function firstEnabled(options: readonly DialogueOptionView[]): number {
  const i = options.findIndex((o) => o.enabled);
  return i < 0 ? 0 : i;
}

/** First focusable row from `start` going `dir` (wrapping); options skip disabled rows, -1 when none. */
function stepFocus(options: readonly DialogueOptionView[] | null, length: number, start: number, dir: 1 | -1): number {
  for (let k = 0; k < length; k++) {
    const i = (((start + dir * k) % length) + length) % length;
    if (options === null || options[i]?.enabled === true) return i;
  }
  return -1;
}

/**
 * Pure key reducer of the dialogue panel. Digits 1-9 pick a topic and then an option (Talk) or an action
 * (Actions); Enter acts on the highlighted row like its digit; Up/Down move the highlight (skipping disabled
 * options); Left/Right change the tone (wrapping); Tab goes to the next tab; M cycles the communication mode;
 * Backspace goes back from an option list to the topics; Escape does the same, else closes. Disabled options
 * are never emitted, and nothing is said or done while an answer is pending (`view.busy`). After a line is
 * said the topic stays open for follow-ups. Keys it does not use are not consumed.
 */
export function reduceDialogueKey(state: DialoguePanelState, view: DialogueView, key: string): DialogueKeyResult {
  const idle = (consumed: boolean): DialogueKeyResult => ({ state, emit: null, consumed });
  const digit = panelKeyToIndex(key);
  if (digit !== null) return activate(state, view, digit);
  switch (key) {
    case 'Enter':
      return activate(state, view, state.focus);
    case 'ArrowDown':
    case 'ArrowUp': {
      const length = listLength(state, view);
      if (length === 0) return idle(true);
      const dir = key === 'ArrowDown' ? 1 : -1;
      const next = stepFocus(currentOptions(state, view), length, state.focus + dir, dir);
      return next < 0 || next === state.focus ? idle(true) : { state: { ...state, focus: next }, emit: null, consumed: true };
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      const i = TONES.indexOf(state.tone);
      const next = TONES[(i + (key === 'ArrowRight' ? 1 : TONES.length - 1) + TONES.length) % TONES.length] ?? state.tone;
      return { state: { ...state, tone: next }, emit: null, consumed: true };
    }
    case 'Tab': {
      const tab = DIALOGUE_TABS[(DIALOGUE_TABS.indexOf(state.tab) + 1) % DIALOGUE_TABS.length] ?? 'talk';
      const next: DialoguePanelState = { ...state, tab, topic: -1, focus: 0 };
      const options = currentOptions(next, view);
      return { state: options ? { ...next, focus: firstEnabled(options) } : next, emit: null, consumed: true };
    }
    case 'm':
    case 'M': {
      const modes = view.commModes;
      if (modes.length < 2) return idle(true);
      const mode = modes[(modes.indexOf(view.commMode) + 1) % modes.length];
      return mode === undefined ? idle(true) : { state, emit: { kind: 'mode', mode }, consumed: true };
    }
    case 'Backspace':
      return state.tab === 'talk' && state.topic >= 0 ? back(state) : idle(false);
    case 'Escape':
      return state.tab === 'talk' && state.topic >= 0 ? back(state) : { state, emit: { kind: 'close' }, consumed: true };
    default:
      return idle(false);
  }
}

function back(state: DialoguePanelState): DialogueKeyResult {
  return { state: { ...state, topic: -1, focus: Math.max(0, state.topic) }, emit: null, consumed: true };
}

function activate(state: DialoguePanelState, view: DialogueView, index: number): DialogueKeyResult {
  const idle: DialogueKeyResult = { state, emit: null, consumed: true };
  if (state.tab === 'notes' || index < 0) return idle;
  if (state.tab === 'talk' && state.topic < 0) {
    const topic = view.topics[index];
    if (!topic || topic.options.length === 0) return idle;
    return { state: { ...state, topic: index, focus: firstEnabled(topic.options) }, emit: null, consumed: true };
  }
  const option = currentOptions(state, view)?.[index];
  if (!option || !option.enabled || view.busy) return idle;
  const emit: DialogueEmit =
    state.tab === 'actions' ? { kind: 'action', id: option.id } : { kind: 'say', id: option.id, tone: state.tone };
  return { state: { ...state, focus: index }, emit, consumed: true };
}

/** Keeps the state valid for a new view (topic and focus in range). */
function clampState(state: DialoguePanelState, view: DialogueView): DialoguePanelState {
  const topic = state.tab === 'talk' && state.topic >= view.topics.length ? -1 : state.topic;
  const next = topic === state.topic ? state : { ...state, topic };
  const length = listLength(next, view);
  const focus = length === 0 ? 0 : Math.min(next.focus, length - 1);
  return focus === next.focus ? next : { ...next, focus };
}

interface Row {
  readonly root: HTMLDivElement;
  readonly badge: HTMLSpanElement;
  readonly label: HTMLSpanElement;
  readonly hint: HTMLSpanElement;
}

interface PanelDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly subtitle: HTMLDivElement;
  readonly tones: HTMLDivElement[];
  readonly mode: HTMLDivElement;
  readonly tabs: HTMLDivElement[];
  readonly body: HTMLDivElement;
  readonly rows: Row[];
  readonly lines: HTMLDivElement[];
  readonly status: HTMLDivElement;
  readonly footer: HTMLDivElement;
}

const HEADLESS_ELEMENT = {} as HTMLElement;

/**
 * Dialogue panel (design §12.3): a non-pausing `Menu` docked at the right edge with the contact's title, tone
 * selector, communication mode, Talk / Actions / Notes tabs, the topic or option list with digit badges, and
 * the last transcript lines. Keys are handled by `reduceDialogueKey`; picks go to the handlers (the contact
 * module queues them). `update` re-renders in place and keeps the selection; call it at most 10 times a second.
 * `handlers.close` runs when the user closes the panel (Escape, or the menu stack dropped it), not when the
 * app calls `close()`. Headless (no `document` or `UIRoot`) it keeps the state and key handling but no DOM.
 */
export class DialoguePanel implements Menu {
  readonly id = 'dialogue' as const;
  readonly element: HTMLElement;
  readonly pausesGame = false as const;

  private readonly ui: UIRoot | null;
  private readonly dom: PanelDom | null;
  private view: DialogueView | null = null;
  private handlers: DialogueHandlers | null = null;
  private st: DialoguePanelState = createDialogueState('neutral');
  private openFlag = false;
  private lastViewTone: Tone = 'neutral';

  constructor(ui: UIRoot | null) {
    this.ui = ui;
    this.dom = ui !== null && typeof document !== 'undefined' ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** Tab, open topic, tone and highlighted row (the app reads `state.tone` for what the officer's lines sound like). */
  get state(): DialoguePanelState {
    return this.st;
  }

  open(view: DialogueView, handlers: DialogueHandlers): void {
    this.view = view;
    this.handlers = handlers;
    this.st = createDialogueState(view.tone);
    this.lastViewTone = view.tone;
    this.openFlag = true;
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  /** Replaces the view; a different contact resets the panel, a changed tone of the same contact is adopted. */
  update(view: DialogueView): void {
    if (!this.openFlag) return;
    const previous = this.view;
    this.view = view;
    if (previous && previous.contactId !== view.contactId) {
      this.st = createDialogueState(view.tone);
    } else if (view.tone !== this.lastViewTone) {
      this.st = { ...this.st, tone: view.tone };
    }
    this.lastViewTone = view.tone;
    this.st = clampState(this.st, view);
    this.render();
  }

  /** Closes the panel without calling `handlers.close`. */
  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.handlers = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onHide(): void {
    // Popped by someone else (the menu stack was cleared): the user is done with the conversation.
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) this.finish();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    const view = this.view;
    if (!this.openFlag || !view || event.ctrlKey || event.altKey || event.metaKey) return false;
    const result = reduceDialogueKey(this.st, view, event.key);
    // Holding a key repeats navigation but never repeats a line or an action.
    if (event.repeat && result.emit) return true;
    return this.apply(result);
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private apply(result: DialogueKeyResult): boolean {
    this.st = result.state;
    const emit = result.emit;
    const handlers = this.handlers;
    if (emit && handlers) {
      switch (emit.kind) {
        case 'say':
          handlers.say(emit.id, emit.tone);
          break;
        case 'action':
          handlers.action(emit.id);
          break;
        case 'mode':
          handlers.commMode(emit.mode);
          break;
        case 'close':
          this.finish();
          return true;
      }
    }
    this.render();
    return result.consumed;
  }

  /** User-initiated close: pops the panel and tells the app. */
  private finish(): void {
    const handlers = this.handlers;
    this.openFlag = false;
    this.handlers = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
    handlers?.close();
  }

  private press(key: string): void {
    const view = this.view;
    if (this.openFlag && view) this.apply(reduceDialogueKey(this.st, view, key));
  }

  private render(): void {
    const dom = this.dom;
    const view = this.view;
    if (!dom || !view) return;
    const st = this.st;
    setText(dom.title, view.title);
    setText(dom.subtitle, view.subtitle);
    dom.subtitle.hidden = view.subtitle === '';
    for (let i = 0; i < TONES.length; i++) {
      const tone = TONES[i] as Tone;
      setClass(dom.tones[i] as HTMLDivElement, tone === st.tone ? 'dlg-tone dlg-on' : 'dlg-tone');
    }
    const modeText = `${COMM_MODE_LABELS[view.commMode]}${view.commModes.length > 1 ? ' (M)' : ''}`;
    setText(dom.mode, modeText);
    for (let i = 0; i < DIALOGUE_TABS.length; i++) {
      const tab = DIALOGUE_TABS[i] as DialogueTab;
      setClass(dom.tabs[i] as HTMLDivElement, tab === st.tab ? 'dlg-tab dlg-on' : 'dlg-tab');
    }
    this.renderBody(dom, view, st);
    for (let i = 0; i < TRANSCRIPT_LINES; i++) {
      const el = dom.lines[i] as HTMLDivElement;
      const line: TranscriptLine | undefined = view.transcript[Math.max(0, view.transcript.length - TRANSCRIPT_LINES) + i];
      el.hidden = line === undefined;
      if (!line) continue;
      setText(el, line.speaker === 'system' ? line.text : line.pending ? `${line.text} …` : line.text);
      setClass(el, `dlg-line dlg-${line.speaker}${line.pending ? ' dlg-pending' : ''}`);
    }
    setText(dom.status, view.busy ? 'Waiting for a response…' : '');
    dom.status.hidden = !view.busy;
    setText(dom.footer, FOOTER);
  }

  private renderBody(dom: PanelDom, view: DialogueView, st: DialoguePanelState): void {
    let n = 0;
    const fill = (cls: string, badge: string, label: string, hint: string, index: number): void => {
      const row = this.row(dom, n++);
      row.root.hidden = false;
      setClass(row.root, cls);
      row.root.dataset['index'] = String(index);
      setText(row.badge, badge);
      setText(row.label, label);
      setText(row.hint, hint);
    };
    if (st.tab === 'notes') {
      const section = (head: string, notes: readonly NoteLine[]): void => {
        fill('dlg-head', '', head, '', -1);
        if (notes.length === 0) fill('dlg-note dlg-note-none', '', 'None yet', '', -1);
        for (let i = 0; i < Math.min(notes.length, NOTE_LINES); i++) {
          const note = notes[i] as NoteLine;
          fill(`dlg-note dlg-note-${note.severity}`, '', note.text, '', -1);
        }
      };
      section('Statements', view.statements);
      section('Facts', view.facts);
      section('Inconsistencies', view.inconsistencies);
    } else if (st.tab === 'talk' && st.topic < 0) {
      for (let i = 0; i < view.topics.length; i++) {
        const topic = view.topics[i];
        if (!topic) continue;
        const cls = `dlg-row${i === st.focus ? ' dlg-focus' : ''}${topic.options.some((o) => o.enabled) ? '' : ' dlg-off'}`;
        fill(cls, panelBadge(i), topic.label, `${String(topic.options.length)} ▸`, i);
      }
    } else {
      const options = currentOptions(st, view) ?? [];
      for (let i = 0; i < options.length; i++) {
        const o = options[i] as DialogueOptionView;
        const cls = `dlg-row${i === st.focus ? ' dlg-focus' : ''}${o.enabled ? '' : ' dlg-off'}`;
        fill(cls, panelBadge(i), o.label, o.hint ?? '', i);
      }
    }
    for (let i = n; i < dom.rows.length; i++) (dom.rows[i] as Row).root.hidden = true;
    dom.body.setAttribute('aria-label', st.tab === 'talk' && st.topic >= 0 ? (view.topics[st.topic]?.label ?? '') : TAB_LABELS[st.tab]);
  }

  private row(dom: PanelDom, index: number): Row {
    while (dom.rows.length <= index) {
      const root = div('dlg-row', dom.body);
      root.setAttribute('role', 'option');
      root.addEventListener('click', () => {
        const i = Number(root.dataset['index']);
        if (Number.isInteger(i) && i >= 0) {
          this.st = { ...this.st, focus: i };
          this.press('Enter');
        }
      });
      const badge = document.createElement('span');
      badge.className = 'dlg-badge';
      const label = document.createElement('span');
      label.className = 'dlg-label';
      const hint = document.createElement('span');
      hint.className = 'dlg-hint';
      root.append(badge, label, hint);
      dom.rows.push({ root, badge, label, hint });
    }
    return dom.rows[index] as Row;
  }

  private build(): PanelDom {
    const root = div('dlg-panel');
    root.setAttribute('role', 'dialog');
    const header = div('dlg-header', root);
    const title = div('dlg-title', header);
    const subtitle = div('dlg-subtitle-chips', header);
    const controls = div('dlg-controls', header);
    const toneBar = div('dlg-tones', controls);
    const tones = TONES.map((tone, i) => {
      const el = div('dlg-tone', toneBar);
      el.textContent = TONE_LABELS[tone];
      el.addEventListener('click', () => {
        this.st = { ...this.st, tone: TONES[i] ?? tone };
        this.render();
      });
      return el;
    });
    const mode = div('dlg-mode', controls);
    mode.addEventListener('click', () => {
      this.press('m');
    });
    const tabBar = div('dlg-tabs', root);
    const tabs = DIALOGUE_TABS.map((tab) => {
      const el = div('dlg-tab', tabBar);
      el.textContent = TAB_LABELS[tab];
      el.addEventListener('click', () => {
        const view = this.view;
        if (!view) return;
        this.st = clampState({ ...this.st, tab, topic: -1, focus: 0 }, view);
        this.render();
      });
      return el;
    });
    const body = div('dlg-body', root);
    body.setAttribute('role', 'listbox');
    // Focusable so UIRoot moves focus into the panel (rows are not buttons: keys are handled in onKeyDown).
    body.tabIndex = 0;
    const transcript = div('dlg-transcript', root);
    const lines: HTMLDivElement[] = [];
    for (let i = 0; i < TRANSCRIPT_LINES; i++) {
      const line = div('dlg-line', transcript);
      line.hidden = true;
      lines.push(line);
    }
    const status = div('dlg-status', root);
    status.hidden = true;
    const footer = div('dlg-footer', root);
    return { root, title, subtitle, tones, mode, tabs, body, rows: [], lines, status, footer };
  }
}
