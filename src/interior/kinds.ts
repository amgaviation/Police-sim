/**
 * Building kind ids. Kept in their own module so `world/buildings.ts` (which needs the template sizes)
 * and `interior/templates.ts` (which validates against the kinds) do not import each other.
 * `world/buildings.ts` re-exports both names.
 */
export const BUILDING_KINDS = [
  'house', 'apartment', 'convenienceStore', 'bank', 'bar', 'hospital', 'school', 'warehouse',
  'office', 'parkingStructure', 'jail', 'policeStation',
] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];
