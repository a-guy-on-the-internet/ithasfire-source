import { describe, it, expect, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  notifyResaleSellerSold,
  type NotifyResaleSellerSoldDeps,
} from "../notify-resale-seller-sold";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SELLER_ID = "seller-uuid";
const LISTING_ID = "listing-uuid";
const ORDER_ID = "order-uuid";
const EVENT_ID = "event-uuid";
const PUBLIC_APP_URL = "https://ithasfire.com";
const NOW = new Date("2026-03-10T12:00:00Z");

function makeListing(
  overrides?: Partial<{
    id: string;
    sellerHumanId: string;
    eventId: string;
    askPriceCents: number;
    currency: string;
  }>,
) {
  return {
    id: overrides?.id ?? LISTING_ID,
    ticketId: "ticket-uuid",
    eventId: overrides?.eventId ?? EVENT_ID,
    sellerHumanId: overrides?.sellerHumanId ?? SELLER_ID,
    askPriceCents: overrides?.askPriceCents ?? 5000,
    currency: overrides?.currency ?? "usd",
    status: "SOLD" as const,
    expiresAt: null,
    source: "internal",
    externalRef: null,
    resalePayoutTermsId: null,
    buyerOrderId: ORDER_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeHumanWithIdentity(humanId: string, email = "seller@example.com") {
  return {
    human: {
      id: humanId,
      name: "Seller Person",
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
    humanId: SELLER_ID,
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
  listingGetById?: (...args: any[]) => any;
  getByIdWithIdentity?: (...args: any[]) => any;
  eventGetById?: (...args: any[]) => any;
  notificationsCreate?: (...args: any[]) => any;
  mailerSend?: (...args: any[]) => any;
}): NotifyResaleSellerSoldDeps {
  return {
    repos: {
      resaleListings: {
        getById: overrides?.listingGetById ?? vi.fn(async () => makeListing()),
      },
      humans: {
        getByIdWithIdentity:
          overrides?.getByIdWithIdentity ??
          vi.fn(async () => makeHumanWithIdentity(SELLER_ID)),
      },
      events: {
        getById: overrides?.eventGetById ?? vi.fn(async () => makeEvent()),
      },
      notifications: {
        create:
          overrides?.notificationsCreate ??
          vi.fn(async () => ({ id: "notif-1", createdAt: NOW })),
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

describe("notifyResaleSellerSold", () => {
  it("sends a 'ticket sold' in-app notification and email to the seller", async () => {
    const deps = makeDeps();

    await notifyResaleSellerSold(deps, {
      orderId: ORDER_ID,
      listingId: LISTING_ID,
      publicAppUrl: PUBLIC_APP_URL,
    });

    // Looked up the listing
    expect(deps.repos.resaleListings.getById).toHaveBeenCalledWith(LISTING_ID);

    // Looked up the seller
    expect(deps.repos.humans.getByIdWithIdentity).toHaveBeenCalledWith(
      SELLER_ID,
    );

    // Looked up the event
    expect(deps.repos.events.getById).toHaveBeenCalledWith(EVENT_ID);

    // Created in-app notification
    expect(deps.repos.notifications?.create).toHaveBeenCalledTimes(1);
    expect(deps.repos.notifications?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: SELLER_ID,
        title: "Ticket sold!",
        kind: "SUCCESS",
        tags: ["resale", "sale"],
      }),
    );

    // Sent email
    expect(deps.mailer.send).toHaveBeenCalledTimes(1);
    expect(deps.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "seller@example.com" },
        idempotencyKey: `resale-seller-sold:${LISTING_ID}`,
      }),
    );
  });

  it("returns early when listing is not found", async () => {
    const deps = makeDeps({
      listingGetById: vi.fn(async () => null),
    });

    await notifyResaleSellerSold(deps, {
      orderId: ORDER_ID,
      listingId: LISTING_ID,
      publicAppUrl: PUBLIC_APP_URL,
    });

    expect(deps.repos.humans.getByIdWithIdentity).not.toHaveBeenCalled();
    expect(deps.repos.notifications?.create).not.toHaveBeenCalled();
    expect(deps.mailer.send).not.toHaveBeenCalled();
  });

  it("returns early when seller is not found", async () => {
    const deps = makeDeps({
      getByIdWithIdentity: vi.fn(async () => null),
    });

    await notifyResaleSellerSold(deps, {
      orderId: ORDER_ID,
      listingId: LISTING_ID,
      publicAppUrl: PUBLIC_APP_URL,
    });

    expect(deps.repos.notifications?.create).not.toHaveBeenCalled();
    expect(deps.mailer.send).not.toHaveBeenCalled();
  });

  it("swallows errors and does not throw", async () => {
    const deps = makeDeps({
      listingGetById: vi.fn(async () => {
        throw new Error("DB went away");
      }),
    });

    // Should not throw
    await expect(
      notifyResaleSellerSold(deps, {
        orderId: ORDER_ID,
        listingId: LISTING_ID,
        publicAppUrl: PUBLIC_APP_URL,
      }),
    ).resolves.toBeUndefined();
  });
});
