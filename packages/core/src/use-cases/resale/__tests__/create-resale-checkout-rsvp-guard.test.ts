import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { createResaleCheckout } from "../create-resale-checkout";
import type { CreateResaleCheckoutDeps } from "../create-resale-checkout";

// FR-003 / FR-012 (community-managed-event-listings): RSVP events have no
// tickets, so no resale. Unreachable in practice (no ticket → no listing),
// but the money-path boundary guard must hold.

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const BUYER_ID = "22222222-2222-4222-8222-222222222222";
const SELLER_ID = "33333333-3333-4333-8333-333333333333";
const LISTING_ID = "44444444-4444-4444-8444-444444444444";

const NOW = new Date("2026-07-01T12:00:00.000Z");

function makeListing() {
  return {
    id: LISTING_ID,
    eventId: EVENT_ID,
    sellerHumanId: SELLER_ID,
    ticketId: "ticket-1",
    status: "ACTIVE",
    askPriceCents: 5000,
    faceValueCents: null,
    processingPassThroughCents: 0,
    processingFeeConfigRef: null,
    saleCutoffAt: null,
    payoutReleaseAt: null,
    resalePayoutTermsId: null,
  };
}

function makeDeps(event: EventRecord): CreateResaleCheckoutDeps {
  const txRepos = {
    resaleListings: {
      getById: vi.fn(async () => makeListing()),
    },
    events: {
      getById: vi.fn(async (id: string) => (id === event.id ? event : null)),
    },
    // A listed pass: checkout refuses a listing whose ticket is not LISTED.
    tickets: {
      getById: vi.fn(async () => ({
        id: "ticket-1",
        status: "LISTED",
        ticketTypeId: null,
        seatId: null,
        orderId: null,
        orderItemId: null,
      })),
    },
  } as unknown as TxRepos;

  return {
    repos: {
      // The pre-transaction tax read (`prepareCheckoutTax`) sees the same rows.
      resaleListings: (txRepos as unknown as Repos).resaleListings,
      events: (txRepos as unknown as Repos).events,
      tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
    } as unknown as Repos,
    payments: {} as CreateResaleCheckoutDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => NOW },
  };
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    status: "PUBLISHED",
    timezone: "America/Chicago",
    currency: "usd",
    resalePayoutTermsId: null,
    ...overrides,
  });
}

function makeInput() {
  return {
    actorHumanId: BUYER_ID,
    buyerHumanId: BUYER_ID,
    listingId: LISTING_ID,
    clientKey: "client-key-12345",
    termsAccepted: true,
    refundPolicyAccepted: true,
  };
}

describe("createResaleCheckout RSVP guard", () => {
  it("rejects a resale checkout against an RSVP event with EVENT_NOT_TICKETED", async () => {
    const deps = makeDeps(makeEvent({ attendanceMode: "RSVP" }));

    await expect(createResaleCheckout(deps, makeInput())).rejects.toMatchObject(
      { code: "EVENT_NOT_TICKETED" },
    );
  });

  it("does not block a TICKETED event (fails later, pricing the unpriced listing)", async () => {
    const deps = makeDeps(makeEvent({ attendanceMode: "TICKETED" }));

    await expect(createResaleCheckout(deps, makeInput())).rejects.toMatchObject(
      { code: "RESALE_TERMS_MISSING" },
    );
  });
});
