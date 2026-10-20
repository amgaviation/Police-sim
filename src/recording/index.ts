/** Recording media layer (design phase 5 §8): snapshot store, capture scheduling and the review timeline. */
export { RECORDING, parseRecordingConfig, retentionOf, type RecordingConfig } from './data';
export {
  IdbMediaStore,
  MEDIA_DB_NAME,
  MEDIA_DB_VERSION,
  MEDIA_STORE_NAME,
  MemoryMediaStore,
  createMediaStore,
  planPrune,
  snapshotKey,
  type MediaStore,
  type RetentionPolicy,
  type SnapshotMeta,
} from './mediaStore';
export { CAM_BITS, SnapshotScheduler, captureSnapshot } from './capture';
export {
  REVIEW_SHIFT_FACTOR,
  REVIEW_STEP_S,
  camSegments,
  camStateOf,
  createReviewState,
  eventIndexAt,
  formatReviewTime,
  frameAt,
  nearestSnapshot,
  reduceReviewKey,
  type CamSegment,
  type CamState,
  type ReviewEmit,
  type ReviewEvent,
  type ReviewFooter,
  type ReviewKeyResult,
  type ReviewRange,
  type ReviewSource,
  type ReviewState,
} from './timeline';
