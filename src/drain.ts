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
import { classifyFailure, isPermanentError } from "./dlq.js";

export const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 min (PFP canonical).
export const DEFAULT_CHUNK_SIZE = 25; // HH COMMIT_CHUNK_SIZE.
export const DEFAULT_SCAN_LIMIT = 50; // HH SCAN_LIMIT / PFP BATCH_SIZE.

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
  processItem: (
    item: TItem,
    indexInIntent: number,
    ctx: DrainItemCtx,
  ) => Promise<TItemResult>;
  /** After each chunk, with the chunk's successful outcomes — advance progress here. */
  onChunk?: (
    results: TItemResult[],
    chunkRange: { start: number; size: number; failed: number },
  ) => Promise<void>;
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
export async function drainBulkOp<TPayload, TItem, TItemResult>(
  args: DrainArgs<TPayload, TItem, TItemResult>,
): Promise<DrainResult> {
  const prefix = args.logPrefix ?? "[durable-jobs:drain]";
  const claim = args.claim ?? true;
  const ttl = args.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const chunkSize = Math.max(1, args.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const now = new Date();
  const claimedUntil = new Date(now.getTime() + ttl);

  // ── 1. ATOMIC CLAIM ────────────────────────────────────────────────────
  // updateMany WHERE prev_state is the only race-free claim. Claims:
  //   A. claimable (PENDING/WAITING/FAILED) whose nextRetryAt has elapsed
  //   B. PROCESSING rows with an expired claim (crash recovery — PFP :108-120)
  let claimedRow: BulkOpIntent | null;
  if (claim) {
    const claimRes = await args.delegate.updateMany({
      where: {
        id: args.intentId,
        OR: [
          {
            status: { in: ["PENDING", "WAITING", "FAILED"] },
            nextRetryAt: { lte: now },
          },
          { status: "PROCESSING", claimedUntil: { lt: now } },
        ],
      },
      data: {
        status: "PROCESSING",
        claimedUntil,
        attempts: { increment: 1 },
      },
    });
    if (claimRes.count === 0) {
      // Another runner won, or the row is terminal / not yet due.
      const row = await args.delegate.findUnique({ where: { id: args.intentId } });
      return {
        status: (row?.status as BulkOpStatus) ?? "PENDING",
        processed: 0,
        succeeded: 0,
        failed: 0,
      };
    }
    claimedRow = await args.delegate.findUnique({ where: { id: args.intentId } });
  } else {
    // N=1 per-emit mode: no claim. Read the row directly.
    claimedRow = await args.delegate.findUnique({ where: { id: args.intentId } });
  }

  if (!claimedRow) {
    return { status: "PENDING", processed: 0, succeeded: 0, failed: 0 };
  }
  const intent = claimedRow;

  // ── 1b. AUDIT HOOK (consumer-owned; package writes no audit) ────────────
  if (args.onClaim) {
    try {
      await args.onClaim(intent);
    } catch (err) {
      console.error(
        `${prefix} onClaim hook threw for intent ${intent.id} (audit not blocked): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ── 2. GATE CHECK → release to WAITING if unmet ─────────────────────────
  if (args.gate) {
    let unmet = false;
    try {
      unmet = await args.gate(intent);
    } catch (err) {
      // A gate failure is transient — release to WAITING for a later attempt.
      console.error(
        `${prefix} gate threw for intent ${intent.id}; releasing to WAITING: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      unmet = true;
    }
    if (unmet) {
      if (claim) {
        await args.delegate.updateMany({
          where: { id: intent.id, status: "PROCESSING" }, // claim-match guard
          data: { status: "WAITING", claimedUntil: null },
        });
      }
      return { status: "WAITING", processed: 0, succeeded: 0, failed: 0 };
    }
  }

  // ── 3. SELECT ITEMS → EMPTY terminal if none ────────────────────────────
  let items: TItem[];
  try {
    items = args.selectItems(intent.payload as TPayload) ?? [];
  } catch (err) {
    // A payload we can't even parse is a permanent error — fail/dead-letter it.
    return finalizeFailure({
      args,
      intent,
      err: err instanceof Error ? err : new Error(String(err)),
      claim,
      processed: 0,
      succeeded: 0,
      failed: 0,
      prefix,
    });
  }

  if (items.length === 0) {
    if (claim) {
      await args.delegate.updateMany({
        where: { id: intent.id, status: "PROCESSING" },
        data: { status: "EMPTY", claimedUntil: null, completedAt: new Date() },
      });
    }
    return { status: "EMPTY", processed: 0, succeeded: 0, failed: 0 };
  }

  // ── 4. CHUNKED Promise.all over items, per-item error-isolated ──────────
  const allResults: TItemResult[] = [];
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let fatalError: unknown = null;

  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    const settled = await Promise.allSettled(
      chunk.map((item, i) =>
        args.processItem(item, start + i, {
          intent,
          chunkIndex: Math.floor(start / chunkSize),
          attempt: intent.attempts,
        }),
      ),
    );

    const chunkResults: TItemResult[] = [];
    let chunkFailed = 0;
    for (const s of settled) {
      processed++;
      if (s.status === "fulfilled") {
        succeeded++;
        chunkResults.push(s.value);
        allResults.push(s.value);
      } else {
        failed++;
        chunkFailed++;
        // First fatal (permanent) error escalates the whole intent; transient
        // per-item failures are tolerated (the item retries on the next drain
        // via the consumer's own per-row idempotency / dedup).
        if (fatalError === null && isPermanentError(s.reason)) {
          fatalError = s.reason;
        } else if (fatalError === null) {
          // keep the first transient too, in case ALL items fail (whole-intent retry)
          fatalError = s.reason;
        }
      }
    }

    if (args.onChunk) {
      try {
        await args.onChunk(chunkResults, {
          start,
          size: chunk.length,
          failed: chunkFailed,
        });
      } catch (err) {
        // Progress advance failing is non-fatal — reconcileStatus self-heals
        // counters against ground truth. Log, never abort the drain.
        console.error(
          `${prefix} onChunk hook threw for intent ${intent.id} (progress will self-heal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // ── 5. TERMINAL DISPOSITION ─────────────────────────────────────────────
  // If EVERY item failed, the whole intent failed → run the DLQ ladder so it
  // retries / dead-letters. If SOME succeeded, the intent is COMPLETED (the
  // failed items are the consumer's row-level DLQ concern, captured in
  // processItem); partial success is success at the intent level.
  if (succeeded === 0 && failed > 0 && fatalError !== null) {
    return finalizeFailure({
      args,
      intent,
      err: fatalError,
      claim,
      processed,
      succeeded,
      failed,
      prefix,
    });
  }

  if (args.onComplete) {
    try {
      await args.onComplete(allResults);
    } catch (err) {
      // onComplete is the consumer's finalize (signals, batch status). If it
      // throws, treat as a transient whole-intent failure so the backstop
      // re-runs it (idempotent finalize expected).
      return finalizeFailure({
        args,
        intent,
        err,
        claim,
        processed,
        succeeded,
        failed,
        prefix,
      });
    }
  }

  if (claim) {
    await args.delegate.updateMany({
      where: { id: intent.id, status: "PROCESSING" }, // claim-match guard
      data: {
        status: "COMPLETED",
        claimedUntil: null,
        lastError: null,
        completedAt: new Date(),
      },
    });
  }
  return { status: "COMPLETED", processed, succeeded, failed };
}

/** Shared failure-ladder writer for drainBulkOp (transient → RELEASE, exhausted → FAILED/DEAD_LETTER). */
async function finalizeFailure<TPayload, TItem, TItemResult>(p: {
  args: DrainArgs<TPayload, TItem, TItemResult>;
  intent: BulkOpIntent;
  err: unknown;
  claim: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  prefix: string;
}): Promise<DrainResult> {
  const { args, intent, err, claim, processed, succeeded, failed, prefix } = p;
  const message = err instanceof Error ? err.message : String(err);

  const decision = classifyFailure({
    err,
    // `attempts` was already incremented by the atomic claim; classifyFailure
    // increments again to model "this failure". To avoid double-count we pass
    // the post-claim attempts and treat its nextCount as authoritative.
    attempts: intent.attempts - (claim ? 1 : 0),
    attemptsPermanent: intent.attemptsPermanent,
    maxAttempts: args.maxAttempts ?? intent.maxAttempts,
    maxAttemptsPermanent:
      args.maxAttemptsPermanent ?? intent.maxAttemptsPermanent,
    mustNeverDrop: args.mustNeverDrop,
  });

  if (!claim) {
    // N=1 mode: no status machine to write back; surface the disposition.
    return {
      status: decision.disposition === "RELEASE" ? "PENDING" : decision.disposition,
      processed,
      succeeded,
      failed,
    };
  }

  if (decision.disposition === "RELEASE") {
    const nextRetryAt = new Date(Date.now() + decision.backoffMs);
    await args.delegate.updateMany({
      where: { id: intent.id, status: "PROCESSING" }, // claim-match guard
      data: {
        status: "PENDING",
        lastError: message.slice(0, 500),
        nextRetryAt,
        claimedUntil: null,
        ...(decision.counter === "attemptsPermanent"
          ? { attemptsPermanent: decision.nextCount }
          : {}),
      },
    });
    return { status: "PENDING", processed, succeeded, failed };
  }

  // FAILED or DEAD_LETTER (exhausted).
  await args.delegate.updateMany({
    where: { id: intent.id, status: "PROCESSING" }, // claim-match guard
    data: {
      status: decision.disposition,
      lastError: message.slice(0, 500),
      claimedUntil: null,
      nextRetryAt: new Date(),
      completedAt: new Date(),
      ...(decision.counter === "attemptsPermanent"
        ? { attemptsPermanent: decision.nextCount }
        : {}),
    },
  });
  const verb = decision.disposition === "DEAD_LETTER" ? "dead-lettered" : "failed";
  console.warn(
    `${prefix} ${verb} intent ${intent.id} after exhaustion (${decision.counter}=${decision.nextCount}): ${message.slice(0, 200)}`,
  );
  return { status: decision.disposition, processed, succeeded, failed };
}

/**
 * Drain ALL claimable rows for a selector (the backstop's inner loop). Count-first
 * idle-skip (Neon HR-2): selects with `take`, returns early on zero candidates
 * BEFORE any write. The consumer supplies `drainOne` (a closure over its own
 * drainBulkOp call with its selectItems/processItem). Spec §4.3.
 */
export async function drainBulkOpBatch(args: {
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
}> {
  const prefix = args.logPrefix ?? "[durable-jobs:drainBatch]";
  const take = args.scanLimit ?? DEFAULT_SCAN_LIMIT;

  const candidates = await args.delegate.findMany({
    where: args.where,
    orderBy: { createdAt: "asc" },
    take,
    select: { id: true },
  });

  const tally = {
    candidates: candidates.length,
    completed: 0,
    waiting: 0,
    pending: 0,
    failed: 0,
    deadLettered: 0,
    empty: 0,
  };
  if (candidates.length === 0) return tally; // count-first idle skip

  for (const c of candidates) {
    try {
      const res = await args.drainOne(c.id);
      switch (res.status) {
        case "COMPLETED":
          tally.completed++;
          break;
        case "WAITING":
          tally.waiting++;
          break;
        case "FAILED":
          tally.failed++;
          break;
        case "DEAD_LETTER":
          tally.deadLettered++;
          break;
        case "EMPTY":
          tally.empty++;
          break;
        default:
          tally.pending++;
      }
    } catch (err) {
      tally.pending++;
      console.error(
        `${prefix} drainOne threw for intent ${c.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return tally;
}

/**
 * Reset stale claims (the backstop's MANDATORY first step — Kelly D1 2026-06-19).
 * updateMany WHERE { status:PROCESSING, claimedUntil:{lt:now} } → PENDING. Without
 * this, a dead runner's rows are lost (the PFP 25k-stuck-row class). Idempotent;
 * count-first (returns {recovered:0} when nothing is stale, no further work).
 */
export async function resetStaleClaims(args: {
  delegate: BulkOpDelegate<BulkOpIntent>;
  staleBeforeMs?: number;
  logPrefix?: string;
}): Promise<{ recovered: number }> {
  const prefix = args.logPrefix ?? "[durable-jobs:resetStaleClaims]";
  const now = new Date();
  // claimedUntil already encodes now+ttl; a claimedUntil in the PAST means the
  // claim expired. staleBeforeMs (default 0) lets a consumer add extra grace.
  const cutoff = new Date(now.getTime() - (args.staleBeforeMs ?? 0));
  const res = await args.delegate.updateMany({
    where: { status: "PROCESSING", claimedUntil: { lt: cutoff } },
    data: {
      status: "PENDING",
      claimedUntil: null,
      lastError: "reset from stale PROCESSING (claim TTL expired — runner crash recovery)",
    },
  });
  if (res.count > 0) {
    console.warn(`${prefix} recovered ${res.count} stale PROCESSING row(s).`);
  }
  return { recovered: res.count };
}
