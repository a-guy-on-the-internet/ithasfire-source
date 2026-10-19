import { describe, expect, it, vi } from "vitest";

import { makeOrderItemsRepo } from "../order-items";
import { makeOrdersRepo } from "../orders";
import { clonePayoutTermsRow, makePayoutTermsRepo } from "../payout-terms";
import { makeResaleListingsRepo } from "../resale-listings";
import type { PrismaClientOrTx } from "../types";

/**
 * Organiser share of every resale, step B1 (schema): the new clause columns on
 * PayoutTerms, the FR-003 record on OrderItem, and the per-sale share on
 * Listing are read into the domain records and written where the sibling
 * fields are written. The SQL CHECKs that hold the shapes live in migration
 * 20261012190000_resale_share_clause and are not exercised here (mocked
 * Prisma).
 */

const TERMS_ID = "00000000-0000-4000-8000-00000000c001";

function termsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TERMS_ID,
    kind: "RESALE",
    status: "ACTIVE",
    isDefault: true,
    version: 4,
    settlementCurrency: "usd",
    feeMode: null,
    feePolicyId: null,
    payoutSchedule: "TWO_WEEKS_AFTER",
    resaleProcessingFeeConfigRef: null,
    resalePayoutReleaseDays: 7,
    resaleShareType: "PERCENT",
    resaleShareBps: 750,
    resaleShareCents: null,
    resaleSharePayer: "BUYER",
    effectiveFrom: null,
    effectiveTo: null,
    remainderPayeeId: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  };
}

describe("PayoutTerms resale share clause (FR-001)", () => {
  it("getById maps the clause onto the record", async () => {
    const findUnique = vi.fn(async () =>
      termsRow({
        resaleShareType: "FLAT",
        resaleShareBps: null,
        resaleShareCents: 300,
        resaleSharePayer: "SELLER",
      }),
    );
    const repo = makePayoutTermsRepo({
      payoutTerms: { findUnique },
    } as unknown as PrismaClientOrTx);

    const record = await repo.getById(TERMS_ID);

    expect(record).toMatchObject({
      resaleShareType: "FLAT",
      resaleShareBps: null,
      resaleShareCents: 300,
      resaleSharePayer: "SELLER",
    });
  });

  it("maps a not-set clause (legacy row) to null type, null amounts", async () => {
    const findUnique = vi.fn(async () =>
      termsRow({
        resaleShareType: null,
        resaleShareBps: null,
        resaleShareCents: null,
        resaleSharePayer: "SELLER",
      }),
    );
    const repo = makePayoutTermsRepo({
      payoutTerms: { findUnique },
    } as unknown as PrismaClientOrTx);

    const record = await repo.getById(TERMS_ID);

    expect(record?.resaleShareType).toBeNull();
    expect(record?.resaleShareBps).toBeNull();
    expect(record?.resaleShareCents).toBeNull();
  });

  it("clone copies the clause, so an event snapshot of the org default keeps it", async () => {
    const created: Array<Record<string, unknown>> = [];
    const payoutTerms = {
      findUnique: vi.fn(async () => ({
        ...termsRow(),
        lines: [],
        deductions: [],
        feePolicy: null,
      })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { ...termsRow(), ...data, id: "clone-1" };
      }),
    };

    await clonePayoutTermsRow({ payoutTerms } as unknown as PrismaClientOrTx, {
      sourcePayoutTermsId: TERMS_ID,
      isDefault: false,
      resetFeeMode: true,
    });

    expect(created[0]).toMatchObject({
      resaleShareType: "PERCENT",
      resaleShareBps: 750,
      resaleShareCents: null,
      resaleSharePayer: "BUYER",
    });
  });

  it("createDraft leaves the clause not set and the payer to the schema default when omitted", async () => {
    const create = vi.fn(async (_input: { data: Record<string, unknown> }) =>
      termsRow({ status: "PENDING", resaleShareType: null, resaleShareBps: null }),
    );
    const repo = makePayoutTermsRepo({
      payoutTerms: { create },
    } as unknown as PrismaClientOrTx);

    await repo.createDraft({ kind: "RESALE", settlementCurrency: "usd" });

    const data = create.mock.calls[0]![0].data;
    expect(data.resaleShareType).toBeNull();
    expect(data.resaleShareBps).toBeNull();
    expect(data.resaleShareCents).toBeNull();
    expect("resaleSharePayer" in data).toBe(false);
  });

  it("createDraft writes a clause when given", async () => {
    const create = vi.fn(async (_input: { data: Record<string, unknown> }) =>
      termsRow({ status: "PENDING" }),
    );
    const repo = makePayoutTermsRepo({
      payoutTerms: { create },
    } as unknown as PrismaClientOrTx);

    await repo.createDraft({
      kind: "RESALE",
      settlementCurrency: "usd",
      resaleShareType: "FLAT",
      resaleShareCents: 200,
      resaleSharePayer: "BUYER",
    });

    expect(create.mock.calls[0]![0].data).toMatchObject({
      resaleShareType: "FLAT",
      resaleShareBps: null,
      resaleShareCents: 200,
      resaleSharePayer: "BUYER",
    });
  });

  it("updateDraft writes only the clause fields it is given", async () => {
    const update = vi.fn(async (_input: { data: Record<string, unknown> }) =>
      termsRow(),
    );
    const repo = makePayoutTermsRepo({
      payoutTerms: { update },
    } as unknown as PrismaClientOrTx);

    await repo.updateDraft({
      payoutTermsId: TERMS_ID,
      resaleShareType: "PERCENT",
      resaleShareBps: 500,
      resaleShareCents: null,
    });

    const data = update.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      resaleShareType: "PERCENT",
      resaleShareBps: 500,
      resaleShareCents: null,
    });
    expect("resaleSharePayer" in data).toBe(false);
    expect("version" in data).toBe(false);
  });

  it("updateDraft bumps the version in the same UPDATE only when asked (B5a)", async () => {
    const update = vi.fn(async (_input: { data: Record<string, unknown> }) =>
      termsRow(),
    );
    const repo = makePayoutTermsRepo({
      payoutTerms: { update },
    } as unknown as PrismaClientOrTx);

    await repo.updateDraft({
      payoutTermsId: TERMS_ID,
      resaleShareType: "FLAT",
      resaleShareBps: null,
      resaleShareCents: 300,
      resaleSharePayer: "BUYER",
      bumpVersion: true,
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0].data).toMatchObject({
      resaleShareType: "FLAT",
      resaleShareCents: 300,
      version: { increment: 1 },
    });
  });
});

