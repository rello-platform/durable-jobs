/**
 * @rello-platform/durable-jobs — Trigger.dev / Neon runtime helpers. Spec §4.6.
 *
 * - `dispatchDrain`: standard dual-dispatch (the API kicks the drain task; the
 *   scheduled backstop recovers a lost dispatch). Logged catch — a failed kick
 *   is NOT thrown back into the request (the backstop is the safety net), but it
 *   IS logged so the failure is visible.
 * - `assertEnvParity`: boot-time env-parity assertion that kills the silent-401
 *   class (the 29-day-548-lost-signal incident). Report-only by default (the PFP
 *   self-check precedent — a thrown task-init bricks the worker); throwOnMissing
 *   for the must-be-present set.
 *
 * The package declares `@trigger.dev/sdk` as an OPTIONAL peer and NEVER imports
 * it — `dispatchDrain` takes `tasks.trigger` as a function so the package is
 * runtime-agnostic and never forces an SDK/CLI version on a consumer.
 *
 * The package does NOT ship the Neon `ws` polyfill — see README "Neon + ws".
 */
/**
 * Dual-dispatch: kick the off-request drain task. The consumer passes
 * `tasks.trigger` (or `taskInstance.trigger`) so the package never imports the
 * SDK. A failed dispatch is logged (never thrown) — the scheduled backstop
 * recovers it (the dispatch happening AFTER the DB commit is write-time-
 * unreachable, which is exactly why the backstop is a legitimate cron).
 */
export declare function dispatchDrain(args: {
    trigger: (taskId: string, payload: unknown) => Promise<unknown>;
    taskId: string;
    payload: unknown;
    logPrefix?: string;
}): Promise<{
    dispatched: boolean;
}>;
export interface AssertEnvParityArgs {
    /** Env var names that MUST be present (non-empty, non-placeholder) in the CURRENT runtime. */
    required: string[];
    /** Values treated as missing (default ["", "placeholder", "changeme", "TODO"]). */
    placeholderValues?: string[];
    /** When true, THROW on any missing/placeholder var. Default false (report-only — PFP precedent). */
    throwOnMissing?: boolean;
    /** Source of env values (default process.env). Injectable for testing. */
    env?: Record<string, string | undefined>;
    logPrefix?: string;
}
export interface AssertEnvParityResult {
    ok: boolean;
    missing: string[];
    placeholder: string[];
}
/**
 * Boot-time env-parity assertion. A consumer declares the env vars its drain
 * reads; this fails LOUD at task-module init (or service boot) if any are
 * absent/placeholder in the CURRENT runtime — catching the Trigger.dev-env ≠
 * Railway-env gap that caused the 29-day silent-401 outage.
 *
 * Report-only by default: logs the diff, returns { ok:false }, does NOT throw
 * (a thrown task-init bricks the Trigger.dev worker — PFP reportSelfCheck
 * precedent). Pass throwOnMissing:true for the must-be-present set.
 */
export declare function assertEnvParity(args: AssertEnvParityArgs): AssertEnvParityResult;
//# sourceMappingURL=runtime.d.ts.map