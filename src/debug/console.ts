import type { EventMap } from '../core/event-map';
import { bus as defaultBus, type EventBus } from '../core/events';
import { log, type LogLevel } from '../core/log';
import { CommandParseError, commonPrefix, completeName, parseCommand } from './commandParser';

export type ConsoleLineKind = 'input' | 'output' | 'error' | LogLevel;

export interface ConsoleLine {
  readonly kind: ConsoleLineKind;
  readonly text: string;
  readonly time: number;
}

export interface CommandContext {
  readonly console: DebugConsole;
  /** Prints a line immediately (useful for long-running commands). */
  print(text: string): void;
}

export interface Command {
  readonly name: string;
  readonly description: string;
  /** Argument synopsis shown by `help`, e.g. `"<slot>"`. */
  readonly usage?: string;
  run(args: string[], ctx: CommandContext): string | undefined | void | Promise<string | undefined | void>;
}

export interface DebugConsoleOptions {
  /** Element the overlay is appended to; defaults to `document.body`. */
  parent?: HTMLElement;
  bus?: EventBus<EventMap>;
  /** Scrollback capacity in lines. Default 1000. */
  maxLines?: number;
  /** Input history capacity. Default 100. */
  historySize?: number;
}

/** Up/down input history with a preserved draft; consecutive duplicates collapse. */
export class CommandHistory {
  private readonly entries: string[] = [];
  private readonly capacity: number;
  private cursor = 0;
  private draft = '';

  constructor(capacity = 100) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get lines(): readonly string[] {
    return this.entries;
  }

  push(line: string): void {
    if (line === '' || this.entries[this.entries.length - 1] === line) {
      this.reset();
      return;
    }
    this.entries.push(line);
    if (this.entries.length > this.capacity) this.entries.shift();
    this.reset();
  }

  /** Moves toward older entries; `draft` is the current input, returned again on the way back. */
  up(draft: string): string {
    if (this.entries.length === 0) return draft;
    if (this.cursor === this.entries.length) this.draft = draft;
    if (this.cursor > 0) this.cursor -= 1;
    return this.entries[this.cursor] ?? draft;
  }

  /** Moves toward newer entries, ending on the saved draft. */
  down(): string {
    if (this.cursor >= this.entries.length) return this.draft;
    this.cursor += 1;
    return this.cursor === this.entries.length ? this.draft : (this.entries[this.cursor] ?? this.draft);
  }

  reset(): void {
    this.cursor = this.entries.length;
    this.draft = '';
  }
}

const LINE_COLORS: Record<ConsoleLineKind, string> = {
  input: '#9fd3ff',
  output: '#e8e8e8',
  error: '#ff6b6b',
  debug: '#8d8d8d',
  info: '#c8c8c8',
  warn: '#ffd166',
};

const ROOT_STYLE = [
  'position:fixed',
  'top:0',
  'left:0',
  'right:0',
  'height:40vh',
  'z-index:1100',
  'display:flex',
  'flex-direction:column',
  'background:rgba(10,12,16,0.92)',
  'color:#e8e8e8',
  // Scales with the accessibility text size (--text-scale on <html>).
  'font:calc(13px * var(--text-scale, 1))/1.4 ui-monospace, Menlo, Consolas, monospace',
  'border-bottom:1px solid #444',
].join(';');

const SCROLLBACK_STYLE = ['flex:1', 'overflow-y:auto', 'padding:6px 8px', 'white-space:pre-wrap', 'word-break:break-word'].join(';');

const INPUT_STYLE = [
  'flex:none',
  'margin:0',
  'padding:6px 8px',
  'border:0',
  'border-top:1px solid #444',
  'outline:none',
  'background:#05070a',
  'color:#e8e8e8',
  'font:inherit',
].join(';');

interface ConsoleView {
  root: HTMLDivElement;
  scrollback: HTMLDivElement;
  input: HTMLInputElement;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * In-game command console. Scrollback shows the `core/log` ring buffer plus live
 * `'console:log'` events and command output. Works headless (no `document`) for tests.
 */
export class DebugConsole {
  private readonly commands = new Map<string, Command>();
  private readonly historyStore: CommandHistory;
  private readonly scrollbackLines: ConsoleLine[] = [];
  private readonly maxLines: number;
  private readonly view: ConsoleView | null;
  private readonly unsubscribeLog: () => void;
  private readonly context: CommandContext;
  private opened = false;
  /** Element that had focus before `open()`; focused again on `close()`. */
  private returnFocus: HTMLElement | null = null;

  constructor(options: DebugConsoleOptions = {}) {
    this.maxLines = Math.max(1, options.maxLines ?? 1000);
    this.historyStore = new CommandHistory(options.historySize ?? 100);
    this.context = { console: this, print: (text) => this.print(text) };
    this.view = typeof document === 'undefined' ? null : this.createView(options.parent ?? document.body);

    for (const entry of log.entries()) this.print(entry.message, entry.level);
    const bus = options.bus ?? defaultBus;
    this.unsubscribeLog = bus.on('console:log', (entry) => this.print(entry.message, entry.level));

    this.register({ name: 'help', description: 'List commands or show usage of one', usage: '[command]', run: (args) => this.help(args[0]) });
    this.register({ name: 'clear', description: 'Clear the scrollback', run: () => this.clear() });
    this.register({ name: 'echo', description: 'Print the arguments', usage: '[text...]', run: (args) => args.join(' ') });
  }

  /** Registers (or replaces) a command; returns a function that unregisters it. */
  register(command: Command): () => void {
    if (command.name.trim() === '' || /\s/.test(command.name)) {
      throw new Error(`Invalid command name "${command.name}"`);
    }
    this.commands.set(command.name, command);
    return () => {
      if (this.commands.get(command.name) === command) this.commands.delete(command.name);
    };
  }

