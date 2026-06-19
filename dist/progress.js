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
/**
 * Atomically advance scalar progress counters. Prisma `{increment}` — the merge
 * happens in the DB, never a read-then-write that two chunks could clobber.
 * Tolerates a missing progress row (logs, never throws) — the status reader
 * reconciles against ground truth regardless.
 */
export async function advanceProgress(args) {
    const prefix = args.logPrefix ?? "[durable-jobs:advanceProgress]";
    const data = {};
    for (const [k, v] of Object.entries(args.increments)) {
        if (typeof v !== "number" || Number.isNaN(v)) {
            console.warn(`${prefix} skipping non-numeric increment for "${k}": ${String(v)}`);
            continue;
        }
        data[k] = { increment: v };
    }
    if (Object.keys(data).length === 0)
        return;
    try {
        await args.progressDelegate.update({ where: args.where, data });
    }
    catch (err) {
        // A missing/absent progress row is expected for ad-hoc ops — log, never throw.
        console.warn(`${prefix} advance skipped for ${JSON.stringify(args.where)} (no progress row?): ${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * Compute a stable 32-bit advisory-lock key from a string anchor (the HH
 * algorithm — byol-progress.ts:213-217). Consumers pass this as `lockKey` to
 * `mergeProgressMap` so two drains of the same anchor serialize.
 */
export function advisoryLockKey(anchor) {
    let key = 0;
    for (let i = 0; i < anchor.length; i++) {
        key = (key * 31 + anchor.charCodeAt(i)) | 0;
    }
    return key;
}
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
export async function mergeProgressMap(args) {
    const prefix = args.logPrefix ?? "[durable-jobs:mergeProgressMap]";
    try {
        // Serializable advisory lock for the txn — two merges of the same key queue.
        await args.tx.$executeRaw `SELECT pg_advisory_xact_lock(${args.lockNamespace}::int, ${args.lockKey}::int)`;
        const current = (await args.read()) ?? {};
        const next = { ...current };
        next[args.mapKey] = args.reducer(current[args.mapKey], args.delta);
        await args.write(next);
    }
    catch (err) {
        // A lost merge self-heals via reconcileStatus (ground-truth reconciliation),
        // so this is non-fatal — log, never throw into the drain.
        console.error(`${prefix} merge failed for mapKey "${args.mapKey}" (will self-heal on reconcile): ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=progress.js.map