/**
 * @rello-platform/durable-jobs — DLQ ladder + typed errors.
 *
 * The PFP 400-vs-5xx split (separate budgets) + the HH DEAD_LETTER terminal,
 * unified. Spec §4.5.
 *
 * - `BulkOpTransientError` → counts against `attempts` (full budget, retries).
 * - `BulkOpPermanentError` → counts against `attemptsPermanent` (smaller budget).
 * - `classifyFailure` computes the terminal disposition + backoff.
 * - `writeDlq` writes a DLQ row, P2002-tolerant (dedup), never an empty catch.
 *
 * PFP grounding (file:line @ 9203465):
 *   400-vs-5xx split + EITHER-counter-exhaust dead-letter:
 *     ~/PathfinderPro/src/trigger/rello-sync-queue-drain.ts:160-205
 *   exp-backoff min(30s·2^(n-1), 480s): same file :179-180.
 */
/** TRANSIENT failure (5xx / network / timeout) — counts against `attempts`, retries. */
export declare class BulkOpTransientError extends Error {
    readonly name = "BulkOpTransientError";
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** PERMANENT failure (4xx / bad payload) — counts against `attemptsPermanent`, smaller budget. */
export declare class BulkOpPermanentError extends Error {
    readonly name = "BulkOpPermanentError";
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** Default exponential-backoff ceiling (PFP: 8 min). */
export declare const DEFAULT_BACKOFF_CAP_MS = 480000;
/** Default exponential-backoff base (PFP: 30s for the first retry). */
export declare const DEFAULT_BACKOFF_BASE_MS = 30000;
/**
 * Duck-type a permanent (4xx) failure from an arbitrary thrown error — mirrors
 * the PFP `is400()` helper so a consumer that throws an api-client error with a
 * `statusCode` (rather than our typed error) still classifies correctly.
 * (PFP: rello-sync-queue-drain.ts is400 :74-82.)
 */
export declare function isPermanentError(err: unknown): boolean;
/** True iff this looks like a Prisma unique-constraint violation (P2002). */
export declare function isUniqueViolation(err: unknown): boolean;
export interface ClassifyFailureArgs {
    err: unknown;
    attempts: number;
    attemptsPermanent: number;
    maxAttempts: number;
    maxAttemptsPermanent: number;
    /** true → DEAD_LETTER instead of FAILED at exhaustion (the HH HOT-lead must-never-drop rule). */
    mustNeverDrop?: boolean;
    backoffBaseMs?: number;
    backoffCapMs?: number;
}
export interface ClassifyFailureResult {
    disposition: "RELEASE" | "FAILED" | "DEAD_LETTER";
    /** which counter this failure incremented. */
    counter: "attempts" | "attemptsPermanent";
    /** the post-increment value of the chosen counter (consumer writes this back). */
    nextCount: number;
    /** ms to wait before the next retry (only meaningful when disposition === RELEASE). */
    backoffMs: number;
}
/**
 * Compute the terminal disposition from the error + counters (the reference
 * MAX_ATTEMPTS ladder, PFP-split). Pure — no I/O. The caller writes the result
 * back atomically (claim-match guarded `updateMany`).
 *
 * Dead-letters when EITHER counter exhausts its budget (PFP `isDead`). A
 * permanent error burns the smaller `attemptsPermanent` budget so an
 * un-fixable payload dies fast instead of consuming 5 transient retries.
 */
export declare function classifyFailure(args: ClassifyFailureArgs): ClassifyFailureResult;
export interface WriteDlqArgs {
    /** The consumer's DLQ row delegate (its FailedXBatch model). */
    dlqDelegate: Pick<import("./types.js").BulkOpDelegate<unknown>, "create">;
    tenantId: string;
    reason: string;
    attempts: number;
    /** Extra DLQ columns (e.g. { queueId } for FailedTracerfyBatch). */
    extra?: Record<string, unknown>;
    /** Optional structured logger; defaults to console.error. */
    logPrefix?: string;
}
/**
 * Write a DLQ row. P2002-tolerant (an already-dead-lettered anchor is a no-op,
 * never a 500). NEVER an empty catch — a non-P2002 failure logs with reason +
 * tenant (an un-recorded dead-letter is the worst silent loss).
 */
export declare function writeDlq(args: WriteDlqArgs): Promise<void>;
//# sourceMappingURL=dlq.d.ts.map