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
function emptyCounts() {
    return {
        findUnique: 0,
        findFirst: 0,
        findMany: 0,
        upsert: 0,
        updateMany: 0,
        update: 0,
        create: 0,
        writes: 0,
        total: 0,
    };
}
/**
 * Wraps any `BulkOpDelegate` and tallies every method call + classifies writes.
 * Pass the wrapped delegate to `enqueueBulkOp` / `drainBulkOp` exactly as you
 * would the real one, then read `.counts` to assert the IO profile.
 *
 * Type param `TRow` mirrors the wrapped delegate's row so the tracker is a
 * drop-in (a real Prisma delegate, the `FakeDelegate`, or a custom stub all fit).
 */
export class TrackingDelegate {
    counts = emptyCounts();
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    /** Reset all counters to zero (call between sweep iterations). */
    reset() {
        Object.assign(this.counts, emptyCounts());
    }
    bump(method, isWrite) {
        this.counts[method] += 1;
        this.counts.total += 1;
        if (isWrite)
            this.counts.writes += 1;
    }
    findUnique(args) {
        this.bump("findUnique", false);
        return Promise.resolve(this.inner.findUnique(args));
    }
    findFirst(args) {
        this.bump("findFirst", false);
        return Promise.resolve(this.inner.findFirst(args));
    }
    findMany(args) {
        this.bump("findMany", false);
        return Promise.resolve(this.inner.findMany(args));
    }
    upsert(args) {
        this.bump("upsert", true);
        return Promise.resolve(this.inner.upsert(args));
    }
    updateMany(args) {
        this.bump("updateMany", true);
        return Promise.resolve(this.inner.updateMany(args));
    }
    update(args) {
        this.bump("update", true);
        return Promise.resolve(this.inner.update(args));
    }
    create(args) {
        this.bump("create", true);
        return Promise.resolve(this.inner.create(args));
    }
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
export async function assertBulkEndpointScales(args) {
    if (!args.sizes || args.sizes.length === 0) {
        throw new Error("[durable-jobs:assertBulkEndpointScales] `sizes` must be a non-empty array of item counts.");
    }
    for (const n of args.sizes) {
        if (!Number.isFinite(n) || n < 0) {
            throw new Error(`[durable-jobs:assertBulkEndpointScales] invalid size ${String(n)} — sizes must be finite, non-negative.`);
        }
    }
    const ceiling = args.maxWritesPerRequest ?? 2;
    const requireNonGrowing = args.requireNonGrowing ?? true;
    // Lazy-require so the harness has no hard import cycle at module load.
    const { FakeDelegate } = await import("./fake-delegate.js");
    const makeDelegate = args.makeDelegate ?? (() => new FakeDelegate());
    const samples = [];
    const violations = [];
    // Sweep ascending so the "non-growing" comparison reads naturally.
    const sizes = [...args.sizes].sort((a, b) => a - b);
    for (const n of sizes) {
        const tracker = new TrackingDelegate(makeDelegate());
        await args.enqueue(tracker, n);
        samples.push({ n, counts: { ...tracker.counts } });
        if (tracker.counts.writes > ceiling) {
            violations.push(`N=${n}: ${tracker.counts.writes} request-path writes > ceiling ${ceiling} ` +
                `(a bounded-IO bulk endpoint persists ONE intent per request — a per-item ` +
                `write loop has leaked back into the handler).`);
        }
    }
    if (requireNonGrowing && samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        if (last.counts.writes > first.counts.writes) {
            violations.push(`writes GREW with N: N=${first.n} → ${first.counts.writes} writes, ` +
                `N=${last.n} → ${last.counts.writes} writes. Request-path IO must not scale with item count.`);
        }
    }
    return { ok: violations.length === 0, samples, violations };
}
//# sourceMappingURL=io-tracker.js.map