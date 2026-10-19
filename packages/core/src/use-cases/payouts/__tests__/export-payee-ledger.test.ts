import { describe, expect, it, vi } from "vitest";

import type {
  ListPayeeLedgerEntriesOptions,
  PayeeLedgerEntryRecord,
} from "@th/types/repos/payee-ledger";
import type { OrderEventAttribution } from "@th/types/repos/orders";

import {
  exportPayeeLedger,
  exportPayeeLedgerOutputSchema,
  PAYEE_LEDGER_EXPORT_PAGE_SIZE,
  type ExportPayeeLedgerDeps,
} from "../export-payee-ledger";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PAYEE_ID = "payee-org";
const NOW = new Date("2026-10-15T12:00:00.000Z");

let seq = 0;
function entry(overrides: Partial<PayeeLedgerEntryRecord> = {}): PayeeLedgerEntryRecord {
  seq += 1;
  const id = `e-${String(seq).padStart(6, "0")}`;
  return {
    id,
    idempotencyKey: `key-${id}`,
    payeeId: PAYEE_ID,
    type: "SETTLEMENT_CREDIT",
    amountCents: 1_000,
    currency: "usd",
    sourceKind: "order_split",
    sourceId: id,
    orderId: null,
    settlementId: null,
    disputeId: null,
    relatedEntryId: null,
    availableAt: null,
    consumedByEntryId: null,
    description: `row ${id}`,
    metadata: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 60_000),
    ...overrides,
  };
}

/** (createdAt, id) ascending — the order the adapter sorts on. */
function cmp(a: PayeeLedgerEntryRecord, b: PayeeLedgerEntryRecord): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type Options = {
  allowed?: boolean;
  /** `null` = the subject has no Payee row. */
  payeeId?: string | null;
  entries?: PayeeLedgerEntryRecord[];
  disputeDebits?: Record<string, PayeeLedgerEntryRecord[]>;
  attribution?: Record<string, Partial<OrderEventAttribution>>;
  /** Call index (0 = cursor read) at which `listEntries` throws. */
  failListEntriesAt?: number;
  disputeDebitsFail?: boolean;
  attributionFail?: boolean;
  auditFails?: boolean;
  reporterThrows?: boolean;
  /** Runs after each `listEntries` call — lets a test write mid-export. */
  afterListEntries?: (call: number, store: PayeeLedgerEntryRecord[]) => void;
};

