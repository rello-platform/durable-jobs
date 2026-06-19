/**
 * @rello-platform/durable-jobs — atomic progress advance. Spec §4.4.
 *
 * - `advanceProgress`: scalar-counter advance via Prisma `{increment}` — NEVER
 *   read-then-write (HH advanceCommitProgress byol-progress.ts:83-101).
 * - `mergeProgressMap`: the one shape Prisma can't field-increment (a JSON map).
 *   Serializable advisory-locked read-modify-write (HH mergeActionProgress
 *   byol-progress.ts:203-248, advisory ns 4242). Two chunks/drains serialize on
 *   the lock so neither clobbers the other; reconcileStatus self-heals a lost
 *   merge against ground truth.
 */
import type { BulkOpDelegate, BulkOpIntent } from "./types.js";
/**
 * Atomically advance scalar progress counters. Prisma `{increment}` — the merge
 * happens in the DB, never a read-then-write that two chunks could clobber.
 * Tolerates a missing progress row (logs, never throws) — the status reader
 * reconciles against ground truth regardless.
 */
export declare function advanceProgress(args: {
    /** The consumer's progress-row delegate (e.g. prisma.batchProgress). */
    progressDelegate: Pick<BulkOpDelegate<BulkOpIntent>, "update">;
    where: Record<string, unknown>;
    increments: Record<string, number>;
    logPrefix?: string;
}): Promise<void>;
/**
 * A minimal Prisma transaction-client surface for the advisory-locked merge.
 * The consumer passes a `prisma.$transaction(async (tx) => ...)` client.
 */
export interface ProgressTxClient {
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}
/**
 * Compute a stable 32-bit advisory-lock key from a string anchor (the HH
 * algorithm — byol-progress.ts:213-217). Consumers pass this as `lockKey` to
 * `mergeProgressMap` so two drains of the same anchor serialize.
 */
export declare function advisoryLockKey(anchor: string): number;
/**
 * Atomically merge a delta into a JSON map column. Postgres can't field-increment
 * inside a JSON column, so this does an advisory-locked read-modify-write inside
 * the consumer's transaction. The consumer supplies `read`/`write` closures
 * bound to its own progress row + a stable lock namespace/key. The reducer folds
 * the delta into the existing entry.
 *
 * NB: the consumer MUST run this inside `prisma.$transaction(async (tx) => ...)`
 * and pass that `tx` so the `pg_advisory_xact_lock` is held for the txn's life
 * (xact-scoped locks auto-release on commit/rollback — no leak on crash).
 */
export declare function mergeProgressMap<TEntry>(args: {
    tx: ProgressTxClient;
    lockNamespace: number;
    lockKey: number;
    read: () => Promise<Record<string, TEntry> | null>;
    write: (next: Record<string, TEntry>) => Promise<void>;
    mapKey: string;
    delta: Partial<TEntry>;
    reducer: (prev: TEntry | undefined, delta: Partial<TEntry>) => TEntry;
    logPrefix?: string;
}): Promise<void>;
//# sourceMappingURL=progress.d.ts.map