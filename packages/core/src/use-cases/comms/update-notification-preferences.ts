import { createHash } from "node:crypto";

import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type {
  NotificationPreferenceTokenPayload,
  NotificationPreferenceTokenScope,
  NotificationPreferenceTokensPort,
} from "@th/ports/notification-preference-tokens";
import type {
  NotificationPreferenceCategory,
  NotificationPreferenceChannel,
  NotificationPreferenceCategoryDelta,
  NotificationPreferenceDelta,
  NotificationPreferenceScope,
  NotificationPreferenceSnapshot,
  NotificationPreferenceChannelsDelta,
  NotificationPreferenceEmailChannelDelta,
  NotificationEmailFrequency,
} from "@th/ports/repos/notification-preferences";
import type { Repos } from "@th/ports/repos";

import { asKnownError } from "../../lib/errors";
import {
  maskSmsIneligible,
  smsIneligibleEnables,
  withSmsIneligibleCleared,
} from "./categories";
import { describeError, parseInput } from "../../lib/io";
import { fail } from "@th/errors";

const CATEGORY_KEYS = [
  "transactional",
  "announcements",
  "reminders",
  "marketing",
  "organizerMessages",
  "billsYoureOn",
] as const satisfies ReadonlyArray<NotificationPreferenceCategory>;
const CHANNEL_KEYS = [
  "email",
  "sms",
  "push",
  "in_app",
] as const satisfies ReadonlyArray<NotificationPreferenceChannel>;
const IDEMPOTENCY_TTL_SECONDS = 60;

const emailFrequencySchema = z.enum([
  "INSTANT",
  "DAILY_DIGEST",
  "WEEKLY_DIGEST",
]);

const categoryUpdateSchema = z
  .object({
    transactional: z.boolean().optional(),
    announcements: z.boolean().optional(),
    reminders: z.boolean().optional(),
    marketing: z.boolean().optional(),
    organizerMessages: z.boolean().optional(),
    billsYoureOn: z.boolean().optional(),
  })
  .strict();

const emailChannelUpdateSchema = categoryUpdateSchema.extend({
  frequency: emailFrequencySchema.optional(),
});

const channelUpdatesSchema = z
  .object({
    email: emailChannelUpdateSchema.optional(),
    sms: categoryUpdateSchema.optional(),
    push: categoryUpdateSchema.optional(),
    in_app: categoryUpdateSchema.optional(),
  })
  .strict();

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("GLOBAL") }).strict(),
  z
    .object({
      kind: z.literal("ORG"),
      orgId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("EVENT"),
      eventId: z.string().uuid(),
    })
    .strict(),
]);

const updatesSchema = z
  .object({
    categories: categoryUpdateSchema.optional(),
    channels: channelUpdatesSchema.optional(),
  })
  .strict();

export const updateNotificationPreferencesInputSchema = z
  .object({
    actorHumanId: z.string().uuid().optional(),
    token: z.string().min(1).optional(),
    humanId: z.string().uuid(),
    scope: scopeSchema,
    updates: updatesSchema.optional(),
    clientKey: z.string().min(8).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasActor = Boolean(value.actorHumanId);
    const hasToken = Boolean(value.token);
    if (hasActor === hasToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly_one_actor_or_token",
        path: ["actorHumanId"],
      });
    }
  });

const effectiveChannelSchema = z
  .object({
    transactional: z.boolean(),
    announcements: z.boolean(),
    reminders: z.boolean(),
    marketing: z.boolean(),
    organizerMessages: z.boolean(),
    billsYoureOn: z.boolean(),
    frequency: emailFrequencySchema.optional(),
  })
  .strict();

const nonEmailEffectiveChannelSchema = effectiveChannelSchema.omit({
  frequency: true,
});

const persistedDeltaSchema = updatesSchema;

export const updateNotificationPreferencesOutputSchema = z
  .object({
    ok: z.literal(true),
    scope: scopeSchema,
    effective: z
      .object({
        email: effectiveChannelSchema.optional(),
        sms: nonEmailEffectiveChannelSchema.optional(),
        push: effectiveChannelSchema.omit({ frequency: true }).optional(),
        in_app: effectiveChannelSchema.omit({ frequency: true }).required(),
      })
      .strict(),
    persistedDelta: persistedDeltaSchema.optional(),
  })
  .strict();

export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesInputSchema
>;
export type UpdateNotificationPreferencesOutput = z.infer<
  typeof updateNotificationPreferencesOutputSchema
>;

export type UpdateNotificationPreferencesDeps = {
  repos: Repos;
  clock: ClockPort;
  idempotency: IdempotencyPort;
  logger?: LoggerPort;
  tokens?: NotificationPreferenceTokensPort;
};

