/** Contact module (design §10): conversations, field actions, statements and discovered facts. */
export { ContactManager } from './contactManager';
export { isContactSave, emptyContactSave } from './save';
export {
  CONTACT_ACTIONS,
  type ContactActionId,
  type ContactDeps,
  type ContactRequest,
  type ContactSave,
  type ContactSaveEntry,
  type ContactTarget,
  type IncidentInfo,
  type IncidentResolver,
  type Presence,
} from './types';
export { ACTION_LABELS, FACT_LABELS } from './presenter';
export type * from './events';
