import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyFailure,
  writeDlq,
  isPermanentError,
  isUniqueViolation,
  BulkOpTransientError,
  BulkOpPermanentError,
} from "./dlq.js";
import { FakeDlqDelegate } from "./testing/fake-delegate.js";

afterEach(() => vi.restoreAllMocks());

describe("typed errors", () => {
  it("instanceof survives across the typed errors", () => {
    expect(new BulkOpTransientError("x")).toBeInstanceOf(BulkOpTransientError);
    expect(new BulkOpPermanentError("x")).toBeInstanceOf(BulkOpPermanentError);
    expect(new BulkOpPermanentError("x")).not.toBeInstanceOf(BulkOpTransientError);
  });
});

describe("isPermanentError", () => {
  it("classifies BulkOpPermanentError + 4xx-shaped errors as permanent", () => {
    expect(isPermanentError(new BulkOpPermanentError("bad"))).toBe(true);
    expect(isPermanentError({ statusCode: 400 })).toBe(true);
    expect(isPermanentError({ status: 422 })).toBe(true);
  });
  it("treats 5xx + transient + unknown as NOT permanent", () => {
    expect(isPermanentError(new BulkOpTransientError("down"))).toBe(false);
    expect(isPermanentError({ statusCode: 500 })).toBe(false);
    expect(isPermanentError(new Error("network"))).toBe(false);
  });
});

describe("isUniqueViolation", () => {
  it("detects P2002", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
  });
});

describe("classifyFailure ladder", () => {
  it("transient under budget → RELEASE on attempts with exponential backoff", () => {
    const r = classifyFailure({
      err: new BulkOpTransientError("down"),
      attempts: 0,
      attemptsPermanent: 0,
      maxAttempts: 5,
      maxAttemptsPermanent: 3,
    });
    expect(r.disposition).toBe("RELEASE");
    expect(r.counter).toBe("attempts");
    expect(r.nextCount).toBe(1);
    expect(r.backoffMs).toBe(30_000); // base * 2^0
  });

  it("backoff grows and caps", () => {
    const big = classifyFailure({
      err: new BulkOpTransientError("down"),
      attempts: 20,
      attemptsPermanent: 0,
      maxAttempts: 100,
      maxAttemptsPermanent: 3,
    });
    expect(big.backoffMs).toBe(480_000); // capped
  });

  it("permanent error burns the SMALLER permanent budget", () => {
    const r = classifyFailure({
      err: new BulkOpPermanentError("bad"),
      attempts: 0,
      attemptsPermanent: 2,
      maxAttempts: 5,
      maxAttemptsPermanent: 3,
    });
    expect(r.counter).toBe("attemptsPermanent");
    expect(r.nextCount).toBe(3);
    expect(r.disposition).toBe("FAILED"); // 3 >= 3 exhausted
  });

  it("transient exhaustion → FAILED", () => {
    const r = classifyFailure({
      err: new BulkOpTransientError("down"),
      attempts: 4,
      attemptsPermanent: 0,
      maxAttempts: 5,
      maxAttemptsPermanent: 3,
    });
    expect(r.disposition).toBe("FAILED");
  });

  it("mustNeverDrop → DEAD_LETTER at exhaustion, not FAILED", () => {
    const r = classifyFailure({
      err: new BulkOpTransientError("down"),
      attempts: 4,
      attemptsPermanent: 0,
      maxAttempts: 5,
      maxAttemptsPermanent: 3,
      mustNeverDrop: true,
    });
    expect(r.disposition).toBe("DEAD_LETTER");
  });
});

describe("writeDlq", () => {
  it("writes a DLQ row with tenant + reason + extra", async () => {
    const dlq = new FakeDlqDelegate();
    await writeDlq({
      dlqDelegate: dlq,
      tenantId: "t1",
      reason: "exhausted",
      attempts: 5,
      extra: { queueId: "q1" },
    });
    expect(dlq.created).toHaveLength(1);
    expect(dlq.created[0]).toMatchObject({
      tenantId: "t1",
      reason: "exhausted",
      attempts: 5,
      queueId: "q1",
    });
  });

  it("is P2002-tolerant — an already-dead-lettered anchor is a silent no-op", async () => {
    const dlq = new FakeDlqDelegate();
    dlq.throwP2002 = true;
    await expect(
      writeDlq({ dlqDelegate: dlq, tenantId: "t1", reason: "dup", attempts: 1 }),
    ).resolves.toBeUndefined();
  });

  it("logs (never throws) on a non-P2002 failure", async () => {
    const dlq = new FakeDlqDelegate();
    dlq.throwOther = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      writeDlq({ dlqDelegate: dlq, tenantId: "t1", reason: "x", attempts: 1 }),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/CRITICAL: failed to write DLQ/));
  });
});
