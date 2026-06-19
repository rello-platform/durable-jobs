# Changelog

All notable changes to `@rello-platform/durable-jobs`.

## v0.1.1

Ergonomics pass — five gaps the two proof consumers (Newsletter-Studio import + the Rello scale harness) surfaced while wiring v0.1.0. **All changes are backward-compatible: every v0.1.0 call site compiles unchanged against v0.1.1.**

### Added

- **`./testing` subpath export** — `@rello-platform/durable-jobs/testing` now exposes the in-memory test helpers (compiled to `dist/testing/`):
  - `FakeDelegate`, `FakeDlqDelegate` — the in-memory `BulkOpDelegate` / DLQ-table stubs (relocated from the private `src/__test-helpers__/` into the public `src/testing/`).
  - `TrackingDelegate` — wraps any `BulkOpDelegate` and tallies per-method DB IO (`.counts` → `writes`/`total` + per-method counts).
  - `assertBulkEndpointScales` — sweeps an enqueue closure across a range of item counts and asserts request-path **writes** stay bounded (never grow with N) — the Rello scale-harness contract. Catches a per-item INSERT loop leaking back into the handler.
- **`asBulkOpDelegate(prisma.x)`** — typed identity cast-helper for the structural delegate boundary, so consumers can write `delegate: asBulkOpDelegate(prisma.model)` instead of `as unknown as BulkOpDelegate`.
- **`DispatchDrainByIdArgs` / `DispatchDrainThunkArgs`** types + **`DrainChunkRange`** type exported.

### Changed (backward-compatible)

1. **`dispatchDrain` accepts a pre-bound trigger thunk.** New overload: `dispatchDrain({ trigger: () => tasks.trigger<typeof task>(task.id, payload) })`. The v0.1.0 callback form's `trigger: (taskId, payload) => …` collided with the SDK's typed `tasks.trigger<typeof task>(literalId, …)` (literal-task-id vs widened `string` → TS2345). The thunk form lets a consumer pre-bind the fully-typed call. The v0.1.0 `{ trigger, taskId, payload }` form is unchanged and still works (disambiguated by argument SHAPE — presence of `taskId` + `payload` — not by function arity, so a `vi.fn()` mock with `.length === 0` is no longer misread).

2. **`BulkOpIntent<TExtra = {}>` is now generic.** Consumers type their business columns — `BulkOpIntent<{ batchId: string; userId: string }>` — so reading them off a threaded `intent` compiles without `intent as {...}`. The default param `{}` keeps every v0.1.0 `BulkOpIntent` reference identical.

3. **A real Prisma delegate is assignable to `BulkOpDelegate` without `as unknown as`.** The delegate method return types are now `PromiseLike<T>` (not `Promise<T>`), so Prisma's awaitable-but-not-a-Promise `Prisma__ModelClient<T>` thenable fits; method-syntax members are checked bivariantly so Prisma's narrower model-specific arg types are accepted at the structural boundary. The supported delegate shape is documented inline in `src/types.ts`.

4. **The claimed `intent` is threaded to `onChunk` / `onComplete`.** `onChunk(results, range, intent)` and `onComplete(results, intent)` now receive the already-loaded, claimed intent as an appended argument, so consumers resolve their progress key (e.g. `intent.batchId`) WITHOUT an extra PK read per chunk. Appending the arg is type-compatible — a v0.1.0 `(results, range) => …` / `(results) => …` callback that ignores it still compiles.

### Internal

- Test helpers moved `src/__test-helpers__/` → `src/testing/`; the three in-repo test files updated to the new import path.
- `tsconfig.json` no longer excludes the (now-removed) `__test-helpers__` dir; `src/testing/` non-test files compile into `dist/testing/`.
- 20 new tests (86 total, all green).

## v0.1.0

Initial release. Runtime-agnostic durable bulk-operation primitive — idempotent + coalescing enqueue, atomic-claim + chunked off-request drain with claim-TTL crash-recovery, atomic progress, reconciling health-typed status, DLQ ladder, dual-dispatch + env-parity. The blessed bulk/at-scale shape (PFP `RelloSyncQueue` gold-standard + HH BYOL reference, unified).
