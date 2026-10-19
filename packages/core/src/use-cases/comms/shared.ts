import { z } from "zod";

import {
  templateRefSchema,
  type TemplateRef as PortTemplateRef,
} from "@th/ports/comms/schemas";
import type {
  NotificationPreferenceScope,
  NotificationPreferenceSnapshot,
} from "@th/ports/repos/notification-preferences";

import {
  notificationCategorySchema,
  type NotificationCategory,
} from "./categories";
import {
  sanitizeMetadata as baseSanitizeMetadata,
  buildTags as baseBuildTags,
  scopeKey as baseScopeKey,
} from "./channel-utils";

export const scopeSchema = z.discriminatedUnion("kind", [
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

export type NotificationScope = z.infer<typeof scopeSchema>;

export const inAppResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("persisted"),
      notificationId: z.string(),
      createdAt: z.date(),
    })
    .strict(),
  z
    .object({
      status: z.literal("skipped"),
      reason: z.enum([
        "channel_disabled",
        "renderer_omitted",
        "port_unavailable",
      ]),
    })
    .strict(),
]);

export type InAppResult = z.infer<typeof inAppResultSchema>;

export const pushResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("skipped"),
      reason: z.enum([
        "renderer_omitted",
        "channel_disabled",
        "no_devices",
        "port_unavailable",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("sent"),
      deviceCount: z.number().int().nonnegative(),
      vendorMessageId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      deviceCount: z.number().int().nonnegative(),
      reason: z.literal("port_error"),
    })
    .strict(),
]);

export type PushResult = z.infer<typeof pushResultSchema>;

export const emailResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("skipped"),
      reason: z.enum([
        "renderer_omitted",
        "channel_disabled",
        "port_unavailable",
        "no_recipient",
        "unverified",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("sent"),
      vendorMessageId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.literal("port_error"),
    })
    .strict(),
]);

export type EmailResult = z.infer<typeof emailResultSchema>;

export const smsResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("skipped"),
      reason: z.enum([
        "renderer_omitted",
        "channel_disabled",
        "port_unavailable",
        "no_recipient",
        "unverified",
        // Consent gate (FR-011): the phone's SMS consent ledger says OPTED_OUT.
        "opted_out",
        // Consent gate fail-closed: the ledger lookup errored, so we refuse to send.
        "consent_unavailable",
        // The category is never sent by SMS (categories.ts `smsAllowed`).
        "category_not_sms_eligible",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("sent"),
      vendorMessageId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.literal("port_error"),
    })
    .strict(),
]);

export type SmsResult = z.infer<typeof smsResultSchema>;

export const sanitizeMetadata = baseSanitizeMetadata;
export const buildTags = baseBuildTags;
export const scopeKey = baseScopeKey;

export type ChannelTemplateRef = {
  key: string;
  version?: string | null;
  variables?: Record<string, unknown> | null;
} | null;

export function normalizeTemplateRef(
  template: ChannelTemplateRef,
): PortTemplateRef | undefined {
  if (!template) return undefined;

  const normalized: Record<string, unknown> = {
    key: template.key,
  };

  if (
    typeof template.version === "string" &&
    template.version.trim().length > 0
  ) {
    normalized.version = template.version;
  }

  if (template.variables && typeof template.variables === "object") {
    normalized.variables = template.variables;
  }

  return templateRefSchema.parse(normalized);
}

export function isChannelEnabled(
  snapshot: NotificationPreferenceSnapshot,
  channel: "in_app" | "push" | "email" | "sms",
  category: NotificationCategory,
  defaultValue: boolean,
): boolean {
  const channelSnapshot = snapshot[channel];
  if (!channelSnapshot) {
    return defaultValue;
  }
  const value = channelSnapshot[category];
  return typeof value === "boolean" ? value : defaultValue;
}
