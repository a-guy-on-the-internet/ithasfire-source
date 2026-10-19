import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type {
  WalletPassPort,
  WalletPassType,
  WalletPassResult,
} from "@th/ports/wallet-pass.port";

import { formatOrderCode } from "@th/types/order-identifier";

import { parseInput, callOrDependencyFailed } from "../../lib/io";
import {
  resolveHolderAddress,
  type LockedHolderAddress,
} from "../../lib/location/resolve-holder-address";
import { venueConfirmationArm } from "../../lib/venue-confirmation";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { resolvePurchasedUnitPriceCents } from "./_shared/resolve-purchased-unit-price";
import { fail } from "@th/errors";

// ── Input / Output ───────────────────────────────────────────────────────────

export const generateWalletPassInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  ticketId: z.string().uuid(),
  passType: z.enum(["apple", "google"]),
});

export const generateWalletPassOutputSchema = z.object({
  passType: z.enum(["apple", "google"]),
  /** Present for Google — the "Add to Wallet" URL the client opens. */
  saveUrl: z.string().url().nullable(),
  /** Present for Apple — base64-encoded .pkpass bytes. */
  passBase64: z.string().nullable(),
  filename: z.string().nullable(),
});

export type GenerateWalletPassInput = z.infer<
  typeof generateWalletPassInputSchema
>;
export type GenerateWalletPassOutput = z.infer<
  typeof generateWalletPassOutputSchema
>;

// ── Dependencies ─────────────────────────────────────────────────────────────

export type GenerateWalletPassDeps = {
  repos: Repos;
  walletPass: WalletPassPort;
  logger?: LoggerPort;
  /**
   * Reports the degraded branch where the ticket's purchase price cannot be
   * resolved and the pass falls back to 0. Best-effort; a throwing reporter
   * never changes behaviour.
   */
  reportError?: ReporterPort;
};

// ── Locked-address copy ──────────────────────────────────────────────────────

/**
 * What the pass prints in its ADDRESS slot while the holder may not see the
 * street. The dated line is the purchase email's locked notice word for word
 * (`ticketIssued.sections.where.revealNotice`), with the date formatted the
 * way the email formats it. English only, like every other label on the pass
 * (the adapters hard-code "VENUE", "ADDRESS", ...).
 *
 * A pass is OFF-PLATFORM and is never rewritten after it is saved: there is
 * no Apple `webServiceURL` and no Google Wallet REST patch, only the one-shot
 * save JWT. So this text is what the pass says for good; the reveal itself
 * reaches the holder through the reveal notification and the order page.
 */
export function lockedPassAddressNotice(
  locked: LockedHolderAddress,
  timezone: string | null | undefined,
): string {
  if (locked.reason === "never") {
    return "The organizer isn't sharing this address.";
  }
  if (locked.reason === "placeUnavailable") {
    // The venue could not be read when the pass was built. Not the venue's
    // "no", and the pass is never rewritten, so promise nothing and point at
    // the place that WILL update.
    return "The address isn't available right now. Check your order page for updates.";
  }
  if (locked.reason === "venueUnconfirmed") {
    // The place withholds its address and has not confirmed this event, so
    // no date is coming. Same words as the order page's notice.
    return "The place shares its address with events it has confirmed. Ask the organizer where to go.";
  }
  if (!locked.revealAt) {
    // Fail-closed row with no date (not a NEVER choice): promise nothing.
    return "The exact address hasn't been shared yet.";
  }
  return `The exact address will be shared on ${formatPassRevealDate(
    locked.revealAt,
    timezone,
  )}. We'll send you a reminder.`;
}

/**
 * "Friday, October 2, 2026 at 7:00 PM" in the event's zone: the same
 * `dateStyle: "full", timeStyle: "short"` the email's notice uses. A missing
 * or unknown zone id falls back to the platform default
 * (`resolveTimeZone`), never UTC: UTC is the server's zone, and it put an
 * evening reveal on the next day.
 */
function formatPassRevealDate(
  at: Date,
  timezone: string | null | undefined,
): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: resolveTimeZone(timezone),
  }).format(at);
}

// ── Use case ─────────────────────────────────────────────────────────────────

