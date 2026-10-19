import { describe, expect, it, vi } from "vitest";

import { sendTicketIssuedEmail } from "../send-ticket-issued-email";
import { formatOrderCode } from "@th/types/order-identifier";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { HumanRecord } from "@th/ports/repos/humans";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { TicketRecord } from "@th/ports/repos/tickets";

// Head and tail MUST differ. A repdigit uuid (`1111…1111`) passes identically
// whether `formatOrderCode` takes the head or the tail, so it pins nothing —
// and the head is the exact wrong answer this code exists to prevent (it is
// also 8 hex chars, so it parses as an order code and then resolves to
// nothing).
const ORDER_ID = "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3";
/** The ONE displayed order code: the 8-hex TAIL, uppercased. */
const ORDER_CODE = "DB21B2C3";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const PLACE_ID = "44444444-4444-4444-8444-444444444444";
const TICKET_ID = "55555555-5555-4555-8555-555555555555";

const order: OrderRecord = {
  id: ORDER_ID,
  eventId: EVENT_ID,
  buyerHumanId: HUMAN_ID,
  amountGrossCents: 2500,
  feesPlatformCents: 0,
  currency: "usd",
  feePolicySnapshot: {},
  status: "SUCCEEDED",
  stripePaymentIntentId: "pi_123",
  source: "PRIMARY",
  occurredAt: new Date("2026-01-22T00:00:00.000Z"),
  parentOrderId: null,
  taxAmountCents: 0,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  stripeTaxCalculationId: null,
  items: [],
};

const human: HumanRecord = {
  id: HUMAN_ID,
  name: "Buyer",
  status: "ACTIVE",
  roles: ["USER"],
  locale: "en-US",
  phone: null,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  trustTier: "NEW",
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date(),
};

const identity = {
  authUserId: HUMAN_ID,
  email: "buyer@example.com",
  emailVerified: true,
  phone: null,
  phoneVerified: false,
  username: null,
  displayUsername: null,
  image: null,
};

const event: EventRecord = {
  id: EVENT_ID,
  orgId: "org-1",
  humanId: null,
  title: "Launch Party",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2026-02-01T00:00:00.000Z"),
  endsAt: null,
  placeId: PLACE_ID,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  countryCode: null,
  region: null,
  locality: null,
  postalCode: null,
  lat: null,
  lng: null,
  content: null,
  slug: "launch-party",
  shortId: null,
  regionCode: null,
  agreementPrimaryId: "agreement-1",
  agreementResaleId: null,
  defaultLocale: null,
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  publishedAt: new Date("2026-01-22T00:00:00.000Z"),
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
  createdAt: new Date("2026-01-22T00:00:00.000Z"),
  updatedAt: new Date("2026-01-22T00:00:00.000Z"),
};

const place: PlaceRecord = {
  id: PLACE_ID,
  name: "Test Venue",
  slug: "test-place",
  formattedAddress: "123 Test St, San Francisco, CA 94111",
  addressLine1: "123 Test St",
  addressLine2: null,
  city: "San Francisco",
  region: "CA",
  postalCode: "94111",
  countryCode: "US",
  capacity: null,
  lat: 0,
  lng: 0,
  status: "ACTIVE",
  verificationStatus: "VERIFIED",
  orgIdsWithAccess: ["org-1"],
  humanIdsWithAccess: [],
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  // A venue that publishes its address. EXPLICIT because the venue ceiling
  // (`applyPlaceLocationFloor`) fails closed: a fake that omits this withholds,
  // and every assertion below about an EXACT event would then be testing the
  // withheld path by accident.
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
} as unknown as PlaceRecord;

/** The same venue, withholding its address. */
const withheldPlace = {
  ...place,
  locationMode: "OBSCURED",
  locationRadiusMeters: null,
  locationLabel: "SoMa",
} as unknown as PlaceRecord;

