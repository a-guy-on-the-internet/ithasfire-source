import { describe, expect, it, vi } from "vitest";

import type {
  UserCreditRecord,
  UserCreditRedemptionRecord,
} from "@th/types";

import {
  listCreditsForHuman,
  type ListCreditsForHumanDeps,
} from "../list-credits-for-human";

const HUMAN = "22222222-2222-4222-8222-222222222222";
const NOW = Date.now();

function makeCredit(overrides: Partial<UserCreditRecord> = {}): UserCreditRecord {
  return {
    id: "credit-1",
    humanId: HUMAN,
    amountCents: 500,
    currency: "usd",
    balanceCents: 500,
    reason: "Goodwill",
    sourceType: "REFUND_GOODWILL",
    grantedByHumanId: null,
    sourceRef: null,
    status: "ACTIVE",
    expiresAt: undefined,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

function makeDeps(credits: UserCreditRecord[], redemptions: UserCreditRedemptionRecord[] = []) {
  return {
    repos: {
      credits: {
        listAllForHuman: vi.fn(async () => credits),
        listRedemptionsForHuman: vi.fn(async () => redemptions),
      },
    },
  } as unknown as ListCreditsForHumanDeps;
}

describe("listCreditsForHuman", () => {
  it("sums only active, unexpired, positive-balance credits per currency", async () => {
    const deps = makeDeps([
      makeCredit({ id: "a", balanceCents: 500, currency: "usd" }),
      makeCredit({ id: "b", balanceCents: 300, currency: "usd" }),
      makeCredit({ id: "c", balanceCents: 1000, currency: "eur" }),
      // Excluded: redeemed
      makeCredit({ id: "d", balanceCents: 0, status: "REDEEMED" }),
      // Excluded: expired
      makeCredit({
        id: "e",
        balanceCents: 200,
        expiresAt: new Date(NOW - 1000),
      }),
      // Excluded: revoked
      makeCredit({ id: "f", balanceCents: 400, status: "REVOKED" }),
    ]);

    const result = await listCreditsForHuman(deps, { humanId: HUMAN });

    expect(result.activeBalanceByCurrency).toEqual({ usd: 800, eur: 1000 });
    expect(result.credits).toHaveLength(6);
  });

  it("returns an empty balance map when there are no spendable credits", async () => {
    const deps = makeDeps([
      makeCredit({ id: "x", balanceCents: 0, status: "REDEEMED" }),
    ]);

    const result = await listCreditsForHuman(deps, { humanId: HUMAN });

    expect(result.activeBalanceByCurrency).toEqual({});
  });

  it("returns redemption history", async () => {
    const redemption: UserCreditRedemptionRecord = {
      id: "r-1",
      creditId: "a",
      orderId: "o-1",
      amountCents: 250,
      redeemedAt: new Date(NOW),
      refundedAt: undefined,
    };
    const deps = makeDeps([makeCredit()], [redemption]);

    const result = await listCreditsForHuman(deps, { humanId: HUMAN });

    expect(result.redemptions).toEqual([redemption]);
  });
});
