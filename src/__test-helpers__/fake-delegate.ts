/**
 * In-memory BulkOpDelegate stub for vitest. Models just enough Prisma-delegate
 * semantics to exercise the helpers: atomic-ish updateMany (WHERE prev_state),
 * findUnique/findFirst by simple equality + the `status:{ in }` / date-range /
 * `nextRetryAt:{ lte }` operators the helpers actually use. NEVER touches a real
 * DB (Test-Runner Standard §2 — no live writes).
 *
 * The store is a plain Map keyed by `id`. Anchors other than `id` (e.g.
 * `{ batchId }`) are matched by scanning. This is intentionally simple — the
 * unit tests assert helper LOGIC, not Prisma fidelity.
 */

import type { BulkOpDelegate, BulkOpIntent, BulkOpStatus } from "../types.js";

let seq = 0;
function newId(): string {
  seq += 1;
  return `intent_${seq}`;
}

function matchOp(actual: unknown, condition: unknown): boolean {
  if (
    condition &&
    typeof condition === "object" &&
    !Array.isArray(condition) &&
    !(condition instanceof Date)
  ) {
    const c = condition as Record<string, unknown>;
    if ("in" in c) {
      return (c.in as unknown[]).includes(actual);
    }
    if ("lt" in c || "lte" in c || "gt" in c || "gte" in c) {
      const a = actual instanceof Date ? actual.getTime() : Number(actual);
      if ("lt" in c) {
        const b = c.lt instanceof Date ? (c.lt as Date).getTime() : Number(c.lt);
        if (!(a < b)) return false;
      }
      if ("lte" in c) {
        const b = c.lte instanceof Date ? (c.lte as Date).getTime() : Number(c.lte);
        if (!(a <= b)) return false;
      }
      if ("gt" in c) {
        const b = c.gt instanceof Date ? (c.gt as Date).getTime() : Number(c.gt);
        if (!(a > b)) return false;
      }
      if ("gte" in c) {
        const b = c.gte instanceof Date ? (c.gte as Date).getTime() : Number(c.gte);
        if (!(a >= b)) return false;
      }
      return true;
    }
    if ("equals" in c) {
      return actual === c.equals;
    }
  }
  return actual === condition;
}

function rowMatches(row: BulkOpIntent, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      const branches = cond as Array<Record<string, unknown>>;
      if (!branches.some((b) => rowMatches(row, b))) return false;
      continue;
    }
    if (key === "AND") {
      const branches = cond as Array<Record<string, unknown>>;
      if (!branches.every((b) => rowMatches(row, b))) return false;
      continue;
    }
    // payload path operator (coalesce on a nested field) — { payload: { path, equals } }
    if (key === "payload" && cond && typeof cond === "object" && "path" in (cond as object)) {
      const pc = cond as { path: string[]; equals: unknown };
      let cursor: unknown = row.payload;
      for (const seg of pc.path) {
        cursor = (cursor as Record<string, unknown> | null)?.[seg];
      }
      if (cursor !== pc.equals) return false;
      continue;
    }
    const actual = (row as unknown as Record<string, unknown>)[key];
    if (!matchOp(actual, cond)) return false;
  }
  return true;
}

function applyData(row: BulkOpIntent, data: Record<string, unknown>): void {
  for (const [key, val] of Object.entries(data)) {
    if (val && typeof val === "object" && "increment" in (val as object)) {
      const cur = Number((row as unknown as Record<string, unknown>)[key] ?? 0);
      (row as unknown as Record<string, unknown>)[key] =
        cur + Number((val as { increment: number }).increment);
    } else {
      (row as unknown as Record<string, unknown>)[key] = val;
    }
  }
  row.updatedAt = new Date();
}

export interface FakeDelegateOptions {
  /** Force the NEXT create/upsert-create to throw a P2002 (simulate a lost @unique race). */
  throwP2002OnNextCreate?: boolean;
}

export class FakeDelegate implements BulkOpDelegate<BulkOpIntent> {
  rows = new Map<string, BulkOpIntent>();
  opts: FakeDelegateOptions;

  constructor(opts: FakeDelegateOptions = {}) {
    this.opts = opts;
  }