const ticket: TicketRecord = {
  id: TICKET_ID,
  eventId: EVENT_ID,
  ticketTypeId: "ticket-type-1",
  ownerHumanId: HUMAN_ID,
  orderId: ORDER_ID,
  orderItemId: null,
  seatId: null,
  code: "TICKET-CODE",
  status: "VALID",
  issuedAt: new Date("2026-01-22T00:00:00.000Z"),
  scannedAt: null,
};

const SEAT_ID = "66666666-6666-4666-8666-666666666666";
const SECTION_ID = "77777777-7777-4777-8777-777777777777";

const seatedTicket: TicketRecord = {
  ...ticket,
  id: "88888888-8888-4888-8888-888888888888",
  seatId: SEAT_ID,
  code: "SEATED-CODE",
};

describe("sendTicketIssuedEmail", () => {
  it("sends a ticket issued email", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_1" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(event) },
      places: { getById: vi.fn().mockResolvedValue(place) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
      },
    } as unknown as Repos;

    const result = await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.ticketCount).toBe(1);
    expect(result.recipientEmail).toBe(identity.email);
    // The use case's OWN output stays the raw id — callers key work off it
    // (and the output schema is `z.string().uuid()`).
    expect(result.orderId).toBe(ORDER_ID);
    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: identity.email },
        template: expect.objectContaining({
          key: "ticket.issued",
          variables: expect.objectContaining({
            // The DISPLAYED order value is the ONE order code, not the raw
            // UUID. Pinning `ORDER_ID` here is what let the email drift away
            // from the checkout confirmation and the receipt page.
            orderId: ORDER_CODE,
            manageUrl: `http://localhost:3000/my-tickets/${ORDER_ID}`,
            // Support CTA deep-links to the help section of the buyer's order
            // page rather than the generic /support hub.
            supportUrl: `http://localhost:3000/my-tickets/${ORDER_ID}#get-help`,
            tickets: [
              {
                code: "TICKET-CODE",
                qrUrl: "http://localhost:3000/tickets/qr/TICKET-CODE",
              },
            ],
          }),
        }),
      }),
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const variables = call.template.variables;

    // The code is derived, never hand-rolled — this is the same helper every
    // other surface calls, so the two cannot drift.
    expect(variables.orderId).toBe(formatOrderCode(ORDER_ID));
    // ...and it is NOT the head of the uuid, which is also 8 hex chars and
    // would satisfy the search parser while matching nothing.
    expect(variables.orderId).not.toBe(ORDER_ID.slice(0, 8).toUpperCase());

    // The raw 36-char UUID must not be the buyer-facing order value.
    expect(variables.orderId).not.toBe(ORDER_ID);

    // It DOES still ride the links, which are keyed by the real id — the
    // buyer's order page is `/my-tickets/<order.id>`, so stripping the UUID
    // out of these would 404.
    expect(variables.manageUrl).toContain(ORDER_ID);
    expect(variables.supportUrl).toContain(ORDER_ID);

    // Idempotency is keyed by the raw id, not the (non-unique) 8-hex code.
    expect(call.idempotencyKey).toBe(`ticket-issued:${ORDER_ID}`);
  });

  it("includes seat labels for seated tickets and omits them for GA tickets", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_seats" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const findByIdsForUpdate = vi.fn().mockResolvedValue([
      {
        id: SEAT_ID,
        seatSectionId: SECTION_ID,
        eventId: EVENT_ID,
        status: "SOLD",
        label: "A12",
        row: "A",
        number: 12,
      },
    ]);
    const getSectionById = vi.fn().mockResolvedValue({
      id: SECTION_ID,
      name: "Front Row",
      type: "RESERVED",
      capacity: 20,
      layoutSectionId: null,
      placeLayoutId: null,
    });

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(event) },
      places: { getById: vi.fn().mockResolvedValue(place) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        // One seated ticket + one GA ticket in the same order.
        listByOrderId: vi.fn().mockResolvedValue([seatedTicket, ticket]),
      },
      seats: { findByIdsForUpdate, getSectionById },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
      },
    );

    expect(findByIdsForUpdate).toHaveBeenCalledWith({
      seatIds: [SEAT_ID],
      eventId: EVENT_ID,
    });

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const tickets = call.template.variables.tickets;
    expect(tickets).toEqual([
      {
        code: "SEATED-CODE",
        qrUrl: "http://localhost:3000/tickets/qr/SEATED-CODE",
        seatLabel: "Front Row · A12",
      },
      {
        code: "TICKET-CODE",
        qrUrl: "http://localhost:3000/tickets/qr/TICKET-CODE",
      },
    ]);
    // The GA ticket must not carry an (even undefined) seat line.
    expect("seatLabel" in tickets[1]).toBe(false);
  });

  it("falls back to the raw seat label when the section lookup returns nothing", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_seats2" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(event) },
      places: { getById: vi.fn().mockResolvedValue(place) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([seatedTicket]),
      },
      seats: {
        findByIdsForUpdate: vi.fn().mockResolvedValue([
          {
            id: SEAT_ID,
            seatSectionId: SECTION_ID,
            eventId: EVENT_ID,
            status: "SOLD",
            label: "A12",
            row: "A",
            number: 12,
          },
        ]),
        getSectionById: vi.fn().mockResolvedValue(null),
      },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
      },
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.template.variables.tickets[0].seatLabel).toBe("A12");
  });

  it("rejects when supportUrl is missing", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_2" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(event) },
      places: { getById: vi.fn().mockResolvedValue(place) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
      },
    } as unknown as Repos;

    await expect(
      sendTicketIssuedEmail(
        { repos, mailer },
        {
          orderId: ORDER_ID,
          publicAppUrl: "http://localhost:3000",
          // supportUrl intentionally omitted
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(mailer.send).not.toHaveBeenCalled();
  });

  it("locks the exact address when addressRevealAt is in the future", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_3" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    // Event with coords + a future reveal timestamp.
    const lockedEvent: EventRecord = {
      ...event,
      locationMode: "OBSCURED",
      addressRevealAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      addressRevealPreset: "DAY_BEFORE",
      locality: "San Francisco",
      region: "CA",
      lat: 37.7749,
      lng: -122.4194,
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(lockedEvent) },
      places: { getById: vi.fn().mockResolvedValue(place) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
      },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
        tileServerUrl: "https://tiles.example.com",
      },
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const variables = call.template.variables;
    expect(variables.addressRevealAtISO).toBe(
      lockedEvent.addressRevealAt!.toISOString(),
    );
    expect(variables.venueAddress).toBeUndefined();
    expect(variables.mapImageUrl).toBeUndefined();
    expect(variables.directionsUrl).toBeUndefined();

    // NFR-004: the linked Place's name is a de-facto exact address for a
    // pre-reveal event, so the venue heading must be the coarse area label —
    // never the venue's public name.
    expect(variables.venueName).toBe("San Francisco, CA");
    expect(JSON.stringify(variables)).not.toContain(place.name);
  });

  it("prefers the coarse area label over a venue-name-bearing locationLabel while locked", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_3b" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    // locationLabel semantics are ambiguous across the codebase — here it
    // carries an actual venue name, which must NOT outrank the always-safe
    // coarse "locality, region" label while the address is locked.
    const lockedLabeledEvent: EventRecord = {
      ...event,
      placeId: null,
      locationMode: "OBSCURED",
      locationLabel: "The Basement East",
      locality: "Nashville",
      region: "TN",
      addressRevealAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      addressRevealPreset: "DAY_BEFORE",
      lat: 36.1773,
      lng: -86.7554,
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(lockedLabeledEvent) },
      places: { getById: vi.fn().mockResolvedValue(null) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
      },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
      },
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const variables = call.template.variables;
    expect(variables.venueName).toBe("Nashville, TN");
    expect(JSON.stringify(variables)).not.toContain("The Basement East");
  });

  it("reveals the exact address when addressRevealAt is in the past", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_4" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const revealedEvent: EventRecord = {
      ...event,
      locationMode: "OBSCURED",
      addressRevealAt: new Date(Date.now() - 60 * 60 * 1000),
      addressRevealPreset: "ONE_HOUR_BEFORE",
      lat: 37.7749,
      lng: -122.4194,
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(revealedEvent) },
      places: { getById: vi.fn().mockResolvedValue(place) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
      },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
        tileServerUrl: "https://tiles.example.com",
      },
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const variables = call.template.variables;
    expect(variables.addressRevealAtISO).toBeUndefined();
    expect(variables.venueAddress).toBe(place.formattedAddress);
    expect(variables.directionsUrl).toContain("google.com/maps/dir");
  });

  it("does not leak the exact address via venueName when place is null and reveal is locked", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_5" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const lockedFreeformEvent: EventRecord = {
      ...event,
      placeId: null,
      locationMode: "OBSCURED",
      addressText: "142 Troutman St, Brooklyn, NY 11206",
      locationLabel: "Bushwick, Brooklyn",
      addressRevealAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      addressRevealPreset: "DAY_BEFORE",
      lat: 40.7061,
      lng: -73.9235,
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(lockedFreeformEvent) },
      places: { getById: vi.fn().mockResolvedValue(null) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
      },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
        tileServerUrl: "https://tiles.example.com",
      },
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const variables = call.template.variables;

    // venueName must be the redacted area label, not the freeform street address.
    expect(variables.venueName).toBe("Bushwick, Brooklyn");

    // The full street address must not appear in any email variable.
    const serialized = JSON.stringify(variables);
    expect(serialized).not.toContain("142 Troutman St");
    expect(serialized).not.toContain("11206");

    // And the address/map/directions are still suppressed.
    expect(variables.venueAddress).toBeUndefined();
    expect(variables.mapImageUrl).toBeUndefined();
    expect(variables.directionsUrl).toBeUndefined();
    expect(variables.addressRevealAtISO).toBe(
      lockedFreeformEvent.addressRevealAt!.toISOString(),
    );
  });

  it("fully-hidden (OBSCURED + null radius) pre-reveal → reveal notice, no map at all", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_6" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const hiddenEvent: EventRecord = {
      ...event,
      placeId: null,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      addressText: "142 Troutman St, Brooklyn, NY 11206",
      locationLabel: "Bushwick, Brooklyn",
      addressRevealAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      addressRevealPreset: "DAY_BEFORE",
      lat: 40.7061,
      lng: -73.9235,
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(hiddenEvent) },
      places: { getById: vi.fn().mockResolvedValue(null) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
      },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
        tileServerUrl: "https://tiles.example.com",
      },
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const variables = call.template.variables;

    // The "revealed on {date}" notice renders; no map (obfuscated or
    // otherwise), no address, no directions.
    expect(variables.addressRevealAtISO).toBe(
      hiddenEvent.addressRevealAt!.toISOString(),
    );
    expect(variables.venueAddress).toBeUndefined();
    expect(variables.mapImageUrl).toBeUndefined();
    expect(variables.directionsUrl).toBeUndefined();
    expect(JSON.stringify(variables)).not.toContain("142 Troutman St");
  });

  it("fully-hidden (OBSCURED + null radius) with a linked Place suppresses the venue name pre-reveal", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_6b" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const hiddenPlaceEvent: EventRecord = {
      ...event,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
      locationLabel: "SoMa, San Francisco",
      addressRevealAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      addressRevealPreset: "DAY_BEFORE",
      lat: 37.7749,
      lng: -122.4194,
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(hiddenPlaceEvent) },
      places: { getById: vi.fn().mockResolvedValue(place) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
      },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
        tileServerUrl: "https://tiles.example.com",
      },
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const variables = call.template.variables;

    // A named venue IS the exact address for a fully-hidden show (NFR-004):
    // the redacted locationLabel renders instead, and the Place's name and
    // address must appear nowhere in the email.
    expect(variables.venueName).toBe("SoMa, San Francisco");
    const serialized = JSON.stringify(variables);
    expect(serialized).not.toContain(place.name);
    expect(serialized).not.toContain(place.formattedAddress!);
    expect(variables.venueAddress).toBeUndefined();
    expect(variables.mapImageUrl).toBeUndefined();
    expect(variables.directionsUrl).toBeUndefined();
  });

  it("fails closed: OBSCURED with a null addressRevealAt (invariant violation) stays locked", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_7" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const invariantViolationEvent: EventRecord = {
      ...event,
      placeId: null,
      locationMode: "OBSCURED",
      addressText: "142 Troutman St, Brooklyn, NY 11206",
      locationLabel: "Bushwick, Brooklyn",
      addressRevealAt: null,
      addressRevealPreset: null,
      lat: 40.7061,
      lng: -73.9235,
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        // Model a REAL account by default. The use case derives an
        // /auth/complete claim link for buyers who cannot sign in, and
        // `isLoginableBuyer` is fail-safe FALSE — so a missing mock silently
        // adds a claim link to every fixture instead of failing loudly.
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(invariantViolationEvent) },
      places: { getById: vi.fn().mockResolvedValue(null) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
      },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
        tileServerUrl: "https://tiles.example.com",
      },
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const variables = call.template.variables;

    // Locked (no address/map/directions) even though no reveal date exists —
    // a null reveal date on a non-EXACT event never means 'revealed'.
    expect(variables.venueAddress).toBeUndefined();
    expect(variables.mapImageUrl).toBeUndefined();
    expect(variables.directionsUrl).toBeUndefined();
    expect(variables.addressRevealAtISO).toBeUndefined();
    expect(JSON.stringify(variables)).not.toContain("142 Troutman St");
  });
});

