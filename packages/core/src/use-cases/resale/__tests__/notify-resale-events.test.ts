import { describe, it, expect, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  notifyListingCreated,
  notifyClaimOpened,
  notifyClaimResolved,
  type ResaleNotifyDeps,
} from "../notify-resale-events";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SELLER_ID = "seller-uuid";
const BUYER_ID = "buyer-uuid";
const EVENT_ID = "event-uuid";
const LISTING_ID = "listing-uuid";
const CLAIM_ID = "claim-uuid";
const PUBLIC_APP_URL = "https://ithasfire.com";
const NOW = new Date("2026-03-10T12:00:00Z");

function makeHumanWithIdentity(humanId: string, email = "test@example.com") {
  return {
    human: {
      id: humanId,
      name: "Test Human",
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

function makeEvent(id: string = EVENT_ID) {
  return {
    id,
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
  getByIdWithIdentity?: (...args: any[]) => any;
  eventGetById?: (...args: any[]) => any;
  notificationsCreate?: (...args: any[]) => any;
  mailerSend?: (...args: any[]) => any;
  withLogger?: boolean;
}): ResaleNotifyDeps {
  return {
    repos: {
      humans: {
        getByIdWithIdentity:
          overrides?.getByIdWithIdentity ??
          vi.fn(async () =>
            makeHumanWithIdentity(SELLER_ID, "seller@example.com"),
          ),
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
    logger: overrides?.withLogger !== false ? createTestLogger() : undefined,
  };
}

// ── notifyListingCreated ─────────────────────────────────────────────────────

describe("notifyListingCreated", () => {
  it("sends an in-app notification and email to the seller", async () => {
    const deps = makeDeps();

    await notifyListingCreated(deps, {
      listingId: LISTING_ID,
      sellerHumanId: SELLER_ID,
      eventId: EVENT_ID,
      askPriceCents: 5000,
      currency: "usd",
      publicAppUrl: PUBLIC_APP_URL,
    });

    // Should have looked up the seller
    expect(deps.repos.humans.getByIdWithIdentity).toHaveBeenCalledWith(
      SELLER_ID,
    );

    // Should have looked up the event
    expect(deps.repos.events.getById).toHaveBeenCalledWith(EVENT_ID);

    // Should have created an in-app notification
    expect(deps.repos.notifications?.create).toHaveBeenCalledTimes(1);
    expect(deps.repos.notifications?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: SELLER_ID,
        title: "Ticket listed for resale",
        kind: "INFO",
      }),
    );

    // Should have sent an email
    expect(deps.mailer.send).toHaveBeenCalledTimes(1);
    expect(deps.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "seller@example.com" },
        idempotencyKey: `resale-listing-created:${LISTING_ID}`,
      }),
    );
  });

  it("returns early when seller is not found", async () => {
    const deps = makeDeps({
      getByIdWithIdentity: vi.fn(async () => null),
    });

    await notifyListingCreated(deps, {
      listingId: LISTING_ID,
      sellerHumanId: SELLER_ID,
      eventId: EVENT_ID,
      askPriceCents: 5000,
      currency: "usd",
      publicAppUrl: PUBLIC_APP_URL,
    });

    // Should NOT have sent any notifications or emails
    expect(deps.repos.notifications?.create).not.toHaveBeenCalled();
    expect(deps.mailer.send).not.toHaveBeenCalled();
  });

  it("swallows mailer errors and logs a warning", async () => {
    const deps = makeDeps({
      mailerSend: vi.fn(async () => {
        throw new Error("SMTP down");
      }),
      withLogger: true,
    });

    // Should not throw
    await notifyListingCreated(deps, {
      listingId: LISTING_ID,
      sellerHumanId: SELLER_ID,
      eventId: EVENT_ID,
      askPriceCents: 5000,
      currency: "usd",
      publicAppUrl: PUBLIC_APP_URL,
    });

    // Logger.child is called, then the child logger logs the warning
    expect(deps.logger?.child).toHaveBeenCalled();
  });
});

// ── notifyClaimOpened ────────────────────────────────────────────────────────

describe("notifyClaimOpened", () => {
  it("sends an in-app notification and email to the respondent", async () => {
    const deps = makeDeps();

    await notifyClaimOpened(deps, {
      claimId: CLAIM_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      kind: "item_not_as_described",
      deadline: "2026-04-01T00:00:00Z",
      publicAppUrl: PUBLIC_APP_URL,
    });

    expect(deps.repos.humans.getByIdWithIdentity).toHaveBeenCalledWith(
      SELLER_ID,
    );
    expect(deps.repos.events.getById).toHaveBeenCalledWith(EVENT_ID);

    expect(deps.repos.notifications?.create).toHaveBeenCalledTimes(1);
    expect(deps.repos.notifications?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: SELLER_ID,
        kind: "WARNING",
        tags: ["resale", "claim"],
      }),
    );

    expect(deps.mailer.send).toHaveBeenCalledTimes(1);
    expect(deps.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `resale-claim-opened:${CLAIM_ID}`,
      }),
    );
  });

  it("returns early when respondent is not found", async () => {
    const deps = makeDeps({
      getByIdWithIdentity: vi.fn(async () => null),
    });

    await notifyClaimOpened(deps, {
      claimId: CLAIM_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      kind: "item_not_as_described",
      deadline: "2026-04-01T00:00:00Z",
      publicAppUrl: PUBLIC_APP_URL,
    });

    expect(deps.repos.notifications?.create).not.toHaveBeenCalled();
    expect(deps.mailer.send).not.toHaveBeenCalled();
  });
});

