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
export interface FakeDelegateOptions {
    /** Force the NEXT create/upsert-create to throw a P2002 (simulate a lost @unique race). */
    throwP2002OnNextCreate?: boolean;
}
export declare class FakeDelegate implements BulkOpDelegate<BulkOpIntent> {
    rows: Map<string, {
        id: string;
        tenantId: string;
        status: BulkOpStatus;
        payload: unknown;
        idempotencyKey: string | null;
        attempts: number;
        attemptsPermanent: number;
        maxAttempts: number;
        maxAttemptsPermanent: number;
        lastError: string | null;
        nextRetryAt: Date;
        claimedUntil: Date | null;
        createdAt: Date;
        updatedAt: Date;
        completedAt: Date | null;
    }>;
    opts: FakeDelegateOptions;
    constructor(opts?: FakeDelegateOptions);
    /** Seed a row directly (test setup). Preserves arbitrary business columns
     *  (e.g. `batchId`) so anchor lookups on a non-`id` @unique key resolve. */
    seed(partial: Partial<BulkOpIntent> & Record<string, unknown>): BulkOpIntent;
    private find;
    findUnique(args: {
        where: Record<string, unknown>;
    }): Promise<BulkOpIntent | null>;
    findFirst(args: {
        where: Record<string, unknown>;
    }): Promise<BulkOpIntent | null>;
    findMany(args: {
        where: Record<string, unknown>;
        take?: number;
    }): Promise<Array<{
        id: string;
    } & Partial<BulkOpIntent>>>;
    updateMany(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
    }): Promise<{
        count: number;
    }>;
    update(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
    }): Promise<BulkOpIntent>;
    upsert(args: {
        where: Record<string, unknown>;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
    }): Promise<BulkOpIntent>;
    create(args: {
        data: Record<string, unknown>;
    }): Promise<BulkOpIntent>;
}
/** A minimal create-only DLQ delegate stub. */
export declare class FakeDlqDelegate {
    created: Array<Record<string, unknown>>;
    throwP2002: boolean;
    throwOther: boolean;
    create(args: {
        data: Record<string, unknown>;
    }): Promise<unknown>;
}
//# sourceMappingURL=fake-delegate.d.ts.map