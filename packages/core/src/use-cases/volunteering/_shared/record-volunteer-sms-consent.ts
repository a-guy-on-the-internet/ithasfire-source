import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import { safeReporter, type ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { describeError } from "../../../lib/io";
import { redactedError } from "../../../lib/comms/redacted-error";
import { toUsSmsNumber } from "../../../lib/comms/phone";
import { recordSmsOptIn } from "../../comms/record-sms-opt-in";

/** Ledger `source` for an opt-in ticked on a new volunteer signup. */
export const VOLUNTEER_SIGNUP_SMS_SOURCE = "volunteer_signup";
/** Ledger `source` for "Text me shift reminders" switched on later. */
export const VOLUNTEER_REMINDER_TOGGLE_SMS_SOURCE = "volunteer_reminder_toggle";

export type RecordVolunteerSmsConsentDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export type VolunteerSmsConsentResult = {
  /**
   * A static hint, true when reminders are on for a number that is NOT the
   * signed-in actor's own verified phone: if that number ever replied STOP,
   * texts stay off until it replies START. Deliberately does not read the
   * ledger, so it never reveals whether a typed number replied STOP.
   * For the actor's own verified phone it is false (re-consented), except
   * when nothing changed and that number's own STOP still stands.
   */
  smsMayNeedStart: boolean;
};

/**
 * Switching volunteer SMS reminders on is consent to receive them (owner,
 * 2026-10-17), but a signup's phone is typed in, not proven. Writing an
 * opt-in for any typed number would let anyone undo a stranger's STOP. So
 * the fresh opt-in goes to the phone-level ledger ONLY when the actor is
 * signed in and the number is their own VERIFIED account phone. Any other
 * number is left as the ledger has it, unread, and the result carries the
 * static `smsMayNeedStart` hint.
 *
 * Runs after the signup write commits and never throws: the signup keeps
 * `smsOptIn` when the ledger write fails (the ledger is the send guard, and
 * switching the toggle again retries). A failure is logged and reported,
 * and the hint then reads true (the number may still be blocked).
 */
export async function recordVolunteerSmsConsent(
  deps: RecordVolunteerSmsConsentDeps,
  input: {
    phone: string;
    source: string;
    /** The signed-in actor; null/absent for an anonymous submit. */
    actorHumanId?: string | null;
    signupId: string;
    eventId?: string | null;
    askId?: string | null;
    useCase: string;
    /**
     * False for a request that changed nothing (an ON that was already on):
     * the ledger is only read, so a repeat never manufactures a new consent.
     */
    recordOptIn?: boolean;
    /**
     * When the person consented: the clock read when the enable action was
     * accepted, before its commit. The ledger orders by this, not by when
     * this post-commit write runs, so a STOP in between wins.
     */
    consentAt: Date;
  },
): Promise<VolunteerSmsConsentResult> {
  const phoneE164 = toUsSmsNumber(input.phone);
  if (!phoneE164) return { smsMayNeedStart: false };

  try {
    if (!input.actorHumanId) return { smsMayNeedStart: true };
    const actor = await deps.repos.humans.getByIdWithIdentity(
      input.actorHumanId,
    );
    const verifiedPhone =
      actor?.identity.phoneVerified && actor.identity.phone
        ? toUsSmsNumber(actor.identity.phone)
        : null;
    if (verifiedPhone !== phoneE164) return { smsMayNeedStart: true };

    if (input.recordOptIn === false) {
      // Nothing changed: no new consent. Reading the ledger is fine here,
      // the number is the actor's own verified phone.
      const current = await deps.repos.smsConsent.getByPhone(phoneE164);
      return { smsMayNeedStart: current?.status === "OPTED_OUT" };
    }

    const result = await recordSmsOptIn(
      {
        repos: deps.repos,
        clock: deps.clock,
        ...(deps.logger ? { logger: deps.logger } : {}),
      },
      {
        phoneNumber: phoneE164,
        source: input.source,
        actorHumanId: input.actorHumanId,
        occurredAt: input.consentAt,
        context: {
          signupId: input.signupId,
          ...(input.eventId ? { eventId: input.eventId } : {}),
          ...(input.askId ? { askId: input.askId } : {}),
        },
      },
    );
    return { smsMayNeedStart: result.status === "OPTED_OUT" };
  } catch (error) {
    // Database/provider diagnostics can echo the phone number: only this
    // redacted copy reaches the log and the error tracker.
    const safeError = redactedError(error);
    try {
      deps.logger?.error("volunteering.sms_consent_record_failed", {
        signupId: input.signupId,
        source: input.source,
        error: describeError(safeError),
      });
    } catch {
      // Logging is best-effort.
    }
    if (deps.reportError) {
      safeReporter(deps.reportError)(safeError, {
        tags: {
          useCase: input.useCase,
          stage: "sms_consent_ledger",
          swallowed: "true",
        },
        extra: { signupId: input.signupId, source: input.source },
      });
    }
    return { smsMayNeedStart: true };
  }
}