function makeDeps(options: Options = {}) {
  const canFinanceOrg = vi.fn(async () => ({ allowed: options.allowed ?? true }));
  const payeeId = options.payeeId === undefined ? PAYEE_ID : options.payeeId;
  const getBySubject = vi.fn(async () => (payeeId ? { id: payeeId } : null));

  // An in-memory ledger that honours the port contract the use case relies
  // on: default (createdAt DESC, id DESC), `order: "asc"`, the inclusive
  // (createdAt, id) `atOrBefore` bound, the exclusive `after` keyset, limit
  // and offset.
  const store = [...(options.entries ?? [])];
  let calls = 0;
  const listEntries = vi.fn(
    async (_payeeId: string, opts: ListPayeeLedgerEntriesOptions = {}) => {
      const call = calls++;
      if (options.failListEntriesAt === call) throw new Error("page read failed");
      let rows = [...store];
      const bound = opts.atOrBefore;
      if (bound) {
        rows = rows.filter(
          (r) =>
            r.createdAt.getTime() < bound.createdAt.getTime() ||
            (r.createdAt.getTime() === bound.createdAt.getTime() && r.id <= bound.id),
        );
      }
      const after = opts.after;
      if (after) {
        rows = rows.filter(
          (r) =>
            r.createdAt.getTime() > after.createdAt.getTime() ||
            (r.createdAt.getTime() === after.createdAt.getTime() && r.id > after.id),
        );
      }
      rows.sort(cmp);
      if ((opts.order ?? "desc") === "desc") rows.reverse();
      const offset = opts.offset ?? 0;
      const result = rows.slice(offset, offset + (opts.limit ?? 50));
      options.afterListEntries?.(call, store);
      return result;
    },
  );
  const listDebitsForDispute = vi.fn(async (disputeId: string) => {
    if (options.disputeDebitsFail) throw new Error("dispute debit read failed");
    return options.disputeDebits?.[disputeId] ?? [];
  });
  const getEventAttributionByIds = vi.fn(async (orderIds: string[]) => {
    if (options.attributionFail) throw new Error("attribution read failed");
    const map = new Map<string, OrderEventAttribution>();
    for (const id of orderIds) {
      const a = options.attribution?.[id];
      if (!a) continue;
      map.set(id, {
        orderId: id,
        orderCode: null,
        kind: "TICKETING",
        eventId: null,
        eventTitle: null,
        eventSlug: null,
        eventStartsAt: null,
        ...a,
      } as OrderEventAttribution);
    }
    return map;
  });
  const auditLog = vi.fn(async () => {
    if (options.auditFails) throw new Error("audit write failed");
  });
  const reportError = vi.fn(() => {
    if (options.reporterThrows) throw new Error("sentry is down");
  });
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);

  const deps = {
    repos: {
      payeeLedger: { listEntries, listDebitsForDispute },
      payees: { getBySubject },
      orders: { getEventAttributionByIds },
      audit: { log: auditLog },
    },
    authz: { canFinanceOrg },
    clock: { now: () => NOW },
    logger,
    reportError,
  } as unknown as ExportPayeeLedgerDeps;

  return {
    deps,
    canFinanceOrg,
    getBySubject,
    listEntries,
    listDebitsForDispute,
    getEventAttributionByIds,
    auditLog,
    reportError,
    logger,
    store,
  };
}

describe("exportPayeeLedger — gate", () => {
  it("refuses a non-finance member with FORBIDDEN before any read, and writes no audit row", async () => {
    const h = makeDeps({ allowed: false, entries: [entry()] });

    await expect(
      exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(h.canFinanceOrg).toHaveBeenCalledWith({ actorHumanId: ACTOR, orgId: ORG_ID });
    expect(h.getBySubject).not.toHaveBeenCalled();
    expect(h.listEntries).not.toHaveBeenCalled();
    expect(h.auditLog).not.toHaveBeenCalled();
  });

  it("reads the ORG payee for a finance member", async () => {
    const h = makeDeps({ entries: [entry()] });
    await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });
    expect(h.getBySubject).toHaveBeenCalledWith({ type: "ORGANIZATION", id: ORG_ID });
  });

  it("without orgId, reads the ACTOR's own human payee and never probes the org gate", async () => {
    const h = makeDeps({ entries: [entry()] });
    await exportPayeeLedger(h.deps, { actorHumanId: ACTOR });
    expect(h.canFinanceOrg).not.toHaveBeenCalled();
    expect(h.getBySubject).toHaveBeenCalledWith({ type: "HUMAN", id: ACTOR });
  });

  it("refuses an unknown input key (strict)", async () => {
    const h = makeDeps();
    await expect(
      exportPayeeLedger(h.deps, { actorHumanId: ACTOR, payeeId: "someone" }),
    ).rejects.toThrow();
    expect(h.listEntries).not.toHaveBeenCalled();
  });
});