  /** Seed a row directly (test setup). Preserves arbitrary business columns
   *  (e.g. `batchId`) so anchor lookups on a non-`id` @unique key resolve. */
  seed(partial: Partial<BulkOpIntent> & Record<string, unknown>): BulkOpIntent {
    const id = (partial.id as string | undefined) ?? newId();
    const row: BulkOpIntent = {
      // carry any extra business columns (batchId, actionId, agentId, …) first
      ...(partial as Record<string, unknown>),
      id,
      tenantId: (partial.tenantId as string | undefined) ?? "t1",
      status: (partial.status ?? "PENDING") as BulkOpStatus,
      payload: partial.payload ?? {},
      idempotencyKey: (partial.idempotencyKey as string | null | undefined) ?? null,
      attempts: (partial.attempts as number | undefined) ?? 0,
      attemptsPermanent: (partial.attemptsPermanent as number | undefined) ?? 0,
      maxAttempts: (partial.maxAttempts as number | undefined) ?? 5,
      maxAttemptsPermanent: (partial.maxAttemptsPermanent as number | undefined) ?? 3,
      lastError: (partial.lastError as string | null | undefined) ?? null,
      nextRetryAt: (partial.nextRetryAt as Date | undefined) ?? new Date(0),
      claimedUntil: (partial.claimedUntil as Date | null | undefined) ?? null,
      createdAt: (partial.createdAt as Date | undefined) ?? new Date(),
      updatedAt: (partial.updatedAt as Date | undefined) ?? new Date(),
      completedAt: (partial.completedAt as Date | null | undefined) ?? null,
    } as BulkOpIntent;
    this.rows.set(id, row);
    return row;
  }

  private find(where: Record<string, unknown>): BulkOpIntent | undefined {
    for (const row of this.rows.values()) {
      if (rowMatches(row, where)) return row;
    }
    return undefined;
  }

  async findUnique(args: {
    where: Record<string, unknown>;
  }): Promise<BulkOpIntent | null> {
    return this.find(args.where) ?? null;
  }

  async findFirst(args: {
    where: Record<string, unknown>;
  }): Promise<BulkOpIntent | null> {
    return this.find(args.where) ?? null;
  }

  async findMany(args: {
    where: Record<string, unknown>;
    take?: number;
  }): Promise<Array<{ id: string } & Partial<BulkOpIntent>>> {
    const matches = [...this.rows.values()]
      .filter((r) => rowMatches(r, args.where))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const limited = args.take ? matches.slice(0, args.take) : matches;
    return limited.map((r) => ({ ...r }));
  }

  async updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }> {
    let count = 0;
    for (const row of this.rows.values()) {
      if (rowMatches(row, args.where)) {
        applyData(row, args.data);
        count += 1;
      }
    }
    return { count };
  }

  async update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<BulkOpIntent> {
    const row = this.find(args.where);
    if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
    applyData(row, args.data);
    return { ...row };
  }

  async upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<BulkOpIntent> {
    const existing = this.find(args.where);
    if (existing) {
      applyData(existing, args.update);
      return { ...existing };
    }
    if (this.opts.throwP2002OnNextCreate) {
      this.opts.throwP2002OnNextCreate = false;
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    return this.create({ data: { ...args.where, ...args.create } });
  }

  async create(args: { data: Record<string, unknown> }): Promise<BulkOpIntent> {
    if (this.opts.throwP2002OnNextCreate) {
      this.opts.throwP2002OnNextCreate = false;
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    }
    const row = this.seed(args.data as Partial<BulkOpIntent>);
    return { ...row };
  }
}

/** A minimal create-only DLQ delegate stub. */
export class FakeDlqDelegate {
  created: Array<Record<string, unknown>> = [];
  throwP2002 = false;
  throwOther = false;
  async create(args: { data: Record<string, unknown> }): Promise<unknown> {
    if (this.throwP2002) {
      throw Object.assign(new Error("dup"), { code: "P2002" });
    }
    if (this.throwOther) {
      throw new Error("disk full");
    }
    this.created.push(args.data);
    return args.data;
  }
}
