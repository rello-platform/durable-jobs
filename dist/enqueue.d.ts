/**
 * @rello-platform/durable-jobs — idempotent + coalescing enqueue.
 *
 * Persist a durable intent and return immediately. NEVER does the work. Spec §4.2.
 *
 * Idempotent on the consumer-chosen `@unique` anchor:
 *   - existing non-terminal row  → { enqueued:false, alreadyInFlight:true }
 *   - existing terminal-FAILED row → recycled via upsert (counters reset, status→PENDING)
 *   - coalesceOn match (PENDING|PROCESSING) → { enqueued:false, alreadyInFlight:true } w/o insert
 *
 * Coalescing (MANDATORY CORE, Kelly D1 2026-06-19) — the PFP 280k-row-explosion fix:
 *   ~/PathfinderPro/src/lib/rello-sync-queue.ts:82-106 (findFirst coalesce check +
 *   skip-insert; "~280k rows / 70k stuck PROCESSING" @ :89). An existing
 *   PENDING|PROCESSING row matching the coalesce key already covers the work →
 *   skip the insert; the in-flight row re-reads latest state at drain time.
 */
import type { BulkOpDelegate, BulkOpIntent } from "./types.js";
export interface EnqueueArgs<TPayload> {
    delegate: BulkOpDelegate<BulkOpIntent>;
    /**
     * The @unique business-key WHERE clause that makes enqueue idempotent
     * (e.g. { batchId } or { batchId_actionId: { batchId, actionId } }).
     * Used as both the findUnique lookup and the upsert `where`.
     */
    anchor: Record<string, unknown>;
    tenantId: string;
    payload: TPayload;
    /**
     * Required when claim:false (Milo N=1 per-emit mode — the receiver's
     * idempotencyKey unique is the dedup). Optional otherwise.
     */
    idempotencyKey?: string;
    /** Extra business columns to set on create/recycle (e.g. { agentId, uploadType }). */
    extra?: Record<string, unknown>;
    /** Override the transient retry budget (default 5). */
    maxAttempts?: number;
    /** Override the permanent (4xx) retry budget (default 3). */
    maxAttemptsPermanent?: number;
    /**
     * Coalescing key (MANDATORY CORE primitive). When set, an existing
     * PENDING|PROCESSING row matching this WHERE is treated as "already covers
     * this work" → returns { alreadyInFlight:true } without insert. Use for
     * idempotent whole-entity syncs whose drain re-reads latest state.
     */
    coalesceOn?: Record<string, unknown>;
    /**
     * Soft ceiling on payload item count above which the consumer SHOULD
     * chunk-enqueue N intents (Q-Scale-1). When `payloadItemCount` exceeds this,
     * enqueue logs a loud warning (does not throw — the consumer owns the split).
     * Default 10_000.
     */
    itemCeiling?: number;
    /** Optional reported count of items in the payload (drives the oversize warning). */
    payloadItemCount?: number;
    logPrefix?: string;
}
export interface EnqueueResult {
    enqueued: boolean;
    intentId?: string;
    /** true when an in-flight (or coalesced) row already exists — idempotent re-enqueue. */
    alreadyInFlight: boolean;
}
/**
 * Persist a durable intent and return immediately. Idempotent on `anchor` +
 * coalescing on `coalesceOn`. NEVER does the work; NEVER throws on the happy
 * path (wraps its writes; a true infra failure rethrows so the caller's route
 * try/catch returns 500 — losing an enqueue silently is worse than a 500).
 */
export declare function enqueueBulkOp<TPayload>(args: EnqueueArgs<TPayload>): Promise<EnqueueResult>;
//# sourceMappingURL=enqueue.d.ts.map