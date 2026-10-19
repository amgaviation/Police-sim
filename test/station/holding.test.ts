import { describe, expect, it } from 'vitest';
import { HoldingCells } from '../../src/station/holding';

describe('HoldingCells', () => {
  it('places people in the lowest free cell until full', () => {
    const h = new HoldingCells(3);
    expect(h.place(10, 1)).toBe(0);
    expect(h.place(11, 2)).toBe(1);
    expect(h.place(12, 3)).toBe(2);
    expect(h.place(13, 4)).toBe(-1);
    expect(h.occupants()).toEqual([
      { cell: 0, personId: 10, since: 1 },
      { cell: 1, personId: 11, since: 2 },
      { cell: 2, personId: 12, since: 3 },
    ]);
  });

  it('refuses a person who is already held', () => {
    const h = new HoldingCells(2);
    expect(h.place(5, 0)).toBe(0);
    expect(h.place(5, 1)).toBe(-1);
    expect(h.occupants()).toHaveLength(1);
  });

  it('removes people and reuses the cell', () => {
    const h = new HoldingCells(2);
    h.place(1, 0);
    h.place(2, 0);
    expect(h.cellOf(1)).toBe(0);
    expect(h.cellOf(2)).toBe(1);
    expect(h.remove(1)).toBe(true);
    expect(h.remove(1)).toBe(false);
    expect(h.cellOf(1)).toBe(-1);
    expect(h.place(3, 9)).toBe(0);
    expect(h.occupants().map((o) => o.personId)).toEqual([3, 2]);
  });

  it('has no room with zero cells', () => {
    expect(new HoldingCells(0).place(1, 0)).toBe(-1);
  });

  it('restores occupants, dropping bad or duplicate cells', () => {
    const h = new HoldingCells(2);
    h.restore([[1, 7, 4], [1, 8, 5], [5, 9, 6], [0, 3, 1]]);
    expect(h.occupants()).toEqual([{ cell: 0, personId: 3, since: 1 }, { cell: 1, personId: 7, since: 4 }]);
  });
});
