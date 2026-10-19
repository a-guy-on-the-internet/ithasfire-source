import { describe, it, expect, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";
import { formatOrderCode } from "@th/types/order-identifier";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  sendResalePurchaseEmail,
  type SendResalePurchaseEmailDeps,
} from "../send-resale-purchase-email";

// ── Helpers ──────────────────────────────────────────────────────────────────

const BUYER_ID = "buyer-uuid";
const EVENT_ID = "event-uuid";
// A REAL uuid with a distinct head and tail: the displayed code is the 8-hex
// TAIL, so a placeholder like "order-uuid" (or a repdigit uuid) would pass
// whichever end `formatOrderCode` took and pin nothing.
const ORDER_ID = "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3";
/** The ONE displayed order code — `formatOrderCode(ORDER_ID)`. */
const ORDER_CODE = "DB21B2C3";
const PUBLIC_APP_URL = "https://ithasfire.com";
const SUPPORT_URL = "https://support.ithasfire.com";
const NOW = new Date("2026-03-10T12:00:00Z");

function makeOrder(
  overrides?: Partial<{
    id: string;
    buyerHumanId: string;
    eventId: string;
  }>,
) {
  return {
    id: overrides?.id ?? ORDER_ID,
    eventId: overrides?.eventId ?? EVENT_ID,
    buyerHumanId: overrides?.buyerHumanId ?? BUYER_ID,
    amountGrossCents: 5250,
    feesPlatformCents: 250,
    taxAmountCents: 0,
    currency: "usd",
    feePolicySnapshot: null,
    status: "SUCCEEDED" as const,
    stripePaymentIntentId: "pi_test",
    source: "RESALE" as const,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
    stripeTaxCalculationId: null,
    items: [
      {
        id: "oi-1",
        orderId: ORDER_ID,
        kind: "ticket" as const,
        ticketTypeId: "tt-1",
        qty: 1,
        unitPriceCents: 5000,
        amountCents: 5000,
        meta: { ticketTypeName: "GA" },
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active" as const,
      },
      {
        id: "oi-2",
        orderId: ORDER_ID,
        kind: "ticket" as const,
        ticketTypeId: null,
        qty: 1,
        unitPriceCents: 250,
        amountCents: 250,
        meta: null,
        paidOutAt: null,
        refundedAt: null,
        transferredAt: null,
        status: "active" as const,
      },
    ],
  };
}

function makeHumanWithIdentity(humanId: string, email = "buyer@example.com") {
  return {
    human: {
      id: humanId,
      name: "Buyer Person",
      status: "ACTIVE" as const,
      roles: [] as string[],
      locale: null,
      phone: null,
      billingAddressLine1: null,
      billingAddressLine2: null,
      billingCity: null,
      billingState: null,
      billingPostalCode: null,
      billingCountry: null,
      defaultPrimaryPayoutTermsId: null,
      defaultResalePayoutTermsId: null,
      trustTier: "NEW" as const,
      trustBadgeLabel: null,
      trustBadgeIcon: null,
      createdAt: NOW,
    },
    identity: {
      authUserId: humanId,
      email,
      emailVerified: true,
      phone: null,
      phoneVerified: false,
      username: null,
      displayUsername: null,
      image: null,
    },
  };
}

function makeEvent() {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: "host-uuid",
    title: "Test Concert",
    status: "PUBLISHED" as const,
    visibility: "PUBLIC" as const,
    gateType: "NONE" as const,
    locationMode: "IN_PERSON" as const,
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2026-04-01T19:00:00Z"),
    endsAt: null,
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    currency: "usd",
    publishedAt: NOW,
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    heroImageId: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    seriesId: null,
    defaultTicketTypeId: null,
    slug: null,
    countryCode: null,
    region: null,
    locality: null,
    postalCode: null,
  };
}

