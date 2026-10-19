import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  ResaleListingHoldOrder,
  ResaleListingHoldRef,
} from "@th/ports/repos/resale-listings";

import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";
import { CART_REAPER_PERIOD_SECONDS } from "../orders/_shared/cart-reaper-cycle";
import { DEFAULT_CART_TTL_SECONDS } from "../orders/release-expired-carts";

export type ExpireResaleListingsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Anomalies and per-listing failures of the stale-hold sweep. */
  reportError?: ReporterPort | null;
};

export type ExpireResaleListingsResult = {
  expiredCount: number;
  /** Stale holds released (listing out of HELD: ACTIVE, CANCELLED or EXPIRED). */
  releasedHoldCount: number;
  /** Of those, listings closed (CANCELLED / EXPIRED) instead of put on sale. */
  closedOnReleaseCount: number;
  /** Stale holds kept because an order for them is still PENDING or PROCESSING. */
  keptLiveHoldCount: number;
  /** Stale holds kept because an order for them was paid (reported). */
  keptPaidHoldCount: number;
  /** Stale holds the sweep threw on (reported; retried next pass). */
  failedHoldCount: number;
  /** HELD listings with no hold row (reported; nothing here can free them). */
  heldWithoutHoldCount: number;
};

/**
 * How long past its `heldUntil` a hold must be before the sweep looks at it.
 *
 * Not what keeps the sweep safe: that is the "no order still live" check
 * under the listing row lock, below. The grace keeps the sweep out of the
 * way of the paths that release a hold on time, so a hold it does find is
 * one they missed:
 *
 *  - `createResaleCheckout` is done within about 340 s of writing its order,
 *    and its idempotency claim lapses at 900 s.
 *  - The cart reaper cancels a PENDING order once it is older than
 *    `DEFAULT_CART_TTL_SECONDS` (1200 s), on a `CART_REAPER_PERIOD_SECONDS`
 *    (1800 s) cycle, so it reaches every order by its creation + 3000 s. A
 *    hold's `heldUntil` is never before its order's creation (the checkout
 *    refuses once the sale cutoff has passed), so that is at most
 *    `heldUntil` + 3000 s.
 *
 * One more reaper cycle and 600 s of slack on top: 5400 s.
 */
export const STALE_RESALE_HOLD_GRACE_SECONDS =
  DEFAULT_CART_TTL_SECONDS + 2 * CART_REAPER_PERIOD_SECONDS + 600;

/** Stale holds handled per pass. The job is hourly; a backlog drains over passes. */
const STALE_HOLD_SWEEP_LIMIT = 200;
/**
 * `jobCursors` key for the sweep's keyset cursor. Holds the sweep KEEPS
 * (a PENDING order the reaper cannot settle, a paid order) stay candidates,
 * so a scan that restarted at the oldest hold every pass would never see
 * past the first 200 of them. The cursor moves past what it kept and wraps
 * to the start after a short page (the `sweep-orphaned-uploads` pattern).
 */
export const STALE_HOLD_SWEEP_CURSOR_KEY = "tickets.expire-resale-listings.stale-holds";
/** HELD-without-hold listings named in one report. */
const HELD_WITHOUT_HOLD_REPORT_LIMIT = 50;

type SweepOutcome = "released" | "closed" | "gone" | "kept_live" | "kept_paid";

/**
 * Hourly background job.
 *
 * 1. Releases stale listing holds (the sweep below), so a listing whose
 *    checkout order is dead goes back on sale, or is closed if it can no
 *    longer be sold.
 * 2. Expires ACTIVE listings whose explicit `expiresAt` has passed, and
 *    restores their tickets to VALID in the same transaction (the adapter's
 *    `expireStale(now)`).
 *
 * A released listing already past its `expiresAt` goes straight to EXPIRED
 * inside `releaseHold`, in the release transaction. It must: checkout does
 * not read `expiresAt`, so a listing released to ACTIVE and expired by the
 * later step 2 could be held by a buyer in between, and step 2 skips HELD.
 *
 * ── The stale-hold sweep ──────────────────────────────────────────────────
 * Every canceller of a resale order releases its listing hold in the cancel
 * transaction (`releaseRetiredCartHolds`). The sweep is the backstop for a
 * hold nothing released: a checkout process killed between its order commit
 * and its unwind, an unwind whose release transaction failed, and holds
 * stranded before the cancellers released them.
 *
 * A hold is released only when its `heldUntil` is more than
 * `STALE_RESALE_HOLD_GRACE_SECONDS` in the past AND every order that took
 * THIS hold (same buyer, same listing, item `meta.holdExpiresAt` equal to
 * the hold's `heldUntil`, or unreadable) is CANCELLED. The order check runs
 * after `lockHold` has taken the ticket and listing row locks and confirmed
 * the hold is still the one listed: finalize's `resaleListings.commit` needs
 * both rows to sell the listing, so no order can finalize between the check
 * and the release. A CANCELLED order never becomes live again (no transition
 * leaves CANCELLED, and the resale link CAS needs PENDING), and no new order
 * for the listing can be written while it is HELD (`hold` needs ACTIVE).
 *
 * The sweep never cancels an order. A PENDING order past its hold is the
 * reaper's: it settles the PaymentIntent, cancels the order, and the cancel
 * releases the listing.
 *
 * Paged with a durable keyset cursor (`STALE_HOLD_SWEEP_CURSOR_KEY`): kept
 * holds stay candidates, so without it 200 of them would hide every newer
 * hold for good.
 */
