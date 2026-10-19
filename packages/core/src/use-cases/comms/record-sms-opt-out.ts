import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { normalizePhoneE164 } from "../../lib/comms/phone";
import { fail } from "@th/errors";

export const recordSmsOptOutInputSchema = z
  .object({
    phoneNumber: z.string().min(1),
    /** Origin tag, e.g. "provider_reconciliation", "support_manual". */
    source: z.string().min(1),
    keyword: z.string().min(1).optional(),
    providerMessageId: z.string().min(1).optional(),
    actorHumanId: z.uuid().optional(),
    /**
     * When the person opted out: the provider's timestamp for an inbound
     * keyword. Omitted for app-side opt-outs (the clock's now).
     */
    occurredAt: z.date().optional(),
  })
  .strict();

export const recordSmsOptOutOutputSchema = z
  .object({
    /** The ledger state after the call. */
    status: z.enum(["OPTED_IN", "OPTED_OUT", "UNKNOWN"]),
    phoneE164: z.string(),
    affectedVolunteerSignupCount: z.number().int().min(0),
    /** False when a newer opt-in was already recorded. */
    applied: z.boolean(),
  })
  .strict();

export type RecordSmsOptOutInput = z.infer<typeof recordSmsOptOutInputSchema>;
export type RecordSmsOptOutOutput = z.infer<typeof recordSmsOptOutOutputSchema>;

export type RecordSmsOptOutDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Records a STOP-family SMS opt-out idempotently and disables every matching
 * volunteer signup `smsOptIn` whose `contactPhone` matches the number. Safe on
 * SNS retries: repeated calls converge on one OPTED_OUT ledger row and clear
 * zero additional signups once they are already off.
 *
 * Ordered by when the person decided (`occurredAt`, else now): an opt-out
 * older than the row's latest opt-in changes nothing and clears no signups.
 * A tie with the opt-in goes to the opt-out. A future `occurredAt` is
 * clamped to now.
 */
export async function recordSmsOptOut(
  deps: RecordSmsOptOutDeps,
  rawInput: unknown,
): Promise<RecordSmsOptOutOutput> {
  const logger = deps.logger?.child({ useCase: "recordSmsOptOut" });
  const input = parseInput(recordSmsOptOutInputSchema, rawInput);

  const phoneE164 = normalizePhoneE164(input.phoneNumber);
  if (!phoneE164) {
    throw fail("PHONE_FORMAT_INVALID");
  }

  const now = deps.clock.now();
  const eventAt =
    input.occurredAt && input.occurredAt.getTime() < now.getTime()
      ? input.occurredAt
      : now;

  const result = await deps.repos.tx(async (tx) => {
    const decision = await tx.smsConsent.applyDecisionIfNewer({
      phoneE164,
      status: "OPTED_OUT",
      eventAt,
      source: input.source,
      reasonKeyword: input.keyword ?? null,
      providerMessageId: input.providerMessageId ?? null,
      actorHumanId: input.actorHumanId ?? null,
    });

    // The signal log keeps every signal, stale ones under their own type.
    await tx.smsConsent.recordEvent({
      phoneE164,
      eventType: decision.applied ? "opt_out" : "opt_out_stale",
      source: input.source,
      providerMessageId: input.providerMessageId ?? null,
    });

    if (!decision.applied) {
      return { decision, cleared: 0 };
    }

    const cleared = await tx.volunteering.clearSmsOptInByPhone(phoneE164);

    await tx.audit.log({
      entity: "sms_consent",
      entityId: phoneE164,
      action: "sms_consent.opted_out",
      data: {
        source: input.source,
        keyword: input.keyword ?? null,
        actorHumanId: input.actorHumanId ?? null,
        clearedVolunteerSignups: cleared,
        eventAt: eventAt.toISOString(),
      },
      at: now,
    });

    return { decision, cleared };
  });
  const affectedVolunteerSignupCount = result.cleared;

  if (!result.decision.applied) {
    logger?.info("sms_consent.opt_out_stale_ignored", {
      source: input.source,
      currentStatus: result.decision.record.status,
    });
    return recordSmsOptOutOutputSchema.parse({
      status: result.decision.record.status,
      phoneE164,
      affectedVolunteerSignupCount: 0,
      applied: false,
    });
  }

  logger?.info("sms_consent.opted_out", {
    source: input.source,
    affectedVolunteerSignupCount,
  });

  return recordSmsOptOutOutputSchema.parse({
    status: "OPTED_OUT",
    phoneE164,
    affectedVolunteerSignupCount,
    applied: true,
  });
}
