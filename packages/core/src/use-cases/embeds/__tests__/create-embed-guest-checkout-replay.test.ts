import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { EmbedRecord } from "@th/types/repos/embeds";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import * as checkoutModule from "../../orders/create-checkout";
import { applyCheckoutServerContextToMetadata } from "../../orders/_shared/checkout-server-context";
import { guestReceiptSecretMatches } from "../_shared/guest-client-secret";
import {
  createEmbedGuestCheckout,
  type CreateEmbedGuestCheckoutDeps,
} from "../create-embed-guest-checkout";

/**
 * An ACCEPTED degradation (review, 2026-10-12): a create sent again under the
 * same `clientKey` is answered from `createCheckout`'s replay record, so no
 * second PaymentIntent is made and the metadata keeps the FIRST secret's
 * hash, but `createEmbedGuestCheckout` makes a fresh secret for every call.
 * The replay's secret therefore earns no codes from `confirmGuestPayment`;
 * the buyer gets them by email.
 *
 * The second call runs the REAL `createCheckout`, against an in-memory
 * idempotency store. Its replay branch returns before any repo or processor
 * call, so it needs no checkout fakes. The FIRST call stands in for a
 * completed checkout: wiring the whole paid path (tx, holds, pricing, tax,
 * payee) is the job of the create-checkout suites. It writes the
 * PaymentIntent metadata with the real `applyCheckoutServerContextToMetadata`
 * and commits the replay record under the key and payload hash
 * `createCheckout` reads. If either drifted, the real second call would
 * refuse (IDEMPOTENCY_KEY_CONFLICT) or fall through to repos it does not
 * have, and this test would fail.
 */

const EMBED_ID = "00000000-0000-4000-8000-000000000010";
const EVENT_ID = "00000000-0000-4000-8000-000000000011";
const ORG_ID = "00000000-0000-4000-8000-000000000012";
const HUMAN_ID = "00000000-0000-4000-8000-000000000013";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000014";
const ORDER_ID = "00000000-0000-4000-8000-000000000099";
const CLIENT_KEY = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

const embed = {
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
} as EmbedRecord;

const event = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Cool Concert",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  startsAt: new Date("2025-06-01T20:00:00Z"),
  endsAt: new Date("2025-06-01T23:00:00Z"),
  currency: "usd",
  seriesId: null,
  cancelledAt: null,
} as unknown as EventRecord;

/** What the first (completed) checkout answered and stored for replay. */
const storedResponse = {
  orderId: ORDER_ID,
  clientSecret: "pi_replay1_secret_FakeFixtureNotReal", // gitleaks:allow (fake test fixture)
  amountGrossCents: 1000,
  feesPlatformCents: 50,
  buyerFeesCents: 50,
  processorFeeCents: 59,
  feeMode: "PASS_THROUGH" as const,
  taxAmountCents: 0,
  creditAppliedCents: 0,
  holdExpiresAt: null,
};

const deps = (): CreateEmbedGuestCheckoutDeps & {
  createPaymentIntent: ReturnType<typeof vi.fn>;
} => {
  const createPaymentIntent = vi.fn();
  return {
    createPaymentIntent,
    repos: {
      embeds: { getById: vi.fn(async () => embed) },
      events: {
        getById: vi.fn(async () => event),
        listTicketTypes: vi.fn(async () => [
          { id: TICKET_TYPE_ID, name: "General Admission" },
        ]),
      },
      orders: {
        getById: vi.fn(async () => ({
          id: ORDER_ID,
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
        })),
      },
      humans: {
        ensureGuestHuman: vi.fn(async () => ({
          humanId: HUMAN_ID,
          created: false,
        })),
      },
    } as unknown as Repos,
    payments: { createPaymentIntent } as never,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => new Date("2025-06-01T18:00:00Z") },
  };
};

const input = {
  embedId: EMBED_ID,
  eventId: EVENT_ID,
  hostOrigin: "https://shop.example.com",
  guestName: "Guest Buyer",
  guestEmail: "guest@example.com",
  clientKey: CLIENT_KEY,
  items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
  termsAccepted: true,
  refundPolicyAccepted: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createEmbedGuestCheckout — a replayed create (accepted degradation)", () => {
  it("the replay answers a NEW receipt secret; the PaymentIntent is made once, with the FIRST hash; the new secret does not match it", async () => {
    const d = deps();
    let paymentIntentsMade = 0;
    let paymentIntentMetadata: Record<string, string> = {};
    const spy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockImplementationOnce(async (checkoutDeps, rawInput, serverContext) => {
        // The first, completed checkout: one PaymentIntent, its metadata
        // written by the real server-context helper, and the replay record
        // committed where the real `createCheckout` looks for it.
        const sent = rawInput as {
          actorHumanId: string;
          buyerHumanId: string;
          eventId: string;
          clientKey: string;
          items: Array<{ ticketTypeId: string; qty: number }>;
        };
        paymentIntentsMade += 1;
        paymentIntentMetadata = applyCheckoutServerContextToMetadata(
          { orderId: ORDER_ID, source: "primary" },
          serverContext ?? {},
        );
        await checkoutDeps.idempotency.commit(
          `checkout:${sent.actorHumanId}:${sent.clientKey}`,
          {
            payloadHash: JSON.stringify({
              actorHumanId: sent.actorHumanId,
              buyerHumanId: sent.buyerHumanId,
              eventId: sent.eventId,
              items: sent.items.map((i) => ({
                ticketTypeId: i.ticketTypeId,
                qty: i.qty,
              })),
              promoCodes: [],
            }),
            response: storedResponse,
          },
        );
        return storedResponse;
      });

    const first = await createEmbedGuestCheckout(d, input);
    // The second call goes through the REAL createCheckout (the spy falls
    // back to it after the one stand-in), which replays the stored answer.
    const second = await createEmbedGuestCheckout(d, input);

    expect(spy).toHaveBeenCalledTimes(2);
    // The real createCheckout read the replay record under its own key and
    // returned it: it never claimed the key (begin), which the paid path
    // would have done first.
    const fake = d.idempotency as ReturnType<typeof createFakeIdempotencyPort>;
    expect(fake.__mocks.get).toHaveBeenCalledWith(
      `checkout:${HUMAN_ID}:embed:${CLIENT_KEY}`,
    );
    expect(fake.__mocks.begin).not.toHaveBeenCalled();
    // Same order, same PaymentIntent: the real replay answered.
    expect(second.orderId).toBe(first.orderId);
    expect(second.clientSecret).toBe(first.clientSecret);
    // No second PaymentIntent: neither the stand-in nor the processor.
    expect(paymentIntentsMade).toBe(1);
    expect(d.createPaymentIntent).not.toHaveBeenCalled();

    // A fresh secret on the replay; the metadata keeps the first one's hash.
    expect(first.receiptSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.receiptSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.receiptSecret).not.toBe(first.receiptSecret);
    expect(paymentIntentMetadata.receiptSecretHash).toBe(
      createHash("sha256").update(first.receiptSecret!).digest("hex"),
    );

    // What `confirmEmbedGuestPayment` decides with: the first secret earns
    // the codes, the replay's does not.
    expect(
      guestReceiptSecretMatches(
        first.receiptSecret!,
        paymentIntentMetadata.receiptSecretHash,
      ),
    ).toBe(true);
    expect(
      guestReceiptSecretMatches(
        second.receiptSecret!,
        paymentIntentMetadata.receiptSecretHash,
      ),
    ).toBe(false);
  });
});