export async function expireResaleListings(
  deps: ExpireResaleListingsDeps,
): Promise<ExpireResaleListingsResult> {
  const now = deps.clock.now();

  const sweep = await sweepStaleHolds(deps, now);

  const { expiredCount } = await deps.repos.resaleListings.expireStale(now);

  if (expiredCount > 0) {
    deps.logger?.info("expireResaleListings.completed", { expiredCount });
  }

  return { expiredCount, ...sweep };
}

async function sweepStaleHolds(
  deps: ExpireResaleListingsDeps,
  now: Date,
): Promise<Omit<ExpireResaleListingsResult, "expiredCount">> {
  const { logger } = deps;
  const counts = {
    releasedHoldCount: 0,
    closedOnReleaseCount: 0,
    keptLiveHoldCount: 0,
    keptPaidHoldCount: 0,
    failedHoldCount: 0,
    heldWithoutHoldCount: 0,
  };

  const heldBefore = new Date(
    now.getTime() - STALE_RESALE_HOLD_GRACE_SECONDS * 1000,
  );
  const after = await readSweepCursor(deps);
  const stale = await deps.repos.resaleListings.listExpiredHolds({
    heldBefore,
    limit: STALE_HOLD_SWEEP_LIMIT,
    after,
  });
  for (const hold of stale) {
    try {
      const outcome = await deps.repos.tx((tx) =>
        releaseStaleHold(tx, hold, now, deps),
      );
      if (outcome === "released") counts.releasedHoldCount++;
      else if (outcome === "closed") {
        counts.releasedHoldCount++;
        counts.closedOnReleaseCount++;
      } else if (outcome === "kept_live") counts.keptLiveHoldCount++;
      else if (outcome === "kept_paid") counts.keptPaidHoldCount++;
    } catch (err) {
      counts.failedHoldCount++;
      logger?.error("expireResaleListings.stale_hold_release_failed", {
        listingId: hold.listingId,
        buyerHumanId: hold.buyerHumanId,
        err,
      });
      reportBestEffort(deps.reportError, err, {
        tags: {
          area: "resale",
          useCase: "expireResaleListings",
          step: "sweepStaleHolds",
        },
        extra: {
          listingId: hold.listingId,
          buyerHumanId: hold.buyerHumanId,
          heldUntil: hold.heldUntil.toISOString(),
        },
      });
    }
  }

  // Written after the page, so a pass killed part-way rescans it. A short
  // page is the end of the candidate set: wrap to the start next pass. A
  // full one: resume after its last row.
  const last = stale[stale.length - 1];
  await writeSweepCursor(
    deps,
    stale.length < STALE_HOLD_SWEEP_LIMIT || !last
      ? null
      : { heldUntil: last.heldUntil, listingId: last.listingId },
  );

  // A HELD listing with no hold row cannot be bought (`hold` needs ACTIVE)
  // or freed by the fenced release. No writer leaves this state, so it is
  // drift: name it for a person rather than guess which buyer it was for.
  const heldWithoutHold = await deps.repos.resaleListings.listHeldWithoutHold(
    HELD_WITHOUT_HOLD_REPORT_LIMIT,
  );
  counts.heldWithoutHoldCount = heldWithoutHold.length;
  if (heldWithoutHold.length > 0) {
    logger?.error("expireResaleListings.held_without_hold", {
      listingIds: heldWithoutHold,
    });
    reportBestEffort(
      deps.reportError,
      new Error("resale_listing_held_without_hold"),
      {
        tags: {
          area: "resale",
          useCase: "expireResaleListings",
          step: "heldWithoutHold",
        },
        extra: { listingIds: heldWithoutHold },
      },
    );
  }

  if (stale.length > 0 || heldWithoutHold.length > 0) {
    logger?.info("expireResaleListings.stale_holds_swept", {
      scanned: stale.length,
      resumedFromCursor: after !== null,
      ...counts,
    });
  }

  return counts;
}

/**
 * Whether `order` may be the one that took THIS hold. An earlier purchase of
 * the same listing by the same buyer (a refunded sale the listing was
 * relisted after, via `unwindSale`) recorded a different `holdExpiresAt` and
 * is not this hold's business. An order with no parseable `holdExpiresAt`
 * cannot be ruled out, so it counts (the conservative direction: keep).
 */
function tookThisHold(order: ResaleListingHoldOrder, heldUntil: Date): boolean {
  if (order.holdExpiresAt === null) return true;
  const ms = new Date(order.holdExpiresAt).getTime();
  if (Number.isNaN(ms)) return true;
  return ms === heldUntil.getTime();
}

