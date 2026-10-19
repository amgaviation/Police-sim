/** Holding cells (design §11.1): each cell holds one person. Pure. */

export interface CellOccupant {
  readonly cell: number;
  readonly personId: number;
  /** Sim time the person was placed. */
  readonly since: number;
}

export class HoldingCells {
  readonly cellCount: number;
  private readonly cells: (CellOccupant | null)[];

  constructor(cellCount: number) {
    this.cellCount = Math.max(0, Math.floor(cellCount));
    this.cells = new Array<CellOccupant | null>(this.cellCount).fill(null);
  }

  /** Puts the person in the lowest free cell; its index, or -1 when every cell is taken or the person is already held. */
  place(personId: number, sim: number): number {
    if (this.cellOf(personId) >= 0) return -1;
    const cell = this.cells.indexOf(null);
    if (cell < 0) return -1;
    this.cells[cell] = { cell, personId, since: sim };
    return cell;
  }

  /** Releases the person; false when they were not held. */
  remove(personId: number): boolean {
    const cell = this.cellOf(personId);
    if (cell < 0) return false;
    this.cells[cell] = null;
    return true;
  }

  /** Cell of the person, -1 when not held. */
  cellOf(personId: number): number {
    return this.cells.findIndex((c) => c !== null && c.personId === personId);
  }

  /** Everyone held, by cell. */
  occupants(): readonly CellOccupant[] {
    return this.cells.filter((c): c is CellOccupant => c !== null);
  }

  /** Replaces the occupants (save load); entries with a bad or taken cell are dropped. */
  restore(list: readonly (readonly [number, number, number])[]): void {
    this.cells.fill(null);
    for (const [cell, personId, since] of list) {
      if (!Number.isInteger(cell) || cell < 0 || cell >= this.cellCount || this.cells[cell] !== null) continue;
      this.cells[cell] = { cell, personId, since };
    }
  }
}
