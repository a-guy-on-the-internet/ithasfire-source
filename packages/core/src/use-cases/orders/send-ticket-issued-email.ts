import { z } from "zod";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import type { AuthZPort } from "@th/ports/authz";
import type { EventRecord } from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import { eventPublicUrl } from "../../lib/public-urls";
import { listArrivalAreasForViewer } from "../arrival-areas/list-arrival-areas-for-viewer";
import { getFeatureGates } from "../features/get-feature-gates";
import { isActiveHolderOrderStatus } from "../../lib/location/holder-eligibility";
import { resolveHolderAddress } from "../../lib/location/resolve-holder-address";
import { venueConfirmationArm } from "../../lib/venue-confirmation";
import { fail } from "@th/errors";

import { isLoginableBuyer } from "./notify-buyer";
import { formatOrderCode } from "@th/types/order-identifier";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";
import {
  buildDoorSaleReceipt,
  isDoorSaleOrder,
} from "./_shared/door-sale-receipt";

export const sendTicketIssuedEmailInputSchema = z.object({
  orderId: z.string().uuid(),
  publicAppUrl: z.string().url(),
  supportUrl: z.string().url(),
  /** Self-hosted tileserver base URL (e.g. https://tiles.example.com). Used for static map images in emails. */
  tileServerUrl: z.string().url().optional(),
  /**
   * Optional `/auth/complete` account-claim link. Set when the recipient is a
   * shadow (guest) human with no account yet — e.g. a volunteer comp-ticket
   * grant — so the email invites them to claim the ticket into an account.
   */
  accountCompletionUrl: z.string().url().optional(),
});

export const sendTicketIssuedEmailOutputSchema = z.object({
  ok: z.literal(true),
  orderId: z.string().uuid(),
  /** Null only when nothing was sent (`skipped`). */
  recipientEmail: z.string().email().nullable(),
  ticketCount: z.number().int().min(0),
  /**
   * Set when nothing was sent: `NO_RECIPIENT` is a door sale whose buyer gave
   * no email (a per-sale phantom buyer has no address to send to).
   */
  skipped: z.literal("NO_RECIPIENT").optional(),
  /** True when a door sale's itemised receipt went out with the ticket. */
  receiptSent: z.boolean().optional(),
});

export type SendTicketIssuedEmailInput = z.infer<
  typeof sendTicketIssuedEmailInputSchema
>;
export type SendTicketIssuedEmailOutput = z.infer<
  typeof sendTicketIssuedEmailOutputSchema
>;

export type SendTicketIssuedEmailDeps = {
  repos: Repos;
  mailer: MailerPort;
  logger?: LoggerPort;
  /**
   * Deliberate swallows: the claim-link loginability lookup
   * (`isLoginableBuyer`) and the arrival-areas line (`gettingThereUrlFor`).
   */
  reportError?: ReporterPort | null;
};

/**
 * The authz an ANONYMOUS projection runs with. With no viewer the projection
 * never asks a staff question (`resolveEventAreaAccess`, `canViewerReadEvent`
 * both skip it), so these never run; if that ever changes they deny, which
 * shows fewer areas, never more.
 */
const ANONYMOUS_AREA_AUTHZ: Pick<
  AuthZPort,
  "canEditEvent" | "canManagePlace" | "hasStaffRole"
> = {
  canEditEvent: async () => ({ allowed: false }),
  canManagePlace: async () => ({ allowed: false }),
  hasStaffRole: async () => ({ allowed: false }),
};

/**
 * arrival-areas FR-010: the event page link for the "Parking and drop-off:
 * see the map" line, or undefined for no line. A line only when
 *   · the recipient already gets the exact address in this email
 *     (`recipientGetsAddress`), so the line never points at a place the
 *     email itself withholds;
 *   · the `arrivalAreas` gate is on (FR-017); and
 *   · the event has at least one area an ANONYMOUS visitor is shown
 *     (`listArrivalAreasForViewer` with no viewer: parking or accessible
 *     drop-off at a published address, never load-in). Asked as nobody in
 *     particular, so the line implies nothing a stranger could not see.
 * Never fails the email: any failure is no line, reported (a deliberate
 * swallow, CLAUDE.md "Error Reporting Convention"). The projection fails
 * closed and reports on its own; this catch covers what escapes it.
 * NFR-002: logs ids only.
 */
