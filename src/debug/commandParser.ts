/** Thrown by `parseCommandLine` for malformed input such as an unterminated quote. */
export class CommandParseError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = 'CommandParseError';
    this.position = position;
  }
}

export interface ParsedCommand {
  readonly name: string;
  readonly args: readonly string[];
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/**
 * Splits a command line into tokens, shell-style: whitespace separates tokens,
 * single or double quotes group text (and may be embedded mid-token), and a
 * backslash escapes the next character outside single quotes.
 */
export function parseCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  let quoteStart = -1;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= line.length) throw new CommandParseError('Trailing backslash', i);
      current += line[i + 1] ?? '';
      inToken = true;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoteStart = i;
      inToken = true;
      continue;
    }
    if (isSpace(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }

  if (quote !== null) throw new CommandParseError(`Unterminated ${quote} quote`, quoteStart);
  if (inToken) tokens.push(current);
  return tokens;
}

/** Parses a line into a command name and arguments; `null` for a blank line. */
export function parseCommand(line: string): ParsedCommand | null {
  const tokens = parseCommandLine(line);
  const name = tokens[0];
  if (name === undefined) return null;
  return { name, args: tokens.slice(1) };
}

/** Quotes `value` so `parseCommandLine` yields it back as a single token. */
export function quoteArg(value: string): string {
  if (value.length > 0 && !/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/[\\"]/g, (m) => `\\${m}`)}"`;
}

/** Longest common prefix of all strings (empty for an empty list). */
export function commonPrefix(values: readonly string[]): string {
  const first = values[0];
  if (first === undefined) return '';
  let prefix = first;
  for (const value of values) {
    let n = 0;
    while (n < prefix.length && n < value.length && prefix[n] === value[n]) n += 1;
    prefix = prefix.slice(0, n);
    if (prefix === '') break;
  }
  return prefix;
}

/** Names starting with `partial`, sorted; an empty partial matches everything. */
export function completeName(partial: string, names: Iterable<string>): string[] {
  const matches: string[] = [];
  for (const name of names) if (name.startsWith(partial)) matches.push(name);
  return matches.sort();
}
