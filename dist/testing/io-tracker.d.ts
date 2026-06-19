/**
 * @rello-platform/durable-jobs/testing — IO-tracker + scale-test harness.
 *
 * The durable primitive's whole point is that a bulk endpoint's REQUEST-PATH DB
 * IO stays BOUNDED regardless of item count N (persist-one-intent + return; the
 * drain does the per-item work off-request). These helpers let a consumer's
 * vitest assert that invariant structurally instead of eyeballing it:
 *
 *  - `TrackingDelegate` — wraps any `BulkOpDelegate` and counts every method
 *    call (and writes) so a test can read "how many DB ops did enqueue do?".
 *  - `assertBulkEndpointScales` — runs an enqueue closure across a sweep of N
 *    and asserts the per-request write count never grows with N (or stays under
 *    a caller-supplied ceiling), catching the regression where someone reverts
 *    to a per-item INSERT loop inside the request handler.
 *
 * NEVER touches a real DB — it wraps the in-memory `FakeDelegate` (or any
 * structural `BulkOpDelegate`). Test-Runner Standard §2.
 */
import type { BulkOpDelegate, BulkOpIntent } from "../types.js";
/** Per-method invocation counters. `writes` = create+upsert+update+updateMany. */
export interface IoCounts {
    findUnique: number;
    findFirst: number;
    findMany: number;
    upsert: number;
    updateMany: number;
    update: number;
    create: number;
    /** Total mutating calls (create + upsert + update + updateMany). */
    writes: number;
    /** Total calls across every method. */
    total: number;
}
/**
 * Wraps any `BulkOpDelegate` and tallies every method call + classifies writes.
 * Pass the wrapped delegate to `enqueueBulkOp` / `drainBulkOp` exactly as you
 * would the real one, then read `.counts` to assert the IO profile.
 *
 * Type param `TRow` mirrors the wrapped delegate's row so the tracker is a
 * drop-in (a real Prisma delegate, the `FakeDelegate`, or a custom stub all fit).
 */
export declare class TrackingDelegate<TRow extends BulkOpIntent = BulkOpIntent> implements BulkOpDelegate<TRow> {
    readonly counts: IoCounts;
    private readonly inner;
    constructor(inner: BulkOpDelegate<TRow>);
    /** Reset all counters to zero (call between sweep iterations). */
    reset(): void;
    private bump;
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
export interface AssertBulkEndpointScalesArgs {
    /**
     * The item counts to sweep (e.g. [1, 10, 100, 1000]). For each N the harness
     * builds a fresh TrackingDelegate, runs `enqueue(delegate, N)`, and records
     * the resulting per-request write count.
     */
    sizes: number[];
    /**
     * Your request-path closure. Receives a fresh TrackingDelegate + the item
     * count; should do exactly what your endpoint does (typically a single
     * `enqueueBulkOp` call). Reuse `makeDelegate` to control the wrapped delegate
     * (defaults to a fresh `FakeDelegate`).
     */
    enqueue: (delegate: TrackingDelegate<BulkOpIntent>, n: number) => Promise<unknown>;
    /** Builds the WRAPPED (inner) delegate for each N. Default: a fresh FakeDelegate. */
    makeDelegate?: () => BulkOpDelegate<BulkOpIntent>;
    /**
     * Hard ceiling on per-request WRITES for any N. The durable shape persists
     * ONE intent per request, so a small constant (default 2 — one upsert + an
     * idempotency re-read tolerance) is the expectation. Set higher if your
     * endpoint legitimately chunk-enqueues a bounded number of intents.
     */
    maxWritesPerRequest?: number;
    /**
     * When true (default), also assert writes do NOT GROW with N — i.e. the write
     * count for the largest N is <= the write count for the smallest N. This is
     * the real "it scales" check (catches a per-item INSERT loop that passes a
     * fixed ceiling at small N but blows it at large N).
     */
    requireNonGrowing?: boolean;
}
export interface ScaleSample {
    n: number;
    counts: IoCounts;
}
export interface AssertBulkEndpointScalesResult {
    ok: boolean;
    samples: ScaleSample[];
    /** Human-readable failure reasons (empty when ok). */
    violations: string[];
}
/**
 * Run `enqueue` across the size sweep and verify the per-request DB-write count
 * stays BOUNDED (and, by default, non-growing) as N scales. Returns a result
 * object — the caller asserts `result.ok` (so it composes with any test runner;
 * the package ships no assertion lib). Throws only on a misuse (empty sizes).
 *
 * Compatible with the Rello scale harness's `assertBulkEndpointScales` contract:
 * pass your endpoint's enqueue closure, get back the per-N IO profile + a pass/
 * fail verdict.
 */
export declare function assertBulkEndpointScales(args: AssertBulkEndpointScalesArgs): Promise<AssertBulkEndpointScalesResult>;
//# sourceMappingURL=io-tracker.d.ts.map