import { describe, it, expect } from "vitest";
import { reconcileStatus, HEALTH_STATUSES } from "./status.js";

describe("reconcileStatus", () => {
  it("ground truth wins on done — a dropped progress counter self-heals", () => {
    const r = reconcileStatus({
      jobId: "b1",
      phase: "committing",
      progressCounters: { committed: 8 }, // progress lagged (dropped 4)
      groundTruthCounters: { committed: { done: 12, total: 12 } },
      deadLettered: 0,
      error: null,
      updatedAt: new Date("2026-06-19T00:00:00Z"),
    });
    expect(r.counters.committed).toEqual({ done: 12, total: 12 });
    expect(r.health.status).toBe("healthy");
    expect(r.health.label).toBe("complete");
  });

  it("never lets done exceed total", () => {
    const r = reconcileStatus({
      jobId: "b1",
      phase: "x",
      progressCounters: { committed: 999 },
      groundTruthCounters: { committed: { done: 5, total: 10 } },
      deadLettered: 0,
      error: null,
      updatedAt: new Date(),
    });
    expect(r.counters.committed.done).toBe(10);
  });

  it("progress ahead of a lagging ground-truth count is not regressed", () => {
    const r = reconcileStatus({
      jobId: "b1",
      phase: "x",
      progressCounters: { committed: 7 },
      groundTruthCounters: { committed: { done: 3, total: 10 } },
      deadLettered: 0,
      error: null,
      updatedAt: new Date(),
    });
    expect(r.counters.committed.done).toBe(7); // max(7,3) capped at total 10
  });

  it("dead-lettered rows surface as degraded — never hidden", () => {
    const r = reconcileStatus({
      jobId: "b1",
      phase: "done",
      progressCounters: { committed: 10 },
      groundTruthCounters: { committed: { done: 10, total: 10 } },
      deadLettered: 2,
      error: null,
      updatedAt: new Date(),
    });
    expect(r.health.status).toBe("degraded");
    expect(r.deadLettered).toBe(2);
    expect(r.health.label).toContain("2 dead-lettered");
  });

  it("an error → unhealthy", () => {
    const r = reconcileStatus({
      jobId: "b1",
      phase: "error",
      progressCounters: {},
      groundTruthCounters: {},
      deadLettered: 0,
      error: "drain crashed",
      updatedAt: new Date(),
    });
    expect(r.health.status).toBe("unhealthy");
    expect(r.error).toBe("drain crashed");
  });

  it("in-flight (not all complete) → healthy 'in progress'", () => {
    const r = reconcileStatus({
      jobId: "b1",
      phase: "committing",
      progressCounters: { committed: 3 },
      groundTruthCounters: { committed: { done: 3, total: 10 } },
      deadLettered: 0,
      error: null,
      updatedAt: new Date(),
    });
    expect(r.health.status).toBe("healthy");
    expect(r.health.label).toBe("in progress");
  });

  it("emits a valid health.status from the published vocabulary + an ISO updatedAt", () => {
    const r = reconcileStatus({
      jobId: "b1",
      phase: "x",
      progressCounters: {},
      groundTruthCounters: {},
      deadLettered: 0,
      error: null,
      updatedAt: new Date("2026-06-19T12:34:56Z"),
    });
    expect(HEALTH_STATUSES).toContain(r.health.status);
    expect(r.updatedAt).toBe("2026-06-19T12:34:56.000Z");
    expect(typeof r.health.checkedAt).toBe("string");
  });
});
