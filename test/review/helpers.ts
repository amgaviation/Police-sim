import type { Menu, UIRoot } from '../../src/ui/ui';
import type { ReviewEvent, ReviewFooter, ReviewSource, SnapshotMeta } from '../../src/recording';

export const key = (k: string, extra: { repeat?: boolean; shiftKey?: boolean } = {}): KeyboardEvent =>
  ({ key: k, repeat: false, shiftKey: false, ...extra }) as KeyboardEvent;

/** The few UIRoot members the panel uses. */
export interface FakeUi {
  readonly menus: Menu[];
  isOpen(m: Menu): boolean;
  push(m: Menu): void;
  pop(m?: Menu): void;
}

export function fakeUi(): FakeUi {
  const stack: Menu[] = [];
  return {
    menus: stack,
    isOpen: (m: Menu): boolean => stack.includes(m),
    push: (m: Menu): void => {
      stack.push(m);
    },
    pop: (m?: Menu): void => {
      const target = m ?? stack[stack.length - 1];
      if (!target) return;
      stack.splice(stack.indexOf(target), 1);
      target.onHide?.();
    },
  };
}

export function asUi(ui: FakeUi): UIRoot {
  return ui as unknown as UIRoot;
}

export function ev(id: number, t: number, cam = 1, extra: Partial<ReviewEvent> = {}): ReviewEvent {
  return { id, t, label: `event ${String(id)}`, kind: 'x', severity: 'info', cam, ...extra };
}

export function snap(sim: number): SnapshotMeta {
  return { key: `s${String(sim)}`, tag: 't', incident: 'C-1', source: 'body', sim, game: sim, bytes: 3, w: 160, h: 90 };
}

export interface TestSource extends ReviewSource {
  readonly imageCalls: string[];
}

/** 0-60 s, events at 0 / 10 / 20 / 20 / 40, snapshots every 10 s from 10, camera muted 20-30 s. */
export function makeSource(over: Partial<ReviewSource> = {}): TestSource {
  const imageCalls: string[] = [];
  const snaps = [10, 20, 30, 40, 50].map(snap);
  return {
    title: 'C-00042 · Disturbance',
    t0: 0,
    t1: 60,
    events: [
      ev(1, 0, 1),
      ev(2, 10, 1),
      ev(3, 20, 3, { severity: 'warn', label: 'Muted bodycam' }),
      ev(4, 20, 3, { severity: 'bad', label: 'Force applied' }),
      ev(5, 40, 0),
    ],
    snapshots: () => Promise.resolve(snaps),
    image: (k: string) => {
      imageCalls.push(k);
      return Promise.resolve(new Blob([k]));
    },
    imageCalls,
    ...over,
  };
}

export function makeFooter(): ReviewFooter & { picks: number[]; opts: string[] } {
  const picks: number[] = [];
  const f = {
    picks,
    opts: ['Admit the muting', 'Deny it'],
    lines: (): readonly string[] => [`Statement ${String(picks.length)}`, 'Why was the camera muted?'],
    options: (): readonly string[] => f.opts,
    pick: (i: number): void => {
      picks.push(i);
    },
  };
  return f;
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}
