/**
 * @rello-platform/durable-jobs/testing — public test-helper surface (v0.1.1).
 *
 * Imported as a SUBPATH:
 *
 *   import { FakeDelegate, TrackingDelegate, assertBulkEndpointScales }
 *     from "@rello-platform/durable-jobs/testing";
 *
 * In-memory, never-touches-a-real-DB helpers for exercising the durable
 * primitive in a consumer's own vitest/jest suite (Test-Runner Standard §2):
 *
 *  - `FakeDelegate`     — in-memory `BulkOpDelegate` stub (atomic-ish updateMany
 *                         WHERE prev_state, the `in`/date-range/`equals`/payload
 *                         -path operators the helpers use). Seed rows, drive any
 *                         helper, assert the resulting status machine.
 *  - `FakeDlqDelegate`  — minimal create-only DLQ-table stub (P2002 / generic
 *                         throw injection) for `writeDlq` tests.
 *  - `TrackingDelegate` — wraps any `BulkOpDelegate` and tallies per-method IO so
 *                         a test can assert request-path DB writes stay bounded.
 *  - `assertBulkEndpointScales` — sweep an enqueue closure across a range of N
 *                         and verify per-request writes never grow with N (the
 *                         Rello scale-harness contract).
 *
 * This entry is build-output `dist/testing/index.js` (+ `.d.ts`) and is wired in
 * package.json `exports["./testing"]`. It is test-only — import it from `*.test`
 * / spec files, never from production code.
 */

export { FakeDelegate, FakeDlqDelegate } from "./fake-delegate.js";
export type { FakeDelegateOptions } from "./fake-delegate.js";

export {
  TrackingDelegate,
  assertBulkEndpointScales,
} from "./io-tracker.js";
export type {
  IoCounts,
  ScaleSample,
  AssertBulkEndpointScalesArgs,
  AssertBulkEndpointScalesResult,
} from "./io-tracker.js";