describe("guest-checkout account-claim link", () => {
  /**
   * A guest buyer's shadow AuthUser has no AuthAccount rows, so every
   * "sign in to view your order" path is a dead end for them — and
   * /my-tickets/** is gated. The receipt email therefore carries an
   * /auth/complete link so they can claim the order into an account.
   *
   * Their TICKET never depended on this: the QR is an unauthenticated
   * /tickets/qr/{code} image rendered inline in the same email.
   */
  /** Minimal deps for the claim-link decision, parameterised by auth accounts. */
  const buildTicketEmailFixture = (opts: {
    authAccounts: Array<{ id: string; providerId: string }>;
  }) => {
    const mailer = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_1" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    } as unknown as MailerPort & { send: ReturnType<typeof vi.fn> };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        listAuthAccounts: vi.fn().mockResolvedValue(opts.authAccounts),
      },
      events: { getById: vi.fn().mockResolvedValue(event) },
      places: { getById: vi.fn().mockResolvedValue(place) },
      tickets: {
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
      },
    } as unknown as Repos;

    return { repos, mailer };
  };

  const claimUrlOf = (mailer: { send: ReturnType<typeof vi.fn> }) => {
    const sent = mailer.send.mock.calls[0]?.[0] as {
      template: { variables: Record<string, unknown> };
    };
    return sent.template.variables.accountCompletionUrl;
  };

  it("adds a claim link when the buyer has no auth accounts (guest checkout)", async () => {
    const { repos, mailer } = buildTicketEmailFixture({ authAccounts: [] });
    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "https://app.test",
        supportUrl: "https://app.test/support",
      },
    );
    expect(claimUrlOf(mailer)).toBe(
      "https://app.test/auth/complete?email=buyer%40example.com&src=guest-checkout",
    );
  });

  it("adds NO claim link when the buyer has a real account", async () => {
    const { repos, mailer } = buildTicketEmailFixture({
      authAccounts: [{ id: "acct_1", providerId: "credential" }],
    });
    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "https://app.test",
        supportUrl: "https://app.test/support",
      },
    );
    expect(claimUrlOf(mailer)).toBeUndefined();
  });

  it("lets an explicit caller-supplied claim link win (volunteer-comp attribution)", async () => {
    const { repos, mailer } = buildTicketEmailFixture({ authAccounts: [] });
    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "https://app.test",
        supportUrl: "https://app.test/support",
        accountCompletionUrl:
          "https://app.test/auth/complete?email=vol%40example.com&src=volunteer-comp",
      },
    );
    expect(claimUrlOf(mailer)).toBe(
      "https://app.test/auth/complete?email=vol%40example.com&src=volunteer-comp",
    );
  });
});