async function gettingThereUrlFor(
  deps: SendTicketIssuedEmailDeps,
  args: {
    event: EventRecord;
    orderId: string;
    recipientGetsAddress: boolean;
    publicAppUrl: string;
  },
): Promise<string | undefined> {
  const { event } = args;
  if (!args.recipientGetsAddress || !event.slug) return undefined;
  try {
    const gates = await getFeatureGates({
      platformSettings: deps.repos.platformSettings,
      reportError: deps.reportError ?? undefined,
    });
    if (gates.arrivalAreas !== true) return undefined;
    const { areas } = await listArrivalAreasForViewer(
      {
        repos: deps.repos,
        authz: ANONYMOUS_AREA_AUTHZ,
        clock: { now: () => new Date() },
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...(deps.reportError ? { reportError: deps.reportError } : {}),
      },
      { eventId: event.id },
    );
    if (areas.length === 0) return undefined;
    return (
      eventPublicUrl({ baseUrl: args.publicAppUrl, slug: event.slug }) ??
      undefined
    );
  } catch (err) {
    deps.logger?.error("sendTicketIssuedEmail.getting_there_failed", {
      orderId: args.orderId,
      eventId: event.id,
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "sendTicketIssuedEmail", step: "gettingThere" },
        extra: { orderId: args.orderId, eventId: event.id },
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }
    return undefined;
  }
}

