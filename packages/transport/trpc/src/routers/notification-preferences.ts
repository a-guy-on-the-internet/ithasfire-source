import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  maskSmsIneligibleSnapshot,
  smsEligibleCategories,
  smsIneligibleEnables,
  withSmsIneligibleCleared,
} from "@th/core/use-cases/comms/categories";
import { recordSmsOptIn } from "@th/core/use-cases/comms/record-sms-opt-in";
import { redactedError } from "@th/core/lib/comms/redacted-error";

import { authedProcedure } from "../init";
import type { Ctx } from "../context";

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("GLOBAL") }).strict(),
  z.object({ kind: z.literal("ORG"), orgId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("EVENT"), eventId: z.string().uuid() }).strict(),
]);

const categoryToggle = z
  .object({
    transactional: z.boolean().optional(),
    announcements: z.boolean().optional(),
    reminders: z.boolean().optional(),
    marketing: z.boolean().optional(),
    organizerMessages: z.boolean().optional(),
    billsYoureOn: z.boolean().optional(),
  })
  .strict();

const emailChannelUpdate = categoryToggle.extend({
  frequency: z.enum(["INSTANT", "DAILY_DIGEST", "WEEKLY_DIGEST"]).optional(),
});

const channelsUpdate = z
  .object({
    email: emailChannelUpdate.optional(),
    sms: categoryToggle.optional(),
    push: categoryToggle.optional(),
    in_app: categoryToggle.optional(),
  })
  .strict();

const getInput = z.object({
  scope: scopeSchema.optional(),
});

const updateInput = z.object({
  scope: scopeSchema.optional(),
  categories: categoryToggle.optional(),
  channels: channelsUpdate.optional(),
});

/**
 * Durable SMS opt-in (FR-003): a user flipping any SMS category ON in
 * settings is an explicit re-consent signal, so mirror it into the phone
 * consent ledger. Best-effort by design — the preference write must never
 * fail because the ledger write did (idempotent either way), and users
 * without a verified phone simply have nothing to record yet.
 */
async function recordSettingsSmsOptInBestEffort(
  ctx: Ctx,
  smsDelta: z.infer<typeof categoryToggle> | undefined,
  /**
   * When the switch was flipped: read before the preference write commits,
   * so a STOP that lands before this later ledger write is newer and wins.
   */
  consentAt: Date,
): Promise<void> {
  const enabledAnySmsCategory = Object.values(smsDelta ?? {}).some(
    (value) => value === true,
  );
  if (!enabledAnySmsCategory) return;

  try {
    const humanWithIdentity = await ctx.repos.humans.getByIdWithIdentity(
      ctx.actorHumanId!,
    );
    const phone = humanWithIdentity?.identity.phone;
    if (!phone || !humanWithIdentity.identity.phoneVerified) return;

    await recordSmsOptIn(
      { repos: ctx.repos, clock: ctx.clock, logger: ctx.logger },
      {
        phoneNumber: phone,
        source: "settings_sms_toggle",
        actorHumanId: ctx.actorHumanId!,
        occurredAt: consentAt,
      },
    );
  } catch (error) {
    // Database diagnostics can echo the phone number: only this redacted
    // copy reaches the log and the error tracker.
    const safeError = redactedError(error);
    // warn, not error: the report below is the Sentry event, and
    // pinoIntegration would file `logger.error` as a second one.
    ctx.logger?.warn("notification_preferences.sms_opt_in_record_failed", {
      error: safeError.message,
    });
    // Swallowed is not silent (CLAUDE.md, "Error Reporting Convention"):
    // someone who replied STOP and switches SMS back on stays OPTED_OUT if
    // this write failed. Guarded so a throwing reporter changes nothing.
    try {
      ctx.reportError?.(safeError, {
        tags: {
          router: "notificationPreferences.update",
          stage: "sms_opt_in_record",
          swallowed: "true",
        },
      });
    } catch {
      // Reporting is best-effort.
    }
  }
}

export const notificationPreferencesRouter = {
  get: authedProcedure.input(getInput).query(async ({ ctx, input }) => {
    const scope = input.scope ?? { kind: "GLOBAL" as const };
    const snapshot = await ctx.repos.notificationPrefs.readEffective({
      humanId: ctx.actorHumanId!,
      scope,
    });
    return {
      scope,
      // A stored opt-in for a never-texted category reads as off.
      preferences: maskSmsIneligibleSnapshot(snapshot),
      smsEligibleCategories: [...smsEligibleCategories],
    };
  }),

  update: authedProcedure
    .input(updateInput)
    .mutation(async ({ ctx, input }) => {
      const scope = input.scope ?? { kind: "GLOBAL" as const };

      // Only transactional may ever be texted; refuse turning SMS
      // on for any other category (turning it off is accepted).
      const ineligible = smsIneligibleEnables(input.channels?.sms);
      if (ineligible.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `sms_category_ineligible: ${ineligible.join(",")}`,
        });
      }

      // Any SMS write also clears stale opt-ins for never-texted categories,
      // so stored, shown and sent agree.
      const delta = {
        categories: input.categories,
        channels: input.channels?.sms
          ? {
              ...input.channels,
              sms: withSmsIneligibleCleared(input.channels.sms),
            }
          : input.channels,
      };

      const consentAt = ctx.clock.now();
      await ctx.repos.notificationPrefs.upsert({
        humanId: ctx.actorHumanId!,
        scope,
        delta,
      });

      await recordSettingsSmsOptInBestEffort(
        ctx,
        input.channels?.sms,
        consentAt,
      );

      const snapshot = await ctx.repos.notificationPrefs.readEffective({
        humanId: ctx.actorHumanId!,
        scope,
      });

      return {
        ok: true as const,
        scope,
        preferences: maskSmsIneligibleSnapshot(snapshot),
        smsEligibleCategories: [...smsEligibleCategories],
      };
    }),
};
