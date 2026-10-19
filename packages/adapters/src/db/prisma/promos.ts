import { Prisma } from "@prisma/client";
import type {
  PromoHoldRecord,
  PromoRecord,
  PromoRedemptionRecord,
  PromoRedemptionStats,
  PromosRepo,
  PromoWithStats,
  CreatePromoHoldInput,
  CreatePromoInput,
  ListPromosByScopeInput,
  UpdatePromoInput,
} from "@th/ports/repos/promos";

import type { PrismaClientOrTx } from "./types";

export function makePromosRepo(p: PrismaClientOrTx): PromosRepo {
  return {
    findActiveByCodes: async ({ codes, now, publicOnly }) => {
      const normalizedCodes = normalizePromoCodes(codes);
      if (normalizedCodes.length === 0) {
        return [];
      }

      const promos = await p.promo.findMany({
        where: {
          codeNormalized: { in: normalizedCodes },
          status: "ACTIVE",
          ...(publicOnly ? { isPublic: true } : {}),
          AND: [
            {
              OR: [{ startsAt: null }, { startsAt: { lte: now } }],
            },
            {
              OR: [{ endsAt: null }, { endsAt: { gte: now } }],
            },
          ],
        },
      });

      return promos.map(mapPromoRecord);
    },

    getRedemptionStats: async ({ promoId, humanId, now, excludeOrderId }) =>
      countPromoClaims(p, { promoId, humanId, now, excludeOrderId }),

    createHolds: async (inputs, { now }) => {
      if (inputs.length === 0) {
        return [];
      }

      // ── Serialise check-then-hold per promo ──────────────────────────────
      // A TRANSACTION-SCOPED ADVISORY lock, not `SELECT ... FOR UPDATE` on
      // the Promo row, for the same reason `lockAndCountCapacityForTicketType`
      // avoids the TicketType row lock: inserting a CouponHold takes an
      // implicit `FOR KEY SHARE` on its parent Coupon, and a row `FOR UPDATE`
      // conflicts with that — a cycle waiting to happen with any other path
      // that inserts holds in a different order. The advisory lock sits in
      // its own lock space, releases on commit, and namespaced so it cannot
      // collide with another feature hashing the same uuid.
      //
      // SORTED so two checkouts carrying the same pair of stackable codes
      // take them in the same order. Deduped so one call never re-locks.
      //
      // `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns
      // `void`, which the driver-adapter decoder cannot deserialize (see
      // fee-policies.ts / authz.ts).
      const promoIds = [
        ...new Set(
          inputs.flatMap((input) => (input.promoId ? [input.promoId] : [])),
        ),
      ].sort();
      for (const promoId of promoIds) {
        await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`promo_hold:${promoId}`}))`;
      }

      const holds: PromoHoldRecord[] = [];

      for (const input of inputs) {
        // Idempotent re-entry, read BEFORE insert and UNDER the lock. The old
        // shape — insert, catch P2002, read back — never worked inside
        // `repos.tx`: the failed INSERT aborts the Postgres transaction and
        // the read-back raises 25P02 (docs/engineering-standards.md,
        // "Swallowing an error inside a transaction"). With the lock held, a
        // miss here means no concurrent writer can beat the insert below, so
        // a P2002 now is a genuine bug and propagates un-swallowed.
        const existing = input.promoId
          ? await p.promoHold.findUnique({
              where: {
                promoId_idempotencyKey: {
                  promoId: input.promoId,
                  idempotencyKey: input.idempotencyKey,
                },
              },
            })
          : await p.promoHold.findUnique({
              where: {
                membershipBenefitId_idempotencyKey: {
                  membershipBenefitId: input.membershipBenefitId as string,
                  idempotencyKey: input.idempotencyKey,
                },
              },
            });

        if (existing) {
          // The retry's own hold is already in the count. Re-checking would
          // refuse the buyer the slot they hold.
          holds.push(mapPromoHoldRecord(existing));
          continue;
        }

        // ── Cap re-check, the authority ─────────────────────────────────
        // The use case pre-checked against the same stats before quoting a
        // price, but that read ran before this lock. Anything admitted
        // between the two — another checkout's hold, a confirm — is visible
        // now. REJECT rather than silently drop the discount: the buyer was
        // quoted a number, and a quiet full-price charge is the worse
        // outcome. Same error shapes as `evaluatePromoApplications`.
        //
        // Membership-benefit holds carry no caps (a benefit is valid exactly
        // as long as the membership is), so they skip straight to the insert.
        if (input.promoId) {
          const promo = await p.promo.findUnique({
            where: { id: input.promoId },
            select: {
              code: true,
              maxRedemptions: true,
              maxRedemptionsPerHuman: true,
            },
          });
          if (!promo) {
            throw {
              code: "invalid_input",
              message: "promo_not_found",
              promoCode: input.code,
            } as const;
          }

          if (
            promo.maxRedemptions != null ||
            promo.maxRedemptionsPerHuman != null
          ) {
            const stats = await countPromoClaims(p, {
              promoId: input.promoId,
              humanId: input.humanId,
              now,
            });

            if (
              promo.maxRedemptions != null &&
              stats.totalRedemptions >= promo.maxRedemptions
            ) {
              throw {
                code: "conflict",
                message: "promo_max_redeemed",
                promoCode: input.code,
              } as const;
            }

            if (
              promo.maxRedemptionsPerHuman != null &&
              stats.redemptionsForHuman >= promo.maxRedemptionsPerHuman
            ) {
              throw {
                code: "conflict",
                message: "promo_redeemed_by_human",
                promoCode: input.code,
              } as const;
            }
          }
        }

        const created = await p.promoHold.create({
          data: {
            // Exactly one source, guaranteed by CreatePromoHoldInput's union
            // and by the CouponHold_source_xor CHECK in Postgres.
            promoId: input.promoId ?? null,
            membershipBenefitId: input.membershipBenefitId ?? null,
            orderId: input.orderId,
            humanId: input.humanId,
            idempotencyKey: input.idempotencyKey,
            // Normalization exists to make a TYPED code match
            // `Promo.codeNormalized`. A membership grant's marker
            // (`benefit:{uuid}`) is not a code and matches nothing, so
            // uppercasing it would only make the ledger disagree with the
            // identical string in the PaymentIntent metadata.
            code: input.promoId ? normalizePromoCode(input.code) : input.code,
            amountDiscountCents: input.amountDiscountCents,
            expiresAt: input.expiresAt,
          },
        });

        holds.push(mapPromoHoldRecord(created));
      }

      return holds;
    },

    releaseHoldsForOrder: async (orderId) => {
      await p.promoHold.updateMany({
        where: { orderId, status: "PENDING" },
        data: { status: "RELEASED" },
      });
    },

    listHoldsForOrder: async (orderId) => {
      const holds = await p.promoHold.findMany({ where: { orderId } });
      return holds.map(mapPromoHoldRecord);
    },

    confirmHoldsForOrder: async ({ orderId, confirmedAt }) => {
      const holds = await p.promoHold.findMany({ where: { orderId } });
      if (holds.length === 0) {
        return [];
      }

      const redemptions: PromoRedemptionRecord[] = [];

      for (const hold of holds) {
        if (hold.status === "RELEASED") {
          continue;
        }

        if (hold.status !== "CONFIRMED") {
          await p.promoHold.update({
            where: { id: hold.id },
            data: { status: "CONFIRMED" },
          });
        }

        // Source-agnostic confirm: the hold already knows which source it came
        // from, so the redemption upsert simply follows it. One ledger, one
        // lifecycle — the only thing that branches is which unique it keys on.
        const redemptionWhere = hold.promoId
          ? { promoId_orderId: { promoId: hold.promoId, orderId: hold.orderId } }
          : {
              membershipBenefitId_orderId: {
                membershipBenefitId: hold.membershipBenefitId as string,
                orderId: hold.orderId,
              },
            };

        const redemption = await p.promoRedemption.upsert({
          where: redemptionWhere,
          create: {
            promoId: hold.promoId,
            membershipBenefitId: hold.membershipBenefitId,
            orderId: hold.orderId,
            humanId: hold.humanId,
            code: hold.code,
            amountDiscountCents: hold.amountDiscountCents,
            redeemedAt: confirmedAt,
          },
          update: {
            humanId: hold.humanId,
            code: hold.code,
            amountDiscountCents: hold.amountDiscountCents,
            redeemedAt: confirmedAt,
          },
        });

        redemptions.push(mapPromoRedemptionRecord(redemption));
      }

      return redemptions;
    },

    listRedemptionsByOrderId: async (orderId) => {
      // Stable order: an order can carry more than one redemption (a typed
      // code AND a membership benefit, or two stackable codes), and callers
      // that summarise "the" discount must not see it flip between reads.
      const rows = await p.promoRedemption.findMany({
        where: { orderId },
        orderBy: [{ redeemedAt: "asc" }, { id: "asc" }],
      });
      return rows.map(mapPromoRedemptionRecord);
    },

    // ── CRUD ─────────────────────────────────────────────────────────────────

    create: async (input: CreatePromoInput) => {
      const codeNormalized = normalizePromoCode(input.code);
      const promo = await p.promo.create({
        data: {
          code: input.code.trim(),
          codeNormalized,
          kind: input.kind,
          value: input.value,
          currency: input.currency ?? "usd",
          scope: input.scope,
          scopeId: input.scopeId ?? null,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
          maxRedemptions: input.maxRedemptions ?? null,
          maxRedemptionsPerHuman: input.maxRedemptionsPerHuman ?? null,
          minOrderCents: input.minOrderCents ?? 0,
          maxDiscountCents: input.maxDiscountCents ?? null,
          stackable: input.stackable ?? false,
          isPublic: input.isPublic ?? false,
          status: "ACTIVE",
        },
      });
      return mapPromoRecord(promo);
    },

    update: async (input: UpdatePromoInput) => {
      const data: Prisma.PromoUpdateInput = {};
      if (input.code !== undefined) {
        data.code = input.code.trim();
        data.codeNormalized = normalizePromoCode(input.code);
      }
      if (input.kind !== undefined) data.kind = input.kind;
      if (input.value !== undefined) data.value = input.value;
      if (input.currency !== undefined) data.currency = input.currency;
      if (input.startsAt !== undefined) data.startsAt = input.startsAt;
      if (input.endsAt !== undefined) data.endsAt = input.endsAt;
      if (input.maxRedemptions !== undefined)
        data.maxRedemptions = input.maxRedemptions;
      if (input.maxRedemptionsPerHuman !== undefined)
        data.maxRedemptionsPerHuman = input.maxRedemptionsPerHuman;
      if (input.minOrderCents !== undefined)
        data.minOrderCents = input.minOrderCents;
      if (input.maxDiscountCents !== undefined)
        data.maxDiscountCents = input.maxDiscountCents;
      if (input.stackable !== undefined) data.stackable = input.stackable;
      if (input.isPublic !== undefined) data.isPublic = input.isPublic;
      if (input.status !== undefined) data.status = input.status;

      const promo = await p.promo.update({
        where: { id: input.id },
        data,
      });
      return mapPromoRecord(promo);
    },

    getById: async (id: string) => {
      const promo = await p.promo.findUnique({ where: { id } });
      return promo ? mapPromoRecord(promo) : null;
    },

    getByIdWithStats: async (id: string) => {
      const promo = await p.promo.findUnique({
        where: { id },
        include: { _count: { select: { redemptions: true } } },
      });
      if (!promo) return null;
      return {
        ...mapPromoRecord(promo),
        totalRedemptions: promo._count.redemptions,
      } satisfies PromoWithStats;
    },

    listByScope: async (input: ListPromosByScopeInput) => {
      const where: Prisma.PromoWhereInput = {
        ...(input.scope ? { scope: input.scope } : {}),
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
        ...(input.status ? { status: input.status } : {}),
      };

      const [items, total] = await Promise.all([
        p.promo.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: input.offset,
          take: input.limit,
          include: { _count: { select: { redemptions: true } } },
        }),
        p.promo.count({ where }),
      ]);

      return {
        items: items.map((c) => ({
          ...mapPromoRecord(c),
          totalRedemptions: c._count.redemptions,
        })),
        total,
      };
    },
  } satisfies PromosRepo;
}

const normalizePromoCode = (code: string) => code.trim().toUpperCase();

const normalizePromoCodes = (codes: string[]) => {
  const normalized = new Set<string>();
  for (const code of codes) {
    const trimmed = code.trim();
    if (!trimmed) continue;
    normalized.add(normalizePromoCode(trimmed));
  }
  return Array.from(normalized);
};

/**
 * The one count both the pre-check and the locked re-check use, so they can
 * never disagree about what "redeemed" means.
 *
 * A claim on the cap is EITHER a confirmed redemption OR a live hold: PENDING,
 * still in force, and on an order that has not already confirmed (that
 * order's claim is its redemption row — the anti-join keeps a hold left
 * PENDING by an interrupted confirm from counting twice).
 *
 * "Still in force" is `expiresAt > now` OR its order is still open (`Order`
 * PENDING or PROCESSING). THE CART'S LIFETIME IS THE HOLD'S AUTHORITY, not
 * the hold's own TTL: the hold expires at 15 min, the cart reaper runs at
 * 20 min and only cancels on its next pass, and `confirmHoldsForOrder`
 * confirms whatever is not RELEASED when the payment lands — by design, a
 * paid cart is never refused its discount. Counting only the TTL let a
 * second checkout take the last slot in that gap and the first cart's
 * `payment_intent.succeeded` confirm anyway: two redemptions on a cap of
 * one. A hold stops counting when its cart is retired (the reaper and
 * `releaseCartHold` flip it to RELEASED, or the order leaves PENDING /
 * PROCESSING) or, with no open order behind it, when its TTL runs out.
 * PROCESSING is the delayed-notification (ACH) state whose tickets and
 * holds confirm days later. Two deliberate consequences: no reaper sweeps a
 * PROCESSING order, so a lost `payment_failed` webhook (DLQ replay is the
 * only unwind) keeps that slot consumed; and a PENDING cart the cart reaper
 * quarantines (paid but finalize DLQ'd, or no processor configured) keeps
 * its slot on purpose — it may still confirm.
 *
 * One round trip: UNION ALL the two ledgers on `humanId`, count the lot, and
 * count the caller's human with a FILTER. A NULL human (anonymous preview)
 * makes the FILTER predicate NULL for every row, so that leg is 0 — the
 * semantics the use case relies on — without a second query shape.
 *
 * `excludeOrderId` drops ONE order's live holds from the hold leg only
 * (`IS DISTINCT FROM` so a NULL exclusion keeps every hold, without a second
 * query shape). Redemptions are never excluded. The locked re-check in
 * `createHolds` never passes it; the callers that do (the buyer-facing
 * preview, `createCheckout`'s routing probe, `claimFreeTickets`) have first
 * checked the order is the buyer's own PENDING cart on the same event.
 *
 * `status` is a Postgres enum, hence `::text`. Table names are
 * schema-qualified (`public.`), the pooled-Neon hazard this repo guards
 * against elsewhere. Every value is a bound parameter.
 *
 * Index use: `CouponRedemption(couponId, humanId)`, the
 * `CouponHold(couponId, idempotencyKey)` unique as a `couponId` prefix, the
 * `CouponRedemption(couponId, orderId)` unique for the anti-join, and the
 * `Order` primary key for the open-cart EXISTS (`CouponHold.orderId` and
 * `Order.id` are both TEXT — no cast on either side).
 */
async function countPromoClaims(
  p: PrismaClientOrTx,
  params: {
    promoId: string;
    humanId?: string;
    now: Date;
    excludeOrderId?: string;
  },
): Promise<PromoRedemptionStats> {
  const rows = await p.$queryRaw<{ total: number; forHuman: number }[]>`
    WITH claims AS (
      SELECT r."humanId"
      FROM public."CouponRedemption" r
      WHERE r."couponId" = ${params.promoId}
      UNION ALL
      SELECT h."humanId"
      FROM public."CouponHold" h
      WHERE h."couponId" = ${params.promoId}
        AND h.status::text = 'PENDING'
        AND (
          h."expiresAt" > ${params.now}
          OR EXISTS (
            SELECT 1
            FROM public."Order" o
            WHERE o.id = h."orderId"
              AND o.status::text IN ('PENDING', 'PROCESSING')
          )
        )
        AND h."orderId" IS DISTINCT FROM ${params.excludeOrderId ?? null}::text
        AND NOT EXISTS (
          SELECT 1
          FROM public."CouponRedemption" r
          WHERE r."couponId" = h."couponId"
            AND r."orderId" = h."orderId"
        )
    )
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE "humanId" = ${params.humanId ?? null}::text)::int AS "forHuman"
    FROM claims
  `;

  return {
    totalRedemptions: Number(rows[0]?.total ?? 0),
    redemptionsForHuman: Number(rows[0]?.forHuman ?? 0),
  } satisfies PromoRedemptionStats;
}

const mapPromoRecord = (promo: {
  id: string;
  code: string;
  codeNormalized: string;
  kind: string;
  value: number;
  currency: string;
  scope: string;
  scopeId: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
  maxRedemptionsPerHuman: number | null;
  minOrderCents: number;
  maxDiscountCents: number | null;
  stackable: boolean;
  isPublic: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): PromoRecord => ({
  id: promo.id,
  code: promo.code,
  codeNormalized: promo.codeNormalized,
  kind: promo.kind as PromoRecord["kind"],
  scope: promo.scope as PromoRecord["scope"],
  scopeId: promo.scopeId,
  value: promo.value,
  currency: promo.currency,
  minOrderCents: promo.minOrderCents,
  maxRedemptions: promo.maxRedemptions ?? undefined,
  maxRedemptionsPerHuman: promo.maxRedemptionsPerHuman ?? undefined,
  maxDiscountCents: promo.maxDiscountCents ?? undefined,
  stackable: promo.stackable,
  isPublic: promo.isPublic,
  status: promo.status as PromoRecord["status"],
  startsAt: promo.startsAt ?? undefined,
  endsAt: promo.endsAt ?? undefined,
  createdAt: promo.createdAt,
  updatedAt: promo.updatedAt,
});

const mapPromoHoldRecord = (hold: {
  id: string;
  promoId: string | null;
  membershipBenefitId: string | null;
  orderId: string;
  humanId: string;
  idempotencyKey: string;
  code: string;
  amountDiscountCents: number;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): PromoHoldRecord => ({
  id: hold.id,
  promoId: hold.promoId,
  membershipBenefitId: hold.membershipBenefitId,
  orderId: hold.orderId,
  humanId: hold.humanId,
  idempotencyKey: hold.idempotencyKey,
  code: hold.code,
  amountDiscountCents: hold.amountDiscountCents,
  status: hold.status as PromoHoldRecord["status"],
  expiresAt: hold.expiresAt,
  createdAt: hold.createdAt,
  updatedAt: hold.updatedAt,
});

const mapPromoRedemptionRecord = (redemption: {
  id: string;
  promoId: string | null;
  membershipBenefitId: string | null;
  orderId: string;
  humanId: string;
  code: string;
  amountDiscountCents: number;
  redeemedAt: Date;
}): PromoRedemptionRecord => ({
  id: redemption.id,
  promoId: redemption.promoId,
  membershipBenefitId: redemption.membershipBenefitId,
  orderId: redemption.orderId,
  humanId: redemption.humanId,
  code: redemption.code,
  amountDiscountCents: redemption.amountDiscountCents,
  redeemedAt: redemption.redeemedAt,
});
