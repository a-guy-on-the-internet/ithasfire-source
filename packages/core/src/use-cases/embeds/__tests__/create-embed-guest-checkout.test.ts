import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createEmbedGuestCheckout,
  createEmbedGuestCheckoutOutputSchema,
} from "../create-embed-guest-checkout";
import { EMBED_GUEST_TICKET_WINDOW_MS } from "../confirm-embed-guest-payment";
import type { TicketRecord } from "@th/types";
import type { CreateEmbedGuestCheckoutDeps } from "../create-embed-guest-checkout";
import * as checkoutModule from "../../orders/create-checkout";
import { ensureEventAccessible } from "../../orders/checkout-helpers";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EmbedRecord } from "@th/types/repos/embeds";
import type { EventRecord } from "@th/ports/repos/events";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { CURRENT_BUYER_TERMS_VERSION } from "../../../lib/legal/buyer-terms";
import { createTestLogger } from "@th/test-utils/fakes/logger";

// ── Defaults ─────────────────────────────────────────────────────────────────

const EMBED_ID = "00000000-0000-4000-8000-000000000010";
const EVENT_ID = "00000000-0000-4000-8000-000000000011";
const ORG_ID = "00000000-0000-4000-8000-000000000012";
const HUMAN_ID = "00000000-0000-4000-8000-000000000013";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000014";

const GUEST_EMAIL = "guest@example.com";
const GUEST_NAME = "Guest Buyer";
/** Matches `activeEmbed.domain` below — the allowlisted embedding origin. */
const HOST_ORIGIN = "https://shop.example.com";

const activeEmbed: EmbedRecord = {
  id: EMBED_ID,
  subjectType: "organization",
  subjectId: ORG_ID,
  domain: "shop.example.com",
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: "someone",
  createdAt: new Date("2025-01-01"),
};

const publishedEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Cool Concert",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2025-06-01T20:00:00Z"),
  endsAt: new Date("2025-06-01T23:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  locality: null,
  region: null,
  countryCode: null,
  postalCode: null,
  shortId: null,
  slug: null,
  currency: "usd",
  heroImageUrl: null,
  content: null,
  payoutSchedule: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  feePolicyId: null,
  seriesId: null,
  nextOccurrenceId: null,
  timezone: null,
  cancelledAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
} as EventRecord;

/**
 * What the mocked `createCheckout` (1000¢, one GA ticket) persisted: the use
 * case reads the confirmation's lines back from the order after delegating.
 */
