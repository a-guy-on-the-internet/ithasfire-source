import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ResaleListingRecord } from "@th/ports/repos/resale-listings";
import type { ReporterPort } from "@th/ports/reporter";

import { parseInput } from "../../lib/io";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";
import { requirePlatformStaff } from "../../lib/rbac";
import { buildDirectInAppNotice } from "../comms/direct-in-app";
import { RESALE_LISTING_CLOSED_RELIST_COPY } from "../comms/copy/resale-direct";
import { resaleListingClosedRelistRenderer } from "../comms/direct-money-safety-renderers";
import { resolveNotificationLocale } from "../comms/locale";
import { cancelActiveListingInTx } from "./_shared/cancel-active-listing";
import { relistUrl } from "./_shared/relist-url";

/**
 * Cancels the live resale listings priced under the markup split, with a
 * notice to each seller to list again (organiser-resale-share FR-015).
 *
 * The markup split is gone (FR-014). A listing without an event share
 * (`eventShareCents` NULL) can no longer be bought: checkout refuses it with
 * RESALE_TERMS_MISSING before any hold or charge. Left alone it would sit
 * on sale forever, and the migration that drops the markup columns
 * (`20261013180000_resale_markup_split_removed`) refuses to run while one is
 * ACTIVE or HELD. A migration cannot send a notice, so this does the cancel.
 *
 * Platform ADMIN only (through `platformJobs.*`, which also takes the staff
 * second factor). `dryRun` (the default) only reports what it would do.
 *
 * Per listing, in ONE transaction:
 *   - the same cancel a seller's own cancel runs (`cancelActiveListingInTx`):
 *     ticket lock, ACTIVE → CANCELLED as a compare-and-swap, ticket LISTED →
 *     VALID, the purchase item's "listed now" pointer cleared;
 *   - an audit row (`cancelled_markup_split_removed`, naming the actor);
 *   - the seller's in-app notice, so the cancel and its notice land together.
 * Then, after the commit, the email (keyed per listing, so a retry never
 * sends it twice).
 *
 * HELD listings are skipped and counted: a buyer is mid-checkout, holding a
 * PaymentIntent. `cancelResaleListing`'s compare-and-swap refuses a HELD
 * listing for the same reason. The hold ends one of two ways: the cart
 * reaper settles the PaymentIntent and releases the listing back to ACTIVE
 * (the next run cancels it), or the buyer pays. A paid order priced under
 * the markup split cannot be finalized by this code and fails closed
 * (`resolveResaleSellerSplit`, RESALE_PURCHASE_PRICE_UNKNOWN: webhook DLQ
 * plus an error report), never paid out on a guessed split. The migration's
 * README says to let such checkouts finish before deploying.
 *
 * Idempotent: a cancelled listing is no longer live, so a second run finds
 * nothing to do. A listing that changed under us (held, sold, or given a
 * share) is left as it is and counted.
 *
 * A listing whose cancel throws is rolled back, reported and counted
 * (`failedListingIds`); the run carries on with the next one.
 */

export const CANCEL_LEGACY_RESALE_LISTINGS_ROLES = ["ADMIN"] as const;

/** Rows read per page, and the most one run looks at. */
const PAGE_SIZE = 100;
const MAX_EXAMINED = 1000;

export const cancelLegacyResaleListingsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /** Report only. Defaults to true: an apply must be asked for. */
    dryRun: z.boolean().default(true),
  })
  .strict();

export const cancelLegacyResaleListingsOutputSchema = z
  .object({
    dryRun: z.boolean(),
    /** Live listings without an event share that this run looked at. */
    examinedCount: z.number().int().nonnegative(),
    /** Cancelled (or, on a dry run, that would be). */
    cancelledListingIds: z.array(z.string()),
    /** HELD: a checkout is in flight. Run again once the hold is released. */
    heldListingIds: z.array(z.string()),
    /** Changed under the run (held, sold or closed since the read). */
    changedListingIds: z.array(z.string()),
    /** The cancel threw and was rolled back (reported). */
    failedListingIds: z.array(z.string()),
    /** More live listings without a share remain past MAX_EXAMINED. */
    hasMore: z.boolean(),
  })
  .strict();

