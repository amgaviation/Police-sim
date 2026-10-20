/** Phase 6 backup: AI backup officers on foot, deterministic mistakes and the SWAT team. */
export * from './types';
export { BACKUP_CONFIG, SWAT_CONFIG, parseBackupConfig, parseSwatConfig } from './data';
export { createFsmOutput, initialRole, stepOfficerFsm, type FsmInputs, type FsmOutput, type OfficerFsm } from './fsm';
export { coverSpot, poorCoverSpot, positionQuality, yawToward, type SpotOut } from './geometry';
export { SWAT_SPEAKER, SwatTeam, clearOrder, entryDoor, swatContactOdds, type SwatDeps, type SwatNpcPort, type SwatOdds, type SwatSave } from './swat';
export { BackupSystem, type BackupContext, type BackupDeps, type BackupNpcPort } from './backupSystem';
export { emptyBackupSave, isBackupSave, type BackupOfficerSave, type BackupPostSave, type BackupSave, type PendingCalloutSave } from './save';
export type { BackupCalloutEvent, BackupCustodyEvent, BackupMistakeEvent, BackupSwatEvent } from './events';
