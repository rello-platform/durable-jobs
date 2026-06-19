import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  drainBulkOp,
  drainBulkOpBatch,
  resetStaleClaims,
} from "./drain.js";
import { BulkOpPermanentError, BulkOpTransientError } from "./dlq.js";
import { FakeDelegate } from "./testing/fake-delegate.js";

describe("drainBulkOp — atomic claim", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("claims a PENDING row, processes chunks, completes", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [1, 2, 3, 4, 5] } });
    const onComplete = vi.fn();
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      chunkSize: 2,
      selectItems: (p) => p.items,
      processItem: async (n) => n * 10,
      onComplete,
    });
    expect(res.status).toBe("COMPLETED");
    expect(res.processed).toBe(5);
    expect(res.succeeded).toBe(5);
    expect(d.rows.get(row.id)!.status).toBe("COMPLETED");
    expect(d.rows.get(row.id)!.completedAt).not.toBeNull();
    // v0.1.1: onComplete now receives (results, intent). Results unchanged; the
    // claimed intent is threaded as the 2nd arg (status is mutated in place by
    // the FakeDelegate afterward, so match on the stable id only).
    expect(onComplete).toHaveBeenCalledWith(
      [10, 20, 30, 40, 50],
      expect.objectContaining({ id: row.id }),
    );
  });

  it("two concurrent drains of the same row — only ONE claims (count===1), the loser no-ops", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [1] } });
    const proc = vi.fn(async (n: number) => n);
    const [a, b] = await Promise.all([
      drainBulkOp<{ items: number[] }, number, number>({
        delegate: d,
        intentId: row.id,
        selectItems: (p) => p.items,
        processItem: proc,
      }),
      drainBulkOp<{ items: number[] }, number, number>({
        delegate: d,
        intentId: row.id,
        selectItems: (p) => p.items,
        processItem: proc,
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    // exactly one COMPLETED; the other observed the already-PROCESSING/terminal row
    expect(statuses).toContain("COMPLETED");
    // processItem ran for the winner only (1 item) — never twice
    expect(proc).toHaveBeenCalledTimes(1);
  });

  it("empty payload → EMPTY terminal, no chunks, onComplete not called", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [] } });
    const onComplete = vi.fn();
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      selectItems: (p) => p.items,
      processItem: async (n) => n,
      onComplete,
    });
    expect(res.status).toBe("EMPTY");
    expect(res.processed).toBe(0);
    expect(d.rows.get(row.id)!.status).toBe("EMPTY");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("gate unmet → releases to WAITING, no processing", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [1, 2] } });
    const proc = vi.fn(async (n: number) => n);
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      gate: async () => true, // prerequisite unmet
      selectItems: (p) => p.items,
      processItem: proc,
    });
    expect(res.status).toBe("WAITING");
    expect(d.rows.get(row.id)!.status).toBe("WAITING");
    expect(d.rows.get(row.id)!.claimedUntil).toBeNull();
    expect(proc).not.toHaveBeenCalled();
  });

  it("claim-TTL crash recovery — a stale PROCESSING row is reclaimable by the drain", async () => {
    const d = new FakeDelegate();
    const past = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const row = d.seed({
      status: "PROCESSING",
      claimedUntil: past, // claim expired
      payload: { items: [1, 2] },
    });
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      selectItems: (p) => p.items,
      processItem: async (n) => n,
    });
    // the expired-claim branch let the drain re-claim + complete it
    expect(res.status).toBe("COMPLETED");
    expect(res.succeeded).toBe(2);
  });

  it("a FRESH PROCESSING claim (not expired) is NOT stolen — drain no-ops", async () => {
    const d = new FakeDelegate();
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const row = d.seed({
      status: "PROCESSING",
      claimedUntil: future,
      payload: { items: [1] },
    });
    const proc = vi.fn(async (n: number) => n);
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      selectItems: (p) => p.items,
      processItem: proc,
    });
    expect(res.status).toBe("PROCESSING"); // couldn't claim
    expect(proc).not.toHaveBeenCalled();
  });

  it("partial failure — some items fail transiently, intent still COMPLETED (failed items are consumer DLQ)", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [1, 2, 3] } });
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      selectItems: (p) => p.items,
      processItem: async (n) => {
        if (n === 2) throw new BulkOpTransientError("flaky");
        return n;
      },
    });
    expect(res.status).toBe("COMPLETED");
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(1);
  });

  it("ALL items fail transiently + budget remains → whole intent RELEASES to PENDING with backoff", async () => {
    const d = new FakeDelegate();
    const row = d.seed({
      status: "PENDING",
      attempts: 0,
      maxAttempts: 5,
      payload: { items: [1, 2] },
    });
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      selectItems: (p) => p.items,
      processItem: async () => {
        throw new BulkOpTransientError("down");
      },
    });
    expect(res.status).toBe("PENDING");
    const after = d.rows.get(row.id)!;
    expect(after.status).toBe("PENDING");
    expect(after.nextRetryAt.getTime()).toBeGreaterThan(Date.now()); // backoff in the future
    expect(after.lastError).toContain("down");
  });

  it("ALL items fail permanently AND permanent budget exhausts → FAILED", async () => {
    const d = new FakeDelegate();
    const row = d.seed({
      status: "PENDING",
      attemptsPermanent: 2, // next failure => 3 === maxAttemptsPermanent
      maxAttemptsPermanent: 3,
      payload: { items: [1] },
    });
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      selectItems: (p) => p.items,
      processItem: async () => {
        throw new BulkOpPermanentError("bad payload");
      },
    });
    expect(res.status).toBe("FAILED");
    expect(d.rows.get(row.id)!.status).toBe("FAILED");
  });

  it("mustNeverDrop → DEAD_LETTER instead of FAILED at exhaustion", async () => {
    const d = new FakeDelegate();
    const row = d.seed({
      status: "PENDING",
      attempts: 4, // claim increments to 5 === maxAttempts
      maxAttempts: 5,
      payload: { items: [1] },
    });
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      mustNeverDrop: true,
      selectItems: (p) => p.items,
      processItem: async () => {
        throw new BulkOpTransientError("still down");
      },
    });
    expect(res.status).toBe("DEAD_LETTER");
    expect(d.rows.get(row.id)!.status).toBe("DEAD_LETTER");
  });

  it("onClaim hook fires synchronously at claim; a throwing hook never aborts the drain", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [1] } });
    const onClaim = vi.fn(async () => {
      throw new Error("audit write failed");
    });
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      onClaim,
      selectItems: (p) => p.items,
      processItem: async (n) => n,
    });
    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("COMPLETED");
  });

  it("claim:false (N=1 mode) — no claim, processes directly", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [42] } });
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      claim: false,
      selectItems: (p) => p.items,
      processItem: async (n) => n,
    });
    expect(res.status).toBe("COMPLETED");
    expect(res.succeeded).toBe(1);
    expect(d.rows.get(row.id)!.attempts).toBe(0); // claim did not increment
  });

  it("onChunk advances per chunk; a throwing onChunk logs but does not abort", async () => {
    const d = new FakeDelegate();
    const row = d.seed({ status: "PENDING", payload: { items: [1, 2, 3, 4] } });
    const onChunk = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("progress row gone"));
    const res = await drainBulkOp<{ items: number[] }, number, number>({
      delegate: d,
      intentId: row.id,
      chunkSize: 2,
      selectItems: (p) => p.items,
      processItem: async (n) => n,
      onChunk,
    });
    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(res.status).toBe("COMPLETED");
  });
});

