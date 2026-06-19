import { defineConfig } from "vitest/config";

// Test-Runner Standard (~TEST-RUNNER-STANDARD-README §2): run-mode vitest only.
// `npm test` runs `vitest run --passWithNoTests` (see package.json). Real
// `.test.ts` with describe/it/expect — no top-level main(), no live DB writes
// (every test drives a stub BulkOpDelegate, never a real Prisma client).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
