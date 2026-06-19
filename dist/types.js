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
//# sourceMappingURL=types.js.map