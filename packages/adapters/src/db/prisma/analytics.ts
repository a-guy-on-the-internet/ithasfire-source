import { Prisma } from "@prisma/client";

import type { AnalyticsRepo } from "@th/ports/repos/analytics";
import type {
  EventDailyStatsRecord,
  UpsertEventDailyStatsInput,
  ResalePriceSnapshotRecord,
  UpsertResalePriceSnapshotInput,
  TicketTypeStatsEntry,
  PlatformStatsResult,
  PlatformRevenueByCurrency,
  OrgDashboardSummary,
  TicketSalesRollupRow,
} from "@th/types";
import { PROCESSOR_FEE_MAX_READ_FAILURES } from "@th/types/repos/orders";
import type { PrismaClientOrTx } from "./types";

// ── Mappers ────────────────────────────────────────────────────────────────

function mapDailyStats(row: any): EventDailyStatsRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    date: row.date,
    grossRevenueCents: row.grossRevenueCents,
    netRevenueCents: row.netRevenueCents,
    refundedCents: row.refundedCents,
    ticketsSold: row.ticketsSold,
    ticketsRefunded: row.ticketsRefunded,
    ticketsTransferred: row.ticketsTransferred,
    totalCapacity: row.totalCapacity,
    sellThroughRate: row.sellThroughRate,
    orderCount: row.orderCount,
    refundCount: row.refundCount,
    ticketTypeStats: (row.ticketTypeStats ?? []) as TicketTypeStatsEntry[],
    waitlistCount: row.waitlistCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapResaleSnapshot(row: any): ResalePriceSnapshotRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    ticketTypeId: row.ticketTypeId,
    date: row.date,
    suggestedPriceCents: row.suggestedPriceCents,
    facePriceCents: row.facePriceCents,
    resaleCapCents: row.resaleCapCents,
    demandTier: row.demandTier,
    sellThroughRate: row.sellThroughRate,
    sampleSize: row.sampleSize,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Repo factory ───────────────────────────────────────────────────────────

