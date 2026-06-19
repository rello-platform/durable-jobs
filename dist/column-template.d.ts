/**
 * @rello-platform/durable-jobs — the canonical Prisma column template. Spec §4.1.
 *
 * The package CANNOT ship a Prisma model directly (models live in the consumer's
 * schema.prisma with the consumer's @@schema). Instead it ships the canonical
 * column set as a copy-paste snippet + a generator so a consumer pastes exactly
 * the columns the helpers operate over, then adds business columns + @@schema +
 * the @unique anchor of its choice.
 */
/** The verbatim canonical column block (helpers operate over EXACTLY these). */
export declare const DURABLE_INTENT_COLUMNS: "  id             String   @id @default(cuid())\n  tenantId       String                                   // tenant isolation \u2014 every helper filters on this\n  status         String   @default(\"PENDING\")             // BulkOpStatus (string-typed; a consumer MAY mirror as a Prisma enum and assert superset)\n  payload        Json                                     // replay payload \u2014 the off-request work reads everything here, never the request body\n  idempotencyKey String?  @db.VarChar(255)                // carried on replay; P2002 -> deduped\n  attempts          Int   @default(0)                     // transient (5xx) attempt counter\n  attemptsPermanent Int   @default(0)                     // 4xx / permanent-error counter (PFP 400-vs-5xx split)\n  maxAttempts          Int @default(5)\n  maxAttemptsPermanent Int @default(3)\n  lastError      String?  @db.Text\n  nextRetryAt    DateTime @default(now())                 // exp-backoff gate; drain selects WHERE nextRetryAt <= now\n  claimedUntil   DateTime?                                // atomic claim TTL; PROCESSING reclaimable after this (PFP crash-recovery)\n  createdAt      DateTime @default(now())\n  updatedAt      DateTime @updatedAt\n  completedAt    DateTime?";
/** The recommended index block for drain selection + stale-claim recovery + tenant scan. */
export declare const DURABLE_INTENT_INDEXES: "  @@index([status, nextRetryAt])         // drain selection\n  @@index([status, claimedUntil])        // stale-claim recovery (PFP crash-recovery)\n  @@index([tenantId])";
/**
 * Generate a ready-to-paste Prisma `model` block for a consumer's durable-intent
 * table. Adds the canonical columns + indexes + the consumer's chosen @unique
 * anchor + any extra business columns + the consumer's @@schema.
 *
 * @example
 *   generateIntentModel({
 *     modelName: "PendingByolCommit",
 *     anchor: "batchId String @unique",
 *     extraColumns: ["leads Json", "committedCount Int @default(0)"],
 *     schema: "harvest_home",
 *   });
 */
export declare function generateIntentModel(args: {
    modelName: string;
    /** The @unique anchor line(s), e.g. "batchId String @unique" or a "@@unique([...])". */
    anchor: string;
    /** Extra business columns, each a full Prisma field line. */
    extraColumns?: string[];
    /** The consumer's multi-schema name (omitted if the consumer is single-schema). */
    schema?: string;
}): string;
//# sourceMappingURL=column-template.d.ts.map