// ── The venue ceiling in the purchase email ─────────────────────────────────
//
// A purchase email is a per-recipient surface, but it is still the address
// leaving the building — and the event most likely to be stored EXACT at a
// withheld venue is one published BEFORE the venue was ever hidden.
describe("sendTicketIssuedEmail — a venue that withholds its address", () => {
  it("locks an EXACT event's address, map and directions once its venue is withheld", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_floor" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      // Stored EXACT: published before the venue was hidden.
      events: { getById: vi.fn().mockResolvedValue(event) },
      places: { getById: vi.fn().mockResolvedValue(withheldPlace) },
      tickets: {
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
      },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
        tileServerUrl: "https://tiles.example.com",
      },
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const variables = call.template.variables;

    expect(variables.venueAddress).toBeUndefined();
    expect(variables.mapImageUrl).toBeUndefined();
    expect(variables.directionsUrl).toBeUndefined();
    // NFR-004: the venue's public NAME is a de-facto exact address while
    // locked, so the heading must not be it. This fixture's event carries no
    // locality/region of its own, so there is no coarse label to fall back to
    // either and the heading degrades all the way to "Place TBA" — the
    // fail-closed end of the same ladder, not a separate behaviour.
    expect(variables.venueName).toBe("Place TBA");

    const serialized = JSON.stringify(variables);
    expect(serialized).not.toContain(place.formattedAddress!);
    expect(serialized).not.toContain(place.name);
  });

  it("changes NOTHING for the same EXACT event at a venue that publishes its address", async () => {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_exact" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };

    const repos = {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(event) },
      places: { getById: vi.fn().mockResolvedValue(place) },
      tickets: {
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
      },
    } as unknown as Repos;

    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
        tileServerUrl: "https://tiles.example.com",
      },
    );

    const call = (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const variables = call.template.variables;

    expect(variables.venueName).toBe(place.name);
    expect(variables.venueAddress).toBe(place.formattedAddress);
  });
});

