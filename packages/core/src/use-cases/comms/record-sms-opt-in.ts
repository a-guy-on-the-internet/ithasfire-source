import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { normalizePhoneE164 } from "../../lib/comms/phone";
import { fail } from "@th/errors";

export const recordSmsOptInInputSchema = z
  .object({
    phoneNumber: z.string().min(1),
    source: z.string().min(1),
    actorHumanId: z.uuid().optional(),
    /**
     * When the person opted in: the provider's timestamp for an inbound
     * keyword. Omitted for consent given in the app (the clock's now).
     */
    occurredAt: z.date().optional(),
    /** Provider message id of an inbound START, kept as consent evidence. */
    providerMessageId: z.string().min(1).optional(),
    /** Where the consent was given (kept on the audit row). */
    context: z
      .object({
        signupId: z.uuid().optional(),
        eventId: z.uuid().optional(),
        askId: z.uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const recordSmsOptInOutputSchema = z
  .object({
    /** The ledger state after the call. */
    status: z.enum(["OPTED_IN", "OPTED_OUT", "UNKNOWN"]),
    phoneE164: z.string(),
    /** False when a newer opt-out (or opt-in) was already recorded. */
    applied: z.boolean(),
  })
  .strict();

export type RecordSmsOptInInput = z.infer<typeof recordSmsOptInInputSchema>;
export type RecordSmsOptInOutput = z.infer<typeof recordSmsOptInOutputSchema>;

export type RecordSmsOptInDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Records explicit SMS re-consent for a phone number. Intentionally does NOT
 * re-enable any prior volunteer signup reminder subscriptions — the volunteer
 * must opt back into a specific reminder flow again. Idempotent: repeated
 * opt-ins converge on one OPTED_IN ledger row.
 *
 * Ordered by when the person decided (`occurredAt`, else now): an opt-in
 * older than the row's latest opt-out changes nothing, so a redelivered
 * START cannot undo a newer STOP. A future `occurredAt` is clamped to now.
 */
export async function recordSmsOptIn(
  deps: RecordSmsOptInDeps,
  rawInput: unknown,
): Promise<RecordSmsOptInOutput> {
  const logger = deps.logger?.child({ useCase: "recordSmsOptIn" });
  const input = parseInput(recordSmsOptInInputSchema, rawInput);

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
      status: "OPTED_IN",
      eventAt,
      source: input.source,
      actorHumanId: input.actorHumanId ?? null,
      providerMessageId: input.providerMessageId ?? null,
    });

    // The signal log keeps every signal, stale ones under their own type.
    await tx.smsConsent.recordEvent({
      phoneE164,
      eventType: decision.applied ? "opt_in" : "opt_in_stale",
      source: input.source,
      providerMessageId: input.providerMessageId ?? null,
    });

    if (decision.applied) {
      await tx.audit.log({
        entity: "sms_consent",
        entityId: phoneE164,
        action: "sms_consent.opted_in",
        data: {
          source: input.source,
          actorHumanId: input.actorHumanId ?? null,
          eventAt: eventAt.toISOString(),
          ...(input.context ? { context: input.context } : {}),
        },
        at: now,
      });
    }

    return decision;
  });

  if (!result.applied) {
    logger?.info("sms_consent.opt_in_stale_ignored", {
      source: input.source,
      currentStatus: result.record.status,
    });
    return recordSmsOptInOutputSchema.parse({
      status: result.record.status,
      phoneE164,
      applied: false,
    });
  }

  logger?.info("sms_consent.opted_in", { source: input.source });

  return recordSmsOptInOutputSchema.parse({
    status: "OPTED_IN",
    phoneE164,
    applied: true,
  });
}
