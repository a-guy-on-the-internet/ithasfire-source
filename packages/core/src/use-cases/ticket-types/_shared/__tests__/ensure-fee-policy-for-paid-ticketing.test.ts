import { describe, expect, it, vi } from "vitest";

import { ensureFeePolicyResolvableForPaidTicketing } from "../ensure-fee-policy-for-paid-ticketing";

/**
 * The paid-ticket gate refuses only when NO fee policy resolves. It used to
 * refuse a legacy ABSORB policy on modeless, unpinned terms too; ABSORB is
 * removed (docs/decisions/absorb-removed.md) and pricing never reads a
 * policy's mode (SALE_FEE_MODE), so that arm is gone.
 */

const EVENT = { id: "evt-1", orgId: "org-1" } as never;
const NOW = new Date("2026-09-30T12:00:00Z");

const policy = (feeMode: "ABSORB" | "PASS_THROUGH") => ({
  id: `policy-${feeMode}`,
  scopeType: "ORG",
  scopeId: "org-1",
  feeMode,
});

function makeTx(resolved: ReturnType<typeof policy> | null) {
  const listByEvent = vi.fn(async () => [
    {
      id: "terms-1",
      kind: "PRIMARY",
      status: "ACTIVE",
      feeMode: null,
      feePolicyId: null,
    },
  ]);
  const tx = {
    feePolicies: {
      resolveEffective: vi.fn(async ({ scopeType }: { scopeType: string }) =>
        scopeType === "ORG" ? resolved : null,
      ),
    },
    payoutTerms: { listByEvent },
  } as never;
  return { tx, listByEvent };
}

describe("ensureFeePolicyResolvableForPaidTicketing", () => {
  it.each(["ABSORB", "PASS_THROUGH"] as const)(
    "a resolved %s policy lets the paid tier through, unreported, without reading the terms",
    async (feeMode) => {
      const reportError = vi.fn();
      const { tx, listByEvent } = makeTx(policy(feeMode));

      await expect(
        ensureFeePolicyResolvableForPaidTicketing(tx, EVENT, NOW, {
          source: "upsertTicketType",
          reportError,
        }),
      ).resolves.toBeUndefined();
      expect(reportError).not.toHaveBeenCalled();
      expect(listByEvent).not.toHaveBeenCalled();
    },
  );

  it("no policy at all: PAID_TICKETING_REQUIRES_FEE_POLICY, no reason", async () => {
    const { tx } = makeTx(null);
    const err = await ensureFeePolicyResolvableForPaidTicketing(tx, EVENT, NOW, {
      source: "updateTicketType",
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });
    expect(err.meta?.reason).toBeUndefined();
  });
});
