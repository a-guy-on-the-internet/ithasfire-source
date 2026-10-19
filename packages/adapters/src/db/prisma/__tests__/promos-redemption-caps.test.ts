import { describe, expect, it, vi } from "vitest";

import { makePromosRepo } from "../promos";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// Promo caps must count LIVE HOLDS, and the hold itself must be the authority.
//
// Money audit 2026-09-08 #8: `getRedemptionStats` counted only confirmed
// redemptions, `createHolds` never re-checked, so every checkout inside the
// hold window passed a cap that was already spoken for, and each one that
// paid confirmed. These are mock-Prisma tests for the QUERY SHAPE and the
// LOCK/CHECK ORDER; the SQL itself is proven against real Postgres in the
// sibling `.integration.test.ts`.
// ---------------------------------------------------------------------------

const PROMO_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_PROMO_ID = "11111111-1111-4111-8111-111111111111";
const BENEFIT_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const HUMAN_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-09-08T12:00:00.000Z");
const EXPIRES_AT = new Date("2026-09-08T12:15:00.000Z");

type RawCall = [TemplateStringsArray, ...unknown[]];

/** Flatten a tagged-template call into the SQL text Postgres would see, with `$n` placeholders. */
function sqlOf(call: RawCall): string {
  const [strings] = call;
  return strings.reduce((acc, part, i) => acc + (i > 0 ? `$${i}` : "") + part, "");
}

function valuesOf(call: RawCall): unknown[] {
  return call.slice(1);
}

function holdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "hold-1",
    promoId: PROMO_ID,
    membershipBenefitId: null,
    orderId: ORDER_ID,
    humanId: HUMAN_ID,
    idempotencyKey: `order:${ORDER_ID}:promo:${PROMO_ID}`,
    code: "FLASH10",
    amountDiscountCents: 500,
    status: "PENDING",
    expiresAt: EXPIRES_AT,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function promoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROMO_ID,
    code: "FLASH10",
    maxRedemptions: null,
    maxRedemptionsPerHuman: null,
    ...overrides,
  };
}

function makePrisma(stats: { total: number; forHuman: number } = { total: 0, forHuman: 0 }) {
  return {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [stats]),
    promo: { findUnique: vi.fn(async () => promoRow()) },
    promoHold: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) =>
        holdRow(args.data),
      ),
      findUnique: vi.fn(async () => null),
    },
    promoRedemption: { count: vi.fn() },
  };
}

function promoInput(promoId = PROMO_ID) {
  return {
    promoId,
    orderId: ORDER_ID,
    humanId: HUMAN_ID,
    idempotencyKey: `order:${ORDER_ID}:promo:${promoId}`,
    code: "FLASH10",
    amountDiscountCents: 500,
    expiresAt: EXPIRES_AT,
  } as const;
}

