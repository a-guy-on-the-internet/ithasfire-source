import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { makeMembershipTiersRepo } from "../../../src/db/prisma/membership-tiers";
import { makePromosRepo } from "../../../src/db/prisma/promos";
import type { PrismaClientOrTx } from "../../../src/db/prisma/types";

/**
 * The two branches the membership-benefit refactor added to the ONE discount
 * ledger, and the only ones with no coverage anywhere else: `createHolds`'
 * P2002 idempotent read-back, and `confirmHoldsForOrder`'s upsert, each of
 * which now has to follow whichever source the row carries.
 *
 * These are unit tests against a fake Prisma client rather than integration
 * tests because the real-Postgres suite silently skips without a database, and
 * a silently-skipped test for money-movement idempotency is worse than none —
 * it reads as coverage. What a fake CAN prove is the branch selection: that a
 * benefit hold reads back on `membershipBenefitId_idempotencyKey` and not on
 * the promo unique, and that a benefit confirm upserts on the benefit key. The
 * DB-level guarantees behind them (the `*_source_xor` CHECKs, NULL-distinct
 * uniques) are the migration's job and are asserted there.
 */

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const BENEFIT_ID = "33333333-3333-4333-8333-333333333333";
const PROMO_ID = "44444444-4444-4444-8444-444444444444";
const EXPIRES_AT = new Date("2026-08-17T12:15:00.000Z");
const NOW = new Date("2026-08-17T12:00:00.000Z");

function holdRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "hold-1",
    promoId: null,
    membershipBenefitId: BENEFIT_ID,
    orderId: ORDER_ID,
    humanId: HUMAN_ID,
    idempotencyKey: `order:${ORDER_ID}:benefit:${BENEFIT_ID}`,
    code: `benefit:${BENEFIT_ID}`,
    amountDiscountCents: 500,
    status: "PENDING",
    expiresAt: EXPIRES_AT,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePrisma() {
  return {
    // createHolds now takes the per-promo advisory lock and re-checks caps
    // under it; benefit holds take no lock, typed codes hit these.
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ total: 0, forHuman: 0 }]),
    promo: {
      findUnique: vi.fn(async () => ({
        code: "EARLY",
        maxRedemptions: null,
        maxRedemptionsPerHuman: null,
      })),
    },
    promoHold: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    promoRedemption: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
}

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "7.1.0",
  });
}

