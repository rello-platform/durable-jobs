/**
 * @rello-platform/durable-jobs — public surface.
 *
 * Runtime-agnostic durable async-work primitive. The blessed bulk/at-scale shape
 * for the Rello platform: the union of the PathfinderPro `RelloSyncQueue`
 * gold-standard (claim-TTL crash-recovery + coalescing enqueue — MANDATORY CORE,
 * Kelly D1 2026-06-19) and the Harvest Home BYOL reference (EMPTY/DEAD_LETTER
 * terminals + reconciling status). See
 * BUILD-|-WORKSTREAM/PLATFORM-DURABLE-BULK-OPERATION-FRAMEWORK/_SPEC-FEATURE.md §4.
 *
 * The package ships NO concrete Prisma model, NO Trigger.dev task, NO cron, and
 * NO React component at P0 — it provides the logic (claim/drain/progress/DLQ),
 * the contracts (status/health), and the column TEMPLATE. Consumers parameterize
 * every helper with their own `prisma.<model>` delegate + their Trigger.dev tasks.
 */
export type { BulkOpStatus, BulkOpIntent, BulkOpDelegate } from "./types.js";
export { TERMINAL_STATUSES, CLAIMABLE_STATUSES, BULK_OP_STATUSES, isTerminalStatus, isClaimableStatus, } from "./types.js";
export { DURABLE_INTENT_COLUMNS, DURABLE_INTENT_INDEXES, generateIntentModel, } from "./column-template.js";
export { enqueueBulkOp } from "./enqueue.js";
export type { EnqueueArgs, EnqueueResult } from "./enqueue.js";
export { drainBulkOp, drainBulkOpBatch, resetStaleClaims, DEFAULT_CLAIM_TTL_MS, DEFAULT_CHUNK_SIZE, DEFAULT_SCAN_LIMIT, } from "./drain.js";
export type { DrainArgs, DrainResult, DrainItemCtx } from "./drain.js";
export { advanceProgress, mergeProgressMap, advisoryLockKey, } from "./progress.js";
export type { ProgressTxClient } from "./progress.js";
export { reconcileStatus, HEALTH_STATUSES } from "./status.js";
export type { BulkOpStatusResponse, ComponentHealth, HealthStatus, ReconcileStatusArgs, } from "./status.js";
export { BulkOpTransientError, BulkOpPermanentError, classifyFailure, writeDlq, isPermanentError, isUniqueViolation, DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_CAP_MS, } from "./dlq.js";
export type { ClassifyFailureArgs, ClassifyFailureResult, WriteDlqArgs, } from "./dlq.js";
export { dispatchDrain, assertEnvParity } from "./runtime.js";
export type { AssertEnvParityArgs, AssertEnvParityResult } from "./runtime.js";
//# sourceMappingURL=index.d.ts.map