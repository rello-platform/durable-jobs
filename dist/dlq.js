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
export class BulkOpTransientError extends Error {
    name = "BulkOpTransientError";
    constructor(message, options) {
        super(message, options);
        // Restore prototype chain for instanceof across transpile targets.
        Object.setPrototypeOf(this, BulkOpTransientError.prototype);
    }
}
/** PERMANENT failure (4xx / bad payload) — counts against `attemptsPermanent`, smaller budget. */
export class BulkOpPermanentError extends Error {
    name = "BulkOpPermanentError";
    constructor(message, options) {
        super(message, options);
        Object.setPrototypeOf(this, BulkOpPermanentError.prototype);
    }
}
/** Default exponential-backoff ceiling (PFP: 8 min). */
export const DEFAULT_BACKOFF_CAP_MS = 480_000;
/** Default exponential-backoff base (PFP: 30s for the first retry). */
export const DEFAULT_BACKOFF_BASE_MS = 30_000;
/**
 * Duck-type a permanent (4xx) failure from an arbitrary thrown error — mirrors
 * the PFP `is400()` helper so a consumer that throws an api-client error with a
 * `statusCode` (rather than our typed error) still classifies correctly.
 * (PFP: rello-sync-queue-drain.ts is400 :74-82.)
 */
export function isPermanentError(err) {
    if (err instanceof BulkOpPermanentError)
        return true;
    if (err && typeof err === "object") {
        const e = err;
        const code = e.statusCode ?? e.status;
        if (typeof code === "number" && code >= 400 && code < 500)
            return true;
    }
    return false;
}
/** True iff this looks like a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(err) {
    return (!!err &&
        typeof err === "object" &&
        err.code === "P2002");
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
export function classifyFailure(args) {
    const permanent = isPermanentError(args.err);
    const counter = permanent ? "attemptsPermanent" : "attempts";
    const nextCount = permanent
        ? args.attemptsPermanent + 1
        : args.attempts + 1;
    const max = permanent ? args.maxAttemptsPermanent : args.maxAttempts;
    const exhausted = nextCount >= max;
    const base = args.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const cap = args.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    // Backoff keyed to the TRANSIENT attempt count when transient, else the
    // permanent count — both produce the same min(base·2^(n-1), cap) curve.
    const backoffMs = Math.min(base * Math.pow(2, Math.max(0, nextCount - 1)), cap);
    if (!exhausted) {
        return { disposition: "RELEASE", counter, nextCount, backoffMs };
    }
    return {
        disposition: args.mustNeverDrop ? "DEAD_LETTER" : "FAILED",
        counter,
        nextCount,
        backoffMs,
    };
}
/**
 * Write a DLQ row. P2002-tolerant (an already-dead-lettered anchor is a no-op,
 * never a 500). NEVER an empty catch — a non-P2002 failure logs with reason +
 * tenant (an un-recorded dead-letter is the worst silent loss).
 */
export async function writeDlq(args) {
    const prefix = args.logPrefix ?? "[durable-jobs:writeDlq]";
    try {
        await args.dlqDelegate.create({
            data: {
                tenantId: args.tenantId,
                reason: args.reason,
                attempts: args.attempts,
                ...(args.extra ?? {}),
            },
        });
    }
    catch (err) {
        if (isUniqueViolation(err)) {
            // Already dead-lettered for this anchor — deduped, safe no-op.
            return;
        }
        // LOGGED catch — never silent. The row failed to record; operators must know.
        console.error(`${prefix} CRITICAL: failed to write DLQ row for tenant ${args.tenantId} (reason: ${args.reason}): ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=dlq.js.map