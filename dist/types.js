/**
 * @rello-platform/durable-jobs — core intent contract.
 *
 * Runtime-agnostic types the helpers operate over. The package ships NO concrete
 * Prisma model and NO `@@schema` — it provides the column TEMPLATE (see
 * `column-template.ts`) and the structural `BulkOpIntent` shape a consumer's
 * Prisma row is assignable to, plus a `BulkOpDelegate` the consumer parameterizes
 * with `prisma.<model>`.
 *
 * Spec: PLATFORM-DURABLE-BULK-OPERATION-FRAMEWORK/_SPEC-FEATURE.md §4.1.
 */
/** Terminal statuses — a drain never re-claims these (except FAILED, see CLAIMABLE). */
export const TERMINAL_STATUSES = [
    "COMPLETED",
    "EMPTY",
    "FAILED",
    "DEAD_LETTER",
];
/**
 * Claimable statuses — the atomic claim's WHERE clause selects these.
 * FAILED is recyclable per the HH reference (a transient-exhausted row can be
 * re-enqueued / re-driven by the backstop); DEAD_LETTER is NOT recyclable.
 * PROCESSING is reclaimed separately via the claim-TTL crash-recovery branch
 * (see `drainBulkOp` / `resetStaleClaims`), not via this set.
 */
export const CLAIMABLE_STATUSES = [
    "PENDING",
    "WAITING",
    "FAILED",
];
/** Canonical literal array — consumers assert their Prisma enum is a superset against this. */
export const BULK_OP_STATUSES = [
    "PENDING",
    "PROCESSING",
    "WAITING",
    "COMPLETED",
    "EMPTY",
    "FAILED",
    "DEAD_LETTER",
];
/** True iff `s` is a terminal status (no further drain). */
export function isTerminalStatus(s) {
    return TERMINAL_STATUSES.includes(s);
}
/** True iff `s` is claimable by a drain. */
export function isClaimableStatus(s) {
    return CLAIMABLE_STATUSES.includes(s);
}
/**
 * Typed identity cast-helper (v0.1.1, ergo-fix 4). Returns its argument typed
 * as `BulkOpDelegate<TRow>` so a consumer can write
 * `delegate: asBulkOpDelegate(prisma.pendingByolCommit)` instead of
 * `delegate: prisma.pendingByolCommit as unknown as BulkOpDelegate`.
 *
 * It is a no-op at runtime (returns the same reference). The `unknown`
 * round-trip is intentional and CONTAINED here — it is the single sanctioned
 * place the structural-boundary cast lives, documented and greppable, rather
 * than scattered as `as unknown as` across every consumer call site. Prefer
 * passing `prisma.<model>` directly (it is now structurally assignable, see
 * above); reach for this only when a Prisma minor tightens a signature in a way
 * that re-breaks direct assignability.
 */
export function asBulkOpDelegate(delegate) {
    return delegate;
}
//# sourceMappingURL=types.js.map