/**
 * v0.1.1 ergonomics fixes — regression tests for the 5 proof-consumer gaps.
 * Each test pins the NEW behavior AND asserts the v0.1.0 form still works.
 */
import { describe, it, expect, vi, beforeEach, afterEach, expectTypeOf } from "vitest";
import { drainBulkOp } from "./drain.js";
import { dispatchDrain } from "./runtime.js";
import { asBulkOpDelegate } from "./types.js";
import type { BulkOpIntent, BulkOpDelegate } from "./types.js";
import { FakeDelegate } from "./testing/fake-delegate.js";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ── Fix 2: dispatchDrain accepts a pre-bound thunk ────────────────────────
describe("fix 2 — dispatchDrain pre-bound thunk form", () => {
  it("v0.1.0 by-id form still calls trigger(taskId, payload)", async () => {
    const trigger = vi.fn().mockResolvedValue({ id: "run_1" });
    const res = await dispatchDrain({
      trigger,
      taskId: "byol-commit-drain",
      payload: { batchId: "b1" },
    });
    expect(trigger).toHaveBeenCalledWith("byol-commit-drain", { batchId: "b1" });
    expect(res.dispatched).toBe(true);
  });

  it("v0.1.1 thunk form calls the pre-bound zero-arg thunk", async () => {
    // Models a typed `() => tasks.trigger<typeof task>(task.id, payload)` thunk.
    const thunk = vi.fn().mockResolvedValue({ id: "run_2" });
    const res = await dispatchDrain({ trigger: thunk });
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(thunk).toHaveBeenCalledWith(); // no args
    expect(res.dispatched).toBe(true);
  });

  it("thunk form logs (never throws) on a failed dispatch", async () => {
    const thunk = vi.fn().mockRejectedValue(new Error("trigger.dev 503"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await dispatchDrain({ trigger: thunk, taskId: "my-drain" });
    expect(res.dispatched).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/dispatch of "my-drain" failed/));
  });

  it("thunk form with a 0-length mock is NOT misread as by-id", async () => {
    // Regression: a `vi.fn()` reports `.length === 0`; shape (no `payload`) must
    // be the discriminator, not arity.
    const thunk = vi.fn().mockResolvedValue(undefined);
    const res = await dispatchDrain({ trigger: thunk });
    expect(res.dispatched).toBe(true);
    expect(thunk).toHaveBeenCalledWith();
  });
});

// ── Fix 3: generic BulkOpIntent<TExtra> ───────────────────────────────────
describe("fix 3 — generic BulkOpIntent<TExtra>", () => {
  it("default param keeps the v0.1.0 base shape (no extra columns)", () => {
    expectTypeOf<BulkOpIntent>().toHaveProperty("id");
    expectTypeOf<BulkOpIntent>().toHaveProperty("tenantId");
    expectTypeOf<BulkOpIntent>().toHaveProperty("status");
  });

  it("TExtra adds typed business columns onto the intent", () => {
    type WithBatch = BulkOpIntent<{ batchId: string; userId: string }>;
    expectTypeOf<WithBatch>().toHaveProperty("batchId");
    expectTypeOf<WithBatch["batchId"]>().toEqualTypeOf<string>();
    expectTypeOf<WithBatch["userId"]>().toEqualTypeOf<string>();
    // base columns still present
    expectTypeOf<WithBatch>().toHaveProperty("id");
  });

  it("typed extra columns read off the threaded intent WITHOUT a cast", async () => {
    type WithBatch = BulkOpIntent<{ batchId: string }>;
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [1, 2] }, batchId: "B-9" });
    let seenBatchId: string | undefined;
    await drainBulkOp<{ items: number[] }, number, number, WithBatch>({
      delegate: d as unknown as BulkOpDelegate<WithBatch>,
      intentId: row.id,
      selectItems: (p) => p.items,
      processItem: async (n) => n,
      // no cast on `intent` — batchId is typed
      onComplete: async (_results, intent) => {
        seenBatchId = intent.batchId;
      },
    });
    expect(seenBatchId).toBe("B-9");
  });
});

