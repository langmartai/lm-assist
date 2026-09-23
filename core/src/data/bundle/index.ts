/**
 * Data bundles (export / import) — the public surface. Routes, MCP tools, the web UI's Core
 * API and the scheduled snapshot import from here; `getBundleService()` is the one entry point.
 */

export {
  BundleService, BundleServiceError, bundleErrorCode, getBundleService, _setBundleServiceForTests,
  SECTION_GROUPS, DEFAULT_EXPORT_GROUPS, NEVER_EXPORTED,
  type SectionGroup, type ExportOptions, type ImportOptions, type ApplyOptions, type ExportResult,
  type ImportResult, type TakeoverResult, type Inventory, type InventoryDataset, type BundleSelf,
  type BundleServiceDeps, type CompactSection,
} from './service';
export { fetchFromPeer, type FetchTransport, type FetchResult } from './fetch';
export { createRoster, defaultRoster, isOnline, type PeerRoster, type RosterSnapshot, type RosterDeps } from './roster';
export {
  BundleStore, getBundleStore, _setBundleStoreForTests, defaultBundlesDir, defaultReceivedDir,
  MAX_CHUNK_BYTES, MAX_UPLOAD_CHUNK_B64, DEFAULT_BUNDLE_RETENTION,
  type StoredBundleInfo, type ChunkResult, type UploadChunkInput, type UploadChunkResult, type StoredImportResult,
  type ImportedMeta,
} from './store';
export {
  BundleError, isBundleId, BUNDLE_ID_RE, BUNDLE_EXT,
  type BundleErrorCode, type BundleManifest, type SectionSummary, type BundleSource,
} from './format';
export {
  DATASET_EXPORT_DENY, MISSIONS_RESERVED_IDS, neutralizeMission, classifyForExport, findOrphans,
  type OrphanStore, type DatasetSectionPlan, type RawDataPort, type RegistryPort,
} from './sections/datasets';
export {
  IMPORT_POLICIES, isImportPolicy, PLAN_BUCKETS, SAMPLE_CAP,
  type ImportPolicy, type PlanCounts, type PlanBucket, type SectionPlan,
} from './sections/types';
