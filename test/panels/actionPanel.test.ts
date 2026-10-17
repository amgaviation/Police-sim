import { describe, expect, it } from 'vitest';
import { ActionPanel, nextEnabled, type ActionPanelModel } from '../../src/ui/panels/actionPanel';
import { panelBadge, panelKeyToIndex } from '../../src/ui/panels/text';

const key = (k: string, repeat = false): KeyboardEvent => ({ key: k, repeat }) as KeyboardEvent;

const trunk: ActionPanelModel = {
  title: 'Trunk',
  subtitle: 'Patrol sedan',
  options: [
    { label: 'Flashlight', detail: 'x1' },
    { label: 'Traffic cones', detail: 'x0', enabled: false },
    { label: 'First aid kit', detail: 'x1' },
    { label: 'Fire extinguisher', enabled: false },
  ],
  footer: 'Esc close',
};

function openPanel(model: ActionPanelModel = trunk): { panel: ActionPanel; selected: number[]; closed: { n: number } } {
  const panel = new ActionPanel(null);
  const selected: number[] = [];
  const closed = { n: 0 };
  panel.open(
    model,
    (i) => selected.push(i),
    () => {
      closed.n += 1;
    },
  );
  return { panel, selected, closed };
}

describe('panelKeyToIndex', () => {
  it('maps 1..9 to 0..8 and everything else to null', () => {
    for (let d = 1; d <= 9; d++) expect(panelKeyToIndex(String(d))).toBe(d - 1);
    for (const k of ['0', 'a', 'Enter', 'Digit1', '', '10', ' ']) expect(panelKeyToIndex(k)).toBeNull();
  });

  it('badges only the first nine options', () => {
    expect(panelBadge(0)).toBe('1');
    expect(panelBadge(8)).toBe('9');
    expect(panelBadge(9)).toBe('');
    expect(panelBadge(-1)).toBe('');
  });
});

describe('nextEnabled', () => {
  it('wraps in both directions and skips disabled options', () => {
    expect(nextEnabled(trunk.options, 0, 1)).toBe(0);
    expect(nextEnabled(trunk.options, 1, 1)).toBe(2);
    expect(nextEnabled(trunk.options, 3, 1)).toBe(0);
    expect(nextEnabled(trunk.options, -1, -1)).toBe(2);
    expect(nextEnabled(trunk.options, 1, -1)).toBe(0);
    expect(nextEnabled([], 0, 1)).toBe(-1);
    expect(nextEnabled([{ label: 'x', enabled: false }], 0, 1)).toBe(-1);
  });
});

describe('ActionPanel (headless)', () => {
  it('is a non-pausing menu with the spec id', () => {
    const panel = new ActionPanel(null);
    expect(panel.id).toBe('action-panel');
    expect(panel.pausesGame).toBe(false);
    expect(panel.isOpen).toBe(false);
    expect(panel.onKeyDown(key('1'))).toBe(false);
  });

  it('opens with the model and the first enabled option highlighted', () => {
    const { panel } = openPanel({ title: 'T', options: [{ label: 'a', enabled: false }, { label: 'b' }] });
    expect(panel.isOpen).toBe(true);
    expect(panel.model?.title).toBe('T');
    expect(panel.focusIndex).toBe(1);
  });

  it('selects enabled options with digits and ignores disabled or missing ones', () => {
    const { panel, selected } = openPanel();
    expect(panel.onKeyDown(key('3'))).toBe(true);
    expect(selected).toEqual([2]);
    expect(panel.focusIndex).toBe(2);
    expect(panel.onKeyDown(key('2'))).toBe(true);
    expect(panel.onKeyDown(key('9'))).toBe(true);
    expect(panel.onKeyDown(key('1', true))).toBe(true);
    expect(selected).toEqual([2]);
    expect(panel.isOpen).toBe(true);
  });

  it('moves with the arrows over enabled options and selects with Enter', () => {
    const { panel, selected } = openPanel();
    expect(panel.focusIndex).toBe(0);
    panel.onKeyDown(key('ArrowDown'));
    expect(panel.focusIndex).toBe(2);
    panel.onKeyDown(key('ArrowDown'));
    expect(panel.focusIndex).toBe(0);
    panel.onKeyDown(key('ArrowUp'));
    expect(panel.focusIndex).toBe(2);
    expect(panel.onKeyDown(key('Enter'))).toBe(true);
    expect(selected).toEqual([2]);
    panel.onKeyDown(key('Enter', true));
    expect(selected).toEqual([2]);
  });

  it('closes on Escape and calls onClose once', () => {
    const { panel, closed } = openPanel();
    expect(panel.onKeyDown(key('Escape'))).toBe(true);
    expect(panel.isOpen).toBe(false);
    expect(closed.n).toBe(1);
    panel.close();
    expect(closed.n).toBe(1);
    expect(panel.onKeyDown(key('1'))).toBe(false);
  });

  it('close() also calls onClose, and selecting while closed does nothing', () => {
    const { panel, selected, closed } = openPanel();
    panel.close();
    expect(closed.n).toBe(1);
    expect(panel.select(0)).toBe(false);
    expect(selected).toEqual([]);
  });

  it('leaves unhandled keys to the game', () => {
    const { panel } = openPanel();
    expect(panel.onKeyDown(key('w'))).toBe(false);
    expect(panel.onKeyDown(key('Tab'))).toBe(false);
  });

  it('update refreshes the model in place and keeps the highlight', () => {
    const { panel, selected } = openPanel();
    panel.onKeyDown(key('ArrowDown'));
    expect(panel.focusIndex).toBe(2);
    panel.update({ ...trunk, options: trunk.options.map((o, i) => (i === 2 ? { ...o, detail: 'x0' } : o)) });
    expect(panel.focusIndex).toBe(2);
    expect(panel.model?.options[2]?.detail).toBe('x0');
    // The highlighted option becomes disabled: move to the next enabled one.
    panel.update({ ...trunk, options: trunk.options.map((o, i) => (i === 2 ? { ...o, enabled: false } : o)) });
    expect(panel.focusIndex).toBe(0);
    // Fewer options than the highlight.
    panel.onKeyDown(key('1'));
    panel.update({ title: 'Trunk', options: [{ label: 'only', enabled: false }] });
    expect(panel.focusIndex).toBe(-1);
    expect(panel.onKeyDown(key('Enter'))).toBe(true);
    expect(selected).toEqual([0]);
    expect(panel.isOpen).toBe(true);
  });

  it('re-opening replaces the model and callbacks without calling the old onClose', () => {
    const { panel, closed } = openPanel();
    const second: number[] = [];
    panel.open({ title: 'Driver', options: [{ label: 'Request licence' }] }, (i) => second.push(i));
    expect(closed.n).toBe(0);
    panel.onKeyDown(key('1'));
    expect(second).toEqual([0]);
    panel.onKeyDown(key('Escape'));
    expect(closed.n).toBe(0);
  });

  it('lets onSelect close the panel', () => {
    const panel = new ActionPanel(null);
    let closes = 0;
    panel.open(
      trunk,
      () => {
        panel.close();
      },
      () => {
        closes += 1;
      },
    );
    panel.onKeyDown(key('1'));
    expect(panel.isOpen).toBe(false);
    expect(closes).toBe(1);
  });
});
