import { describe, expect, it, vi } from "vitest";

import { makePayoutTermsRepo } from "../payout-terms";
import type { PrismaClientOrTx } from "../types";

const TERMS_ID = "00000000-0000-4000-8000-000000000001";

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TERMS_ID,
    kind: "PRIMARY",
    status: "ACTIVE",
    feeMode: "PASS_THROUGH",
    feePolicyId: null,
    isDefault: false,
    settlementCurrency: "usd",
    payoutSchedule: "WEEK_OF_EVENT",
    resaleProcessingFeeConfigRef: null,
    resalePayoutReleaseDays: 7,
    version: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("makePayoutTermsRepo.archive (booking-the-night FR-009)", () => {
  it("CAS-archives a row whose status is in expectedFrom and returns the updated record", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn(async () => buildRow({ status: "ARCHIVED" }));
    const prisma = {
      payoutTerms: { updateMany, findUnique },
    } as unknown as PrismaClientOrTx;

    const result = await makePayoutTermsRepo(prisma).archive({
      payoutTermsId: TERMS_ID,
      expectedFrom: ["PENDING", "ACTIVE"],
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: TERMS_ID, status: { in: ["PENDING", "ACTIVE"] } },
      data: { status: "ARCHIVED", updatedAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ id: TERMS_ID, status: "ARCHIVED" });
  });

  it("returns null on a 0-match (already archived, or moved), without a re-fetch", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const findUnique = vi.fn();
    const prisma = {
      payoutTerms: { updateMany, findUnique },
    } as unknown as PrismaClientOrTx;

    const result = await makePayoutTermsRepo(prisma).archive({
      payoutTermsId: TERMS_ID,
      expectedFrom: ["PENDING", "ACTIVE"],
    });

    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("makePayoutTermsRepo.activate", () => {
  it("CAS-activates a row whose status is in expectedFrom and returns the updated record", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn(async () => buildRow({ status: "ACTIVE" }));
    const prisma = {
      payoutTerms: { updateMany, findUnique },
    } as unknown as PrismaClientOrTx;
    const repo = makePayoutTermsRepo(prisma);

    const result = await repo.activate({
      payoutTermsId: TERMS_ID,
      expectedFrom: ["PENDING"],
    });

    // The WHERE pins the stored status so the transition is a true CAS.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: TERMS_ID, status: { in: ["PENDING"] } },
      data: { status: "ACTIVE", updatedAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ id: TERMS_ID, status: "ACTIVE" });
  });

  it("returns null on a 0-match (e.g. expectedFrom PENDING against an already-ACTIVE row)", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const findUnique = vi.fn();
    const prisma = {
      payoutTerms: { updateMany, findUnique },
    } as unknown as PrismaClientOrTx;
    const repo = makePayoutTermsRepo(prisma);

    const result = await repo.activate({
      payoutTermsId: TERMS_ID,
      expectedFrom: ["PENDING"],
    });

    expect(result).toBeNull();
    // No re-fetch when the guarded write did not land.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns null when the row vanishes between the guarded write and the re-fetch", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn(async () => null);
    const prisma = {
      payoutTerms: { updateMany, findUnique },
    } as unknown as PrismaClientOrTx;
    const repo = makePayoutTermsRepo(prisma);

    const result = await repo.activate({
      payoutTermsId: TERMS_ID,
      expectedFrom: ["PENDING"],
    });

    expect(result).toBeNull();
  });
});