export async function sendTicketIssuedEmail(
  deps: SendTicketIssuedEmailDeps,
  rawInput: unknown,
): Promise<SendTicketIssuedEmailOutput> {
  const input = parseInput(sendTicketIssuedEmailInputSchema, rawInput);
  const logger = deps.logger?.child({ useCase: "sendTicketIssuedEmail" });

  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  const doorSale = isDoorSaleOrder(order);
  const humanWithIdentity = await deps.repos.humans.getByIdWithIdentity(
    order.buyerHumanId,
  );
  if (!humanWithIdentity) {
    // A door sale without a buyer email is recorded against a per-sale
    // phantom Human with no address (spec 2026-10-07 door-sales FR-004):
    // there is nobody to email, and that is the normal case, not a fault.
    // The payment webhook sends this for every finalised primary order, so
    // throwing here dead-lettered every door card sale.
    if (doorSale) {
      logger?.info("sendTicketIssuedEmail.door_sale_no_recipient", {
        orderId: order.id,
      });
      return sendTicketIssuedEmailOutputSchema.parse({
        ok: true,
        orderId: order.id,
        recipientEmail: null,
        ticketCount: 0,
        skipped: "NO_RECIPIENT",
      });
    }
    throw fail("HUMAN_NOT_FOUND", { meta: { role: "buyer" } });
  }
  const { identity } = humanWithIdentity;

  // ── Account-claim link for GUEST-checkout buyers ──────────────────────
  //
  // A guest buyer has a shadow `AuthUser` from `ensureGuestHuman` with NO
  // `AuthAccount` rows — no password, no OAuth — so every "sign in to see your
  // order" path is a dead end for them. `/my-tickets/**` is gated, so without
  // this the receipt link in their own email bounces them to a sign-in they
  // cannot complete.
  //
  // Their TICKET is unaffected either way: the QR is an unauthenticated
  // `/tickets/qr/{code}` image rendered inline in this very email, so entry at
  // the door never depends on an account. This link is about the RECEIPT —
  // refunds, transfers, wallet passes.
  //
  // `isLoginableBuyer` is the same signal `notifyBuyerForFinalizedOrder` uses
  // to decide who gets in-app notifications, so "gets a claim link" and "gets
  // in-app notifications" stay exact complements rather than drifting apart.
  // It is fail-safe FALSE on a repo error, which here means a real account
  // holder could see a claim link they don't need — it lands on sign-in with
  // their address prefilled, so the failure mode is a redundant link, never a
  // lost or misdirected one.
  //
  // An explicit `accountCompletionUrl` from the caller always wins: the
  // volunteer-comp path (`grant-volunteer-reward.ts`) passes its own with
  // `src=volunteer-comp`, and that attribution must survive.
  const derivedAccountCompletionUrl =
    input.accountCompletionUrl ??
    ((await isLoginableBuyer(
      { repos: deps.repos, reportError: deps.reportError },
      order.buyerHumanId,
    ))
      ? undefined
      : `${input.publicAppUrl.replace(/\/+$/, "")}/auth/complete?email=${encodeURIComponent(
          identity.email,
        )}&src=guest-checkout`);

  const event = await deps.repos.events.getById(requireTicketingEventId(order));
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  const place = event.placeId
    ? await deps.repos.places.getById(event.placeId)
    : null;

  // Delayed address reveal: an OBSCURED event's exact address/map/directions
  // are suppressed until its (mandatory) `addressRevealAt` passes; the email
  // renders a "revealed on {date}" notice instead. This applies to BOTH
  // obscured-circle and fully-hidden events — the purchase email never carries
  // an obfuscated map, only the notice. Fail-closed: a non-EXACT event with a
  // null reveal date stays locked, and so does a NEVER event. EXACT events
  // are never locked.
  //
  // THE VENUE CEILING applies here too: an event at a venue that withholds its
  // address is treated as OBSCURED regardless of what the event row says. A
  // purchase email is a per-recipient surface, but it is still the address
  // leaving the building, and the event most likely to be stored EXACT at a
  // withheld venue is one that was published before the venue was hidden.
  //
  // `resolveHolderAddress` is the ONE place that decision lives; the order
  // page, the my-tickets list, the wallet pass and the reveal notification
  // share it. Once unlocked it also reads the TRUE address from the right
  // row: for a withheld venue that is the Place, because the Event row only
  // carries the venue's public projection — and only when that venue has
  // vouched for this event (owner, or an explicit confirmation).
  //
  // The recipient is the buyer, so the buyer must still be a holder: a paid
  // order and a live ticket. The webhook sends this on success, so that is
  // the normal case; the check keeps a late or replayed send for a refunded
  // order from carrying the street.
  const activeHolder =
    isActiveHolderOrderStatus(order.status) &&
    (await deps.repos.tickets.hasActiveTicketForEvent(
      event.id,
      order.buyerHumanId,
    ));
  const holderAddress = resolveHolderAddress({
    event,
    place,
    venueConfirmationArm: venueConfirmationArm(event, place),
    activeHolder,
    actOnBill: false,
    now: new Date(),
  });
  const addressLocked = holderAddress.locked;

  // Venue heading. While the address is locked, a linked Place's public name
  // is a de-facto exact address (NFR-004) — the public pre-reveal surfaces
  // show only a fuzzed circle + coarse area label, never the venue name — so
  // this email must not name the venue either. The locked label is the
  // coarse "locality, region" first, then the organizer's `locationLabel`
  // (see `resolveHolderAddress`), and "Place TBA" when neither exists. Never
  // fall through to `event.addressText` (full street-level text) while
  // locked. EXACT and post-reveal behavior is unchanged.
  const venueName = holderAddress.locked
    ? holderAddress.label?.trim() || "Place TBA"
    : place?.name?.trim() || event.addressText?.trim() || "Place TBA";

  // Build venue address for the email (place address takes precedence).
  // Suppressed when the address is locked behind the reveal gate.
  const venueAddress = holderAddress.locked
    ? undefined
    : (place?.formattedAddress ?? holderAddress.addressText ?? undefined);

  // Coordinates for the map and directions: the true point once unlocked
  // (the Place's for a withheld venue), nothing while locked.
  const venueLat = holderAddress.locked ? null : holderAddress.lat;
  const venueLng = holderAddress.locked ? null : holderAddress.lng;

  // Build static map image URL when we have coordinates and a tileserver.
  // Suppressed when the address is locked.
  let mapImageUrl: string | undefined;
  if (venueLat != null && venueLng != null && input.tileServerUrl) {
    // TileServer GL static image endpoint — no API key needed, we own the server.
    const base = input.tileServerUrl.replace(/\/+$/, "");
    mapImageUrl = `${base}/styles/streets/static/${venueLng},${venueLat},14/600x200.png`;
  }

  // Build Google Maps directions URL when we have coordinates.
  // Suppressed when the address is locked.
  const directionsUrl =
    venueLat != null && venueLng != null
      ? `https://www.google.com/maps/dir/?api=1&destination=${venueLat},${venueLng}`
      : undefined;

  // The "address will be shared on {date}" notice. Only a locked address
  // with a real future date gets one; NEVER (and a date-less row) carries
  // no date to promise.
  const addressRevealAt = holderAddress.locked ? holderAddress.revealAt : null;

  const ticketDetails = await deps.repos.tickets.listByOrderId(order.id);
  if (!ticketDetails.length) {
    throw fail("TICKETS_MISSING");
  }

  // Resolve human-readable seat labels for seated tickets (GA tickets have
  // no seatId and get no seat line). The label is `Section name · Seat.label`
  // when the section is known, otherwise the raw seat label (e.g. "A12") —
  // mirroring how resale/checkout surfaces already present seat data.
  const seatIds = ticketDetails
    .map((ticket) => ticket.seatId)
    .filter((seatId): seatId is string => seatId !== null);

  const seatLabelBySeatId = new Map<string, string>();
  if (seatIds.length > 0) {
    // Same read-enrichment lookup used by get-resale-listing: outside a
    // transaction the FOR UPDATE lock only spans this single statement.
    const seats = await deps.repos.seats.findByIdsForUpdate({
      seatIds,
      eventId: requireTicketingEventId(order),
    });
    const sectionNameById = new Map<string, string | null>();
    for (const seat of seats) {
      let sectionName = sectionNameById.get(seat.seatSectionId);
      if (sectionName === undefined) {
        const section = await deps.repos.seats.getSectionById(
          seat.seatSectionId,
        );
        sectionName = section?.name ?? null;
        sectionNameById.set(seat.seatSectionId, sectionName);
      }
      seatLabelBySeatId.set(
        seat.id,
        sectionName ? `${sectionName} · ${seat.label}` : seat.label,
      );
    }
  }

  const publicAppUrl = input.publicAppUrl.replace(/\/+$/, "");
  // The recipient's order detail lives under /my-tickets; `/orders/:id` is
  // an admin-only path. Pre-fix the email pointed there, which 404'd for
  // buyers.
  const manageUrl = `${publicAppUrl}/my-tickets/${order.id}`;
  const qrBaseUrl = `${publicAppUrl}/tickets/qr`;
  const gettingThereUrl = await gettingThereUrlFor(deps, {
    event,
    orderId: order.id,
    recipientGetsAddress: !addressLocked,
    publicAppUrl,
  });
  const ticketAssets = ticketDetails.map((ticket) => {
    const seatLabel = ticket.seatId
      ? seatLabelBySeatId.get(ticket.seatId)
      : undefined;
    return {
      code: ticket.code,
      qrUrl: `${qrBaseUrl}/${ticket.code}`,
      ...(seatLabel ? { seatLabel } : {}),
    };
  });

  await deps.mailer.send({
    to: { to: identity.email },
    template: {
      key: "ticket.issued",
      variables: {
        eventTitle: event.title,
        eventDateISO: event.startsAt.toISOString(),
        timezone: event.timezone ?? "America/Chicago",
        venueName,
        tickets: ticketAssets,
        // DISPLAYED value only — the ONE order code (`formatOrderCode`: the
        // 8-hex TAIL of the id, uppercased), identical to the checkout
        // confirmation, the /my-tickets receipt, the wallet pass and admin
        // search. The raw 36-char UUID used to travel here, so a buyer had
        // three different strings for one order and quoted whichever they
        // happened to have. Everything below that is NOT rendered as the
        // order's identity — `manageUrl`, the support deep-link, the
        // idempotency key, the log field and this use case's own output —
        // deliberately keeps the RAW `order.id`.
        orderId: formatOrderCode(order.id),
        manageUrl,
        // Order-aware "need help with THIS order" CTA: deep-links the buyer to
        // the help section of their order page. The generic `input.supportUrl`
        // remains plumbed as a fallback but is no longer the rendered link.
        supportUrl: `${manageUrl}#get-help`,
        ...(venueAddress ? { venueAddress } : {}),
        ...(mapImageUrl ? { mapImageUrl } : {}),
        ...(directionsUrl ? { directionsUrl } : {}),
        ...(derivedAccountCompletionUrl
          ? { accountCompletionUrl: derivedAccountCompletionUrl }
          : {}),
        ...(addressLocked && addressRevealAt
          ? { addressRevealAtISO: addressRevealAt.toISOString() }
          : {}),
        ...(gettingThereUrl ? { gettingThereUrl } : {}),
      },
    },
    idempotencyKey: `ticket-issued:${order.id}`,
  });

  logger?.info("sendTicketIssuedEmail.sent", {
    orderId: order.id,
    ticketCount: ticketAssets.length,
  });

  // ── Door sale: the itemised receipt (spec 2026-10-07 door-sales FR-011) ──
  // Online checkout shows the buyer every line before they pay; a door buyer
  // only hears a total, so the receipt that itemises ticket, fees and each
  // tax line is emailed with the ticket. A separate message on the existing
  // `order.receipt` template (the ticket email stays the one every buyer
  // gets). Thrown like the ticket email above: the webhook dead-letters and
  // replays it, the cash till reports it.
  let receiptSent = false;
  if (doorSale) {
    const [taxLines, ticketTypes] = await Promise.all([
      deps.repos.orders.listTaxLines(order.id),
      deps.repos.events.listTicketTypes(event.id),
    ]);
    const receipt = buildDoorSaleReceipt({
      order,
      taxLines,
      ticketTypeNames: new Map(ticketTypes.map((tt) => [tt.id, tt.name])),
    });
    const buyerName = humanWithIdentity.human.name?.trim();
    // A GUEST (no sign-in method yet, the case `derivedAccountCompletionUrl`
    // is set for) gets no "View order details" link: `/my-tickets/**` is
    // gated, so it would land on a sign-in they cannot complete. The ticket
    // email sent just above carries their QR codes and the optional claim
    // link; a second account prompt here would push an account the buyer
    // did not ask for (owner ruling R7: no account, no marketing).
    const guest = derivedAccountCompletionUrl != null;
    await deps.mailer.send({
      to: { to: identity.email },
      template: {
        key: "order.receipt",
        variables: {
          orderId: formatOrderCode(order.id),
          ...(buyerName ? { buyerName } : {}),
          lineItems: receipt.lineItems,
          totalCents: receipt.totalCents,
          eventTitle: event.title,
          ...(guest ? {} : { viewOrderUrl: manageUrl }),
          paymentMethod: receipt.paymentMethod,
          ...(receipt.complimentary ? { complimentary: true } : {}),
          currency: order.currency,
        },
      },
      idempotencyKey: `door-sale-receipt:${order.id}`,
    });
    receiptSent = true;
    logger?.info("sendTicketIssuedEmail.door_receipt_sent", {
      orderId: order.id,
      totalCents: receipt.totalCents,
    });
  }

  return sendTicketIssuedEmailOutputSchema.parse({
    ok: true,
    orderId: order.id,
    recipientEmail: identity.email,
    ticketCount: ticketAssets.length,
    ...(doorSale ? { receiptSent } : {}),
  });
}
