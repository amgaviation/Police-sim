/** Public API of the radio module (design §9.7). */
export * from './types';
export {
  AMBIENT,
  PHONETIC,
  PHRASES,
  PHRASE_KINDS,
  RADIO_CONFIG,
  REQUEST_CHANNEL,
  VOICE_COMMANDS,
  channelDef,
  isChannelId,
  validateAmbient,
  validateChannels,
  validateCommands,
  validatePhonetic,
  validatePhrases,
  type AmbientChannel,
  type ChannelDef,
  type CommandTable,
  type PhoneticTable,
  type PhraseKind,
  type PhraseTable,
  type RadioConfig,
} from './data';
export type * from './events';
export { toSpoken, numberWords, wordCount } from './spoken';
export { parseVoiceCommand, normalizeUtterance, type VoiceContext } from './grammar';
export { RadioMenu, type MenuContext, type MenuView, type MenuOption, type MenuLevel } from './menu';
export { RadioNet, QUEUE_CAP, type NewTransmission } from './net';
export { RadioSystem, type RadioDeps } from './radioSystem';
export { defaultRadioSave, isRadioSave, type RadioSave } from './save';
export type { ComposerSave, PendingAnswer } from './compose';
export { RadioPlayer, type RadioPlayerDeps, type RadioFxLike, type SpeechOutLike } from './player';
export {
  RadioController,
  EMERGENCY_HOLD_S,
  HINTS,
  type RadioControllerState,
  type RadioControllerContext,
  type RadioControllerDeps,
  type RadioInput,
  type SpeechInLike,
} from './controller';
export { createRadioCommands, formatTransmission, type RadioCommandDeps } from './commands';
