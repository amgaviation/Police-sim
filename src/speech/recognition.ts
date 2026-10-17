/**
 * Push-to-talk speech recognition (design §10.5). TypeScript's DOM lib lacks the
 * `SpeechRecognition` constructor, so this declares a minimal structural shape and looks up
 * `globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition`. Off unless `enabled`
 * (settings `audio.voiceCommands`, default off): browsers usually send the audio to a
 * remote recognition service. Nothing here ever throws.
 */

export interface RecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

/** Structural view of `SpeechRecognitionEvent`. */
export interface RecognitionResultEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<ArrayLike<RecognitionAlternativeLike>>;
}

/** Structural view of `SpeechRecognition` (test seam). */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((ev: RecognitionResultEventLike) => void) | null;
  onerror: ((ev: { readonly error: string }) => void) | null;
  onnomatch: ((ev: unknown) => void) | null;
  onend: ((ev: unknown) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechInOptions {
  /** Recognizer seam; null disables. Default: the browser's constructor, if any. */
  factory?: (() => SpeechRecognitionLike) | null;
  /** Recognition language. Default 'en-US'. */
  lang?: string;
}

export interface RecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

type ResultListener = (alternatives: readonly RecognitionAlternative[]) => void;
type ErrorListener = (code: string) => void;

function browserRecognizerFactory(): (() => SpeechRecognitionLike) | null {
  const g = globalThis as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown };
  const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return Ctor ? () => new Ctor() as SpeechRecognitionLike : null;
}

/** Maps one recognition event to the alternatives of its current result, best first. */
export function alternativesOf(ev: RecognitionResultEventLike): RecognitionAlternative[] {
  const result = ev.results[ev.resultIndex];
  if (!result) return [];
  const out: RecognitionAlternative[] = [];
  for (let i = 0; i < result.length; i++) {
    const alt = result[i];
    if (!alt) continue;
    out.push({ transcript: String(alt.transcript).trim(), confidence: Number.isFinite(alt.confidence) ? alt.confidence : 0 });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

export class SpeechIn {
  private readonly factory: (() => SpeechRecognitionLike) | null;
  private readonly lang: string;
  private recognizer: SpeechRecognitionLike | null = null;
  private isEnabled = false;
  private isListening = false;
  private disposed = false;
  private readonly resultListeners = new Set<ResultListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(options: SpeechInOptions = {}) {
    this.factory = options.factory !== undefined ? options.factory : browserRecognizerFactory();
    this.lang = options.lang ?? 'en-US';
  }

  /** True when the browser offers speech recognition. */
  get available(): boolean {
    return this.factory !== null && !this.disposed;
  }

  /** Settings `audio.voiceCommands`; turning it off aborts a running recognition. */
  get enabled(): boolean {
    return this.isEnabled;
  }

  set enabled(value: boolean) {
    this.isEnabled = value;
    if (!value && this.isListening) this.abort();
  }

  get listening(): boolean {
    return this.isListening;
  }

  /** PTT down: starts one recognition. False when disabled, unavailable or refused. */
  start(): boolean {
    if (!this.isEnabled || !this.available) return false;
    if (this.isListening) return true;
    try {
      const rec = this.ensureRecognizer();
      if (!rec) return false;
      rec.start();
      this.isListening = true;
      return true;
    } catch {
      this.isListening = false;
      return false;
    }
  }

  /** PTT up: ends capture; the final result (if any) still arrives through `onResult`. */
  stop(): void {
    if (!this.isListening) return;
    this.isListening = false;
    try {
      this.recognizer?.stop();
    } catch {
      // ignore
    }
  }

  onResult(fn: ResultListener): () => void {
    this.resultListeners.add(fn);
    return () => this.resultListeners.delete(fn);
  }

  onError(fn: ErrorListener): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  dispose(): void {
    if (this.disposed) return;
    this.abort();
    const rec = this.recognizer;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onnomatch = null;
      rec.onend = null;
    }
    this.recognizer = null;
    this.resultListeners.clear();
    this.errorListeners.clear();
    this.disposed = true;
  }

  private abort(): void {
    this.isListening = false;
    try {
      this.recognizer?.abort();
    } catch {
      // ignore
    }
  }

  private ensureRecognizer(): SpeechRecognitionLike | null {
    if (this.recognizer) return this.recognizer;
    const factory = this.factory;
    if (!factory) return null;
    const rec = factory();
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    rec.lang = this.lang;
    rec.onresult = (ev) => {
      const alternatives = alternativesOf(ev);
      if (alternatives.length === 0) return;
      for (const fn of this.resultListeners) {
        try {
          fn(alternatives);
        } catch {
          // listener errors stay with the listener
        }
      }
    };
    rec.onerror = (ev) => {
      this.isListening = false;
      this.emitError(typeof ev.error === 'string' ? ev.error : 'unknown');
    };
    rec.onnomatch = () => this.emitError('no-match');
    rec.onend = () => {
      this.isListening = false;
    };
    this.recognizer = rec;
    return rec;
  }

  private emitError(code: string): void {
    for (const fn of this.errorListeners) {
      try {
        fn(code);
      } catch {
        // ignore
      }
    }
  }
}