describe("createHolds — membership-benefit source", () => {
  it("writes membershipBenefitId and leaves promoId null", async () => {
    const prisma = makePrisma();
    prisma.promoHold.create.mockResolvedValue(holdRow());

    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);
    const [hold] = await repo.createHolds([
      {
        membershipBenefitId: BENEFIT_ID,
        orderId: ORDER_ID,
        humanId: HUMAN_ID,
        idempotencyKey: `order:${ORDER_ID}:benefit:${BENEFIT_ID}`,
        code: `benefit:${BENEFIT_ID}`,
        amountDiscountCents: 500,
        expiresAt: EXPIRES_AT,
      },
    ], { now: NOW });

    expect(prisma.promoHold.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        promoId: null,
        membershipBenefitId: BENEFIT_ID,
        // NOT uppercased. Normalization exists to match a typed code against
        // `Promo.codeNormalized`; a benefit marker matches nothing, and
        // uppercasing it would make the ledger disagree with the identical
        // string this order's PaymentIntent metadata carries.
        code: `benefit:${BENEFIT_ID}`,
      }),
    });
    expect(hold?.membershipBenefitId).toBe(BENEFIT_ID);
    expect(hold?.promoId).toBeNull();
  });

  it("still normalizes a TYPED code's casing", async () => {
    const prisma = makePrisma();
    prisma.promoHold.create.mockResolvedValue(
      holdRow({ promoId: PROMO_ID, membershipBenefitId: null, code: "EARLY" }),
    );

    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);
    await repo.createHolds([
      {
        promoId: PROMO_ID,
        orderId: ORDER_ID,
        humanId: HUMAN_ID,
        idempotencyKey: `order:${ORDER_ID}:promo:${PROMO_ID}`,
        code: " early ",
        amountDiscountCents: 500,
        expiresAt: EXPIRES_AT,
      },
    ], { now: NOW });

    expect(prisma.promoHold.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ code: "EARLY" }),
    });
  });

  it("on P2002, reads the existing hold back on the BENEFIT unique", async () => {
    // The retry is what makes a re-entered checkout idempotent instead of
    // double-discounting. Two uniques now guard `idempotencyKey` — one per
    // source — so reading back on the wrong one would 500 (or, worse, return
    // someone else's row).
    const prisma = makePrisma();
    prisma.promoHold.create.mockRejectedValue(p2002());
    prisma.promoHold.findUnique.mockResolvedValue(holdRow());

    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);
    const [hold] = await repo.createHolds([
      {
        membershipBenefitId: BENEFIT_ID,
        orderId: ORDER_ID,
        humanId: HUMAN_ID,
        idempotencyKey: `order:${ORDER_ID}:benefit:${BENEFIT_ID}`,
        code: `benefit:${BENEFIT_ID}`,
        amountDiscountCents: 500,
        expiresAt: EXPIRES_AT,
      },
    ], { now: NOW });

    expect(prisma.promoHold.findUnique).toHaveBeenCalledWith({
      where: {
        membershipBenefitId_idempotencyKey: {
          membershipBenefitId: BENEFIT_ID,
          idempotencyKey: `order:${ORDER_ID}:benefit:${BENEFIT_ID}`,
        },
      },
    });
    // One hold returned, not two — the discount is claimed once.
    expect(hold?.id).toBe("hold-1");
  });

  it("on P2002 for a typed code, reads back on the PROMO unique", async () => {
    const prisma = makePrisma();
    prisma.promoHold.create.mockRejectedValue(p2002());
    prisma.promoHold.findUnique.mockResolvedValue(
      holdRow({ promoId: PROMO_ID, membershipBenefitId: null }),
    );

    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);
    await repo.createHolds([
      {
        promoId: PROMO_ID,
        orderId: ORDER_ID,
        humanId: HUMAN_ID,
        idempotencyKey: `order:${ORDER_ID}:promo:${PROMO_ID}`,
        code: "EARLY",
        amountDiscountCents: 500,
        expiresAt: EXPIRES_AT,
      },
    ], { now: NOW });

    expect(prisma.promoHold.findUnique).toHaveBeenCalledWith({
      where: {
        promoId_idempotencyKey: {
          promoId: PROMO_ID,
          idempotencyKey: `order:${ORDER_ID}:promo:${PROMO_ID}`,
        },
      },
    });
  });

  it("rethrows P2002 when the hold cannot be read back", async () => {
    // A P2002 with no matching row means the collision came from somewhere
    // this branch does not understand. Swallowing it would silently drop a
    // discount the buyer was quoted.
    const prisma = makePrisma();
    prisma.promoHold.create.mockRejectedValue(p2002());
    prisma.promoHold.findUnique.mockResolvedValue(null);

    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);
    await expect(
      repo.createHolds([
        {
          membershipBenefitId: BENEFIT_ID,
          orderId: ORDER_ID,
          humanId: HUMAN_ID,
          idempotencyKey: "k",
          code: "c",
          amountDiscountCents: 500,
          expiresAt: EXPIRES_AT,
        },
      ], { now: NOW }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("confirmHoldsForOrder — source-agnostic, one lifecycle", () => {
  it("upserts a benefit redemption on the BENEFIT unique", async () => {
    const prisma = makePrisma();
    prisma.promoHold.findMany.mockResolvedValue([holdRow()]);
    prisma.promoHold.update.mockResolvedValue(holdRow({ status: "CONFIRMED" }));
    prisma.promoRedemption.upsert.mockResolvedValue({
      id: "red-1",
      promoId: null,
      membershipBenefitId: BENEFIT_ID,
      orderId: ORDER_ID,
      humanId: HUMAN_ID,
      code: `benefit:${BENEFIT_ID}`,
      amountDiscountCents: 500,
      redeemedAt: NOW,
    });

    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);
    const [redemption] = await repo.confirmHoldsForOrder({
      orderId: ORDER_ID,
      confirmedAt: NOW,
    });

    expect(prisma.promoRedemption.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          membershipBenefitId_orderId: {
            membershipBenefitId: BENEFIT_ID,
            orderId: ORDER_ID,
          },
        },
        create: expect.objectContaining({
          promoId: null,
          membershipBenefitId: BENEFIT_ID,
        }),
      }),
    );
    expect(redemption?.membershipBenefitId).toBe(BENEFIT_ID);
    expect(redemption?.promoId).toBeNull();
  });

  it("upserts a typed redemption on the PROMO unique — behaviour unchanged", async () => {
    const prisma = makePrisma();
    prisma.promoHold.findMany.mockResolvedValue([
      holdRow({ promoId: PROMO_ID, membershipBenefitId: null, code: "EARLY" }),
    ]);
    prisma.promoHold.update.mockResolvedValue(holdRow());
    prisma.promoRedemption.upsert.mockResolvedValue({
      id: "red-2",
      promoId: PROMO_ID,
      membershipBenefitId: null,
      orderId: ORDER_ID,
      humanId: HUMAN_ID,
      code: "EARLY",
      amountDiscountCents: 500,
      redeemedAt: NOW,
    });

    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);
    await repo.confirmHoldsForOrder({ orderId: ORDER_ID, confirmedAt: NOW });

    expect(prisma.promoRedemption.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { promoId_orderId: { promoId: PROMO_ID, orderId: ORDER_ID } },
      }),
    );
  });

  it("confirms BOTH sources on one order, each on its own key", async () => {
    // The order that made the `promoRedemptions[0]` reads unsafe: a member who
    // also types a stackable code produces two rows in the one ledger.
    const prisma = makePrisma();
    prisma.promoHold.findMany.mockResolvedValue([
      holdRow({ promoId: PROMO_ID, membershipBenefitId: null, code: "EARLY" }),
      holdRow({ id: "hold-2" }),
    ]);
    prisma.promoHold.update.mockResolvedValue(holdRow());
    prisma.promoRedemption.upsert.mockImplementation(async () => ({
      id: "red",
      promoId: null,
      membershipBenefitId: BENEFIT_ID,
      orderId: ORDER_ID,
      humanId: HUMAN_ID,
      code: "c",
      amountDiscountCents: 500,
      redeemedAt: NOW,
    }));

    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);
    const redemptions = await repo.confirmHoldsForOrder({
      orderId: ORDER_ID,
      confirmedAt: NOW,
    });

    expect(redemptions).toHaveLength(2);
    const wheres = prisma.promoRedemption.upsert.mock.calls.map(
      (call) => Object.keys((call[0] as { where: object }).where)[0],
    );
    expect(wheres).toEqual([
      "promoId_orderId",
      "membershipBenefitId_orderId",
    ]);
  });

  it("skips RELEASED holds regardless of source", async () => {
    const prisma = makePrisma();
    prisma.promoHold.findMany.mockResolvedValue([
      holdRow({ status: "RELEASED" }),
    ]);

    const repo = makePromosRepo(prisma as unknown as PrismaClientOrTx);
    const redemptions = await repo.confirmHoldsForOrder({
      orderId: ORDER_ID,
      confirmedAt: NOW,
    });

    expect(redemptions).toEqual([]);
    expect(prisma.promoRedemption.upsert).not.toHaveBeenCalled();
  });
});

