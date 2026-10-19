import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { HumanRecord } from "@th/ports/repos/humans";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import { parseInput } from "../../lib/io";
import { recordAcceptance } from "../../lib/legal/acceptance";
import {
  CURRENT_CHARGEBACK_TERMS_VERSION,
  getCurrentChargebackTermsSnapshot,
} from "../../lib/payments/chargeback-terms";
import { ORG_ADMIN_ROLES, requireOrgMembership } from "../../lib/rbac";
import { fail } from "@th/errors";

export const acceptChargebackTermsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    target: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("ORGANIZATION"),
        orgId: z.uuid(),
      }),
      z.object({
        type: z.literal("HUMAN"),
        humanId: z.uuid(),
      }),
    ]),
  })
  .strict();

export const chargebackTermsSnapshotOutputSchema = z
  .object({
    version: z.literal(CURRENT_CHARGEBACK_TERMS_VERSION),
    text: z.string().min(1),
  })
  .strict();

export const acceptChargebackTermsOutputSchema = z
  .object({
    ok: z.literal(true),
    targetType: z.enum(["ORGANIZATION", "HUMAN"]),
    targetId: z.uuid(),
    acceptedAt: z.date(),
    terms: chargebackTermsSnapshotOutputSchema,
    /**
     * `true` when the owner already held an acceptance of the CURRENT version
     * and nothing was written — `acceptedAt` is then the ORIGINAL timestamp,
     * not the clock. A stale-version acceptance is re-accepted (`false`) and
     * overwritten: that is the re-bind path.
     */
    alreadyAccepted: z.boolean(),
  })
  .strict();

export type AcceptChargebackTermsInput = z.infer<
  typeof acceptChargebackTermsInputSchema
>;
export type AcceptChargebackTermsOutput = z.infer<
  typeof acceptChargebackTermsOutputSchema
>;

export type AcceptChargebackTermsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * An acceptance of the CURRENT version that is already on the row. Re-running
 * the mutation must NOT rewrite the columns (it would overwrite the legal
 * `acceptedAt`) nor add an audit row. Stale versions do not count — those
 * re-accept. Mirrors the strict predicate in lib/payments/chargeback-terms.
 */
function existingCurrentAcceptanceAt(
  record:
    | Pick<
        OrganizationRecord,
        | "chargebackTermsVersion"
        | "chargebackTermsAcceptedAt"
        | "chargebackTermsAcceptedByHumanId"
      >
    | Pick<HumanRecord, "chargebackTermsVersion" | "chargebackTermsAcceptedAt">,
  currentVersion: string,
): Date | null {
  if (record.chargebackTermsVersion !== currentVersion) return null;
  if (!(record.chargebackTermsAcceptedAt instanceof Date)) return null;
  if (
    "chargebackTermsAcceptedByHumanId" in record &&
    !record.chargebackTermsAcceptedByHumanId
  ) {
    return null;
  }
  return record.chargebackTermsAcceptedAt;
}

export async function acceptChargebackTerms(
  deps: AcceptChargebackTermsDeps,
  rawInput: unknown,
): Promise<AcceptChargebackTermsOutput> {
  const logger = deps.logger?.child({ useCase: "acceptChargebackTerms" });

  const execute = async (): Promise<AcceptChargebackTermsOutput> => {
    const input = parseInput(acceptChargebackTermsInputSchema, rawInput);
    const acceptedAt = deps.clock.now();
    const terms = getCurrentChargebackTermsSnapshot();

    const result = await deps.repos.tx(async (tx) => {
      if (input.target.type === "ORGANIZATION") {
        const organization = await tx.organizations.getById(input.target.orgId);
        if (!organization) {
          throw fail("ORG_NOT_FOUND");
        }

        await requireOrgMembership({
          repos: tx,
          orgId: input.target.orgId,
          actorHumanId: input.actorHumanId,
          roles: ORG_ADMIN_ROLES,
          errorCode: "INSUFFICIENT_ROLE",
        });

        const existingOrgAcceptedAt = existingCurrentAcceptanceAt(
          organization,
          terms.version,
        );
        if (existingOrgAcceptedAt) {
          return acceptChargebackTermsOutputSchema.parse({
            ok: true,
            targetType: "ORGANIZATION",
            targetId: input.target.orgId,
            acceptedAt: existingOrgAcceptedAt,
            terms,
            alreadyAccepted: true,
          });
        }

        await tx.organizations.acceptChargebackTerms({
          orgId: input.target.orgId,
          version: terms.version,
          acceptedAt,
          acceptedByHumanId: input.actorHumanId,
        });

        await tx.audit.log({
          entity: "organization",
          entityId: input.target.orgId,
          action: "organization.chargeback_terms_accepted",
          data: {
            actorHumanId: input.actorHumanId,
            terms,
          },
          at: acceptedAt,
        });

        // Dual-write to the canonical AcceptanceRecord ledger. Reads still use
        // the legacy Organization columns; this keeps the new ledger populated
        // so Phase 2 can flip reads over after a backfill.
        await recordAcceptance({
          repos: tx,
          humanId: input.actorHumanId,
          documentType: "CHARGEBACK_TERMS_ORGANIZER",
          scopeType: "ORGANIZATION",
          scopeId: input.target.orgId,
          acceptedAt,
        });

        return acceptChargebackTermsOutputSchema.parse({
          ok: true,
          targetType: "ORGANIZATION",
          targetId: input.target.orgId,
          acceptedAt,
          terms,
          alreadyAccepted: false,
        });
      }

      if (input.target.humanId !== input.actorHumanId) {
        throw fail("NOT_RESOURCE_OWNER");
      }

      const human = await tx.humans.getById(input.target.humanId);
      if (!human) {
        throw fail("HUMAN_NOT_FOUND");
      }

      const existingHumanAcceptedAt = existingCurrentAcceptanceAt(
        human,
        terms.version,
      );
      if (existingHumanAcceptedAt) {
        return acceptChargebackTermsOutputSchema.parse({
          ok: true,
          targetType: "HUMAN",
          targetId: input.target.humanId,
          acceptedAt: existingHumanAcceptedAt,
          terms,
          alreadyAccepted: true,
        });
      }

      await tx.humans.acceptChargebackTerms({
        humanId: input.target.humanId,
        version: terms.version,
        acceptedAt,
      });

      await tx.audit.log({
        entity: "human",
        entityId: input.target.humanId,
        action: "human.chargeback_terms_accepted",
        data: {
          actorHumanId: input.actorHumanId,
          terms,
        },
        at: acceptedAt,
      });

      // Dual-write to the canonical AcceptanceRecord ledger. A solo human
      // organizer accepting for themselves is recorded at GLOBAL scope
      // (scopeId null); org acceptances carry scopeType ORGANIZATION above.
      await recordAcceptance({
        repos: tx,
        humanId: input.target.humanId,
        documentType: "CHARGEBACK_TERMS_ORGANIZER",
        scopeType: "GLOBAL",
        scopeId: null,
        acceptedAt,
      });

      return acceptChargebackTermsOutputSchema.parse({
        ok: true,
        targetType: "HUMAN",
        targetId: input.target.humanId,
        acceptedAt,
        terms,
        alreadyAccepted: false,
      });
    });

    logger?.info("acceptChargebackTerms.completed", {
      targetType: result.targetType,
      targetId: result.targetId,
      version: result.terms.version,
      alreadyAccepted: result.alreadyAccepted,
    });

    return result;
  };

  if (logger) {
    return logger.withTime("acceptChargebackTerms", execute);
  }

  return execute();
}
