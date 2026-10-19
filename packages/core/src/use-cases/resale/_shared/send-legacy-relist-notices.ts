import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import { buildDirectInAppNotice } from "../../comms/direct-in-app";
import { resaleSaleRefundedListingClosedRenderer } from "../../comms/direct-money-safety-renderers";
import type { LegacyRelistNotice } from "../unwind-resale-order-after-refund";
import { relistUrl } from "./relist-url";

const USE_CASE = "sendLegacyRelistNotices";

/**
 * Tells each seller whose listing a refund closed (it was priced under the
 * removed markup split, organiser-resale-share FR-015) that the buyer was
 * refunded, the sale will not be paid, and how to list the ticket again.
 *
 * Call it AFTER the refund's transaction has committed, with the notices
 * `unwindResaleOrderAfterRefund` returned. It never throws: the refund has
 * already happened, and a notice must never undo or block it. Each failure
 * (and a missing app URL, which leaves the seller untold) is logged and
 * reported, guarded so a throwing reporter changes nothing.
 *
 * Sent once: only an unwind that ran returns notices. A replay finds the
 * order already unwound (or already REFUNDED, for the `charge.refunded`
 * webhook that follows a refund made here) and returns none.
 */
export async function sendLegacyRelistNotices(
  deps: {
    repos: Pick<Repos, "events" | "notifications">;
    clock: ClockPort;
    publicAppUrl?: string | null;
    logger?: LoggerPort;
    reportError?: ReporterPort | null;
  },
  notices: readonly LegacyRelistNotice[],
): Promise<void> {
  for (const notice of notices) {
    const extra = {
      listingId: notice.listingId,
      refundedOrderId: notice.refundedOrderId,
      sellerHumanId: notice.sellerHumanId,
    };
    try {
      if (!deps.publicAppUrl) {
        throw new Error("legacy_relist_notice_no_public_app_url");
      }
      const now = deps.clock.now();
      const event = await deps.repos.events.getById(notice.eventId);
      const row = buildDirectInAppNotice(
        { logger: deps.logger, reportError: deps.reportError ?? undefined },
        resaleSaleRefundedListingClosedRenderer,
        {
          listingId: notice.listingId,
          eventTitle: event?.title ?? null,
          askPriceCents: notice.askPriceCents,
          currency: notice.currency,
          resaleUrl: relistUrl(deps.publicAppUrl, notice.sellerOrderId),
        },
        { useCase: USE_CASE, now },
      );
      await deps.repos.notifications?.create({
        humanId: notice.sellerHumanId,
        title: row.title,
        body: row.body,
        kind: row.kind,
        metadata: { variant: row.variant },
        tags: ["resale", "listing", "refund"],
        ...(row.action ? { action: row.action } : {}),
        template: row.template ?? null,
      });
    } catch (err) {
      try {
        deps.logger?.error(`${USE_CASE}.failed`, { ...extra, err });
      } catch {
        // A throwing logger must never change behaviour either.
      }
      reportBestEffort(deps.reportError, err, {
        tags: { useCase: USE_CASE, reason: "notice_failed" },
        extra,
      });
    }
  }
}
