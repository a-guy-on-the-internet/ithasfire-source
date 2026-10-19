import { describe, expect, it, vi } from "vitest";

import { makePayeesRepo } from "../payees";
import type { PrismaClientOrTx } from "../types";

const ACCT = "acct_123";
const OBSERVED_AT = new Date("2026-08-06T12:00:00.000Z");

function syncInput(overrides: Record<string, unknown> = {}) {
  return {
    stripeAccountId: ACCT,
    status: "ACTIVE" as const,
    payoutsEnabled: true,
    chargesEnabled: true,
    defaultCurrency: "usd",
    requirements: {},
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

/** The ordering-guard predicate every conditional write must carry. */
const FRESHNESS = [
  { capabilitiesSyncedAt: null },
  { capabilitiesSyncedAt: { lte: OBSERVED_AT } },
];

function createPrisma() {
  const updateMany = vi.fn();
  const findUnique = vi.fn();
  const create = vi.fn();
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);

  const prisma = {
    payee: { updateMany, findUnique, create, findMany, count },
  } as unknown as PrismaClientOrTx;

  return { prisma, updateMany, findUnique, create, findMany, count };
}

describe("makePayeesRepo.syncCapabilities", () => {
  it("no-ops when stripeAccountId is empty", async () => {
    const { prisma, updateMany, findUnique, create } = createPrisma();
    const repo = makePayeesRepo(prisma);

    await repo.syncCapabilities(syncInput({ stripeAccountId: "" }));

    expect(updateMany).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("updates an existing non-RESTRICTED payee and does not create", async () => {
    const { prisma, updateMany, findUnique, create } = createPrisma();
    const repo = makePayeesRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });

    await repo.syncCapabilities(syncInput({ status: "ACTIVE" }));

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        stripeAccountId: ACCT,
        status: { not: "RESTRICTED" },
        OR: FRESHNESS,
      },
      data: {
        status: "ACTIVE",
        payoutsEnabled: true,
        chargesEnabled: true,
        defaultCurrency: "usd",
        requirements: {},
        capabilitiesSyncedAt: OBSERVED_AT,
      },
    });
    // Row was updated — must not fall through to findUnique/create.
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("transitions PENDING -> ACTIVE via the conditional updateMany", async () => {
    const { prisma, updateMany, create } = createPrisma();
    const repo = makePayeesRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });

    await repo.syncCapabilities(syncInput({ status: "ACTIVE" }));

    expect(updateMany.mock.calls[0]?.[0].data.status).toBe("ACTIVE");
    expect(create).not.toHaveBeenCalled();
  });

  it("does NOT mint a placeholder for an unknown account — reports it instead", async () => {
    // The old create branch (subjectType HUMAN, subjectId "") was a triple
    // hazard: unfindable by subject, re-read from Stripe by every nightly
    // reconcile forever, and — [subjectType, subjectId] being unique — the
    // SECOND unknown account P2002'd into a permanent DLQ entry. Verified
    // live with two consecutive `stripe trigger account.updated` runs.
    const { prisma, updateMany, findUnique, create } = createPrisma();
    const repo = makePayeesRepo(prisma);
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue(null);

    await expect(
      repo.syncCapabilities(
        syncInput({
          status: "PENDING",
          payoutsEnabled: false,
          chargesEnabled: false,
        }),
      ),
    ).resolves.toBe("skipped_unknown_account");

    expect(findUnique).toHaveBeenCalledWith({
      where: { stripeAccountId: ACCT },
      // `status` + `capabilitiesSyncedAt` are selected so the zero-row case can
      // report WHICH guard fired — RESTRICTED (a permanent block worth an
      // error-level log) vs merely stale (routine).
      select: { id: true, status: true, capabilitiesSyncedAt: true },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("defaults requirements to {} on the write when input.requirements is null", async () => {
    const { prisma, updateMany } = createPrisma();
    const repo = makePayeesRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });

    await repo.syncCapabilities(syncInput({ requirements: null }));

    expect(updateMany.mock.calls[0]?.[0].data.requirements).toEqual({});
  });

  it("preserves RESTRICTED: a deauthorized payee receiving active capabilities stays RESTRICTED (no create, no overwrite)", async () => {
    const { prisma, updateMany, findUnique, create } = createPrisma();
    const repo = makePayeesRepo(prisma);
    // Conditional updateMany skips the RESTRICTED row (status != RESTRICTED).
    updateMany.mockResolvedValue({ count: 0 });
    // The row exists — it's the RESTRICTED one.
    findUnique.mockResolvedValue({
      id: "payee-restricted-1",
      status: "RESTRICTED",
      capabilitiesSyncedAt: null,
    });

    await repo.syncCapabilities(
      syncInput({
        status: "ACTIVE",
        payoutsEnabled: true,
        chargesEnabled: true,
      }),
    );

    // updateMany was guarded so it never touched the RESTRICTED row...
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        stripeAccountId: ACCT,
        status: { not: "RESTRICTED" },
        OR: FRESHNESS,
      },
      data: expect.objectContaining({ status: "ACTIVE" }),
    });
    // ...and because the row exists we must NOT create a duplicate or
    // otherwise flip it back to ACTIVE/PENDING.
    expect(create).not.toHaveBeenCalled();
  });

  // ── Ordering guard ────────────────────────────────────────────────────────
  // Stripe does not guarantee webhook order and retries arrive late. Without
  // this, a stale "still pending" delivery overwrites a newer "now active" one
  // and the org can never publish a paid event again.

  it("scopes the write to observations at least as new as the last applied one", async () => {
    const { prisma, updateMany } = createPrisma();
    const repo = makePayeesRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });

    await repo.syncCapabilities(syncInput());

    expect(updateMany.mock.calls[0]?.[0].where.OR).toEqual(FRESHNESS);
    expect(updateMany.mock.calls[0]?.[0].data.capabilitiesSyncedAt).toBe(
      OBSERVED_AT,
    );
  });

  it("leaves the row alone when a STALE observation loses the guard", async () => {
    const { prisma, updateMany, findUnique, create } = createPrisma();
    const repo = makePayeesRepo(prisma);
    // A newer write already landed, so the conditional update matches 0 rows...
    updateMany.mockResolvedValue({ count: 0 });
    // ...but the row very much exists.
    findUnique.mockResolvedValue({
      id: "payee-1",
      status: "ACTIVE",
      capabilitiesSyncedAt: OBSERVED_AT,
    });

    const older = new Date(OBSERVED_AT.getTime() - 60_000);
    await repo.syncCapabilities(
      syncInput({
        observedAt: older,
        status: "PENDING",
        payoutsEnabled: false,
        chargesEnabled: false,
      }),
    );

    expect(updateMany.mock.calls[0]?.[0].where.OR).toEqual([
      { capabilitiesSyncedAt: null },
      { capabilitiesSyncedAt: { lte: older } },
    ]);
    // Must NOT resurrect the row as a fresh create, and must not overwrite.
    expect(create).not.toHaveBeenCalled();
  });

  it("uses lte so an exact redelivery of the same event still applies", async () => {
    const { prisma, updateMany } = createPrisma();
    const repo = makePayeesRepo(prisma);
    updateMany.mockResolvedValue({ count: 1 });

    await repo.syncCapabilities(syncInput());

    // `lt` would drop a Stripe redelivery of the same second-granularity event.
    expect(updateMany.mock.calls[0]?.[0].where.OR[1]).toEqual({
      capabilitiesSyncedAt: { lte: OBSERVED_AT },
    });
  });

  it("reports which guard dropped the write", async () => {
    // The caller logs (and escalates) on these, so a wrong discriminator turns
    // a permanent publish block into a routine-looking info line.
    const restricted = createPrisma();
    restricted.updateMany.mockResolvedValue({ count: 0 });
    restricted.findUnique.mockResolvedValue({
      id: "p1",
      status: "RESTRICTED",
      capabilitiesSyncedAt: null,
    });
    await expect(
      makePayeesRepo(restricted.prisma).syncCapabilities(syncInput()),
    ).resolves.toBe("skipped_restricted");

    const stale = createPrisma();
    stale.updateMany.mockResolvedValue({ count: 0 });
    stale.findUnique.mockResolvedValue({
      id: "p1",
      status: "ACTIVE",
      capabilitiesSyncedAt: new Date(OBSERVED_AT.getTime() + 60_000),
    });
    await expect(
      makePayeesRepo(stale.prisma).syncCapabilities(syncInput()),
    ).resolves.toBe("skipped_stale");

    const applied = createPrisma();
    applied.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      makePayeesRepo(applied.prisma).syncCapabilities(syncInput()),
    ).resolves.toBe("applied");

    const unknown = createPrisma();
    unknown.updateMany.mockResolvedValue({ count: 0 });
    unknown.findUnique.mockResolvedValue(null);
    await expect(
      makePayeesRepo(unknown.prisma).syncCapabilities(syncInput()),
    ).resolves.toBe("skipped_unknown_account");
  });
});

