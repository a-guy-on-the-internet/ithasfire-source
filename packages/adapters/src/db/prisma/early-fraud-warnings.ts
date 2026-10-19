import type { EarlyFraudWarning, Prisma } from "@prisma/client";
import type {
  EarlyFraudWarningRecord,
  EarlyFraudWarningResolution,
  EarlyFraudWarningsRepo,
  UpsertEarlyFraudWarningInput,
} from "@th/ports/repos/early-fraud-warnings";

import type { PrismaClientOrTx } from "./types";

const ACTIONABLE_MAX_ROWS = 200;

const hasOwn = <K extends keyof UpsertEarlyFraudWarningInput>(
  input: UpsertEarlyFraudWarningInput,
  key: K,
): boolean => Object.prototype.hasOwnProperty.call(input, key);

function mapRow(row: EarlyFraudWarning): EarlyFraudWarningRecord {
  return {
    id: row.id,
    stripeEfwId: row.stripeEfwId,
    stripeChargeId: row.stripeChargeId,
    paymentIntentId: row.paymentIntentId ?? null,
    orderId: row.orderId ?? null,
    ownerOrgId: row.ownerOrgId ?? null,
    ownerHumanId: row.ownerHumanId ?? null,
    fraudType: row.fraudType,
    actionable: row.actionable,
    stripeCreatedAt: row.stripeCreatedAt,
    resolvedAt: row.resolvedAt ?? null,
    resolution: (row.resolution as EarlyFraudWarningResolution | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Newest Stripe warning first; id breaks ties deterministically.
const NEWEST_FIRST: Prisma.EarlyFraudWarningOrderByWithRelationInput[] = [
  { stripeCreatedAt: "desc" },
  { id: "desc" },
];

export function makeEarlyFraudWarningsRepo(
  p: PrismaClientOrTx,
): EarlyFraudWarningsRepo {
  return {
    upsertFromStripe: async (input) => {
      // Linkage columns only move on update when the caller SUPPLIES a
      // non-null value: a thinner replay (no PI, no order) must never unlink
      // what the first delivery resolved. `actionable` / `fraudType` /
      // `stripeCreatedAt` always follow Stripe.
      const linkage: Prisma.EarlyFraudWarningUncheckedUpdateInput = {
        ...(hasOwn(input, "paymentIntentId") && input.paymentIntentId
          ? { paymentIntentId: input.paymentIntentId }
          : {}),
        ...(hasOwn(input, "orderId") && input.orderId
          ? { orderId: input.orderId }
          : {}),
        ...(hasOwn(input, "ownerOrgId") && input.ownerOrgId
          ? { ownerOrgId: input.ownerOrgId }
          : {}),
        ...(hasOwn(input, "ownerHumanId") && input.ownerHumanId
          ? { ownerHumanId: input.ownerHumanId }
          : {}),
      };
      const row = await p.earlyFraudWarning.upsert({
        where: { stripeEfwId: input.stripeEfwId },
        create: {
          stripeEfwId: input.stripeEfwId,
          stripeChargeId: input.stripeChargeId,
          paymentIntentId: input.paymentIntentId ?? null,
          orderId: input.orderId ?? null,
          ownerOrgId: input.ownerOrgId ?? null,
          ownerHumanId: input.ownerHumanId ?? null,
          fraudType: input.fraudType,
          actionable: input.actionable,
          stripeCreatedAt: input.stripeCreatedAt,
        },
        update: {
          stripeChargeId: input.stripeChargeId,
          fraudType: input.fraudType,
          actionable: input.actionable,
          stripeCreatedAt: input.stripeCreatedAt,
          ...linkage,
        },
      });
      return mapRow(row);
    },

    findByStripeEfwId: async (stripeEfwId) => {
      const row = await p.earlyFraudWarning.findUnique({
        where: { stripeEfwId },
      });
      return row ? mapRow(row) : null;
    },

    listActionable: async (input) => {
      const take = Math.min(
        Math.max(1, Math.trunc(input?.limit ?? ACTIONABLE_MAX_ROWS)),
        ACTIONABLE_MAX_ROWS,
      );
      const rows = await p.earlyFraudWarning.findMany({
        where: { actionable: true, resolvedAt: null },
        orderBy: NEWEST_FIRST,
        take,
      });
      return rows.map(mapRow);
    },

    markResolved: async (input) => {
      // updateMany + re-read: the `resolvedAt: null` predicate is the CAS.
      // A replayed or later-arriving webhook finds count 0 and returns null
      // instead of overwriting the first resolution.
      const updated = await p.earlyFraudWarning.updateMany({
        where: { id: input.id, resolvedAt: null },
        data: { resolvedAt: input.resolvedAt, resolution: input.resolution },
      });
      if (updated.count === 0) return null;
      const row = await p.earlyFraudWarning.findUnique({
        where: { id: input.id },
      });
      return row ? mapRow(row) : null;
    },

    findActiveForOrder: async (orderId) => {
      const row = await p.earlyFraudWarning.findFirst({
        where: { orderId, resolvedAt: null },
        orderBy: NEWEST_FIRST,
      });
      return row ? mapRow(row) : null;
    },

    findLatestForOrder: async (orderId) => {
      const row = await p.earlyFraudWarning.findFirst({
        where: { orderId },
        orderBy: NEWEST_FIRST,
      });
      return row ? mapRow(row) : null;
    },

    findActiveByStripeChargeId: async (stripeChargeId) => {
      const row = await p.earlyFraudWarning.findFirst({
        where: { stripeChargeId, resolvedAt: null },
        orderBy: NEWEST_FIRST,
      });
      return row ? mapRow(row) : null;
    },
  };
}