describe("exportPayeeLedger — rows", () => {
  it("no Payee row → empty export, no ledger read, no audit row", async () => {
    const h = makeDeps({ payeeId: null });
    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });
    expect(out).toEqual({ payeeId: null, asOf: NOW, rows: [] });
    expect(h.listEntries).not.toHaveBeenCalled();
    expect(h.auditLog).not.toHaveBeenCalled();
  });

  it("an empty ledger → zero rows after one cursor read, audit rowCount 0", async () => {
    const h = makeDeps({ entries: [] });
    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });
    expect(out.rows).toEqual([]);
    expect(h.listEntries).toHaveBeenCalledTimes(1);
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { orgId: ORG_ID, actorHumanId: ACTOR, rowCount: 0, currencies: [] },
      }),
    );
  });

  it("keeps an INDEPENDENT running balance per currency when rows interleave", async () => {
    const h = makeDeps({
      entries: [
        entry({ currency: "usd", amountCents: 1_000 }),
        entry({ currency: " EUR ", amountCents: 500 }),
        entry({ currency: "USD", type: "REFUND_DEBIT", amountCents: 300 }),
        entry({ currency: "eur", amountCents: 200 }),
        entry({ currency: "usd", type: "PAYOUT", amountCents: 700 }),
      ],
    });

    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });

    expect(out.rows.map((r) => [r.currency, r.changeCents, r.balanceAfterCents])).toEqual([
      ["usd", 1_000, 1_000],
      ["eur", 500, 500],
      ["usd", -300, 700],
      ["eur", 200, 700],
      ["usd", -700, 0],
    ]);
    // No currency filter on any read: every currency is in the file.
    for (const [, opts] of h.listEntries.mock.calls) {
      expect(opts).not.toHaveProperty("currency");
    }
    expect(h.auditLog).toHaveBeenCalledWith({
      entity: "payee",
      entityId: PAYEE_ID,
      action: "payee_ledger_export",
      data: { orgId: ORG_ID, actorHumanId: ACTOR, rowCount: 5, currencies: ["eur", "usd"] },
      at: NOW,
    });
    expect(exportPayeeLedgerOutputSchema.parse(out)).toEqual(out);
  });

  it("holds, reserves and a hold-release change nothing; a debit-compensating release adds", async () => {
    // Built in ledger order: `entry()` stamps each row a minute after the last.
    const credit = entry({ amountCents: 2_000 });
    const hold = entry({ type: "DISPUTE_HOLD", amountCents: 400, disputeId: "dp_1" });
    const reserveHold = entry({ type: "RESERVE_HOLD", amountCents: 100 });
    const reserveRelease = entry({ type: "RESERVE_RELEASE", amountCents: 100 });
    const holdRelease = entry({
      type: "DISPUTE_RELEASE",
      amountCents: 400,
      disputeId: "dp_1",
      relatedEntryId: hold.id,
    });
    const debit = entry({ type: "DISPUTE_DEBIT", amountCents: 600, disputeId: "dp_2" });
    const debitRelease = entry({
      type: "DISPUTE_RELEASE",
      amountCents: 600,
      disputeId: "dp_2",
      relatedEntryId: debit.id,
    });
    const h = makeDeps({
      entries: [
        credit,
        hold,
        reserveHold,
        reserveRelease,
        holdRelease,
        debit,
        debitRelease,
      ],
      disputeDebits: { dp_2: [debit] },
    });

    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });

    expect(out.rows.map((r) => [r.type, r.changeCents, r.balanceAfterCents])).toEqual([
      ["SETTLEMENT_CREDIT", 2_000, 2_000],
      ["DISPUTE_HOLD", 0, 2_000],
      ["RESERVE_HOLD", 0, 2_000],
      ["RESERVE_RELEASE", 0, 2_000],
      ["DISPUTE_RELEASE", 0, 2_000],
      ["DISPUTE_DEBIT", -600, 1_400],
      ["DISPUTE_RELEASE", 600, 2_000],
    ]);
    // Amount stays as stored — positive — whatever the sign of Change.
    expect(out.rows.every((r) => r.amountCents > 0)).toBe(true);
  });

  it("reads a legacy debt-recovery PAYOUT as a credit, a new PAYOUT as a debit", async () => {
    const h = makeDeps({
      entries: [
        entry({ type: "PAYOUT", amountCents: 250, idempotencyKey: "debt-recovery:x" }),
        entry({ type: "PAYOUT", amountCents: 100, idempotencyKey: "payout:y" }),
      ],
    });
    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });
    expect(out.rows.map((r) => r.changeCents)).toEqual([250, -100]);
    expect(out.rows.map((r) => r.balanceAfterCents)).toEqual([250, 150]);
  });

  it("names the event for an order, and leaves it null without an order or an event", async () => {
    const h = makeDeps({
      entries: [
        entry({ orderId: "order-1" }),
        entry({ orderId: "order-membership" }),
        entry({ orderId: "order-gone" }),
        entry({ orderId: null }),
      ],
      attribution: {
        "order-1": { eventId: "ev-1", eventTitle: "Roast the Host" },
        "order-membership": { kind: "MEMBERSHIP", eventId: null, eventTitle: null },
      },
    });

    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });

    expect(out.rows.map((r) => r.eventName)).toEqual(["Roast the Host", null, null, null]);
    expect(h.getEventAttributionByIds).toHaveBeenCalledTimes(1);
    expect(h.getEventAttributionByIds.mock.calls[0]![0].sort()).toEqual([
      "order-1",
      "order-gone",
      "order-membership",
    ]);
  });
});