export function makeAnalyticsRepo(p: PrismaClientOrTx): AnalyticsRepo {
  return {
    // ── Realised sales ────────────────────────────────────────────────────

    async getTicketSalesRollup(
      eventIds: string[],
    ): Promise<TicketSalesRollupRow[]> {
      if (eventIds.length === 0) return [];

      // Every predicate here is a decision; none of them are incidental.
      //
      // `oi."unitPriceCents"` and NOT `tt."priceCents"`: this is the whole
      // point. unitPriceCents is the snapshot written once at purchase and
      // never recomputed. The live ticket-type price is a forward-looking
      // policy number the organizer can edit at any time — and, since the
      // scheduled-price work, one that flips on a timer — so deriving
      // historical revenue from it restates the past every time either
      // happens.
      //
      // `o.source <> 'RESALE'`: a resale mints a SECOND ticket line for the
      // same physical seat while the seller's line becomes 'transferred'.
      // Counting both would double-count the seat, and the resale ask is
      // secondary-market money that mostly belongs to the reseller, not the
      // event. COMP orders ARE included — they consume real inventory, and
      // whatever price was recorded on them (normally 0) is the truth.
      //
      // `oi.status IN ('active','transferred')` counts as SOLD: a ticket that
      // was resold or gifted was still sold once on the primary market. Its
      // revenue was realised and must not disappear from the event's history
      // the moment the ticket changes hands.
      //
      // Order statuses include PART_REFUNDED, REFUNDED and DISPUTED so that
      // ITEM-level status decides the split. Filtering to SUCCEEDED orders (as
      // getPopularityStats does) would drop every still-valid ticket on an
      // order that had ONE ticket refunded. DISPUTED is listed even though no
      // production path currently writes it — `markDisputeStatus` writes the
      // `disputeStatus` / `disputedAt` mirror fields and leaves `status` alone
      // — because if one ever did, an event's whole history would vanish the
      // moment a chargeback opened and reappear when it closed. A silently
      // moving historical number is the exact bug class this query exists to
      // remove, so the set is chosen to be robust rather than minimal.
      //
      // `ticketTypeId` is NOT filtered to NOT NULL: the FK is ON DELETE SET
      // NULL, so a deleted tier orphans its sales to a null id. Excluding them
      // would silently shrink an event's revenue when a tier is removed —
      // the opposite of the point. They come back as a null-keyed row the use
      // case folds into event totals. (`deleteTicketType` refuses once tickets
      // are issued, so this is a defensive path, not a routine one.)
      //
      // `* oi.qty` is defensive: every ticket-line writer today emits qty 1,
      // but the aggregate should be correct by construction, not by
      // convention.
      const rows = await p.$queryRaw<
        Array<{
          eventId: string;
          ticketTypeId: string | null;
          soldCount: bigint;
          refundedCount: bigint;
          revenueCents: bigint;
          refundedCents: bigint;
        }>
      >`
        SELECT
          o."eventId"                          AS "eventId",
          oi."ticketTypeId"                    AS "ticketTypeId",
          COALESCE(SUM(oi.qty) FILTER (
            WHERE oi.status IN ('active', 'transferred')
          ), 0)::bigint                        AS "soldCount",
          COALESCE(SUM(oi.qty) FILTER (
            WHERE oi.status = 'refunded'
          ), 0)::bigint                        AS "refundedCount",
          COALESCE(SUM(oi."unitPriceCents" * oi.qty) FILTER (
            WHERE oi.status IN ('active', 'transferred')
          ), 0)::bigint                        AS "revenueCents",
          COALESCE(SUM(oi."unitPriceCents" * oi.qty) FILTER (
            WHERE oi.status = 'refunded'
          ), 0)::bigint                        AS "refundedCents"
        FROM "OrderItem" oi
        INNER JOIN "Order" o ON o.id = oi."orderId"
        WHERE o."eventId" = ANY(${eventIds})
          AND o.kind = 'TICKETING'
          AND o.source <> 'RESALE'
          AND o.status IN ('SUCCEEDED', 'PART_REFUNDED', 'REFUNDED', 'DISPUTED')
          AND oi.kind = 'ticket'
        GROUP BY o."eventId", oi."ticketTypeId"
      `;

      return rows.map((row) => ({
        eventId: row.eventId,
        ticketTypeId: row.ticketTypeId,
        soldCount: Number(row.soldCount),
        refundedCount: Number(row.refundedCount),
        revenueCents: Number(row.revenueCents),
        refundedCents: Number(row.refundedCents),
      }));
    },

    // ── EventDailyStats ───────────────────────────────────────────────────

    async upsertDailyStats(input: UpsertEventDailyStatsInput) {
      const row = await p.eventDailyStats.upsert({
        where: {
          eventId_date: {
            eventId: input.eventId,
            date: input.date,
          },
        },
        create: {
          eventId: input.eventId,
          date: input.date,
          grossRevenueCents: input.grossRevenueCents,
          netRevenueCents: input.netRevenueCents,
          refundedCents: input.refundedCents,
          ticketsSold: input.ticketsSold,
          ticketsRefunded: input.ticketsRefunded,
          ticketsTransferred: input.ticketsTransferred,
          totalCapacity: input.totalCapacity,
          sellThroughRate: input.sellThroughRate,
          orderCount: input.orderCount,
          refundCount: input.refundCount,
          ticketTypeStats: input.ticketTypeStats as any,
          waitlistCount: input.waitlistCount,
        },
        update: {
          grossRevenueCents: input.grossRevenueCents,
          netRevenueCents: input.netRevenueCents,
          refundedCents: input.refundedCents,
          ticketsSold: input.ticketsSold,
          ticketsRefunded: input.ticketsRefunded,
          ticketsTransferred: input.ticketsTransferred,
          totalCapacity: input.totalCapacity,
          sellThroughRate: input.sellThroughRate,
          orderCount: input.orderCount,
          refundCount: input.refundCount,
          ticketTypeStats: input.ticketTypeStats as any,
          waitlistCount: input.waitlistCount,
        },
      });
      return mapDailyStats(row);
    },

    async upsertDailyStatsBatch(inputs: UpsertEventDailyStatsInput[]) {
      let written = 0;
      // Use transaction batches of 50 to avoid excessive query length
      const batchSize = 50;
      for (let i = 0; i < inputs.length; i += batchSize) {
        const batch = inputs.slice(i, i + batchSize);
        const ops = batch.map((input) =>
          p.eventDailyStats.upsert({
            where: {
              eventId_date: {
                eventId: input.eventId,
                date: input.date,
              },
            },
            create: {
              eventId: input.eventId,
              date: input.date,
              grossRevenueCents: input.grossRevenueCents,
              netRevenueCents: input.netRevenueCents,
              refundedCents: input.refundedCents,
              ticketsSold: input.ticketsSold,
              ticketsRefunded: input.ticketsRefunded,
              ticketsTransferred: input.ticketsTransferred,
              totalCapacity: input.totalCapacity,
              sellThroughRate: input.sellThroughRate,
              orderCount: input.orderCount,
              refundCount: input.refundCount,
              ticketTypeStats: input.ticketTypeStats as any,
              waitlistCount: input.waitlistCount,
            },
            update: {
              grossRevenueCents: input.grossRevenueCents,
              netRevenueCents: input.netRevenueCents,
              refundedCents: input.refundedCents,
              ticketsSold: input.ticketsSold,
              ticketsRefunded: input.ticketsRefunded,
              ticketsTransferred: input.ticketsTransferred,
              totalCapacity: input.totalCapacity,
              sellThroughRate: input.sellThroughRate,
              orderCount: input.orderCount,
              refundCount: input.refundCount,
              ticketTypeStats: input.ticketTypeStats as any,
              waitlistCount: input.waitlistCount,
            },
          }),
        );
        // Prisma $transaction batches upserts in a single round-trip
        await (p as any).$transaction(ops);
        written += batch.length;
      }
      return written;
    },

    async getLatestDailyStats(eventId: string) {
      const row = await p.eventDailyStats.findFirst({
        where: { eventId },
        orderBy: { date: "desc" },
      });
      return row ? mapDailyStats(row) : null;
    },

    async getLatestDailyStatsBatch(eventIds: string[]) {
      if (eventIds.length === 0) return [];
      // Use a raw query with DISTINCT ON to get the latest row per eventId in one round-trip
      const rows: any[] = await (p as any).$queryRawUnsafe(
        `SELECT DISTINCT ON ("eventId") *
         FROM "EventDailyStats"
         WHERE "eventId" = ANY($1::text[])
         ORDER BY "eventId", "date" DESC`,
        eventIds,
      );
      return rows.map(mapDailyStats);
    },

    async getDailyStats(eventId: string, date: Date) {
      const row = await p.eventDailyStats.findUnique({
        where: {
          eventId_date: {
            eventId,
            date,
          },
        },
      });
      return row ? mapDailyStats(row) : null;
    },

    // ── ResalePriceSnapshot ───────────────────────────────────────────────

    async upsertResaleSnapshot(input: UpsertResalePriceSnapshotInput) {
      const row = await p.resalePriceSnapshot.upsert({
        where: {
          eventId_ticketTypeId_date: {
            eventId: input.eventId,
            ticketTypeId: input.ticketTypeId,
            date: input.date,
          },
        },
        create: {
          eventId: input.eventId,
          ticketTypeId: input.ticketTypeId,
          date: input.date,
          suggestedPriceCents: input.suggestedPriceCents,
          facePriceCents: input.facePriceCents,
          resaleCapCents: input.resaleCapCents,
          demandTier: input.demandTier,
          sellThroughRate: input.sellThroughRate,
          sampleSize: input.sampleSize,
          source: input.source,
        },
        update: {
          suggestedPriceCents: input.suggestedPriceCents,
          facePriceCents: input.facePriceCents,
          resaleCapCents: input.resaleCapCents,
          demandTier: input.demandTier,
          sellThroughRate: input.sellThroughRate,
          sampleSize: input.sampleSize,
          source: input.source,
        },
      });
      return mapResaleSnapshot(row);
    },

    async upsertResaleSnapshotBatch(inputs: UpsertResalePriceSnapshotInput[]) {
      let written = 0;
      const batchSize = 50;
      for (let i = 0; i < inputs.length; i += batchSize) {
        const batch = inputs.slice(i, i + batchSize);
        const ops = batch.map((input) =>
          p.resalePriceSnapshot.upsert({
            where: {
              eventId_ticketTypeId_date: {
                eventId: input.eventId,
                ticketTypeId: input.ticketTypeId,
                date: input.date,
              },
            },
            create: {
              eventId: input.eventId,
              ticketTypeId: input.ticketTypeId,
              date: input.date,
              suggestedPriceCents: input.suggestedPriceCents,
              facePriceCents: input.facePriceCents,
              resaleCapCents: input.resaleCapCents,
              demandTier: input.demandTier,
              sellThroughRate: input.sellThroughRate,
              sampleSize: input.sampleSize,
              source: input.source,
            },
            update: {
              suggestedPriceCents: input.suggestedPriceCents,
              facePriceCents: input.facePriceCents,
              resaleCapCents: input.resaleCapCents,
              demandTier: input.demandTier,
              sellThroughRate: input.sellThroughRate,
              sampleSize: input.sampleSize,
              source: input.source,
            },
          }),
        );
        await (p as any).$transaction(ops);
        written += batch.length;
      }
      return written;
    },

    async getLatestResaleSnapshot(eventId: string, ticketTypeId: string) {
      const row = await p.resalePriceSnapshot.findFirst({
        where: { eventId, ticketTypeId },
        orderBy: { date: "desc" },
      });
      return row ? mapResaleSnapshot(row) : null;
    },

    async getLatestResaleSnapshotsBatch(
      eventId: string,
      ticketTypeIds: string[],
    ) {
      if (ticketTypeIds.length === 0) return [];
      const rows: any[] = await (p as any).$queryRawUnsafe(
        `SELECT DISTINCT ON ("ticketTypeId") *
         FROM "ResalePriceSnapshot"
         WHERE "eventId" = $1 AND "ticketTypeId" = ANY($2::text[])
         ORDER BY "ticketTypeId", "date" DESC`,
        eventId,
        ticketTypeIds,
      );
      return rows.map(mapResaleSnapshot);
    },

    async listResaleSnapshots(eventId: string, date: Date) {
      const rows = await p.resalePriceSnapshot.findMany({
        where: {
          eventId,
          date,
        },
        orderBy: { ticketTypeId: "asc" },
      });
      return rows.map(mapResaleSnapshot);
    },

    async getPlatformStats(): Promise<PlatformStatsResult> {
      // Run all aggregate queries in parallel for speed.
      const [orderAgg, eventCount, ticketCount, humanCount, orgCount] =
        await Promise.all([
          p.order.aggregate({
            _count: { id: true },
            _sum: { amountGrossCents: true, feesPlatformCents: true },
            // CAPTURED MONEY, not "SUCCEEDED". This filter used to be
            // `status: "SUCCEEDED"`, which dropped an order the moment one
            // ticket on it was refunded — and took the order's ENTIRE
            // platform fee out of the total with it, even though the fee had
            // been charged. Measured on the dev database: platform fees
            // under-reported by $66.00 on $337.25, 19.6%.
            //
            // CANCELLED stays OUT, and that is verified rather than assumed:
            // the only writers of that status are `cancelPendingOrder`
            // (PENDING → CANCELLED), `cancelProcessingOrder` (PROCESSING →
            // CANCELLED, a failed delayed payment) and `cancelCompOrder` (a
            // $0 comp void) — see `orders.ts`. None of the three represents
            // money that was captured. PENDING and PROCESSING are out for
            // the same reason: the charge has not landed.
            where: {
              status: {
                in: ["SUCCEEDED", "PART_REFUNDED", "REFUNDED", "DISPUTED"],
              },
            },
          }),
          p.event.count(),
          p.ticket.count(),
          p.human.count(),
          p.organization.count(),
        ]);

      // Also get total orders (all statuses) for context
      const totalOrders = await p.order.count();

      return {
        totalOrders,
        // Now "orders with captured money", not strictly SUCCEEDED — the
        // field name predates the widened filter and is kept because
        // `/platform/overview` and `PlatformStatsResult` are shared shape.
        totalSucceededOrders: orderAgg._count.id,
        // CROSS-CURRENCY, deliberately left as-is: `/platform/overview`
        // renders one number and the platform is effectively
        // single-currency today. Everything that needs a defensible figure
        // reads `sumPlatformRevenueByCurrency` below, which groups.
        totalGrossRevenueCents: orderAgg._sum.amountGrossCents ?? 0,
        totalPlatformFeesCents: orderAgg._sum.feesPlatformCents ?? 0,
        totalEvents: eventCount,
        totalTicketsSold: ticketCount,
        totalHumans: humanCount,
        totalOrganizations: orgCount,
      };
    },

    async sumPlatformRevenueByCurrency(): Promise<PlatformRevenueByCurrency[]> {
      // Raw SQL grouped on `btrim(lower(o."currency"))`, following
      // `orders.sumCollectedTaxByCurrency` — a grouped aggregate over the
      // whole Order table, where fetching every finalized order to sum in JS
      // is unbounded. Normalising here means the rows join the ledger's and
      // Stripe's lowercase ISO-4217 without the caller guessing at casing;
      // btrim matches how the ledger reads normalise.
      //
      // The status set is the SAME captured-money set `getPlatformStats`
      // above now uses; see that comment for why CANCELLED / PENDING /
      // PROCESSING are excluded and why SUCCEEDED alone was wrong.
      //
      // NOTHING IS EVER JOINED AT ITEM GRAIN INTO AN ORDER SUM. An order has
      // N items; joining them before summing would multiply every order
      // figure by N. So every per-order input (the refunded ticket items'
      // stamped fee shares and counts, the live credit redemptions, the
      // refunded orders' ticket shape, splits and attribution, the external
      // refund marker) is aggregated TO ONE ROW PER ORDER first
      // (`refunded_ticket_items`, `live_credit`, `refunded_order_tickets`,
      // `refunded_order_splits`, `refunded_order_attribution`,
      // `external_amount_refunds`) and only then LEFT JOINed one-to-one onto
      // the order. The final aggregate therefore sees exactly one row per
      // order, and the fees-returned COUNTS come out of that same fold
      // rather than a second scan of `OrderItem` under the identical filter.
      // `refunded_ticket_items`, `live_credit` and `external_amount_refunds`
      // are restricted to `counted`, because neither `OrderItem.refundedAt`,
      // `UserCreditRedemption.orderId` nor `AuditLog.entityId` gives the
      // planner anything to work with unbounded; the other three
      // (`refunded_order_tickets`, `refunded_order_splits`,
      // `refunded_order_attribution`) are restricted to the orders
      // `refunded_ticket_items` holds.
      //
      // FEE-MODE SPLIT. `feePolicySnapshot` is JSONB with a top-level
      // `feeMode` of 'PASS_THROUGH' | 'ABSORB'. It is lifted out once in
      // `counted` and read from there by both the split and the net.
      // Anything else (missing key, legacy shape) lands in the Unknown
      // bucket so the three always sum to the total and nothing is silently
      // folded into a mode.
      //
      // CREDIT RULE. The same snapshot carries `organiserCredit`. An order
      // stamped 'FULL_PRICE' (every sale since the 2026-10-11 ruling) credited
      // the organiser the full ticket price, so the platform took NO unit out
      // of the basis and kept the fee once. An order without the stamp
      // credited price minus fee and kept it twice. It is lifted once in
      // `counted` as a boolean that is FALSE for anything but that exact
      // value, the same test `computeAgreementBasis` applies, so the two
      // cannot disagree about which rule an order was sold under.
      //
      // THE NET (`netKeptCents`) is a COVERAGE-GATED figure: summed over the
      // eligible orders ONLY, reported with `netKeptEligibleCount` against
      // `orderCount`. The ELEVEN eligibility conditions and the economics of
      // each term are documented in
      // `packages/core/src/use-cases/platform/get-platform-revenue.ts`;
      // this query is the mechanical form of that expression. It is SIGNED:
      // a capped give-back and platform-funded credit can exceed the fee.
      //
      // THE REFUND SIDE IS WHERE THIS GETS SUBTLE. Three separate errors all
      // understated profit on refunded orders and all are handled here:
      // the recovered processor fee (condition 5), an uncapped basis-side
      // give-back (the LEAST around the stamp) and a credit whose cost the
      // refund gave back (condition 6). Read the header before touching any
      // of the three.
      //
      // Schema-qualified (public.*) so the statement survives a Neon pooled
      // connection waking with an empty search_path.
      const rows = await p.$queryRaw<
        Array<{
          currency: string;
          ticketVolumeCents: bigint;
          platformFeesChargedCents: bigint;
          platformFeesPassThroughCents: bigint;
          platformFeesAbsorbCents: bigint;
          platformFeesUnknownModeCents: bigint;
          taxCollectedCents: bigint;
          orderCount: bigint;
          processorFeeCents: bigint;
          processorFeeMeasuredCount: bigint;
          processorFeeEligibleCount: bigint;
          processorFeeParkedCount: bigint;
          netKeptCents: bigint;
          netKeptEligibleCount: bigint;
          feesReturnedCents: bigint;
          feesReturnedMeasuredCount: bigint;
          feesReturnedEligibleCount: bigint;
        }>
      >(Prisma.sql`
        WITH counted AS (
          -- ONE ROW PER COUNTED ORDER. The currency is normalised once and
          -- the fee mode lifted out of the JSONB snapshot once, so every
          -- downstream expression reads the same value.
          SELECT
            o."id"                            AS "orderId",
            btrim(lower(o."currency"))        AS "currency",
            o."amountGrossCents",
            o."feesPlatformCents",
            o."taxAmountCents",
            o."processorFeeCents",
            o."processorFeeReadFailures",
            o."stripePaymentIntentId",
            o."status",
            -- The Dispute-row mirror markDisputeStatus writes. The dispute
            -- lifecycle never sets status to DISPUTED, so this is the
            -- column condition (2) has to read.
            o."disputeStatus",
            -- OrderSource. RESALE orders record no platform fee at all, so
            -- they need excluding rather than netting; see condition (7).
            o."source",
            o."feePolicySnapshot"->>'feeMode' AS "feeMode",
            -- THE CREDIT RULE THE ORDER WAS SOLD UNDER. TRUE only for a
            -- snapshot stamped organiserCredit = 'FULL_PRICE': the organiser
            -- was credited the full ticket price and nothing came out of the
            -- basis. COALESCE to FALSE because a missing key yields NULL, and
            -- a missing key IS the answer for every order sold before the
            -- stamp existed: those were credited price minus fee. Any other
            -- value reads FALSE too, exactly as computeAgreementBasis reads it.
            COALESCE(
              o."feePolicySnapshot"->>'organiserCredit' = 'FULL_PRICE',
              FALSE
            ) AS "creditedFullPrice"
          FROM public."Order" o
          WHERE o."status" IN ('SUCCEEDED', 'PART_REFUNDED', 'REFUNDED', 'DISPUTED')
        ),
        refunded_ticket_items AS (
          -- Refunded TICKET items, FOLDED TO ONE ROW PER ORDER. The fee
          -- share is allocated over ticket items
          -- (_shared/refund-platform-fee-share.ts), so a refunded
          -- non-ticket line was never going to be stamped and must not read
          -- as a gap. refundedAt is written together with
          -- status = 'refunded' by orderItems.updateStatus; it is the
          -- marker every refund path sets.
          --
          -- RESTRICTED TO THE COUNTED ORDERS. Neither OrderItem.refundedAt
          -- nor kind carries a usable index, so without this the CTE is a
          -- seq scan over every item ever written; the counted set is
          -- already materialised above.
          SELECT
            oi."orderId",
            COALESCE(SUM(oi."refundedPlatformFeeCents"), 0)::bigint AS "stampedFeeCents",
            -- Refunded ticket items on the order, at ALL. Two eligibility
            -- conditions turn on "was anything refunded here", regardless
            -- of whether it was stamped.
            COUNT(*)::bigint                                        AS "refundedCount",
            -- An UNSTAMPED refunded ticket item is what disqualifies the
            -- order from the net: the money went back and nothing recorded
            -- how much of the fee went with it.
            COUNT(*) FILTER (
              WHERE oi."refundedPlatformFeeCents" IS NULL
            )::bigint                                              AS "unstampedCount"
          FROM public."OrderItem" oi
          WHERE oi."refundedAt" IS NOT NULL
            AND oi."kind" = 'ticket'
            AND oi."orderId" IN (SELECT "orderId" FROM counted)
          GROUP BY oi."orderId"
        ),
        live_credit AS (
          -- LIVE platform-funded credit applied to the order, one row per
          -- order. Credit never touches amountGrossCents
          -- (create-checkout.ts), so it is invisible to every other figure
          -- in this query.
          --
          -- WHAT "LIVE" MEANS, AND WHAT IT DOES NOT. releasedAt is stamped
          -- by credits.releaseForOrder, which is CANCEL PATHS ONLY (the
          -- order died unpaid, the cents went back to the balance) -- so the
          -- filter is there for cancelled-then-recounted orders, not for
          -- refunds. refundedAt has NO WRITER anywhere in the repo today:
          -- the port contract states outright that restoring a credit on
          -- refund is refund policy and is not implemented, and the schema
          -- comment describing it is aspirational. It is filtered on anyway
          -- so this read is correct the day a writer lands. A refunded
          -- order that used credit is handled by ELIGIBILITY instead (see
          -- condition 6), not by this filter.
          -- (No backticks below this line: it is inside a template literal.)
          SELECT
            ucr."orderId",
            COALESCE(SUM(ucr."amountCents"), 0)::bigint AS "creditCents"
          FROM public."UserCreditRedemption" ucr
          WHERE ucr."releasedAt" IS NULL
            AND ucr."refundedAt" IS NULL
            AND ucr."orderId" IN (SELECT "orderId" FROM counted)
          GROUP BY ucr."orderId"
        ),
        refunded_order_tickets AS (
          -- THE TICKET SHAPE OF EVERY ORDER WITH A REFUNDED TICKET ITEM, one
          -- row per order. Read by conditions (8), (9) and (10).
          --
          -- ticketCount: every ticket item on the order, refunded or not.
          -- hasDiscount: the order carries a discount line.
          -- likeTickets: every ticket item has the same face (amountCents)
          --   and the same per-ticket fee, and every one of them carries
          --   that fee. Read by (10) only.
          -- ticketFeeSumCents: the per-ticket fees summed. (10) compares it
          --   with the order fee.
          -- ticketFaceSumCents: the ticket faces summed. (9) compares the
          --   splits with it, (10) with it less the fee, and
          --   refunded_order_attribution divides by it.
          --
          -- THE PER-TICKET FEE is meta.platformFeePerTicketCents, the value
          -- checkout writes on each ticket item and the refund stamp copies
          -- when the values sum to the order fee
          -- (orders/_shared/refund-platform-fee-share.ts). It is read only
          -- when the text is 1 to 9 digits, so a malformed value cannot fail
          -- the cast and a huge one cannot overflow it. Anything else reads
          -- NULL, which makes likeTickets FALSE: such an order is never read
          -- as "like" and its partial refund is excluded.
          --
          -- FACE is amountCents. Checkout writes one ticket item per ticket
          -- with qty 1, so it equals unitPriceCents. The weight
          -- createCreditsFromOrder hands attributeCreditToItems is
          -- refundFaceWeightCents(item), which is amountCents EXCEPT for a
          -- ticket marked meta.discountedToZero (weight 0). The two agree
          -- on every order (9) or (10) admits: such a ticket needs a
          -- discount line to reach $0, a discount line excludes the partial
          -- refund in both, and refunded_order_attribution (read by (9))
          -- also refuses a marked ticket outright, so (9) does not lean on
          -- the discount line alone.
          --
          -- THE DISCOUNT SIGNAL IS THE DISCOUNT LINE ITSELF. A promo code or a
          -- membership benefit reaches an order as a negative OrderItem of
          -- kind 'discount' (checkout-promos.ts, the one writer), and
          -- amountGrossCents is the ticket lines minus those lines
          -- (price-cart.ts; create-embed-guest-checkout.ts asserts the
          -- identity before it writes). It is also the row the refund reads:
          -- the buyer's refund base is the order total, which folds in every
          -- negative line. So "has a discount line" and "the buyer's base and
          -- the organiser's credit were each reduced by a whole-order amount"
          -- are the same fact, with no arithmetic to get wrong.
          --
          -- ANY discount line counts, whatever its amount and whichever
          -- tickets it came off. Telling a harmless discount (identical
          -- tickets) from a harmful one is not attempted: identical tickets
          -- are themselves off by a cent when the discount does not divide
          -- evenly (three at face 1000 / fee 33 with 101 off: 34, 33, 32).
          --
          -- NOT platform_credit. Credit is a negative line too, but it never
          -- touches amountGrossCents, and a refund on an order that spent it
          -- is condition (6).
          --
          -- THE TICKET-ITEM COUNT is at the same grain as
          -- refunded_ticket_items.refundedCount (both count kind = 'ticket'
          -- OrderItem rows), because (8), (9) and (10) all call a refund
          -- partial when refundedCount < ticketCount. Checkout writes one
          -- OrderItem per ticket with qty 1; an item refunds whole or not at
          -- all (one refundedAt and one stamp per row, no partly-refunded
          -- quantity), so a row count cannot call a partial refund full. ONE
          -- ROW PER ORDER (GROUP BY), so the join below cannot fan out.
          --
          -- RESTRICTED TO ORDERS WITH A REFUNDED TICKET ITEM, the only ones
          -- the three conditions ask about, so this probes
          -- OrderItem(orderId) for the refunded orders and nothing else.
          SELECT
            t."orderId",
            COUNT(*) FILTER (WHERE t."kind" = 'ticket')::bigint AS "ticketCount",
            COUNT(*) FILTER (WHERE t."kind" = 'discount') > 0  AS "hasDiscount",
            COALESCE(
              COUNT(DISTINCT t."amountCents") FILTER (WHERE t."kind" = 'ticket') = 1
                AND COUNT(DISTINCT t."feeCents") FILTER (WHERE t."kind" = 'ticket') = 1
                AND COUNT(t."feeCents") FILTER (WHERE t."kind" = 'ticket')
                  = COUNT(*) FILTER (WHERE t."kind" = 'ticket'),
              FALSE
            )                                                   AS "likeTickets",
            SUM(t."feeCents") FILTER (WHERE t."kind" = 'ticket')::bigint
                                                                AS "ticketFeeSumCents",
            SUM(t."amountCents") FILTER (WHERE t."kind" = 'ticket')::bigint
                                                                AS "ticketFaceSumCents"
          FROM (
            SELECT
              oi."orderId",
              oi."kind",
              oi."amountCents",
              CASE
                WHEN oi."meta"->>'platformFeePerTicketCents' ~ '^[0-9]{1,9}$'
                THEN (oi."meta"->>'platformFeePerTicketCents')::bigint
              END AS "feeCents"
            FROM public."OrderItem" oi
            WHERE oi."orderId" IN (SELECT "orderId" FROM refunded_ticket_items)
          ) t
          GROUP BY t."orderId"
        ),
        refunded_order_splits AS (
          -- THE PAYEE SPLITS OF EVERY ORDER WITH A REFUNDED TICKET ITEM, one
          -- row per order. splitsDivide is read by condition (10);
          -- splitSumCents by (9) and (10).
          --
          -- WHY (10) NEEDS THEM. createCreditsFromOrder credits each payee
          -- its OrderSplit amount (one split row per payee per order, unique
          -- on orderId + payeeId) and attributes THAT amount to the ticket
          -- items on its own, with the leftover cent on the last ticket. A
          -- partial refund debits each payee its own attributed share
          -- (write-refund-debits.ts). So a refunded like ticket is debited
          -- face - fee only when every payee's split divides by the ticket
          -- count AND the splits add up to the faces less the fee. Two like
          -- tickets at face 1000 / fee 33 split 50/50 are credited 967 each,
          -- attributed 484 : 483 per payee; refunding the second costs the
          -- platform 1033 - 966 = 67 where the net gives back 66.
          --
          -- splitSumCents: every payee's split summed.
          -- splitsDivide: every split divides by the order's ticket-item
          --   count. NULLIF so a zero count reads NULL (not divisible)
          --   instead of failing the query; a NULL reads as FALSE below.
          --
          -- An order with NO split rows has no row here, which (9) and (10)
          -- read as not exact. Not because admitting it would overstate:
          -- with no credit attributed the refund debits nobody, but the
          -- platform also still holds the basis it never credited, so the
          -- net, which assumes the basis was credited, would UNDERSTATE.
          -- It is excluded because the take is not the net either way.
          --
          -- RESTRICTED TO THE ORDERS refunded_order_tickets already holds,
          -- through the join, so this probes OrderSplit(orderId) (the
          -- unique index's leading column) for refunded orders only.
          SELECT
            s."orderId",
            SUM(s."amountCents")::bigint AS "splitSumCents",
            BOOL_AND(s."amountCents" % NULLIF(rot."ticketCount", 0) = 0)
                                         AS "splitsDivide"
          FROM public."OrderSplit" s
          JOIN refunded_order_tickets rot ON rot."orderId" = s."orderId"
          GROUP BY s."orderId"
        ),
        refunded_order_attribution AS (
          -- DOES EVERY PAYEE'S CREDIT ATTRIBUTE TO EVERY TICKET WITHOUT A
          -- ROUNDED CENT? One row per order with a refunded ticket item and
          -- at least one split. Read by condition (9).
          --
          -- attributeCreditToItems (settlements/create-credits-from-order.ts)
          -- gives each ticket but the last Math.round(split * face_i /
          -- sum(face)) of a payee's split and the last ticket the remainder,
          -- once per payee. When split * face_i divides by sum(face) for
          -- EVERY ticket, each share is that quotient exactly: Math.round of
          -- an integer is the integer, the running remainder never runs
          -- short because the exact shares add up to the split, and the last
          -- ticket's remainder is its own exact share. Summed over payees,
          -- ticket i is then debited face_i * sum(split) / sum(face), which
          -- is face_i when the splits add up to the faces. When any product
          -- leaves a remainder, one ticket carries a rounded cent and a
          -- refund of it is not fee_i: two at face 1999 / fee 33 split
          -- 1999 : 1999 are debited 1000 + 1000 and 999 + 999, so refunding
          -- the second costs the platform 2032 - 1998 = 34 where the net
          -- gives back 33. One payee holding the whole credit always
          -- divides (its split IS the face sum), and so do like tickets
          -- whose splits each divide by the ticket count.
          --
          -- The weight is refundFaceWeightCents(item): amountCents, or 0
          -- for a ticket marked meta.discountedToZero. A pair with a marked
          -- ticket or a negative face (where the weight is not amountCents)
          -- reads not exact, and so does a negative split, which earns no
          -- credit (createCreditsFromOrder skips amounts <= 0) yet would
          -- count in splitSumCents. A zero split passes: it is credited
          -- nothing and debited nothing. A zero face sum reads NULL, which
          -- COALESCE turns into not exact.
          --
          -- GRAIN: split x ticket item, folded straight back to one row per
          -- order by the GROUP BY. Nothing else reads these pairs, so the
          -- fan-out never reaches an order sum. Restricted to the orders
          -- refunded_order_tickets holds, through the join.
          SELECT
            s."orderId",
            BOOL_AND(
              COALESCE(
                s."amountCents" >= 0
                  AND ti."amountCents" >= 0
                  AND (ti."meta"->>'discountedToZero') IS DISTINCT FROM 'true'
                  AND (s."amountCents"::bigint * ti."amountCents"::bigint)
                    % NULLIF(rot."ticketFaceSumCents", 0) = 0,
                FALSE
              )
            ) AS "attributionExact"
          FROM public."OrderSplit" s
          JOIN refunded_order_tickets rot ON rot."orderId" = s."orderId"
          JOIN public."OrderItem" ti
            ON ti."orderId" = s."orderId" AND ti."kind" = 'ticket'
          GROUP BY s."orderId"
        ),
        external_amount_refunds AS (
          -- ORDERS A STRIPE-SIDE PARTIAL REFUND MOVED MONEY ON WITHOUT
          -- REFUNDING ANY TICKET ITEM. Read by condition (11).
          --
          -- A partial refund made outside the app (the Stripe dashboard) is
          -- reconciled by reconcileExternalPartialRefund
          -- (orders/reconcile-stripe-full-refund.ts): it debits the payees
          -- a share proportional to the amount, flips no item unless the
          -- refund named one, and stamps nothing. The order then reads as
          -- unrefunded here while the buyer has money back and the net
          -- still counts the whole fee. The one record every reconciled pass
          -- leaves, whether or not any payee was debited, is its audit row,
          -- action stripe_partial_refund_reconciled, written in the same
          -- transaction as the debits.
          --
          -- THE SAME ROW FOLLOWS AN IN-APP PARTIAL REFUND. Stripe fires
          -- charge.refunded for every refund, so the app's own item refunds
          -- reach the same arm and leave the same row. Those have refunded
          -- ticket items, so (11) excludes only an order with the row and
          -- NO refunded ticket item. An order with both an in-app and an
          -- external partial refund is not told apart; see KNOWN AND NOT
          -- YET EXCLUDED in the use case header.
          --
          -- COST: AuditLog has no index on entityId or action, so expect a
          -- scan of the order audit rows (plan not measured). Fine on a
          -- staff page at today's volume; an AuditLog(entity, entityId)
          -- index is the fix when it grows. DISTINCT makes it one row per
          -- order.
          SELECT DISTINCT a."entityId" AS "orderId"
          FROM public."AuditLog" a
          WHERE a."entity" = 'order'
            AND a."action" = 'stripe_partial_refund_reconciled'
            AND a."entityId" IN (SELECT "orderId" FROM counted)
        ),
        order_net AS (
          SELECT
            c.*,
            -- The item-grain and credit-grain inputs, carried through at
            -- ORDER grain so the aggregate below needs no second scan.
            COALESCE(rti."stampedFeeCents", 0) AS "stampedFeeCents",
            COALESCE(rti."refundedCount", 0)   AS "refundedTicketCount",
            COALESCE(rti."unstampedCount", 0)  AS "unstampedTicketCount",
            -- ELIGIBILITY, all ELEVEN conditions. COALESCE to FALSE because
            -- a NULL feeMode makes the whole chain NULL, and "unknown" must
            -- read as "not eligible", never leak through a FILTER.
            COALESCE(
              -- EACH CONDITION WAS RE-READ FOR A FULL-PRICE-CREDITED ORDER
              -- (creditedFullPrice). (1) to (7) and (11) are about something
              -- other than the basis-side unit and apply to it unchanged;
              -- (8) and (10) exist only because of the basis-side unit and
              -- apply to unstamped orders alone; (9) is the full-price
              -- order's own partial-refund exclusion. The reason is on each
              -- one.
              --
              -- (1) A recorded fee mode, or the buyer-side unit is
              -- unknowable and so is whose the processor fee was.
              -- FULL-PRICE: applies, and matters more. The buyer-side unit
              -- is the only fee unit such an order has.
              c."feeMode" IN ('PASS_THROUGH', 'ABSORB')
                -- (2) A DISPUTE OF ANY KIND IS EXCLUDED, not modelled. A
                -- lost dispute returns principal this read cannot see, an
                -- open one may still, and on ticketing the platform bears
                -- Stripe's dispute fee (disputes/shared.ts, feeBorneBy
                -- PLATFORM), which no term below subtracts. WON and the
                -- WARNING_* inquiry states are excluded too: the order row
                -- does not say whether a fee was charged or kept, and an
                -- exclusion costs coverage where a guess could overstate.
                -- So ANY non-null disputeStatus excludes, not only
                -- BLOCKED_SETTLEMENT_DISPUTE_STATUSES (OPEN, UNDER_REVIEW,
                -- LOST).
                --
                -- disputeStatus IS THE COLUMN THAT IS WRITTEN.
                -- markDisputeStatus sets Order.disputeStatus and leaves
                -- status alone (orders/_shared/dispute-list-filter.ts), so
                -- a status of DISPUTED is never written by the dispute
                -- lifecycle. The status test stays for any row that has it.
                -- FULL-PRICE: applies. The credit rule changes nothing
                -- about what a dispute moves.
                AND c."status" <> 'DISPUTED'
                AND c."disputeStatus" IS NULL
                -- (3) Under ABSORB the processor fee is OURS, so an
                -- unstamped one is a real unknown — unless there was no
                -- payment intent at all, in which case there is no fee to
                -- stamp. Under PASS_THROUGH the buyer funded it, so it is
                -- not a platform cost and an unstamped fee does not
                -- disqualify.
                -- FULL-PRICE: applies. Who funds the processor fee is the
                -- fee mode's question, not the credit rule's.
                AND (
                  c."feeMode" <> 'ABSORB'
                  OR c."processorFeeCents" IS NOT NULL
                  OR c."stripePaymentIntentId" IS NULL
                )
                -- (4) Every refunded ticket item carries its fee stamp, or
                -- money went back with no record of how much fee went too.
                -- FULL-PRICE: applies. The buyer-side give-back is read off
                -- the same stamp.
                AND COALESCE(rti."unstampedCount", 0) = 0
                -- (5) NO REFUNDED TICKET ITEM ON AN ABSORB ORDER. Every
                -- refund path withholds the ACTUAL Stripe fee from the
                -- buyer (quote-full-refund, refund-full-order,
                -- refund-order-items, cancel-event — uniform across both
                -- modes), so the platform RECOVERS the processor fee it
                -- paid. Subtracting processorFeeCents in full on a refunded
                -- ABSORB order therefore charges it TWICE: face 1000 /
                -- fee 33 / Stripe 59 fully refunded is truly 0, but
                -- 33 - 59 - 33 = -59. The recovered share is stored
                -- NOWHERE, so it cannot be added back — and a cancelled
                -- event refunds every order, which would book hundreds of
                -- dollars of loss that never happened. Excluded until an
                -- OrderItem.refundedProcessorFeeCents sibling exists; see
                -- the use case header.
                -- FULL-PRICE: applies. The recovered processor fee is
                -- unrecorded under either credit rule.
                AND NOT (
                  c."feeMode" = 'ABSORB'
                  AND COALESCE(rti."refundedCount", 0) > 0
                )
                -- (6) NO REFUND ON AN ORDER THAT SPENT LIVE CREDIT. The
                -- refund pays the buyer NET of credit while the organiser
                -- is debited their FULL basis, so the refund recovers what
                -- the credit cost the platform — and nothing stamps the
                -- redemption (refundedAt has no writer), so the credit term
                -- would keep subtracting a cost that came back. Excluded
                -- rather than guessed.
                -- FULL-PRICE: applies. The organiser is still debited what
                -- they were credited (now the full price) while the buyer
                -- is paid net of credit, so the refund still recovers the
                -- credit's cost and still stamps nothing.
                AND NOT (
                  COALESCE(rti."refundedCount", 0) > 0
                  AND COALESCE(lc."creditCents", 0) > 0
                )
                -- (7) NOT A RESALE ORDER. create-resale-checkout records
                -- feesPlatformCents: 0 — the platform's resale cut is an
                -- OrderSplit line out of the basis plus
                -- processingPassThroughCents, and never touches the fee
                -- column — while hardcoding feeMode: 'PASS_THROUGH' in the
                -- snapshot. So a resale order passes every other condition
                -- and nets LEAST(0, gross) + 0 = exactly 0, at FULL
                -- coverage, with no reason attached: a resale-only currency
                -- would render "Net kept $0.00" as a complete answer when
                -- the platform in fact took a cut this read cannot see.
                -- A confidently wrong zero is worse than a null.
                --
                -- DO NOT REPLACE THIS WITH A feesPlatformCents = 0 GUARD:
                -- a genuine free or fee-waived ticketing order records 0
                -- too, and for those 0 is the TRUE answer. The worked
                -- example is claim-free-tickets: it DOES record a feeMode,
                -- gross 0, fee 0, so its 0 net is a measurement. COMP is NOT
                -- that example -- issue-comp-tickets writes an empty
                -- feePolicySnapshot, so condition 1 excludes every COMP order
                -- before this one is reached (verified on the dev database:
                -- 4 COMP orders, none with a recorded mode). Nothing is lost
                -- either way, since their gross and fee are both 0.
                -- FULL-PRICE: applies. A resale order is stamped too, and
                -- its cut is still an OrderSplit line this read cannot see.
                AND c."source" <> 'RESALE'
                -- (8) NOT A PARTIAL REFUND WHOSE BASIS-SIDE CAP BITES. The
                -- cap below clamps the AGGREGATE give-back at
                -- min(fee, gross) rather than pro-rating it per ticket, so
                -- it is exact when everything was refunded and too LARGE
                -- when only part was. 2 tickets at fee 50 (F=100) with a
                -- promo taking gross to 80, PASS_THROUGH, one ticket
                -- refunded with stamp 50: truly 90 kept, but
                -- 80 + 100 - LEAST(50, 80) - 50 = 80.
                --
                -- "Everything was refunded" is COUNTED, as in (9): refunded
                -- ticket items equal to all ticket items on the order
                -- (rot."ticketCount"). So this excludes only the inexact
                -- case and leaves the full refund — which the cap handles to
                -- the cent — eligible. It used to read Σstamped = fee, which
                -- a held FEE-WAIVED ticket fools: it has a real face and a
                -- fee share of 0, so refunding every fee-bearing ticket
                -- stamps the whole order fee while that ticket is still
                -- held. THE PRO-RATED ALTERNATIVE WAS REJECTED: integer
                -- division truncates, and on a SUBTRACTED term truncating
                -- subtracts LESS and therefore OVERSTATES the net. This
                -- file errs toward caution, never toward keeping profit.
                --
                -- FULL-PRICE: DOES NOT APPLY, and must not exclude. Nothing
                -- came out of the basis, so there is no basis-side unit, no
                -- cap and nothing for a cap to clamp. The platform holds
                -- the fee the buyer paid on top and gives back each
                -- refunded ticket's stamped share of it: fee - stamped.
                -- Where that is not exact is condition (9), not this one.
                AND NOT (
                  NOT c."creditedFullPrice"
                  AND c."feesPlatformCents" > c."amountGrossCents"
                  AND COALESCE(rti."refundedCount", 0) > 0
                  AND COALESCE(rti."refundedCount", 0) < rot."ticketCount"
                )
                -- (9) A PARTIAL REFUND ON A FULL-PRICE ORDER ONLY WHEN ITS
                -- COST IS THE STAMP. A full-price order nets fee - stamped.
                -- Three allocators run over the order's tickets with three
                -- different weights:
                --   * the buyer's refund base, by what the buyer paid
                --     (lib/orders/refund-item-base.ts);
                --   * the organiser's debit, by face, once PER PAYEE
                --     (settlements/create-credits-from-order.ts,
                --     attributeCreditToItems);
                --   * the stamp, the ticket's own fee
                --     (orders/_shared/refund-platform-fee-share.ts).
                -- Refunding ticket i costs the platform base_i - debit_i.
                -- Before any rounding that is
                --   fee_i - D * (paid_i / sum(paid) - face_i / sum(face))
                -- for a discount of D. A partial refund is admitted only
                -- when all three of these hold:
                --   * NO DISCOUNT LINE. With a discount the term above is
                --     not 0: tickets face 1000 / fee 33 and face 2000 / fee
                --     50 with 1500 off; refunding the second pays the buyer
                --     1053, docks the organiser 1000, and costs the platform
                --     53 against a stamp of 50, so fee - stamped reads 33
                --     kept where 30 was.
                --   * THE SPLITS ADD UP TO THE FACES (splitSumCents =
                --     ticketFaceSumCents). The organiser's debits on a
                --     ticket add up to face_i * sum(split) / sum(face), so a
                --     split total above the faces docks more than the face
                --     and one below docks less. An order with no split row
                --     has no refunded_order_splits row and fails this.
                --   * EVERY PAYEE'S SHARE OF EVERY TICKET IS WHOLE
                --     (refunded_order_attribution.attributionExact). The
                --     rounding is per payee, so two payees can each round
                --     the same ticket up: two at face 1999 / fee 33 split
                --     1999 : 1999 are debited 2000 and 1998, and refunding
                --     the second costs 34 where fee - stamped gives back 33.
                --     One payee holding the whole credit always passes.
                -- With all three, debit_i is face_i and the base is the
                -- ticket's own buyer total, so the refund costs that total
                -- less the face: the ticket's fee, which the stamp copies
                -- when the per-ticket fees are recorded and sum to the
                -- order fee (how checkout writes them), plus its
                -- processing-fee share (see KNOWN AND NOT YET EXCLUDED in
                -- the use case header). Each case is pinned against the
                -- real allocators in
                -- core/.../orders/_shared/__tests__/refund-platform-fee-exactness.test.ts.
                --
                -- EXCLUDED, NOT CORRECTED. The cents are recorded nowhere
                -- this query can read, and an order whose net is not known
                -- to the cent is left out of the sum and the count.
                --
                -- ANY DISCOUNT, not "a discount over unlike tickets": see
                -- refunded_order_tickets above. The exclusion costs
                -- coverage on some orders that happen to be exact. On a
                -- discounted marked order (9) admits only a refund of every
                -- ticket item.
                --
                -- A FULL REFUND STAYS ELIGIBLE. Every base and every debit
                -- comes back, the differences sum to the order fee, and
                -- fee - stamped is 0 exactly. "Partial" here is COUNTED, not
                -- read off the stamps: refunded ticket items fewer than all
                -- ticket items on the order (rot."ticketCount"). The stamp
                -- sum was rejected because fee-free tickets break it: with
                -- every fee-bearing ticket refunded and a waived one held
                -- the stamps equal the order fee, and with an order fee of 0
                -- ANY refund reads as full (three waived tickets, face 1000,
                -- 101 off, refund the first: the platform is out 1 cent).
                --
                -- UNSTAMPED orders are untouched by this one; (8) and (10)
                -- are theirs.
                AND NOT (
                  c."creditedFullPrice"
                  AND COALESCE(rti."refundedCount", 0) > 0
                  AND COALESCE(rti."refundedCount", 0) < rot."ticketCount"
                  AND NOT COALESCE(
                    NOT rot."hasDiscount"
                      AND ros."splitSumCents" = rot."ticketFaceSumCents"
                      AND roa."attributionExact",
                    FALSE
                  )
                )
                -- (10) NOT A PARTIAL REFUND ON AN UNSTAMPED ORDER OF UNLIKE
                -- TICKETS. An unstamped PASS_THROUGH order gives back two
                -- stamps per refunded ticket (the basis-side and buyer-side
                -- give-backs below). What the refund really costs is
                -- base_i - debit_i: the buyer's refund base, split by what
                -- the buyer paid, minus the organiser's debit, the credit
                -- (gross - fee) split by FACE (attributeCreditToItems). The
                -- stamp is the ticket's own per-ticket-capped fee, which is
                -- not the face ratio. Face 1000 / fee 33 and face 2000 / fee
                -- 50, no discount: the credit 2917 splits 972 : 1945, so
                -- refunding the second costs 2050 - 1945 = 105 where the
                -- net gives back 100, and refunding the first costs 61
                -- where it gives back 66. Pinned against the real
                -- allocators in
                -- core/.../orders/_shared/__tests__/refund-platform-fee-exactness.test.ts.
                --
                -- WHAT "LIKE" MUST MEAN for the partial refund to be exact,
                -- all five of:
                --   * one face on every ticket item, and
                --   * one per-ticket fee on every ticket item, every one of
                --     them recorded: then attribution by face hands each
                --     ticket an equal share of each payee's credit;
                --   * the splits sum to the faces less the fee, n * (face -
                --     fee), and EVERY payee's split divides by the ticket
                --     count: attribution is per payee, so each payee hands
                --     each ticket exactly its split / n with no leftover cent
                --     to place, and the shares add to face - fee. A payee
                --     whose split leaves a remainder puts it on the last
                --     ticket (see refunded_order_splits). One payee at 100%
                --     always divides; an order with no splits never passes;
                --   * the per-ticket fees sum to the order fee: otherwise
                --     the stamp is allocated by buyer-paid weight instead of
                --     copied, and its leftover cent can land elsewhere;
                --   * no discount line: a discount is spread over the
                --     buyer's base and the organiser's credit by two
                --     allocators that place their leftover cents on
                --     different tickets. Three at face 1000 / fee 33 with 101
                --     off cost 67, 66 and 65 against 66 each.
                -- A fee-waived ticket beside a fee-bearing one is unlike by
                -- fee, so a held waived ticket cannot pass as like.
                --
                -- A FULL REFUND STAYS ELIGIBLE whatever the tickets: every
                -- base and every debit comes back and the differences sum to
                -- both units exactly. "Partial" is COUNTED, as in (8) and
                -- (9). An unrefunded order is never touched.
                --
                -- FULL-PRICE: DOES NOT APPLY. A marked order has no
                -- basis-side unit; its partial refund is (9)'s question.
                AND NOT (
                  NOT c."creditedFullPrice"
                  AND COALESCE(rti."refundedCount", 0) > 0
                  AND COALESCE(rti."refundedCount", 0) < rot."ticketCount"
                  AND NOT COALESCE(
                    rot."likeTickets"
                      AND NOT rot."hasDiscount"
                      AND rot."ticketFeeSumCents" = c."feesPlatformCents"
                      AND ros."splitsDivide"
                      AND ros."splitSumCents"
                        = rot."ticketFaceSumCents" - rot."ticketFeeSumCents",
                    FALSE
                  )
                )
                -- (11) NOT AN ORDER A STRIPE-SIDE PARTIAL REFUND PAID BACK
                -- WITHOUT REFUNDING A TICKET ITEM. The buyer has money back,
                -- the payees were debited a proportional share, and nothing
                -- on the order's items says so: it would net as unrefunded,
                -- the whole fee kept. See external_amount_refunds.
                -- FULL-PRICE: applies. Neither credit rule records the
                -- amount such a refund moved.
                AND NOT (
                  ear."orderId" IS NOT NULL
                  AND COALESCE(rti."refundedCount", 0) = 0
                ),
              FALSE
            ) AS "netEligible",
            (
              -- BASIS-SIDE UNIT, with the basis cap folded in. The
              -- organiser's basis is max(gross - fee, 0), so what the fee
              -- actually took out of it is min(fee, gross). PER ORDER,
              -- never per item: the floor applies once at order level, and
              -- a per-item variant would clip tickets whose siblings' gross
              -- funded the fee.
              --
              -- ZERO ON A FULL-PRICE-CREDITED ORDER. Its basis is the gross
              -- itself, so the fee took nothing out of it. This is the unit
              -- the 2026-10-11 ruling removed: gross 7500 / fee 50
              -- PASS_THROUGH nets 50 stamped and 100 unstamped.
              CASE WHEN c."creditedFullPrice" THEN 0
                   ELSE LEAST(c."feesPlatformCents", c."amountGrossCents")
              END::bigint
              -- BUYER-SIDE UNIT. PASS_THROUGH only: the buyer paid the fee
              -- on top of the ticket.
              + CASE WHEN c."feeMode" = 'PASS_THROUGH' THEN c."feesPlatformCents" ELSE 0 END
              -- PROCESSOR COST is a platform cost only under ABSORB; under
              -- PASS_THROUGH the checkout gross-up had the buyer fund it.
              -- On a REFUNDED order the platform recovers it, which is what
              -- condition (5) is about.
              - CASE WHEN c."feeMode" = 'ABSORB' THEN COALESCE(c."processorFeeCents", 0) ELSE 0 END
              -- FEES RETURNED, TWO TERMS, because the two units come back
              -- under different caps. The stamp is the item's share of
              -- feesPlatformCents and is UNCAPPED by construction.
              --
              -- BASIS-SIDE GIVE-BACK, CAPPED BY THE SAME CAP THAT LIMITED
              -- THE TAKE. Only min(fee, gross) was ever taken out of the
              -- basis, so only that much can be given back. Without the cap
              -- a deep discount goes negative for no reason: gross 10 /
              -- fee 33 / stamp 33 PASS_THROUGH is truly 0, but
              -- 10 + 33 - 66 = -23. Identical to an uncapped stamp whenever
              -- fee <= gross (stamps sum to the order fee at most), so this
              -- only bites where it must.
              --
              -- ZERO ON A FULL-PRICE-CREDITED ORDER, for the reason the take
              -- is zero: a unit that was never taken cannot be given back.
              -- The refund docks the organiser the full price they were
              -- credited, so the face nets out between buyer and organiser
              -- and the platform returns the fee from its one unit below.
              - CASE WHEN c."creditedFullPrice" THEN 0
                     ELSE LEAST(
                       COALESCE(rti."stampedFeeCents", 0),
                       LEAST(c."feesPlatformCents", c."amountGrossCents")
                     )
                END
              -- BUYER-SIDE GIVE-BACK, correctly UNCAPPED: under
              -- PASS_THROUGH the buyer paid the full fee on top of the
              -- ticket regardless of any promo, and gets all of it back.
              -- Together the two terms are the decision record's worked
              -- table for an order credited price minus fee: PASS_THROUGH
              -- returns both units, ABSORB one. A full-price-credited order
              -- returns this one alone. (ABSORB refunds are ineligible
              -- today by (5), so the ABSORB branch is written for
              -- correctness rather than exercised.)
              - CASE WHEN c."feeMode" = 'PASS_THROUGH'
                     THEN COALESCE(rti."stampedFeeCents", 0) ELSE 0 END
              -- PLATFORM-FUNDED CREDIT: a discount the platform paid for
              -- out of margin. Only ever reaches an UNREFUNDED order, by (6).
              - COALESCE(lc."creditCents", 0)
            )::bigint AS "netCents"
          FROM counted c
          LEFT JOIN refunded_ticket_items rti ON rti."orderId" = c."orderId"
          LEFT JOIN live_credit lc ON lc."orderId" = c."orderId"
          -- One row per order at most (GROUP BY), so this join cannot
          -- multiply an order either.
          LEFT JOIN refunded_order_tickets rot ON rot."orderId" = c."orderId"
          -- One row per order at most (GROUP BY) as well.
          LEFT JOIN refunded_order_splits ros ON ros."orderId" = c."orderId"
          -- One row per order at most (GROUP BY): the split x ticket pairs
          -- are folded away inside the CTE.
          LEFT JOIN refunded_order_attribution roa ON roa."orderId" = c."orderId"
          -- One row per order at most (DISTINCT).
          LEFT JOIN external_amount_refunds ear ON ear."orderId" = c."orderId"
        )
        SELECT
          o."currency"                                     AS "currency",
          COALESCE(SUM(o."amountGrossCents"), 0)::bigint    AS "ticketVolumeCents",
          COALESCE(SUM(o."feesPlatformCents"), 0)::bigint   AS "platformFeesChargedCents",
          COALESCE(SUM(o."feesPlatformCents") FILTER (
            WHERE o."feeMode" = 'PASS_THROUGH'
          ), 0)::bigint                                     AS "platformFeesPassThroughCents",
          COALESCE(SUM(o."feesPlatformCents") FILTER (
            WHERE o."feeMode" = 'ABSORB'
          ), 0)::bigint                                     AS "platformFeesAbsorbCents",
          -- IS DISTINCT FROM, not <>: a missing key yields NULL and NULL <> x
          -- is NULL, which would drop those orders from every bucket.
          COALESCE(SUM(o."feesPlatformCents") FILTER (
            WHERE o."feeMode" IS DISTINCT FROM 'PASS_THROUGH'
              AND o."feeMode" IS DISTINCT FROM 'ABSORB'
          ), 0)::bigint                                     AS "platformFeesUnknownModeCents",
          COALESCE(SUM(o."taxAmountCents"), 0)::bigint      AS "taxCollectedCents",
          COUNT(*)::bigint                                  AS "orderCount",
          -- Σ over the orders the sweep has ALREADY read. Partial by design:
          -- NULL contributes nothing, so this understates cost until coverage
          -- is complete — which is exactly why the two counts ride alongside
          -- it and the caller labels the line.
          COALESCE(SUM(o."processorFeeCents"), 0)::bigint   AS "processorFeeCents",
          COUNT(o."processorFeeCents")::bigint              AS "processorFeeMeasuredCount",
          -- Orders that COULD carry a fee: the sweep can only read one from a
          -- charge's balance transaction, so an order with no payment intent
          -- is not missing data and must not count against coverage.
          COUNT(*) FILTER (
            WHERE o."stripePaymentIntentId" IS NOT NULL
          )::bigint                                         AS "processorFeeEligibleCount",
          -- Eligible, still NULL, and PARKED by the sweep: at or past the
          -- failure cap, so it will never be read without a manual reset.
          -- The cap is the sweep's own constant, bound as a parameter, so
          -- the two cannot drift apart.
          COUNT(*) FILTER (
            WHERE o."stripePaymentIntentId" IS NOT NULL
              AND o."processorFeeCents" IS NULL
              AND o."processorFeeReadFailures" >= ${PROCESSOR_FEE_MAX_READ_FAILURES}
          )::bigint                                         AS "processorFeeParkedCount",
          -- THE FEES-RETURNED LINE, derived from the SAME per-order fold the
          -- net uses. It used to be its own item-grain subquery LEFT JOINed
          -- per currency, which scanned OrderItem a second time under the
          -- identical filter. Order grain makes the sums identical (every
          -- refunded ticket item belongs to exactly one order, and every
          -- counted order appears here exactly once) while halving the work.
          COALESCE(SUM(o."stampedFeeCents"), 0)::bigint     AS "feesReturnedCents",
          -- Refunded ticket items WITH a stamp. Counted as
          -- refunded − unstamped rather than by a second COUNT, because at
          -- order grain the individual items are already folded away.
          COALESCE(SUM(
            o."refundedTicketCount" - o."unstampedTicketCount"
          ), 0)::bigint                                     AS "feesReturnedMeasuredCount",
          COALESCE(SUM(o."refundedTicketCount"), 0)::bigint AS "feesReturnedEligibleCount",
          -- THE NET, over the eligible orders only. SIGNED. An ineligible
          -- order contributes to NEITHER the sum nor the count, so the
          -- caller can report exactly how much of the currency it covers.
          COALESCE(SUM(o."netCents") FILTER (
            WHERE o."netEligible"
          ), 0)::bigint                                     AS "netKeptCents",
          COUNT(*) FILTER (
            WHERE o."netEligible"
          )::bigint                                         AS "netKeptEligibleCount"
        FROM order_net o
        GROUP BY o."currency"
        ORDER BY o."currency" ASC
      `);

      return rows.map((row) => ({
        currency: row.currency,
        // Diagnostic figures, never a transfer input: bigint → number the
        // way the reconciliation reads do, so a pathological total is
        // reported rather than raising 22003 on an ::int cast.
        ticketVolumeCents: Number(row.ticketVolumeCents),
        platformFeesChargedCents: Number(row.platformFeesChargedCents),
        platformFeesPassThroughCents: Number(row.platformFeesPassThroughCents),
        platformFeesAbsorbCents: Number(row.platformFeesAbsorbCents),
        platformFeesUnknownModeCents: Number(row.platformFeesUnknownModeCents),
        taxCollectedCents: Number(row.taxCollectedCents),
        orderCount: Number(row.orderCount),
        processorFeeCents: Number(row.processorFeeCents),
        processorFeeMeasuredCount: Number(row.processorFeeMeasuredCount),
        processorFeeEligibleCount: Number(row.processorFeeEligibleCount),
        processorFeeParkedCount: Number(row.processorFeeParkedCount),
        feesReturnedCents: Number(row.feesReturnedCents),
        feesReturnedMeasuredCount: Number(row.feesReturnedMeasuredCount),
        feesReturnedEligibleCount: Number(row.feesReturnedEligibleCount),
        // SIGNED — Number() keeps the sign; a negative net is a real answer.
        netKeptCents: Number(row.netKeptCents),
        netKeptEligibleCount: Number(row.netKeptEligibleCount),
      }));
    },

    async getOrgDashboardSummary(orgId: string): Promise<OrgDashboardSummary> {
      // Use a single raw query: join EventDailyStats with Event (filtered by orgId),
      // pick the latest stats row per event via DISTINCT ON, then aggregate.
      const rows: Array<{
        total_gross_revenue_cents: bigint | null;
        total_net_revenue_cents: bigint | null;
        total_tickets_sold: bigint | null;
        total_refunded_cents: bigint | null;
        total_capacity: bigint | null;
        event_count: bigint | null;
      }> = await (p as any).$queryRawUnsafe(
        `SELECT
           COALESCE(SUM(s."grossRevenueCents"), 0)  AS total_gross_revenue_cents,
           COALESCE(SUM(s."netRevenueCents"), 0)     AS total_net_revenue_cents,
           COALESCE(SUM(s."ticketsSold"), 0)         AS total_tickets_sold,
           COALESCE(SUM(s."refundedCents"), 0)       AS total_refunded_cents,
           COALESCE(SUM(s."totalCapacity"), 0)       AS total_capacity,
           COUNT(*)                                   AS event_count
         FROM (
           SELECT DISTINCT ON (eds."eventId")
             eds."grossRevenueCents",
             eds."netRevenueCents",
             eds."ticketsSold",
             eds."refundedCents",
             eds."totalCapacity"
           FROM "EventDailyStats" eds
           INNER JOIN "Event" e ON e.id = eds."eventId"
           WHERE e."orgId" = $1
           ORDER BY eds."eventId", eds."date" DESC
         ) s`,
        orgId,
      );

      const row = rows[0];
      const totalGrossRevenueCents = Number(
        row?.total_gross_revenue_cents ?? 0,
      );
      const totalNetRevenueCents = Number(row?.total_net_revenue_cents ?? 0);
      const totalTicketsSold = Number(row?.total_tickets_sold ?? 0);
      const totalRefundedCents = Number(row?.total_refunded_cents ?? 0);
      const totalCapacity = Number(row?.total_capacity ?? 0);
      const eventCount = Number(row?.event_count ?? 0);

      const averageSellThroughRate =
        totalCapacity > 0 ? totalTicketsSold / totalCapacity : 0;
      const refundRate =
        totalGrossRevenueCents > 0
          ? totalRefundedCents / totalGrossRevenueCents
          : 0;

      return {
        totalGrossRevenueCents,
        totalNetRevenueCents,
        totalTicketsSold,
        averageSellThroughRate,
        totalRefundedCents,
        refundRate,
        eventCount,
      };
    },
  };
}
