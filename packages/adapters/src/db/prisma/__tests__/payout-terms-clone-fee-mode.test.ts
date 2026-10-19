import { describe, expect, it, vi } from "vitest";

import { makeEventsRepo } from "../events";
import { clonePayoutTermsRow, makePayoutTermsRepo } from "../payout-terms";
import type { PrismaClientOrTx } from "../types";

/**
 * No new event can be put into ABSORB (docs/decisions/fee-mode-switch-dropped.md).
 * Snapshots of an org/place/human default reset `feeMode` to null so they
 * inherit the policy default (PASS_THROUGH); copy-on-write of an event's own
 * legacy row keeps ABSORB so that event keeps its math.
 */

const SOURCE_ID = "00000000-0000-4000-8000-0000000000a1";
const ORG_ID = "00000000-0000-4000-8000-0000000000b1";

const absorbSource = () => ({
  id: SOURCE_ID,
  kind: "PRIMARY",
  status: "ACTIVE",
  isDefault: true,
  version: 3,
  settlementCurrency: "usd",
  feeMode: "ABSORB",
  feePolicyId: null,
  payoutSchedule: "WEEK_OF_EVENT",
  resaleProcessingFeeConfigRef: null,
  resalePayoutReleaseDays: 7,
  effectiveFrom: null,
  effectiveTo: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  lines: [],
  // ── P4b (deal terms) ── the clone now copies the whole deal.
  remainderPayeeId: null,
  deductions: [],
});

function prismaWithAbsorbSource() {
  const created: Array<Record<string, unknown>> = [];
  const payoutTerms = {
    findUnique: vi.fn(async () => absorbSource()),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created.push(data);
      return { ...absorbSource(), ...data, id: `clone-${created.length}` };
    }),
  };
  return { payoutTerms, created };
}

describe("clonePayoutTermsRow — fee mode", () => {
  it("a snapshot (resetFeeMode: true) of an ABSORB default comes out null", async () => {
    const { payoutTerms, created } = prismaWithAbsorbSource();
    const p = { payoutTerms } as unknown as PrismaClientOrTx;

    await clonePayoutTermsRow(p, {
      sourcePayoutTermsId: SOURCE_ID,
      isDefault: false,
      resetFeeMode: true,
    });

    expect(created[0]!.feeMode).toBeNull();
  });

  it("copy-on-write of a legacy event's own row (resetFeeMode: false) keeps ABSORB", async () => {
    const { payoutTerms, created } = prismaWithAbsorbSource();
    const repo = makePayoutTermsRepo({
      payoutTerms,
    } as unknown as PrismaClientOrTx);

    const clone = await repo.clone({
      sourcePayoutTermsId: SOURCE_ID,
      isDefault: false,
      bumpVersion: true,
      resetFeeMode: false,
    });

    expect(created[0]!.feeMode).toBe("ABSORB");
    expect(clone?.feeMode).toBe("ABSORB");
  });
});

describe("clonePayoutTermsRow — inherited fee-policy pin", () => {
  it("a snapshot drops a pin to an ABSORB policy (a null mode would inherit it)", async () => {
    const { payoutTerms, created } = prismaWithAbsorbSource();
    payoutTerms.findUnique.mockImplementation(async () => ({
      ...absorbSource(),
      feeMode: null,
      feePolicyId: "absorb-policy",
      feePolicy: { feeMode: "ABSORB" },
    }) as never);

    await clonePayoutTermsRow({ payoutTerms } as unknown as PrismaClientOrTx, {
      sourcePayoutTermsId: SOURCE_ID,
      isDefault: false,
      resetFeeMode: true,
    });

    expect(created[0]!.feeMode).toBeNull();
    expect(created[0]!.feePolicyId).toBeNull();
  });

  it("a snapshot keeps a pin to a PASS_THROUGH policy", async () => {
    const { payoutTerms, created } = prismaWithAbsorbSource();
    payoutTerms.findUnique.mockImplementation(async () => ({
      ...absorbSource(),
      feePolicyId: "pt-policy",
      feePolicy: { feeMode: "PASS_THROUGH" },
    }) as never);

    await clonePayoutTermsRow({ payoutTerms } as unknown as PrismaClientOrTx, {
      sourcePayoutTermsId: SOURCE_ID,
      isDefault: false,
      resetFeeMode: true,
    });

    expect(created[0]!.feePolicyId).toBe("pt-policy");
  });

  it("copy-on-write (resetFeeMode: false) keeps an ABSORB pin", async () => {
    const { payoutTerms, created } = prismaWithAbsorbSource();
    payoutTerms.findUnique.mockImplementation(async () => ({
      ...absorbSource(),
      feePolicyId: "absorb-policy",
      feePolicy: { feeMode: "ABSORB" },
    }) as never);

    await clonePayoutTermsRow({ payoutTerms } as unknown as PrismaClientOrTx, {
      sourcePayoutTermsId: SOURCE_ID,
      isDefault: false,
      resetFeeMode: false,
    });

    expect(created[0]!.feePolicyId).toBe("absorb-policy");
  });
});

describe("events adapter create — snapshot of an ABSORB org default", () => {
  it("the new event's PRIMARY terms come out null (inherit PASS_THROUGH)", async () => {
    const { payoutTerms, created } = prismaWithAbsorbSource();
    const STOP = new Error("stop after the snapshot");
    const eventCreate = vi.fn(async () => {
      throw STOP;
    });
    const p = {
      payoutTerms,
      organization: {
        findUnique: vi.fn(async () => ({
          defaultPrimaryPayoutTermsId: SOURCE_ID,
          defaultResalePayoutTermsId: null,
        })),
      },
      event: { create: eventCreate },
    } as unknown as PrismaClientOrTx;

    await expect(
      makeEventsRepo(p).upsertDraft({
        orgId: ORG_ID,
        humanId: null,
        title: "New show",
        startsAt: new Date("2026-11-01T20:00:00Z"),
        status: "DRAFT",
        location: { kind: "none" },
      } as never),
    ).rejects.toBe(STOP);

    // The default was snapshotted…
    expect(payoutTerms.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SOURCE_ID } }),
    );
    // …without its ABSORB mode, and the event points at the clone.
    expect(created).toHaveLength(1);
    expect(created[0]!.feeMode).toBeNull();
    const eventData = (eventCreate.mock.calls[0] as unknown as [
      { data: { payoutTermsId: string } },
    ])[0].data;
    expect(eventData.payoutTermsId).toBe("clone-1");
  });
});
