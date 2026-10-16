import { bus } from './events';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  /** Wall-clock time (ms since epoch). */
  readonly time: number;
}

/** Capacity of the in-memory ring buffer of recent entries. */
export const LOG_BUFFER_SIZE = 500;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Renders arbitrary log arguments to a single line of text. */
export function formatLogArgs(args: readonly unknown[]): string {
  return args.map(formatValue).join(' ');
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (value === null || value === undefined) return String(value);
  switch (typeof value) {
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'symbol':
      return value.toString();
    case 'function':
      return `[function ${value.name || 'anonymous'}]`;
    default:
      try {
        return JSON.stringify(value) ?? '[object]';
      } catch {
        return '[unserializable object]';
      }
  }
}

// Ring buffer state.
const buffer: LogEntry[] = [];
let head = 0;
let minLevel: LogLevel = 'debug';
let mirrorToConsole = true;
let emitting = false;

function push(entry: LogEntry): void {
  if (buffer.length < LOG_BUFFER_SIZE) {
    buffer.push(entry);
  } else {
    buffer[head] = entry;
    head = (head + 1) % LOG_BUFFER_SIZE;
  }
}

function mirror(entry: LogEntry): void {
  if (!mirrorToConsole || typeof console === 'undefined') return;
  switch (entry.level) {
    case 'debug':
      console.debug(entry.message);
      break;
    case 'info':
      console.info(entry.message);
      break;
    case 'warn':
      console.warn(entry.message);
      break;
    case 'error':
      console.error(entry.message);
      break;
  }
}

function write(level: LogLevel, args: readonly unknown[]): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const entry: LogEntry = { level, message: formatLogArgs(args), time: Date.now() };
  push(entry);
  mirror(entry);
  // A 'console:log' handler that throws is reported back through log.error;
  // the re-entrancy guard keeps that from recursing.
  if (emitting) return;
  emitting = true;
  try {
    bus.emit('console:log', entry);
  } finally {
    emitting = false;
  }
}

/** Leveled logger: ring-buffered, mirrored to the console, published on the bus. */
export const log = {
  log(level: LogLevel, ...args: unknown[]): void {
    write(level, args);
  },
  debug(...args: unknown[]): void {
    write('debug', args);
  },
  info(...args: unknown[]): void {
    write('info', args);
  },
  warn(...args: unknown[]): void {
    write('warn', args);
  },
  error(...args: unknown[]): void {
    write('error', args);
  },
  /** Buffered entries, oldest first. */
  entries(): LogEntry[] {
    return buffer.slice(head).concat(buffer.slice(0, head));
  },
  clear(): void {
    buffer.length = 0;
    head = 0;
  },
  /** Entries below this level are dropped entirely. */
  setMinLevel(level: LogLevel): void {
    minLevel = level;
  },
  getMinLevel(): LogLevel {
    return minLevel;
  },
  /** Toggles mirroring to the host console (on by default). */
  setConsoleMirror(enabled: boolean): void {
    mirrorToConsole = enabled;
  },
};