describe("exportPayeeLedger — snapshot and paging", () => {
  it("walks every page oldest first with no row repeated or dropped, and asks for event names in chunks of 500", async () => {
    const total = PAYEE_LEDGER_EXPORT_PAGE_SIZE * 2 + 37;
    const same = new Date("2026-03-01T00:00:00.000Z");
    // Ties on createdAt across a page boundary: the id half of the sort
    // carries the walk.
    const entries = Array.from({ length: total }, (_, i) =>
      entry({
        orderId: `order-${i}`,
        ...(i >= 490 && i < 510 ? { createdAt: same } : {}),
      }),
    );
    const h = makeDeps({ entries });

    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });

    const expected = [...entries].sort(cmp).map((e) => e.id);
    expect(out.rows.map((r) => r.id)).toEqual(expected);
    expect(new Set(out.rows.map((r) => r.id)).size).toBe(total);
    // 1 cursor read + 3 pages (500, 500, 37).
    expect(h.listEntries).toHaveBeenCalledTimes(4);
    // Keyset paging: the first page has no `after`, each later page starts
    // strictly after the previous page's last row, and no read uses OFFSET.
    const sorted = [...entries].sort(cmp);
    const pageOpts = h.listEntries.mock.calls.slice(1).map((c) => c[1]!);
    expect(pageOpts[0]).toMatchObject({ order: "asc", limit: PAYEE_LEDGER_EXPORT_PAGE_SIZE });
    expect(pageOpts[0]).not.toHaveProperty("after");
    expect(pageOpts[1]!.after).toEqual({
      createdAt: sorted[499]!.createdAt,
      id: sorted[499]!.id,
    });
    expect(pageOpts[2]!.after).toEqual({
      createdAt: sorted[999]!.createdAt,
      id: sorted[999]!.id,
    });
    expect(pageOpts.every((o) => o.offset === undefined)).toBe(true);
    expect(out.rows.at(-1)!.balanceAfterCents).toBe(total * 1_000);
    expect(h.getEventAttributionByIds.mock.calls.map((c) => c[0].length)).toEqual([
      500, 500, 37,
    ]);
  });

  it("leaves out an entry written after the cursor read, and duplicates nothing", async () => {
    const total = PAYEE_LEDGER_EXPORT_PAGE_SIZE + 10;
    const entries = Array.from({ length: total }, () => entry());
    const late = entry({ amountCents: 99_999 });
    // A row stamped AFTER the cursor read (the common case of a write during
    // the export) sorts past the snapshot bound and is never in the file.
    // The late-COMMIT case, stamped before the cursor, is the next test.
    const h = makeDeps({
      entries,
      afterListEntries: (call, store) => {
        if (call === 1) store.push(late);
      },
    });

    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });

    expect(out.rows).toHaveLength(total);
    expect(out.rows.map((r) => r.id)).not.toContain(late.id);
    expect(new Set(out.rows.map((r) => r.id)).size).toBe(total);
    const newest = [...entries].sort(cmp).at(-1)!;
    expect(h.listEntries.mock.calls[1]![1]).toMatchObject({
      atOrBefore: { createdAt: newest.createdAt, id: newest.id },
    });
  });

  it("a LATE-COMMITTED row that sorts behind the walk is left out, never duplicated", async () => {
    // `createdAt` is stamped at INSERT, not at commit. A transaction that
    // inserted before the cursor read but commits after page 2 was read
    // lands INSIDE the snapshot bound, BEHIND the walk position. Under OFFSET
    // paging it shifts every later row one place: page 3 would repeat
    // page 2's last row and the running balance would count it twice.
    const total = PAYEE_LEDGER_EXPORT_PAGE_SIZE * 2;
    const entries = Array.from({ length: total }, () => entry());
    const sorted = [...entries].sort(cmp);
    const late = entry({
      amountCents: 77_777,
      // Between the 100th and 101st rows: well behind the walk.
      createdAt: new Date(sorted[100]!.createdAt.getTime() - 1),
    });
    const h = makeDeps({
      entries,
      afterListEntries: (call, store) => {
        if (call === 2) store.push(late);
      },
    });

    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });

    const ids = out.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(sorted.map((e) => e.id));
    expect(ids).not.toContain(late.id);
    // Coherent running balance: every row adds 1,000, so row i reads
    // (i + 1) × 1,000 — no double count, no gap.
    expect(out.rows.every((r, i) => r.balanceAfterCents === (i + 1) * 1_000)).toBe(true);
  });
});

