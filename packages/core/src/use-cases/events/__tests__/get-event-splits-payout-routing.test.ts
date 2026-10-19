import { describe, expect, it, vi } from "vitest";

import { getEventSplits, type GetEventSplitsDeps } from "../get-event-splits";

// PAYOUT ROUTING: owner-only (owner ruling 2026-09-28). `canEditEvent` admits a
// human owner's edit-role delegates — reading the splits editor must not.

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const DELEGATE_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "55555555-5555-4555-8555-555555555555";

function deps(event: { orgId: string | null; humanId: string | null }) {
  const listLines = vi.fn(async () => []);
  return {
    listLines,
    deps: {
      repos: {
        events: {
          getById: vi.fn(async () => ({
            id: EVENT_ID,
            payoutTermsId: null,
            resalePayoutTermsId: null,
            ...event,
          })),
        },
        payoutTerms: {
          getById: vi.fn(async () => null),
          listLines,
          listByEvent: vi.fn(async () => []),
        },
        payees: { getByIds: vi.fn(async () => []) },
        eventHumans: { listByEvent: vi.fn(async () => []) },
        humans: { getByIds: vi.fn(async () => []) },
        organizations: { getByIds: vi.fn(async () => []) },
        feePolicies: { resolveEffective: vi.fn(async () => null) },
      },
      // The delegate passes the generic editor bar…
      authz: { canEditEvent: vi.fn(async () => ({ allowed: true })) },
      clock: { now: () => new Date("2026-09-28T12:00:00Z") },
    } as unknown as GetEventSplitsDeps,
  };
}

describe("getEventSplits — payout routing", () => {
  it("refuses an edit-role delegate of the human owner with INSUFFICIENT_ROLE", async () => {
    const { deps: d, listLines } = deps({ orgId: null, humanId: PRINCIPAL_ID });

    await expect(
      getEventSplits(d, {
        actorHumanId: DELEGATE_ID,
        eventId: EVENT_ID,
        kind: "PRIMARY",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    // …but never reaches a terms read.
    expect(listLines).not.toHaveBeenCalled();
  });

  it("does not refuse the owner at the payout-routing bar", async () => {
    const { deps: d } = deps({ orgId: null, humanId: PRINCIPAL_ID });

    await expect(
      getEventSplits(d, {
        actorHumanId: PRINCIPAL_ID,
        eventId: EVENT_ID,
        kind: "PRIMARY",
      }),
    ).resolves.toBeDefined();
  });

  it("leaves an org event to canEditEvent (org arm unchanged)", async () => {
    const { deps: d } = deps({ orgId: ORG_ID, humanId: null });

    await expect(
      getEventSplits(d, {
        actorHumanId: DELEGATE_ID,
        eventId: EVENT_ID,
        kind: "PRIMARY",
      }),
    ).resolves.toBeDefined();
  });
});