// ── Fix 4: real Prisma delegate assignable without `as unknown as` ─────────
describe("fix 4 — delegate assignability", () => {
  it("a PromiseLike-returning, narrow-arg delegate is assignable to BulkOpDelegate", () => {
    // Models a real Prisma delegate: (a) method `args` types narrower than our
    // `Record<string,unknown>` (model-specific WhereInputs), and (b) a return
    // type that is a `PromiseLike<T>` thenable, NOT a real `Promise<T>` (Prisma's
    // `Prisma__ModelClient<T>`). PrismaPromise extends Promise, so PromiseLike is
    // the faithful lower bound — the v0.1.0 `Promise<T>` return type would reject
    // this delegate (TS2345 the proof consumers hit), v0.1.1's PromiseLike accepts it.
    // Prisma's generated WhereInputs are wide (every column OPTIONAL + operator
    // unions), so a `Record<string,unknown>` arg is assignable to them — modeled
    // here as `WhereInput` (all-optional). The faithful blocker the consumers hit
    // was the RETURN type (a thenable, not a Promise), addressed by PromiseLike.
    interface WhereInput {
      id?: string;
      tenantId?: string;
      status?: unknown;
      [k: string]: unknown;
    }
    interface FakePrismaDelegate {
      findUnique(a: { where: WhereInput; select?: object }): PromiseLike<BulkOpIntent | null>;
      findFirst(a: { where: WhereInput; select?: object }): PromiseLike<BulkOpIntent | null>;
      findMany(a: { where: WhereInput; take?: number; orderBy?: unknown; select?: object }): PromiseLike<BulkOpIntent[]>;
      upsert(a: { where: WhereInput; create: object; update: object }): PromiseLike<BulkOpIntent>;
      updateMany(a: { where: WhereInput; data: object }): PromiseLike<{ count: number }>;
      update(a: { where: WhereInput; data: object }): PromiseLike<BulkOpIntent>;
      create(a: { data: object }): PromiseLike<BulkOpIntent>;
    }
    // The whole point: this assignment compiles with NO `as unknown as`.
    const check = (d: FakePrismaDelegate): BulkOpDelegate => d;
    expect(typeof check).toBe("function");
  });

  it("asBulkOpDelegate is a typed identity (same reference at runtime)", () => {
    const d = new FakeDelegate();
    const typed = asBulkOpDelegate(d);
    expect(typed).toBe(d);
    expectTypeOf(typed).toMatchTypeOf<BulkOpDelegate>();
  });
});

// ── Fix 5: claimed intent threaded to onChunk / onComplete ────────────────
describe("fix 5 — intent threaded to hooks", () => {
  it("onChunk receives (results, range, intent) per chunk", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [1, 2, 3, 4, 5] }, batchId: "BB" });
    const seenIntentIds: string[] = [];
    await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      chunkSize: 2,
      selectItems: (p) => p.items,
      processItem: async (n) => n,
      onChunk: async (_results, _range, intent) => {
        seenIntentIds.push(intent.id);
      },
    });
    // 5 items / chunk 2 → 3 chunks, each handed the same claimed intent.
    expect(seenIntentIds).toEqual([row.id, row.id, row.id]);
  });

  it("onComplete receives (results, intent) once on success", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [1, 2] } });
    const onComplete = vi.fn();
    await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      selectItems: (p) => p.items,
      processItem: async (n) => n,
      onComplete,
    });
    expect(onComplete).toHaveBeenCalledWith(
      [1, 2],
      expect.objectContaining({ id: row.id }),
    );
  });

  it("a v0.1.0 hook that ignores the appended intent arg still works", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [7] } });
    // 1-arg onComplete / 2-arg onChunk — the v0.1.0 shapes, fewer params.
    const oldOnComplete = async (results: number[]) => {
      expect(results).toEqual([7]);
    };
    const oldOnChunk = async (
      results: number[],
      range: { start: number; size: number; failed: number },
    ) => {
      expect(range.size).toBe(1);
      expect(results).toEqual([7]);
    };
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      selectItems: (p) => p.items,
      processItem: async (n) => n,
      onChunk: oldOnChunk,
      onComplete: oldOnComplete,
    });
    expect(res.status).toBe("COMPLETED");
  });
});
