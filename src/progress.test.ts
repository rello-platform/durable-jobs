import { describe, it, expect, vi, afterEach } from "vitest";
import {
  advanceProgress,
  mergeProgressMap,
  advisoryLockKey,
  type ProgressTxClient,
} from "./progress.js";

afterEach(() => vi.restoreAllMocks());

describe("advanceProgress", () => {
  it("issues atomic {increment} for each numeric counter", async () => {
    const update = vi.fn().mockResolvedValue({});
    await advanceProgress({
      progressDelegate: { update },
      where: { batchId: "b1" },
      increments: { committedCount: 12, errorCount: 1 },
    });
    expect(update).toHaveBeenCalledWith({
      where: { batchId: "b1" },
      data: { committedCount: { increment: 12 }, errorCount: { increment: 1 } },
    });
  });

  it("skips non-numeric / NaN increments (no clobber)", async () => {
    const update = vi.fn().mockResolvedValue({});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await advanceProgress({
      progressDelegate: { update },
      where: { batchId: "b1" },
      increments: { good: 5, bad: NaN as unknown as number },
    });
    expect(update).toHaveBeenCalledWith({
      where: { batchId: "b1" },
      data: { good: { increment: 5 } },
    });
  });

  it("no-ops (no DB call) when there are no valid increments", async () => {
    const update = vi.fn();
    await advanceProgress({
      progressDelegate: { update },
      where: { batchId: "b1" },
      increments: {},
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("logs (never throws) when the progress row is absent", async () => {
    const update = vi.fn().mockRejectedValue(Object.assign(new Error("nf"), { code: "P2025" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      advanceProgress({
        progressDelegate: { update },
        where: { batchId: "gone" },
        increments: { x: 1 },
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("advisoryLockKey", () => {
  it("is stable + deterministic for the same anchor", () => {
    expect(advisoryLockKey("batch-42")).toBe(advisoryLockKey("batch-42"));
    expect(advisoryLockKey("a")).not.toBe(advisoryLockKey("b"));
  });
  it("returns a 32-bit int", () => {
    const k = advisoryLockKey("some-long-anchor-string");
    expect(Number.isInteger(k)).toBe(true);
    expect(k).toBe(k | 0);
  });
});

describe("mergeProgressMap", () => {
  it("takes the advisory lock, reads, folds the delta via the reducer, writes", async () => {
    const calls: string[] = [];
    const tx: ProgressTxClient = {
      $executeRaw: vi.fn(async () => {
        calls.push("lock");
        return 1;
      }),
    };
    let stored: Record<string, { done: number }> = { a: { done: 1 } };
    await mergeProgressMap<{ done: number }>({
      tx,
      lockNamespace: 4242,
      lockKey: advisoryLockKey("anchor"),
      read: async () => stored,
      write: async (next) => {
        stored = next;
      },
      mapKey: "a",
      delta: { done: 2 },
      reducer: (prev, delta) => ({ done: (prev?.done ?? 0) + (delta.done ?? 0) }),
    });
    expect(calls).toEqual(["lock"]);
    expect(stored.a).toEqual({ done: 3 });
  });

  it("initializes a map entry when the key is absent", async () => {
    const tx: ProgressTxClient = { $executeRaw: vi.fn(async () => 1) };
    let stored: Record<string, { done: number }> = {};
    await mergeProgressMap<{ done: number }>({
      tx,
      lockNamespace: 4242,
      lockKey: 1,
      read: async () => stored,
      write: async (next) => {
        stored = next;
      },
      mapKey: "new",
      delta: { done: 1 },
      reducer: (prev, delta) => ({ done: (prev?.done ?? 0) + (delta.done ?? 0) }),
    });
    expect(stored.new).toEqual({ done: 1 });
  });

  it("logs (never throws) when the write fails — reconcileStatus self-heals", async () => {
    const tx: ProgressTxClient = { $executeRaw: vi.fn(async () => 1) };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      mergeProgressMap<{ done: number }>({
        tx,
        lockNamespace: 4242,
        lockKey: 1,
        read: async () => ({}),
        write: async () => {
          throw new Error("write failed");
        },
        mapKey: "a",
        delta: { done: 1 },
        reducer: () => ({ done: 1 }),
      }),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});
