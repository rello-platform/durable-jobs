/**
 * Fix 1 — the `./testing` subpath entry. Asserts every helper the entry promises
 * is exported + loadable, and that the scale-test harness (TrackingDelegate +
 * assertBulkEndpointScales) does what the Rello scale harness needs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as testingEntry from "./index.js";
import {
  FakeDelegate,
  FakeDlqDelegate,
  TrackingDelegate,
  assertBulkEndpointScales,
} from "./index.js";
import { enqueueBulkOp } from "../enqueue.js";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("fix 1 — ./testing entry loads", () => {
  it("exports every promised helper", () => {
    expect(typeof testingEntry.FakeDelegate).toBe("function");
    expect(typeof testingEntry.FakeDlqDelegate).toBe("function");
    expect(typeof testingEntry.TrackingDelegate).toBe("function");
    expect(typeof testingEntry.assertBulkEndpointScales).toBe("function");
  });

  it("FakeDelegate / FakeDlqDelegate are usable instances", () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING" });
    expect(d.rows.get(row.id)).toBeDefined();
    const dlq = new FakeDlqDelegate();
    expect(dlq.created).toEqual([]);
  });
});

describe("TrackingDelegate", () => {
  it("counts method calls + classifies writes, delegating to the inner delegate", async () => {
    const inner = new FakeDelegate();
    const t = new TrackingDelegate(inner);
    await enqueueBulkOp({
      delegate: t,
      anchor: { batchId: "b1" },
      tenantId: "t1",
      payload: { leads: [1, 2, 3] },
    });
    // A fresh enqueue: 1 findUnique (anchor) + 1 upsert (the single persisted intent).
    expect(t.counts.findUnique).toBe(1);
    expect(t.counts.upsert).toBe(1);
    expect(t.counts.writes).toBe(1);
    expect(t.counts.total).toBe(2);
    // It actually wrote through to the inner store.
    expect(inner.rows.size).toBe(1);
  });

  it("reset() zeroes the counters", () => {
    const t = new TrackingDelegate(new FakeDelegate());
    t.counts.writes = 5;
    t.counts.total = 9;
    t.reset();
    expect(t.counts.writes).toBe(0);
    expect(t.counts.total).toBe(0);
  });
});

describe("assertBulkEndpointScales", () => {
  it("passes for a bounded-IO endpoint (writes constant as N grows)", async () => {
    const res = await assertBulkEndpointScales({
      sizes: [1, 10, 100, 1000],
      enqueue: async (delegate, n) => {
        // The blessed shape: persist ONE intent regardless of N.
        await enqueueBulkOp({
          delegate,
          anchor: { batchId: `b-${n}` },
          tenantId: "t1",
          payload: { leads: Array.from({ length: n }, (_, i) => i) },
        });
      },
    });
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
    expect(res.samples).toHaveLength(4);
    // every sample wrote exactly once
    for (const s of res.samples) expect(s.counts.writes).toBe(1);
  });

  it("FAILS for an anti-pattern endpoint that writes per item", async () => {
    const res = await assertBulkEndpointScales({
      sizes: [1, 5, 50],
      enqueue: async (delegate, n) => {
        // The regression we want to catch: a per-item INSERT loop in the handler.
        for (let i = 0; i < n; i++) {
          await delegate.create({ data: { id: `row-${n}-${i}`, tenantId: "t1" } });
        }
      },
    });
    expect(res.ok).toBe(false);
    expect(res.violations.length).toBeGreaterThan(0);
    // writes grew with N
    expect(res.samples[res.samples.length - 1]!.counts.writes).toBeGreaterThan(
      res.samples[0]!.counts.writes,
    );
  });

  it("respects a custom maxWritesPerRequest ceiling", async () => {
    const res = await assertBulkEndpointScales({
      sizes: [1, 10],
      maxWritesPerRequest: 0, // even one write violates
      requireNonGrowing: false,
      enqueue: async (delegate, n) => {
        await enqueueBulkOp({
          delegate,
          anchor: { batchId: `c-${n}` },
          tenantId: "t1",
          payload: {},
        });
      },
    });
    expect(res.ok).toBe(false);
  });

  it("throws on misuse (empty sizes)", async () => {
    await expect(
      assertBulkEndpointScales({ sizes: [], enqueue: async () => {} }),
    ).rejects.toThrow(/non-empty/);
  });
});