export type CancelLegacyResaleListingsInput = z.input<
  typeof cancelLegacyResaleListingsInputSchema
>;
export type CancelLegacyResaleListingsOutput = z.infer<
  typeof cancelLegacyResaleListingsOutputSchema
>;

export type CancelLegacyResaleListingsDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  /** Absent: no email (the in-app notice is still written). */
  mailer?: MailerPort | null;
  publicAppUrl?: string | null;
  logger?: LoggerPort;
  /**
   * A listing whose cancel failed, and a notice email that failed, are both
   * swallowed so the run carries on: this is how they reach Sentry.
   */
  reportError?: ReporterPort | null;
};

const USE_CASE = "resale.cancelLegacyResaleListings";
const AUDIT_ACTION = "cancelled_markup_split_removed";

export async function cancelLegacyResaleListings(
  deps: CancelLegacyResaleListingsDeps,
  rawInput: unknown,
): Promise<CancelLegacyResaleListingsOutput> {
  const input = parseInput(cancelLegacyResaleListingsInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: CANCEL_LEGACY_RESALE_LISTINGS_ROLES,
  });

  const listings: ResaleListingRecord[] = [];
  let afterId: string | null = null;
  let hasMore = false;
  for (;;) {
    const page = await deps.repos.resaleListings.listLiveWithoutShare({
      limit: PAGE_SIZE,
      afterId,
    });
    listings.push(...page);
    if (page.length < PAGE_SIZE) break;
    if (listings.length >= MAX_EXAMINED) {
      hasMore = true;
      break;
    }
    afterId = page[page.length - 1]!.id;
  }

  const out: CancelLegacyResaleListingsOutput = {
    dryRun: input.dryRun,
    examinedCount: listings.length,
    cancelledListingIds: [],
    heldListingIds: [],
    changedListingIds: [],
    failedListingIds: [],
    hasMore,
  };

  for (const listing of listings) {
    if (listing.status === "HELD") {
      out.heldListingIds.push(listing.id);
      continue;
    }
    if (input.dryRun) {
      out.cancelledListingIds.push(listing.id);
      continue;
    }

    let outcome: CancelOutcome;
    try {
      outcome = await cancelOne(deps, {
        listingId: listing.id,
        actorHumanId: input.actorHumanId,
      });
    } catch (err) {
      out.failedListingIds.push(listing.id);
      const extra = { listingId: listing.id, eventId: listing.eventId };
      deps.logger?.error(`${USE_CASE}.cancel_failed`, { ...extra, err });
      reportBestEffort(deps.reportError, err, {
        tags: { useCase: USE_CASE, reason: "cancel_failed" },
        extra,
      });
      continue;
    }

    if (outcome.kind === "held") {
      out.heldListingIds.push(listing.id);
    } else if (outcome.kind === "changed") {
      out.changedListingIds.push(listing.id);
    } else {
      out.cancelledListingIds.push(listing.id);
      await emailSeller(deps, outcome.notice);
    }
  }

  deps.logger?.info(`${USE_CASE}.done`, {
    actorHumanId: input.actorHumanId,
    dryRun: out.dryRun,
    examinedCount: out.examinedCount,
    cancelledCount: out.cancelledListingIds.length,
    heldCount: out.heldListingIds.length,
    changedCount: out.changedListingIds.length,
    failedCount: out.failedListingIds.length,
    hasMore: out.hasMore,
  });

  return cancelLegacyResaleListingsOutputSchema.parse(out);
}

type SellerNotice = {
  listingId: string;
  sellerHumanId: string;
  eventTitle: string | null;
  askPriceCents: number;
  currency: string;
  resaleUrl: string;
};

type CancelOutcome =
  | { kind: "cancelled"; notice: SellerNotice }
  | { kind: "held" }
  | { kind: "changed" };

