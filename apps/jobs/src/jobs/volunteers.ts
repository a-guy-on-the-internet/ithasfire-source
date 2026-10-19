/**
 * Volunteer cron jobs.
 *
 * Two windows that fan out into the same `sendVolunteerShiftReminders`
 * use case with a different `kind`:
 *
 *   • volunteers.reminders-24h — runs every 30 min, picks up APPROVED
 *     signups whose anchor starts in the next ~24h band (23h30m–24h30m).
 *   • volunteers.reminders-1h  — runs every 30 min (aligned with the
 *     other :00/:30 jobs so the database wakes once per slot), picks up the
 *     40m–80m band. Both bands are wider than the tick on purpose; see
 *     DEFAULT_BAND_MS in send-volunteer-shift-reminders.ts.
 *
 * A signup's anchor is its shift's start; else, for an event role without
 * shifts, the event's start; else, for a one-time ask with a start time,
 * the ask's start (`signupReminderAnchor`, volunteer-ask-reminders). The
 * result counts candidates per anchor in `byAnchor`.
 *
 * One person with several signups on the same event or ask at the same start
 * gets one message per channel naming every role (R12). In the result,
 * `sent` / `skipped` / `failed` count signups per channel and `messages`
 * counts what went out, so a grouped text is `sent.sms: 2, messages.sms: 1`.
 *
 * Idempotency is enforced inside the use case via the
 * `VolunteerShiftNotification` unique `(signupId, kind, channel)`
 * index, so overlapping ticks (e.g. cron drift) can't double-fire.
 *
 * SMS dispatch only happens when AWS SNS is configured AND the
 * volunteer explicitly opted in at signup time (`smsOptIn=true` on
 * the signup row). In-app dispatch persists a notification row (the
 * polled inbox) and only applies to signups with a `humanId` (real
 * accounts — shadow profiles have no inbox; the use case skips them
 * per-channel).
 */
import { z } from "zod";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { sendVolunteerShiftReminders } from "@th/core/use-cases/volunteering";

const reminderInput = z.object({
  /** Optional explicit window for backfills or one-off catch-up runs. */
  windowStartIso: z.string().datetime().optional(),
  windowEndIso: z.string().datetime().optional(),
});

export const volunteersReminders24h = defineScheduledTask({
  name: "volunteers.reminders-24h",
  description:
    "Dispatch 24h-ahead volunteer reminders for shifts, shiftless event roles and one-time asks (email + in-app for signed-in volunteers + SMS for opted-in numbers). Idempotent via the VolunteerShiftNotification ledger.",
  input: reminderInput,
  schedule: getSchedule("volunteers.reminders-24h"),
  handler: async ({ input, ctx }) => {
    const result = await sendVolunteerShiftReminders(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        mailer: ctx.mailer,
        sms: ctx.sms,
        renderEmailTemplate: ctx.renderEmailTemplate,
        appBaseUrl: ctx.appBaseUrl,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      { kind: "REMINDER_24H", ...input },
    );
    ctx.logger.info("volunteers.reminders-24h.completed", result);
    return result;
  },
});

export const volunteersReminders1h = defineScheduledTask({
  name: "volunteers.reminders-1h",
  description:
    "Dispatch 1h-ahead volunteer reminders for shifts, shiftless event roles and one-time asks. Window +40m to +80m on a */30 tick; the per-channel ledger claim keeps overlapping ticks to one reminder.",
  input: reminderInput,
  schedule: getSchedule("volunteers.reminders-1h"),
  handler: async ({ input, ctx }) => {
    const result = await sendVolunteerShiftReminders(
      {
        repos: ctx.repos,
        clock: ctx.clock,
        mailer: ctx.mailer,
        sms: ctx.sms,
        renderEmailTemplate: ctx.renderEmailTemplate,
        appBaseUrl: ctx.appBaseUrl,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      { kind: "REMINDER_1H", ...input },
    );
    ctx.logger.info("volunteers.reminders-1h.completed", result);
    return result;
  },
});

export const volunteerJobs = [volunteersReminders24h, volunteersReminders1h];