describe("getRedemptionStats — counts confirmed redemptions PLUS live holds", () => {
  it("is ONE query over both ledgers, keyed on the caller's clock, schema-qualified, parameterised", async () => {
    const prisma = makePrisma({ total: 3, forHuman: 1 });
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    const stats = await repo.getRedemptionStats({
      promoId: PROMO_ID,
      humanId: HUMAN_ID,
      now: NOW,
    });

    expect(stats).toEqual({ totalRedemptions: 3, redemptionsForHuman: 1 });
    // The old shape — two `promoRedemption.count` calls — never sees a hold.
    expect(prisma.promoRedemption.count).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

    const call = prisma.$queryRaw.mock.calls[0] as unknown as RawCall;
    const sql = sqlOf(call);
    // Both halves of the one ledger, on the pooled-Neon-safe schema-qualified names.
    expect(sql).toContain('public."CouponRedemption"');
    expect(sql).toContain('public."CouponHold"');
    // A hold counts only while it is PENDING and still in force: unexpired
    // at the caller's clock OR on an order that is still open. The cart's
    // lifetime is the hold's authority — hold TTL (15 min) < cart TTL
    // (20 min), and a paid cart confirms an expired hold, so dropping it at
    // its TTL let a second checkout double-redeem a cap of one.
    expect(sql).toMatch(/h\.status::text\s*=\s*'PENDING'/);
    expect(sql).toMatch(/"expiresAt"\s*>\s*\$\d/);
    expect(sql).toMatch(
      /"expiresAt"\s*>\s*\$\d+\s+OR\s+EXISTS\s*\(\s*SELECT 1\s+FROM public\."Order" o\s+WHERE o\.id = h\."orderId"\s+AND o\.status::text IN \('PENDING', 'PROCESSING'\)\s*\)/,
    );
    // … and not once its order has already confirmed (that row is the redemption).
    expect(sql).toMatch(/NOT EXISTS/);
    // Nothing interpolated: promo id, clock and human are all bound parameters.
    expect(sql).not.toContain(PROMO_ID);
    expect(sql).not.toContain(HUMAN_ID);
    const values = valuesOf(call);
    expect(values).toContain(PROMO_ID);
    expect(values).toContain(NOW);
    expect(values).toContain(HUMAN_ID);
  });

  it("binds NULL for the human when the caller is anonymous, so the per-human leg is 0", async () => {
    const prisma = makePrisma({ total: 2, forHuman: 0 });
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    const stats = await repo.getRedemptionStats({ promoId: PROMO_ID, now: NOW });

    expect(stats.redemptionsForHuman).toBe(0);
    const values = valuesOf(prisma.$queryRaw.mock.calls[0] as unknown as RawCall);
    expect(values).toContain(null);
  });

  it("excludeOrderId is bound into the HOLD leg only, as IS DISTINCT FROM so a NULL keeps every hold", async () => {
    const prisma = makePrisma({ total: 1, forHuman: 0 });
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    await repo.getRedemptionStats({
      promoId: PROMO_ID,
      humanId: HUMAN_ID,
      now: NOW,
      excludeOrderId: ORDER_ID,
    });

    const call = prisma.$queryRaw.mock.calls[0] as unknown as RawCall;
    const sql = sqlOf(call);
    // `<>` would make a NULL exclusion drop EVERY hold (NULL predicate).
    expect(sql).toMatch(/h\."orderId"\s+IS DISTINCT FROM\s+\$\d+::text/);
    // The redemption leg carries no orderId predicate: a paid order always counts.
    const redemptionLeg = sql.slice(0, sql.indexOf("UNION ALL"));
    expect(redemptionLeg).not.toMatch(/"orderId"/);
    expect(sql).not.toContain(ORDER_ID);
    expect(valuesOf(call)).toContain(ORDER_ID);
  });

  it("with no excludeOrderId the same query binds NULL for it (one query shape)", async () => {
    const prisma = makePrisma();
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    await repo.getRedemptionStats({ promoId: PROMO_ID, humanId: HUMAN_ID, now: NOW });

    const call = prisma.$queryRaw.mock.calls[0] as unknown as RawCall;
    expect(sqlOf(call)).toMatch(/IS DISTINCT FROM/);
    expect(valuesOf(call)).toContain(null);
  });

  it("the locked re-check in createHolds NEVER excludes an order", async () => {
    const prisma = makePrisma({ total: 0, forHuman: 0 });
    prisma.promo.findUnique = vi.fn(async () => promoRow({ maxRedemptionsPerHuman: 1 }));
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    await repo.createHolds([promoInput()], { now: NOW });

    // The count ran (capped promo) and its exclusion slot is NULL, never the
    // hold's own orderId — the authority counts everything.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const values = valuesOf(prisma.$queryRaw.mock.calls[0] as unknown as RawCall);
    expect(values).toContain(null);
    expect(values.filter((v) => v === ORDER_ID)).toHaveLength(0);
  });
});

