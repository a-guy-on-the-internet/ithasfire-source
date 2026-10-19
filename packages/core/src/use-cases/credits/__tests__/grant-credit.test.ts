import { describe, expect, it, vi } from "vitest";

import type { UserCreditRecord } from "@th/types";

import { grantCredit, type GrantCreditDeps } from "../grant-credit";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2025-06-01T00:00:00.000Z");

function makeCredit(overrides: Partial<UserCreditRecord> = {}): UserCreditRecord {
  return {
    id: "credit-1",
    humanId: RECIPIENT,
    amountCents: 500,
    currency: "usd",
    balanceCents: 500,
    reason: "Goodwill",
    sourceType: "REFUND_GOODWILL",
    grantedByHumanId: ACTOR,
    sourceRef: null,
    status: "ACTIVE",
    expiresAt: undefined,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDeps(options: { allowed?: boolean } = {}) {
  const allowed = options.allowed ?? true;

  const grant = vi.fn(async () => makeCredit());
  const findBySource = vi.fn(async () => null as UserCreditRecord | null);
  const auditLog = vi.fn(async () => undefined);

  const credits = {
    grant,
    findBySource,
    listActiveForHuman: vi.fn(),
    listAllForHuman: vi.fn(),
    listRedemptionsForHuman: vi.fn(),
    redeemConditional: vi.fn(),
    recordRedemption: vi.fn(),
  };

  const tx = {
    credits,
    audit: { log: auditLog },
  };

  const deps = {
    repos: {
      tx: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    },
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    },
    clock: { now: () => NOW },
  } as unknown as GrantCreditDeps;

  return { deps, grant, findBySource, auditLog };
}

const baseInput = {
  actorHumanId: ACTOR,
  humanId: RECIPIENT,
  amountCents: 500,
  reason: "Goodwill",
  sourceType: "REFUND_GOODWILL" as const,
};

describe("grantCredit", () => {
  it("grants a credit and writes an audit log inside the transaction", async () => {
    const { deps, grant, auditLog } = makeDeps();

    const result = await grantCredit(deps, baseInput);

    expect(result.credit.id).toBe("credit-1");
    expect(grant).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: RECIPIENT,
        amountCents: 500,
        currency: "usd",
        grantedByHumanId: ACTOR,
        sourceType: "REFUND_GOODWILL",
      }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "user_credit",
        action: "user_credit.granted",
      }),
    );
  });

  it("rejects non-staff actors", async () => {
    const { deps, grant } = makeDeps({ allowed: false });

    await expect(grantCredit(deps, baseInput)).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(grant).not.toHaveBeenCalled();
  });

  it("rejects an expiry in the past", async () => {
    const { deps, grant } = makeDeps();

    await expect(
      grantCredit(deps, {
        ...baseInput,
        expiresAt: new Date("2025-05-31T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "EXPIRES_AT_IN_PAST" });
    expect(grant).not.toHaveBeenCalled();
  });

  it("is idempotent on (humanId, sourceType, sourceRef)", async () => {
    const { deps, grant, findBySource } = makeDeps();
    const existing = makeCredit({ id: "credit-existing" });
    findBySource.mockResolvedValueOnce(existing);

    const result = await grantCredit(deps, {
      ...baseInput,
      sourceType: "REFERRAL",
      sourceRef: "referral-pair-abc",
    });

    expect(result.credit.id).toBe("credit-existing");
    expect(findBySource).toHaveBeenCalledWith({
      humanId: RECIPIENT,
      sourceType: "REFERRAL",
      sourceRef: "referral-pair-abc",
    });
    expect(grant).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount", async () => {
    const { deps } = makeDeps();

    await expect(
      grantCredit(deps, { ...baseInput, amountCents: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("returns the existing credit when a concurrent grant wins the unique race (P2002)", async () => {
    // FIX 3: the velocity guard's pre-check sees nothing, but a concurrent
    // grant inserts first and our insert violates the partial unique index
    // on (humanId, sourceType, sourceRef). grantCredit must swallow the
    // P2002, re-read in a fresh transaction, and return the raced row.
    const { deps, grant, findBySource } = makeDeps();
    const existing = makeCredit({ id: "credit-raced" });
    findBySource
      .mockResolvedValueOnce(null) // pre-check inside the failing tx
      .mockResolvedValueOnce(existing); // re-read after the P2002
    grant.mockRejectedValueOnce({ code: "P2002" });

    const result = await grantCredit(deps, {
      ...baseInput,
      sourceType: "REFERRAL",
      sourceRef: "referral-pair-xyz",
    });

    expect(result.credit.id).toBe("credit-raced");
    expect(grant).toHaveBeenCalledTimes(1);
    expect(findBySource).toHaveBeenCalledTimes(2);
  });
});
