import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

export const getPayoutLineForAckInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    payoutTermsLineId: z.string().uuid(),
  })
  .strict();

export const getPayoutLineForAckOutputSchema = z
  .object({
    lineId: z.string().uuid(),
    payoutTermsId: z.string().uuid(),
    kind: z.enum(["PRIMARY", "RESALE", "MERCH"]),
    percentBps: z.number().int(),
    floorCents: z.number().int(),
    capPercent: z.number().int().nullable(),
    requiresConfirmation: z.boolean(),
    confirmationStatus: z
      .enum(["PENDING", "CONFIRMED", "COUNTERED", "DECLINED"])
      .nullable(),
    confirmedAt: z.date().nullable(),
    /** True when the actor's Connect account can actually receive payouts. */
    payeeConnectActive: z.boolean(),
    event: z
      .object({
        id: z.string().uuid(),
        title: z.string().nullable(),
        startsAt: z.date().nullable(),
      })
      .strict(),
  })
  .strict();

export type GetPayoutLineForAckInput = z.infer<
  typeof getPayoutLineForAckInputSchema
>;
export type GetPayoutLineForAckOutput = z.infer<
  typeof getPayoutLineForAckOutputSchema
>;

export type GetPayoutLineForAckDeps = {
  repos: Pick<Repos, "payoutTerms" | "payees" | "events" | "authz">;
  logger?: LoggerPort;
};

/**
 * Read view used by the payee acknowledgement page. Returns just enough
 * context (event title + dates + line terms + Connect status) for the
 * payee to confirm. Auth: actor must own the line's Payee.
 */
export async function getPayoutLineForAck(
  deps: GetPayoutLineForAckDeps,
  rawInput: unknown,
): Promise<GetPayoutLineForAckOutput> {
  const input = parseInput(getPayoutLineForAckInputSchema, rawInput);

  const line = await deps.repos.payoutTerms.getLineById(
    input.payoutTermsLineId,
  );
  if (!line) {
    throw fail("PAYOUT_LINE_NOT_FOUND");
  }

  const payee = await deps.repos.payees.getById(line.payeeId);
  if (!payee) {
    throw fail("PAYEE_NOT_FOUND");
  }

  // Auth: only the payee's owner may view (humans for HUMAN-subject;
  // org admin for ORGANIZATION-subject).
  if (payee.subjectType === "HUMAN") {
    if (payee.subjectId !== input.actorHumanId) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "payee" } });
    }
  } else {
    const memberships = await deps.repos.authz.getOrgMemberships({
      orgIds: [payee.subjectId],
      humanId: input.actorHumanId,
    });
    const isAdmin = memberships.some(
      (m) => m.role === "OWNER" || m.role === "ADMIN",
    );
    if (!isAdmin) {
      throw fail("INSUFFICIENT_ROLE");
    }
  }

  // Resolve the parent terms + the event that points at it. PayoutTerms
  // doesn't carry an eventId itself; we look it up via the events repo's
  // back-reference helper.
  const terms = await deps.repos.payoutTerms.getById(line.payoutTermsId);
  if (!terms) {
    throw fail("PAYOUT_TERMS_NOT_FOUND");
  }
  const event = await deps.repos.events.findByPayoutTermsId(line.payoutTermsId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND", { meta: { via: "terms" } });
  }

  deps.logger?.info("payout_terms.get_line_for_ack", {
    lineId: input.payoutTermsLineId,
    actorHumanId: input.actorHumanId,
    eventId: event.id,
  });

  return getPayoutLineForAckOutputSchema.parse({
    lineId: line.id,
    payoutTermsId: line.payoutTermsId,
    kind: terms.kind,
    // Storage is whole percent; surface bps for UI consistency with
    // get-event-splits.
    percentBps: line.percent * 100,
    floorCents: line.floorCents,
    capPercent: line.capPercent,
    requiresConfirmation: line.requiresConfirmation,
    confirmationStatus: line.confirmationStatus,
    confirmedAt: line.confirmedAt,
    payeeConnectActive: payee.payoutsEnabled,
    event: {
      id: event.id,
      title: event.title,
      startsAt: event.startsAt,
    },
  });
}
