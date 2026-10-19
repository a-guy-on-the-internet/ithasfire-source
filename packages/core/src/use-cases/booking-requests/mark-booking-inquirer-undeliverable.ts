import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// markBookingInquirerUndeliverable — provider bounce/complaint → "we could not
// reach this person" on the venue's booking inquiry
// (booking-inquirer-outreach, 2026-09-05)
//
// WHY THIS ISN'T ALREADY COVERED. The platform records bounces on
// `AuthUser.email_delivery_status` (Resend webhook →
// `EmailDeliverabilityPort.recordProviderEvent`), but that adapter
// DELIBERATELY refuses to flag an UNVERIFIED account: "they may have
// fat-fingered their address at sign-up; suppressing them would lock them out
// forever". Every shadow minted for an inquirer is unverified by construction,
// so a bounced venue reply currently leaves a `EmailDeliveryEvent` row and
// nothing else — invisible to the venue staring at a silent thread. This
// stamps the inquiry itself.
//
// ADDRESS-KEYED, because the address is all the webhook knows: the provider
// does not echo our custom headers on bounce events. The repo therefore scopes
// the fan-in hard — only rows we actually MAILED (`inquirerEmailMessageId IS
// NOT NULL`), still OPEN, and still UNCLAIMED. See the port doc: without those
// scopes one bounce would stamp the same person's untouched inquiries at other
// venues, and a bounced guest-ticket receipt would stamp every one of them.
//
// BACKEND STATE ONLY in this step — no UI reads it yet, by design.
// ─────────────────────────────────────────────────────────────────────────────

export const markBookingInquirerUndeliverableInputSchema = z
  .object({
    /** Recipient address from the provider event. Lowercased here. */
    email: z.string().min(3).max(320),
    status: z.enum(["BOUNCED", "COMPLAINED"]),
    /** Provider-reported occurrence time. The stamp never moves backwards. */
    occurredAt: z.date(),
  })
  .strict();

export const markBookingInquirerUndeliverableOutputSchema = z
  .object({ stamped: z.number().int().min(0) })
  .strict();

export type MarkBookingInquirerUndeliverableInput = z.infer<
  typeof markBookingInquirerUndeliverableInputSchema
>;
export type MarkBookingInquirerUndeliverableOutput = z.infer<
  typeof markBookingInquirerUndeliverableOutputSchema
>;

export type MarkBookingInquirerUndeliverableDeps = {
  repos: Pick<Repos, "bookingRequests">;
  logger?: LoggerPort;
  /** Deliberate-swallow reporter (ReporterPort convention). */
  reportError?: ReporterPort;
};

/**
 * Stamp every open, unclaimed, ALREADY-MAILED inquiry at this address as
 * undeliverable.
 *
 * NEVER THROWS. It runs inside the provider webhook, whose response controls
 * Svix/Resend retry semantics: a failure here must not turn a successfully
 * ingested delivery event into a 500 that gets redelivered forever. Swallowed
 * + reported (warn is not Sentry-captured), returning `{ stamped: 0 }`.
 *
 * `stamped: 0` is the NORMAL case, not an error — most bounces belong to
 * addresses no booking inquiry ever used.
 */
export async function markBookingInquirerUndeliverable(
  deps: MarkBookingInquirerUndeliverableDeps,
  rawInput: unknown,
): Promise<MarkBookingInquirerUndeliverableOutput> {
  const input = parseInput(
    markBookingInquirerUndeliverableInputSchema,
    rawInput,
  );
  const logger = deps.logger?.child({
    useCase: "markBookingInquirerUndeliverable",
  });

  try {
    const stamped =
      await deps.repos.bookingRequests.markInquirerEmailUndeliverable({
        contactEmail: input.email.toLowerCase(),
        status: input.status,
        at: input.occurredAt,
      });

    if (stamped > 0) {
      logger?.info("booking_requests.inquirer_email_undeliverable", {
        status: input.status,
        stamped,
      });
    }

    return markBookingInquirerUndeliverableOutputSchema.parse({ stamped });
  } catch (error) {
    logger?.error("booking_requests.inquirer_undeliverable_failed", {
      status: input.status,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "markBookingInquirerUndeliverable" },
        // Deliberately NO email address in the report — Sentry extras are not
        // a place for recipient PII; the log line above carries the rest.
        extra: { status: input.status },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // webhook's 200 into a 500.
    }
    return markBookingInquirerUndeliverableOutputSchema.parse({ stamped: 0 });
  }
}
