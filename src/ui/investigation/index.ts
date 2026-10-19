/** Investigation UI (design phase 4 §10.4). */
export {
  CAMERA_FOV_STEP,
  CameraOverlay,
  createCameraState,
  reduceCameraKey,
  type CameraEmit,
  type CameraHandlers,
  type CameraInfo,
  type CameraKeyResult,
  type CameraState,
} from './cameraOverlay';
export {
  CaseFilePanel,
  clampCaseState,
  createCaseFileState,
  reduceCaseKey,
  tabRows,
  type CaseFileEmit,
  type CaseFileHandlers,
  type CaseFileKeyResult,
  type CaseFilePanelState,
} from './caseFilePanel';
export { BRUSH_STEP_S, FingerprintPanel, reduceDustKey, type DustDir, type DustEmit, type DustHandlers } from './fingerprintPanel';
export { MarkerLabels, type MarkerLabel } from './markerLabels';
