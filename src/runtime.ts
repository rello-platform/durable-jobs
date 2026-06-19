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
 * Args for the v0.1.0 (taskId + payload) form of `dispatchDrain`. The consumer
 * passes a `trigger(taskId, payload)` callback — the shape of `tasks.trigger`.
 */
export interface DispatchDrainByIdArgs {
  /** A `(taskId, payload) => Promise` callback — typically `tasks.trigger`. */
  trigger: (taskId: string, payload: unknown) => Promise<unknown>;
  taskId: string;
  payload: unknown;
  logPrefix?: string;
}

/**
 * Args for the v0.1.1 (ergo-fix 2) PRE-BOUND-THUNK form of `dispatchDrain`. The
 * consumer passes a zero-arg thunk that already closes over the typed trigger
 * call — e.g. `() => tasks.trigger<typeof drainTask>(drainTask.id, { batchId })`.
 *
 * Why this exists: the v0.1.0 `trigger: (taskId: string, …) => …` callback
 * collides with the SDK's typed `tasks.trigger<typeof task>(literalTaskId, …)`
 * — the SDK requires the literal task id, not a widened `string`, so wiring the
 * callback form fights TS2345. Pre-binding the call into a thunk lets the
 * consumer keep full SDK typing and hand `dispatchDrain` an already-bound fn.
 */
export interface DispatchDrainThunkArgs {
  /** Pre-bound zero-arg dispatch thunk — closes over the typed `tasks.trigger(...)` call. */
  trigger: () => Promise<unknown>;
  /** Optional label for the log line (defaults to "drain task"). Purely cosmetic. */
  taskId?: string;
  logPrefix?: string;
}

/**
 * Dual-dispatch: kick the off-request drain task. A failed dispatch is logged
 * (never thrown) — the scheduled backstop recovers it (the dispatch happening
 * AFTER the DB commit is write-time-unreachable, which is exactly why the
 * backstop is a legitimate cron). The package never imports the Trigger.dev SDK;
 * the consumer hands it the trigger call.
 *
 * Two forms (both backward-compatible):
 *  - v0.1.0: `dispatchDrain({ trigger: (id, p) => tasks.trigger(id, p), taskId, payload })`
 *  - v0.1.1: `dispatchDrain({ trigger: () => tasks.trigger<typeof task>(task.id, p) })`
 *    — pass a pre-bound thunk; no `taskId`/`payload` required (the thunk closes
 *    over them). This avoids the literal-task-id vs widened-`string` TS2345.
 */
export function dispatchDrain(
  args: DispatchDrainByIdArgs,
): Promise<{ dispatched: boolean }>;
export function dispatchDrain(
  args: DispatchDrainThunkArgs,
): Promise<{ dispatched: boolean }>;
export async function dispatchDrain(
  args: DispatchDrainByIdArgs | DispatchDrainThunkArgs,
): Promise<{ dispatched: boolean }> {
  const prefix = args.logPrefix ?? "[durable-jobs:dispatchDrain]";
  // Disambiguate by SHAPE, not function arity: the v0.1.0 by-id form ALWAYS
  // carries `taskId` (a required string) + `payload`; the thunk form carries
  // neither. Arity (`trigger.length`) is unreliable — a `vi.fn()` mock and many
  // bound callbacks report length 0 even for the (id, payload) form. The
  // presence of a string `taskId` is the stable discriminator.
  const isById = typeof (args as DispatchDrainByIdArgs).taskId === "string"
    && "payload" in args;
  const label =
    typeof args.taskId === "string" && args.taskId.length > 0
      ? args.taskId
      : "drain task";
  try {
    if (isById) {
      const a = args as DispatchDrainByIdArgs;
      await a.trigger(a.taskId, a.payload);
    } else {
      await (args as DispatchDrainThunkArgs).trigger();
    }
    return { dispatched: true };
  } catch (err) {
    // LOGGED catch — never silent, never thrown. The backstop recovers it.
    console.error(
      `${prefix} dispatch of "${label}" failed (backstop will recover): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { dispatched: false };
  }
}

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

const DEFAULT_PLACEHOLDERS = ["", "placeholder", "changeme", "TODO"];

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
export function assertEnvParity(args: AssertEnvParityArgs): AssertEnvParityResult {
  const prefix = args.logPrefix ?? "[durable-jobs:assertEnvParity]";
  const env = args.env ?? (process.env as Record<string, string | undefined>);
  const placeholders = (args.placeholderValues ?? DEFAULT_PLACEHOLDERS).map((p) =>
    p.toLowerCase(),
  );

  const missing: string[] = [];
  const placeholder: string[] = [];

  for (const name of args.required) {
    const raw = env[name];
    if (raw === undefined || raw === null || raw.trim() === "") {
      missing.push(name);
      continue;
    }
    if (placeholders.includes(raw.trim().toLowerCase())) {
      placeholder.push(name);
    }
  }

  const ok = missing.length === 0 && placeholder.length === 0;

  if (!ok) {
    const parts: string[] = [];
    if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
    if (placeholder.length) parts.push(`placeholder: ${placeholder.join(", ")}`);
    const msg = `${prefix} ENV PARITY FAILURE in current runtime — ${parts.join("; ")}. ` +
      `A key present in Railway can be absent/placeholder in the Trigger.dev project env (and vice versa); ` +
      `mirror via the Trigger.dev envvar REST API. This is the silent-401 class.`;
    if (args.throwOnMissing) {
      throw new Error(msg);
    }
    console.error(msg);
  }

  return { ok, missing, placeholder };
}