describe("exportPayeeLedger — all or nothing", () => {
  it.each([
    ["the cursor read", { failListEntriesAt: 0 }],
    ["a later page", { failListEntriesAt: 2 }],
    ["the dispute-debit lookup", { disputeDebitsFail: true }],
    ["the event lookup", { attributionFail: true }],
  ] as const)("rejects when %s fails, and writes no audit row", async (_name, failure) => {
    const entries = Array.from({ length: PAYEE_LEDGER_EXPORT_PAGE_SIZE + 5 }, (_, i) =>
      entry({ orderId: `order-${i}` }),
    );
    entries.push(
      entry({
        type: "DISPUTE_RELEASE",
        disputeId: "dp_1",
        relatedEntryId: "missing",
      }),
    );
    const h = makeDeps({ entries, ...failure });

    await expect(
      exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID }),
    ).rejects.toThrow(/failed/);
    expect(h.auditLog).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("rejects when the payee lookup fails", async () => {
    const h = makeDeps();
    h.getBySubject.mockRejectedValueOnce(new Error("payee read failed"));
    await expect(
      exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID }),
    ).rejects.toThrow("payee read failed");
  });
});

describe("exportPayeeLedger — audit swallow (ReporterPort)", () => {
  it("still returns the rows when the audit write fails, and reports it", async () => {
    const h = makeDeps({ entries: [entry(), entry()], auditFails: true });

    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });

    expect(out.rows).toHaveLength(2);
    expect(h.logger.error).toHaveBeenCalledWith(
      "exportPayeeLedger.auditLogFailed",
      expect.objectContaining({ err: expect.any(Error) }),
    );
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "exportPayeeLedger", step: "auditLog" },
      extra: { payeeId: PAYEE_ID },
    });
  });

  it("a throwing reporter changes nothing", async () => {
    const h = makeDeps({ entries: [entry()], auditFails: true, reporterThrows: true });
    const out = await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });
    expect(out.rows).toHaveLength(1);
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it("reports nothing on a healthy export", async () => {
    const h = makeDeps({ entries: [entry()] });
    await exportPayeeLedger(h.deps, { actorHumanId: ACTOR, orgId: ORG_ID });
    expect(h.reportError).not.toHaveBeenCalled();
    expect(h.auditLog).toHaveBeenCalledTimes(1);
  });
});
