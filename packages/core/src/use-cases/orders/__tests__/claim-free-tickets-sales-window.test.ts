/**
 * FR-014 on the FREE-claim path.
 *
 * `claimFreeTickets` is the fifth money site even though no money moves: it
 * MINTS TICKETS. A free tier with a sales window that has not opened — the
 * classic "RSVP list opens Monday at noon" shape — must be refused here as
 * firmly as a paid one, and it is a separately exported use case (createCheckout
 * delegates to it, but so can anything else), so the guard has to hold on its
 * own rather than by virtue of the caller.
 *
 * Spec: docs/specs/2026-08-04/completed/ticket-type-packs.spec.yaml FR-014, adopted by
 * docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-009.
 */
import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { claimFreeTickets } from "../claim-free-tickets";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";
const TERMS_ID = "44444444-4444-4444-8444-444444444444";
const FEE_POLICY_ID = "55555555-5555-4555-8555-555555555555";

const OPENS_AT = new Date("2026-07-06T17:00:00.000Z");
const CLOSES_AT = new Date("2026-07-20T17:00:00.000Z");

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
 * A FREE ticket type carrying a window, plus just enough repo surface to reach
 * `orders.createPending` — which is a SENTINEL that throws
 * REACHED_CREATE_PENDING rather than a stub that succeeds.
 *
 * That shape is deliberate. "The window let this through" is asserted
 * POSITIVELY, by observing the flow arrive at the first write, instead of
 * negatively ("it didn't throw the window code"), which would also pass if the
 * call died for an unrelated reason two lines earlier. It also means a refusal
 * test proves the write was never attempted rather than merely not observed.
 */
function makeHarness(window: {
  salesOpenAt: Date | null;
  salesCloseAt: Date | null;
}) {
  // A SENTINEL, not a stub. Reaching `createPending` is the positive proof
  // that the window gate let the claim through; a refused claim must never get
  // here. The harness stops at this line rather than mocking the whole mint —
  // the assertion is about the gate, not about ticket issuance.
  const createPending = vi.fn(async () => {
    throw Object.assign(new Error("reached create pending"), {
      code: "REACHED_CREATE_PENDING",
    });
  });
  const mintCalled = vi.fn();

  const txRepos = {
    events: {
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? makeEvent() : null)),
      listTicketTypes: vi.fn(async () => [
        {
          id: TICKET_TYPE_ID,
          name: "Free RSVP",
          description: null,
          priceCents: 0,
          pricingMode: "FIXED" as const,
          minimumCents: null,
          suggestedCents: null,
          capacity: 100,
          status: "ACTIVE" as const,
          seatSectionId: null,
          resaleAllowed: false,
          resaleCapCents: null,
          transferAllowed: true,
          scheduledPriceCents: null,
          scheduledPriceAt: null,
          ...window,
        },
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
      // Capacity is 100 above and nothing is issued or held, so the
      // pre-charge gate is a no-op here — this file is about the sales
      // window, and the `createPending` sentinel must stay the first thing a
      // permitted claim reaches.
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

const input = {
  actorHumanId: ACTOR_ID,
  buyerHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  clientKey: "client-key-12345",
  items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 2 }],
  termsAccepted: true,
  refundPolicyAccepted: true,
  allowRedirectPaymentMethods: true,
  allowBankDebit: true,
  applyPlatformCredit: true,
};

const claimAt = (now: Date, window: Parameters<typeof makeHarness>[0]) => {
  const harness = makeHarness(window);
  return {
    harness,
    run: () =>
      claimFreeTickets(
        { repos: harness.repos, clock: { now: () => now } },
        input,
        [],
        undefined,
      ),
  };
};

describe("claimFreeTickets — sales window (FR-014)", () => {
  it("refuses a claim BEFORE the window opens, minting nothing", async () => {
    const { harness, run } = claimAt(new Date(OPENS_AT.getTime() - 1), {
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });

    await expect(run()).rejects.toMatchObject({
      code: "TICKET_TYPE_NOT_YET_ON_SALE",
    });
    expect(harness.createPending).not.toHaveBeenCalled();
    expect(harness.mintCalled).not.toHaveBeenCalled();
  });

  it("refuses a claim AT the close instant (EXCLUSIVE), minting nothing", async () => {
    const { harness, run } = claimAt(new Date(CLOSES_AT.getTime()), {
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });

    await expect(run()).rejects.toMatchObject({
      code: "TICKET_TYPE_SALES_ENDED",
    });
    expect(harness.createPending).not.toHaveBeenCalled();
    expect(harness.mintCalled).not.toHaveBeenCalled();
  });

  it("does NOT refuse at the open instant — it gets past the window gate", async () => {
    // The harness deliberately stops short of a full mint, so the proof that the
    // window let the claim through is that the failure is something ELSE
    // entirely. If the guard had fired, this would be TICKET_TYPE_NOT_YET_ON_SALE.
    const { run } = claimAt(new Date(OPENS_AT.getTime()), {
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });

    await expect(run()).rejects.toMatchObject({
      code: "REACHED_CREATE_PENDING",
    });
  });

  it("NFR-001: an unwindowed free tier is not refused at any of those instants", async () => {
    for (const now of [
      new Date(OPENS_AT.getTime() - 1),
      new Date(CLOSES_AT.getTime()),
    ]) {
      const { run } = claimAt(now, { salesOpenAt: null, salesCloseAt: null });
      await expect(run()).rejects.toMatchObject({
        code: "REACHED_CREATE_PENDING",
      });
    }
  });
});
