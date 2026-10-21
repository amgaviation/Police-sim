/** Shared gear types (Phase 7 design §4.1, §4.2, §8.3). */

/** Where a gear item is worn or carried; each slot has a capacity (providers add room). */
export const GEAR_SLOTS = ['belt', 'vest', 'body', 'longGun', 'carry'] as const;
export type GearSlot = (typeof GEAR_SLOTS)[number];

/** Officer assignments; each has a policy (weight limit, required / forbidden items, retention, long guns). */
export const ASSIGNMENTS = ['patrol', 'traffic', 'k9', 'motor', 'bicycle', 'swat', 'detective', 'supervisor', 'marine', 'air'] as const;
export type Assignment = (typeof ASSIGNMENTS)[number];

export type GearIssueCode =
  | 'unknownItem'
  | 'countRange'
  | 'overweight'
  | 'slotsFull'
  | 'missingRequired'
  | 'forbidden'
  | 'retentionTooLow'
  | 'retentionMissing'
  | 'tooManyLongGuns'
  | 'requiresItem'
  | 'notRackItem'
  | 'rackFull'
  | 'cargoWeight'
  | 'cargoSlots'
  | 'missingVehicleItem'
  | 'unknownTrunkItem';

export interface GearIssue {
  code: GearIssueCode;
  /** The item (or, for `slotsFull`, null) the issue is about. */
  item: string | null;
  message: string;
}

export interface OfficerLoadoutItem {
  id: string;
  count: number;
  /** Holster retention level; required on items whose definition has `retention`. */
  retention?: 1 | 2 | 3;
}

export interface OfficerLoadout {
  assignment: Assignment;
  items: OfficerLoadoutItem[];
}

/** What a vehicle carries: trunk item id -> count, and the racked long gun ids. */
export interface VehicleLoadout {
  trunk: Record<string, number>;
  rack: string[];
}

/** A vehicle's cargo capacity (`cargo` of its model). */
export interface VehicleCapacity {
  kg: number;
  slots: number;
  rackSlots: number;
}

export interface LoadoutValidation {
  ok: boolean;
  errors: GearIssue[];
  warnings: GearIssue[];
  /** Total mass of the loadout. */
  weightKg: number;
  /** The weight limit (officer: assignment `maxKg`; vehicle: `cap.kg`). */
  capacityKg: number;
  /**
   * Officer loadout: slot usage and capacity. Vehicle loadout: `carry` = trunk slots, `longGun` = rack slots, the
   * other slots are 0 / 0.
   */
  slots: Record<GearSlot, { used: number; cap: number }>;
}
