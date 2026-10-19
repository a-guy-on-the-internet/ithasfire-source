import { describe, expect, it } from "vitest";

import { derivePayoutGate } from "../payout-gate";
import { ownerInputOf } from "@/app/admin/[slug]/payouts/_components/stripe-account-owner";

const REFUSED_AT = 1_000;

describe("derivePayoutGate", () => {
  it("shows nothing while the status read is loading", () => {
    expect(
      derivePayoutGate({
        hasResellable: true,
        status: undefined,
        statusUpdatedAt: 0,
        refusedAt: null,
      }),
    ).toEqual({ showSetupCard: false, showReadyNow: false });
  });

  it("shows the card when the seller's payouts are off", () => {
    expect(
      derivePayoutGate({
        hasResellable: true,
        status: { payoutsEnabled: false },
        statusUpdatedAt: 500,
        refusedAt: null,
      }),
    ).toEqual({ showSetupCard: true, showReadyNow: false });
  });

  it("skips the advisory card when there is nothing to resell", () => {
    expect(
      derivePayoutGate({
        hasResellable: false,
        status: { payoutsEnabled: false },
        statusUpdatedAt: 500,
        refusedAt: null,
      }).showSetupCard,
    ).toBe(false);
  });

  it("shows nothing when payouts are on and nothing was refused", () => {
    expect(
      derivePayoutGate({
        hasResellable: true,
        status: { payoutsEnabled: true },
        statusUpdatedAt: 500,
        refusedAt: null,
      }),
    ).toEqual({ showSetupCard: false, showReadyNow: false });
  });

  it("keeps the card after a refusal even if an OLDER read said payouts were on", () => {
    expect(
      derivePayoutGate({
        hasResellable: true,
        status: { payoutsEnabled: true },
        statusUpdatedAt: REFUSED_AT - 1,
        refusedAt: REFUSED_AT,
      }),
    ).toEqual({ showSetupCard: true, showReadyNow: false });
  });

  it("keeps the card after a refusal when the read made at the same instant is not newer", () => {
    expect(
      derivePayoutGate({
        hasResellable: true,
        status: { payoutsEnabled: true },
        statusUpdatedAt: REFUSED_AT,
        refusedAt: REFUSED_AT,
      }).showSetupCard,
    ).toBe(true);
  });

  it("keeps the card when the refetch after a refusal fails (data and timestamp stay old)", () => {
    // React Query keeps the last data + dataUpdatedAt on a failed refetch.
    expect(
      derivePayoutGate({
        hasResellable: true,
        status: { payoutsEnabled: true },
        statusUpdatedAt: REFUSED_AT - 200,
        refusedAt: REFUSED_AT,
      }),
    ).toEqual({ showSetupCard: true, showReadyNow: false });
  });

  it("keeps the card after a refusal when the status never loaded", () => {
    expect(
      derivePayoutGate({
        hasResellable: true,
        status: undefined,
        statusUpdatedAt: 0,
        refusedAt: REFUSED_AT,
      }).showSetupCard,
    ).toBe(true);
  });

  it("keeps the card when a newer read still says payouts are off", () => {
    expect(
      derivePayoutGate({
        hasResellable: true,
        status: { payoutsEnabled: false },
        statusUpdatedAt: REFUSED_AT + 1,
        refusedAt: REFUSED_AT,
      }),
    ).toEqual({ showSetupCard: true, showReadyNow: false });
  });

  it("swaps the card for the ready-now line once a NEWER read says payouts are on", () => {
    expect(
      derivePayoutGate({
        hasResellable: true,
        status: { payoutsEnabled: true },
        statusUpdatedAt: REFUSED_AT + 1,
        refusedAt: REFUSED_AT,
      }),
    ).toEqual({ showSetupCard: false, showReadyNow: true });
  });
});

describe("ownerInputOf", () => {
  it("sends {} for the signed-in human so the router fills the id from the session", () => {
    expect(ownerInputOf({ kind: "human" })).toEqual({});
  });

  it("passes an explicit human id through", () => {
    expect(ownerInputOf({ kind: "human", humanId: "h-1" })).toEqual({
      humanId: "h-1",
    });
  });

  it("passes an org id through", () => {
    expect(ownerInputOf({ kind: "org", orgId: "o-1" })).toEqual({
      orgId: "o-1",
    });
  });
});
