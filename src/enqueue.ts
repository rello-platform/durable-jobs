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
import { isUniqueViolation } from "./dlq.js";

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

const DEFAULT_ITEM_CEILING = 10_000;

/**
 * Persist a durable intent and return immediately. Idempotent on `anchor` +
 * coalescing on `coalesceOn`. NEVER does the work; NEVER throws on the happy
 * path (wraps its writes; a true infra failure rethrows so the caller's route
 * try/catch returns 500 — losing an enqueue silently is worse than a 500).
 */
export async function enqueueBulkOp<TPayload>(
  args: EnqueueArgs<TPayload>,
): Promise<EnqueueResult> {
  const prefix = args.logPrefix ?? "[durable-jobs:enqueue]";
  const ceiling = args.itemCeiling ?? DEFAULT_ITEM_CEILING;

  if (!args.tenantId) {
    throw new Error(`${prefix} tenantId is required (tenant isolation).`);
  }

  if (
    typeof args.payloadItemCount === "number" &&
    args.payloadItemCount > ceiling
  ) {
    console.warn(
      `${prefix} oversize payload: ${args.payloadItemCount} items > ceiling ${ceiling}. ` +
        `Chunk-enqueue N intents (each its own anchor) so a single Json column stays bounded; ` +
        `coalescing + drainBulkOpBatch handle the fan-out (Q-Scale-1).`,
    );
  }

  // 1) COALESCE — an existing PENDING|PROCESSING row matching coalesceOn covers
  //    this work. Skip the insert (PFP 280k-explosion fix).
  if (args.coalesceOn) {
    const existing = await args.delegate.findFirst({
      where: {
        tenantId: args.tenantId,
        status: { in: ["PENDING", "PROCESSING"] },
        ...args.coalesceOn,
      },
      select: { id: true },
    });
    if (existing) {
      return { enqueued: false, alreadyInFlight: true, intentId: existing.id };
    }
  }

  // 2) Look up the anchor. In-flight (non-terminal, non-FAILED) → idempotent no-op.
  //    Terminal-FAILED → recycle. Absent → create.
  const current = await args.delegate.findUnique({ where: args.anchor });

  if (current) {
    const status = current.status;
    if (status === "DEAD_LETTER") {
      // Must-never-drop row already exhausted — do NOT silently recycle; surface it.
      return { enqueued: false, alreadyInFlight: true, intentId: current.id };
    }
    if (status === "COMPLETED" || status === "EMPTY") {
      // Already done for this anchor — idempotent no-op.
      return { enqueued: false, alreadyInFlight: true, intentId: current.id };
    }
    if (status === "PENDING" || status === "PROCESSING" || status === "WAITING") {
      // In flight — idempotent re-enqueue.
      return { enqueued: false, alreadyInFlight: true, intentId: current.id };
    }
    // status === "FAILED" → recycle: reset counters + payload, back to PENDING.
  }

  const createData: Record<string, unknown> = {
    tenantId: args.tenantId,
    status: "PENDING",
    payload: args.payload as unknown,
    idempotencyKey: args.idempotencyKey ?? null,
    attempts: 0,
    attemptsPermanent: 0,
    lastError: null,
    nextRetryAt: new Date(),
    claimedUntil: null,
    completedAt: null,
    ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
    ...(args.maxAttemptsPermanent !== undefined
      ? { maxAttemptsPermanent: args.maxAttemptsPermanent }
      : {}),
    ...(args.extra ?? {}),
  };

  // Recycle-on-FAILED resets the same mutable columns; the anchor row is reused.
  const recycleData: Record<string, unknown> = {
    status: "PENDING",
    payload: args.payload as unknown,
    idempotencyKey: args.idempotencyKey ?? null,
    attempts: 0,
    attemptsPermanent: 0,
    lastError: null,
    nextRetryAt: new Date(),
    claimedUntil: null,
    completedAt: null,
    ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
    ...(args.maxAttemptsPermanent !== undefined
      ? { maxAttemptsPermanent: args.maxAttemptsPermanent }
      : {}),
    ...(args.extra ?? {}),
  };

  try {
    const row = await args.delegate.upsert({
      where: args.anchor,
      create: createData,
      update: recycleData,
    });
    // enqueued:true on a fresh create OR a recycled-FAILED row (both produce work).
    // alreadyInFlight reflects whether the anchor pre-existed (recycle).
    return {
      enqueued: true,
      intentId: row.id,
      alreadyInFlight: !!current,
    };
  } catch (err) {
    // A concurrent enqueue won the @unique race (P2002) — treat as in-flight.
    if (isUniqueViolation(err)) {
      const won = await args.delegate.findUnique({ where: args.anchor });
      return {
        enqueued: false,
        alreadyInFlight: true,
        intentId: won?.id,
      };
    }
    // Real infra failure — rethrow so the route try/catch returns 500. Losing an
    // enqueue silently (the very bug class this package kills) is unacceptable.
    console.error(
      `${prefix} CRITICAL: enqueue write failed for tenant ${args.tenantId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw err;
  }
}
