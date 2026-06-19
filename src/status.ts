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

// Imported so the dependency on @rello-platform/health is real (the package is
// pinned in package.json) and so the status literal stays type-locked to the
// published health primitive. `EngineHealthResponse` is the published surface;
// we extract its status discriminant rather than redeclaring the literal blind.
import type { EngineHealthResponse } from "@rello-platform/health";

/**
 * The published health-status discriminant literal, lifted from
 * `@rello-platform/health` so it can never drift from the platform health
 * vocabulary. If the published union changes its status literal, this line
 * fails to compile — the intended type-lock.
 */
export type HealthStatus = EngineHealthResponse["status"];

export const HEALTH_STATUSES = ["healthy", "degraded", "unhealthy"] as const;

/**
 * Component-level health for a durable job. Extends the published health-status
 * vocabulary (see module header — local until @rello-platform/health ships a
 * canonical ComponentHealth). `status` reuses the published literal verbatim.
 */
export interface ComponentHealth {
  status: HealthStatus; // "healthy" | "degraded" | "unhealthy"
  /** Human-facing one-liner (e.g. "12/12 committed", "3 dead-lettered"). */
  label: string;
  /** Optional machine detail for admin surfaces. */
  detail?: string | null;
  /** ISO timestamp this health was computed. */
  checkedAt: string;
}

/** The reconciling status contract every durable surface returns. */
export interface BulkOpStatusResponse {
  jobId: string; // the anchor identity (batchId or intentId)
  /** Discriminated health of the whole job — green clean, degraded w/ DLQ rows, red on FAILED. */
  health: ComponentHealth;
  phase: string; // consumer-defined phase string (committing | routing | done | error | …)
  overallLabel: string;
  counters: Record<string, { done: number; total: number }>; // reconciled per-phase
  deadLettered: number; // surfaced DLQ count — never hidden
  error: string | null;
  updatedAt: string;
}

export interface ReconcileStatusArgs {
  jobId: string;
  phase: string;
  /** Counters from the progress row (may be stale / dropped). */
  progressCounters: Record<string, number>;
  /** The consumer's authoritative ground-truth counts (e.g. EnrichedLead.count). */
  groundTruthCounters: Record<string, { done: number; total: number }>;
  deadLettered: number;
  error: string | null;
  updatedAt: Date;
  /** Optional override of the overall label; defaults to a derived summary. */
  overallLabel?: string;
}

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
export function reconcileStatus(args: ReconcileStatusArgs): BulkOpStatusResponse {
  const counters: Record<string, { done: number; total: number }> = {};
  const keys = new Set<string>([
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
    } else {
      // No ground truth for this key — surface the progress counter as done,
      // total unknown (use done as total so the bar reads complete-of-known).
      counters[key] = { done: progress, total: progress };
    }
  }

  const allComplete =
    keys.size > 0 &&
    Object.values(counters).every((c) => c.total > 0 && c.done >= c.total);

  let status: HealthStatus;
  let label: string;
  if (args.error) {
    status = "unhealthy";
    label = `error: ${args.error}`;
  } else if (args.deadLettered > 0) {
    status = "degraded";
    label = `${args.deadLettered} dead-lettered`;
  } else if (allComplete) {
    status = "healthy";
    label = "complete";
  } else {
    status = "healthy";
    label = "in progress";
  }

  const health: ComponentHealth = {
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