// ── notifyClaimResolved ──────────────────────────────────────────────────────

describe("notifyClaimResolved", () => {
  it("sends notifications to both buyer and seller for an approved claim", async () => {
    const getByIdWithIdentity = vi
      .fn()
      .mockImplementation(async (id: string) => {
        if (id === BUYER_ID)
          return makeHumanWithIdentity(BUYER_ID, "buyer@example.com");
        if (id === SELLER_ID)
          return makeHumanWithIdentity(SELLER_ID, "seller@example.com");
        return null;
      });

    const deps = makeDeps({ getByIdWithIdentity });

    await notifyClaimResolved(deps, {
      claimId: CLAIM_ID,
      claimantId: BUYER_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      status: "approved",
      resolution: "full_refund",
      publicAppUrl: PUBLIC_APP_URL,
    });

    // Should have looked up both buyer and seller
    expect(getByIdWithIdentity).toHaveBeenCalledWith(BUYER_ID);
    expect(getByIdWithIdentity).toHaveBeenCalledWith(SELLER_ID);

    // Two in-app notifications (buyer + seller)
    expect(deps.repos.notifications?.create).toHaveBeenCalledTimes(2);

    // Two emails (buyer + seller)
    expect(deps.mailer.send).toHaveBeenCalledTimes(2);

    // Verify buyer email has the right idempotency key
    expect(deps.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "buyer@example.com" },
        idempotencyKey: `resale-claim-resolved-buyer:${CLAIM_ID}`,
      }),
    );

    // Verify seller email has the right idempotency key
    expect(deps.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "seller@example.com" },
        idempotencyKey: `resale-claim-resolved-seller:${CLAIM_ID}`,
      }),
    );
  });

  it("sends notifications to both buyer and seller for a denied claim", async () => {
    const getByIdWithIdentity = vi
      .fn()
      .mockImplementation(async (id: string) => {
        if (id === BUYER_ID)
          return makeHumanWithIdentity(BUYER_ID, "buyer@example.com");
        if (id === SELLER_ID)
          return makeHumanWithIdentity(SELLER_ID, "seller@example.com");
        return null;
      });

    const deps = makeDeps({ getByIdWithIdentity });

    await notifyClaimResolved(deps, {
      claimId: CLAIM_ID,
      claimantId: BUYER_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      status: "denied",
      resolution: null,
      publicAppUrl: PUBLIC_APP_URL,
    });

    // Buyer should get INFO kind for denied claim
    expect(deps.repos.notifications?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: BUYER_ID,
        kind: "INFO",
      }),
    );

    // Seller should get SUCCESS kind for denied claim (resolved in their favor)
    expect(deps.repos.notifications?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: SELLER_ID,
        kind: "SUCCESS",
      }),
    );
  });

  it("skips buyer notification if buyer not found", async () => {
    const getByIdWithIdentity = vi
      .fn()
      .mockImplementation(async (id: string) => {
        if (id === BUYER_ID) return null;
        if (id === SELLER_ID)
          return makeHumanWithIdentity(SELLER_ID, "seller@example.com");
        return null;
      });

    const deps = makeDeps({ getByIdWithIdentity });

    await notifyClaimResolved(deps, {
      claimId: CLAIM_ID,
      claimantId: BUYER_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      status: "approved",
      resolution: "full_refund",
      publicAppUrl: PUBLIC_APP_URL,
    });

    // Only seller notification + email
    expect(deps.repos.notifications?.create).toHaveBeenCalledTimes(1);
    expect(deps.mailer.send).toHaveBeenCalledTimes(1);
    expect(deps.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "seller@example.com" },
      }),
    );
  });

  it("skips seller notification if seller not found", async () => {
    const getByIdWithIdentity = vi
      .fn()
      .mockImplementation(async (id: string) => {
        if (id === BUYER_ID)
          return makeHumanWithIdentity(BUYER_ID, "buyer@example.com");
        if (id === SELLER_ID) return null;
        return null;
      });

    const deps = makeDeps({ getByIdWithIdentity });

    await notifyClaimResolved(deps, {
      claimId: CLAIM_ID,
      claimantId: BUYER_ID,
      respondentId: SELLER_ID,
      eventId: EVENT_ID,
      status: "denied",
      resolution: null,
      publicAppUrl: PUBLIC_APP_URL,
    });

    // Only buyer notification + email
    expect(deps.repos.notifications?.create).toHaveBeenCalledTimes(1);
    expect(deps.mailer.send).toHaveBeenCalledTimes(1);
    expect(deps.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: "buyer@example.com" },
      }),
    );
  });
});
