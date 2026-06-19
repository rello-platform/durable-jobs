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
/**
 * Unified durable-intent status machine. The union of the HH-BYOL reference
 * terminals (EMPTY/DEAD_LETTER) + the PFP gold-standard claim model.
 *
 * String-typed (not a Prisma enum) so it is portable across consumer `@@schema`s.
 * A consumer MAY mirror it as a Prisma enum but MUST import this literal set to
 * assert the enum is a superset at build time (Type-discipline Rule E) — never
 * redeclare the literal set (drift becomes a silent NaN, not a compile error).
 */
export type BulkOpStatus = "PENDING" | "PROCESSING" | "WAITING" | "COMPLETED" | "EMPTY" | "FAILED" | "DEAD_LETTER";
/** Terminal statuses — a drain never re-claims these (except FAILED, see CLAIMABLE). */
export declare const TERMINAL_STATUSES: readonly ["COMPLETED", "EMPTY", "FAILED", "DEAD_LETTER"];
/**
 * Claimable statuses — the atomic claim's WHERE clause selects these.
 * FAILED is recyclable per the HH reference (a transient-exhausted row can be
 * re-enqueued / re-driven by the backstop); DEAD_LETTER is NOT recyclable.
 * PROCESSING is reclaimed separately via the claim-TTL crash-recovery branch
 * (see `drainBulkOp` / `resetStaleClaims`), not via this set.
 */
export declare const CLAIMABLE_STATUSES: readonly ["PENDING", "WAITING", "FAILED"];
/** Canonical literal array — consumers assert their Prisma enum is a superset against this. */
export declare const BULK_OP_STATUSES: readonly ["PENDING", "PROCESSING", "WAITING", "COMPLETED", "EMPTY", "FAILED", "DEAD_LETTER"];
/** True iff `s` is a terminal status (no further drain). */
export declare function isTerminalStatus(s: BulkOpStatus): boolean;
/** True iff `s` is claimable by a drain. */
export declare function isClaimableStatus(s: BulkOpStatus): boolean;
/**
 * The minimal row shape the helpers read/write. The consumer's Prisma row
 * (with its own business columns + `@@schema`) is structurally assignable to
 * this — the package never imports the consumer's generated client.
 */
export interface BulkOpIntent {
    id: string;
    tenantId: string;
    status: BulkOpStatus;
    payload: unknown;
    idempotencyKey: string | null;
    attempts: number;
    attemptsPermanent: number;
    maxAttempts: number;
    maxAttemptsPermanent: number;
    lastError: string | null;
    nextRetryAt: Date;
    claimedUntil: Date | null;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
}
/**
 * The Prisma model-delegate surface the helpers need. The consumer passes
 * `prisma.<model>` here. Typed structurally (not against `@prisma/client`) so
 * the package never hardcodes a client or a schema. `@prisma/client` is an
 * OPTIONAL peer — only consumers that actually wire a delegate need it.
 *
 * Each method mirrors the Prisma delegate signature loosely enough that a real
 * Prisma delegate is assignable while keeping the package decoupled.
 */
export interface BulkOpDelegate<TRow = BulkOpIntent> {
    findUnique(args: {
        where: Record<string, unknown>;
        select?: Record<string, boolean>;
    }): Promise<TRow | null>;
    findFirst(args: {
        where: Record<string, unknown>;
        select?: Record<string, boolean>;
    }): Promise<TRow | null>;
    findMany(args: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
        select?: Record<string, boolean>;
    }): Promise<Array<{
        id: string;
    } & Partial<TRow>>>;
    upsert(args: {
        where: Record<string, unknown>;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
    }): Promise<TRow>;
    updateMany(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
    }): Promise<{
        count: number;
    }>;
    update(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
    }): Promise<TRow>;
    create(args: {
        data: Record<string, unknown>;
    }): Promise<TRow>;
}
//# sourceMappingURL=types.d.ts.map