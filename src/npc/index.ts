/** NPC module (design §8): ambient pedestrians, scene actors with a behaviour state machine, vehicle occupants, render view. */
export { createNpcCommands } from './commands';
export { complianceChance, understands } from './compliance';
export { BEHAVIORS, DEMEANORS, NPC_CONFIG, NPC_DENSITY, PROFILE_IDS, behavior, findBehavior, parseBehaviors, parseDensity, parseNpcConfig } from './data';
export type { BehaviorProfile, DensityData, Demeanor, NpcConfig, StartPose } from './data';
export type * from './events';
export { NpcSystem } from './npcSystem';
export { isNpcSave } from './save';
export * from './types';
