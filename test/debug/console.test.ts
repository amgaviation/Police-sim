import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { log } from '../../src/core/log';
import { CommandHistory, DebugConsole, type Command } from '../../src/debug/console';

describe('CommandHistory', () => {
  it('navigates older and newer entries and restores the draft', () => {
    const h = new CommandHistory(10);
    h.push('one');
    h.push('two');
    expect(h.up('draft')).toBe('two');
    expect(h.up('ignored')).toBe('one');
    expect(h.up('ignored')).toBe('one');
    expect(h.down()).toBe('two');
    expect(h.down()).toBe('draft');
    expect(h.down()).toBe('draft');
  });

  it('collapses consecutive duplicates, drops blanks and caps size', () => {
    const h = new CommandHistory(2);
    h.push('a');
    h.push('a');
    h.push('');
    expect(h.lines).toEqual(['a']);
    h.push('b');
    h.push('c');
    expect(h.lines).toEqual(['b', 'c']);
  });

  it('returns the draft when empty', () => {
    const h = new CommandHistory();
    expect(h.up('x')).toBe('x');
    expect(h.down()).toBe('');
  });
});

describe('DebugConsole (headless)', () => {
  let bus: EventBus<EventMap>;
  let con: DebugConsole;

  beforeEach(() => {
    log.setConsoleMirror(false);
    log.clear();
    bus = new EventBus<EventMap>();
    con = new DebugConsole({ bus, maxLines: 50 });
  });

  afterEach(() => {
    con.dispose();
    log.setConsoleMirror(true);
  });

  const texts = (): string[] => con.lines.map((l) => l.text);

  it('has the built-in commands registered', () => {
    expect(con.commandList.map((c) => c.name)).toEqual(['clear', 'echo', 'help']);
  });

  it('toggles open state', () => {
    expect(con.isOpen()).toBe(false);
    con.toggle();
    expect(con.isOpen()).toBe(true);
    con.toggle();
    expect(con.isOpen()).toBe(false);
    con.open();
    expect(con.isOpen()).toBe(true);
    con.close();
    expect(con.isOpen()).toBe(false);
  });

  it('echoes the input line and prints command output', async () => {
    await con.execute('echo hello "big world"');
    expect(con.lines).toEqual([
      expect.objectContaining({ kind: 'input', text: '> echo hello "big world"' }),
      expect.objectContaining({ kind: 'output', text: 'hello big world' }),
    ]);
    expect(con.history).toEqual(['echo hello "big world"']);
  });

  it('ignores blank lines', async () => {
    await con.execute('   ');
    expect(con.lines).toEqual([]);
    expect(con.history).toEqual([]);
  });

  it('reports unknown commands and parse errors as error lines', async () => {
    await con.execute('nope 1 2');
    await con.execute('echo "unterminated');
    const errors = con.lines.filter((l) => l.kind === 'error').map((l) => l.text);
    expect(errors).toEqual(['Unknown command "nope". Type "help" for a list.', 'Unterminated " quote']);
  });

  it('catches sync and async command errors', async () => {
    con.register({
      name: 'boom',
      description: 'throws',
      run: () => {
        throw new TypeError('bad');
      },
    });
    con.register({ name: 'later', description: 'rejects', run: () => Promise.reject(new Error('nope')) });
    await con.execute('boom');
    await con.execute('later');
    const errors = con.lines.filter((l) => l.kind === 'error').map((l) => l.text);
    expect(errors).toEqual(['TypeError: bad', 'Error: nope']);
  });

  it('awaits async results and supports ctx.print', async () => {
    const cmd: Command = {
      name: 'slow',
      description: 'async',
      run: async (args, ctx) => {
        ctx.print(`working on ${args.join(',')}`);
        await Promise.resolve();
        return 'done';
      },
    };
    con.register(cmd);
    await con.execute('slow a b');
    expect(texts()).toEqual(['> slow a b', 'working on a,b', 'done']);
  });

  it('help lists commands and describes one', async () => {
    con.register({ name: 'seed', description: 'Reseed the RNG', usage: '[n]', run: () => undefined });
    await con.execute('help');
    expect(texts()).toContain('seed   Reseed the RNG');
    expect(texts()).toContain('clear  Clear the scrollback');
    con.clear();
    await con.execute('help seed');
    expect(texts()).toEqual(['> help seed', 'seed [n]', '  Reseed the RNG']);
    con.clear();
    await con.execute('help missing');
    expect(texts()).toEqual(['> help missing', 'Unknown command "missing"']);
  });

  it('clear empties the scrollback', async () => {
    await con.execute('echo a');
    await con.execute('clear');
    expect(con.lines).toEqual([]);
  });

  it('register replaces by name, returns an unregister function, rejects bad names', () => {
    const first: Command = { name: 'x', description: 'first', run: () => 'first' };
    const second: Command = { name: 'x', description: 'second', run: () => 'second' };
    const off1 = con.register(first);
    con.register(second);
    expect(con.getCommand('x')).toBe(second);
    off1(); // stale unregister must not remove the replacement
    expect(con.getCommand('x')).toBe(second);
    expect(con.unregister('x')).toBe(true);
    expect(con.unregister('x')).toBe(false);
    expect(() => con.register({ name: 'bad name', description: '', run: () => undefined })).toThrow();
    expect(() => con.register({ name: '', description: '', run: () => undefined })).toThrow();
  });

  it('completes command names', () => {
    con.register({ name: 'edit', description: '', run: () => undefined });
    expect(con.complete('e')).toEqual(['echo', 'edit']);
    expect(con.complete('h')).toEqual(['help']);
    expect(con.complete('zzz')).toEqual([]);
  });

  it('seeds the scrollback from the log buffer and follows live log events', () => {
    con.dispose();
    log.info('earlier');
    con = new DebugConsole({ bus, maxLines: 50 });
    expect(con.lines).toEqual([expect.objectContaining({ kind: 'info', text: 'earlier' })]);
    bus.emit('console:log', { level: 'warn', message: 'careful', time: 1 });
    expect(con.lines[1]).toEqual(expect.objectContaining({ kind: 'warn', text: 'careful' }));
    con.dispose();
    bus.emit('console:log', { level: 'error', message: 'after dispose', time: 2 });
    expect(con.lines).toHaveLength(2);
    con = new DebugConsole({ bus, maxLines: 50 });
  });

  it('splits multi-line output and trims the scrollback to maxLines', () => {
    con.print('a\nb\nc');
    expect(texts()).toEqual(['a', 'b', 'c']);
    for (let i = 0; i < 60; i++) con.print(`line ${String(i)}`);
    expect(con.lines).toHaveLength(50);
    expect(con.lines[0]?.text).toBe('line 10');
    expect(con.lines[49]?.text).toBe('line 59');
  });
});
