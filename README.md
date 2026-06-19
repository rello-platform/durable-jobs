# @rello-platform/durable-jobs

Runtime-agnostic **durable async-work primitive** for the Rello platform — the blessed shape for any bulk / at-scale / fire-and-forget operation that must NOT run synchronously inside an HTTP request handler.

It is the union of two production-proven implementations:

- the **PathfinderPro `RelloSyncQueue` gold-standard** — claim-TTL **PROCESSING crash-recovery** (the 25k-stuck-row fix) + **coalescing enqueue** (the 280k-row-explosion fix), both **MANDATORY CORE** here (Kelly D1, 2026-06-19);
- the **Harvest Home BYOL reference** — `EMPTY` / `DEAD_LETTER` terminals, a cross-instance ordering `gate`, and a **reconciling, health-typed status contract**.

The package owns the **logic** (idempotent+coalescing enqueue, atomic claim + chunked off-request drain, atomic progress, DLQ ladder, dual-dispatch + env-parity) and the **contracts** (`BulkOpStatusResponse` + `ComponentHealth`). It is parameterized over **your** Prisma model + Trigger.dev tasks, so it never hardcodes a schema, a `@@schema`, an SDK version, or a cron.

It ships **NO** concrete Prisma model, **NO** Trigger.dev task definition, **NO** cron, and **NO** React component (P0). You wire those; the package supplies the durable core.

---

## Install (pin convention)

Consumed as a **git dep** (`~PLATFORM-PACKAGE-PIN-CONVENTION-README.md` §3). Pin a fixed tag — never a floating ref:

```jsonc
// package.json
"@rello-platform/durable-jobs": "github:rello-platform/durable-jobs#v0.1.1"
```

`@trigger.dev/sdk` and `@prisma/client` are **optional peerDependencies** — the package never imports them directly (it takes `prisma.<model>` and `tasks.trigger` as parameters), so it never forces a runtime/CLI version on you. You own the pins (and the CLI-pin = SDK-pin rule).