describe("resetStaleClaims", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("flips expired-claim PROCESSING rows back to PENDING", async () => {
    const d = new FakeDelegate();
    d.seed({ id: "stale", status: "PROCESSING", claimedUntil: new Date(Date.now() - 1000) });
    d.seed({ id: "fresh", status: "PROCESSING", claimedUntil: new Date(Date.now() + 60_000) });
    const res = await resetStaleClaims({ delegate: d });
    expect(res.recovered).toBe(1);
    expect(d.rows.get("stale")!.status).toBe("PENDING");
    expect(d.rows.get("stale")!.claimedUntil).toBeNull();
    expect(d.rows.get("fresh")!.status).toBe("PROCESSING");
  });

  it("recovers 0 when nothing is stale (count-first idle)", async () => {
    const d = new FakeDelegate();
    d.seed({ status: "PROCESSING", claimedUntil: new Date(Date.now() + 60_000) });
    const res = await resetStaleClaims({ delegate: d });
    expect(res.recovered).toBe(0);
  });
});

describe("drainBulkOpBatch", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("count-first idle skip — zero candidates returns without calling drainOne", async () => {
    const d = new FakeDelegate();
    const drainOne = vi.fn();
    const res = await drainBulkOpBatch({
      delegate: d,
      where: { status: { in: ["PENDING"] } },
      drainOne: drainOne as never,
    });
    expect(res.candidates).toBe(0);
    expect(drainOne).not.toHaveBeenCalled();
  });

  it("tallies each disposition across candidates", async () => {
    const d = new FakeDelegate();
    d.seed({ id: "a", status: "PENDING" });
    d.seed({ id: "b", status: "PENDING" });
    d.seed({ id: "c", status: "PENDING" });
    const drainOne = vi
      .fn()
      .mockResolvedValueOnce({ status: "COMPLETED", processed: 1, succeeded: 1, failed: 0 })
      .mockResolvedValueOnce({ status: "WAITING", processed: 0, succeeded: 0, failed: 0 })
      .mockResolvedValueOnce({ status: "FAILED", processed: 1, succeeded: 0, failed: 1 });
    const res = await drainBulkOpBatch({
      delegate: d,
      where: { status: { in: ["PENDING"] } },
      drainOne,
    });
    expect(res.candidates).toBe(3);
    expect(res.completed).toBe(1);
    expect(res.waiting).toBe(1);
    expect(res.failed).toBe(1);
  });
});