describe("makePayoutTermsRepo.seedLinesIfEmpty", () => {
  const OWNER_LINE = {
    payeeId: "00000000-0000-4000-8000-000000000002",
    percent: 100,
    floorCents: 0,
    capPercent: null,
    priority: 0,
    rounding: "FLOOR" as const,
    requiresConfirmation: false,
  };

  it("returns true when the conditional insert lands (row had zero lines)", async () => {
    const $executeRaw = vi.fn(async (..._args: unknown[]) => 1);
    const prisma = { $executeRaw } as unknown as PrismaClientOrTx;
    const repo = makePayoutTermsRepo(prisma);

    const seeded = await repo.seedLinesIfEmpty(TERMS_ID, [OWNER_LINE]);

    expect(seeded).toBe(true);
    expect($executeRaw).toHaveBeenCalledTimes(1);
    // The whole guard lives in ONE statement: INSERT … SELECT … WHERE NOT
    // EXISTS, so a concurrent splits commit can't be clobbered.
    const templateParts = $executeRaw.mock.calls[0]![0] as readonly string[];
    const sqlText = [...templateParts].join(" ");
    expect(sqlText).toContain('INSERT INTO "PayoutTermsLine"');
    expect(sqlText).toContain("NOT EXISTS");
  });

  it("returns false on a 0-match (lines appeared concurrently) without any other write", async () => {
    const $executeRaw = vi.fn(async () => 0);
    const deleteMany = vi.fn();
    const prisma = {
      $executeRaw,
      payoutTermsLine: { deleteMany },
    } as unknown as PrismaClientOrTx;
    const repo = makePayoutTermsRepo(prisma);

    const seeded = await repo.seedLinesIfEmpty(TERMS_ID, [OWNER_LINE]);

    expect(seeded).toBe(false);
    // Never falls back to replaceLines-style delete-all semantics.
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("no-ops (false) for an empty seed list", async () => {
    const $executeRaw = vi.fn();
    const prisma = { $executeRaw } as unknown as PrismaClientOrTx;
    const repo = makePayoutTermsRepo(prisma);

    await expect(repo.seedLinesIfEmpty(TERMS_ID, [])).resolves.toBe(false);
    expect($executeRaw).not.toHaveBeenCalled();
  });
});

describe("makePayoutTermsRepo.provisionDefaultPrimary", () => {
  it("passes payoutSchedule through to the create when provided", async () => {
    const create = vi.fn(async () => buildRow({ payoutSchedule: "ASAP" }));
    const prisma = { payoutTerms: { create } } as unknown as PrismaClientOrTx;
    const repo = makePayoutTermsRepo(prisma);

    await repo.provisionDefaultPrimary({
      payeeId: "00000000-0000-4000-8000-000000000002",
      settlementCurrency: "usd",
      isDefault: true,
      payoutSchedule: "ASAP",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ payoutSchedule: "ASAP" }),
    });
  });

  it("omits payoutSchedule from the create data when not provided (schema default applies)", async () => {
    const create = vi.fn(async (_input: { data: Record<string, unknown> }) =>
      buildRow(),
    );
    const prisma = { payoutTerms: { create } } as unknown as PrismaClientOrTx;
    const repo = makePayoutTermsRepo(prisma);

    await repo.provisionDefaultPrimary({
      payeeId: "00000000-0000-4000-8000-000000000002",
      settlementCurrency: "usd",
      isDefault: true,
    });

    const data = create.mock.calls[0]![0].data;
    expect("payoutSchedule" in data).toBe(false);
  });
});

describe("makePayoutTermsRepo.createDraft", () => {
  it("passes payoutSchedule through to the create when provided", async () => {
    const create = vi.fn(async () =>
      buildRow({ status: "PENDING", payoutSchedule: "ONE_WEEK_AFTER" }),
    );
    const prisma = { payoutTerms: { create } } as unknown as PrismaClientOrTx;
    const repo = makePayoutTermsRepo(prisma);

    await repo.createDraft({
      kind: "PRIMARY",
      settlementCurrency: "usd",
      payoutSchedule: "ONE_WEEK_AFTER",
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ payoutSchedule: "ONE_WEEK_AFTER" }),
    });
  });

  it("omits payoutSchedule from the create data when not provided (schema default applies)", async () => {
    const create = vi.fn(async (_input: { data: Record<string, unknown> }) =>
      buildRow({ status: "PENDING" }),
    );
    const prisma = { payoutTerms: { create } } as unknown as PrismaClientOrTx;
    const repo = makePayoutTermsRepo(prisma);

    await repo.createDraft({ kind: "PRIMARY", settlementCurrency: "usd" });

    const data = create.mock.calls[0]![0].data;
    expect("payoutSchedule" in data).toBe(false);
  });
});
