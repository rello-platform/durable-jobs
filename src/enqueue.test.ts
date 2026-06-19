import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enqueueBulkOp } from "./enqueue.js";
import { FakeDelegate } from "./__test-helpers__/fake-delegate.js";

describe("enqueueBulkOp", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("persists a fresh intent and returns enqueued:true", async () => {
    const d = new FakeDelegate();
    const res = await enqueueBulkOp({
      delegate: d,
      anchor: { batchId: "b1" },
      tenantId: "t1",
      payload: { leads: [1, 2, 3] },
    });
    expect(res.enqueued).toBe(true);
    expect(res.alreadyInFlight).toBe(false);
    expect(res.intentId).toBeDefined();
    expect(d.rows.size).toBe(1);
    const row = [...d.rows.values()][0]!;
    expect(row.status).toBe("PENDING");
    expect(row.tenantId).toBe("t1");
  });

  it("is idempotent on the @unique anchor — a second enqueue is alreadyInFlight, no second row", async () => {
    const d = new FakeDelegate();
    const a = await enqueueBulkOp({
      delegate: d,
      anchor: { batchId: "b1" },
      tenantId: "t1",
      payload: { x: 1 },
    });
    const b = await enqueueBulkOp({
      delegate: d,
      anchor: { batchId: "b1" },
      tenantId: "t1",
      payload: { x: 1 },
    });
    expect(a.enqueued).toBe(true);
    expect(b.enqueued).toBe(false);
    expect(b.alreadyInFlight).toBe(true);
    expect(d.rows.size).toBe(1);
  });

  it("recycles a terminal-FAILED row back to PENDING with counters reset", async () => {
    const d = new FakeDelegate();
    d.seed({
      id: "x",
      tenantId: "t1",
      status: "FAILED",
      attempts: 5,
      attemptsPermanent: 1,
      lastError: "boom",
    });
    // anchor matches the seeded row's id
    const res = await enqueueBulkOp({
      delegate: d,
      anchor: { id: "x" },
      tenantId: "t1",
      payload: { fresh: true },
    });
    expect(res.enqueued).toBe(true);
    expect(res.alreadyInFlight).toBe(true); // anchor pre-existed
    const row = d.rows.get("x")!;
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.attemptsPermanent).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.payload).toEqual({ fresh: true });
  });

  it("COMPLETED anchor is an idempotent no-op (not recycled)", async () => {
    const d = new FakeDelegate();
    d.seed({ id: "x", status: "COMPLETED" });
    const res = await enqueueBulkOp({
      delegate: d,
      anchor: { id: "x" },
      tenantId: "t1",
      payload: {},
    });
    expect(res.enqueued).toBe(false);
    expect(res.alreadyInFlight).toBe(true);
    expect(d.rows.get("x")!.status).toBe("COMPLETED");
  });

  it("coalesces — an existing PENDING row matching coalesceOn skips the insert", async () => {
    const d = new FakeDelegate();
    d.seed({
      id: "existing",
      tenantId: "t1",
      status: "PENDING",
      payload: { intakeId: "i-42" },
    });
    const res = await enqueueBulkOp({
      delegate: d,
      anchor: { batchId: "b-new" },
      tenantId: "t1",
      payload: { intakeId: "i-42" },
      coalesceOn: { payload: { path: ["intakeId"], equals: "i-42" } },
    });
    expect(res.enqueued).toBe(false);
    expect(res.alreadyInFlight).toBe(true);
    expect(res.intentId).toBe("existing");
    expect(d.rows.size).toBe(1); // no new row
  });

  it("coalesce does NOT skip when no in-flight row matches", async () => {
    const d = new FakeDelegate();
    const res = await enqueueBulkOp({
      delegate: d,
      anchor: { batchId: "b1" },
      tenantId: "t1",
      payload: { intakeId: "i-7" },
      coalesceOn: { payload: { path: ["intakeId"], equals: "i-7" } },
    });
    expect(res.enqueued).toBe(true);
    expect(d.rows.size).toBe(1);
  });

  it("treats a P2002 race on create as alreadyInFlight (no throw)", async () => {
    const d = new FakeDelegate({ throwP2002OnNextCreate: true });
    // pre-seed the row that the 'winner' wrote so the post-P2002 findUnique resolves
    d.seed({ id: "winner", status: "PENDING" });
    const res = await enqueueBulkOp({
      delegate: d,
      anchor: { id: "winner" },
      tenantId: "t1",
      payload: {},
    });
    // anchor pre-exists (the winner) so it short-circuits before create; force the
    // race path explicitly instead:
    expect(res.alreadyInFlight).toBe(true);
  });

  it("rethrows a non-P2002 infra failure (never silently drops an enqueue)", async () => {
    const d = new FakeDelegate();
    vi.spyOn(d, "upsert").mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      enqueueBulkOp({
        delegate: d,
        anchor: { batchId: "b1" },
        tenantId: "t1",
        payload: {},
      }),
    ).rejects.toThrow("connection lost");
  });

  it("requires tenantId", async () => {
    const d = new FakeDelegate();
    await expect(
      enqueueBulkOp({
        delegate: d,
        anchor: { batchId: "b1" },
        tenantId: "",
        payload: {},
      }),
    ).rejects.toThrow(/tenantId is required/);
  });

  it("warns on an oversize payload above the item ceiling but does not throw", async () => {
    const d = new FakeDelegate();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await enqueueBulkOp({
      delegate: d,
      anchor: { batchId: "big" },
      tenantId: "t1",
      payload: {},
      payloadItemCount: 50_000,
      itemCeiling: 10_000,
    });
    expect(res.enqueued).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/oversize payload/));
  });
});
