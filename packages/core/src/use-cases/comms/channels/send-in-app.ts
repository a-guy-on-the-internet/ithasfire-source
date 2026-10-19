import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { notificationCategorySchema } from "../categories";
import {
  buildTags,
  inAppResultSchema,
  normalizeTemplateRef,
  sanitizeMetadata,
  scopeKey,
  scopeSchema,
  type InAppResult,
} from "../shared";
import type { InAppChannelPayload } from "../renderers";
import { fail } from "@th/errors";

export type SendInAppDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export const sendInAppInputSchema = z
  .object({
    humanId: z.string().uuid(),
    variant: z.string().min(1),
    category: notificationCategorySchema,
    scope: scopeSchema,
    payload: z.custom<InAppChannelPayload | undefined>(),
    enabled: z.boolean(),
    idempotencyKey: z.string().min(1).optional(),
    now: z.date(),
  })
  .strict();

export type SendInAppInput = z.infer<typeof sendInAppInputSchema>;

export async function sendInApp(
  deps: SendInAppDeps,
  rawInput: SendInAppInput,
): Promise<InAppResult> {
  const input = sendInAppInputSchema.parse(rawInput);

  if (!input.enabled) {
    return { status: "skipped", reason: "channel_disabled" } as const;
  }

  if (!input.payload) {
    return { status: "skipped", reason: "renderer_omitted" } as const;
  }

  const payload = input.payload;
  const template = normalizeTemplateRef(payload.template);

  const tags = buildTags(payload.tags, input.category, input.variant);
  const metadata = sanitizeMetadata({
    ...payload.metadata,
    variant: input.variant,
    category: input.category,
    scope: scopeKey(input.scope),
  });

  const result = await deps.repos.tx(async (tx) => {
    if (!tx.notifications) {
      throw fail("NOTIFICATIONS_REPO_UNAVAILABLE");
    }

    const created = await tx.notifications.create({
      humanId: input.humanId,
      title: payload.title ?? undefined,
      body: payload.body,
      kind: payload.kind,
      metadata,
      tags,
      expiresAt: payload.expiresAt ?? undefined,
      action: payload.action ?? null,
      template,
    });

    await tx.audit.log({
      entity: "human",
      entityId: input.humanId,
      action: "comms.in_app.sent",
      data: {
        variant: input.variant,
        category: input.category,
        scope: input.scope,
        notificationId: created.id,
      },
      at: input.now,
    });

    return {
      status: "persisted",
      notificationId: created.id,
      createdAt: created.createdAt,
    } satisfies InAppResult;
  });

  return inAppResultSchema.parse(result);
}
