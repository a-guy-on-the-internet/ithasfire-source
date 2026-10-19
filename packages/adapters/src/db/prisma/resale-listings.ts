import { Prisma } from "@prisma/client";
import type {
  ResaleListingReleaseResult,
  ResaleListingsRepo,
} from "@th/ports/repos/resale-listings";
import type {
  EnrichedResaleListingRecord,
  ResaleListingTicketFacts,
  ResaleListingRecord,
  ResaleListingStatus,
} from "@th/types/repos/resale-listings";
import {
  buildOffsetPaginatedResult,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";

import type { ResaleSharePayer } from "@th/types/repos/payout-terms";

import type { PrismaClientOrTx } from "./types";

/** Map a Prisma row to the port record type. */
/**
 * The ticket facts a listing read shows beside the share: the purchase item's
 * recorded original price and the ticket type's STORED pricing (the core
 * resolves the list price in force with `resolveUnitPriceCents`).
 */
const TICKET_FACTS_SELECT = {
  ticketType: {
    select: {
      id: true,
      name: true,
      priceCents: true,
      scheduledPriceCents: true,
      scheduledPriceAt: true,
      pricingMode: true,
      minimumCents: true,
    },
  },
  orderItem: {
    select: { unitPriceCents: true, originalUnitPriceCents: true },
  },
} as const;

function ticketFactsOf(
  ticket: {
    orderItem?: { originalUnitPriceCents: number | null } | null;
    ticketType?: {
      priceCents: number;
      scheduledPriceCents: number | null;
      scheduledPriceAt: Date | null;
      pricingMode: "FIXED" | "ADJUSTABLE";
      minimumCents: number | null;
    } | null;
  } | null,
): ResaleListingTicketFacts {
  return {
    originalPriceCents: ticket?.orderItem?.originalUnitPriceCents ?? null,
    ticketTypePricing: ticket?.ticketType
      ? {
          priceCents: ticket.ticketType.priceCents,
          scheduledPriceCents: ticket.ticketType.scheduledPriceCents ?? null,
          scheduledPriceAt: ticket.ticketType.scheduledPriceAt ?? null,
          pricingMode: ticket.ticketType.pricingMode,
          minimumCents: ticket.ticketType.minimumCents ?? null,
        }
      : null,
  };
}

function toRecord(row: {
  id: string;
  ticketId: string;
  eventId: string;
  sellerHumanId: string;
  askPriceCents: number;
  faceValueCents: number | null;
  processingPassThroughCents: number;
  processingFeeConfigRef: unknown;
  saleCutoffAt: Date | null;
  payoutReleaseAt: Date | null;
  currency: string;
  status: string;
  expiresAt: Date | null;
  source: string;
  externalRef: unknown;
  resalePayoutTermsId: string | null;
  // Optional so a narrowed row (raw SQL, older selects) still maps.
  eventShareCents?: number | null;
  sharePayer?: ResaleSharePayer | null;
  buyerOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ResaleListingRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    eventId: row.eventId,
    sellerHumanId: row.sellerHumanId,
    askPriceCents: row.askPriceCents,
    faceValueCents: row.faceValueCents,
    processingPassThroughCents: row.processingPassThroughCents,
    processingFeeConfigRef:
      (row.processingFeeConfigRef as string | null) ?? null,
    saleCutoffAt: row.saleCutoffAt,
    payoutReleaseAt: row.payoutReleaseAt,
    currency: row.currency,
    status: row.status as ResaleListingStatus,
    expiresAt: row.expiresAt,
    source: row.source,
    externalRef: row.externalRef,
    resalePayoutTermsId: row.resalePayoutTermsId,
    // FR-005 share and payer (organiser-resale-share).
    eventShareCents: row.eventShareCents ?? null,
    sharePayer: row.sharePayer ?? null,
    buyerOrderId: row.buyerOrderId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The SQL-only partial unique index: one ACTIVE/HELD listing per ticket. */
const LIVE_LISTING_INDEX = "Listing_ticketId_live_key";

/**
 * Is this P2002 the one-live-listing index, and not some other unique
 * constraint on "Listing" (`id`, `buyerOrderId`, or one added later)?
 *
 * Under `@prisma/adapter-pg` a `create` reports (pinned against Postgres in
 * test/integration/resale-listings-relist.test.ts):
 *
 *   meta.driverAdapterError.cause = {
 *     originalCode: "23505",
 *     originalMessage: 'duplicate key value violates unique constraint "Listing_ticketId_live_key"',
 *     constraint: { fields: ['"ticketId"'] },   // quoted, parsed from DETAIL
 *   }
 *
 * The constraint name is only inside the message text, so it is read first
 * and the column list second (`ticketId` alone is this index: no other
 * unique constraint is on that column). The query-engine shape
 * (`meta.target`) is read the same way. A P2002 that names neither is still
 * treated as this index, the mapping this had before it could tell: a race
 * loser must not become a 500 because a driver upgrade dropped the detail.
 */
function isLiveListingUniqueViolation(
  error: Prisma.PrismaClientKnownRequestError,
): boolean {
  const meta = (error.meta ?? {}) as {
    target?: unknown;
    driverAdapterError?: {
      cause?: {
        originalMessage?: unknown;
        constraint?: { fields?: unknown; index?: unknown };
      };
    };
  };
  const cause = meta.driverAdapterError?.cause;

  const namedInMessage =
    typeof cause?.originalMessage === "string"
      ? cause.originalMessage.match(/unique constraint "([^"]+)"/)?.[1]
      : undefined;
  const indexName =
    namedInMessage ??
    (typeof cause?.constraint?.index === "string"
      ? cause.constraint.index
      : undefined) ??
    (typeof meta.target === "string" ? meta.target : undefined);
  if (indexName !== undefined) return indexName === LIVE_LISTING_INDEX;

  const fields = Array.isArray(cause?.constraint?.fields)
    ? cause.constraint.fields
    : Array.isArray(meta.target)
      ? meta.target
      : undefined;
  if (fields !== undefined) {
    return (
      fields.length === 1 && String(fields[0]).replace(/"/g, "") === "ticketId"
    );
  }

  return true;
}

/**
 * A P2002 from the SQL-only partial unique index "Listing_ticketId_live_key"
 * (one ACTIVE/HELD listing per ticket; see resale.prisma and migration
 * 20261011120000_listing_live_unique_per_ticket) means a racing create for
 * the same ticket committed first. Re-thrown as a domain conflict so the race
 * loser is refused the way the use-case pre-check refuses, never a 500. A
 * unique violation on any other constraint is not relabelled.
 */
function rethrowLiveListingConflict(error: unknown, ticketId: string): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    isLiveListingUniqueViolation(error)
  ) {
    throw {
      code: "conflict",
      message: "resale_listing_live_exists",
      ticketId,
      cause: error,
    } as const;
  }
  throw error;
}

const LIVE_LISTING_STATUSES = ["ACTIVE", "HELD"] as const;

export function makeResaleListingsRepo(
  p: PrismaClientOrTx,
): ResaleListingsRepo {
  return {
    // ── Existing: hold / commit / cancel ──

    hold: async (listingId, buyerHumanId, heldUntil) => {
      // CAS ACTIVE → HELD first. It takes the listing row lock before the
      // hold row is written (the order every hold writer uses), and a
      // listing a racing `cancelOpenForEvent` / `expireStale` / seller
      // cancel just closed flips 0 rows instead of being overwritten back
      // to HELD. The caller's transaction refuses on `ok: false`.
      const flipped = await p.resaleListing.updateMany({
        where: { id: listingId, status: "ACTIVE" },
        data: { status: "HELD" },
      });
      if (flipped.count !== 1) return { ok: false };
      // An ACTIVE listing with a hold row left behind (data drift) is
      // refused, as before; the caller's transaction then rolls the flip
      // above back. (The unique `listingId` would refuse it too, as a P2002.)
      const existing = await p.resaleListingHold.findUnique({
        where: { listingId },
      });
      if (existing) return { ok: false };
      await p.resaleListingHold.create({
        data: { listingId, buyerHumanId, heldUntil },
      });
      return { ok: true };
    },

    commit: async (listingId, buyerHumanId, buyerOrderId) => {
      const listing = await p.resaleListing.findUnique({
        where: { id: listingId },
        include: { hold: true },
      });
      if (!listing) return { ok: false };
      // A listing that is terminally closed (event cancelled under the
      // buyer via `cancelOpenForEvent`, or expired) has NO hold — but that
      // must not read as the idempotent "already committed" replay the
      // finalizer treats `ok: false` as, or the buyer's paid order is
      // marked SUCCEEDED with no ticket. Throw so the finalize tx aborts
      // and the paid order lands in the DLQ for manual review.
      if (listing.status === "CANCELLED" || listing.status === "EXPIRED") {
        throw {
          code: "conflict",
          message: "resale_listing_not_sellable",
          listingId,
          buyerOrderId,
          listingStatus: listing.status,
        } as const;
      }
      if (!listing.hold) return { ok: false };
      if (listing.hold.buyerHumanId !== buyerHumanId) return { ok: false };
      const ticketId = listing.ticketId;
      // Lock order: ticket row FIRST, then the listing row. Mirrored by
      // `cancelOpenForEvent` so the two never deadlock.
      await p.ticket.update({
        where: { id: ticketId },
        data: { ownerHumanId: buyerHumanId },
      });
      await p.ticketTransfer.create({
        data: {
          ticketId,
          fromHumanId: listing.sellerHumanId,
          toHumanId: buyerHumanId,
          reason: "resale",
          orderId: null,
        },
      });
      // Status-conditional CAS: if this blocked on a row lock held by a
      // cancelling tx, Postgres re-evaluates the WHERE against the committed
      // row (now CANCELLED) and flips 0 rows — never SOLD over CANCELLED.
      const committed = await p.resaleListing.updateMany({
        where: { id: listingId, status: "HELD" },
        data: { status: "SOLD", buyerOrderId },
      });
      if (committed.count !== 1) {
        throw {
          code: "conflict",
          message: "resale_listing_commit_mismatch",
          listingId,
          buyerOrderId,
        } as const;
      }
      await p.resaleListingHold.deleteMany({ where: { listingId } });
      return { ok: true, ticketId };
    },

    cancelHold: async (listingId) => {
      // Listing row before the hold row, the order `hold`, `commit`,
      // `cancelOpenForEvent`, `releaseHold` and `assertHeldBy` all use.
      //
      // HELD → ACTIVE as a compare-and-swap. An unconditional write would
      // put a SOLD / CANCELLED / EXPIRED listing back on sale, and now that a
      // ticket keeps one row per listing, that past row can sit beside a
      // newer live one (it would then fail on "Listing_ticketId_live_key").
      // HELD → ACTIVE stays inside the ticket's one live slot.
      const reopened = await p.resaleListing.updateMany({
        where: { id: listingId, status: "HELD" },
        data: { status: "ACTIVE" },
      });
      if (reopened.count !== 1) {
        // Missing, or no longer HELD. The unconditional `update` this
        // replaces threw for a missing row; it still throws, and nothing
        // (the hold row included) is written.
        throw {
          code: "conflict",
          message: "resale_listing_cancel_hold_mismatch",
          listingId,
        } as const;
      }
      await p.resaleListingHold.deleteMany({ where: { listingId } });
    },

    closeHeld: async (listingId) => {
      // Listing row before the hold row, as every hold writer does. HELD →
      // CANCELLED as a compare-and-swap: the caller holds the ticket row
      // lock, so nothing can have taken the listing out of HELD, but a row
      // that is not HELD is never written all the same.
      const closed = await p.resaleListing.updateMany({
        where: { id: listingId, status: "HELD" },
        data: { status: "CANCELLED" },
      });
      if (closed.count !== 1) return { closed: false, hold: null };
      const hold = await p.resaleListingHold.findUnique({
        where: { listingId },
        select: { buyerHumanId: true, heldUntil: true },
      });
      await p.resaleListingHold.deleteMany({ where: { listingId } });
      return { closed: true, hold };
    },

    assertHeldBy: async (listingId, { buyerHumanId, heldUntil }) => {
      // A same-value conditional UPDATE: it takes the listing row lock for
      // the rest of the caller's transaction, and if it had to wait for a
      // cancelling transaction, READ COMMITTED re-evaluates `status` against
      // the committed row (CANCELLED → 0 rows).
      const locked = await p.resaleListing.updateMany({
        where: { id: listingId, status: "HELD" },
        data: { status: "HELD" },
      });
      if (locked.count !== 1) return false;
      // Under the lock: every writer that removes a hold (`commit`,
      // `cancelOpenForEvent`, `releaseHold`, `cancelHold`) takes this listing
      // row first, so the hold read here cannot be deleted before the caller
      // commits.
      const hold = await p.resaleListingHold.findUnique({
        where: { listingId },
      });
      return (
        hold != null &&
        hold.buyerHumanId === buyerHumanId &&
        hold.heldUntil.getTime() === heldUntil.getTime()
      );
    },

    releaseHold: async (listingId, fence, opts) =>
      releaseHeldListing(p, listingId, fence, opts?.now ?? new Date()),

    lockHold: async (listingId, fence) => {
      if (!(await lockListingTicket(p, listingId))) return false;
      // Now the listing row (and the fence check), as `assertHeldBy` does.
      const locked = await p.resaleListing.updateMany({
        where: { id: listingId, status: "HELD" },
        data: { status: "HELD" },
      });
      if (locked.count !== 1) return false;
      const hold = await p.resaleListingHold.findUnique({
        where: { listingId },
      });
      return (
        hold != null &&
        hold.buyerHumanId === fence.buyerHumanId &&
        hold.heldUntil.getTime() === fence.heldUntil.getTime()
      );
    },

    listExpiredHolds: async ({ heldBefore, limit, after }) => {
      const rows = await p.resaleListingHold.findMany({
        where: {
          heldUntil: { lt: heldBefore },
          listing: { status: "HELD" },
          ...(after
            ? {
                OR: [
                  { heldUntil: { gt: after.heldUntil } },
                  {
                    heldUntil: after.heldUntil,
                    listingId: { gt: after.listingId },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ heldUntil: "asc" }, { listingId: "asc" }],
        take: limit,
        select: { listingId: true, buyerHumanId: true, heldUntil: true },
      });
      return rows;
    },

    listHeldWithoutHold: async (limit) => {
      const rows = await p.resaleListing.findMany({
        where: { status: "HELD", hold: { is: null } },
        orderBy: { updatedAt: "asc" },
        take: limit,
        select: { id: true },
      });
      return rows.map((row) => row.id);
    },

    listOrdersForHold: async (listingId, buyerHumanId) => {
      // The column OR the meta copy: `cancelOpenForEvent` and `expireStale`
      // null the column, and an order the sweep cannot see is an order it
      // would release the listing out from under.
      const itemForListing = {
        OR: [
          { resaleListingId: listingId },
          { meta: { path: ["resaleListingId"], equals: listingId } },
        ],
      };
      const rows = await p.order.findMany({
        where: { buyerHumanId, items: { some: itemForListing } },
        select: {
          id: true,
          status: true,
          items: { where: itemForListing, select: { meta: true } },
        },
      });
      return rows.map((row) => {
        const meta = row.items[0]?.meta as Record<string, unknown> | null;
        const holdExpiresAt = meta?.holdExpiresAt;
        return {
          id: row.id,
          status: row.status,
          holdExpiresAt: typeof holdExpiresAt === "string" ? holdExpiresAt : null,
        };
      });
    },

    unwindSale: async (listingId, buyerOrderId, nextStatus) => {
      const unwindResult = await p.resaleListing.updateMany({
        where: {
          id: listingId,
          buyerOrderId,
          status: "SOLD",
        },
        data: {
          status: nextStatus,
          buyerOrderId: null,
        },
      });

      if (unwindResult.count !== 1) {
        throw {
          code: "conflict",
          message: "resale_sale_unwind_mismatch",
          listingId,
          buyerOrderId,
          nextStatus,
        } as const;
      }

      await p.resaleListingHold.deleteMany({ where: { listingId } });
    },

    // ── CRUD ──

    create: async (input) => {
      const row = await p.resaleListing
        .create({
          data: {
            ticketId: input.ticketId,
            eventId: input.eventId,
            sellerHumanId: input.sellerHumanId,
            askPriceCents: input.askPriceCents,
            faceValueCents: input.faceValueCents ?? null,
            processingPassThroughCents: input.processingPassThroughCents ?? 0,
            processingFeeConfigRef: input.processingFeeConfigRef ?? null,
            saleCutoffAt: input.saleCutoffAt ?? null,
            payoutReleaseAt: input.payoutReleaseAt ?? null,
            currency: input.currency ?? "usd",
            source: "internal",
            resalePayoutTermsId: input.resalePayoutTermsId ?? null,
            eventShareCents: input.eventShareCents ?? null,
            sharePayer: input.sharePayer ?? null,
            expiresAt: input.expiresAt ?? null,
          },
        })
        .catch((error: unknown) =>
          rethrowLiveListingConflict(error, input.ticketId),
        );
      return toRecord(row);
    },

    cancel: async (listingId, sellerHumanId) => {
      const result = await p.resaleListing.updateMany({
        where: { id: listingId, sellerHumanId, status: "ACTIVE" },
        data: { status: "CANCELLED" },
      });
      return result.count === 1;
    },

    getById: async (id) => {
      const row = await p.resaleListing.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    getByTicketId: async (ticketId) => {
      // A ticket has one row per listing it ever had. The live one (at most
      // one: partial unique index "Listing_ticketId_live_key") is the current
      // listing; with none live, the most recent past one is.
      const live = await p.resaleListing.findFirst({
        where: { ticketId, status: { in: [...LIVE_LISTING_STATUSES] } },
      });
      if (live) return toRecord(live);
      const latest = await p.resaleListing.findFirst({
        where: { ticketId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return latest ? toRecord(latest) : null;
    },

    // ── Queries ──

    listByEvent: async ({ eventId, status, limit, offset }) => {
      const { limit: safeLimit, offset: safeOffset } = sanitizeOffsetPagination(
        { limit, offset },
      );

      const where = {
        eventId,
        ...(status && status.length > 0 ? { status: { in: status } } : {}),
      };

      const [items, total] = await Promise.all([
        p.resaleListing.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: safeLimit,
          skip: safeOffset,
        }),
        p.resaleListing.count({ where }),
      ]);

      return buildOffsetPaginatedResult({
        items: items.map(toRecord),
        total,
        limit: safeLimit,
        offset: safeOffset,
      });
    },

    listByEventEnriched: async ({
      eventId,
      status,
      sectionId,
      onlyWithShare,
      limit,
      offset,
    }) => {
      const { limit: safeLimit, offset: safeOffset } = sanitizeOffsetPagination(
        { limit, offset },
      );

      const where: Record<string, unknown> = {
        eventId,
        ...(status && status.length > 0 ? { status: { in: status } } : {}),
        ...(onlyWithShare ? { eventShareCents: { not: null } } : {}),
      };

      // Filter by section: join through ticket → seat → seatSection
      if (sectionId) {
        where.ticket = { seat: { seatSectionId: sectionId } };
      }

      const [items, total] = await Promise.all([
        p.resaleListing.findMany({
          where,
          include: {
            ticket: {
              include: {
                ...TICKET_FACTS_SELECT,
                seat: {
                  include: {
                    seatSection: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: safeLimit,
          skip: safeOffset,
        }),
        p.resaleListing.count({ where }),
      ]);

      const enriched: EnrichedResaleListingRecord[] = items.map((row) => ({
        ...toRecord(row),
        ticketTypeName: row.ticket?.ticketType?.name ?? null,
        // HISTORICAL face value (FR-001): the listing's frozen snapshot, then
        // the seller's purchase snapshot. Never the live TicketType price —
        // that number moves whenever the organizer edits it and would show a
        // markup that disagrees with the split the money actually took.
        facePriceCents:
          row.faceValueCents ?? row.ticket?.orderItem?.unitPriceCents ?? null,
        ...ticketFactsOf(row.ticket),
        sectionName: row.ticket?.seat?.seatSection?.name ?? null,
        sectionId: row.ticket?.seat?.seatSection?.id ?? null,
        seatLabel: row.ticket?.seat?.label ?? null,
        seatRow: row.ticket?.seat?.row ?? null,
        seatNumber: row.ticket?.seat?.number ?? null,
      }));

      return buildOffsetPaginatedResult({
        items: enriched,
        total,
        limit: safeLimit,
        offset: safeOffset,
      });
    },

    listBySeller: async ({ sellerHumanId, status, limit, offset }) => {
      const { limit: safeLimit, offset: safeOffset } = sanitizeOffsetPagination(
        { limit, offset },
      );

      const where = {
        sellerHumanId,
        ...(status && status.length > 0 ? { status: { in: status } } : {}),
      };

      const [items, total] = await Promise.all([
        p.resaleListing.findMany({
          where,
          include: { ticket: { include: TICKET_FACTS_SELECT } },
          orderBy: { createdAt: "desc" },
          take: safeLimit,
          skip: safeOffset,
        }),
        p.resaleListing.count({ where }),
      ]);

      return buildOffsetPaginatedResult({
        items: items.map((row) => ({
          ...toRecord(row),
          ...ticketFactsOf(row.ticket),
        })),
        total,
        limit: safeLimit,
        offset: safeOffset,
      });
    },

    // ── Batch ops ──

    expireStale: async (now) => {
      if ("$disconnect" in p) {
        return (p as any).$transaction((tx: PrismaClientOrTx) =>
          expireStaleListings(tx, now),
        );
      }

      return expireStaleListings(p, now);
    },

    cancelOpenForEvent: async (eventId) => cancelOpenListingsForEvent(p, eventId),

    listLiveWithoutShare: async ({ limit, afterId }) => {
      const rows = await p.resaleListing.findMany({
        where: {
          status: { in: ["ACTIVE", "HELD"] },
          eventShareCents: null,
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        orderBy: { id: "asc" },
        take: Math.max(1, Math.min(limit, 500)),
      });
      return rows.map(toRecord);
    },

    // ── Data-backed pricing query ──

    getCompletedResalePrices: async (eventId, ticketTypeId, dayWindow) => {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - dayWindow);

      const rows = await p.resaleListing.findMany({
        where: {
          eventId,
          status: "SOLD",
          ticket: { ticketTypeId },
          updatedAt: { gte: cutoff },
        },
        select: {
          askPriceCents: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      });

      return rows.map((r) => ({
        askPriceCents: r.askPriceCents,
        completedAt: r.updatedAt,
      }));
    },

    // ── External inventory ──

    createExternal: async (input) => {
      const row = await p.resaleListing
        .create({
          data: {
            ticketId: input.ticketId,
            eventId: input.eventId,
            sellerHumanId: input.sellerHumanId,
            askPriceCents: input.askPriceCents,
            faceValueCents: input.faceValueCents ?? null,
            processingPassThroughCents: input.processingPassThroughCents ?? 0,
            processingFeeConfigRef: input.processingFeeConfigRef ?? null,
            saleCutoffAt: input.saleCutoffAt ?? null,
            payoutReleaseAt: input.payoutReleaseAt ?? null,
            currency: input.currency ?? "usd",
            source: "external",
            externalRef: input.externalRef as object,
            resalePayoutTermsId: input.resalePayoutTermsId ?? null,
            eventShareCents: input.eventShareCents ?? null,
            sharePayer: input.sharePayer ?? null,
            expiresAt: input.expiresAt ?? null,
          },
        })
        .catch((error: unknown) =>
          rethrowLiveListingConflict(error, input.ticketId),
        );
      return toRecord(row);
    },
  };
}

/**
 * See the port doc. Runs on whatever client it is handed — `cancelEvent`
 * passes its transaction client, so every write here commits or rolls back
 * with the cancellation.
 */
async function cancelOpenListingsForEvent(
  p: PrismaClientOrTx,
  eventId: string,
): Promise<{ cancelledListingIds: string[] }> {
  const candidates = await p.resaleListing.findMany({
    where: { eventId, status: { in: [...LIVE_LISTING_STATUSES] } },
    select: { id: true, ticketId: true },
  });

  if (candidates.length === 0) {
    return { cancelledListingIds: [] };
  }

  const candidateIds = candidates.map((listing) => listing.id);
  const ticketIds = candidates.map((listing) => listing.ticketId);

  // Tickets FIRST (same lock order as `commit`: ticket row, then listing
  // row). Only LISTED tickets reset — a ticket a racing finalize already
  // reassigned is VALID and untouched.
  await p.ticket.updateMany({
    where: { id: { in: ticketIds }, status: "LISTED" },
    data: { status: "VALID" },
  });

  // Status-conditional: a candidate that went SOLD between the select and
  // here is skipped; the re-select below reports only what actually flipped.
  await p.resaleListing.updateMany({
    where: {
      id: { in: candidateIds },
      eventId,
      status: { in: [...LIVE_LISTING_STATUSES] },
    },
    data: { status: "CANCELLED" },
  });

  const cancelled = await p.resaleListing.findMany({
    where: { id: { in: candidateIds }, status: "CANCELLED" },
    select: { id: true },
  });
  if (cancelled.length === 0) {
    return { cancelledListingIds: [] };
  }
  const cancelledListingIds = cancelled.map((listing) => listing.id);

  // HELD rows carried a hold for an in-flight resale checkout; release it
  // so the (never re-sellable) row is not left HELD-with-hold forever.
  await p.resaleListingHold.deleteMany({
    where: { listingId: { in: cancelledListingIds } },
  });

  // Pointer bookkeeping: every order item naming one of these listings is
  // cleared, by listing id. (`expireStale` clears only the ticket's current
  // item; `unwindSale` touches no order item.) That includes a RESALE item
  // of a checkout that held the listing and never completed; its
  // `meta.resaleListingId` still names it.
  await p.orderItem.updateMany({
    where: { resaleListingId: { in: cancelledListingIds } },
    data: { resaleListingId: null },
  });

  return { cancelledListingIds };
}

async function expireStaleListings(
  p: PrismaClientOrTx,
  now: Date,
): Promise<{ expiredCount: number }> {
  const candidates = await p.resaleListing.findMany({
    where: {
      status: "ACTIVE",
      expiresAt: { lt: now },
    },
    select: { id: true, ticketId: true },
  });

  if (candidates.length === 0) {
    return { expiredCount: 0 };
  }

  const candidateIds = candidates.map((listing) => listing.id);

  // Tickets FIRST, then listings: the order `commit`, `cancelOpenForEvent`,
  // `releaseHold` and the refund reconcile take. This used to write the
  // listings first and the tickets second, a deadlock cycle against all of
  // them. Id order, so two lockers of overlapping sets queue.
  const candidateTicketIds = [
    ...new Set(candidates.map((listing) => listing.ticketId)),
  ].sort();
  await p.$queryRaw`SELECT id FROM "Ticket" WHERE id = ANY(${candidateTicketIds}::text[]) ORDER BY id FOR NO KEY UPDATE`;

  await p.resaleListing.updateMany({
    where: {
      id: { in: candidateIds },
      status: "ACTIVE",
      expiresAt: { lt: now },
    },
    data: { status: "EXPIRED" },
  });

  const expiredListings = await p.resaleListing.findMany({
    where: {
      id: { in: candidateIds },
      status: "EXPIRED",
    },
    select: {
      id: true,
      ticketId: true,
      ticket: {
        select: {
          orderItemId: true,
        },
      },
    },
  });

  if (expiredListings.length === 0) {
    return { expiredCount: 0 };
  }

  const ticketIds = expiredListings.map((listing) => listing.ticketId);
  await p.ticket.updateMany({
    where: {
      id: { in: ticketIds },
      status: "LISTED",
    },
    data: { status: "VALID" },
  });

  const expiredListingIds = expiredListings.map((listing) => listing.id);
  const orderItemIds = expiredListings
    .map((listing) => listing.ticket?.orderItemId)
    .filter((orderItemId): orderItemId is string => Boolean(orderItemId));

  if (orderItemIds.length > 0) {
    await p.orderItem.updateMany({
      where: {
        id: { in: orderItemIds },
        resaleListingId: { in: expiredListingIds },
      },
      data: { resaleListingId: null },
    });
  }

  return { expiredCount: expiredListings.length };
}

/**
 * Locks the listing's ticket row. Ticket before listing is the order
 * `commit`, `cancelOpenListingsForEvent` and the refund reconcile take, so a
 * release never inverts against them. Null when the listing (or its ticket)
 * is gone.
 *
 * `FOR NO KEY UPDATE`, the lock a plain UPDATE of a non-key column takes: it
 * queues behind (and blocks) every other UPDATE of the ticket, which is the
 * serialisation needed, but not an insert that only takes a foreign-key
 * `FOR KEY SHARE` on it (a `TicketTransfer`, say), as `FOR UPDATE` would.
 */
async function lockListingTicket(
  p: PrismaClientOrTx,
  listingId: string,
): Promise<{ id: string; status: string; orderItemId: string | null } | null> {
  const listing = await p.resaleListing.findUnique({
    where: { id: listingId },
    select: { ticketId: true },
  });
  if (!listing) return null;
  // Parameterised; the lock strength is a fixed fragment (as `events.lockRows`).
  const rows = await p.$queryRaw<
    Array<{ id: string; status: string; orderItemId: string | null }>
  >`SELECT id, status::text AS status, "orderItemId" FROM "Ticket" WHERE id = ${listing.ticketId} FOR NO KEY UPDATE`;
  return rows[0] ?? null;
}

/**
 * `releaseHold`: give ONE hold back and put the listing where it belongs.
 *
 * Locks: ticket row, listing row, hold row. Every check below runs under the
 * ticket and listing locks, so a refund reconcile (ticket first) or an event
 * cancel (tickets first) either committed before this read or waits for it.
 * The event row is only read: `cancelEvent` writes the event and the
 * listings in one transaction, so a committed CANCELLED event with a still
 * HELD listing only exists from before `cancelOpenForEvent`.
 */
async function releaseHeldListing(
  p: PrismaClientOrTx,
  listingId: string,
  fence: { buyerHumanId: string; heldUntil: Date },
  now: Date,
): Promise<ResaleListingReleaseResult> {
  const ticket = await lockListingTicket(p, listingId);

  // Not HELD → nothing of ours to release (SOLD/CANCELLED dropped the hold).
  const locked = await p.resaleListing.updateMany({
    where: { id: listingId, status: "HELD" },
    data: { status: "HELD" },
  });
  if (locked.count !== 1) return { released: false };
  const deleted = await p.resaleListingHold.deleteMany({
    where: {
      listingId,
      buyerHumanId: fence.buyerHumanId,
      heldUntil: fence.heldUntil,
    },
  });
  if (deleted.count !== 1) return { released: false };

  const listing = await p.resaleListing.findUnique({
    where: { id: listingId },
    select: { eventId: true, expiresAt: true, ticketId: true },
  });
  const originalItem = ticket?.orderItemId
    ? await p.orderItem.findUnique({
        where: { id: ticket.orderItemId },
        select: { status: true, refundedAt: true },
      })
    : null;
  const event = listing
    ? await p.event.findUnique({
        where: { id: listing.eventId },
        select: { status: true },
      })
    : null;

  // 1. The pass can no longer be sold: never back on sale, ticket as it is.
  //    A voided pass must not be reset to VALID (the refunded seller would
  //    get a scannable ticket back).
  if (!ticket || ticket.status !== "LISTED") {
    await closeListing(p, listingId, "CANCELLED");
    return { released: true, listingStatus: "CANCELLED", reason: "ticket_not_listed" };
  }
  if (
    originalItem &&
    (originalItem.status === "refunded" || originalItem.refundedAt)
  ) {
    await closeListing(p, listingId, "CANCELLED");
    return {
      released: true,
      listingStatus: "CANCELLED",
      reason: "original_item_refunded",
    };
  }

  // 2. Event cancelled: what `cancelOpenListingsForEvent` does for one row.
  if (event?.status === "CANCELLED") {
    await p.ticket.updateMany({
      where: { id: ticket.id, status: "LISTED" },
      data: { status: "VALID" },
    });
    await closeListing(p, listingId, "CANCELLED");
    return { released: true, listingStatus: "CANCELLED", reason: "event_cancelled" };
  }

  // 3. At or past its own expiry: what `expireStaleListings` does for one
  //    row. `expiresAt == now` counts as expired, as the checkout refuses it.
  if (listing?.expiresAt && listing.expiresAt.getTime() <= now.getTime()) {
    await p.ticket.updateMany({
      where: { id: ticket.id, status: "LISTED" },
      data: { status: "VALID" },
    });
    await p.resaleListing.updateMany({
      where: { id: listingId, status: "HELD" },
      data: { status: "EXPIRED" },
    });
    if (ticket.orderItemId) {
      await p.orderItem.updateMany({
        where: { id: ticket.orderItemId, resaleListingId: listingId },
        data: { resaleListingId: null },
      });
    }
    return { released: true, listingStatus: "EXPIRED", reason: "listing_expired" };
  }

  // 4. Back on sale.
  await p.resaleListing.updateMany({
    where: { id: listingId, status: "HELD" },
    data: { status: "ACTIVE" },
  });
  return { released: true, listingStatus: "ACTIVE" };
}

/**
 * HELD → CANCELLED for one listing, with `cancelOpenListingsForEvent`'s
 * pointer bookkeeping (every order item pointing at it is unlinked). The
 * ticket is the caller's business.
 */
async function closeListing(
  p: PrismaClientOrTx,
  listingId: string,
  status: "CANCELLED",
): Promise<void> {
  await p.resaleListing.updateMany({
    where: { id: listingId, status: "HELD" },
    data: { status },
  });
  await p.orderItem.updateMany({
    where: { resaleListingId: listingId },
    data: { resaleListingId: null },
  });
}
