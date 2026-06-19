import { describe, it, expect, vi, afterEach } from "vitest";
import { dispatchDrain, assertEnvParity } from "./runtime.js";

afterEach(() => vi.restoreAllMocks());

describe("dispatchDrain", () => {
  it("calls the consumer-supplied trigger with taskId + payload", async () => {
    const trigger = vi.fn().mockResolvedValue({ id: "run_1" });
    const res = await dispatchDrain({
      trigger,
      taskId: "byol-commit-drain",
      payload: { batchId: "b1" },
    });
    expect(trigger).toHaveBeenCalledWith("byol-commit-drain", { batchId: "b1" });
    expect(res.dispatched).toBe(true);
  });

  it("logs (never throws) on a failed dispatch — the backstop recovers it", async () => {
    const trigger = vi.fn().mockRejectedValue(new Error("trigger.dev 503"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await dispatchDrain({
      trigger,
      taskId: "drain",
      payload: {},
    });
    expect(res.dispatched).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/dispatch of "drain" failed/));
  });
});

describe("assertEnvParity", () => {
  it("ok:true when every required var is present + non-placeholder", () => {
    const r = assertEnvParity({
      required: ["OVEN_API_KEY", "HH_TO_NS_KEY"],
      env: { OVEN_API_KEY: "real-key", HH_TO_NS_KEY: "another" },
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.placeholder).toEqual([]);
  });

  it("flags missing AND placeholder vars (report-only — does not throw)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = assertEnvParity({
      required: ["A", "B", "C"],
      env: { A: "ok", B: "", C: "placeholder" },
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("B");
    expect(r.placeholder).toContain("C");
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/ENV PARITY FAILURE/));
  });

  it("throwOnMissing:true throws on a gap (the must-be-present set)", () => {
    expect(() =>
      assertEnvParity({
        required: ["MUST_HAVE"],
        env: {},
        throwOnMissing: true,
      }),
    ).toThrow(/ENV PARITY FAILURE/);
  });

  it("treats custom placeholder values as missing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = assertEnvParity({
      required: ["K"],
      env: { K: "CHANGEME" },
      placeholderValues: ["changeme"],
    });
    expect(r.placeholder).toContain("K");
  });
});
