import { describe, expect, it } from 'vitest';
import { SUBTITLE_BASE_MS, SUBTITLE_PER_CHAR_MS, SubtitleBar } from '../../src/ui/dialogue/subtitleBar';

describe('SubtitleBar (headless)', () => {
  it('shows "Name: text" and has no line before anything is said', () => {
    const bar = new SubtitleBar(null);
    expect(bar.current).toBeNull();
    bar.show('Jane', 'Hello there', 1000);
    expect(bar.current).toBe('Jane: Hello there');
    bar.show('', 'No speaker', 1000);
    expect(bar.current).toBe('No speaker');
  });

  it('stays up for 4000 ms plus 50 ms per character', () => {
    const bar = new SubtitleBar(null);
    const line = 'Jane: Hello there';
    const duration = SUBTITLE_BASE_MS + SUBTITLE_PER_CHAR_MS * line.length;
    expect(SUBTITLE_BASE_MS).toBe(4000);
    expect(SUBTITLE_PER_CHAR_MS).toBe(50);
    bar.show('Jane', 'Hello there', 10_000);
    bar.update(10_000 + duration - 1);
    expect(bar.current).toBe(line);
    bar.update(10_000 + duration);
    expect(bar.current).toBeNull();
  });

  it('takes an explicit duration', () => {
    const bar = new SubtitleBar(null);
    bar.show('A', 'b', 0, 500);
    bar.update(499);
    expect(bar.current).toBe('A: b');
    bar.update(500);
    expect(bar.current).toBeNull();
  });

  it('replaces the line and restarts the timer', () => {
    const bar = new SubtitleBar(null);
    bar.show('A', 'first', 0, 1000);
    bar.show('B', 'second', 900, 1000);
    bar.update(1500);
    expect(bar.current).toBe('B: second');
    bar.update(1900);
    expect(bar.current).toBeNull();
  });

  it('ignores empty lines', () => {
    const bar = new SubtitleBar(null);
    bar.show('A', 'kept', 0);
    bar.show('', '', 10);
    expect(bar.current).toBe('A: kept');
  });

  it('clear() removes the line; setVisible(false) hides and refuses lines until shown again', () => {
    const bar = new SubtitleBar(null);
    bar.show('A', 'x', 0);
    bar.clear();
    expect(bar.current).toBeNull();
    bar.show('A', 'y', 0);
    bar.setVisible(false);
    expect(bar.current).toBeNull();
    bar.show('A', 'z', 0);
    expect(bar.current).toBeNull();
    bar.setVisible(true);
    bar.show('A', 'w', 0);
    expect(bar.current).toBe('A: w');
    bar.dispose();
    expect(bar.current).toBeNull();
  });
});
