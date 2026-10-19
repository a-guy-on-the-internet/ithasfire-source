import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { UserCreditRecord } from "@th/types";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { fail } from "@th/errors";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";

export const grantCreditInputSchema = z
  .object({
    /** Platform staff member performing the grant. */
    actorHumanId: z.uuid(),
    /** Recipient of the credit. */
    humanId: z.uuid(),
    amountCents: z.number().int().positive(),
    /** ISO 4217 currency code (lowercase). Defaults to USD. */
    currency: z
      .string()
      .trim()
      .toLowerCase()
      .length(3)
      .default("usd"),
    reason: plainTextMultilineRequired(280),
    sourceType: z.enum([
      "SIGNUP_BONUS",
      "REFERRAL",
      "REFUND_GOODWILL",
      "PLATFORM_CAMPAIGN",
      "PARTNER_SPIFF",
      "MANUAL_STAFF_GRANT",
    ]),
    /** Optional grouping / idempotency key (campaign id, referral pair, etc.). */
    sourceRef: z.string().trim().min(1).max(200).optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .strict();

export type GrantCreditInput = z.infer<typeof grantCreditInputSchema>;
export type GrantCreditOutput = { credit: UserCreditRecord };

export type GrantCreditDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Issue a platform-funded account credit to a human. Credits come out of
 * platform margin — they reduce the buyer's charge at checkout but never the
 * organiser's settlement.
 *
 * Idempotency: when `sourceRef` is supplied, a prior grant with the same
 * (humanId, sourceType, sourceRef) is returned unchanged instead of issuing a
 * duplicate. This makes referral / campaign grants safe to retry.
 */
export async function grantCredit(
  deps: GrantCreditDeps,
  rawInput: unknown,
): Promise<GrantCreditOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "grantCredit" });

  const execute = async (): Promise<GrantCreditOutput> => {
    const input = parseInput(grantCreditInputSchema, rawInput);

    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: ["ADMIN", "SUPPORT", "DEVELOPER"],
    });

    const now = deps.clock.now();

    if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
      throw fail("EXPIRES_AT_IN_PAST");
    }

    const grantOnce = async (): Promise<UserCreditRecord> =>
      deps.repos.tx(async (tx) => {
        // Velocity / idempotency guard — a sourceRef may only grant a given
        // human once for a given sourceType. The pre-read handles the common
        // case; the partial unique index (raw SQL in the user_credit
        // migration) is the race-safe backstop, caught below.
        if (input.sourceRef) {
          const existing = await tx.credits.findBySource({
            humanId: input.humanId,
            sourceType: input.sourceType,
            sourceRef: input.sourceRef,
          });
          if (existing) {
            return existing;
          }
        }

        const created = await tx.credits.grant({
          humanId: input.humanId,
          amountCents: input.amountCents,
          currency: input.currency,
          reason: input.reason,
          sourceType: input.sourceType,
          grantedByHumanId: input.actorHumanId,
          sourceRef: input.sourceRef ?? null,
          expiresAt: input.expiresAt ?? null,
        });

        await tx.audit.log({
          entity: "user_credit",
          entityId: created.id,
          action: "user_credit.granted",
          data: {
            actorHumanId: input.actorHumanId,
            humanId: input.humanId,
            amountCents: input.amountCents,
            currency: input.currency,
            sourceType: input.sourceType,
            sourceRef: input.sourceRef ?? null,
            reason: input.reason,
            expiresAt: input.expiresAt?.toISOString() ?? null,
          },
          at: now,
        });

        return created;
      });

    let credit: UserCreditRecord;
    try {
      credit = await grantOnce();
    } catch (err: unknown) {
      // P2002 = the partial unique index rejected a concurrent duplicate grant.
      // The transaction has rolled back, so re-read in a fresh transaction and
      // return the credit the winning grant created — keeping the grant
      // idempotent under concurrency. We only treat this as idempotent when a
      // sourceRef was supplied (the only case the unique index covers).
      const isUniqueViolation =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "P2002";

      if (input.sourceRef && isUniqueViolation) {
        const existing = await deps.repos.tx((tx) =>
          tx.credits.findBySource({
            humanId: input.humanId,
            sourceType: input.sourceType,
            sourceRef: input.sourceRef as string,
          }),
        );
        if (existing) {
          scopedLogger?.info("grantCredit.idempotent_race_duplicate", {
            creditId: existing.id,
            humanId: existing.humanId,
            sourceType: input.sourceType,
          });
          return { credit: existing };
        }
      }
      throw err;
    }

    scopedLogger?.info("grantCredit.succeeded", {
      creditId: credit.id,
      humanId: credit.humanId,
      amountCents: credit.amountCents,
    });

    return { credit };
  };

  if (scopedLogger) {
    return scopedLogger.withTime("grantCredit", execute);
  }

  return execute();
}
