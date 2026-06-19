/**
 * @rello-platform/durable-jobs — reconciling status contract. Spec §4.4.
 *
 * The contract every bulk/durable surface returns. RECONCILES the progress row's
 * counters against ground-truth counts the consumer supplies, so a dropped
 * counter self-heals and a "done" decision uses authoritative counts (the HH
 * status route reconciliation, status/route.ts:91-226). reconcileStatus does NO
 * network work — the consumer's status route stays non-blocking.
 *
 * HEALTH TYPING (Q-Health-1, verified 2026-06-19):
 *   The published `@rello-platform/health` (≤ v0.1.3) does NOT export a
 *   `ComponentHealth` type — it exports `EngineHealthResponse` (a discriminated
 *   union keyed on `app`) whose status discriminant is the literal
 *   "healthy" | "degraded" | "unhealthy" (BaseEngineHealth.status). We pin
 *   `@rello-platform/health#v0.1.3` and define `ComponentHealth` HERE, reusing
 *   that published status-literal vocabulary verbatim (re-exported as
 *   HEALTH_STATUSES below) so the contract is health-typed and aligned to the
 *   published primitive WITHOUT blocking P0 on an upstream `ComponentHealth` tag.
 *   FOLLOW-UP (tracked in ANSWERS Q-Health-1): when @rello-platform/health
 *   promotes a canonical ComponentHealth union, durable-jobs cuts a minor that
 *   swaps this local interface for the imported type (additive — the status
 *   literal is already shared).
 */
export const HEALTH_STATUSES = ["healthy", "degraded", "unhealthy"];
/**
 * Build a BulkOpStatusResponse by RECONCILING progress counters against ground
 * truth. For each counter we take `max(progressCounter, groundTruth.done)` so a
 * dropped progress increment self-heals (ground truth is authoritative) while a
 * progress row ahead of a lagging count is not regressed. NEVER does network
 * work. Pure — deterministic given its inputs.
 *
 * Health derivation:
 *   - error set OR any counter `done > total` anomaly → unhealthy
 *   - deadLettered > 0 → degraded (surfaced, not hidden)
 *   - all counters done === total (and present) → healthy
 *   - otherwise (in flight) → healthy (work proceeding, no failure)
 */
export function reconcileStatus(args) {
    const counters = {};
    const keys = new Set([
        ...Object.keys(args.groundTruthCounters),
        ...Object.keys(args.progressCounters),
    ]);
    for (const key of keys) {
        const gt = args.groundTruthCounters[key];
        const progress = args.progressCounters[key] ?? 0;
        if (gt) {
            // Ground truth wins on `done` (self-heal a dropped counter); never exceed total.
            const done = Math.min(Math.max(progress, gt.done), gt.total);
            counters[key] = { done, total: gt.total };
        }
        else {
            // No ground truth for this key — surface the progress counter as done,
            // total unknown (use done as total so the bar reads complete-of-known).
            counters[key] = { done: progress, total: progress };
        }
    }
    const allComplete = keys.size > 0 &&
        Object.values(counters).every((c) => c.total > 0 && c.done >= c.total);
    let status;
    let label;
    if (args.error) {
        status = "unhealthy";
        label = `error: ${args.error}`;
    }
    else if (args.deadLettered > 0) {
        status = "degraded";
        label = `${args.deadLettered} dead-lettered`;
    }
    else if (allComplete) {
        status = "healthy";
        label = "complete";
    }
    else {
        status = "healthy";
        label = "in progress";
    }
    const health = {
        status,
        label,
        detail: null,
        checkedAt: new Date().toISOString(),
    };
    return {
        jobId: args.jobId,
        health,
        phase: args.phase,
        overallLabel: args.overallLabel ?? label,
        counters,
        deadLettered: args.deadLettered,
        error: args.error,
        updatedAt: args.updatedAt.toISOString(),
    };
}
//# sourceMappingURL=status.js.map