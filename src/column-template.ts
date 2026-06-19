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
export const DURABLE_INTENT_COLUMNS = `  id             String   @id @default(cuid())
  tenantId       String                                   // tenant isolation — every helper filters on this
  status         String   @default("PENDING")             // BulkOpStatus (string-typed; a consumer MAY mirror as a Prisma enum and assert superset)
  payload        Json                                     // replay payload — the off-request work reads everything here, never the request body
  idempotencyKey String?  @db.VarChar(255)                // carried on replay; P2002 -> deduped
  attempts          Int   @default(0)                     // transient (5xx) attempt counter
  attemptsPermanent Int   @default(0)                     // 4xx / permanent-error counter (PFP 400-vs-5xx split)
  maxAttempts          Int @default(5)
  maxAttemptsPermanent Int @default(3)
  lastError      String?  @db.Text
  nextRetryAt    DateTime @default(now())                 // exp-backoff gate; drain selects WHERE nextRetryAt <= now
  claimedUntil   DateTime?                                // atomic claim TTL; PROCESSING reclaimable after this (PFP crash-recovery)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  completedAt    DateTime?` as const;

/** The recommended index block for drain selection + stale-claim recovery + tenant scan. */
export const DURABLE_INTENT_INDEXES = `  @@index([status, nextRetryAt])         // drain selection
  @@index([status, claimedUntil])        // stale-claim recovery (PFP crash-recovery)
  @@index([tenantId])` as const;

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
export function generateIntentModel(args: {
  modelName: string;
  /** The @unique anchor line(s), e.g. "batchId String @unique" or a "@@unique([...])". */
  anchor: string;
  /** Extra business columns, each a full Prisma field line. */
  extraColumns?: string[];
  /** The consumer's multi-schema name (omitted if the consumer is single-schema). */
  schema?: string;
}): string {
  const extra = (args.extraColumns ?? []).map((c) => `  ${c.trim()}`).join("\n");
  const anchorIsBlockAttr = args.anchor.trim().startsWith("@@");
  const inlineAnchor = anchorIsBlockAttr ? "" : `  ${args.anchor.trim()}`;
  const blockAnchor = anchorIsBlockAttr ? `  ${args.anchor.trim()}` : "";
  const schemaLine = args.schema ? `  @@schema("${args.schema}")` : "";

  return [
    `model ${args.modelName} {`,
    DURABLE_INTENT_COLUMNS,
    inlineAnchor,
    extra,
    "",
    DURABLE_INTENT_INDEXES,
    blockAnchor,
    schemaLine,
    "}",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