describe("sendTicketIssuedEmail — NEVER, and the source of the revealed address", () => {
  function reposFor(
    theEvent: EventRecord,
    thePlace: PlaceRecord | null,
  ): Repos {
    return {
      orders: { getById: vi.fn().mockResolvedValue(order) },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(theEvent) },
      places: { getById: vi.fn().mockResolvedValue(thePlace) },
      tickets: {
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
      },
    } as unknown as Repos;
  }

  async function variablesFor(repos: Repos) {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_src" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };
    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
        tileServerUrl: "https://tiles.example.com",
      },
    );
    return (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].template
      .variables;
  }

  it("NEVER: no address, no map, no directions and no reveal date — even with a stale past date", async () => {
    const neverEvent: EventRecord = {
      ...event,
      placeId: null,
      locationMode: "OBSCURED",
      locationRadiusMeters: 500,
      addressRevealPreset: "NEVER",
      addressRevealAt: new Date(Date.now() - 60 * 60 * 1000),
      addressText: "142 Troutman St, Brooklyn, NY 11206",
      locality: "Bushwick",
      region: "Brooklyn",
      lat: 40.7061,
      lng: -73.9235,
    };

    const variables = await variablesFor(reposFor(neverEvent, null));

    expect(variables.venueName).toBe("Bushwick, Brooklyn");
    expect(variables.venueAddress).toBeUndefined();
    expect(variables.mapImageUrl).toBeUndefined();
    expect(variables.directionsUrl).toBeUndefined();
    // No date to promise: the template shows no "will be shared on" notice.
    expect(variables.addressRevealAtISO).toBeUndefined();
    expect(JSON.stringify(variables)).not.toContain("Troutman");
  });

  it("an empty or whitespace-only name and address fall through to 'Place TBA'", async () => {
    const blankEvent: EventRecord = {
      ...event,
      placeId: null,
      locationMode: "EXACT",
      addressText: "   ",
    };
    const blankPlace = { ...place, name: "  " } as unknown as PlaceRecord;

    expect((await variablesFor(reposFor(blankEvent, null))).venueName).toBe(
      "Place TBA",
    );
    expect(
      (
        await variablesFor(
          reposFor({ ...blankEvent, placeId: PLACE_ID }, blankPlace),
        )
      ).venueName,
    ).toBe("Place TBA");
  });

  it("after the reveal at a withheld venue: map and directions use the Place's TRUE point, not the Event projection", async () => {
    // Part 1's storage: the Event row is the venue's public projection.
    const projectionEvent: EventRecord = {
      ...event,
      locationMode: "OBSCURED",
      locationRadiusMeters: 800,
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: new Date(Date.now() - 60 * 60 * 1000),
      addressText: "SoMa",
      locality: "San Francisco",
      region: "CA",
      lat: 37.78,
      lng: -122.4,
    };
    const trueWithheldPlace = {
      ...withheldPlace,
      lat: 37.7793,
      lng: -122.4193,
    } as unknown as PlaceRecord;

    const variables = await variablesFor(
      reposFor(projectionEvent, trueWithheldPlace),
    );

    expect(variables.addressRevealAtISO).toBeUndefined();
    expect(variables.venueName).toBe(place.name);
    expect(variables.venueAddress).toBe(place.formattedAddress);
    expect(variables.directionsUrl).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=37.7793,-122.4193",
    );
    expect(variables.mapImageUrl).toBe(
      "https://tiles.example.com/styles/streets/static/-122.4193,37.7793,14/600x200.png",
    );
    expect(variables.directionsUrl).not.toContain("37.78,-122.4");
  });
});