const MOCK_ORDER_ID = "00000000-0000-4000-8000-000000000099";
const GA_TICKET_TYPE = { id: TICKET_TYPE_ID, name: "General Admission" };
const persistedOrder = () => ({
  id: MOCK_ORDER_ID,
  eventId: EVENT_ID,
  buyerHumanId: HUMAN_ID,
  items: [
    {
      id: "item-1",
      kind: "ticket",
      ticketTypeId: TICKET_TYPE_ID,
      qty: 1,
      unitPriceCents: 1000,
      amountCents: 1000,
    },
  ],
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createEmbedGuestCheckout — shadow profile", () => {
  it("rejects false refund-policy acknowledgement before guest creation", async () => {
    const ensureGuestHuman = vi.fn();
    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: { ensureGuestHuman },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    };

    await expect(
      createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        eventId: EVENT_ID,
        hostOrigin: HOST_ORIGIN,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-refund",
        refundPolicyAccepted: false,
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      }),
    ).rejects.toMatchObject({ code: "REFUND_POLICY_REQUIRED" });

    expect(ensureGuestHuman).not.toHaveBeenCalled();
  });

  it("keeps bank debit out of the embed checkout", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        orderId: "00000000-0000-4000-8000-000000000099",
        clientSecret: "pi_secret",
        amountGrossCents: 1000,
        feesPlatformCents: 50,
        buyerFeesCents: 50,
        processorFeeCents: 59,
        taxAmountCents: 0,
        holdExpiresAt: null,
      });

    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: {
          ensureGuestHuman: vi.fn(async () => ({
            humanId: HUMAN_ID,
            created: true,
          })),
          update: vi.fn(async (id: string, u: any) => ({ id, ...u })),
        },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    };

    try {
      await createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        eventId: EVENT_ID,
        hostOrigin: HOST_ORIGIN,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-redirects",
        refundPolicyAccepted: true,
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      });

      expect(createCheckoutSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          // ACH was never ruled in for the embed, so bank debit is off.
          // Amazon Pay and Cash App are off in Stripe since 2026-10-13 and
          // the adapter no longer requests them (stripe-adapter.test.ts), so
          // the embed's PaymentIntent is card only.
          allowRedirectPaymentMethods: true,
          allowBankDebit: false,
          // Owner ruling 2026-10-03: a guest never spends account credit.
          applyPlatformCredit: false,
          // Namespaced away from the main checkout's replay keys.
          clientKey: "embed:guest-client-key-0000000-redirects",
          refundPolicyAccepted: true,
        }),
        // The embed binding rides the server-only third argument, beside
        // the receipt secret's hash (never the secret).
        {
          embedId: EMBED_ID,
          receiptSecretHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      );
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("delegates as the guest human with server-observed ip/ua and no client termsVersion", async () => {
    // The acceptance ledger rows are written by createCheckout keyed on
    // buyerHumanId (covered in create-checkout.test.ts); embed guest
    // checkout inherits them by delegating with the guest's humanId and the
    // transport-supplied requestIp / requestUserAgent. termsVersion is no
    // longer part of the contract — the stamp is server-authoritative.
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        orderId: "00000000-0000-4000-8000-000000000099",
        clientSecret: "pi_secret",
        amountGrossCents: 1000,
        feesPlatformCents: 50,
        buyerFeesCents: 50,
        processorFeeCents: 59,
        taxAmountCents: 0,
        creditAppliedCents: 0,
        holdExpiresAt: null,
      });

    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: {
          ensureGuestHuman: vi.fn(async () => ({
            humanId: HUMAN_ID,
            created: true,
          })),
          update: vi.fn(async (id: string, u: any) => ({ id, ...u })),
        },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    };

    try {
      await createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        eventId: EVENT_ID,
        hostOrigin: HOST_ORIGIN,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-ledgerrow",
        termsAccepted: true,
        refundPolicyAccepted: true,
        requestIp: "198.51.100.7",
        requestUserAgent: "embed-widget/2.0",
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      });

      expect(createCheckoutSpy).toHaveBeenCalledTimes(1);
      const delegatedInput = createCheckoutSpy.mock.calls[0]?.[1] as Record<
        string,
        unknown
      >;
      expect(delegatedInput).toMatchObject({
        actorHumanId: HUMAN_ID,
        buyerHumanId: HUMAN_ID,
        termsAccepted: true,
        refundPolicyAccepted: true,
        requestIp: "198.51.100.7",
        requestUserAgent: "embed-widget/2.0",
      });
      expect(delegatedInput).not.toHaveProperty("termsVersion");
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("forwards each seat's quoted price to createCheckout untouched (seat-price-overrides D-007)", async () => {
    const SEAT_ID = "00000000-0000-4000-8000-000000000021";
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockRejectedValue({ code: "conflict", message: "seat_price_changed" });
    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        humans: {
          ensureGuestHuman: vi.fn(async () => ({
            humanId: HUMAN_ID,
            created: true,
          })),
          update: vi.fn(async (id: string, u: any) => ({ id, ...u })),
        },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    };

    try {
      await expect(
        createEmbedGuestCheckout(deps, {
          embedId: EMBED_ID,
          eventId: EVENT_ID,
          hostOrigin: HOST_ORIGIN,
          guestName: GUEST_NAME,
          guestEmail: GUEST_EMAIL,
          clientKey: "guest-client-key-0000000-seatquote",
          termsAccepted: true,
          refundPolicyAccepted: true,
          items: [
            {
              ticketTypeId: TICKET_TYPE_ID,
              qty: 1,
              seatIds: [SEAT_ID],
              seatQuotes: [{ seatId: SEAT_ID, unitPriceCents: 3500 }],
            },
          ],
        }),
      ).rejects.toMatchObject({ message: "seat_price_changed" });

      const delegatedInput = createCheckoutSpy.mock.calls[0]?.[1] as {
        items: unknown[];
      };
      expect(delegatedInput.items).toEqual([
        {
          ticketTypeId: TICKET_TYPE_ID,
          qty: 1,
          seatIds: [SEAT_ID],
          seatQuotes: [{ seatId: SEAT_ID, unitPriceCents: 3500 }],
        },
      ]);
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("refuses a seat quote for a seat the embed item does not buy", async () => {
    const createCheckoutSpy = vi.spyOn(checkoutModule, "createCheckout");
    const deps = {
      repos: {} as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    } as CreateEmbedGuestCheckoutDeps;
    try {
      await expect(
        createEmbedGuestCheckout(deps, {
          embedId: EMBED_ID,
          eventId: EVENT_ID,
          hostOrigin: HOST_ORIGIN,
          guestName: GUEST_NAME,
          guestEmail: GUEST_EMAIL,
          clientKey: "guest-client-key-0000000-seatquote-bad",
          termsAccepted: true,
          refundPolicyAccepted: true,
          items: [
            {
              ticketTypeId: TICKET_TYPE_ID,
              qty: 1,
              seatIds: ["00000000-0000-4000-8000-000000000021"],
              seatQuotes: [
                {
                  seatId: "00000000-0000-4000-8000-000000000022",
                  unitPriceCents: 3500,
                },
              ],
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(createCheckoutSpy).not.toHaveBeenCalled();
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("rejects a client-supplied termsVersion (strict schema, server-authoritative stamp)", async () => {
    const ensureGuestHuman = vi.fn();
    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: { ensureGuestHuman },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    };

    await expect(
      createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        eventId: EVENT_ID,
        hostOrigin: HOST_ORIGIN,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-strict01",
        termsAccepted: true,
        // Even the correct current version is rejected — the stamp is
        // server-authoritative, never client input.
        termsVersion: CURRENT_BUYER_TERMS_VERSION,
        refundPolicyAccepted: true,
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(ensureGuestHuman).not.toHaveBeenCalled();
  });

  it("calls ensureGuestHuman with the email only and names the NEW guest (new guest)", async () => {
    const ensureGuestHuman = vi.fn(async () => ({
      humanId: HUMAN_ID,
      created: true,
    }));
    const update = vi.fn(async (id: string, u: any) => ({ id, ...u }));

    // We expect the use case to call ensureGuestHuman, then delegate to
    // createCheckout. We'll let createCheckout throw since we only want
    // to verify the shadow profile creation path.
    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: { ensureGuestHuman, update },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    };

    const input = {
      embedId: EMBED_ID,
      eventId: EVENT_ID,
      hostOrigin: HOST_ORIGIN,
      guestName: GUEST_NAME,
      guestEmail: GUEST_EMAIL,
      clientKey: "guest-client-key-0000000-12345678",
      refundPolicyAccepted: true,
      items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
    };

    // createCheckout will fail because we haven't mocked everything it
    // needs, but ensureGuestHuman should have been called by then.
    try {
      await createEmbedGuestCheckout(deps, input);
    } catch {
      // expected — downstream createCheckout deps not fully mocked
    }

    expect(ensureGuestHuman).toHaveBeenCalledOnce();
    expect(ensureGuestHuman).toHaveBeenCalledWith({ email: GUEST_EMAIL });
    expect(update).toHaveBeenCalledWith(HUMAN_ID, { name: GUEST_NAME });
  });

  it("reuses existing human when ensureGuestHuman returns created: false", async () => {
    const EXISTING_HUMAN_ID = "00000000-0000-4000-8000-000000000099";
    const ensureGuestHuman = vi.fn(async () => ({
      humanId: EXISTING_HUMAN_ID,
      created: false,
    }));
    const update = vi.fn();

    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: { ensureGuestHuman, update },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    };

    const input = {
      embedId: EMBED_ID,
      eventId: EVENT_ID,
      hostOrigin: HOST_ORIGIN,
      guestName: GUEST_NAME,
      guestEmail: GUEST_EMAIL,
      clientKey: "guest-client-key-0000000-87654321",
      refundPolicyAccepted: true,
      items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
    };

    try {
      await createEmbedGuestCheckout(deps, input);
    } catch {
      // expected — downstream createCheckout deps not fully mocked
    }

    expect(ensureGuestHuman).toHaveBeenCalledOnce();
    expect(ensureGuestHuman).toHaveBeenCalledWith({ email: GUEST_EMAIL });
    // An unauthenticated buyer's typed name never renames an existing account.
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects when embed is not found", async () => {
    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => null) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: { ensureGuestHuman: vi.fn() },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    };

    const input = {
      embedId: EMBED_ID,
      eventId: EVENT_ID,
      hostOrigin: HOST_ORIGIN,
      guestName: GUEST_NAME,
      guestEmail: GUEST_EMAIL,
      clientKey: "guest-client-key-0000000-00000000",
      refundPolicyAccepted: true,
      items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
    };

    await expect(createEmbedGuestCheckout(deps, input)).rejects.toMatchObject({ code: "EMBED_NOT_FOUND" });
  });

  it("rejects a mismatched host origin BEFORE turnstile and guest creation", async () => {
    const ensureGuestHuman = vi.fn();
    const turnstileVerify = vi.fn(async () => true);
    const createCheckoutSpy = vi.spyOn(checkoutModule, "createCheckout");

    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: { ensureGuestHuman },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
      turnstile: { enabled: true, verify: turnstileVerify },
      logger: createTestLogger(),
    };

    try {
      await expect(
        createEmbedGuestCheckout(deps, {
          embedId: EMBED_ID,
          eventId: EVENT_ID,
          hostOrigin: "https://attacker.example.net",
          guestName: GUEST_NAME,
          guestEmail: GUEST_EMAIL,
          clientKey: "guest-client-key-0000000-badorigin",
          turnstileToken: "tok-should-not-be-verified",
          refundPolicyAccepted: true,
          items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
        }),
      ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });

      // Ordering matters: the origin gate must fire before ANY side-effectful
      // work — no Turnstile round-trip, no shadow guest account, no Stripe.
      expect(turnstileVerify).not.toHaveBeenCalled();
      expect(ensureGuestHuman).not.toHaveBeenCalled();
      expect(createCheckoutSpy).not.toHaveBeenCalled();
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("rejects a null host origin (fail closed)", async () => {
    const ensureGuestHuman = vi.fn();
    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: { ensureGuestHuman },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    };

    await expect(
      createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        eventId: EVENT_ID,
        hostOrigin: null,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-nullorigin",
        refundPolicyAccepted: true,
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });

    expect(ensureGuestHuman).not.toHaveBeenCalled();
  });

  it("passes the server-observed request IP to turnstile.verify", async () => {
    const turnstileVerify = vi.fn(async () => true);
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        orderId: "00000000-0000-4000-8000-000000000099",
        clientSecret: "pi_secret",
        amountGrossCents: 1000,
        feesPlatformCents: 50,
        buyerFeesCents: 50,
        processorFeeCents: 59,
        taxAmountCents: 0,
        holdExpiresAt: null,
      });

    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: {
          ensureGuestHuman: vi.fn(async () => ({
            humanId: HUMAN_ID,
            created: true,
          })),
          update: vi.fn(async (id: string, u: any) => ({ id, ...u })),
        },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
      turnstile: { enabled: true, verify: turnstileVerify },
    };

    try {
      await createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        eventId: EVENT_ID,
        hostOrigin: HOST_ORIGIN,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-turnstile-ip",
        turnstileToken: "tok-123",
        refundPolicyAccepted: true,
        requestIp: "203.0.113.9",
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      });

      expect(turnstileVerify).toHaveBeenCalledTimes(1);
      expect(turnstileVerify).toHaveBeenCalledWith("tok-123", "203.0.113.9");
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("rejects when event does not belong to embed organization", async () => {
    const wrongOrgEvent = { ...publishedEvent, orgId: "other-org-id" };

    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: { getById: vi.fn(async () => wrongOrgEvent) },
        humans: { ensureGuestHuman: vi.fn() },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
    };

    const input = {
      embedId: EMBED_ID,
      eventId: EVENT_ID,
      hostOrigin: HOST_ORIGIN,
      guestName: GUEST_NAME,
      guestEmail: GUEST_EMAIL,
      clientKey: "guest-client-key-0000000-99999999",
      refundPolicyAccepted: true,
      items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
    };

    await expect(createEmbedGuestCheckout(deps, input)).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});

describe("createEmbedGuestCheckout — linkOut embeds", () => {
  it("rejects a linkOut embed BEFORE turnstile and guest creation", async () => {
    // The widget renders only link-out CTAs for linkOut embeds (EmbedEventGrid /
    // EmbedEventDetail / EmbedCalendarBrowse all route to the canonical page),
    // so a checkout call for one can only be a hand-crafted request — refuse it
    // server-side rather than honoring the flag client-side only.
    const ensureGuestHuman = vi.fn();
    const turnstileVerify = vi.fn(async () => true);
    const createCheckoutSpy = vi.spyOn(checkoutModule, "createCheckout");

    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: {
          getById: vi.fn(async () => ({ ...activeEmbed, linkOut: true })),
        },
        events: {
          getById: vi.fn(async () => publishedEvent),
          listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
        },
        orders: { getById: vi.fn(async () => persistedOrder()) },
        humans: { ensureGuestHuman },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
      turnstile: { enabled: true, verify: turnstileVerify },
      logger: createTestLogger(),
    };

    try {
      await expect(
        createEmbedGuestCheckout(deps, {
          embedId: EMBED_ID,
          eventId: EVENT_ID,
          hostOrigin: HOST_ORIGIN,
          guestName: GUEST_NAME,
          guestEmail: GUEST_EMAIL,
          clientKey: "guest-client-key-0000000-linkout",
          turnstileToken: "tok-should-not-be-verified",
          refundPolicyAccepted: true,
          items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
        }),
      ).rejects.toMatchObject({ code: "EMBED_LINK_OUT_ONLY" });

      expect(turnstileVerify).not.toHaveBeenCalled();
      expect(ensureGuestHuman).not.toHaveBeenCalled();
      expect(createCheckoutSpy).not.toHaveBeenCalled();
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });
});

describe("createEmbedGuestCheckout — lineItems from the persisted order", () => {
  const VIP_TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000015";
  const ticket = (id: string, ticketTypeId: string, unitPriceCents: number) => ({
    id,
    kind: "ticket",
    ticketTypeId,
    qty: 1,
    unitPriceCents,
    amountCents: unitPriceCents,
  });

  const run = async (
    order: unknown,
    amountGrossCents: number,
    opts: {
      clientSecret?: string | null;
      reportError?: CreateEmbedGuestCheckoutDeps["reportError"];
      logger?: CreateEmbedGuestCheckoutDeps["logger"];
    } = {},
  ) => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        orderId: MOCK_ORDER_ID,
        clientSecret:
          opts.clientSecret === undefined
            ? "pi_secret" // gitleaks:allow (fake test fixture)
            : opts.clientSecret,
        amountGrossCents,
        feesPlatformCents: 0,
        buyerFeesCents: 0,
        processorFeeCents: 0,
        feeMode: "PASS_THROUGH",
        taxAmountCents: 0,
        creditAppliedCents: 0,
        holdExpiresAt: null,
      });
    const deps: CreateEmbedGuestCheckoutDeps = {
      repos: {
        embeds: { getById: vi.fn(async () => activeEmbed) },
        events: {
          getById: vi.fn(async () => publishedEvent),
          // Event order: GA first, then VIP.
          listTicketTypes: vi.fn(async () => [
            GA_TICKET_TYPE,
            { id: VIP_TICKET_TYPE_ID, name: "VIP" },
          ]),
        },
        orders: { getById: vi.fn(async () => order) },
        humans: {
          ensureGuestHuman: vi.fn(async () => ({
            humanId: HUMAN_ID,
            created: false,
          })),
        },
      } as unknown as Repos,
      payments: {} as any,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => new Date("2025-06-01T18:00:00Z") },
      ...(opts.reportError ? { reportError: opts.reportError } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    };
    try {
      return await createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        eventId: EVENT_ID,
        hostOrigin: HOST_ORIGIN,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-lines",
        refundPolicyAccepted: true,
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      });
    } finally {
      createCheckoutSpy.mockRestore();
    }
  };

  it("groups per ticket type, in the event's ticket-type order, and ignores discount/credit items", async () => {
    const result = await run(
      {
        id: MOCK_ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: HUMAN_ID,
        // Persisted order is unordered; VIP items come first here.
        items: [
          ticket("i1", VIP_TICKET_TYPE_ID, 5000),
          ticket("i2", TICKET_TYPE_ID, 1000),
          ticket("i3", VIP_TICKET_TYPE_ID, 5000),
          ticket("i4", TICKET_TYPE_ID, 1000),
          ticket("i5", TICKET_TYPE_ID, 1000),
          { id: "d1", kind: "discount", ticketTypeId: null, qty: 1, unitPriceCents: -700, amountCents: -700 },
          { id: "c1", kind: "platform_credit", ticketTypeId: null, qty: 1, unitPriceCents: -300, amountCents: -300 },
        ],
      },
      // 3 × 1000 + 2 × 5000 − 700 discount. Credit does not touch the gross.
      12_300,
    );

    expect(result.lineItems).toEqual([
      { ticketTypeId: TICKET_TYPE_ID, name: "General Admission", qty: 3, unitPriceCents: 1000, lineCents: 3000 },
      { ticketTypeId: VIP_TICKET_TYPE_ID, name: "VIP", qty: 2, unitPriceCents: 5000, lineCents: 10_000 },
    ]);
    const linesCents = result.lineItems.reduce((s, l) => s + l.lineCents, 0);
    expect(linesCents - result.amountGrossCents).toBe(700);
  });

  it("refuses (INTERNAL) an order that is not this guest's", async () => {
    await expect(
      run({ ...persistedOrder(), buyerHumanId: "00000000-0000-4000-8000-0000000000aa" }, 1000),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("refuses (INTERNAL) when the order cannot be read back", async () => {
    await expect(run(null, 1000)).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("refuses (INTERNAL) a ticket item whose type the event does not list", async () => {
    await expect(
      run(
        {
          ...persistedOrder(),
          items: [ticket("i1", "00000000-0000-4000-8000-0000000000bb", 1000)],
        },
        1000,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("groups by ticket type AND unit price: two PWYW tickets of one tier at different amounts are two lines", async () => {
    const result = await run(
      {
        ...persistedOrder(),
        items: [
          ticket("i1", TICKET_TYPE_ID, 2500),
          ticket("i2", TICKET_TYPE_ID, 1000),
        ],
      },
      3500,
    );
    expect(result.lineItems).toEqual([
      { ticketTypeId: TICKET_TYPE_ID, name: "General Admission", qty: 1, unitPriceCents: 1000, lineCents: 1000 },
      { ticketTypeId: TICKET_TYPE_ID, name: "General Admission", qty: 1, unitPriceCents: 2500, lineCents: 2500 },
    ]);
  });

  describe("a failed read-back (ReporterPort convention)", () => {
    const loggerWithSpy = () => {
      const logger = createTestLogger();
      vi.mocked(logger.child).mockReturnValue(logger);
      return logger;
    };

    it("with a PaymentIntent (nothing charged yet): throws, and reports nothing", async () => {
      const reportError = vi.fn();
      await expect(
        run(null, 1000, { reportError }),
      ).rejects.toMatchObject({ code: "INTERNAL" });
      expect(reportError).not.toHaveBeenCalled();
    });

    it("regression: an order completed without a PaymentIntent (a free claim) degrades to no lines and reports — never an error for a finished purchase", async () => {
      const reportError = vi.fn();
      const logger = loggerWithSpy();
      const result = await run(null, 0, {
        clientSecret: null,
        reportError,
        logger,
      });

      expect(result.orderId).toBe(MOCK_ORDER_ID);
      expect(result.lineItems).toEqual([]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "INTERNAL" }),
        {
          tags: {
            useCase: "createEmbedGuestCheckout",
            stage: "readOrderLineItems",
          },
          extra: { orderId: MOCK_ORDER_ID, eventId: EVENT_ID },
        },
      );
      // The log line stays alongside the report.
      expect(logger.error).toHaveBeenCalledWith(
        "createEmbedGuestCheckout.lineItemsReadFailed",
        expect.objectContaining({ orderId: MOCK_ORDER_ID }),
      );
    });

    it("an inconsistent completed order (items do not reproduce the gross) also degrades and reports", async () => {
      const reportError = vi.fn();
      const result = await run(persistedOrder(), 900, {
        clientSecret: null,
        reportError,
      });
      expect(result.lineItems).toEqual([]);
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("a throwing reporter never breaks the degraded result", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const result = await run(null, 0, { clientSecret: null, reportError });
      expect(result.lineItems).toEqual([]);
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError on the success path", async () => {
      const reportError = vi.fn();
      const result = await run(persistedOrder(), 1000, {
        clientSecret: null,
        reportError,
      });
      expect(result.lineItems).toHaveLength(1);
      expect(reportError).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guest release (owner ruling 2026-10-11): the order is bound to its embed, and
// the idempotency key that can replay its client secret is not guessable.
// ─────────────────────────────────────────────────────────────────────────────

const bindingDeps = (): CreateEmbedGuestCheckoutDeps => ({
  repos: {
    embeds: { getById: vi.fn(async () => activeEmbed) },
    events: {
      getById: vi.fn(async () => publishedEvent),
      listTicketTypes: vi.fn(async () => [GA_TICKET_TYPE]),
    },
    orders: { getById: vi.fn(async () => persistedOrder()) },
    humans: {
      ensureGuestHuman: vi.fn(async () => ({ humanId: HUMAN_ID, created: true })),
      update: vi.fn(async (id: string, u: any) => ({ id, ...u })),
    },
  } as unknown as Repos,
  payments: {} as any,
  idempotency: createFakeIdempotencyPort(),
  clock: { now: () => new Date("2025-06-01T18:00:00Z") },
});

const bindingInput = (over: Record<string, unknown> = {}) => ({
  embedId: EMBED_ID,
  eventId: EVENT_ID,
  hostOrigin: HOST_ORIGIN,
  guestName: GUEST_NAME,
  guestEmail: GUEST_EMAIL,
  // The widget's key before the UUID build: `emb_<13-digit ms>_<8 base36>`.
  clientKey: "emb_1760184000000_k3j9x0ab",
  refundPolicyAccepted: true,
  items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
  ...over,
});

const mockedCheckoutResult = {
  orderId: MOCK_ORDER_ID,
  clientSecret: "pi_secret", // gitleaks:allow (fake test fixture)
  amountGrossCents: 1000,
  feesPlatformCents: 50,
  buyerFeesCents: 50,
  processorFeeCents: 59,
  feeMode: "PASS_THROUGH" as const,
  taxAmountCents: 0,
  creditAppliedCents: 0,
  holdExpiresAt: null,
};

describe("createEmbedGuestCheckout — the order is bound to its embed", () => {
  it("hands createCheckout the embed's id as the server-only third argument, which createCheckout writes to the PaymentIntent's metadata", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue(mockedCheckoutResult);

    try {
      const out = await createEmbedGuestCheckout(bindingDeps(), bindingInput());

      expect(createCheckoutSpy).toHaveBeenCalledTimes(1);
      const [, delegatedInput, serverContext] =
        createCheckoutSpy.mock.calls[0]!;
      // `applyCheckoutServerContextToMetadata` (orders/__tests__/
      // checkout-server-context.test.ts) turns this into `metadata.embedId`
      // and `metadata.receiptSecretHash`.
      expect(serverContext).toEqual({
        embedId: EMBED_ID,
        receiptSecretHash: createHash("sha256")
          .update(out.receiptSecret!)
          .digest("hex"),
      });
      // Never as an input field: the input is what transports build from a
      // client's body, and the binding must not be able to arrive that way.
      expect(delegatedInput).not.toHaveProperty("embedId");
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("an extra field in the guest's request cannot name another embed: the schema refuses it before any read", async () => {
    const createCheckoutSpy = vi.spyOn(checkoutModule, "createCheckout");
    const deps = bindingDeps();

    try {
      await expect(
        createEmbedGuestCheckout(
          deps,
          bindingInput({
            serverContext: {
              embedId: "00000000-0000-4000-8000-0000000000ff",
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(deps.repos.embeds.getById).not.toHaveBeenCalled();
      expect(createCheckoutSpy).not.toHaveBeenCalled();
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });
});

// Owner ruling 2026-10-12: codes show only in the tab that started the
// payment. The receipt secret is that tab's proof; the PaymentIntent keeps
// only its hash.
describe("createEmbedGuestCheckout — the receipt secret", () => {
  it("a paid order: returns a fresh 256-bit base64url secret and hands createCheckout only its SHA-256", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue(mockedCheckoutResult);

    try {
      const out = await createEmbedGuestCheckout(bindingDeps(), bindingInput());

      expect(out.receiptSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [, delegatedInput, serverContext] =
        createCheckoutSpy.mock.calls[0]!;
      expect(serverContext?.receiptSecretHash).toBe(
        createHash("sha256").update(out.receiptSecret!).digest("hex"),
      );
      // The secret itself goes nowhere but the answer.
      expect(JSON.stringify([delegatedInput, serverContext])).not.toContain(
        out.receiptSecret!,
      );
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("every call makes its own secret", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue(mockedCheckoutResult);

    try {
      const a = await createEmbedGuestCheckout(bindingDeps(), bindingInput());
      const b = await createEmbedGuestCheckout(bindingDeps(), bindingInput());

      expect(a.receiptSecret).not.toBe(b.receiptSecret);
      expect(createCheckoutSpy.mock.calls[0]![2]?.receiptSecretHash).not.toBe(
        createCheckoutSpy.mock.calls[1]![2]?.receiptSecretHash,
      );
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("a free order (no PaymentIntent) answers receiptSecret null", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({ ...mockedCheckoutResult, clientSecret: null });

    try {
      const out = await createEmbedGuestCheckout(bindingDeps(), bindingInput());

      expect(out.receiptSecret).toBeNull();
      expect(out.clientSecret).toBeNull();
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("the secret reaches no logger call", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue(mockedCheckoutResult);
    const calls: unknown[] = [];
    const recording = (): NonNullable<CreateEmbedGuestCheckoutDeps["logger"]> => {
      const record =
        (level: string) =>
        (...args: unknown[]) => {
          calls.push([level, ...args]);
        };
      return {
        child: (...args: unknown[]) => {
          calls.push(["child", ...args]);
          return recording();
        },
        withTime: async (name: string, fn: () => Promise<unknown>) => {
          calls.push(["withTime", name]);
          return fn();
        },
        log: record("log"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
      } as unknown as NonNullable<CreateEmbedGuestCheckoutDeps["logger"]>;
    };

    try {
      const out = await createEmbedGuestCheckout(
        { ...bindingDeps(), logger: recording() },
        bindingInput(),
      );

      expect(calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(calls)).not.toContain(out.receiptSecret!);
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });
});

describe("createEmbedGuestCheckout — client key floor", () => {
  it.each([
    ["8 characters (the old minimum)", "abcd1234"],
    ["18 characters (the widget's prefix and timestamp with no tail)", "emb_1760184000000_"],
  ])("refuses a key of %s before any read", async (_label, clientKey) => {
    expect(clientKey.length).toBeLessThan(19);
    const createCheckoutSpy = vi.spyOn(checkoutModule, "createCheckout");
    const deps = bindingDeps();

    try {
      await expect(
        createEmbedGuestCheckout(deps, bindingInput({ clientKey })),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(deps.repos.embeds.getById).not.toHaveBeenCalled();
      expect(createCheckoutSpy).not.toHaveBeenCalled();
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it.each([
    [
      "the widget's pre-UUID key (26 characters), still sent by tabs loaded before the deploy",
      "emb_1760184000000_k3j9x0ab",
    ],
    [
      // `Math.random().toString(36).slice(2, 10)` prints the shortest form
      // of the number, so the tail can be shorter than 8 characters.
      "the same format with a one-character tail (19 characters, the shortest the shipped widget can send)",
      "emb_1760184000000_k",
    ],
    [
      "the same format with a five-character tail",
      "emb_1760184000000_k3j9x",
    ],
    [
      "a crypto.randomUUID() key (36 characters)",
      "3f2b8c1e-7a4d-4e9b-9c1f-2d6a5b8e7f10",
    ],
  ])("accepts %s", async (_label, clientKey) => {
    expect(clientKey.length).toBeGreaterThanOrEqual(19);
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue(mockedCheckoutResult);

    try {
      await createEmbedGuestCheckout(bindingDeps(), bindingInput({ clientKey }));

      expect(createCheckoutSpy.mock.calls[0]![1]).toMatchObject({
        clientKey: `embed:${clientKey}`,
      });
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ticket codes on the answer (owner, 2026-10-12). Only an order this call
// COMPLETED (a free claim: no PaymentIntent, tickets minted in the claim's
// transaction) carries them; a paid order's codes come from
// `confirmGuestPayment`, after the client secret is proven. The real free path
// (claimFreeTickets minting before this returns) is driven in
// orders/__tests__/create-checkout.test.ts, "a 100%-off promo".
// ─────────────────────────────────────────────────────────────────────────────

describe("createEmbedGuestCheckout — a completed (free) order's ticket codes", () => {
  const CLOCK_NOW = new Date("2025-06-01T18:00:00Z");
  const UUID_KEY = "3f2b8c1e-7a4d-4e9b-9c1f-2d6a5b8e7f10";
  const ISSUED_AT = new Date(CLOCK_NOW.getTime() - 1000);

  const ticketRow = (n: number, over: Partial<TicketRecord> = {}): TicketRecord => ({
    id: `00000000-0000-4000-8000-00000000010${n}`,
    eventId: EVENT_ID,
    ticketTypeId: TICKET_TYPE_ID,
    ownerHumanId: HUMAN_ID,
    orderId: MOCK_ORDER_ID,
    orderItemId: `00000000-0000-4000-8000-00000000020${n}`,
    seatId: null,
    code: `tk_freefixture${n}`,
    status: "VALID",
    issuedAt: ISSUED_AT,
    scannedAt: null,
    ...over,
  });

  const run = async (opts: {
    clientSecret: string | null;
    orderStatus?: string;
    tickets?: TicketRecord[];
    ticketsError?: unknown;
    reportError?: CreateEmbedGuestCheckoutDeps["reportError"];
    now?: Date;
    /** Default: a `crypto.randomUUID()` key, the current widget's. */
    clientKey?: string;
  }) => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        ...mockedCheckoutResult,
        clientSecret: opts.clientSecret,
        amountGrossCents: 1000,
      });
    const listByOrderId = vi.fn(async (orderId: string) => {
      if (opts.ticketsError !== undefined) throw opts.ticketsError;
      return (opts.tickets ?? []).filter((t) => t.orderId === orderId);
    });
    const logger = createTestLogger();
    vi.mocked(logger.child).mockReturnValue(logger);
    const deps: CreateEmbedGuestCheckoutDeps = {
      ...bindingDeps(),
      repos: {
        ...bindingDeps().repos,
        orders: {
          getById: vi.fn(async () => ({
            ...persistedOrder(),
            status: opts.orderStatus ?? "SUCCEEDED",
          })),
        },
        tickets: { listByOrderId },
        seats: { findLabelsByIds: vi.fn(async () => []) },
      } as unknown as Repos,
      clock: { now: () => opts.now ?? CLOCK_NOW },
      logger,
      ...(opts.reportError ? { reportError: opts.reportError } : {}),
    };
    try {
      const result = await createEmbedGuestCheckout(
        deps,
        bindingInput({ clientKey: opts.clientKey ?? UUID_KEY }),
      );
      return { result, listByOrderId, logger };
    } finally {
      createCheckoutSpy.mockRestore();
    }
  };

  it("a free claim (no PaymentIntent) answers with its tickets' codes, and the answer fits the output schema", async () => {
    const { result } = await run({
      clientSecret: null,
      tickets: [ticketRow(1), ticketRow(2)],
    });

    expect(result.tickets).toEqual([
      { code: "tk_freefixture1", ticketTypeName: "General Admission", seatLabel: null },
      { code: "tk_freefixture2", ticketTypeName: "General Admission", seatLabel: null },
    ]);
    expect(createEmbedGuestCheckoutOutputSchema.parse(result)).toMatchObject({
      tickets: result.tickets,
    });
  });

  it.each([
    ["the older widget's emb_<ms>_<base36> key", "emb_1760184000000_k3j9x0ab"],
    ["a 36-character key that is not a v4 UUID", "3f2b8c1e-7a4d-1e9b-9c1f-2d6a5b8e7f10"],
    ["a long non-UUID key", "guest-client-key-0000000-lines-and-more"],
  ])("a free claim with %s is a valid checkout, but carries NO codes and reads no ticket", async (_label, clientKey) => {
    const { result, listByOrderId } = await run({
      clientSecret: null,
      tickets: [ticketRow(1)],
      clientKey,
    });

    expect(result.orderId).toBe(MOCK_ORDER_ID);
    expect(result.lineItems).toHaveLength(1);
    expect(result.tickets).toEqual([]);
    expect(listByOrderId).not.toHaveBeenCalled();
  });

  it("an uppercase v4 UUID key is still a UUID: codes come back", async () => {
    const { result } = await run({
      clientSecret: null,
      tickets: [ticketRow(1)],
      clientKey: UUID_KEY.toUpperCase(),
    });
    expect(result.tickets).toHaveLength(1);
  });

  it("an order with a PaymentIntent NEVER carries a code here, and no ticket is read: whatever the rows say", async () => {
    // Rows that would pass every rule, on an order that claims SUCCEEDED.
    const { result, listByOrderId } = await run({
      clientSecret: "pi_secret", // gitleaks:allow (fake test fixture)
      orderStatus: "SUCCEEDED",
      tickets: [ticketRow(1)],
    });

    expect(result.tickets).toEqual([]);
    expect(listByOrderId).not.toHaveBeenCalled();
  });

  it("the same rules as the guest confirm: a transferred ticket is left out, and a replay after the window gets none", async () => {
    const mine = ticketRow(1);
    const givenAway = ticketRow(2, {
      ownerHumanId: "00000000-0000-4000-8000-0000000000aa",
    });

    const fresh = await run({ clientSecret: null, tickets: [mine, givenAway] });
    expect(fresh.result.tickets.map((t) => t.code)).toEqual([mine.code]);

    // An idempotent replay of the `clientKey` long after the claim.
    const late = await run({
      clientSecret: null,
      tickets: [mine],
      now: new Date(ISSUED_AT.getTime() + EMBED_GUEST_TICKET_WINDOW_MS + 1),
    });
    expect(late.result.tickets).toEqual([]);
  });

  it("an order that is no longer an active holder's (refunded since) gets none", async () => {
    const { result } = await run({
      clientSecret: null,
      orderStatus: "REFUNDED",
      tickets: [ticketRow(1)],
    });
    expect(result.tickets).toEqual([]);
  });

  it("regression: a failed ticket read never fails a finished claim → no tickets, reported once, log line kept, no code anywhere", async () => {
    const dbDown = new Error("connection terminated");
    const reportError = vi.fn();
    const { result, logger } = await run({
      clientSecret: null,
      ticketsError: dbDown,
      reportError,
    });

    expect(result.orderId).toBe(MOCK_ORDER_ID);
    expect(result.lineItems).toHaveLength(1);
    expect(result.tickets).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(dbDown, {
      tags: {
        useCase: "createEmbedGuestCheckout",
        stage: "readEmbedGuestTickets",
      },
      extra: { orderId: MOCK_ORDER_ID },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "createEmbedGuestCheckout.ticketsReadFailed",
      { orderId: MOCK_ORDER_ID, err: dbDown },
    );
  });

  it("a throwing reporter changes nothing", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down too");
    });
    const { result } = await run({
      clientSecret: null,
      ticketsError: new Error("connection terminated"),
      reportError,
    });
    expect(result.tickets).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("the success log line carries the count, never a code", async () => {
    const { logger } = await run({
      clientSecret: null,
      tickets: [ticketRow(1)],
    });

    expect(logger.info).toHaveBeenCalledWith(
      "createEmbedGuestCheckout.succeeded",
      expect.objectContaining({ ticketCount: 1 }),
    );
    const logged = JSON.stringify([
      vi.mocked(logger.info).mock.calls,
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.error).mock.calls,
    ]);
    expect(logged).not.toContain("tk_");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gated events (owner ruling 2026-10-12): the widget never sells a PASSWORD or
// APPLICATION event. The buyer is named by a TYPED email, so the unlock check
// inside createCheckout cannot stand in for this: it would pass for anyone who
// types an approved person's address.
// ─────────────────────────────────────────────────────────────────────────────

describe("createEmbedGuestCheckout — gated events are never sold through the widget", () => {
  const gatedDeps = (gateType: "PASSWORD" | "APPLICATION") => {
    const deps = bindingDeps();
    vi.mocked(deps.repos.events.getById).mockResolvedValue({
      ...publishedEvent,
      gateType,
    });
    return deps;
  };

  it.each(["PASSWORD", "APPLICATION"] as const)(
    "a %s event is refused with EVENT_GATED before a guest, an order or a payment exists",
    async (gateType) => {
      const createCheckoutSpy = vi
        .spyOn(checkoutModule, "createCheckout")
        .mockResolvedValue(mockedCheckoutResult);
      const deps = gatedDeps(gateType);

      try {
        await expect(
          createEmbedGuestCheckout(deps, bindingInput()),
        ).rejects.toMatchObject({ code: "EVENT_GATED" });

        expect(deps.repos.humans.ensureGuestHuman).not.toHaveBeenCalled();
        expect(createCheckoutSpy).not.toHaveBeenCalled();
        expect(deps.repos.orders.getById).not.toHaveBeenCalled();
      } finally {
        createCheckoutSpy.mockRestore();
      }
    },
  );

  it("an APPLICATION event is refused even when the typed email's human holds an EventUnlock", async () => {
    // The approved person's unlock exists, and createCheckout's own gate check
    // (the REAL ensureEventAccessible) would let their typed email through.
    const isUnlocked = vi.fn(
      async (_eventId: string, humanId: string) => humanId === HUMAN_ID,
    );
    const gatedEvent: EventRecord = { ...publishedEvent, gateType: "APPLICATION" };
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockImplementation(async (_deps, rawInput) => {
        const buyerHumanId = (rawInput as { buyerHumanId?: string })
          .buyerHumanId;
        await ensureEventAccessible(
          { eventUnlocks: { isUnlocked } } as unknown as TxRepos,
          gatedEvent,
          buyerHumanId ?? HUMAN_ID,
        );
        return mockedCheckoutResult;
      });
    const deps = gatedDeps("APPLICATION");

    try {
      await expect(
        createEmbedGuestCheckout(deps, bindingInput()),
      ).rejects.toMatchObject({ code: "EVENT_GATED" });

      // Refused before the email was resolved to anyone, so no unlock was
      // consulted, no order was created, and Stripe was never reached.
      expect(deps.repos.humans.ensureGuestHuman).not.toHaveBeenCalled();
      expect(isUnlocked).not.toHaveBeenCalled();
      expect(createCheckoutSpy).not.toHaveBeenCalled();
      expect(deps.repos.orders.getById).not.toHaveBeenCalled();
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });
});
