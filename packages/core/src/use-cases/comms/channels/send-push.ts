import { z } from "zod";

import type { PushPort } from "@th/ports/comms/push";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { describeError } from "../../../lib/io";
import { notificationCategorySchema } from "../categories";
import {
  buildTags,
  normalizeTemplateRef,
  pushResultSchema,
  sanitizeMetadata,
  scopeKey,
  scopeSchema,
  type PushResult,
} from "../shared";
import type { PushChannelPayload } from "../renderers";

export type SendPushDeps = {
  repos: Repos;
  push?: PushPort;
  logger?: LoggerPort;
};

export const sendPushInputSchema = z
  .object({
    humanId: z.string().uuid(),
    variant: z.string().min(1),
    category: notificationCategorySchema,
    scope: scopeSchema,
    payload: z.custom<PushChannelPayload | undefined>(),
    enabled: z.boolean(),
    notificationId: z.string().optional(),
  })
  .strict();

export type SendPushInput = z.infer<typeof sendPushInputSchema>;

export async function sendPush(
  deps: SendPushDeps,
  rawInput: SendPushInput,
): Promise<PushResult> {
  const input = sendPushInputSchema.parse(rawInput);

  if (!input.enabled) {
    return { status: "skipped", reason: "channel_disabled" } as const;
  }

  if (!input.payload) {
    return { status: "skipped", reason: "renderer_omitted" } as const;
  }

  if (!deps.push) {
    return { status: "skipped", reason: "port_unavailable" } as const;
  }

  const devices = await deps.repos.pushDevices.findActiveByHuman({
    humanId: input.humanId,
  });
  const enabledDevices = devices.filter((device) => device.enabled);

  if (enabledDevices.length === 0) {
    return { status: "skipped", reason: "no_devices" } as const;
  }

  const tags = buildTags(input.payload.tags, input.category, input.variant);
  const metadata = sanitizeMetadata({
    ...input.payload.metadata,
    variant: input.variant,
    category: input.category,
    scope: scopeKey(input.scope),
    ...(input.notificationId ? { notificationId: input.notificationId } : {}),
  });

  const template = normalizeTemplateRef(input.payload.template);

  try {
    const sendOutput = await deps.push.send({
      deviceIds: enabledDevices.map((device) => device.id),
      humanId: input.humanId,
      title: input.payload.title ?? undefined,
      body: input.payload.body,
      collapseKey: input.payload.collapseKey ?? undefined,
      data: input.payload.data ?? undefined,
      metadata,
      template,
    });

    return pushResultSchema.parse({
      status: "sent",
      deviceCount: enabledDevices.length,
      vendorMessageId: sendOutput.id ?? undefined,
    });
  } catch (error) {
    deps.logger?.error("comms.push.port_error", {
      error: describeError(error),
    });
    return pushResultSchema.parse({
      status: "failed",
      deviceCount: enabledDevices.length,
      reason: "port_error",
    });
  }
}
