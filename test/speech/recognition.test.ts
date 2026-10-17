import { describe, expect, it, vi } from 'vitest';
import {
  SpeechIn,
  alternativesOf,
  type RecognitionResultEventLike,
  type SpeechRecognitionLike,
} from '../../src/speech/recognition';

class FakeRecognizer implements SpeechRecognitionLike {
  lang = '';
  continuous = true;
  interimResults = true;
  maxAlternatives = 1;
  onresult: ((ev: RecognitionResultEventLike) => void) | null = null;
  onerror: ((ev: { readonly error: string }) => void) | null = null;
  onnomatch: ((ev: unknown) => void) | null = null;
  onend: ((ev: unknown) => void) | null = null;
  calls: string[] = [];
  running = false;
  start(): void {
    if (this.running) throw new Error('InvalidStateError');
    this.running = true;
    this.calls.push('start');
  }
  stop(): void {
    this.calls.push('stop');
  }
  abort(): void {
    this.running = false;
    this.calls.push('abort');
  }
  end(): void {
    this.running = false;
    this.onend?.({});
  }
}

function make(): { rec: FakeRecognizer; speech: SpeechIn; made: () => number } {
  const rec = new FakeRecognizer();
  let made = 0;
  const speech = new SpeechIn({
    factory: () => {
      made++;
      return rec;
    },
  });
  return { rec, speech, made: () => made };
}

function event(resultIndex: number, results: { transcript: string; confidence: number }[][]): RecognitionResultEventLike {
  return { resultIndex, results };
}

describe('SpeechIn', () => {
  it('is unavailable headless and every call is a safe no-op', () => {
    const speech = new SpeechIn();
    expect(speech.available).toBe(false);
    speech.enabled = true;
    expect(speech.start()).toBe(false);
    expect(speech.listening).toBe(false);
    expect(() => {
      speech.stop();
      speech.dispose();
    }).not.toThrow();
    expect(new SpeechIn({ factory: null }).available).toBe(false);
  });

  it('is off by default and starts only when enabled', () => {
    const { rec, speech, made } = make();
    expect(speech.available).toBe(true);
    expect(speech.enabled).toBe(false);
    expect(speech.start()).toBe(false);
    expect(made()).toBe(0);
    speech.enabled = true;
    expect(speech.start()).toBe(true);
    expect(speech.listening).toBe(true);
    expect(rec.calls).toEqual(['start']);
  });

  it('configures one-shot English recognition with 3 alternatives', () => {
    const { rec, speech } = make();
    speech.enabled = true;
    speech.start();
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(false);
    expect(rec.maxAlternatives).toBe(3);
    expect(rec.lang).toBe('en-US');
    const other = new SpeechIn({ factory: () => new FakeRecognizer(), lang: 'en-GB' });
    other.enabled = true;
    expect(other.start()).toBe(true);
  });

  it('reuses one recognizer across push-to-talk presses', () => {
    const { rec, speech, made } = make();
    speech.enabled = true;
    speech.start();
    expect(speech.start()).toBe(true);
    speech.stop();
    expect(speech.listening).toBe(false);
    rec.end();
    speech.start();
    expect(made()).toBe(1);
    expect(rec.calls).toEqual(['start', 'stop', 'start']);
  });

  it('returns false when the recognizer refuses to start', () => {
    const { rec, speech } = make();
    speech.enabled = true;
    rec.running = true;
    expect(speech.start()).toBe(false);
    expect(speech.listening).toBe(false);
  });

  it('maps results to alternatives, best first', () => {
    const { rec, speech } = make();
    const got = vi.fn();
    speech.onResult(got);
    speech.enabled = true;
    speech.start();
    rec.onresult?.(
      event(1, [
        [{ transcript: 'old', confidence: 1 }],
        [
          { transcript: ' show me en route ', confidence: 0.6 },
          { transcript: 'show me in route', confidence: 0.8 },
          { transcript: 'snow me en route', confidence: 0.1 },
        ],
      ]),
    );
    expect(got).toHaveBeenCalledWith([
      { transcript: 'show me in route', confidence: 0.8 },
      { transcript: 'show me en route', confidence: 0.6 },
      { transcript: 'snow me en route', confidence: 0.1 },
    ]);
  });

  it('ignores empty results and unsubscribes listeners', () => {
    const { rec, speech } = make();
    const got = vi.fn();
    const off = speech.onResult(got);
    speech.enabled = true;
    speech.start();
    rec.onresult?.(event(3, []));
    expect(got).not.toHaveBeenCalled();
    off();
    rec.onresult?.(event(0, [[{ transcript: 'x', confidence: 1 }]]));
    expect(got).not.toHaveBeenCalled();
    expect(alternativesOf(event(0, [[{ transcript: 'a', confidence: Number.NaN }]]))).toEqual([{ transcript: 'a', confidence: 0 }]);
  });

  it('forwards errors by code and nomatch as no-match', () => {
    const { rec, speech } = make();
    const codes: string[] = [];
    speech.onError((c) => codes.push(c));
    speech.enabled = true;
    speech.start();
    rec.onerror?.({ error: 'not-allowed' });
    expect(speech.listening).toBe(false);
    rec.onnomatch?.({});
    rec.onerror?.({ error: 'network' });
    expect(codes).toEqual(['not-allowed', 'no-match', 'network']);
  });

  it('clears listening when recognition ends', () => {
    const { rec, speech } = make();
    speech.enabled = true;
    speech.start();
    rec.end();
    expect(speech.listening).toBe(false);
  });

  it('aborts when disabled while listening, and on dispose', () => {
    const { rec, speech } = make();
    speech.enabled = true;
    speech.start();
    speech.enabled = false;
    expect(rec.calls).toContain('abort');
    expect(speech.listening).toBe(false);
    speech.enabled = true;
    speech.start();
    speech.dispose();
    expect(rec.calls.filter((c) => c === 'abort')).toHaveLength(2);
    expect(rec.onresult).toBeNull();
    expect(speech.available).toBe(false);
    expect(speech.start()).toBe(false);
  });

  it('isolates throwing listeners', () => {
    const { rec, speech } = make();
    const good = vi.fn();
    speech.onResult(() => {
      throw new Error('bad listener');
    });
    speech.onResult(good);
    speech.enabled = true;
    speech.start();
    expect(() => rec.onresult?.(event(0, [[{ transcript: 'ten four', confidence: 0.9 }]]))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
