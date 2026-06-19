/**
 * @rello-platform/durable-jobs — atomic-claim + chunked-drain (the heart). Spec §4.3.
 *
 * Absorbs the PFP gold-standard durability (Kelly D1 2026-06-19 — MANDATORY CORE,
 * not opt-in):
 *
 *  - PROCESSING crash-recovery: the atomic claim WHERE-clause carries the
 *    `{ status:"PROCESSING", claimedUntil:{ lt: now } }` branch so a runner that
 *    dies mid-batch does not strand rows in PROCESSING forever. The PFP 25k-stuck
 *    -row fix: ~/PathfinderPro/src/trigger/rello-sync-queue-drain.ts:108-120
 *    (claim clause @ :113; CLAIM_TTL_MS @ :48). `resetStaleClaims()` is the
 *    backstop's first step.
 *
 *  - Atomic claim via `updateMany WHERE prev_state`: the only race-free claim;
 *    `claim.count === 0` → another runner won. PFP :126-145; HH
 *    drainPendingByolCommit:149-157.
 *
 *  - Claim-match guard on every terminal write: `updateMany WHERE { id, status:
 *    "PROCESSING" }` so we never clobber a sibling that reclaimed an expired
 *    claim. PFP :146-160.
 *
 *  - Chunked Promise.all off the request path (default 25 = HH COMMIT_CHUNK_SIZE),
 *    per-item error-isolated. HH byol-commit-drain.ts:73,177-207.
 *
 *  - Cross-instance ordering gate (opt-in) → WAITING. HH WAITING_SKIP_TRACE,
 *    byol-action-drain.ts:163-181.
 */
import type { BulkOpDelegate, BulkOpIntent, BulkOpStatus } from "./types.js";
export declare const DEFAULT_CLAIM_TTL_MS: number;
export declare const DEFAULT_CHUNK_SIZE = 25;
export declare const DEFAULT_SCAN_LIMIT = 50;
export interface DrainItemCtx<TIntent extends BulkOpIntent = BulkOpIntent> {
    /** The CLAIMED, already-loaded intent row (incl. the consumer's `TExtra` columns). */
    intent: TIntent;
    chunkIndex: number;
    attempt: number;
}
/** Range descriptor passed to `onChunk` alongside the chunk's outcomes + intent. */
export interface DrainChunkRange {
    start: number;
    size: number;
    failed: number;
}
export interface DrainArgs<TPayload, TItem, TItemResult, TIntent extends BulkOpIntent = BulkOpIntent> {
    delegate: BulkOpDelegate<TIntent>;
    intentId: string;
    /**
     * false = N=1 per-emit mode (no claim; relies on the receiver's
     * idempotencyKey for dedup — the Milo UsageReportDLQ degenerate case).
     * Default true.
     */
    claim?: boolean;
    /** Claim TTL — PROCESSING rows whose claim expired are reclaimable. Default 15 min. */
    claimTtlMs?: number;
    /** Chunk size for the per-item Promise.all loop. Default 25. */
    chunkSize?: number;
    /** Override the transient retry budget for the WHOLE intent (drain-level throw). */
    maxAttempts?: number;
    /** Override the permanent retry budget for the WHOLE intent. */
    maxAttemptsPermanent?: number;
    /** When true → DEAD_LETTER instead of FAILED at exhaustion (must-never-drop). */
    mustNeverDrop?: boolean;
    /**
     * Cross-instance ordering gate (opt-in). Returns true while a prerequisite is
     * unmet; the drain releases the row to WAITING and the backstop re-attempts.
     */
    gate?: (intent: TIntent) => Promise<boolean>;
    /** Pull the work items out of the PERSISTED payload (never the request body). */
    selectItems: (payload: TPayload) => TItem[];
    /**
     * Process ONE item. Throw BulkOpPermanentError (4xx) vs BulkOpTransientError
     * (5xx) to select the counter at the chunk/drain level. Per-item failures are
     * isolated — one throwing item does not abort the chunk; it is collected into
     * the chunk's failure tally and (when fatal to the whole intent) surfaced.
     */
    processItem: (item: TItem, indexInIntent: number, ctx: DrainItemCtx<TIntent>) => Promise<TItemResult>;
    /**
     * After each chunk, with the chunk's successful outcomes — advance progress here.
     *
     * v0.1.1 (ergo-fix 5): the already-CLAIMED `intent` is threaded in as the 3rd
     * arg so a consumer can resolve its progress key (e.g. `intent.batchId`)
     * WITHOUT a second PK read per chunk. The arg is APPENDED — a v0.1.0
     * `(results, range) => …` callback that ignores it stays type-compatible
     * (TS allows a callback with fewer parameters).
     */
    onChunk?: (results: TItemResult[], chunkRange: DrainChunkRange, intent: TIntent) => Promise<void>;
    /**
     * Once on terminal success, with all successful outcomes — finalize.
     *
     * v0.1.1 (ergo-fix 5): the CLAIMED `intent` is threaded in as the 2nd arg so
     * a consumer's finalize (signals, batch status) can read its business columns
     * without an extra read. Appended — a v0.1.0 `(results) => …` stays compatible.
     */
    onComplete?: (results: TItemResult[], intent: TIntent) => Promise<void>;
    /**
     * Audit hook — called synchronously at claim time (the consumer fires its
     * enqueue-time SYSTEM audit / canonical audit signal here; the PACKAGE writes
     * NO audit — Q-Audit-1). Never throws into the drain; a failing onClaim logs.
     */
    onClaim?: (intent: TIntent) => Promise<void>;
    logPrefix?: string;
}
export interface DrainResult {
    status: BulkOpStatus;
    processed: number;
    succeeded: number;
    failed: number;
}
/**
 * Drain ONE intent. Idempotent + safe under event-dispatch + backstop racing.
 * See module header for the invariant map.
 */
export declare function drainBulkOp<TPayload, TItem, TItemResult, TIntent extends BulkOpIntent = BulkOpIntent>(args: DrainArgs<TPayload, TItem, TItemResult, TIntent>): Promise<DrainResult>;
/**
 * Drain ALL claimable rows for a selector (the backstop's inner loop). Count-first
 * idle-skip (Neon HR-2): selects with `take`, returns early on zero candidates
 * BEFORE any write. The consumer supplies `drainOne` (a closure over its own
 * drainBulkOp call with its selectItems/processItem). Spec §4.3.
 */
export declare function drainBulkOpBatch(args: {
    delegate: BulkOpDelegate<BulkOpIntent>;
    /** e.g. { status:{ in:["PENDING","WAITING"] }, createdAt:{ lt: graceCutoff } }. */
    where: Record<string, unknown>;
    scanLimit?: number;
    drainOne: (id: string) => Promise<DrainResult>;
    logPrefix?: string;
}): Promise<{
    candidates: number;
    completed: number;
    waiting: number;
    pending: number;
    failed: number;
    deadLettered: number;
    empty: number;
}>;
/**
 * Reset stale claims (the backstop's MANDATORY first step — Kelly D1 2026-06-19).
 * updateMany WHERE { status:PROCESSING, claimedUntil:{lt:now} } → PENDING. Without
 * this, a dead runner's rows are lost (the PFP 25k-stuck-row class). Idempotent;
 * count-first (returns {recovered:0} when nothing is stale, no further work).
 */
export declare function resetStaleClaims(args: {
    delegate: BulkOpDelegate<BulkOpIntent>;
    staleBeforeMs?: number;
    logPrefix?: string;
}): Promise<{
    recovered: number;
}>;
//# sourceMappingURL=drain.d.ts.map