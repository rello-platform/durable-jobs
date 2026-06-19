import { describe, it, expect } from "vitest";
import {
  DURABLE_INTENT_COLUMNS,
  DURABLE_INTENT_INDEXES,
  generateIntentModel,
} from "./column-template.js";

describe("column template", () => {
  it("the canonical column block carries every helper-operated column", () => {
    for (const col of [
      "id",
      "tenantId",
      "status",
      "payload",
      "idempotencyKey",
      "attempts",
      "attemptsPermanent",
      "maxAttempts",
      "maxAttemptsPermanent",
      "lastError",
      "nextRetryAt",
      "claimedUntil",
      "createdAt",
      "updatedAt",
      "completedAt",
    ]) {
      expect(DURABLE_INTENT_COLUMNS).toContain(col);
    }
  });

  it("ships the crash-recovery + drain-selection indexes", () => {
    expect(DURABLE_INTENT_INDEXES).toContain("@@index([status, nextRetryAt])");
    expect(DURABLE_INTENT_INDEXES).toContain("@@index([status, claimedUntil])");
    expect(DURABLE_INTENT_INDEXES).toContain("@@index([tenantId])");
  });

  it("generates a model with an inline @unique anchor + business cols + @@schema", () => {
    const m = generateIntentModel({
      modelName: "PendingByolCommit",
      anchor: "batchId String @unique",
      extraColumns: ["leads Json", "committedCount Int @default(0)"],
      schema: "harvest_home",
    });
    expect(m).toContain("model PendingByolCommit {");
    expect(m).toContain("batchId String @unique");
    expect(m).toContain("leads Json");
    expect(m).toContain("committedCount Int @default(0)");
    expect(m).toContain('@@schema("harvest_home")');
    expect(m).toContain("@@index([status, claimedUntil])");
    expect(m.trim().endsWith("}")).toBe(true);
  });

  it("supports a composite @@unique block anchor", () => {
    const m = generateIntentModel({
      modelName: "PendingByolAction",
      anchor: "@@unique([batchId, actionId])",
    });
    expect(m).toContain("@@unique([batchId, actionId])");
    expect(m).toContain("model PendingByolAction {");
  });

  it("omits the schema line for a single-schema consumer", () => {
    const m = generateIntentModel({
      modelName: "PendingThing",
      anchor: "key String @unique",
    });
    expect(m).not.toContain("@@schema");
  });
});
