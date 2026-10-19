/**
 * Money audit 2026-09-08 #14 on the FREE-claim path.
 *
 * `listTicketTypes` returns EVERY status — admin surfaces need the archived
 * ones — so each selling use case narrows to the sellable set itself. The
 * rule is `status === "ACTIVE"`, the same one the public page
 * (`listEventTicketTypes`), the card tiers and the POS listing display. An
 * archived or unpublished tier is not shown, and it must not be claimable by
 * id either. `claimFreeTickets` MINTS TICKETS, and is a separately exported
 * use case, so the guard has to hold here on its own.
 *
 * At the port the non-sellable statuses are ONE value: the adapter folds the
 * DB's INACTIVE and ARCHIVED to "DRAFT" (`TicketTypeStatus = "DRAFT" |
 * "ACTIVE"`), so "DRAFT" is the only non-sellable value a use case can ever
 * see, and the only one worth feeding it.
 */
import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { claimFreeTickets } from "../claim-free-tickets";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const ACTIVE_TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const HIDDEN_TICKET_TYPE_ID = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const TERMS_ID = "44444444-4444-4444-8444-444444444444";
const FEE_POLICY_ID = "55555555-5555-4555-8555-555555555555";

function makeEvent(): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    orgId: null,
    humanId: ACTOR_ID,
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    startsAt: new Date("2026-08-01T19:00:00.000Z"),
    endsAt: new Date("2026-08-01T22:00:00.000Z"),
    gateType: "NONE",
    currency: "usd",
  });
}

/**
 * Two FREE tiers — one ACTIVE, one DRAFT — and just enough
 * repo surface to reach `orders.createPending`, which is a SENTINEL that
 * throws REACHED_CREATE_PENDING rather than a stub that succeeds. Same shape
 * as the sales-window harness: "the gate let this through" is proved
 * POSITIVELY by arriving at the first write, and a refusal proves the write
 * was never attempted.
 */
function makeHarness() {
  const createPending = vi.fn(async () => {
    throw Object.assign(new Error("reached create pending"), {
      code: "REACHED_CREATE_PENDING",
    });
  });
  const mintCalled = vi.fn();

  const tier = (id: string, status: "ACTIVE" | "DRAFT") => ({
    id,
    name: id,
    description: null,
    priceCents: 0,
    pricingMode: "FIXED" as const,
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    status,
    seatSectionId: null,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    salesOpenAt: null,
    salesCloseAt: null,
  });

  const txRepos = {
    events: {
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? makeEvent() : null)),
      listTicketTypes: vi.fn(async () => [
        tier(ACTIVE_TICKET_TYPE_ID, "ACTIVE"),
        tier(HIDDEN_TICKET_TYPE_ID, "DRAFT"),
      ]),
    },
    payoutTerms: {
      listByEvent: vi.fn(async () => [
        {
          id: TERMS_ID,
          kind: "PRIMARY",
          status: "ACTIVE",
          feeMode: "ABSORB",
          feePolicyId: FEE_POLICY_ID,
          payoutSchedule: "WEEK_OF_EVENT",
          isDefault: false,
          settlementCurrency: "usd",
          version: 1,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
      listLines: vi.fn(async () => [
        {
          id: "line-1",
          payoutTermsId: TERMS_ID,
          payeeId: "66666666-6666-4666-8666-666666666666",
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR" as const,
        },
      ]),
    },
    feePolicies: {
      getById: vi.fn(async () => ({
        id: FEE_POLICY_ID,
        scopeType: "EVENT",
        scopeId: EVENT_ID,
        status: "ACTIVE",
        version: 1,
        buyerFeePct: 0,
        maxFeeCents: null,
        minFeeCents: 0,
        platformFixedCents: 0,
        feeMode: "ABSORB",
        processsorFeePct: 0.029,
        processorFixedCents: 30,
        payoutPct: 0.9,
        payoutFixedCents: 0,
        monthlyPayoutCents: 0,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
      })),
    },
    eventUnlocks: { isUnlocked: vi.fn(async () => true) },
    memberships: {
      listForMember: vi.fn(async () => []),
      listActiveForHuman: vi.fn(async () => []),
      listActiveBenefitsForHuman: vi.fn(async () => []),
    },
    promos: {
      findActiveByCodes: vi.fn(async () => []),
      findByCodeNormalized: vi.fn(async () => null),
      createHolds: vi.fn(async () => []),
    },
    seats: {
      releaseExpiredHolds: vi.fn(async () => 0),
      releaseSeats: vi.fn(async () => 0),
      findByIdsForUpdate: vi.fn(async () => []),
    },
    orders: { createPending, getById: vi.fn(async () => null) },
    tickets: {
      createMany: mintCalled,
      lockAndCountCapacityForTicketType: vi.fn(async () => ({
        issued: 0,
        held: 0,
      })),
    },
  } as unknown as TxRepos;

  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  return { repos, createPending, mintCalled, txRepos };
}

const baseInput = {
  actorHumanId: ACTOR_ID,
  buyerHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  clientKey: "client-key-12345",
  termsAccepted: true,
  refundPolicyAccepted: true,
  allowRedirectPaymentMethods: true,
  allowBankDebit: true,
  applyPlatformCredit: true,
};

const claim = (items: Array<{ ticketTypeId: string; qty: number }>) => {
  const harness = makeHarness();
  return {
    harness,
    run: () =>
      claimFreeTickets(
        {
          repos: harness.repos,
          clock: { now: () => new Date("2026-07-10T17:00:00.000Z") },
        },
        { ...baseInput, items },
        [],
        undefined,
      ),
  };
};

describe("claimFreeTickets — only ACTIVE ticket types are claimable (money audit 2026-09-08 #14)", () => {
  {
    it("refuses an archived or unpublished (DRAFT) tier named by id, minting nothing", async () => {
      const { harness, run } = claim([
        { ticketTypeId: HIDDEN_TICKET_TYPE_ID, qty: 1 },
      ]);

      await expect(run()).rejects.toMatchObject({
        code: "not_found",
        message: "ticket_type_not_found",
      });
      expect(harness.createPending).not.toHaveBeenCalled();
      expect(harness.mintCalled).not.toHaveBeenCalled();
    });
  }

  it("a cart mixing an ACTIVE and a DRAFT tier is refused whole", async () => {
    const { harness, run } = claim([
      { ticketTypeId: ACTIVE_TICKET_TYPE_ID, qty: 1 },
      { ticketTypeId: HIDDEN_TICKET_TYPE_ID, qty: 1 },
    ]);

    await expect(run()).rejects.toMatchObject({
      code: "not_found",
      message: "ticket_type_not_found",
    });
    expect(harness.createPending).not.toHaveBeenCalled();
  });

  it("the ACTIVE tier listed alongside a DRAFT one still gets past the gate", async () => {
    // The harness stops at the first write, so the proof that the sellable
    // gate let the claim through is reaching the createPending sentinel.
    const { run } = claim([
      { ticketTypeId: ACTIVE_TICKET_TYPE_ID, qty: 2 },
    ]);

    await expect(run()).rejects.toMatchObject({
      code: "REACHED_CREATE_PENDING",
    });
  });
});