describe("makePayeesRepo.listForCapabilityReconcile", () => {
  const BASE = {
    stripeAccountId: { not: null },
    status: { not: "RESTRICTED" },
  };

  it("takes never-synced rows first — those are the ones the outage left behind", async () => {
    const { prisma, findMany } = createPrisma();
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await makePayeesRepo(prisma).listForCapabilityReconcile({ limit: 200 });

    expect(findMany.mock.calls[0]?.[0]).toEqual({
      where: { ...BASE, capabilitiesSyncedAt: null },
      take: 100, // half the batch — see the cap test below
    });
  });

  it("tops up with the stalest synced rows, ordered ASC without NULLS FIRST", async () => {
    // Split deliberately: a default btree is ASC NULLS LAST, so no scan
    // direction serves `ASC NULLS FIRST` and that ordering would plan a full
    // sort. These two shapes are both index-servable.
    const { prisma, findMany } = createPrisma();
    findMany
      .mockResolvedValueOnce([{ id: "a", stripeAccountId: "acct_a" }])
      .mockResolvedValueOnce([]);

    await makePayeesRepo(prisma).listForCapabilityReconcile({ limit: 200 });

    expect(findMany.mock.calls[1]?.[0]).toEqual({
      where: { ...BASE, capabilitiesSyncedAt: { not: null } },
      orderBy: { capabilitiesSyncedAt: "asc" },
      take: 199, // limit minus the never-synced row already taken
    });
  });

  it("caps never-synced at half the batch so the stale set is always sampled", async () => {
    // Without the cap, permanently-failing never-synced rows (a Stripe account
    // deleted in the dashboard never gets stamped) eventually fill every batch,
    // the second query is never issued, and no synced row is re-read again —
    // the backstop provides zero coverage while still reporting a full scan.
    const { prisma, findMany } = createPrisma();
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await makePayeesRepo(prisma).listForCapabilityReconcile({ limit: 200 });

    expect(findMany.mock.calls[0]?.[0].take).toBe(100);
    // Second query still runs, and gets the rest of the batch.
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1]?.[0].take).toBe(200);
  });

  it("hands unused stale-arm budget back to the never-synced arm", async () => {
    // The measured miss: limit 10 against 6 all-never-synced rows returned 5 —
    // the cap took 5, the stale arm had nothing, and the sixth row plus five
    // slots of budget evaporated. First run after the migration is this shape
    // at scale: every row never-synced, a limit-200 sweep covering only 100.
    const { prisma, findMany } = createPrisma();
    const never = (n: string) => ({ id: n, stripeAccountId: `acct_${n}` });
    findMany
      .mockResolvedValueOnce([1, 2, 3, 4, 5].map((n) => never(`n${n}`)))
      .mockResolvedValueOnce([]) // stale arm: nothing
      .mockResolvedValueOnce([never("n6")]); // refill

    const rows = await makePayeesRepo(prisma).listForCapabilityReconcile({
      limit: 10,
    });

    expect(rows.map((r) => r.id)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
    // The refill must skip what the first arm already took and ask for
    // exactly the unspent budget.
    expect(findMany.mock.calls[2]?.[0]).toEqual({
      where: {
        ...BASE,
        capabilitiesSyncedAt: null,
        id: { notIn: ["n1", "n2", "n3", "n4", "n5"] },
      },
      take: 5,
    });
  });

  it("does not refill when the never-synced arm itself ran dry", async () => {
    // Arm 1 under its cap means there ARE no more never-synced rows; a third
    // query would be a guaranteed-empty round trip on every healthy night.
    const { prisma, findMany } = createPrisma();
    findMany
      .mockResolvedValueOnce([{ id: "n1", stripeAccountId: "acct_n1" }])
      .mockResolvedValueOnce([{ id: "s1", stripeAccountId: "acct_s1" }]);

    await makePayeesRepo(prisma).listForCapabilityReconcile({ limit: 10 });

    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("returns never-synced rows ahead of stale ones", async () => {
    const { prisma, findMany } = createPrisma();
    findMany
      .mockResolvedValueOnce([{ id: "never", stripeAccountId: "acct_n" }])
      .mockResolvedValueOnce([{ id: "stale", stripeAccountId: "acct_s" }]);

    const rows = await makePayeesRepo(prisma).listForCapabilityReconcile({
      limit: 10,
    });

    expect(rows.map((r) => r.id)).toEqual(["never", "stale"]);
  });

  it("dedupes a row a webhook moved between the two queries", async () => {
    // The queries aren't in one transaction. A row stamped between them lands
    // in both sets, and processing it twice would double-count one payee's
    // drift and inflate the alert.
    const { prisma, findMany } = createPrisma();
    findMany
      .mockResolvedValueOnce([{ id: "dup", stripeAccountId: "acct_d" }])
      .mockResolvedValueOnce([{ id: "dup", stripeAccountId: "acct_d" }]);

    const rows = await makePayeesRepo(prisma).listForCapabilityReconcile({
      limit: 10,
    });

    expect(rows).toHaveLength(1);
  });

  it("excludes RESTRICTED and account-less rows from both queries", async () => {
    // RESTRICTED can't be promoted by any write, so a Stripe call for one is
    // pure cost; an account-less payee has nothing to read.
    const { prisma, findMany } = createPrisma();
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await makePayeesRepo(prisma).listForCapabilityReconcile({ limit: 10 });

    for (const call of findMany.mock.calls) {
      expect(call[0].where.status).toEqual({ not: "RESTRICTED" });
      expect(call[0].where.stripeAccountId).toEqual({ not: null });
    }
  });
});

describe("makePayeesRepo.countRestrictedWithStripeAccount", () => {
  it("counts only restricted payees that still hold an account", async () => {
    const { prisma, count } = createPrisma();

    await makePayeesRepo(prisma).countRestrictedWithStripeAccount();

    expect(count).toHaveBeenCalledWith({
      where: { status: "RESTRICTED", stripeAccountId: { not: null } },
    });
  });
});
