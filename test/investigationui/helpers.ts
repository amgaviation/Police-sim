import type { Menu, UIRoot } from '../../src/ui/ui';

export const key = (k: string, repeat = false): KeyboardEvent => ({ key: k, repeat }) as KeyboardEvent;

/** The few UIRoot members the panels use. */
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