function makeDeps(overrides?: {
  ordersGetById?: (...args: any[]) => any;
  getByIdWithIdentity?: (...args: any[]) => any;
  eventGetById?: (...args: any[]) => any;
  mailerSend?: (...args: any[]) => any;
}): SendResalePurchaseEmailDeps {
  return {
    repos: {
      orders: {
        getById: overrides?.ordersGetById ?? vi.fn(async () => makeOrder()),
      },
      humans: {
        getByIdWithIdentity:
          overrides?.getByIdWithIdentity ??
          vi.fn(async () => makeHumanWithIdentity(BUYER_ID)),
      },
      events: {
        getById: overrides?.eventGetById ?? vi.fn(async () => makeEvent()),
      },
    } as unknown as Repos,
    mailer: {
      send:
        overrides?.mailerSend ??
        vi.fn(async () => ({ result: { id: "msg-1", status: "sent" } })),
      sendBatch: vi.fn(),
      health: vi.fn(),
    } as unknown as MailerPort,
    logger: createTestLogger(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sendResalePurchaseEmail", () => {
  it("sends a purchase confirmation email to the buyer via the order.receipt template", async () => {
    const deps = makeDeps();

    await sendResalePurchaseEmail(deps, {
      orderId: ORDER_ID,
      publicAppUrl: PUBLIC_APP_URL,
      supportUrl: SUPPORT_URL,
    });

    // Looked up order, buyer, and event
    expect(deps.repos.orders.getById).toHaveBeenCalledWith(ORDER_ID);
    expect(deps.repos.humans.getByIdWithIdentity).toHaveBeenCalledWith(
      BUYER_ID,
    );
    expect(deps.repos.events.getById).toHaveBeenCalledWith(EVENT_ID);

    // Sent email with the order.receipt template
    expect(deps.mailer.send).toHaveBeenCalledTimes(1);
    expect(deps.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "buyer@example.com" },
        template: expect.objectContaining({
          key: "order.receipt",
          variables: expect.objectContaining({
            // DISPLAYED value = the ONE order code, the same string the
            // resale confirmation screen and the receipt page show.
            orderId: ORDER_CODE,
            eventTitle: "Test Concert",
            // The link keeps the RAW uuid — it is a path segment.
            viewOrderUrl: `${PUBLIC_APP_URL}/orders/${ORDER_ID}`,
          }),
        }),
        // Idempotency stays keyed by the raw (unique) id, never the 8-hex
        // code, which is only 32 bits and not unique by construction.
        idempotencyKey: `resale-purchase-receipt:${ORDER_ID}`,
      }),
    );

    const call = (deps.mailer.send as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.template.variables.orderId).toBe(formatOrderCode(ORDER_ID));
    expect(call.template.variables.orderId).not.toBe(ORDER_ID);
    // Not the HEAD of the uuid — also 8 hex chars, parses as an order code,
    // resolves to nothing.
    expect(call.template.variables.orderId).not.toBe(
      ORDER_ID.slice(0, 8).toUpperCase(),
    );
  });

  it("returns early when order is not found", async () => {
    const deps = makeDeps({
      ordersGetById: vi.fn(async () => null),
    });

    await sendResalePurchaseEmail(deps, {
      orderId: ORDER_ID,
      publicAppUrl: PUBLIC_APP_URL,
      supportUrl: SUPPORT_URL,
    });

    expect(deps.repos.humans.getByIdWithIdentity).not.toHaveBeenCalled();
    expect(deps.mailer.send).not.toHaveBeenCalled();
  });

  it("returns early when buyer is not found", async () => {
    const deps = makeDeps({
      getByIdWithIdentity: vi.fn(async () => null),
    });

    await sendResalePurchaseEmail(deps, {
      orderId: ORDER_ID,
      publicAppUrl: PUBLIC_APP_URL,
      supportUrl: SUPPORT_URL,
    });

    expect(deps.mailer.send).not.toHaveBeenCalled();
  });

  it("returns early when event is not found", async () => {
    const deps = makeDeps({
      eventGetById: vi.fn(async () => null),
    });

    await sendResalePurchaseEmail(deps, {
      orderId: ORDER_ID,
      publicAppUrl: PUBLIC_APP_URL,
      supportUrl: SUPPORT_URL,
    });

    expect(deps.mailer.send).not.toHaveBeenCalled();
  });

  it("swallows errors and does not throw", async () => {
    const deps = makeDeps({
      ordersGetById: vi.fn(async () => {
        throw new Error("DB went away");
      }),
    });

    await expect(
      sendResalePurchaseEmail(deps, {
        orderId: ORDER_ID,
        publicAppUrl: PUBLIC_APP_URL,
        supportUrl: SUPPORT_URL,
      }),
    ).resolves.toBeUndefined();
  });
});