const CLAUSE_RECORD = {
  resaleClauseType: "PERCENT" as const,
  resaleClauseBps: 500,
  resaleClauseCents: null,
  resaleClausePayer: "SELLER" as const,
  resaleClauseTermsId: TERMS_ID,
  resaleClauseTermsVersion: 4,
  originalUnitPriceCents: 2500,
  eventShareCents: 150,
  sharePayer: "SELLER" as const,
};

function orderItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "oi-1",
    orderId: "o-1",
    kind: "ticket",
    ticketTypeId: "tt-1",
    qty: 1,
    unitPriceCents: 3000,
    amountCents: 3000,
    meta: {},
    paidOutAt: null,
    refundedAt: null,
    refundedTaxCents: null,
    transferredAt: null,
    resaleListingId: "l-1",
    resaleFaceValueCents: 2500,
    resaleProcessingPassThroughCents: 0,
    resaleProcessingFeeConfigRef: null,
    resaleSaleCutoffAt: null,
    resalePayoutReleaseAt: null,
    resalePayoutStatus: null,
    resalePayoutHeldAt: null,
    resalePayoutHoldReason: null,
    resalePayoutNoticeSentAt: null,
    resalePayoutReminderSentAt: null,
    resalePayoutFinalNoticeSentAt: null,
    ...CLAUSE_RECORD,
    status: "active",
    ...overrides,
  };
}

describe("OrderItem resale share record (FR-003)", () => {
  it("order-items getById maps the record and the per-sale share", async () => {
    const repo = makeOrderItemsRepo({
      orderItem: { findUnique: vi.fn(async () => orderItemRow()) },
    } as unknown as PrismaClientOrTx);

    const record = await repo.getById("oi-1");

    expect(record).toMatchObject(CLAUSE_RECORD);
  });

  it("maps a legacy item with no record to nulls", async () => {
    const repo = makeOrderItemsRepo({
      orderItem: {
        findUnique: vi.fn(async () =>
          orderItemRow({
            resaleClauseType: null,
            resaleClauseBps: null,
            resaleClausePayer: null,
            resaleClauseTermsId: null,
            resaleClauseTermsVersion: null,
            originalUnitPriceCents: null,
            eventShareCents: null,
            sharePayer: null,
          }),
        ),
      },
    } as unknown as PrismaClientOrTx);

    const record = await repo.getById("oi-1");

    expect(record?.resaleClauseType).toBeNull();
    expect(record?.originalUnitPriceCents).toBeNull();
    expect(record?.eventShareCents).toBeNull();
  });

  it("orders createPending writes the record onto each item, and nulls when omitted", async () => {
    const create = vi.fn(
      async (_input: {
        data: { items: { create: Array<Record<string, unknown>> } };
      }) => ({
        id: "o-1",
        amountGrossCents: 3000,
        feesPlatformCents: 0,
        currency: "usd",
      }),
    );
    const repo = makeOrdersRepo({
      order: { create },
    } as unknown as PrismaClientOrTx);

    await repo.createPending({
      eventId: "e-1",
      buyerHumanId: "h-1",
      amountGrossCents: 3000,
      feesPlatformCents: 0,
      currency: "usd",
      items: [
        {
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 3000,
          amountCents: 3000,
          ...CLAUSE_RECORD,
        },
        {
          kind: "ticket",
          ticketTypeId: "tt-1",
          qty: 1,
          unitPriceCents: 3000,
          amountCents: 3000,
        },
      ],
    });

    const items = create.mock.calls[0]![0].data.items.create;
    expect(items[0]).toMatchObject(CLAUSE_RECORD);
    expect(items[1]).toMatchObject({
      resaleClauseType: null,
      resaleClauseBps: null,
      resaleClauseCents: null,
      resaleClausePayer: null,
      resaleClauseTermsId: null,
      resaleClauseTermsVersion: null,
      originalUnitPriceCents: null,
      eventShareCents: null,
      sharePayer: null,
    });
  });
});

