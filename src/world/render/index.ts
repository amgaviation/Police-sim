/** Public API of the city renderer (main thread). The worker entry is `chunk.worker.ts`. */
export {
  CHUNK_GROUP_NAMES,
  WINDOW_CELLS,
  WINDOW_TEXTURE_SIZE,
  WINDOW_TILE_U,
  WINDOW_TILE_V,
  buildChunkMesh,
  chunkMeshTransferables,
  lampHeadPosition,
  type ChunkGroupName,
  type ChunkMeshData,
  type ChunkMeshGroup,
} from './chunkMesher';
export { validateBuildRequest, validateInitRequest, type ChunkWorkerMap } from './chunkProtocol';
export { ChunkWorkerHost, type ChunkWorkerReply } from './chunkWorkerHost';
export { createChunkWorker } from './createChunkWorker';
export { CityMaterials } from './cityMaterials';
export {
  ChunkStreamer,
  LOAD_MARGIN,
  LOD0_FAR,
  LOD0_NEAR,
  UNLOAD_MARGIN,
  chunkDistance,
  desiredChunks,
  type ChunkLod,
  type ChunkStreamerOptions,
  type ChunkStreamerStats,
} from './chunkStreamer';
export { SIGNAL_HEAD_PARTS, SIGNAL_LIT, SIGNAL_PART, SIGNAL_UNLIT, SignalHeads } from './signalHeads';
export { StreetlightPool } from './streetlightPool';
