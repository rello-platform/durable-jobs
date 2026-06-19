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
export interface DrainItemCtx {
    intent: BulkOpIntent;
    chunkIndex: number;
    attempt: number;
}
export interface DrainArgs<TPayload, TItem, TItemResult> {
    delegate: BulkOpDelegate<BulkOpIntent>;
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
    gate?: (intent: BulkOpIntent) => Promise<boolean>;
    /** Pull the work items out of the PERSISTED payload (never the request body). */
    selectItems: (payload: TPayload) => TItem[];
    /**
     * Process ONE item. Throw BulkOpPermanentError (4xx) vs BulkOpTransientError
     * (5xx) to select the counter at the chunk/drain level. Per-item failures are
     * isolated — one throwing item does not abort the chunk; it is collected into
     * the chunk's failure tally and (when fatal to the whole intent) surfaced.
     */
    processItem: (item: TItem, indexInIntent: number, ctx: DrainItemCtx) => Promise<TItemResult>;
    /** After each chunk, with the chunk's successful outcomes — advance progress here. */
    onChunk?: (results: TItemResult[], chunkRange: {
        start: number;
        size: number;
        failed: number;
    }) => Promise<void>;
    /** Once on terminal success, with all successful outcomes — finalize. */
    onComplete?: (results: TItemResult[]) => Promise<void>;
    /**
     * Audit hook — called synchronously at claim time (the consumer fires its
     * enqueue-time SYSTEM audit / canonical audit signal here; the PACKAGE writes
     * NO audit — Q-Audit-1). Never throws into the drain; a failing onClaim logs.
     */
    onClaim?: (intent: BulkOpIntent) => Promise<void>;
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
export declare function drainBulkOp<TPayload, TItem, TItemResult>(args: DrainArgs<TPayload, TItem, TItemResult>): Promise<DrainResult>;
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