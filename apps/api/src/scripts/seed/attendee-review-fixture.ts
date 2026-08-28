import type { PrismaClient } from "@prisma/client";

import { DEMO_IDS } from "./ids.js";

// ── Attendee-review ("Rate this show") fixture ───────────────────────────
//
// Makes the dev-login admin *eligible* to review a recently-ended show so the
// `/review-event/[eventId]` flow and the my-tickets "Rate this show" CTA are
// exercisable locally. The eligibility contract
// (`get-attendee-review-eligibility.ts`) requires ALL of:
//   1. event PUBLISHED (not CANCELLED/ARCHIVED)      → the reused fixture is
//   2. event has ENDED (endsAt in the past)          → daysFromNow: -3
//   3. within 30 days of endsAt                      → 3 days ago ≪ 30d
//   4. a SCANNED Ticket owned by the admin human     → issued below
//   5. NO existing AttendeeReview for (event, human) → deliberately not seeded
//
// We reuse the existing recent-past recap event (see `buildEventFixtures` in
// fixtures.ts) rather than minting a bespoke one, and issue a SUCCEEDED order
// so the same order also surfaces under my-tickets "Past" (which keys off the
// event start being in the past).
//
// Self-contained + Stripe-free: this order never goes through the refund /
// fee-lookup flows, so it needs no real PaymentIntent. Idempotent via fixed
// IDs + upserts, matching the rest of the seed.

/** Slug of the recent-past show reused as the rateable event. */
const RECENT_PAST_SHOW_SLUG = "ca-sf-past-recent-recap";

/** Public ticket code for the seeded SCANNED ticket. */
const REVIEW_SHOW_TICKET_CODE = "DEV-REVIEW-SHOW-01";

export type SeedAttendeeReviewShowResult = {
  eventId: string;
  orderId: string;
  ticketId: string;
} | null;

/**
 * Seed a SUCCEEDED order + one SCANNED ticket for `humanId` (default: the
 * dev-login admin) against the recent-past recap event.
 *
 * Must run AFTER events + ticket types exist (i.e. after `upsertEventWithTickets`
 * for the org fixtures). No-ops gracefully if the event or a ticket type is
 * missing so a partial/altered seed never hard-fails here.
 */
export const seedAttendeeReviewShow = async (
  prisma: PrismaClient,
  opts: { humanId?: string } = {},
): Promise<SeedAttendeeReviewShowResult> => {
  const humanId = opts.humanId ?? DEMO_IDS.devUser;

  const event = await prisma.event.findUnique({
    where: { slug: RECENT_PAST_SHOW_SLUG },
    select: {
      id: true,
      title: true,
      status: true,
      startsAt: true,
      endsAt: true,
    },
  });
  if (!event) {
    console.log(
      `  [attendee-review] Event "${RECENT_PAST_SHOW_SLUG}" not found — skipping rateable-show fixture.`,
    );
    return null;
  }

  // Prefer a paid tier so the my-tickets card shows a realistic amount.
  const ticketType = await prisma.ticketType.findFirst({
    where: { eventId: event.id },
    orderBy: { priceCents: "desc" },
    select: { id: true, priceCents: true },
  });
  if (!ticketType) {
    console.log(
      `  [attendee-review] No ticket type for "${RECENT_PAST_SHOW_SLUG}" — skipping rateable-show fixture.`,
    );
    return null;
  }

  const orderId = DEMO_IDS.reviewShowOrder;
  const orderItemId = DEMO_IDS.reviewShowOrderItem;
  const ticketId = DEMO_IDS.reviewShowTicket;

  const amountGrossCents = ticketType.priceCents;
  const platformFeeCents = Math.round(amountGrossCents * 0.05);
  const buyerFeeCents = Math.round(amountGrossCents * 0.065);
  const buyerTotalCents = amountGrossCents + buyerFeeCents;
  const feePolicySnapshot = {
    platformFeePct: 0.05,
    buyerFeePct: 0.065,
    currency: "usd",
  };

  // Bought ~5 days before the show, scanned in shortly before it ended.
  const endsAt = event.endsAt ?? event.startsAt;
  const occurredAt = new Date(endsAt.getTime() - 5 * 24 * 60 * 60 * 1000);
  const scannedAt = new Date(endsAt.getTime() - 30 * 60 * 1000);

  await prisma.order.upsert({
    where: { id: orderId },
    update: {
      status: "SUCCEEDED",
      eventId: event.id,
      buyerHumanId: humanId,
    },
    create: {
      id: orderId,
      eventId: event.id,
      buyerHumanId: humanId,
      amountGrossCents,
      feesPlatformCents: platformFeeCents,
      currency: "usd",
      status: "SUCCEEDED",
      feePolicySnapshot,
      occurredAt,
      source: "PRIMARY",
    },
  });

  await prisma.orderItem.upsert({
    where: { id: orderItemId },
    update: {},
    create: {
      id: orderItemId,
      orderId,
      kind: "ticket",
      ticketTypeId: ticketType.id,
      qty: 1,
      unitPriceCents: amountGrossCents,
      amountCents: amountGrossCents,
      meta: {
        buyerTotalCents,
        buyerUnitTotalCents: buyerTotalCents,
      },
    },
  });

  // The eligibility gate counts tickets with status="SCANNED" owned by the
  // human — see `attendee-reviews.ts` adapter `hasScannedTicket`.
  await prisma.ticket.upsert({
    where: { id: ticketId },
    update: {
      status: "SCANNED",
      scannedAt,
      ownerHumanId: humanId,
      eventId: event.id,
      ticketTypeId: ticketType.id,
      orderId,
      orderItemId,
    },
    create: {
      id: ticketId,
      eventId: event.id,
      orderId,
      orderItemId,
      ticketTypeId: ticketType.id,
      ownerHumanId: humanId,
      code: REVIEW_SHOW_TICKET_CODE,
      status: "SCANNED",
      issuedAt: occurredAt,
      scannedAt,
    },
  });

  console.log(
    `  [attendee-review] Seeded SCANNED ticket + SUCCEEDED order for "${event.title}" ` +
      `(owner …${humanId.slice(-4)}) — try /review-event/${event.id}`,
  );

  return { eventId: event.id, orderId, ticketId };
};
