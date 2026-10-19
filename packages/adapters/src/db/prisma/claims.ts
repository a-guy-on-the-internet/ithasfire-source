import type { ClaimsRepo } from "@th/ports/repos/claims";
import type { ClaimRecord } from "@th/types/repos/claims";
import {
  buildOffsetPaginatedResult,
  sanitizeOffsetPagination,
} from "@th/ports/pagination";

import type { PrismaClientOrTx } from "./types";

/** Map a Prisma row to the port record type. */
function toRecord(row: {
  id: string;
  orderId: string;
  orderItemId: string;
  eventId: string;
  claimantId: string;
  respondentId: string;
  kind: string;
  status: string;
  evidence: unknown;
  deadline: Date;
  resolvedAt: Date | null;
  resolvedById: string | null;
  resolutionNote: string | null;
  resolution: string | null;
  sellerEvidence: unknown;
  sellerRespondedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ClaimRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    orderItemId: row.orderItemId,
    eventId: row.eventId,
    claimantId: row.claimantId,
    respondentId: row.respondentId,
    kind: row.kind,
    status: row.status as ClaimRecord["status"],
    evidence: row.evidence,
    deadline: row.deadline,
    resolvedAt: row.resolvedAt,
    resolvedById: row.resolvedById,
    resolutionNote: row.resolutionNote,
    resolution: row.resolution,
    sellerEvidence: row.sellerEvidence,
    sellerRespondedAt: row.sellerRespondedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeClaimsRepo(p: PrismaClientOrTx): ClaimsRepo {
  return {
    create: async (input) => {
      const row = await p.claim.create({
        data: {
          orderId: input.orderId,
          orderItemId: input.orderItemId,
          eventId: input.eventId,
          claimantId: input.claimantId,
          respondentId: input.respondentId,
          kind: input.kind,
          evidence: input.evidence as object,
          deadline: input.deadline,
        },
      });
      return toRecord(row);
    },

    getById: async (id) => {
      const row = await p.claim.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    getByOrderItemId: async (orderItemId) => {
      const row = await p.claim.findUnique({ where: { orderItemId } });
      return row ? toRecord(row) : null;
    },

    lockOrderItem: async (orderItemId) => {
      // Transaction-scoped: released at COMMIT/ROLLBACK, so it only
      // serializes anything when `p` is the tx client (port doc).
      // `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns
      // Postgres `void`, which the driver adapter cannot deserialize. The key
      // is a bound parameter (tagged template), never interpolated SQL.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`claim_order_item:${orderItemId}`}))`;
    },

    updateStatus: async (id, input) => {
      const data: Record<string, unknown> = { status: input.status };
      if (input.resolution) data.resolution = input.resolution;
      if (input.resolvedById) data.resolvedById = input.resolvedById;
      if (input.resolutionNote !== undefined)
        data.resolutionNote = input.resolutionNote;
      if (
        input.status === "approved" ||
        input.status === "denied" ||
        input.status === "expired"
      ) {
        data.resolvedAt = new Date();
      }
      // Conditional on the prior status (port doc): `updateMany` so a row
      // that has moved on matches nothing instead of being overwritten.
      const { count } = await p.claim.updateMany({
        where: { id, status: input.fromStatus },
        data,
      });
      if (count === 0) return null;
      const row = await p.claim.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    listByEvent: async ({ eventId, status, limit, offset }) => {
      const { limit: safeLimit, offset: safeOffset } = sanitizeOffsetPagination(
        { limit, offset },
      );

      const where = {
        eventId,
        ...(status && status.length > 0 ? { status: { in: status } } : {}),
      };

      const [items, total] = await Promise.all([
        p.claim.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: safeLimit,
          skip: safeOffset,
        }),
        p.claim.count({ where }),
      ]);

      return buildOffsetPaginatedResult({
        items: items.map(toRecord),
        total,
        limit: safeLimit,
        offset: safeOffset,
      });
    },

    listByClaimant: async (humanId, { orderId, limit, offset }) => {
      const { limit: safeLimit, offset: safeOffset } = sanitizeOffsetPagination(
        { limit, offset },
      );

      const where = { claimantId: humanId, ...(orderId ? { orderId } : {}) };

      const [items, total] = await Promise.all([
        p.claim.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: safeLimit,
          skip: safeOffset,
        }),
        p.claim.count({ where }),
      ]);

      return buildOffsetPaginatedResult({
        items: items.map(toRecord),
        total,
        limit: safeLimit,
        offset: safeOffset,
      });
    },

    listByRespondent: async (humanId, { status, limit, offset }) => {
      const { limit: safeLimit, offset: safeOffset } = sanitizeOffsetPagination(
        { limit, offset },
      );

      const where = {
        respondentId: humanId,
        ...(status && status.length > 0 ? { status: { in: status } } : {}),
      };

      const [items, total] = await Promise.all([
        p.claim.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: safeLimit,
          skip: safeOffset,
        }),
        p.claim.count({ where }),
      ]);

      return buildOffsetPaginatedResult({
        items: items.map(toRecord),
        total,
        limit: safeLimit,
        offset: safeOffset,
      });
    },

    listAll: async ({ status, limit, offset }) => {
      const { limit: safeLimit, offset: safeOffset } = sanitizeOffsetPagination(
        { limit, offset },
      );

      const where = {
        ...(status && status.length > 0 ? { status: { in: status } } : {}),
      };

      const [items, total] = await Promise.all([
        p.claim.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: safeLimit,
          skip: safeOffset,
        }),
        p.claim.count({ where }),
      ]);

      return buildOffsetPaginatedResult({
        items: items.map(toRecord),
        total,
        limit: safeLimit,
        offset: safeOffset,
      });
    },

    hasOpenClaims: async (orderId) => {
      const count = await p.claim.count({
        where: { orderId, status: { in: ["open", "under_review"] } },
      });
      return count > 0;
    },

    refundedOrderIds: async (orderIds) => {
      if (orderIds.length === 0) return new Set<string>();
      const rows = await p.order.findMany({
        where: { id: { in: orderIds }, status: "REFUNDED" },
        select: { id: true },
      });
      return new Set(rows.map((row) => row.id));
    },

    settlementIdsWithOpenClaims: async (settlementIds) => {
      if (settlementIds.length === 0) return new Set<string>();

      // Single query: settlement → settlement_lines → order_item_settlement_lines
      // → order_items → claims (open/under_review). Tables are
      // schema-qualified (public.*) to keep this raw query independent of
      // the connection's runtime `search_path` — Neon's pooled endpoint
      // can briefly return connections with an empty search_path on
      // compute wake-up, surfacing as 42P01 "relation does not exist".
      const rows = await p.$queryRaw<{ settlement_id: string }[]>`
        SELECT DISTINCT sl."settlementId" AS settlement_id
        FROM public."SettlementLine" sl
        JOIN public."OrderItemSettlementLine" oisl ON oisl."settlementLineId" = sl.id
        JOIN public."OrderItem" oi ON oi.id = oisl."orderItemId"
        JOIN public."Claim" c ON c."orderId" = oi."orderId"
        WHERE sl."settlementId" = ANY(${settlementIds}::text[])
          AND c.status IN ('open', 'under_review')
      `;

      return new Set(rows.map((r) => r.settlement_id));
    },

    recordSellerResponse: async (claimId, { sellerEvidence, respondedAt }) => {
      // Only while undecided (port doc): a decided claim matches nothing.
      const { count } = await p.claim.updateMany({
        where: { id: claimId, status: { in: ["open", "under_review"] } },
        data: {
          sellerEvidence: sellerEvidence as object,
          sellerRespondedAt: respondedAt,
        },
      });
      if (count === 0) return null;
      const row = await p.claim.findUnique({ where: { id: claimId } });
      return row ? toRecord(row) : null;
    },
  };
}
