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
 *
 * `TExtra` (v0.1.1, ergo-fix 3) lets a consumer thread its OWN business columns
 * through to the typed hooks (`onChunk` / `onComplete` / `onClaim`) and the
 * threaded `intent` arg — e.g. `BulkOpIntent<{ batchId: string; userId: string }>`
 * — so reading `intent.batchId` in a hook compiles without `intent as {...}`.
 * The default `{}` keeps every v0.1.0 call site (`BulkOpIntent` with no arg)
 * compiling unchanged — the base contract is identical, `TExtra` only ADDS
 * optional knowledge of extra columns.
 */
export type BulkOpIntent<TExtra extends Record<string, unknown> = {}> = {
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
} & TExtra;
/**
 * The Prisma model-delegate surface the helpers need. The consumer passes
 * `prisma.<model>` here. Typed structurally (not against `@prisma/client`) so
 * the package never hardcodes a client or a schema. `@prisma/client` is an
 * OPTIONAL peer — only consumers that actually wire a delegate need it.
 *
 * ── Real-Prisma-delegate assignability (v0.1.1, ergo-fix 4) ──────────────
 * A real `prisma.<model>` delegate must be assignable to this WITHOUT a
 * `prisma.x as unknown as BulkOpDelegate` double-cast. Two facts about the
 * Prisma generated delegate drove the v0.1.1 loosening:
 *
 *  1. Prisma's delegate methods return a `Prisma__<Model>Client<T>` (a custom
 *     PromiseLike/thenable that is awaitable but is NOT a `Promise<T>`). A
 *     method typed `(): Promise<T>` is therefore NOT a supertype of a method
 *     typed `(): Prisma__ModelClient<T>` — assignability fails. We declare the
 *     return types as `PromiseLike<T>` (which `await` satisfies and which BOTH
 *     a `Promise<T>` and a `Prisma__ModelClient<T>` are assignable to).
 *
 *  2. Prisma's arg types are model-specific (`ModelWhereUniqueInput`, …), each
 *     a structural subtype of our permissive `{ where: Record<string,unknown> }`.
 *     Because these are declared as METHODS (method syntax) rather than function
 *     PROPERTIES, TypeScript checks their parameters BIVARIANTLY, so a narrower
 *     Prisma arg type is accepted at the structural boundary. The helpers still
 *     construct fully-typed arg objects internally, so real type safety lives at
 *     the call sites, not on this permissive boundary.
 *
 * For ergonomics there is also `asBulkOpDelegate(prisma.x)` (see below) — a
 * typed identity helper that documents the supported shape and avoids the
 * `as unknown as` idiom at the call site if a consumer prefers an explicit cast.
 */
export interface BulkOpDelegate<TRow = BulkOpIntent> {
    findUnique(args: {
        where: Record<string, unknown>;
        select?: Record<string, boolean>;
    }): PromiseLike<TRow | null>;
    findFirst(args: {
        where: Record<string, unknown>;
        select?: Record<string, boolean>;
    }): PromiseLike<TRow | null>;
    findMany(args: {
        where: Record<string, unknown>;
        orderBy?: unknown;
        take?: number;
        select?: Record<string, boolean>;
    }): PromiseLike<Array<{
        id: string;
    } & Partial<TRow>>>;
    upsert(args: {
        where: Record<string, unknown>;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
    }): PromiseLike<TRow>;
    updateMany(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
    }): PromiseLike<{
        count: number;
    }>;
    update(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
    }): PromiseLike<TRow>;
    create(args: {
        data: Record<string, unknown>;
    }): PromiseLike<TRow>;
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
export declare function asBulkOpDelegate<TRow = BulkOpIntent>(delegate: unknown): BulkOpDelegate<TRow>;
//# sourceMappingURL=types.d.ts.map