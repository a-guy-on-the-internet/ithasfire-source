import { createHash } from "node:crypto";

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { PushPort } from "@th/ports/comms/push";
import type { SMSPort } from "@th/ports/comms/sms";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos } from "@th/ports/repos";
import type { NotificationPreferenceScope } from "@th/ports/repos/notification-preferences";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  getNotificationCategoryConfig,
  notificationCategorySchema,
  type NotificationCategory,
} from "./categories";
import {
  scopeSchema,
  inAppResultSchema,
  pushResultSchema,
  emailResultSchema,
  smsResultSchema,
  isChannelEnabled,
  scopeKey,
  type InAppResult,
  type PushResult,
  type EmailResult,
  type SmsResult,
} from "./shared";
import { renderNotification, type InAppChannelPayload } from "./renderers";
import { buildInAppTemplateRef } from "./render-stored-notification";
import { sendInApp } from "./channels/send-in-app";
import { sendPush } from "./channels/send-push";
import { sendEmail } from "./channels/send-email";
import { sendSms } from "./channels/send-sms";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 60;

const channelToggleSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

const notifyChannelsSchema = z
  .object({
    inApp: channelToggleSchema.optional(),
    push: channelToggleSchema.optional(),
    email: channelToggleSchema.optional(),
    sms: channelToggleSchema.optional(),
  })
  .partial();

export const notifyInputSchema = z
  .object({
    humanId: z.string().uuid(),
    variant: z.string().min(1),
    payload: z.unknown().optional(),
    scope: scopeSchema.optional(),
    idempotencyKey: z.string().min(8).optional(),
    actor: z
      .object({
        type: z.enum(["system", "human", "service"]).default("system"),
        humanId: z.string().uuid().optional(),
        label: z.string().min(1).optional(),
      })
      .partial()
      .optional(),
    channels: notifyChannelsSchema.optional(),
  })
  .strict();

export const notifyOutputSchema = z
  .object({
    ok: z.literal(true),
    variant: z.string().min(1),
    category: notificationCategorySchema,
    scope: scopeSchema,
    inApp: inAppResultSchema,
    push: pushResultSchema.optional(),
    email: emailResultSchema.optional(),
    sms: smsResultSchema.optional(),
    idempotentReplay: z.boolean().optional(),
  })
  .strict();

export type NotifyInput = z.infer<typeof notifyInputSchema>;
export type NotifyOutput = z.infer<typeof notifyOutputSchema>;

export type NotifyDeps = {
  repos: Repos;
  clock: ClockPort;
  idempotency: IdempotencyPort;
  push?: PushPort;
  mailer?: MailerPort;
  sms?: SMSPort;
  metrics?: MetricsPort;
  logger?: LoggerPort;
  /**
   * Reports the in-app row that could not store its render payload (so it can
   * never be shown in the reader's language). The notification itself still
   * goes out; see `storeInAppTemplate`.
   */
  reportError?: ReporterPort;
};

/**
 * The in-app payload with its render payload attached as the row's template
 * (`buildInAppTemplateRef`), so the inbox can re-render it in the reader's
 * language. Leaves a renderer-supplied template alone.
 *
 * A payload that cannot be stored is a deliberate fallback — the row still
 * goes out, in English for every reader — so it is reported (CLAUDE.md
 * swallow rule), guarded so a throwing reporter changes nothing. Only when
 * the in-app row will actually be written, so a disabled channel or a renderer
 * without in-app output reports nothing.
 */
function storeInAppTemplate(
  deps: Pick<NotifyDeps, "reportError">,
  logger: LoggerPort | undefined,
  variant: string,
  payload: unknown,
  inApp: InAppChannelPayload | undefined,
  enabled: boolean,
): InAppChannelPayload | undefined {
  if (!inApp || !enabled || inApp.template !== null) return inApp;
  const built = buildInAppTemplateRef(variant, payload);
  if (built.skipped) {
    const chars = "chars" in built ? built.chars : undefined;
    logger?.warn("comms.notify.in_app_template_skipped", {
      variant,
      reason: built.skipped,
      chars,
    });
    try {
      deps.reportError?.(
        new Error(
          `notify: in-app template for "${variant}" not stored (${built.skipped})`,
        ),
        {
          tags: {
            useCase: "comms.notify",
            variant,
            reason: built.skipped,
          },
          extra: { chars },
        },
      );
    } catch {
      // A throwing reporter must never fail the notification.
    }
  }
  return { ...inApp, template: built.template };
}

