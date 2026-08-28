/**
 * Volunteer cron jobs.
 *
 * Two windows that fan out into the same `sendVolunteerShiftReminders`
 * use case with a different `kind`:
 *
 *   • volunteers.reminders-24h — runs every 15 min, picks up APPROVED
 *     signups whose shift starts in the next ~24h band (23h45m–24h15m).
 *   • volunteers.reminders-1h  — runs every 5 min, picks up the
 *     55m–65m band.
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
    "Dispatch 24h-ahead volunteer shift reminders (email + in-app for signed-in volunteers + SMS for opted-in numbers). Idempotent via the VolunteerShiftNotification ledger.",
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
    "Dispatch 1h-ahead volunteer shift reminders. Tighter window + faster cron tick than the 24h variant.",
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
      },
      { kind: "REMINDER_1H", ...input },
    );
    ctx.logger.info("volunteers.reminders-1h.completed", result);
    return result;
  },
});

export const volunteerJobs = [volunteersReminders24h, volunteersReminders1h];
