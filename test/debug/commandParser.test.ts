import { describe, expect, it } from 'vitest';
import {
  CommandParseError,
  commonPrefix,
  completeName,
  parseCommand,
  parseCommandLine,
  quoteArg,
} from '../../src/debug/commandParser';

describe('parseCommandLine', () => {
  it('splits on whitespace and trims', () => {
    expect(parseCommandLine('  spawn   test  3 ')).toEqual(['spawn', 'test', '3']);
    expect(parseCommandLine('a\tb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('returns no tokens for a blank line', () => {
    expect(parseCommandLine('')).toEqual([]);
    expect(parseCommandLine('   ')).toEqual([]);
  });

  it('groups double-quoted text', () => {
    expect(parseCommandLine('save "my slot" now')).toEqual(['save', 'my slot', 'now']);
  });

  it('groups single-quoted text literally', () => {
    expect(parseCommandLine(`echo 'say "hi"'`)).toEqual(['echo', 'say "hi"']);
    expect(parseCommandLine(`echo 'a\\nb'`)).toEqual(['echo', 'a\\nb']);
  });

  it('keeps empty quoted tokens', () => {
    expect(parseCommandLine('set name ""')).toEqual(['set', 'name', '']);
    expect(parseCommandLine("set name ''")).toEqual(['set', 'name', '']);
  });

  it('allows quotes embedded mid-token', () => {
    expect(parseCommandLine('pre"fix mid"post')).toEqual(['prefix midpost']);
  });

  it('handles backslash escapes outside single quotes', () => {
    expect(parseCommandLine('echo a\\ b')).toEqual(['echo', 'a b']);
    expect(parseCommandLine('echo "say \\"hi\\""')).toEqual(['echo', 'say "hi"']);
    expect(parseCommandLine('echo \\\\')).toEqual(['echo', '\\']);
  });

  it('throws CommandParseError on an unterminated quote', () => {
    expect(() => parseCommandLine('echo "open')).toThrow(CommandParseError);
    expect(() => parseCommandLine("echo 'open")).toThrow(/Unterminated ' quote/);
    try {
      parseCommandLine('echo "open');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandParseError);
      expect((error as CommandParseError).position).toBe(5);
    }
  });

  it('throws on a trailing backslash', () => {
    expect(() => parseCommandLine('echo x\\')).toThrow(CommandParseError);
  });
});

describe('parseCommand', () => {
  it('separates the name from the arguments', () => {
    expect(parseCommand('timescale 2')).toEqual({ name: 'timescale', args: ['2'] });
    expect(parseCommand('help')).toEqual({ name: 'help', args: [] });
  });

  it('returns null for a blank line', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('  \t ')).toBeNull();
  });
});

describe('quoteArg', () => {
  it('round-trips arbitrary values through the parser', () => {
    for (const value of ['plain', 'has space', 'q"uote', "ap'os", 'back\\slash', '', 'tab\there']) {
      expect(parseCommandLine(`cmd ${quoteArg(value)}`)).toEqual(['cmd', value]);
    }
  });

  it('leaves simple words unquoted', () => {
    expect(quoteArg('simple')).toBe('simple');
    expect(quoteArg('')).toBe('""');
  });
});

describe('completion helpers', () => {
  it('commonPrefix finds the shared prefix', () => {
    expect(commonPrefix([])).toBe('');
    expect(commonPrefix(['save'])).toBe('save');
    expect(commonPrefix(['save', 'savelist', 'saveas'])).toBe('save');
    expect(commonPrefix(['spawn', 'seed'])).toBe('s');
    expect(commonPrefix(['abc', 'xyz'])).toBe('');
  });

  it('completeName filters by prefix and sorts', () => {
    const names = ['spawn', 'seed', 'save', 'help', 'load'];
    expect(completeName('s', names)).toEqual(['save', 'seed', 'spawn']);
    expect(completeName('sa', names)).toEqual(['save']);
    expect(completeName('zz', names)).toEqual([]);
    expect(completeName('', names)).toEqual(['help', 'load', 'save', 'seed', 'spawn']);
  });
});