`dist/` is committed; there is **no** `prepare`/`postinstall` (that would force a `git+ssh` clone-build and break every consumer's Railway `npm install`). Tag = publish: `git tag vX.Y.Z && git push origin vX.Y.Z`.

---

## 1. The durable-intent table (you own the model)

The package can't ship a Prisma model (models live in your `schema.prisma` with your `@@schema`). It ships the **canonical column set** the helpers operate over, as a copy-paste template + a generator (`generateIntentModel`). Paste these columns into your model, add your business columns + your `@unique` anchor + your `@@schema`:

```prisma
model PendingByolCommit {
  id             String   @id @default(cuid())
  tenantId       String                                   // tenant isolation — every helper filters on this
  status         String   @default("PENDING")             // BulkOpStatus (string-typed; you MAY mirror as a Prisma enum)
  payload        Json                                     // replay payload — the drain reads everything here, NEVER the request body
  idempotencyKey String?  @db.VarChar(255)                // carried on replay; P2002 -> deduped
  attempts          Int   @default(0)                     // transient (5xx) attempt counter
  attemptsPermanent Int   @default(0)                     // 4xx / permanent-error counter (PFP 400-vs-5xx split)
  maxAttempts          Int @default(5)
  maxAttemptsPermanent Int @default(3)
  lastError      String?  @db.Text
  nextRetryAt    DateTime @default(now())                 // exp-backoff gate; drain selects WHERE nextRetryAt <= now
  claimedUntil   DateTime?                                // atomic claim TTL; PROCESSING reclaimable after this (crash recovery)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  completedAt    DateTime?

  // Your @unique anchor — the idempotency key (choose one):
  batchId        String   @unique                         // OR @@unique([batchId, actionId]) OR @@unique([tenantId, idempotencyKey])
  leads          Json                                     // your business columns
  committedCount Int      @default(0)

  @@index([status, nextRetryAt])         // drain selection
  @@index([status, claimedUntil])        // stale-claim recovery (crash recovery)
  @@index([tenantId])
  @@schema("harvest_home")               // your @@schema (omit if single-schema)
}
```

`generateIntentModel({ modelName, anchor, extraColumns, schema })` produces this block programmatically. A consumer that mirrors `BulkOpStatus` as a Prisma `enum` MUST import the `BULK_OP_STATUSES` literal array and assert the enum is a superset (Type discipline — never redeclare the literal set).

---

## 2. The shape, end to end

```ts
import {
  enqueueBulkOp, drainBulkOp, drainBulkOpBatch, resetStaleClaims,
  advanceProgress, reconcileStatus,
  dispatchDrain, assertEnvParity,
  BulkOpTransientError, BulkOpPermanentError, writeDlq,
} from "@rello-platform/durable-jobs";
```

### 2.1 Enqueue (in your API route — persist-first, return fast)

```ts
const { intentId } = await enqueueBulkOp({
  delegate: prisma.pendingByolCommit,        // your model delegate
  anchor: { batchId },                       // the @unique idempotency key
  tenantId: session.tenantId,                // REQUIRED — tenant isolation
  payload: { leads },                        // the drain reads THIS, never the request body
  coalesceOn: { payload: { path: ["intakeId"], equals: intakeId } }, // optional — collapse redundant work
});
// Two dispatch forms (v0.1.1) — pick whichever types cleanly against your SDK pin:
await dispatchDrain({ trigger: (id, p) => tasks.trigger(id, p), taskId: "byol-commit-drain", payload: { batchId } });
// …or the PRE-BOUND THUNK form — keeps full `tasks.trigger<typeof task>(...)` typing,
//    avoids the literal-task-id-vs-`string` TS2345 the callback form hits:
await dispatchDrain({ trigger: () => tasks.trigger<typeof byolCommitDrain>(byolCommitDrain.id, { batchId }) });
return Response.json({ queued: true });      // returns under the edge cap regardless of N
```

`enqueueBulkOp` is idempotent on `anchor` (a second call → `{ alreadyInFlight: true }`, no second row), recycles a terminal-`FAILED` row, and — when `coalesceOn` is set — skips the insert if an existing `PENDING|PROCESSING` row already covers the work. It NEVER does the work and NEVER silently drops an enqueue (a real infra failure rethrows so your route try/catch returns 500).

### 2.2 Drain (in your Trigger.dev task — off the request path)

```ts
// Type the 4th param to thread YOUR business columns onto every hook's `intent`:
type ByolIntent = BulkOpIntent<{ batchId: string; agentId: string }>;
const result = await drainBulkOp<{ leads: Lead[] }, Lead, CommitResult, ByolIntent>({
  delegate: prisma.pendingByolCommit,        // a real Prisma delegate fits structurally (v0.1.1)
  intentId: payload.batchId,                 // or look it up by anchor first
  chunkSize: 25,                             // default 25
  selectItems: (p) => p.leads,               // pull items from the PERSISTED payload
  processItem: async (lead) => {             // process ONE item, error-isolated
    const r = await relloClient.createLead(lead);
    if (!r.ok && r.status >= 400 && r.status < 500) throw new BulkOpPermanentError(`bad lead: ${r.status}`);
    if (!r.ok) throw new BulkOpTransientError(`rello 5xx: ${r.status}`);
    return r.body;
  },
  // v0.1.1: the CLAIMED intent is threaded to onChunk/onComplete — read your
  // progress key (intent.batchId) off it, NO extra PK read, NO `intent as {...}`:
  onChunk: async (results, { size }, intent) =>
    advanceProgress({ progressDelegate: prisma.batchProgress, where: { batchId: intent.batchId }, increments: { committedCount: results.length } }),
  onComplete: async (all, intent) => { /* emit signals for intent.batchId, finalize batch status */ },
  onClaim: async (intent) => { /* fire your SYSTEM audit signal here — see §5 */ },
  mustNeverDrop: false,                       // true → DEAD_LETTER instead of FAILED at exhaustion
});
```

The atomic claim (`updateMany WHERE prev_state`) is the only race-free claim — concurrent drains see `claim.count === 0` and no-op. A claimed row gets `claimedUntil = now + ttl` (default 15 min); a **crashed runner's** `PROCESSING` row is reclaimable once that TTL expires (the claim WHERE-clause carries the `{ status:"PROCESSING", claimedUntil:{ lt: now } }` branch). Partial item failures are your row-level DLQ concern (capture them in `processItem`); the intent COMPLETEs if any item succeeded.

### 2.3 Backstop (your scheduled task — recovers lost dispatches + stale claims)

```ts
export const byolCommitDrainBackstop = schedules.task({
  id: "byol-commit-drain-backstop",
  cron: "*/10 * * * *",                       // see §4 — */10 clustered, NOT */5
  run: async () => {
    await resetStaleClaims({ delegate: prisma.pendingByolCommit }); // MANDATORY first step (crash recovery)
    return drainBulkOpBatch({
      delegate: prisma.pendingByolCommit,
      where: { status: { in: ["PENDING", "WAITING"] }, nextRetryAt: { lte: new Date() } },
      drainOne: (id) => drainBulkOp({ /* same args as 2.2, bound to id */ }),
    });
  },
});
```

### 2.4 Status (your status route — non-blocking, reconciling)

```ts
const progress = await prisma.batchProgress.findUnique({ where: { batchId } });
const deadLettered = await prisma.pendingByolCommit.count({ where: { batchId, status: "DEAD_LETTER" } });
return Response.json(reconcileStatus({
  jobId: batchId,
  phase: progress?.phase ?? "committing",
  progressCounters: { committed: progress?.committedCount ?? 0 },
  groundTruthCounters: { committed: { done: await prisma.lead.count({ where: { batchId } }), total } }, // authoritative
  deadLettered,
  error: null,
  updatedAt: progress?.updatedAt ?? new Date(),
}));
```

`reconcileStatus` takes `max(progressCounter, groundTruth.done)` so a dropped progress increment **self-heals** against authoritative counts. It does NO network work — your status route stays non-blocking. `health` is typed `ComponentHealth` (status reuses the `@rello-platform/health` `"healthy" | "degraded" | "unhealthy"` vocabulary): green clean, **degraded** with dead-lettered rows (surfaced, never hidden), red on error.

---

## 3. Neon + `ws` (consumer responsibility — the package does NOT ship the polyfill)

If your Trigger.dev tasks read/write a Neon DB via `@neondatabase/serverless` pooler-mode, **you** must install the WebSocket polyfill at your single Prisma init point — the package can't (it never imports your Prisma client). Place this at your Prisma init point (verbatim from `~TRIGGER-DEV-NEON-RUNTIME-README.md` §2):

```ts
import { neonConfig } from "@neondatabase/serverless";

if (!neonConfig.webSocketConstructor) {
  if (typeof globalThis.WebSocket !== "undefined") {
    neonConfig.webSocketConstructor = globalThis.WebSocket as unknown as typeof neonConfig.webSocketConstructor;
  } else {
    // `eval("require")` keeps the bare require call out of webpack/turbopack static analysis.
    neonConfig.webSocketConstructor = eval("require")("ws") as typeof neonConfig.webSocketConstructor;
  }
}
```

…and declare `ws` to the Trigger.dev bundler (`~TRIGGER-DEV-NEON-RUNTIME-README.md` §3):

```ts
// trigger.config.ts
build: { extensions: [prismaExtension({ mode: "legacy" }), additionalPackages({ packages: ["ws"] })] }
```

Add `ws@^8.20.1` + `@types/ws@^8.18.1` to your `package.json`. Pin `runtime: "node-22"` in `trigger.config.ts`; deploy with the CLI matching your SDK pin exactly (`npx trigger.dev@<sdk-version> deploy`, never `@latest`). If you do NOT use Neon serverless, skip this section.

---

## 4. Cron cadence (Neon HR-2 — `*/10` clustered, NOT `*/5`)

The package ships **no cron** — you wire `resetStaleClaims` + `drainBulkOpBatch` into your own backstop `schedules.task`. That backstop is a **legitimate cron** — its commit message must name the write-time-unreachable invariant it enforces:

> *Recovers a fire-and-forget enqueue whose Trigger.dev event-dispatch failed. The dispatch happens AFTER the DB commit, off the request path — so "the dispatch succeeded" is write-time-unreachable. The backstop also resets claims orphaned by a runner that died mid-loop — "the runner is still alive" is likewise not checkable at claim-write time.*

**Mandate for new consumers:** backstops run **no tighter than `*/10`**, **clustered on the `:00/:10/:20` boundary** with your other DB-touching crons, **count-first idle-skip** (`drainBulkOpBatch` selects with `take` and returns early on zero candidates before any write). Do NOT add a sub-5-min DB cron (Neon autosuspend cost). *(The HH BYOL reference runs `*/5` — a known grandfathered deviation that converges to `*/10` on its P2 re-home.)*

---

## 5. Audit-split (the package writes NO audit row)

Audit is the consumer's concern (Rello owns the canonical `AuditLog` per the App Ownership Matrix). The `drainBulkOp({ onClaim })` hook is the **synchronous-in-handler** point where you fire the enqueue-time SYSTEM audit — emit your canonical `<appslug>.audit.<scope>.<action>` signal there. A throwing `onClaim` logs but never aborts the drain. The package itself never writes an audit row.

---

## 6. Env parity (kills the silent-401 class)

`assertEnvParity` fails LOUD at task-module init if a var your drain reads is absent/placeholder in the CURRENT runtime — catching the Trigger.dev-env ≠ Railway-env gap (the 29-day, 548-signal silent outage). Report-only by default (a thrown task-init bricks the worker); `throwOnMissing: true` for the must-be-present set.

```ts
// at the top of your drain task module
assertEnvParity({ required: ["OVEN_API_KEY", "HARVEST_HOME_TO_NEWSLETTER_STUDIO_API_KEY"] });
```

A key present in Railway can be absent in the Trigger.dev project env (and vice versa) — mirror via the Trigger.dev envvar REST API; no redeploy needed for an env-only change.

---

## 7. N=1 per-emit mode (the Milo `UsageReportDLQ` degenerate case)

For single-emit durable work where the receiver is idempotent on `idempotencyKey` (no claim needed), pass `claim: false` and a required `idempotencyKey` on enqueue. The drain processes directly without the atomic-claim machinery; double-send is a safe no-op at the idempotent receiver.

---

## 8. Testing helpers (`/testing` subpath)

Import the in-memory test helpers from the `@rello-platform/durable-jobs/testing` **subpath** — they never touch a real DB (Test-Runner Standard §2), so a consumer's vitest/jest suite can exercise the durable primitive against a stub delegate:

```ts
import {
  FakeDelegate,           // in-memory BulkOpDelegate stub — seed rows, drive any helper
  FakeDlqDelegate,        // create-only DLQ-table stub (P2002 / throw injection) for writeDlq
  TrackingDelegate,       // wraps any BulkOpDelegate, tallies per-method DB IO
  assertBulkEndpointScales, // sweep enqueue across N, assert request-path writes stay bounded
} from "@rello-platform/durable-jobs/testing";
```

`assertBulkEndpointScales` is the scale-harness contract: it runs your enqueue closure across a sweep of item counts and verifies the per-request **write** count never grows with N (the whole point of the durable shape — persist one intent, return; the drain does per-item work off-request). It catches the regression where a per-item INSERT loop leaks back into the handler:

```ts
const res = await assertBulkEndpointScales({
  sizes: [1, 10, 100, 1000],
  enqueue: async (delegate, n) =>
    enqueueBulkOp({ delegate, anchor: { batchId: `b-${n}` }, tenantId: "t1", payload: { leads: makeN(n) } }),
});
expect(res.ok).toBe(true);              // writes stayed constant (1) across every N
```

`TrackingDelegate` wraps any delegate (the `FakeDelegate`, or your real Prisma delegate in an integration test) and exposes `.counts` (per-method call counts + `writes`/`total`). Import these ONLY from test/spec files — they are not part of the production surface.

---

## Public API

### Root entry — `@rello-platform/durable-jobs`

| Symbol | Purpose |
|---|---|
| `BulkOpStatus`, `BulkOpIntent<TExtra>`, `BulkOpDelegate` (types) | the intent contract + the delegate you parameterize. `BulkOpIntent<TExtra>` (v0.1.1) types your business columns onto the threaded intent |
| `asBulkOpDelegate` | typed identity cast-helper (v0.1.1) — `delegate: asBulkOpDelegate(prisma.x)` instead of `as unknown as` (a real Prisma delegate is now structurally assignable, so usually unneeded) |
| `TERMINAL_STATUSES`, `CLAIMABLE_STATUSES`, `BULK_OP_STATUSES`, `isTerminalStatus`, `isClaimableStatus` | status-machine constants/guards |
| `DURABLE_INTENT_COLUMNS`, `DURABLE_INTENT_INDEXES`, `generateIntentModel` | the Prisma column template |
| `enqueueBulkOp` | idempotent + coalescing persist-first enqueue |
| `drainBulkOp`, `drainBulkOpBatch`, `resetStaleClaims` | atomic claim + chunked drain + crash-recovery |
| `advanceProgress`, `mergeProgressMap`, `advisoryLockKey` | atomic progress |
| `reconcileStatus`, `BulkOpStatusResponse`, `ComponentHealth`, `HealthStatus`, `HEALTH_STATUSES` | the reconciling status contract |
| `BulkOpTransientError`, `BulkOpPermanentError`, `classifyFailure`, `writeDlq`, `isPermanentError`, `isUniqueViolation` | DLQ ladder + typed errors |
| `dispatchDrain`, `assertEnvParity` | Trigger.dev dual-dispatch (by-id OR pre-bound-thunk form, v0.1.1) + env-parity |

Tuning constants: `DEFAULT_CLAIM_TTL_MS` (15 min), `DEFAULT_CHUNK_SIZE` (25), `DEFAULT_SCAN_LIMIT` (50), `DEFAULT_BACKOFF_BASE_MS` (30s), `DEFAULT_BACKOFF_CAP_MS` (8 min).

### Testing entry — `@rello-platform/durable-jobs/testing` (v0.1.1)

| Symbol | Purpose |
|---|---|
| `FakeDelegate`, `FakeDlqDelegate` | in-memory `BulkOpDelegate` / DLQ-table stubs (never a real DB) |
| `TrackingDelegate` | wraps any delegate, tallies per-method DB IO (`.counts`) |
| `assertBulkEndpointScales` | sweep enqueue across N, assert request-path writes stay bounded |

---

## Provenance

Spec: `BUILD-|-WORKSTREAM/PLATFORM-DURABLE-BULK-OPERATION-FRAMEWORK/_SPEC-FEATURE.md` §4. Durability bar = PathfinderPro `RelloSyncQueue` gold-standard (ANSWERS D1). PFP grounding: crash-recovery `src/trigger/rello-sync-queue-drain.ts:108-120`; coalescing `src/lib/rello-sync-queue.ts:82-106`. HH BYOL reference @ `dd8aee0`. P0 is the foundation; P1 adds the hardening pillars (scale-test, env-parity manifest, e2e, then observability + contract tests), P2 migrates the 22 flows, P3 codifies the anti-pattern into law.
