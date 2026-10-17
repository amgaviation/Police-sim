/**
 * Numeric id maps shared by the road graph, the city and the data validators.
 * Kept in their own module so the data loader and the graph can both import
 * them without a cycle; `roadGraph.ts` re-exports everything.
 */

export const ROAD_CLASS = { highway: 0, arterial: 1, collector: 2, local: 3, county: 4, gravel: 5, service: 6 } as const;
export type RoadClassId = (typeof ROAD_CLASS)[keyof typeof ROAD_CLASS];
export type RoadClassName = keyof typeof ROAD_CLASS;
export const ROAD_CLASS_NAMES: readonly RoadClassName[] = [
  'highway', 'arterial', 'collector', 'local', 'county', 'gravel', 'service',
];

/** minorStop: approaches of the lower class stop. */
export const JUNCTION = { none: 0, signal: 1, allWayStop: 2, minorStop: 3 } as const;
export type JunctionId = (typeof JUNCTION)[keyof typeof JUNCTION];
export const JUNCTION_NAMES: readonly (keyof typeof JUNCTION)[] = ['none', 'signal', 'allWayStop', 'minorStop'];

export const EDGE_FLAG = { oneWay: 1, divided: 2, schoolZone: 4, construction: 8 } as const;
export type EdgeFlagId = (typeof EDGE_FLAG)[keyof typeof EDGE_FLAG];
/** Indexed by bit position (flag = 1 << index). */
export const EDGE_FLAG_NAMES: readonly (keyof typeof EDGE_FLAG)[] = ['oneWay', 'divided', 'schoolZone', 'construction'];

export const SURFACE = { asphalt: 0, concrete: 1, gravel: 2, dirt: 3, grass: 4, sand: 5 } as const;
export type SurfaceId = (typeof SURFACE)[keyof typeof SURFACE];
export type SurfaceName = keyof typeof SURFACE;
export const SURFACE_NAMES: readonly SurfaceName[] = ['asphalt', 'concrete', 'gravel', 'dirt', 'grass', 'sand'];

export const DISTRICT = {
  downtown: 0, suburbs: 1, industrial: 2, highway: 3, rural: 4, campus: 5,
  hospital: 6, airport: 7, harbor: 8, park: 9, water: 10,
} as const;
export type DistrictId = (typeof DISTRICT)[keyof typeof DISTRICT];
export type DistrictName = keyof typeof DISTRICT;
export const DISTRICT_NAMES: readonly DistrictName[] = [
  'downtown', 'suburbs', 'industrial', 'highway', 'rural', 'campus', 'hospital', 'airport', 'harbor', 'park', 'water',
];

export const ASPECT = { green: 0, yellow: 1, red: 2 } as const;
export type AspectId = (typeof ASPECT)[keyof typeof ASPECT];
export const ASPECT_NAMES: readonly (keyof typeof ASPECT)[] = ['green', 'yellow', 'red'];

export const TURN = { straight: 0, left: 1, right: 2, uturn: 3 } as const;
export type TurnId = (typeof TURN)[keyof typeof TURN];
export const TURN_NAMES: readonly (keyof typeof TURN)[] = ['straight', 'left', 'right', 'uturn'];