interface StoredNotifyRecord {
  payloadHash: string;
  response: NotifyOutput;
}

export async function notify(
  deps: NotifyDeps,
  rawInput: unknown,
): Promise<NotifyOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "comms.notify" });

  const execute = async (): Promise<NotifyOutput> => {
    const parsedInput = parseInput(notifyInputSchema, rawInput);
    const scope =
      parsedInput.scope ??
      ({ kind: "GLOBAL" } as const satisfies NotificationPreferenceScope);
    const now = deps.clock.now();

    // Stored text is always English; the inbox re-renders it in the reader's
    // language from the template stored with the row (storeInAppTemplate).
    const rendered = renderNotification(
      parsedInput.variant,
      parsedInput.payload,
      { now, locale: "en" },
    );

    const idempotencyPayload = {
      humanId: parsedInput.humanId,
      scope,
      variant: parsedInput.variant,
      fingerprint: rendered.fingerprint,
    };
    const payloadHash = sha256(JSON.stringify(idempotencyPayload));
    const idempotencyKey = buildIdempotencyKey(parsedInput, scope, payloadHash);

    const replay =
      await deps.idempotency.get<StoredNotifyRecord>(idempotencyKey);
    if (replay) {
      ensurePayloadConsistency(replay.payloadHash, payloadHash);
      const replayOutput = notifyOutputSchema.parse({
        ...replay.response,
        idempotentReplay: true,
      });
      return replayOutput;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const pending =
        await deps.idempotency.get<StoredNotifyRecord>(idempotencyKey);
      if (pending) {
        ensurePayloadConsistency(pending.payloadHash, payloadHash);
        return notifyOutputSchema.parse({
          ...pending.response,
          idempotentReplay: true,
        });
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      const humanWithIdentity = await deps.repos.humans.getByIdWithIdentity(
        parsedInput.humanId,
      );
      if (!humanWithIdentity) {
        throw fail("HUMAN_NOT_FOUND");
      }
      const { human } = humanWithIdentity;

      const preferences = await deps.repos.notificationPrefs.readEffective({
        humanId: parsedInput.humanId,
        scope,
      });

      const overrides = parsedInput.channels ?? {};

      const inAppPreference = isChannelEnabled(
        preferences,
        "in_app",
        rendered.category,
        true,
      );
      const pushPreference = isChannelEnabled(
        preferences,
        "push",
        rendered.category,
        getNotificationCategoryConfig(rendered.category).pushDefaultEnabled,
      );
      const emailPreference = isChannelEnabled(
        preferences,
        "email",
        rendered.category,
        getNotificationCategoryConfig(rendered.category).emailDefaultEnabled,
      );
      const smsPreference = isChannelEnabled(
        preferences,
        "sms",
        rendered.category,
        getNotificationCategoryConfig(rendered.category).smsDefaultEnabled,
      );

      const inAppEnabled = overrides.inApp?.enabled ?? inAppPreference;
      const pushEnabled = overrides.push?.enabled ?? pushPreference;
      const emailEnabled = overrides.email?.enabled ?? emailPreference;
      const smsEnabled = overrides.sms?.enabled ?? smsPreference;

      const inAppResult = await sendInApp(
        { repos: deps.repos, logger: deps.logger },
        {
          humanId: parsedInput.humanId,
          variant: parsedInput.variant,
          category: rendered.category,
          scope,
          payload: storeInAppTemplate(
            deps,
            scopedLogger,
            parsedInput.variant,
            parsedInput.payload,
            rendered.inApp,
            inAppEnabled,
          ),
          enabled: inAppEnabled,
          now,
          idempotencyKey,
        },
      );

      const pushResult = await sendPush(
        { repos: deps.repos, push: deps.push, logger: deps.logger },
        {
          humanId: parsedInput.humanId,
          variant: parsedInput.variant,
          category: rendered.category,
          scope,
          payload: rendered.push,
          enabled: pushEnabled,
          notificationId:
            inAppResult.status === "persisted"
              ? inAppResult.notificationId
              : undefined,
        },
      );

      const emailResult = await sendEmail(
        { mailer: deps.mailer, logger: deps.logger },
        {
          human: humanWithIdentity,
          variant: parsedInput.variant,
          category: rendered.category,
          scope,
          payload: rendered.email,
          enabled: emailEnabled,
          // Channel-DERIVED key, not the notify-level key: notify() has
          // already claimed `idempotencyKey` via deps.idempotency.begin()
          // above. The mail adapter takes its own claim through the SAME
          // idempotency port (bound in the api/jobs containers), so passing
          // the identical key makes the adapter's begin() see notify's
          // in-progress claim and every send dies with idempotency_conflict
          // — emails silently lost while the outbox row is still marked
          // dispatched. The `:email` suffix keeps per-send dedupe intact
          // without colliding with the parent claim.
          idempotencyKey: `${idempotencyKey}:email`,
        },
      );

      const smsResult = await sendSms(
        {
          sms: deps.sms,
          smsConsent: deps.repos.smsConsent,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        {
          human: humanWithIdentity,
          variant: parsedInput.variant,
          category: rendered.category,
          scope,
          payload: rendered.sms,
          enabled: smsEnabled,
          // Same layering rule as the email channel above.
          idempotencyKey: `${idempotencyKey}:sms`,
        },
      );

      emitMetrics(deps.metrics, {
        variant: parsedInput.variant,
        category: rendered.category,
        inApp: inAppResult,
        push: pushResult,
        email: emailResult,
        sms: smsResult,
      });

      const response = notifyOutputSchema.parse({
        ok: true,
        variant: parsedInput.variant,
        category: rendered.category,
        scope,
        inApp: inAppResult,
        push: pushResult,
        email: emailResult,
        sms: smsResult,
      });

      await deps.idempotency.commit<StoredNotifyRecord>(
        idempotencyKey,
        { payloadHash, response },
        IDEMPOTENCY_TTL_SECONDS,
      );

      scopedLogger?.info("comms.notify.success", {
        humanId: parsedInput.humanId,
        variant: parsedInput.variant,
        category: rendered.category,
        inAppStatus: inAppResult.status,
        pushStatus: pushResult.status,
        emailStatus: emailResult.status,
        smsStatus: smsResult.status,
      });

      return response;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("notify", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("comms.notify", execute);
  }

  return execute();
}

function emitMetrics(
  metrics: MetricsPort | undefined,
  context: {
    variant: string;
    category: NotificationCategory;
    inApp: InAppResult;
    push: PushResult;
    email: EmailResult;
    sms: SmsResult;
  },
): void {
  if (!metrics) return;

  const baseTags: Record<string, string> = {
    variant: context.variant,
    category: context.category,
  };

  metrics.increment("comms.notify.request", baseTags);

  if (context.inApp.status === "persisted") {
    metrics.increment("comms.notify.inapp.persisted", baseTags);
  } else {
    metrics.increment("comms.notify.inapp.skipped", {
      ...baseTags,
      reason: context.inApp.reason,
    });
  }

  if (context.push.status === "sent") {
    metrics.increment("comms.notify.push.sent", {
      ...baseTags,
      devices: String(context.push.deviceCount),
    });
  } else if (context.push.status === "skipped") {
    metrics.increment("comms.notify.push.skipped", {
      ...baseTags,
      reason: context.push.reason,
    });
  } else if (context.push.status === "failed") {
    metrics.increment("comms.notify.push.failed", {
      ...baseTags,
      reason: context.push.reason,
      devices: String(context.push.deviceCount),
    });
  }

  if (context.email.status === "sent") {
    metrics.increment("comms.notify.email.sent", baseTags);
  } else if (context.email.status === "skipped") {
    metrics.increment("comms.notify.email.skipped", {
      ...baseTags,
      reason: context.email.reason,
    });
  } else if (context.email.status === "failed") {
    metrics.increment("comms.notify.email.failed", {
      ...baseTags,
      reason: context.email.reason,
    });
  }

  if (context.sms.status === "sent") {
    metrics.increment("comms.notify.sms.sent", baseTags);
  } else if (context.sms.status === "skipped") {
    metrics.increment("comms.notify.sms.skipped", {
      ...baseTags,
      reason: context.sms.reason,
    });
  } else if (context.sms.status === "failed") {
    metrics.increment("comms.notify.sms.failed", {
      ...baseTags,
      reason: context.sms.reason,
    });
  }
}

function buildIdempotencyKey(
  input: NotifyInput,
  scope: NotificationPreferenceScope,
  payloadHash: string,
): string {
  const scopeSegment = scopeKey(scope);
  const suffix = input.idempotencyKey ? input.idempotencyKey : payloadHash;
  return `notify:${input.humanId}:${scopeSegment}:${suffix}`;
}

function ensurePayloadConsistency(
  expectedHash: string,
  actualHash: string,
): void {
  if (expectedHash !== actualHash) {
    throw fail("IDEMPOTENCY_KEY_CONFLICT");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
