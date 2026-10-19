import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { formatCents } from "../../lib/currency-utils";
import { trimTrailingSlash } from "../../lib/url";
import { buildDirectInAppNotice } from "../comms/direct-in-app";
import {
  resaleSellerSoldRenderer,
  type ResaleSellerSoldPayload,
} from "../comms/direct-money-safety-renderers";

// ── Types ──────────────────────────────────────────────────────────────────

export type NotifyResaleSellerSoldDeps = {
  repos: Repos;
  mailer: MailerPort;
  logger?: LoggerPort;
  /**
   * Reports an in-app row whose render payload could not be stored (it then
   * stays English for every reader); see `buildDirectInAppNotice`.
   */
  reportError?: ReporterPort | null;
};

export type NotifyResaleSellerSoldParams = {
  orderId: string;
  listingId: string;
  publicAppUrl: string;
};

/**
 * Sends a "Your ticket sold!" email + in-app notification to the seller
 * after a resale purchase has been finalized.
 *
 * Fires after `finalizeResalePurchase` succeeds. This is fire-and-forget —
 * failures are logged, never thrown.
 */
export async function notifyResaleSellerSold(
  deps: NotifyResaleSellerSoldDeps,
  params: NotifyResaleSellerSoldParams,
): Promise<void> {
  const logger = deps.logger?.child({ notify: "seller_sold" });

  try {
    // ── Load listing to get seller + price ────────────────────────────────
    const listing = await deps.repos.resaleListings.getById(params.listingId);
    if (!listing) {
      logger?.warn("notify.seller_sold.listing_not_found", {
        listingId: params.listingId,
      });
      return;
    }

    // ── Load seller identity ──────────────────────────────────────────────
    const sellerWithIdentity = await deps.repos.humans.getByIdWithIdentity(
      listing.sellerHumanId,
    );
    if (!sellerWithIdentity) {
      logger?.warn("notify.seller_sold.seller_not_found", {
        sellerHumanId: listing.sellerHumanId,
      });
      return;
    }
    const { identity } = sellerWithIdentity;

    // ── Load event for context ────────────────────────────────────────────
    const event = await deps.repos.events.getById(listing.eventId);
    const eventTitle = event?.title ?? "your event";

    const publicAppUrl = trimTrailingSlash(params.publicAppUrl);

    // ── Format sale amount ────────────────────────────────────────────────
    const saleCents = listing.askPriceCents;
    const formattedAmount = formatCents(saleCents, listing.currency);

    // ── Create in-app notification ────────────────────────────────────────
    // English text + template for the reader's language
    // (comms/direct-money-safety-renderers.ts).
    const payload: ResaleSellerSoldPayload = {
      listingId: params.listingId,
      orderId: params.orderId,
      eventTitle: event?.title ?? null,
      amountCents: saleCents,
      currency: listing.currency,
      resaleUrl: `${publicAppUrl}/my/resale`,
    };
    const row = buildDirectInAppNotice(
      { logger, reportError: deps.reportError },
      resaleSellerSoldRenderer,
      payload,
      { useCase: "resale.notifyResaleSellerSold" },
    );
    await deps.repos.notifications?.create({
      humanId: listing.sellerHumanId,
      title: row.title,
      body: row.body,
      kind: row.kind,
      metadata: { variant: row.variant },
      tags: ["resale", "sale"],
      ...(row.action ? { action: row.action } : {}),
      template: row.template ?? null,
    });

    // ── Send email ────────────────────────────────────────────────────────
    await deps.mailer.send({
      to: { to: identity.email },
      subject: `Your ticket for ${eventTitle} has been sold!`,
      text: [
        `Great news! Your ticket for ${eventTitle} has been sold for ${formattedAmount}.`,
        "",
        "What happens next:",
        `  - The buyer now has the ticket with a new QR code.`,
        `  - Your payout will be processed after the event ends.`,
        `  - You can track your resale activity at ${publicAppUrl}/my/resale`,
        "",
        "Thanks for using Ithas Fire!",
      ].join("\n"),
      idempotencyKey: `resale-seller-sold:${params.listingId}`,
    });

    logger?.info("notify.seller_sold.sent", {
      listingId: params.listingId,
      sellerHumanId: listing.sellerHumanId,
      sellerEmail: identity.email,
      salePriceCents: saleCents,
    });
  } catch (err) {
    logger?.warn("notify.seller_sold.failed", {
      error: err instanceof Error ? err.message : String(err),
      listingId: params.listingId,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "resale.notifyResaleSellerSold" },
        extra: { listingId: params.listingId },
      });
    } catch {
      // A throwing reporter must never change the (swallowed) outcome.
    }
  }
}