  unregister(name: string): boolean {
    return this.commands.delete(name);
  }

  getCommand(name: string): Command | undefined {
    return this.commands.get(name);
  }

  /** Registered commands sorted by name. */
  get commandList(): readonly Command[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get lines(): readonly ConsoleLine[] {
    return this.scrollbackLines;
  }

  get history(): readonly string[] {
    return this.historyStore.lines;
  }

  isOpen(): boolean {
    return this.opened;
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  open(): void {
    const wasOpen = this.opened;
    this.opened = true;
    if (!this.view) return;
    const active = this.view.root.ownerDocument.activeElement;
    if (!wasOpen && active instanceof HTMLElement && !this.view.root.contains(active)) this.returnFocus = active;
    this.view.root.style.display = 'flex';
    this.view.input.focus();
    this.scrollToBottom();
  }

  /** Hides the console and gives focus back to what had it before (e.g. a menu button). */
  close(): void {
    this.opened = false;
    if (!this.view) return;
    this.view.input.blur();
    this.view.root.style.display = 'none';
    const target = this.returnFocus;
    this.returnFocus = null;
    if (target?.isConnected) target.focus();
  }

  /** Parses and runs one line; output and errors are printed, never thrown. */
  async execute(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === '') return;
    this.historyStore.push(trimmed);
    this.print(`> ${trimmed}`, 'input');

    let parsed;
    try {
      parsed = parseCommand(trimmed);
    } catch (error) {
      this.print(error instanceof CommandParseError ? error.message : errorText(error), 'error');
      return;
    }
    if (!parsed) return;

    const command = this.commands.get(parsed.name);
    if (!command) {
      this.print(`Unknown command "${parsed.name}". Type "help" for a list.`, 'error');
      return;
    }
    try {
      const result = await command.run([...parsed.args], this.context);
      if (typeof result === 'string' && result !== '') this.print(result);
    } catch (error) {
      this.print(errorText(error), 'error');
    }
  }

  /** Command names completing `partial` (the first token of a line). */
  complete(partial: string): string[] {
    return completeName(partial, this.commands.keys());
  }

  print(text: string, kind: ConsoleLineKind = 'output'): void {
    for (const part of text.split('\n')) this.append({ kind, text: part, time: Date.now() });
  }

  clear(): void {
    this.scrollbackLines.length = 0;
    if (this.view) this.view.scrollback.replaceChildren();
  }

  dispose(): void {
    this.unsubscribeLog();
    this.commands.clear();
    this.view?.root.remove();
  }

  private help(name: string | undefined): string {
    if (name !== undefined) {
      const command = this.commands.get(name);
      if (!command) return `Unknown command "${name}"`;
      return `${command.name}${command.usage ? ` ${command.usage}` : ''}\n  ${command.description}`;
    }
    const list = this.commandList;
    const width = list.reduce((w, c) => Math.max(w, c.name.length), 0);
    return list.map((c) => `${c.name.padEnd(width)}  ${c.description}`).join('\n');
  }

  private append(line: ConsoleLine): void {
    this.scrollbackLines.push(line);
    const overflow = this.scrollbackLines.length - this.maxLines;
    if (overflow > 0) this.scrollbackLines.splice(0, overflow);
    if (!this.view) return;

    const { scrollback } = this.view;
    const atBottom = scrollback.scrollTop + scrollback.clientHeight >= scrollback.scrollHeight - 4;
    const el = document.createElement('div');
    el.style.color = LINE_COLORS[line.kind];
    el.textContent = line.kind === 'warn' || line.kind === 'error' ? `[${line.kind}] ${line.text}` : line.text;
    scrollback.appendChild(el);
    while (scrollback.childElementCount > this.maxLines) scrollback.firstElementChild?.remove();
    if (atBottom) this.scrollToBottom();
  }

  private scrollToBottom(): void {
    if (this.view) this.view.scrollback.scrollTop = this.view.scrollback.scrollHeight;
  }

  private createView(parent: HTMLElement): ConsoleView {
    const root = document.createElement('div');
    root.id = 'debug-console';
    root.setAttribute('style', ROOT_STYLE);
    root.style.display = 'none';

    const scrollback = document.createElement('div');
    scrollback.setAttribute('style', SCROLLBACK_STYLE);

    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('style', INPUT_STYLE);
    input.addEventListener('keydown', (event) => this.onKeyDown(event));

    root.append(scrollback, input);
    parent.appendChild(root);
    return { root, scrollback, input };
  }

  private onKeyDown(event: KeyboardEvent): void {
    const input = this.view?.input;
    if (!input) return;
    switch (event.key) {
      case 'Enter': {
        event.preventDefault();
        const line = input.value;
        input.value = '';
        void this.execute(line);
        break;
      }
      case 'ArrowUp':
        event.preventDefault();
        input.value = this.historyStore.up(input.value);
        input.setSelectionRange(input.value.length, input.value.length);
        break;
      case 'ArrowDown':
        event.preventDefault();
        input.value = this.historyStore.down();
        input.setSelectionRange(input.value.length, input.value.length);
        break;
      case 'Tab':
        event.preventDefault();
        this.autocomplete(input);
        break;
      default:
        break;
    }
  }

  private autocomplete(input: HTMLInputElement): void {
    const value = input.value;
    if (/\s/.test(value.trimStart())) return; // only the command name is completed
    const partial = value.trimStart();
    const matches = this.complete(partial);
    if (matches.length === 0) return;
    if (matches.length === 1) {
      input.value = `${matches[0] ?? partial} `;
      return;
    }
    input.value = commonPrefix(matches);
    this.print(matches.join('  '));
  }
}