async function releaseStaleHold(
  tx: TxRepos,
  hold: ResaleListingHoldRef,
  now: Date,
  deps: ExpireResaleListingsDeps,
): Promise<SweepOutcome> {
  const fence = { buyerHumanId: hold.buyerHumanId, heldUntil: hold.heldUntil };

  // Takes the ticket row lock, then the listing row lock, for the rest of
  // this transaction, and confirms the hold is still the one the scan read.
  // Ticket first is the order `releaseHold`, `commit` and `cancelOpenForEvent`
  // take. Everything below runs with no finalize, link or canceller able to
  // move this listing.
  const stillHeld = await tx.resaleListings.lockHold(hold.listingId, fence);
  if (!stillHeld) return "gone";

  const orders = (
    await tx.resaleListings.listOrdersForHold(hold.listingId, hold.buyerHumanId)
  ).filter((order) => tookThisHold(order, hold.heldUntil));
  const live = orders.filter((order) => order.status !== "CANCELLED");

  if (live.length > 0) {
    const unpaid = live.every(
      (order) => order.status === "PENDING" || order.status === "PROCESSING",
    );
    if (unpaid) {
      // The reaper's (PENDING) or the delayed payment's (PROCESSING). The
      // reaper reports a cart it cannot settle; nothing to add here.
      return "kept_live";
    }
    // A paid order whose listing is still HELD: finalize should have sold
    // it. Never release a listing someone paid for; tell a person.
    const liveOrders = live.map(({ id, status }) => ({ id, status }));
    deps.logger?.error("expireResaleListings.stale_hold_paid_order", {
      listingId: hold.listingId,
      buyerHumanId: hold.buyerHumanId,
      orders: liveOrders,
    });
    reportBestEffort(
      deps.reportError,
      new Error("resale_stale_hold_has_paid_order"),
      {
        tags: {
          area: "resale",
          useCase: "expireResaleListings",
          step: "sweepStaleHolds.paidOrder",
        },
        extra: {
          listingId: hold.listingId,
          buyerHumanId: hold.buyerHumanId,
          heldUntil: hold.heldUntil.toISOString(),
          orders: liveOrders,
        },
      },
    );
    return "kept_paid";
  }

  const released = await tx.resaleListings.releaseHold(hold.listingId, fence, {
    now,
  });
  if (!released.released) return "gone";

  await tx.audit.log({
    entity: "resale_listing",
    entityId: hold.listingId,
    action: "resale_listing_stale_hold_released",
    data: {
      buyerHumanId: hold.buyerHumanId,
      heldUntil: hold.heldUntil.toISOString(),
      cancelledOrderIds: orders.map((order) => order.id),
      // ACTIVE = back on sale; CANCELLED / EXPIRED = closed instead.
      listingStatus: released.listingStatus,
      ...("reason" in released ? { closeReason: released.reason } : {}),
    },
    at: now,
  });
  return released.listingStatus === "ACTIVE" ? "released" : "closed";
}

/**
 * The stored cursor, or null (start from the oldest hold). Tolerant: a value
 * it cannot parse, or a read that fails, restarts the scan rather than
 * stopping the sweep (one extra pass is the cost).
 */
async function readSweepCursor(
  deps: ExpireResaleListingsDeps,
): Promise<{ heldUntil: Date; listingId: string } | null> {
  let raw: unknown;
  try {
    raw = await deps.repos.jobCursors.get(STALE_HOLD_SWEEP_CURSOR_KEY);
  } catch (err) {
    deps.logger?.error("expireResaleListings.cursor_read_failed", { err });
    reportBestEffort(deps.reportError, err, {
      tags: { area: "resale", useCase: "expireResaleListings", step: "cursorRead" },
      extra: { effect: "restarted the stale-hold scan from the oldest hold" },
    });
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { heldUntil, listingId } = raw as {
    heldUntil?: unknown;
    listingId?: unknown;
  };
  if (typeof listingId !== "string" || listingId.length === 0) return null;
  if (typeof heldUntil !== "string") return null;
  const parsed = new Date(heldUntil);
  if (Number.isNaN(parsed.getTime())) return null;
  return { heldUntil: parsed, listingId };
}

/** Persist the resume point. Never fails the pass: worst case it rescans. */
async function writeSweepCursor(
  deps: ExpireResaleListingsDeps,
  next: { heldUntil: Date; listingId: string } | null,
): Promise<void> {
  try {
    await deps.repos.jobCursors.set(
      STALE_HOLD_SWEEP_CURSOR_KEY,
      next
        ? { heldUntil: next.heldUntil.toISOString(), listingId: next.listingId }
        : null,
    );
  } catch (err) {
    deps.logger?.error("expireResaleListings.cursor_write_failed", { err, next });
    reportBestEffort(deps.reportError, err, {
      tags: { area: "resale", useCase: "expireResaleListings", step: "cursorWrite" },
      extra: { effect: "next pass restarts from the oldest hold" },
    });
  }
}