export async function generateWalletPass(
  deps: GenerateWalletPassDeps,
  rawInput: unknown,
): Promise<GenerateWalletPassOutput> {
  const input = parseInput(generateWalletPassInputSchema, rawInput);

  // 1. Load ticket + verify ownership
  const ticket = await deps.repos.tickets.getById(input.ticketId);
  if (!ticket) {
    throw fail("TICKET_NOT_FOUND");
  }

  if (ticket.ownerHumanId !== input.actorHumanId) {
    throw fail("TICKET_NOT_FOUND");
  }

  if (ticket.status !== "VALID") {
    throw fail("TICKET_NOT_VALID");
  }

  // 2. Check adapter is configured for this pass type
  const configured = await deps.walletPass.isConfigured(
    input.passType as WalletPassType,
  );
  if (!configured) {
    throw fail("WALLET_PASS_NOT_CONFIGURED", { meta: { passType: input.passType } });
  }

  // 3. Load related data for the pass
  const [order, event, ticketType] = await Promise.all([
    ticket.orderId
      ? deps.repos.orders.getById(ticket.orderId)
      : Promise.resolve(null),
    deps.repos.events.getById(ticket.eventId),
    ticket.ticketTypeId
      ? deps.repos.tickets.getTicketTypeById(ticket.ticketTypeId)
      : Promise.resolve(null),
  ]);

  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  const holder = await deps.repos.humans.getById(ticket.ownerHumanId);

  // The address this holder may see RIGHT NOW, decided by the ONE shared
  // helper (mode floored by the venue, reveal date, NEVER). This matters more
  // here than on any other surface: the pass leaves the platform, lives on
  // the holder's phone indefinitely, and is never rewritten after it is saved.
  // Whatever goes in now is what it says forever.
  const place = event.placeId
    ? await deps.repos.places.getById(event.placeId)
    : null;
  const holderAddress = resolveHolderAddress({
    event,
    place,
    venueConfirmationArm: venueConfirmationArm(event, place),
    // Established above: the actor owns this ticket and it is VALID. A
    // refunded, invalidated or transferred-away ticket never reaches here.
    activeHolder: true,
    actOnBill: false,
    now: new Date(),
  });

  // FR-002: the pass shows the price PAID, snapshotted on the OrderItem — not
  // the live TicketType, which would rewrite the number on the buyer's phone
  // every time the organizer edits the price and the pass is re-issued.
  const purchasedUnitPriceCents = await resolvePurchasedUnitPriceCents(
    deps.repos,
    ticket,
  );
  if (purchasedUnitPriceCents == null) {
    // Degraded: 0 is the existing "unknown price" sentinel on the pass. It is
    // NOT a fall back to the live price — that is the bug being fixed.
    deps.logger?.error("generateWalletPass.purchase_price_unresolved", {
      ticketId: ticket.id,
      orderItemId: ticket.orderItemId,
    });
    try {
      deps.reportError?.(
        new Error("generateWalletPass: no purchase price for ticket"),
        {
          tags: { useCase: "generateWalletPass" },
          extra: { ticketId: ticket.id, orderItemId: ticket.orderItemId },
        },
      );
    } catch {
      // Reporting is best-effort — a throwing reporter must never stop a pass
      // from being issued.
    }
  }

  // 4. Build pass data
  //
  // `orderRef` is derived from the SAME resolved id the pass carries, so the
  // code printed on the pass is byte-identical to the one the order page and
  // admin search show. Empty id (no order, no ticket.orderId) → null rather
  // than a meaningless "".
  const resolvedOrderId = order?.id ?? ticket.orderId ?? "";
  const ticketData = {
    ticketId: ticket.id,
    ticketCode: ticket.code,
    ticketTypeName: ticketType?.name ?? "General Admission",
    eventId: event.id,
    eventTitle: event.title,
    eventStartsAt: event.startsAt.toISOString(),
    eventEndsAt: event.endsAt?.toISOString() ?? null,
    // Locked: the coarse area label and a notice in the address slot —
    // never the street, never the venue's name (a de-facto address while
    // locked). Unlocked: the organizer's label as before, and the TRUE
    // street (from the Place for a venue that withholds its address).
    //
    // "Place TBA" when locked with no label, as the email does: Google only
    // renders the address inside a named venue block, so a null name would
    // drop the notice along with it.
    venueName: holderAddress.locked
      ? holderAddress.label?.trim() || "Place TBA"
      : (event.locationLabel ?? null),
    venueAddress: holderAddress.locked
      ? lockedPassAddressNotice(holderAddress, event.timezone)
      : holderAddress.addressText,
    // Lets an adapter with shared per-event state (Google's class) keep a
    // locked pass off state that was created while the address was open.
    addressLocked: holderAddress.locked,
    organizerName: null,
    orderId: resolvedOrderId,
    orderRef: resolvedOrderId ? formatOrderCode(resolvedOrderId) : null,
    holderName: holder?.name ?? null,
    priceCents: purchasedUnitPriceCents ?? 0,
    currency: event.currency ?? "usd",
    // Organiser-cropped wallet artwork. Always null until the builder field
    // and its `Event.walletImageId` column land — the ports and both adapters
    // are wired ahead of the schema so the image path could be verified
    // end-to-end (a real signed `.pkpass` with a thumbnail) before a migration
    // was added to a dev DB that another session's migration is mid-flight on.
    // See `docs/specs/2026-09-07/wallet-pass-image.spec.yaml`.
    //
    // When wiring this up: an image that is FLAGGED or not yet moderated must
    // resolve to null here, not be passed through (NFR-002 / the HIGH risk in
    // the spec) — moderation is asynchronous, so un-reviewed is not safe.
    walletImageUrl: null,
  };

  // 5. Generate pass
  const result: WalletPassResult = await callOrDependencyFailed(
    () =>
      deps.walletPass.generate(input.passType as WalletPassType, ticketData),
    deps.logger,
    {
      action: "walletPass.generate",
      ticketId: input.ticketId,
      passType: input.passType,
    },
  );

  // 6. Map result to output
  if (result.type === "apple") {
    return generateWalletPassOutputSchema.parse({
      passType: "apple",
      saveUrl: null,
      passBase64: result.passBuffer.toString("base64"),
      filename: result.filename,
    });
  }

  return generateWalletPassOutputSchema.parse({
    passType: "google",
    saveUrl: result.saveUrl,
    passBase64: null,
    filename: null,
  });
}
