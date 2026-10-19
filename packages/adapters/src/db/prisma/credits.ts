import { Prisma } from "@prisma/client";
import type {
  CreditsRepo,
  GrantUserCreditInput,
  ListActiveCreditsInput,
  RecordCreditRedemptionInput,
  ReleaseCreditsForOrderOptions,
} from "@th/ports/repos/credits";
import type {
  UserCreditRecord,
  UserCreditRedemptionRecord,
  UserCreditSourceType,
} from "@th/types";

import type { PrismaClientOrTx } from "./types";

type PrismaUserCredit = {
  id: string;
  humanId: string;
  amountCents: number;
  currency: string;
  balanceCents: number;
  reason: string;
  sourceType: UserCreditSourceType;
  grantedByHumanId: string | null;
  sourceRef: string | null;
  status: "ACTIVE" | "REDEEMED" | "EXPIRED" | "REVOKED";
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type PrismaUserCreditRedemption = {
  id: string;
  creditId: string;
  orderId: string;
  amountCents: number;
  redeemedAt: Date;
  refundedAt: Date | null;
  releasedAt?: Date | null;
};

function mapCredit(row: PrismaUserCredit): UserCreditRecord {
  return {
    id: row.id,
    humanId: row.humanId,
    amountCents: row.amountCents,
    currency: row.currency,
    balanceCents: row.balanceCents,
    reason: row.reason,
    sourceType: row.sourceType,
    grantedByHumanId: row.grantedByHumanId,
    sourceRef: row.sourceRef,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRedemption(
  row: PrismaUserCreditRedemption,
): UserCreditRedemptionRecord {
  return {
    id: row.id,
    creditId: row.creditId,
    orderId: row.orderId,
    amountCents: row.amountCents,
    redeemedAt: row.redeemedAt,
    refundedAt: row.refundedAt,
    releasedAt: row.releasedAt ?? null,
  };
}

export function makeCreditsRepo(p: PrismaClientOrTx): CreditsRepo {
  return {
    grant: async (input: GrantUserCreditInput) => {
      const created = await p.userCredit.create({
        data: {
          humanId: input.humanId,
          amountCents: input.amountCents,
          currency: input.currency,
          balanceCents: input.amountCents,
          reason: input.reason,
          sourceType: input.sourceType,
          grantedByHumanId: input.grantedByHumanId ?? null,
          sourceRef: input.sourceRef ?? null,
          expiresAt: input.expiresAt ?? null,
        },
      });
      return mapCredit(created as PrismaUserCredit);
    },

    listActiveForHuman: async ({ humanId, currency }: ListActiveCreditsInput) => {
      const now = new Date();
      const rows = await p.userCredit.findMany({
        where: {
          humanId,
          currency,
          status: "ACTIVE",
          balanceCents: { gt: 0 },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [
          { expiresAt: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
        ],
      });
      return rows.map((r) => mapCredit(r as PrismaUserCredit));
    },

    listAllForHuman: async (humanId: string) => {
      const rows = await p.userCredit.findMany({
        where: { humanId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map((r) => mapCredit(r as PrismaUserCredit));
    },

    listRedemptionsForHuman: async (humanId: string) => {
      const rows = await p.userCreditRedemption.findMany({
        where: { credit: { humanId } },
        orderBy: { redeemedAt: "desc" },
      });
      return rows.map((r) => mapRedemption(r as PrismaUserCreditRedemption));
    },

    findBySource: async ({ humanId, sourceType, sourceRef }) => {
      const row = await p.userCredit.findFirst({
        where: { humanId, sourceType, sourceRef },
      });
      return row ? mapCredit(row as PrismaUserCredit) : null;
    },

    redeemConditional: async ({ creditId, requestedCents }) => {
      if (requestedCents <= 0) {
        return { appliedCents: 0, balanceAfterCents: 0 };
      }

      // Conditional, atomic debit. The CTE locks the row (FOR UPDATE) so a
      // concurrent checkout racing on the same credit serialises here and
      // re-reads the post-debit balance instead of overwriting it. We debit
      // LEAST(balance, requested) and re-derive the applied amount from the
      // row the UPDATE actually touched — never from a pre-read snapshot.
      const rows = await p.$queryRaw<
        Array<{ appliedCents: number; balanceAfter: number }>
      >(Prisma.sql`
        WITH cur AS (
          SELECT "id", "balanceCents" AS "oldBalance"
          FROM public."UserCredit"
          WHERE "id" = ${creditId}
            AND "status" = 'ACTIVE'
            AND "balanceCents" > 0
          FOR UPDATE
        )
        UPDATE public."UserCredit" u
        SET "balanceCents" = cur."oldBalance" - LEAST(cur."oldBalance", ${requestedCents}),
            "status" = CASE
              WHEN cur."oldBalance" - LEAST(cur."oldBalance", ${requestedCents}) <= 0
                THEN 'REDEEMED'::"UserCreditStatus"
              ELSE u."status"
            END,
            "updatedAt" = NOW()
        FROM cur
        WHERE u."id" = cur."id"
        RETURNING
          LEAST(cur."oldBalance", ${requestedCents})::int AS "appliedCents",
          u."balanceCents"::int AS "balanceAfter"
      `);

      const row = rows[0];
      if (!row) {
        // No ACTIVE row with a positive balance — drained, expired, or already
        // redeemed. Nothing applied.
        return { appliedCents: 0, balanceAfterCents: 0 };
      }
      return {
        appliedCents: Number(row.appliedCents),
        balanceAfterCents: Number(row.balanceAfter),
      };
    },

    recordRedemption: async (input: RecordCreditRedemptionInput) => {
      // Idempotent on (creditId, orderId): if a redemption already exists,
      // return it unchanged. The balance debit is handled separately by
      // redeemConditional within the same transaction.
      const existing = await p.userCreditRedemption.findUnique({
        where: {
          creditId_orderId: {
            creditId: input.creditId,
            orderId: input.orderId,
          },
        },
      });
      if (existing) {
        return mapRedemption(existing as PrismaUserCreditRedemption);
      }

      try {
        const redemption = (await p.userCreditRedemption.create({
          data: {
            creditId: input.creditId,
            orderId: input.orderId,
            amountCents: input.amountCents,
          },
        })) as PrismaUserCreditRedemption;
        return mapRedemption(redemption);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const raced = await p.userCreditRedemption.findUnique({
            where: {
              creditId_orderId: {
                creditId: input.creditId,
                orderId: input.orderId,
              },
            },
          });
          if (raced) {
            return mapRedemption(raced as PrismaUserCreditRedemption);
          }
        }
        throw error;
      }
    },

    releaseForOrder: async (
      orderId: string,
      opts?: ReleaseCreditsForOrderOptions,
    ) => {
      // Bound instant for the expiry CASE (see the port). Wall clock only when
      // the caller has no ClockPort — the retire helper runs inside another
      // use case's transaction and carries none.
      const now = opts?.now ?? new Date();

      // The mirror image of redeemConditional, for a PENDING order that died
      // unpaid. One statement so the redemption stamp and the balance restore
      // cannot come apart:
      //
      //   pending  — the still-applied redemptions on this order, with their
      //              credit rows locked FOR UPDATE. The `releasedAt IS NULL`
      //              guard is re-evaluated after the lock is acquired, so a
      //              concurrent release of the same order (reaper vs buyer)
      //              sees the winner's stamp and finds nothing to do.
      //              `refundedAt IS NULL` keeps a refund-reversed redemption
      //              from being restored a second time.
      //              LOCK ORDER: the ORDER BY is the one `listActiveForHuman`
      //              returns credits in, and Postgres sorts BEFORE it locks,
      //              so this statement takes a buyer's credits in the same
      //              sequence `applyAvailableCredits` → `redeemConditional`
      //              takes them one by one. A plain checkout on another
      //              device racing this release over two credits therefore
      //              queues behind it rather than deadlocking (40P01).
      //   released — stamps those redemptions.
      //   restored — adds the cents back to each credit. Status only moves
      //              off REDEEMED, and where it lands follows the predicate
      //              listActiveForHuman spends by: ACTIVE if unexpired,
      //              EXPIRED if the window closed while the cents were out.
      //              REVOKED / EXPIRED credits get their ledger corrected but
      //              are never resurrected.
      //
      // (creditId, orderId) is unique, so the per-credit SUM is a single row;
      // the GROUP BY is belt-and-braces against ever feeding an UPDATE ...
      // FROM two rows for one target.
      const rows = await p.$queryRaw<
        Array<{ creditId: string; restoredCents: number | bigint }>
      >(Prisma.sql`
        WITH pending AS (
          SELECT r."id" AS "redemptionId", r."creditId", r."amountCents"
          FROM public."UserCreditRedemption" r
          JOIN public."UserCredit" c ON c."id" = r."creditId"
          WHERE r."orderId" = ${orderId}
            AND r."releasedAt" IS NULL
            AND r."refundedAt" IS NULL
          ORDER BY c."expiresAt" ASC NULLS LAST, c."createdAt" ASC, c."id" ASC
          FOR UPDATE OF r, c
        ),
        released AS (
          UPDATE public."UserCreditRedemption" r
          SET "releasedAt" = ${now}
          FROM pending
          WHERE r."id" = pending."redemptionId"
          RETURNING pending."creditId", pending."amountCents"
        ),
        per_credit AS (
          SELECT "creditId", SUM("amountCents")::int AS "restoreCents"
          FROM released
          GROUP BY "creditId"
        ),
        restored AS (
          UPDATE public."UserCredit" u
          SET "balanceCents" = u."balanceCents" + per_credit."restoreCents",
              "status" = CASE
                WHEN u."status" <> 'REDEEMED'::"UserCreditStatus"
                  THEN u."status"
                WHEN u."expiresAt" IS NOT NULL AND u."expiresAt" <= ${now}
                  THEN 'EXPIRED'::"UserCreditStatus"
                WHEN u."balanceCents" + per_credit."restoreCents" > 0
                  THEN 'ACTIVE'::"UserCreditStatus"
                ELSE u."status"
              END,
              "updatedAt" = ${now}
          FROM per_credit
          WHERE u."id" = per_credit."creditId"
          RETURNING u."id" AS "creditId", per_credit."restoreCents"::int AS "restoredCents"
        )
        SELECT "creditId", "restoredCents" FROM restored
      `);

      let releasedCents = 0;
      const creditIds: string[] = [];
      for (const row of rows) {
        releasedCents += Number(row.restoredCents);
        creditIds.push(row.creditId);
      }
      return { releasedCents, creditIds };
    },
  };
}
