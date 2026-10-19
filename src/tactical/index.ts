/** Tactical module: sound model, stance, slicing, exposure, partner and the runtime system (design §7). */
export { TACTICS, validateTactics, type TacticsConfig } from './data';
export type { TacticalSoundEvent, TacticalStanceEvent, TacticalFlashlightEvent, TacticalPartnerEvent } from './events';
export { bodyPoints, exposure } from './exposure';
export { PartnerOfficer, PARTNER_MODES, isPartnerMode, type PartnerCommand, type PartnerHooks, type PartnerMode, type PartnerSave } from './partner';
export { defaultTacticalSave, isTacticalSave, type PendingSoundSave, type TacticalSave } from './save';
export { createSliceDoor, pickSliceDoor, sliceStep, type SliceDoor } from './slice';
export {
  SOUND_KINDS,
  buildSoundGraph,
  doorAttenuation,
  footstepLevel,
  hearingThreshold,
  receivedLevel,
  sourceLevel,
  stimulus,
  type SoundGraph,
  type SoundKind,
} from './sound';
export { createStance, eyeOffset, speedFactor, stepLean, type StanceState } from './stance';
export { TacticalSystem, type TacticalDeps } from './tacticalSystem';
export { createListener, type DoorStateName, type InteriorQuery, type Listener, type ListenerPort, type OfficerPose, type TacticalRequest } from './types';