describe("OrderItem resale share record through a cart re-price (updatePendingItems)", () => {
  function prismaForRepricing() {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const update = vi.fn(
      async ({
        data,
      }: {
        data: { items: { create: Array<Record<string, unknown>> } };
      }) => ({
        id: "o-1",
        kind: "TICKETING",
        status: "PENDING",
        items: data.items.create.map((created, i) => ({
          ...orderItemRow(),
          ...created,
          id: `oi-${i}`,
        })),
      }),
    );
    return {
      prisma: { order: { updateMany, update } } as unknown as PrismaClientOrTx,
      update,
    };
  }

  const baseItem = {
    kind: "ticket" as const,
    ticketTypeId: "tt-1",
    qty: 1,
    unitPriceCents: 3000,
    amountCents: 3000,
  };

  it("writes the record onto each recreated item and maps it back", async () => {
    const { prisma, update } = prismaForRepricing();
    const repo = makeOrdersRepo(prisma);

    const result = await repo.updatePendingItems({
      orderId: "o-1",
      amountGrossCents: 3000,
      feesPlatformCents: 0,
      currency: "usd",
      items: [{ ...baseItem, ...CLAUSE_RECORD }],
    });

    const items = update.mock.calls[0]![0].data.items.create;
    expect(items[0]).toMatchObject(CLAUSE_RECORD);
    expect(result?.items[0]).toMatchObject(CLAUSE_RECORD);
  });

  it("writes nulls for every record field when they are omitted", async () => {
    const { prisma, update } = prismaForRepricing();
    const repo = makeOrdersRepo(prisma);

    await repo.updatePendingItems({
      orderId: "o-1",
      amountGrossCents: 3000,
      feesPlatformCents: 0,
      currency: "usd",
      items: [baseItem],
    });

    const items = update.mock.calls[0]![0].data.items.create;
    expect(items[0]).toMatchObject({
      resaleClauseType: null,
      resaleClauseBps: null,
      resaleClauseCents: null,
      resaleClausePayer: null,
      resaleClauseTermsId: null,
      resaleClauseTermsVersion: null,
      originalUnitPriceCents: null,
      eventShareCents: null,
      sharePayer: null,
    });
  });
});

describe("Listing per-sale share (FR-005)", () => {
  it("create writes eventShareCents and sharePayer and maps them back", async () => {
    const create = vi.fn(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "l-1",
        status: "ACTIVE",
        source: "internal",
        externalRef: null,
        buyerOrderId: null,
        createdAt: new Date("2026-10-12T00:00:00Z"),
        updatedAt: new Date("2026-10-12T00:00:00Z"),
        ...data,
      }),
    );
    const repo = makeResaleListingsRepo({
      resaleListing: { create },
    } as unknown as PrismaClientOrTx);

    const record = await repo.create({
      ticketId: "t-1",
      eventId: "e-1",
      sellerHumanId: "h-1",
      askPriceCents: 4000,
      eventShareCents: 400,
      sharePayer: "BUYER",
    });

    expect(create.mock.calls[0]![0].data).toMatchObject({
      eventShareCents: 400,
      sharePayer: "BUYER",
    });
    expect(record).toMatchObject({ eventShareCents: 400, sharePayer: "BUYER" });
  });

  it("create writes nulls when the share is omitted", async () => {
    const create = vi.fn(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "l-2",
        status: "ACTIVE",
        source: "internal",
        externalRef: null,
        buyerOrderId: null,
        createdAt: new Date("2026-10-12T00:00:00Z"),
        updatedAt: new Date("2026-10-12T00:00:00Z"),
        ...data,
      }),
    );
    const repo = makeResaleListingsRepo({
      resaleListing: { create },
    } as unknown as PrismaClientOrTx);

    const record = await repo.create({
      ticketId: "t-1",
      eventId: "e-1",
      sellerHumanId: "h-1",
      askPriceCents: 4000,
    });

    expect(record.eventShareCents).toBeNull();
    expect(record.sharePayer).toBeNull();
  });
});
