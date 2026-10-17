/** Hand-written fake Web Audio graph: records node creation and AudioParam writes. */

export interface ParamEvent {
  readonly kind: 'value' | 'setTargetAtTime' | 'setValueAtTime' | 'linearRamp' | 'exponentialRamp' | 'cancel';
  readonly value: number;
  readonly time: number;
}

export class FakeParam {
  private readonly ctx: FakeContext;
  private v: number;
  readonly events: ParamEvent[] = [];
  /** Last automation target (or plain value) written. */
  target: number;

  constructor(ctx: FakeContext, initial: number) {
    this.ctx = ctx;
    this.v = initial;
    this.target = initial;
  }

  get value(): number {
    return this.v;
  }

  set value(v: number) {
    this.v = v;
    this.target = v;
    this.record('value', v, this.ctx.currentTime);
  }

  setTargetAtTime(value: number, time: number, _tau: number): this {
    this.target = value;
    this.record('setTargetAtTime', value, time);
    return this;
  }

  setValueAtTime(value: number, time: number): this {
    this.record('setValueAtTime', value, time);
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.record('linearRamp', value, time);
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.record('exponentialRamp', value, time);
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.record('cancel', 0, time);
    return this;
  }

  private record(kind: ParamEvent['kind'], value: number, time: number): void {
    this.events.push({ kind, value, time });
    this.ctx.paramWrites++;
  }
}

export class FakeNode {
  readonly connections: unknown[] = [];
  disconnected = 0;
  readonly ctx: FakeContext;
  readonly kind: string;

  constructor(ctx: FakeContext, kind: string) {
    this.ctx = ctx;
    this.kind = kind;
  }

  connect<T>(dest: T): T {
    this.connections.push(dest);
    return dest;
  }

  disconnect(): void {
    this.disconnected++;
    this.connections.length = 0;
  }
}

export class FakeGain extends FakeNode {
  readonly gain: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'gain');
    this.gain = new FakeParam(ctx, 1);
  }
}

class FakeScheduled extends FakeNode {
  started: { when: number; offset?: number } | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  start(when = 0, offset?: number): void {
    this.started = { when, offset };
  }
  stop(when = 0): void {
    this.stoppedAt = when;
  }
}

export class FakeOscillator extends FakeScheduled {
  type = 'sine';
  readonly frequency: FakeParam;
  readonly detune: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'oscillator');
    this.frequency = new FakeParam(ctx, 440);
    this.detune = new FakeParam(ctx, 0);
  }
}

export class FakeBufferSource extends FakeScheduled {
  buffer: FakeBuffer | null = null;
  loop = false;
  constructor(ctx: FakeContext) {
    super(ctx, 'bufferSource');
  }
}

export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  readonly frequency: FakeParam;
  readonly Q: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'biquad');
    this.frequency = new FakeParam(ctx, 350);
    this.Q = new FakeParam(ctx, 1);
  }
}

export class FakeWaveShaper extends FakeNode {
  curve: Float32Array | null = null;
  constructor(ctx: FakeContext) {
    super(ctx, 'waveShaper');
  }
}

export class FakePanner extends FakeNode {
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  refDistance = 1;
  rolloffFactor = 1;
  maxDistance = 10000;
  readonly positionX: FakeParam;
  readonly positionY: FakeParam;
  readonly positionZ: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'panner');
    this.positionX = new FakeParam(ctx, 0);
    this.positionY = new FakeParam(ctx, 0);
    this.positionZ = new FakeParam(ctx, 0);
  }
}

export class FakeBuffer {
  readonly duration: number;
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly data: Float32Array;
  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = new Float32Array(length);
  }
  getChannelData(_channel: number): Float32Array {
    return this.data;
  }
}

export class FakeListener {
  readonly positionX: FakeParam;
  readonly positionY: FakeParam;
  readonly positionZ: FakeParam;
  readonly forwardX: FakeParam;
  readonly forwardY: FakeParam;
  readonly forwardZ: FakeParam;
  readonly upX: FakeParam;
  readonly upY: FakeParam;
  readonly upZ: FakeParam;
  constructor(ctx: FakeContext) {
    this.positionX = new FakeParam(ctx, 0);
    this.positionY = new FakeParam(ctx, 0);
    this.positionZ = new FakeParam(ctx, 0);
    this.forwardX = new FakeParam(ctx, 0);
    this.forwardY = new FakeParam(ctx, 0);
    this.forwardZ = new FakeParam(ctx, -1);
    this.upX = new FakeParam(ctx, 0);
    this.upY = new FakeParam(ctx, 1);
    this.upZ = new FakeParam(ctx, 0);
  }
}

export class FakeContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  readonly sampleRate = 8000;
  paramWrites = 0;
  readonly created: Record<string, number> = {};
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeNode;
  readonly listener: FakeListener;
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;
  /** When set, resume() returns a rejected promise. */
  rejectResume = false;

  constructor() {
    this.destination = new FakeNode(this, 'destination');
    this.listener = new FakeListener(this);
  }

  get totalCreated(): number {
    return Object.values(this.created).reduce((a, b) => a + b, 0);
  }

  private track<T extends FakeNode>(node: T): T {
    this.created[node.kind] = (this.created[node.kind] ?? 0) + 1;
    this.nodes.push(node);
    return node;
  }

  createGain(): FakeGain {
    return this.track(new FakeGain(this));
  }
  createOscillator(): FakeOscillator {
    return this.track(new FakeOscillator(this));
  }
  createBufferSource(): FakeBufferSource {
    return this.track(new FakeBufferSource(this));
  }
  createBiquadFilter(): FakeBiquad {
    return this.track(new FakeBiquad(this));
  }
  createWaveShaper(): FakeWaveShaper {
    return this.track(new FakeWaveShaper(this));
  }
  createPanner(): FakePanner {
    return this.track(new FakePanner(this));
  }
  createBuffer(channels: number, length: number, rate: number): FakeBuffer {
    this.created['buffer'] = (this.created['buffer'] ?? 0) + 1;
    return new FakeBuffer(channels, length, rate);
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.rejectResume) return Promise.reject(new Error('not allowed'));
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspendCalls++;
    this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCalls++;
    this.state = 'closed';
    return Promise.resolve();
  }

  nodesOf<T extends FakeNode>(kind: string): T[] {
    return this.nodes.filter((n) => n.kind === kind) as T[];
  }
}

/** Engine factory over a fresh fake context; the context is exposed for assertions. */
export function fakeFactory(): { ctx: FakeContext; factory: () => AudioContext } {
  const ctx = new FakeContext();
  return { ctx, factory: () => ctx as unknown as AudioContext };
}