describe("createHolds — serialises the check-then-hold under a per-promo advisory lock", () => {
  it("takes the lock, THEN reads caps and counts, THEN inserts — in that order", async () => {
    const prisma = makePrisma({ total: 0, forHuman: 0 });
    prisma.promo.findUnique.mockResolvedValue(
      promoRow({ maxRedemptions: 10, maxRedemptionsPerHuman: 1 }),
    );
    const order: string[] = [];
    prisma.$executeRaw.mockImplementation(async () => {
      order.push("lock");
      return 1;
    });
    prisma.$queryRaw.mockImplementation(async () => {
      order.push("count");
      return [{ total: 0, forHuman: 0 }];
    });
    prisma.promoHold.create.mockImplementation(async (args) => {
      order.push("insert");
      return holdRow(args.data);
    });

    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);
    const [hold] = await repo.createHolds([promoInput()], { now: NOW });

    expect(hold?.promoId).toBe(PROMO_ID);
    expect(order).toEqual(["lock", "count", "insert"]);

    const lockCall = prisma.$executeRaw.mock.calls[0] as unknown as RawCall;
    expect(sqlOf(lockCall)).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
    // Namespaced key, bound not interpolated — same shape as
    // `ticket_type_capacity:` in tickets.ts.
    expect(valuesOf(lockCall)).toEqual([`promo_hold:${PROMO_ID}`]);
    // The count inside the lock uses the caller's clock, not the DB's.
    expect(valuesOf(prisma.$queryRaw.mock.calls[0] as unknown as RawCall)).toContain(NOW);
  });

  it("REJECTS with promo_max_redeemed when the locked count meets maxRedemptions — never silently drops the discount", async () => {
    const prisma = makePrisma({ total: 10, forHuman: 0 });
    prisma.promo.findUnique.mockResolvedValue(promoRow({ maxRedemptions: 10 }));
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    await expect(
      repo.createHolds([promoInput()], { now: NOW }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "promo_max_redeemed",
      promoCode: "FLASH10",
    });
    expect(prisma.promoHold.create).not.toHaveBeenCalled();
  });

  it("REJECTS with promo_redeemed_by_human when this human already holds or redeemed the cap", async () => {
    const prisma = makePrisma({ total: 1, forHuman: 1 });
    prisma.promo.findUnique.mockResolvedValue(
      promoRow({ maxRedemptionsPerHuman: 1 }),
    );
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    await expect(
      repo.createHolds([promoInput()], { now: NOW }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "promo_redeemed_by_human",
      promoCode: "FLASH10",
    });
    expect(prisma.promoHold.create).not.toHaveBeenCalled();
  });

  it("skips the count entirely for an uncapped promo (still locks, still inserts)", async () => {
    const prisma = makePrisma();
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    await repo.createHolds([promoInput()], { now: NOW });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.promoHold.create).toHaveBeenCalledTimes(1);
  });

  it("locks multiple promos in a deterministic (sorted) order to keep two checkouts from deadlocking", async () => {
    const prisma = makePrisma();
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    // Given in reverse-sorted order; locks must still be taken ascending.
    await repo.createHolds([promoInput(PROMO_ID), promoInput(OTHER_PROMO_ID)], {
      now: NOW,
    });

    const keys = prisma.$executeRaw.mock.calls.map(
      (call) => valuesOf(call as unknown as RawCall)[0],
    );
    expect(keys).toEqual([
      `promo_hold:${OTHER_PROMO_ID}`,
      `promo_hold:${PROMO_ID}`,
    ]);
    // All locks precede the first insert.
    const firstInsert = prisma.promoHold.create.mock.invocationCallOrder[0]!;
    for (const lock of prisma.$executeRaw.mock.invocationCallOrder) {
      expect(lock).toBeLessThan(firstInsert);
    }
  });

  it("idempotent re-entry: an existing hold for the key is returned WITHOUT a cap re-check or a second insert", async () => {
    // The retry's own hold is in the count. Re-checking would reject the
    // buyer for the slot they already own.
    const prisma = makePrisma({ total: 1, forHuman: 1 });
    prisma.promo.findUnique.mockResolvedValue(
      promoRow({ maxRedemptions: 1, maxRedemptionsPerHuman: 1 }),
    );
    prisma.promoHold.findUnique.mockResolvedValue(holdRow());
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    const [hold] = await repo.createHolds([promoInput()], { now: NOW });

    expect(hold?.id).toBe("hold-1");
    expect(prisma.promoHold.findUnique).toHaveBeenCalledWith({
      where: {
        promoId_idempotencyKey: {
          promoId: PROMO_ID,
          idempotencyKey: `order:${ORDER_ID}:promo:${PROMO_ID}`,
        },
      },
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.promoHold.create).not.toHaveBeenCalled();
  });

  it("a membership-benefit hold has no caps: no lock, no count, plain insert", async () => {
    const prisma = makePrisma();
    prisma.promoHold.create.mockImplementation(async (args) =>
      holdRow({ ...args.data, promoId: null, membershipBenefitId: BENEFIT_ID }),
    );
    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);

    const [hold] = await repo.createHolds(
      [
        {
          membershipBenefitId: BENEFIT_ID,
          orderId: ORDER_ID,
          humanId: HUMAN_ID,
          idempotencyKey: `order:${ORDER_ID}:benefit:${BENEFIT_ID}`,
          code: `benefit:${BENEFIT_ID}`,
          amountDiscountCents: 500,
          expiresAt: EXPIRES_AT,
        },
      ],
      { now: NOW },
    );

    expect(hold?.membershipBenefitId).toBe(BENEFIT_ID);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.promo.findUnique).not.toHaveBeenCalled();
  });
});
