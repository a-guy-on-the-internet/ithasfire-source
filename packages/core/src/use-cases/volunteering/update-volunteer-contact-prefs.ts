import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { VolunteerSignupRecord } from "@th/ports/repos/volunteering";

import { parseInput } from "../../lib/io";
import { toUsSmsNumber } from "../../lib/comms/phone";
import { updateVolunteerContactPrefsInputSchema } from "./schemas";
import {
  recordVolunteerSmsConsent,
  VOLUNTEER_REMINDER_TOGGLE_SMS_SOURCE,
  type VolunteerSmsConsentResult,
} from "./_shared/record-volunteer-sms-consent";
import { signupReminderAnchor } from "./_shared/signup-reminder-anchor";
import { fail } from "@th/errors";

export type UpdateVolunteerContactPrefsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Reports a consent-ledger write that failed after the toggle saved. */
  reportError?: ReporterPort;
};

/**
 * Volunteer updates the SMS-reminder preference on their own signup (Gap 6).
 *
 * - Ownership-guarded: the signup's `humanId` must equal the actor — same
 *   `not_signup_owner` contract as `withdrawVolunteerSignup`. Shadow-only
 *   signups (`humanId` null) are unmanageable here by design; the volunteer
 *   completes their account first.
 * - Enabling requires a `contactPhone` already on file: an opt-in without a
 *   destination is meaningless and unsafe to persist (TCPA defensibility —
 *   mirrors the force-clear in `submitVolunteerSignup`). There is no phone
 *   input on this mutation; the phone captured at signup is the consented
 *   destination.
 * - Disabling is ALWAYS allowed, phone or not — withdrawal of consent must
 *   never be blockable. It mirrors a carrier STOP (`clearSmsOptInByPhone`)
 *   scoped to one signup.
 * - Idempotent: re-setting the current value succeeds without a write or an
 *   audit row (same early-return shape as `checkInVolunteer`'s CHECKED_IN
 *   branch), so the audit trail only records actual consent transitions.
 * - Consent stays per-signup, matching capture — no global preference in v1.
 * - Switching reminders ON is consent (owner, 2026-10-17). When the number
 *   is the actor's own VERIFIED account phone, a fresh opt-in goes to the
 *   phone-level SMS consent ledger, so a number that once replied STOP gets
 *   its reminders again. A typed-in number is never written there (that
 *   would let anyone undo a stranger's STOP); for such a number the result
 *   carries the static `smsMayNeedStart` hint (reply START), which never
 *   reads the ledger. An ON that changed nothing records no new consent.
 *   A ledger failure is reported, never thrown: the toggle stays ON, and
 *   switching it OFF then ON again retries.
 * - Turning ON is refused (`sms_reminders_unavailable`) for a signup no
 *   reminder is sent for (`signupReminderAnchor`, volunteer-ask-reminders
 *   FR-005): a shiftless event signup on a role that has shifts, or an ask
 *   signup whose ask is not one-time with a start. OFF is always allowed.
 * - Switching reminders OFF writes nothing to the ledger: an opt-out there
 *   would also stop 2FA codes and every other text to the number.
 */
export async function updateVolunteerContactPrefs(
  deps: UpdateVolunteerContactPrefsDeps,
  rawInput: unknown,
): Promise<VolunteerSignupRecord & VolunteerSmsConsentResult> {
  const input = parseInput(updateVolunteerContactPrefsInputSchema, rawInput);
  // The moment the person switched reminders on: taken before the toggle
  // commits, so a STOP that lands before the post-commit ledger write is
  // newer and wins.
  const consentAt = deps.clock.now();

  const { record, changed, smsPhone } = await deps.repos.tx(async (tx) => {
    const signup = await tx.volunteering.getSignup(input.signupId);
    if (!signup) {
      throw fail("SIGNUP_NOT_FOUND");
    }

    // Must be the signup owner — checked before any state inspection so a
    // foreign signup id uniformly yields `not_signup_owner` regardless of
    // its current opt-in state (no preference oracle across humans).
    if (signup.humanId !== input.actorHumanId) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "signup" } });
    }

    // An ON for a signup no reminder is sent for is refused rather than
    // saved as a promise nobody keeps. A shift signup always has one; a
    // shiftless event signup needs its role to have no shifts, an ask
    // signup a one-time ask with a start. OFF stays always allowed.
    if (input.smsOptIn) {
      const shiftless = !signup.shiftId;
      const role =
        shiftless && signup.eventId
          ? await tx.volunteering.getEventRole(signup.roleId)
          : null;
      const ask =
        shiftless && !signup.eventId && signup.askId
          ? await tx.volunteering.getAsk(signup.askId)
          : null;
      const anchor = signupReminderAnchor({
        shiftId: signup.shiftId,
        eventId: signup.eventId,
        // A role that no longer exists offers no event-start anchor.
        roleHasShifts: role ? role.shifts.length > 0 : true,
        ask,
      });
      if (!anchor) {
        throw fail("INVALID_INPUT", { message: "sms_reminders_unavailable" });
      }
    }

    // Phone gate runs even when the flag is already true (drift state from
    // a manual edit): an enable request without a destination is always
    // rejected, never silently confirmed.
    const hasPhone = (signup.contactPhone ?? "").trim().length > 0;
    if (input.smsOptIn && !hasPhone) {
      throw fail("PHONE_REQUIRED_FOR_SMS");
    }
    // A number on file that we cannot text (outside the US) is refused the
    // same way submit refuses it, not left to fail at every reminder.
    const smsPhone = input.smsOptIn
      ? toUsSmsNumber(signup.contactPhone ?? "")
      : null;
    if (input.smsOptIn && !smsPhone) {
      throw fail("INVALID_INPUT", { message: "sms_requires_us_phone" });
    }
    // A number kept as typed ("615-555-0100", saved before SMS was on) is
    // stored in E.164 when SMS is turned on, so the reminder can send it.
    const phoneToStore =
      smsPhone && smsPhone !== signup.contactPhone ? smsPhone : undefined;

    // Idempotent re-set: nothing changed, so skip the write AND the audit
    // row — the trail records consent transitions, not toggle mashing.
    if (signup.smsOptIn === input.smsOptIn && phoneToStore === undefined) {
      return { record: signup, changed: false, smsPhone };
    }

    const updated = await tx.volunteering.updateSignupContactPrefs(
      input.signupId,
      {
        smsOptIn: input.smsOptIn,
        ...(phoneToStore !== undefined && { contactPhone: phoneToStore }),
      },
    );

    await tx.audit.log({
      entity: "volunteer_signup",
      entityId: input.signupId,
      action: "contact_prefs_updated",
      data: { humanId: input.actorHumanId, smsOptIn: input.smsOptIn },
      at: deps.clock.now(),
    });

    return { record: updated, changed: true, smsPhone };
  });

  if (!input.smsOptIn || !smsPhone) {
    return { ...record, smsMayNeedStart: false };
  }

  const consent = await recordVolunteerSmsConsent(deps, {
    phone: smsPhone,
    source: VOLUNTEER_REMINDER_TOGGLE_SMS_SOURCE,
    actorHumanId: input.actorHumanId,
    signupId: input.signupId,
    eventId: record.eventId,
    askId: record.askId ?? null,
    useCase: "updateVolunteerContactPrefs",
    recordOptIn: changed,
    consentAt,
  });
  return { ...record, ...consent };
}