// ── Benefit retirement ──────────────────────────────────────────────────────

describe("membership benefits are RETIRED, not deleted", () => {
  function benefitPrisma() {
    return {
      membershipBenefit: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn(),
        create: vi.fn(),
      },
      membershipTier: { findMany: vi.fn(), findUnique: vi.fn() },
      membership: { count: vi.fn() },
    };
  }

  it("`deleteBenefit` stamps archivedAt instead of issuing a DELETE", async () => {
    // The whole point: a DELETE cascades into CouponRedemption and erases the
    // platform's record of granted margin. Nothing in the app may issue one.
    const prisma = benefitPrisma();
    const repo = makeMembershipTiersRepo(prisma as never);

    const archivedAt = new Date("2026-08-20T12:00:00.000Z");
    await repo.deleteBenefit({ id: BENEFIT_ID, archivedAt });

    expect(prisma.membershipBenefit.delete).not.toHaveBeenCalled();
    // The caller's instant, verbatim — `expect.any(Date)` would have passed
    // just as happily against an adapter reaching for wall time.
    expect(prisma.membershipBenefit.update).toHaveBeenCalledWith({
      where: { id: BENEFIT_ID },
      data: { archivedAt },
    });
  });

  it("retired benefits are excluded from checkout resolution", async () => {
    const prisma = benefitPrisma();
    const repo = makeMembershipTiersRepo(prisma as never);

    await repo.listBenefitsForTiers(["tier-1"]);

    expect(prisma.membershipBenefit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tierId: { in: ["tier-1"] }, archivedAt: null },
      }),
    );
  });

  it("a retired benefit is invisible to the edit/remove surface", async () => {
    // Same rule as checkout, so an owner cannot edit terms on something that
    // no longer grants anything.
    const prisma = benefitPrisma();
    prisma.membershipBenefit.findUnique.mockResolvedValue({
      id: BENEFIT_ID,
      tierId: "tier-1",
      discountKind: "AMOUNT",
      discountValue: 500,
      maxDiscountCents: null,
      categoryId: null,
      placeId: null,
      label: null,
      archivedAt: new Date("2026-08-20T00:00:00.000Z"),
    });
    const repo = makeMembershipTiersRepo(prisma as never);

    await expect(repo.findBenefitById(BENEFIT_ID)).resolves.toBeNull();
  });
});
