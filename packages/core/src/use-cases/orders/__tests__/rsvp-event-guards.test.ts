import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { createCheckout } from "../create-checkout";
import type { CreateCheckoutDeps, CreateCheckoutInput } from "../create-checkout";
import { claimFreeTickets } from "../claim-free-tickets";
import { updateOrderItems } from "../update-order-items";

// FR-003 / FR-012 (community-managed-event-listings): RSVP events have no
// ticket types, orders, or money paths. Every checkout-shaped use case must
// reject them with EVENT_NOT_TICKETED, and must NOT block TICKETED events.

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";

const NOW = new Date("2026-07-01T12:00:00.000Z");

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    orgId: null,
    humanId: ACTOR_ID,
    status: "PUBLISHED",
    timezone: "America/Chicago",
    startsAt: new Date("2026-08-01T19:00:00.000Z"),
    endsAt: new Date("2026-08-01T22:00:00.000Z"),
    publishedAt: new Date("2026-06-01T00:00:00.000Z"),
    gateType: "NONE",
    currency: "usd",
    ...overrides,
  });
}

function makeRepos(event: EventRecord): Repos {
  const txRepos = {
    events: {
      getById: vi.fn(async (id: string) => (id === event.id ? event : null)),
      // Empty ticket types: TICKETED events fall through the RSVP guard and
      // fail later with NO_TICKET_TYPES — proving the guard did not fire.
      listTicketTypes: vi.fn(async () => []),
    },
    orders: {
      getById: vi.fn(async () => null),
    },
    // TICKETED update-order-items path reaches loadAgreementContext next; an
    // empty terms list yields PRIMARY_AGREEMENT_MISSING (≠ EVENT_NOT_TICKETED).
    payoutTerms: {
      listByEvent: vi.fn(async () => []),
    },
  } as unknown as TxRepos;

  return {
    // The pre-transaction tax read (`prepareCheckoutTax`) sees the same rows.
    events: (txRepos as unknown as Repos).events,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;
}

function makeCheckoutInput(): CreateCheckoutInput {
  return {
    actorHumanId: ACTOR_ID,
    buyerHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    clientKey: "client-key-12345",
    items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
    termsAccepted: true,
    refundPolicyAccepted: true,
    allowRedirectPaymentMethods: true,
    allowBankDebit: true,
    applyPlatformCredit: true,
  };
}

describe("createCheckout RSVP guard", () => {
  it("rejects checkout against an RSVP event with EVENT_NOT_TICKETED", async () => {
    const deps: CreateCheckoutDeps = {
      repos: makeRepos(makeEvent({ attendanceMode: "RSVP" })),
      payments: {} as CreateCheckoutDeps["payments"],
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => NOW },
    };

    await expect(createCheckout(deps, makeCheckoutInput())).rejects.toMatchObject(
      { code: "EVENT_NOT_TICKETED" },
    );
  });

  it("does not block a TICKETED event (fails later on NO_TICKET_TYPES)", async () => {
    const deps: CreateCheckoutDeps = {
      repos: makeRepos(makeEvent({ attendanceMode: "TICKETED" })),
      payments: {} as CreateCheckoutDeps["payments"],
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => NOW },
    };

    await expect(createCheckout(deps, makeCheckoutInput())).rejects.toMatchObject(
      { code: "NO_TICKET_TYPES" },
    );
  });
});

describe("claimFreeTickets RSVP guard", () => {
  it("rejects a free claim against an RSVP event with EVENT_NOT_TICKETED", async () => {
    const deps = {
      repos: makeRepos(makeEvent({ attendanceMode: "RSVP" })),
      clock: { now: () => NOW },
    };

    await expect(
      claimFreeTickets(deps, makeCheckoutInput(), [], undefined),
    ).rejects.toMatchObject({ code: "EVENT_NOT_TICKETED" });
  });

  it("does not block a TICKETED event (fails later on PRIMARY_AGREEMENT_MISSING)", async () => {
    // claim-free-tickets loads the agreement context BEFORE ticket types, so
    // with empty payout terms the first post-guard failure is the agreement.
    const deps = {
      repos: makeRepos(makeEvent({ attendanceMode: "TICKETED" })),
      clock: { now: () => NOW },
    };

    await expect(
      claimFreeTickets(deps, makeCheckoutInput(), [], undefined),
    ).rejects.toMatchObject({ code: "PRIMARY_AGREEMENT_MISSING" });
  });
});

describe("updateOrderItems RSVP guard", () => {
  const input = {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
  };

  it("rejects a cart hold against an RSVP event with EVENT_NOT_TICKETED", async () => {
    const deps = {
      repos: makeRepos(makeEvent({ attendanceMode: "RSVP" })),
      clock: { now: () => NOW },
    };

    await expect(updateOrderItems(deps, input)).rejects.toMatchObject({
      code: "EVENT_NOT_TICKETED",
    });
  });

  it("does not block a TICKETED event (fails later on PRIMARY_AGREEMENT_MISSING)", async () => {
    const deps = {
      repos: makeRepos(makeEvent({ attendanceMode: "TICKETED" })),
      clock: { now: () => NOW },
    };

    await expect(updateOrderItems(deps, input)).rejects.toMatchObject({
      code: "PRIMARY_AGREEMENT_MISSING",
    });
  });
});
