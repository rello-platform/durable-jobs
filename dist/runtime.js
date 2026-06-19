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
export async function dispatchDrain(args) {
    const prefix = args.logPrefix ?? "[durable-jobs:dispatchDrain]";
    // Disambiguate by SHAPE, not function arity: the v0.1.0 by-id form ALWAYS
    // carries `taskId` (a required string) + `payload`; the thunk form carries
    // neither. Arity (`trigger.length`) is unreliable — a `vi.fn()` mock and many
    // bound callbacks report length 0 even for the (id, payload) form. The
    // presence of a string `taskId` is the stable discriminator.
    const isById = typeof args.taskId === "string"
        && "payload" in args;
    const label = typeof args.taskId === "string" && args.taskId.length > 0
        ? args.taskId
        : "drain task";
    try {
        if (isById) {
            const a = args;
            await a.trigger(a.taskId, a.payload);
        }
        else {
            await args.trigger();
        }
        return { dispatched: true };
    }
    catch (err) {
        // LOGGED catch — never silent, never thrown. The backstop recovers it.
        console.error(`${prefix} dispatch of "${label}" failed (backstop will recover): ${err instanceof Error ? err.message : String(err)}`);
        return { dispatched: false };
    }
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
export function assertEnvParity(args) {
    const prefix = args.logPrefix ?? "[durable-jobs:assertEnvParity]";
    const env = args.env ?? process.env;
    const placeholders = (args.placeholderValues ?? DEFAULT_PLACEHOLDERS).map((p) => p.toLowerCase());
    const missing = [];
    const placeholder = [];
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
        const parts = [];
        if (missing.length)
            parts.push(`missing: ${missing.join(", ")}`);
        if (placeholder.length)
            parts.push(`placeholder: ${placeholder.join(", ")}`);
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
//# sourceMappingURL=runtime.js.map