// ── C1 / H2: who a withheld venue's address goes to ─────────────────────────

describe("sendTicketIssuedEmail — the venue's word, and an active holder", () => {
  /** Revealed on its own schedule an hour ago, stored as the projection. */
  const revealedProjection: EventRecord = {
    ...event,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    addressRevealPreset: "IMMEDIATELY",
    addressRevealAt: new Date(Date.now() - 60 * 60 * 1000),
    addressText: "SoMa",
    locality: "San Francisco",
    region: "CA",
    lat: 37.78,
    lng: -122.4,
  };

  function reposFor(
    theEvent: EventRecord,
    opts: { orderStatus?: string; holdsTicket?: boolean } = {},
  ) {
    const hasActiveTicketForEvent = vi
      .fn()
      .mockResolvedValue(opts.holdsTicket ?? true);
    const repos = {
      orders: {
        getById: vi
          .fn()
          .mockResolvedValue({ ...order, status: opts.orderStatus ?? order.status }),
      },
      humans: {
        getByIdWithIdentity: vi.fn().mockResolvedValue({ human, identity }),
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: { getById: vi.fn().mockResolvedValue(theEvent) },
      places: { getById: vi.fn().mockResolvedValue(withheldPlace) },
      tickets: {
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
        hasActiveTicketForEvent,
      },
    } as unknown as Repos;
    return { repos, hasActiveTicketForEvent };
  }

  async function variablesFor(repos: Repos) {
    const mailer: MailerPort = {
      send: vi
        .fn()
        .mockResolvedValue({ result: { success: true, id: "email_c1" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    };
    await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
        tileServerUrl: "https://tiles.example.com",
      },
    );
    return (mailer.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].template
      .variables;
  }

  function expectNoVenueTruth(variables: unknown) {
    const text = JSON.stringify(variables);
    expect(text).not.toContain("123 Test St");
    expect(text).not.toContain("Test Venue");
    expect(text).not.toContain("destination=");
  }

  it("C1: a stranger's UNCONFIRMED event at the withheld venue: label only, no map, no promised date", async () => {
    const { repos } = reposFor({ ...revealedProjection, orgId: "org-stranger" });
    const variables = await variablesFor(repos);
    expect(variables.venueName).toBe("San Francisco, CA");
    expect(variables.venueAddress).toBeUndefined();
    expect(variables.mapImageUrl).toBeUndefined();
    expect(variables.addressRevealAtISO).toBeUndefined();
    expectNoVenueTruth(variables);
  });

  it("C1: an ownerless community listing there: the same", async () => {
    const { repos } = reposFor({
      ...revealedProjection,
      orgId: null,
      stewardship: "COMMUNITY",
    });
    expectNoVenueTruth(await variablesFor(repos));
  });

  it("stamp arm: a confirmed stranger's IMMEDIATELY event promises startsAt − 24h, not now", async () => {
    const startsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const { repos } = reposFor({
      ...revealedProjection,
      orgId: "org-stranger",
      startsAt,
      venueConfirmedAt: new Date(Date.now() - 60 * 60 * 1000),
      venueConfirmationWithdrawnAt: null,
      venueConfirmedPlaceId: PLACE_ID,
    });
    const variables = await variablesFor(repos);
    expect(variables.addressRevealAtISO).toBe(
      new Date(startsAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    );
    expectNoVenueTruth(variables);
  });

  it("H2: a late send for a REFUNDED order carries no street — and skips the ticket read", async () => {
    const { repos, hasActiveTicketForEvent } = reposFor(revealedProjection, {
      orderStatus: "REFUNDED",
    });
    expectNoVenueTruth(await variablesFor(repos));
    expect(hasActiveTicketForEvent).not.toHaveBeenCalled();
  });

  it("H2: a buyer who no longer holds a ticket gets no street", async () => {
    const { repos, hasActiveTicketForEvent } = reposFor(revealedProjection, {
      holdsTicket: false,
    });
    expectNoVenueTruth(await variablesFor(repos));
    expect(hasActiveTicketForEvent).toHaveBeenCalledWith(EVENT_ID, HUMAN_ID);
  });

  it("the venue's own show, paid and held: the Place's street", async () => {
    const { repos } = reposFor(revealedProjection);
    const variables = await variablesFor(repos);
    expect(variables.venueAddress).toBe(place.formattedAddress);
  });
});

// Door sales (spec 2026-10-07 door-sales FR-011) branch on `paymentChannel`;
// an online order must be untouched by that branch.
describe("sendTicketIssuedEmail: an online order is not a door sale", () => {
  function reposFor(withIdentity: boolean) {
    return {
      orders: {
        getById: vi.fn().mockResolvedValue({ ...order, paymentChannel: "WEB" }),
        listTaxLines: vi.fn(),
      },
      humans: {
        getByIdWithIdentity: vi
          .fn()
          .mockResolvedValue(withIdentity ? { human, identity } : null),
        listAuthAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
      },
      events: {
        getById: vi.fn().mockResolvedValue(event),
        listTicketTypes: vi.fn(),
      },
      places: { getById: vi.fn().mockResolvedValue(place) },
      tickets: {
        hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
        listByOrderId: vi.fn().mockResolvedValue([ticket]),
      },
    } as unknown as Repos;
  }

  it("sends the ticket email only — no receipt, no extra reads", async () => {
    const mailer = {
      send: vi.fn().mockResolvedValue({ result: { success: true, id: "e" } }),
      sendBatch: vi.fn(),
      health: vi.fn(),
    } as unknown as MailerPort;
    const repos = reposFor(true);
    const out = await sendTicketIssuedEmail(
      { repos, mailer },
      {
        orderId: ORDER_ID,
        publicAppUrl: "http://localhost:3000",
        supportUrl: "https://ithasfire.com/help",
      },
    );
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(out.receiptSent).toBeUndefined();
    expect(out.skipped).toBeUndefined();
    expect(repos.orders.listTaxLines).not.toHaveBeenCalled();
  });

  it("a buyer with no identity still refuses (HUMAN_NOT_FOUND): only a door sale may have no recipient", async () => {
    const mailer = { send: vi.fn() } as unknown as MailerPort;
    await expect(
      sendTicketIssuedEmail(
        { repos: reposFor(false), mailer },
        {
          orderId: ORDER_ID,
          publicAppUrl: "http://localhost:3000",
          supportUrl: "https://ithasfire.com/help",
        },
      ),
    ).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
    expect(mailer.send).not.toHaveBeenCalled();
  });
});