async function cancelOne(
  deps: CancelLegacyResaleListingsDeps,
  params: { listingId: string; actorHumanId: string },
): Promise<CancelOutcome> {
  const now = deps.clock.now();
  return deps.repos.tx(async (tx) => {
    // Re-read inside the transaction: the page above was unlocked.
    const listing = await tx.resaleListings.getById(params.listingId);
    if (!listing || listing.eventShareCents != null) {
      return { kind: "changed" };
    }
    if (listing.status === "HELD") return { kind: "held" };
    if (listing.status !== "ACTIVE") return { kind: "changed" };

    if (!(await cancelActiveListingInTx(tx, listing))) {
      // Lost the compare-and-swap: a buyer held it since the read above.
      const fresh = await tx.resaleListings.getById(listing.id);
      return fresh?.status === "HELD" ? { kind: "held" } : { kind: "changed" };
    }

    await tx.audit.log({
      entity: "resale_listing",
      entityId: listing.id,
      action: AUDIT_ACTION,
      data: {
        ticketId: listing.ticketId,
        eventId: listing.eventId,
        sellerHumanId: listing.sellerHumanId,
        actorHumanId: params.actorHumanId,
        askPriceCents: listing.askPriceCents,
        reason: "resale_markup_split_removed",
      },
      at: now,
    });

    // The link opens the new-listing form on the order holding the ticket.
    const ticket = await tx.tickets.getById(listing.ticketId);
    const holderItem = ticket?.orderItemId
      ? await tx.orderItems.getById(ticket.orderItemId)
      : null;
    const event = await tx.events.getById(listing.eventId);
    const notice: SellerNotice = {
      listingId: listing.id,
      sellerHumanId: listing.sellerHumanId,
      eventTitle: event?.title ?? null,
      askPriceCents: listing.askPriceCents,
      currency: listing.currency,
      resaleUrl: relistUrl(deps.publicAppUrl, holderItem?.orderId ?? null),
    };

    // The in-app notice commits with the cancel: a seller whose listing was
    // closed is always told, whatever happens to the email below.
    const row = buildDirectInAppNotice(
      { logger: deps.logger, reportError: deps.reportError },
      resaleListingClosedRelistRenderer,
      {
        listingId: notice.listingId,
        eventTitle: notice.eventTitle,
        askPriceCents: notice.askPriceCents,
        currency: notice.currency,
        resaleUrl: notice.resaleUrl,
      },
      { useCase: USE_CASE, now },
    );
    await tx.notifications?.create({
      humanId: listing.sellerHumanId,
      title: row.title,
      body: row.body,
      kind: row.kind,
      metadata: { variant: row.variant },
      tags: ["resale", "listing"],
      ...(row.action ? { action: row.action } : {}),
      template: row.template ?? null,
    });

    return { kind: "cancelled", notice };
  });
}

/**
 * The email, after the cancel committed. Best effort: the in-app notice is
 * already written. Keyed per listing, so a retried run never sends twice.
 */
async function emailSeller(
  deps: CancelLegacyResaleListingsDeps,
  notice: SellerNotice,
): Promise<void> {
  if (!deps.mailer) return;
  try {
    const seller = await deps.repos.humans.getByIdWithIdentity(
      notice.sellerHumanId,
    );
    const email = seller?.identity.email;
    if (!email) return;
    // In the seller's stored language, from the same copy as the in-app
    // notice.
    const locale = resolveNotificationLocale(seller.human.locale);
    const copy = RESALE_LISTING_CLOSED_RELIST_COPY[locale];
    const body = resaleListingClosedRelistRenderer.render(
      {
        listingId: notice.listingId,
        eventTitle: notice.eventTitle,
        askPriceCents: notice.askPriceCents,
        currency: notice.currency,
        resaleUrl: notice.resaleUrl,
      },
      { now: deps.clock.now(), locale },
    ).inApp?.body;
    await deps.mailer.send({
      to: { to: email },
      subject: copy.emailSubject({ eventTitle: notice.eventTitle }),
      text: [
        body ?? copy.title,
        "",
        copy.emailLink(notice.resaleUrl),
        "",
        copy.emailSignoff,
      ].join("\n"),
      idempotencyKey: `resale-listing-closed-relist:${notice.listingId}`,
    });
  } catch (err) {
    const extra = { listingId: notice.listingId };
    deps.logger?.error(`${USE_CASE}.email_failed`, { ...extra, err });
    reportBestEffort(deps.reportError, err, {
      tags: { useCase: USE_CASE, reason: "email_failed" },
      extra,
    });
  }
}
