import { Prisma } from "@prisma/client";
import type { FeeWaiver, FeeWaiverRedemption } from "@prisma/client";
import type {
  FeeWaiverRecord,
  FeeWaiverRedemptionRecord,
  FeeWaiversRepo,
  GrantFeeWaiverInput,
  ListFeeWaiversInput,
} from "@th/ports/repos/fee-waivers";

import type { PrismaClientOrTx } from "./types";

export function makeFeeWaiversRepo(p: PrismaClientOrTx): FeeWaiversRepo {
  return {
    async getById(id) {
      const waiver = await p.feeWaiver.findUnique({ where: { id } });
      return waiver ? toFeeWaiverRecord(waiver) : null;
    },

    async resolveApplicable({
      buyerHumanId,
      organizerOrgId,
      organizerHumanId,
      at,
    }) {
      // Raw because `ticketsUsed < ticketsGranted` is a column-to-column
      // comparison, which Prisma's `where` cannot express.
      const subjectClauses: Prisma.Sql[] = [];

      if (buyerHumanId) {
        subjectClauses.push(
          Prisma.sql`("side" = 'BUYER' AND "subjectType" = 'HUMAN' AND "subjectId" = ${buyerHumanId})`,
        );
      }
      if (organizerOrgId) {
        subjectClauses.push(
          Prisma.sql`("side" = 'ORGANIZER' AND "subjectType" = 'ORG' AND "subjectId" = ${organizerOrgId})`,
        );
      }
      if (organizerHumanId) {
        subjectClauses.push(
          Prisma.sql`("side" = 'ORGANIZER' AND "subjectType" = 'HUMAN' AND "subjectId" = ${organizerHumanId})`,
        );
      }

      // No identified party — nothing can apply. Returning early also stops us
      // emitting `WHERE ()`, which is a syntax error.
      if (subjectClauses.length === 0) return [];

      const rows = await p.$queryRaw<FeeWaiver[]>(Prisma.sql`
        SELECT *
        FROM "FeeWaiver"
        WHERE "status" = 'ACTIVE'
          AND "ticketsUsed" < "ticketsGranted"
          AND "effectiveFrom" <= ${at}
          AND ("effectiveTo" IS NULL OR "effectiveTo" > ${at})
          AND (${Prisma.join(subjectClauses, " OR ")})
        -- Most-depleted first: burn a nearly-spent allowance down to zero
        -- before opening a fresh one, so remaining balances stay legible.
        ORDER BY ("ticketsGranted" - "ticketsUsed") ASC, "createdAt" ASC
      `);

      return rows.map(toFeeWaiverRecord);
    },

    async reserve({ waiverId, orderId, waivableTicketFeesCents }) {
      const requestedTickets = waivableTicketFeesCents.length;
      if (requestedTickets <= 0) {
        return { reservedTickets: 0, feeWaivedCents: 0, redemptionId: null };
      }

      // Idempotency: a checkout retry for the same order must not double-spend.
      const existing = await p.feeWaiverRedemption.findUnique({
        where: { waiverId_orderId: { waiverId, orderId } },
      });
      if (existing && existing.status !== "RELEASED") {
        return {
          reservedTickets: existing.ticketsReserved,
          feeWaivedCents: existing.feeWaivedCents,
          redemptionId: existing.id,
        };
      }

      const now = new Date();

      // Single atomic conditional UPDATE. `prev` takes a row lock so two
      // checkouts racing for the last ticket of an allowance serialise here;
      // LEAST() clamps to the grant so the loser gets a partial (or zero)
      // reservation instead of overselling.
      //
      // RETURNING sees the NEW ticketsUsed on `f` and the pre-update snapshot
      // on `prev`, so their difference is exactly what this call claimed.
      const claimed = await p.$queryRaw<Array<{ reserved: number }>>(
        Prisma.sql`
        WITH prev AS (
          SELECT "id", "ticketsUsed"
          FROM "FeeWaiver"
          WHERE "id" = ${waiverId}
            AND "status" = 'ACTIVE'
            AND "ticketsUsed" < "ticketsGranted"
            AND "effectiveFrom" <= ${now}
            AND ("effectiveTo" IS NULL OR "effectiveTo" > ${now})
          FOR UPDATE
        )
        UPDATE "FeeWaiver" f
        SET "ticketsUsed" = LEAST(f."ticketsGranted", f."ticketsUsed" + ${requestedTickets}),
            "status" = CASE
              WHEN LEAST(f."ticketsGranted", f."ticketsUsed" + ${requestedTickets}) >= f."ticketsGranted"
                THEN 'EXHAUSTED'::"FeeWaiverStatus"
              ELSE f."status"
            END,
            "updatedAt" = ${now}
        FROM prev
        WHERE f."id" = prev."id"
        RETURNING (f."ticketsUsed" - prev."ticketsUsed")::int AS reserved
      `,
      );

      const reservedTickets = claimed[0]?.reserved ?? 0;
      if (reservedTickets <= 0) {
        return { reservedTickets: 0, feeWaivedCents: 0, redemptionId: null };
      }

      // A partial reservation waives the most expensive tickets, so the cost is
      // the sum of the first `reservedTickets` entries of the descending ladder.
      const feeWaivedCents = waivableTicketFeesCents
        .slice(0, reservedTickets)
        .reduce((sum, cents) => sum + cents, 0);

      // `upsert` rather than `create`: a previously RELEASED redemption for
      // this (waiver, order) still occupies the unique slot.
      const redemption = await p.feeWaiverRedemption.upsert({
        where: { waiverId_orderId: { waiverId, orderId } },
        create: {
          waiverId,
          orderId,
          ticketsReserved: reservedTickets,
          feeWaivedCents,
          status: "RESERVED",
        },
        update: {
          ticketsReserved: reservedTickets,
          feeWaivedCents,
          status: "RESERVED",
          releasedAt: null,
          settledAt: null,
        },
      });

      return {
        reservedTickets,
        feeWaivedCents,
        redemptionId: redemption.id,
      };
    },

    async release(orderId) {
      // Releases both RESERVED (checkout died) and SETTLED (order refunded)
      // redemptions. Already-RELEASED rows are skipped, so a duplicate webhook
      // delivery cannot inflate an allowance back above its grant.
      const rows = await p.$queryRaw<Array<{ released_tickets: number }>>(
        Prisma.sql`
        WITH released AS (
          UPDATE "FeeWaiverRedemption"
          SET "status" = 'RELEASED',
              "releasedAt" = NOW(),
              "updatedAt" = NOW()
          WHERE "orderId" = ${orderId}
            AND "status" IN ('RESERVED', 'SETTLED')
          RETURNING "waiverId", "ticketsReserved"
        ),
        agg AS (
          SELECT "waiverId", SUM("ticketsReserved")::int AS tickets
          FROM released
          GROUP BY "waiverId"
        )
        UPDATE "FeeWaiver" f
        SET "ticketsUsed" = GREATEST(0, f."ticketsUsed" - agg.tickets),
            -- Re-open an exhausted allowance, but never resurrect a REVOKED one.
            "status" = CASE
              WHEN f."status" = 'EXHAUSTED' THEN 'ACTIVE'::"FeeWaiverStatus"
              ELSE f."status"
            END,
            "updatedAt" = NOW()
        FROM agg
        WHERE f."id" = agg."waiverId"
        RETURNING agg.tickets AS released_tickets
      `,
      );

      return {
        releasedTickets: rows.reduce((sum, r) => sum + r.released_tickets, 0),
      };
    },

    async settle(orderId) {
      const result = await p.feeWaiverRedemption.updateMany({
        where: { orderId, status: "RESERVED" },
        data: { status: "SETTLED", settledAt: new Date() },
      });

      // ticketsUsed already counts RESERVED, so settling moves no counters —
      // it only hardens the reservation against a checkout-expiry sweep.
      const redemptions = await p.feeWaiverRedemption.findMany({
        where: { orderId, status: "SETTLED" },
        select: { ticketsReserved: true },
      });

      return {
        settledTickets:
          result.count === 0
            ? 0
            : redemptions.reduce((sum, r) => sum + r.ticketsReserved, 0),
      };
    },

    async listRedemptionsByOrder(orderId) {
      const rows = await p.feeWaiverRedemption.findMany({
        where: { orderId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toRedemptionRecord);
    },

    async grant(input: GrantFeeWaiverInput): Promise<FeeWaiverRecord> {
      const created = await p.feeWaiver.create({
        data: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          side: input.side,
          ticketsGranted: input.ticketsGranted,
          effectiveFrom: input.effectiveFrom ?? new Date(),
          effectiveTo: input.effectiveTo ?? null,
          notes: input.notes ?? null,
          createdBy: input.actorHumanId,
        },
      });
      return toFeeWaiverRecord(created);
    },

    async revoke({ waiverId, actorHumanId }) {
      const updated = await p.feeWaiver.update({
        where: { id: waiverId },
        data: {
          status: "REVOKED",
          revokedBy: actorHumanId,
          revokedAt: new Date(),
        },
      });
      return toFeeWaiverRecord(updated);
    },

    async list(input: ListFeeWaiversInput) {
      const where: Prisma.FeeWaiverWhereInput = {};
      if (input.subjectType) where.subjectType = input.subjectType;
      if (input.subjectId) where.subjectId = input.subjectId;
      if (input.side) where.side = input.side;
      if (!input.includeInactive) where.status = "ACTIVE";

      const [waivers, total] = await Promise.all([
        p.feeWaiver.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: input.limit ?? 50,
          skip: input.offset ?? 0,
        }),
        p.feeWaiver.count({ where }),
      ]);

      return { waivers: waivers.map(toFeeWaiverRecord), total };
    },
  };
}

function toFeeWaiverRecord(w: FeeWaiver): FeeWaiverRecord {
  return {
    id: w.id,
    subjectType: w.subjectType,
    subjectId: w.subjectId,
    side: w.side,
    ticketsGranted: w.ticketsGranted,
    ticketsUsed: w.ticketsUsed,
    ticketsRemaining: Math.max(0, w.ticketsGranted - w.ticketsUsed),
    status: w.status,
    effectiveFrom: w.effectiveFrom,
    effectiveTo: w.effectiveTo,
    notes: w.notes,
    createdBy: w.createdBy,
    revokedBy: w.revokedBy,
    revokedAt: w.revokedAt,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

function toRedemptionRecord(r: FeeWaiverRedemption): FeeWaiverRedemptionRecord {
  return {
    id: r.id,
    waiverId: r.waiverId,
    orderId: r.orderId,
    ticketsReserved: r.ticketsReserved,
    feeWaivedCents: r.feeWaivedCents,
    status: r.status,
    releasedAt: r.releasedAt,
    settledAt: r.settledAt,
    createdAt: r.createdAt,
  };
}
