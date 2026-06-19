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
let seq = 0;
function newId() {
    seq += 1;
    return `intent_${seq}`;
}
function matchOp(actual, condition) {
    if (condition &&
        typeof condition === "object" &&
        !Array.isArray(condition) &&
        !(condition instanceof Date)) {
        const c = condition;
        if ("in" in c) {
            return c.in.includes(actual);
        }
        if ("lt" in c || "lte" in c || "gt" in c || "gte" in c) {
            const a = actual instanceof Date ? actual.getTime() : Number(actual);
            if ("lt" in c) {
                const b = c.lt instanceof Date ? c.lt.getTime() : Number(c.lt);
                if (!(a < b))
                    return false;
            }
            if ("lte" in c) {
                const b = c.lte instanceof Date ? c.lte.getTime() : Number(c.lte);
                if (!(a <= b))
                    return false;
            }
            if ("gt" in c) {
                const b = c.gt instanceof Date ? c.gt.getTime() : Number(c.gt);
                if (!(a > b))
                    return false;
            }
            if ("gte" in c) {
                const b = c.gte instanceof Date ? c.gte.getTime() : Number(c.gte);
                if (!(a >= b))
                    return false;
            }
            return true;
        }
        if ("equals" in c) {
            return actual === c.equals;
        }
    }
    return actual === condition;
}
function rowMatches(row, where) {
    for (const [key, cond] of Object.entries(where)) {
        if (key === "OR") {
            const branches = cond;
            if (!branches.some((b) => rowMatches(row, b)))
                return false;
            continue;
        }
        if (key === "AND") {
            const branches = cond;
            if (!branches.every((b) => rowMatches(row, b)))
                return false;
            continue;
        }
        // payload path operator (coalesce on a nested field) — { payload: { path, equals } }
        if (key === "payload" && cond && typeof cond === "object" && "path" in cond) {
            const pc = cond;
            let cursor = row.payload;
            for (const seg of pc.path) {
                cursor = cursor?.[seg];
            }
            if (cursor !== pc.equals)
                return false;
            continue;
        }
        const actual = row[key];
        if (!matchOp(actual, cond))
            return false;
    }
    return true;
}
function applyData(row, data) {
    for (const [key, val] of Object.entries(data)) {
        if (val && typeof val === "object" && "increment" in val) {
            const cur = Number(row[key] ?? 0);
            row[key] =
                cur + Number(val.increment);
        }
        else {
            row[key] = val;
        }
    }
    row.updatedAt = new Date();
}
export class FakeDelegate {
    rows = new Map();
    opts;
    constructor(opts = {}) {
        this.opts = opts;
    }
    /** Seed a row directly (test setup). Preserves arbitrary business columns
     *  (e.g. `batchId`) so anchor lookups on a non-`id` @unique key resolve. */
    seed(partial) {
        const id = partial.id ?? newId();
        const row = {
            // carry any extra business columns (batchId, actionId, agentId, …) first
            ...partial,
            id,
            tenantId: partial.tenantId ?? "t1",
            status: (partial.status ?? "PENDING"),
            payload: partial.payload ?? {},
            idempotencyKey: partial.idempotencyKey ?? null,
            attempts: partial.attempts ?? 0,
            attemptsPermanent: partial.attemptsPermanent ?? 0,
            maxAttempts: partial.maxAttempts ?? 5,
            maxAttemptsPermanent: partial.maxAttemptsPermanent ?? 3,
            lastError: partial.lastError ?? null,
            nextRetryAt: partial.nextRetryAt ?? new Date(0),
            claimedUntil: partial.claimedUntil ?? null,
            createdAt: partial.createdAt ?? new Date(),
            updatedAt: partial.updatedAt ?? new Date(),
            completedAt: partial.completedAt ?? null,
        };
        this.rows.set(id, row);
        return row;
    }
    find(where) {
        for (const row of this.rows.values()) {
            if (rowMatches(row, where))
                return row;
        }
        return undefined;
    }
    async findUnique(args) {
        return this.find(args.where) ?? null;
    }
    async findFirst(args) {
        return this.find(args.where) ?? null;
    }
    async findMany(args) {
        const matches = [...this.rows.values()]
            .filter((r) => rowMatches(r, args.where))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const limited = args.take ? matches.slice(0, args.take) : matches;
        return limited.map((r) => ({ ...r }));
    }
    async updateMany(args) {
        let count = 0;
        for (const row of this.rows.values()) {
            if (rowMatches(row, args.where)) {
                applyData(row, args.data);
                count += 1;
            }
        }
        return { count };
    }
    async update(args) {
        const row = this.find(args.where);
        if (!row)
            throw Object.assign(new Error("Record not found"), { code: "P2025" });
        applyData(row, args.data);
        return { ...row };
    }
    async upsert(args) {
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
    async create(args) {
        if (this.opts.throwP2002OnNextCreate) {
            this.opts.throwP2002OnNextCreate = false;
            throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = this.seed(args.data);
        return { ...row };
    }
}
/** A minimal create-only DLQ delegate stub. */
export class FakeDlqDelegate {
    created = [];
    throwP2002 = false;
    throwOther = false;
    async create(args) {
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
//# sourceMappingURL=fake-delegate.js.map