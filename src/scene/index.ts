/** Public API of the scene module (Phase 3 design §11). */
export * from './types';
export * from './events';
export * from './save';
export * from './spots';
export * from './indoor';
export { SCENE_CONFIG, parseSceneConfig, type SceneConfig } from './data';
export * from './commands';
export { SceneDirector, verifyContentIds, scriptFor } from './director';
export { compass, fill } from './text';