interface StoredUpdateNotificationPreferencesRecord {
  payloadHash: string;
  response: UpdateNotificationPreferencesOutput;
}

interface ChannelEligibility {
  email: boolean;
  sms: boolean;
  push: boolean;
  in_app: boolean;
}

export async function updateNotificationPreferences(
  deps: UpdateNotificationPreferencesDeps,
  rawInput: unknown,
): Promise<UpdateNotificationPreferencesOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "updateNotificationPreferences",
  });

  const execute = async () => {
    const input = parseInput(
      updateNotificationPreferencesInputSchema,
      rawInput,
    );
    const now = deps.clock.now();

    const tokenPayload = await resolveTokenPayload(
      deps.tokens,
      input.token ?? null,
    );

    if (input.token && !tokenPayload) {
      throw fail("TOKEN_INVALID");
    }

    if (tokenPayload) {
      if (tokenPayload.expiresAt.getTime() <= now.getTime()) {
        throw fail("TOKEN_EXPIRED");
      }
      if (tokenPayload.humanId !== input.humanId) {
        throw fail("TOKEN_HUMAN_MISMATCH");
      }
      if (!scopesMatch(tokenPayload.scope, input.scope)) {
        throw fail("TOKEN_SCOPE_MISMATCH");
      }
    }

    if (!tokenPayload && input.actorHumanId !== input.humanId) {
      throw fail("ACTOR_MISMATCH");
    }

    const humanWithIdentity = await deps.repos.humans.getByIdWithIdentity(
      input.humanId,
    );
    if (!humanWithIdentity) {
      throw fail("HUMAN_NOT_FOUND");
    }
    const { identity } = humanWithIdentity;

    if (input.scope.kind === "ORG") {
      const org = await deps.repos.organizations.getById(input.scope.orgId);
      if (!org) {
        throw fail("ORGANIZATION_NOT_FOUND");
      }
    }

    if (input.scope.kind === "EVENT") {
      const event = await deps.repos.events.getById(input.scope.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }
    }

    const eligibility = await computeChannelEligibility(
      deps.repos,
      input.humanId,
      {
        emailVerified: identity.emailVerified,
        phoneVerified: identity.phoneVerified,
        hasEmail: Boolean(identity.email),
        hasPhone: Boolean(identity.phone),
      },
    );

    const combinedUpdates = mergeDeltas(
      tokenPayload
        ? {
            categories: tokenPayload.categories,
            channels: tokenPayload.channels,
          }
        : undefined,
      input.updates,
    );

    const sanitizedDelta = sanitizeDelta(combinedUpdates, eligibility);
    if (!sanitizedDelta) {
      throw fail("NO_UPDATES_PROVIDED");
    }

    const payloadForHash = {
      updates: sanitizedDelta,
      actorHumanId: input.actorHumanId ?? null,
      tokenId: tokenPayload?.tokenId ?? null,
    };

    const payloadHash = createHash("sha256")
      .update(JSON.stringify(payloadForHash))
      .digest("hex");
    const idempotencyKey = buildIdempotencyKey(
      input.humanId,
      input.scope,
      input.clientKey,
      payloadHash,
    );

    const replay =
      await deps.idempotency.get<StoredUpdateNotificationPreferencesRecord>(
        idempotencyKey,
      );
    if (replay) {
      ensurePayloadConsistency(replay.payloadHash, payloadHash);
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredUpdateNotificationPreferencesRecord>(
          idempotencyKey,
        );
      if (afterWait) {
        ensurePayloadConsistency(afterWait.payloadHash, payloadHash);
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      const result = await deps.repos.tx(async (tx) => {
        await tx.notificationPrefs.upsert({
          humanId: input.humanId,
          scope: input.scope,
          delta: sanitizedDelta,
        });

        const snapshot = await tx.notificationPrefs.readEffective({
          humanId: input.humanId,
          scope: input.scope,
        });

        const effective = applyEligibility(snapshot, eligibility);

        await tx.audit.log({
          entity: "human",
          entityId: input.humanId,
          action: "comms.notification_prefs.updated",
          data: {
            humanId: input.humanId,
            scope: input.scope,
            delta: sanitizedDelta,
            source: tokenPayload
              ? { kind: "token", tokenId: tokenPayload.tokenId }
              : { kind: "actor", actorHumanId: input.actorHumanId },
          },
          at: now,
        });

        return updateNotificationPreferencesOutputSchema.parse({
          ok: true,
          scope: input.scope,
          effective,
          persistedDelta: sanitizedDelta,
        });
      });

      await deps.idempotency.commit<StoredUpdateNotificationPreferencesRecord>(
        idempotencyKey,
        { payloadHash, response: result },
        IDEMPOTENCY_TTL_SECONDS,
      );

      scopedLogger?.info("updateNotificationPreferences.success", {
        humanId: input.humanId,
        scope: input.scope,
        viaToken: Boolean(tokenPayload),
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("update_notification_preferences", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateNotificationPreferences", execute);
  }

  return execute();
}

async function resolveTokenPayload(
  tokensPort: NotificationPreferenceTokensPort | undefined,
  token: string | null,
): Promise<NotificationPreferenceTokenPayload | null> {
  if (!token) return null;
  if (!tokensPort) {
    throw fail("TOKEN_NOT_SUPPORTED");
  }
  return tokensPort.validateUnsubscribeToken(token);
}

function scopesMatch(
  tokenScope: NotificationPreferenceTokenScope,
  inputScope: NotificationPreferenceScope,
): boolean {
  if (tokenScope.kind !== inputScope.kind) {
    return false;
  }

  if (tokenScope.kind === "ORG") {
    if (inputScope.kind !== "ORG") {
      return false;
    }
    return Boolean(tokenScope.orgId) && tokenScope.orgId === inputScope.orgId;
  }

  if (tokenScope.kind === "EVENT") {
    if (inputScope.kind !== "EVENT") {
      return false;
    }
    return (
      Boolean(tokenScope.eventId) && tokenScope.eventId === inputScope.eventId
    );
  }

  return true;
}

async function computeChannelEligibility(
  repos: Repos,
  humanId: string,
  flags: {
    emailVerified: boolean;
    phoneVerified: boolean;
    hasEmail: boolean;
    hasPhone: boolean;
  },
): Promise<ChannelEligibility> {
  const [pushDevices] = await Promise.all([
    repos.pushDevices.findActiveByHuman({ humanId }),
  ]);

  const pushEligible = pushDevices.some((device) => device.enabled);

  return {
    email: flags.emailVerified && flags.hasEmail,
    sms: flags.phoneVerified && flags.hasPhone,
    push: pushEligible,
    in_app: true,
  };
}

function mergeDeltas(
  base: NotificationPreferenceDelta | undefined,
  override: NotificationPreferenceDelta | undefined,
): NotificationPreferenceDelta | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: NotificationPreferenceDelta = {};

  if (base?.categories) {
    merged.categories = { ...base.categories };
  }
  if (override?.categories) {
    merged.categories = {
      ...(merged.categories ?? {}),
      ...override.categories,
    };
  }

  if (base?.channels || override?.channels) {
    const mergedChannels: NotificationPreferenceChannelsDelta = {};

    for (const channel of CHANNEL_KEYS) {
      const baseChannel = base?.channels?.[channel];
      const overrideChannel = override?.channels?.[channel];

      if (!baseChannel && !overrideChannel) {
        continue;
      }

      switch (channel) {
        case "email": {
          const combined: NotificationPreferenceEmailChannelDelta = {
            ...(baseChannel ?? {}),
            ...(overrideChannel ?? {}),
          };
          if (Object.keys(combined).length > 0) {
            mergedChannels.email = combined;
          }
          break;
        }
        case "sms": {
          const combined: NotificationPreferenceCategoryDelta = {
            ...(baseChannel ?? {}),
            ...(overrideChannel ?? {}),
          };
          if (Object.keys(combined).length > 0) {
            mergedChannels.sms = combined;
          }
          break;
        }
        case "push": {
          const combined: NotificationPreferenceCategoryDelta = {
            ...(baseChannel ?? {}),
            ...(overrideChannel ?? {}),
          };
          if (Object.keys(combined).length > 0) {
            mergedChannels.push = combined;
          }
          break;
        }
        case "in_app": {
          const combined: NotificationPreferenceCategoryDelta = {
            ...(baseChannel ?? {}),
            ...(overrideChannel ?? {}),
          };
          if (Object.keys(combined).length > 0) {
            mergedChannels.in_app = combined;
          }
          break;
        }
        default:
          break;
      }
    }

    if (Object.keys(mergedChannels).length > 0) {
      merged.channels = mergedChannels;
    }
  }

  return merged;
}

function sanitizeDelta(
  delta: NotificationPreferenceDelta | undefined,
  eligibility: ChannelEligibility,
): NotificationPreferenceDelta | undefined {
  if (!delta) {
    return undefined;
  }

  const sanitized: NotificationPreferenceDelta = {};

  if (delta.categories) {
    const cleaned = sanitizeCategories(delta.categories);
    if (cleaned) {
      sanitized.categories = cleaned;
    }
  }

  if (delta.channels) {
    const cleanedChannels = sanitizeChannels(delta.channels, eligibility);
    if (cleanedChannels) {
      sanitized.channels = cleanedChannels;
    }
  }

  if (!sanitized.categories && !sanitized.channels) {
    return undefined;
  }

  return sanitized;
}

function sanitizeCategories(
  categories: NotificationPreferenceDelta["categories"] | undefined,
) {
  if (!categories) return undefined;

  const result: Partial<Record<NotificationPreferenceCategory, boolean>> = {};

  for (const key of CATEGORY_KEYS) {
    const value = categories[key];
    if (value === undefined) continue;
    if (key === "transactional" && value === false) {
      throw fail("TRANSACTIONAL_CANNOT_BE_DISABLED");
    }
    result[key] = value;
  }

  return Object.keys(result).length ? result : undefined;
}

function sanitizeChannels(
  channels: NotificationPreferenceChannelsDelta,
  eligibility: ChannelEligibility,
) {
  const result: NotificationPreferenceChannelsDelta = {};

  if (channels.email) {
    if (!eligibility.email) {
      throw {
        code: "invalid_input",
        message: "channel_ineligible",
        channel: "email",
      } as const;
    }
    const sanitizedEmail = sanitizeEmailChannelUpdate(channels.email);
    if (sanitizedEmail) {
      result.email = sanitizedEmail;
    }
  }

  if (channels.sms) {
    if (!eligibility.sms) {
      throw {
        code: "invalid_input",
        message: "channel_ineligible",
        channel: "sms",
      } as const;
    }
    // Only transactional may be texted (categories.ts
    // `smsAllowed`); enabling any other category's SMS is refused.
    const ineligible = smsIneligibleEnables(channels.sms);
    if (ineligible.length > 0) {
      throw {
        code: "invalid_input",
        message: "sms_category_ineligible",
        channel: "sms",
        categories: ineligible,
      } as const;
    }
    // Any SMS write also clears stale opt-ins for never-texted categories.
    const sanitizedSms = sanitizeCategories(
      withSmsIneligibleCleared(channels.sms),
    );
    if (sanitizedSms) {
      result.sms = sanitizedSms;
    }
  }

  if (channels.push) {
    if (!eligibility.push) {
      throw {
        code: "invalid_input",
        message: "channel_ineligible",
        channel: "push",
      } as const;
    }
    const sanitizedPush = sanitizeCategories(channels.push);
    if (sanitizedPush) {
      result.push = sanitizedPush;
    }
  }

  if (channels.in_app) {
    if (!eligibility.in_app) {
      throw {
        code: "invalid_input",
        message: "channel_ineligible",
        channel: "in_app",
      } as const;
    }
    const sanitizedInApp = sanitizeCategories(channels.in_app);
    if (sanitizedInApp) {
      result.in_app = sanitizedInApp;
    }
  }

  return Object.keys(result).length ? result : undefined;
}

function sanitizeEmailChannelUpdate(
  updates: NotificationPreferenceEmailChannelDelta,
): NotificationPreferenceEmailChannelDelta | undefined {
  const base = sanitizeCategories(updates);
  const result: NotificationPreferenceEmailChannelDelta = {
    ...(base ?? {}),
  };

  if (updates.frequency !== undefined) {
    result.frequency = updates.frequency satisfies NotificationEmailFrequency;
  }

  return Object.keys(result).length ? result : undefined;
}

function applyEligibility(
  snapshot: NotificationPreferenceSnapshot,
  eligibility: ChannelEligibility,
): NotificationPreferenceSnapshot {
  const effective: NotificationPreferenceSnapshot = {};

  const inAppSnapshot = snapshot.in_app;
  if (!inAppSnapshot) {
    throw fail("MISSING_IN_APP_PREFERENCES");
  }
  effective.in_app = inAppSnapshot;

  if (eligibility.email && snapshot.email) {
    effective.email = snapshot.email;
  }
  if (eligibility.sms && snapshot.sms) {
    // A stored opt-in for a never-texted category reads as off.
    effective.sms = maskSmsIneligible(snapshot.sms);
  }
  if (eligibility.push && snapshot.push) {
    effective.push = snapshot.push;
  }

  return effective;
}

function ensurePayloadConsistency(
  existingHash: string,
  nextHash: string,
): void {
  if (existingHash !== nextHash) {
    throw fail("IDEMPOTENCY_KEY_CONFLICT");
  }
}

function buildIdempotencyKey(
  humanId: string,
  scope: NotificationPreferenceScope,
  clientKey: string | undefined,
  payloadHash: string,
): string {
  const scopeFragment =
    scope.kind === "GLOBAL"
      ? "GLOBAL"
      : scope.kind === "ORG"
        ? `ORG:${scope.orgId}`
        : `EVENT:${scope.eventId}`;

  const salt = clientKey ?? payloadHash;

  return `prefs:${humanId}:${scopeFragment}:${salt}`;
}
