import type { CareerSave, CareerStage, CareerView, ShiftSummary } from '../../src/career';
import { DAY, GOOD_CTX, harness, saveAt, stepAt, type Harness } from '../career/helpers';

export { DAY, GOOD_CTX };
export const H = 3600;
export const NIGHT_START = DAY + 22 * H;

/** The view of a career in `stage`, after `mutate` changed its save. */
export function viewOf(stage: CareerStage = 'patrol', mutate?: (s: CareerSave) => void): CareerView {
  const save = saveAt(stage);
  mutate?.(save);
  return harness(save).career.view;
}

/** A patrol officer who ended the first night shift on time: off duty, with hours left before the next shift. */
export function offDutyHarness(mutate?: (s: CareerSave) => void): Harness & { summary: ShiftSummary } {
  const save = saveAt('patrol');
  mutate?.(save);
  const h = harness(save);
  stepAt(h, NIGHT_START);
  h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: false });
  stepAt(h, NIGHT_START + 8 * H);
  const summary = h.summaries[0];
  if (!summary) throw new Error('no shift summary');
  return Object.assign(h, { summary });
}

/** A minimal fake Storage backed by a map. */
export function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

export function key(k: string): KeyboardEvent {
  return { key: k, repeat: false, ctrlKey: false, altKey: false, metaKey: false, target: null } as unknown as KeyboardEvent;
}
