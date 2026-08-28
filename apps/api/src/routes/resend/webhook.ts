import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { Webhook } from "svix";

import type {
  EmailDeliverabilityPort,
  EmailDeliveryStatus,
  RecordEmailDeliveryProviderEventInput,
} from "@th/ports/comms/email-deliverability";
import type { LoggerPort } from "@th/ports/logger";

import { env } from "../../lib/env";
import { resolveWebhookAppCode } from "../../lib/webhook-app-code";

const PROVIDER = "resend";
const SUPPORTED_EVENT_TYPES = new Set(["email.bounced", "email.complained"]);

export type ParsedResendDeliveryEvent = Omit<
  RecordEmailDeliveryProviderEventInput,
  "provider"
>;

export type ResendWebhookHandleResult = {
  recorded: number;
  replayed: number;
  ignored: boolean;
  eventType: string | null;
};

export type ParseResendDeliveryEventsOptions = {
  now?: Date;
  webhookEventId?: string;
};

export function parseResendDeliveryEvents(
  payload: unknown,
  options: Date | ParseResendDeliveryEventsOptions = {},
): ParsedResendDeliveryEvent[] {
  const now = options instanceof Date ? options : (options.now ?? new Date());
  const webhookEventId =
    options instanceof Date ? undefined : options.webhookEventId;
  const event = asRecord(payload);
  const eventType = getString(event, "type");
  if (!eventType || !SUPPORTED_EVENT_TYPES.has(eventType)) {
    return [];
  }

  const data = asRecord(event.data);
  const providerEventId =
    getString(event, "id") ?? getString(data, "event_id") ?? webhookEventId;
  if (!providerEventId) {
    return [];
  }

  const status = resolveDeliveryStatus(eventType, data);
  const emails = extractEmails(event, data);
  if (emails.length === 0) {
    return [];
  }

  const occurredAt =
    parseDate(
      getString(event, "created_at") ??
        getString(event, "createdAt") ??
        getString(data, "created_at") ??
        getString(data, "createdAt") ??
        getString(data, "timestamp"),
    ) ?? now;

  return emails.map((email, index) => ({
    providerEventId:
      emails.length === 1 ? providerEventId : `${providerEventId}:${index}`,
    eventType,
    email,
    status,
    occurredAt,
    payload,
  }));
}

export async function handleResendWebhookPayload(input: {
  payload: unknown;
  webhookEventId?: string;
  deliverability: EmailDeliverabilityPort;
  logger: LoggerPort;
}): Promise<ResendWebhookHandleResult> {
  const eventType = getString(asRecord(input.payload), "type") ?? null;
  const events = parseResendDeliveryEvents(input.payload, {
    webhookEventId: input.webhookEventId,
  });

  if (events.length === 0) {
    input.logger.info("resend_webhook_ignored", { eventType });
    return { recorded: 0, replayed: 0, ignored: true, eventType };
  }

  let replayed = 0;
  for (const event of events) {
    const record = await input.deliverability.recordProviderEvent({
      ...event,
      provider: PROVIDER,
    });
    if (record.replayed) {
      replayed += 1;
    }
    input.logger.info("resend_webhook_recorded", {
      eventType: event.eventType,
      providerEventId: event.providerEventId,
      status: event.status,
      authUserId: record.authUserId,
      replayed: record.replayed,
    });
  }

  return {
    recorded: events.length,
    replayed,
    ignored: false,
    eventType,
  };
}

const plugin: FastifyPluginAsync = async (app) => {
  const logger = app.deps.logger.child({ route: "webhooks/resend" });

  app.post("/webhooks/resend", async (request, reply) => {
    if (!env.RESEND_WEBHOOK_SECRET) {
      logger.warn("resend_webhook_unconfigured", {
        hasWebhookSecret: false,
      });
      return reply.status(503).send({ ok: false, error: "not_configured" });
    }

    if (!Buffer.isBuffer(request.body)) {
      logger.warn("resend_webhook_missing_raw_body", {
        bodyType: typeof request.body,
      });
      return reply.status(400).send({ ok: false, error: "missing_raw_body" });
    }

    let payload: unknown;
    const svixId = firstHeader(request.headers["svix-id"]);
    const svixTimestamp = firstHeader(request.headers["svix-timestamp"]);
    const svixSignature = firstHeader(request.headers["svix-signature"]);
    try {
      payload = new Webhook(env.RESEND_WEBHOOK_SECRET).verify(request.body, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      });
    } catch (error) {
      logger.warn("resend_webhook_bad_signature", {
        error: error instanceof Error ? error.message : String(error),
      });
      return reply.status(400).send({ ok: false, error: "bad_signature" });
    }

    try {
      await handleResendWebhookPayload({
        payload,
        webhookEventId: svixId,
        deliverability: app.deps.emailDeliverability,
        logger,
      });
    } catch (error) {
      // Stamp the canonical AppErrorCode (FR-011) so an internal processing
      // failure is grepable by the same code the rest of the stack uses, then
      // re-throw UNCHANGED. Re-throwing preserves Fastify's default 500 so the
      // provider (Svix/Resend) keeps its retry semantics — the wire response is
      // identical to before this handler logged anything.
      logger.error("resend_webhook_processing_failed", {
        error: error instanceof Error ? error.message : String(error),
        appCode: resolveWebhookAppCode(error) ?? undefined,
        svixId: svixId || undefined,
      });
      throw error;
    }

    return reply.send({ ok: true });
  });
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const getString = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const item = value[key];
  return typeof item === "string" && item.trim().length > 0
    ? item.trim()
    : undefined;
};

const resolveDeliveryStatus = (
  eventType: string,
  data: Record<string, unknown>,
): EmailDeliveryStatus => {
  if (eventType === "email.complained") return "COMPLAINED";

  const bounce = asRecord(data.bounce);
  const bounceType = getString(bounce, "type")?.toLowerCase();
  return bounceType === "temporary" ? "DELIVERABLE" : "BOUNCED";
};

const extractEmails = (
  event: Record<string, unknown>,
  data: Record<string, unknown>,
): string[] => {
  const found = [
    ...collectEmails(data.to),
    ...collectEmails(data.email),
    ...collectEmails(event.to),
    ...collectEmails(event.email),
  ];
  return Array.from(new Set(found.map((email) => email.toLowerCase())));
};

const collectEmails = (value: unknown): string[] => {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectEmails(item));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = asRecord(value);
  const nested = record.email ?? record.to;
  return nested === undefined ? [] : collectEmails(nested);
};

const parseDate = (value: string | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const firstHeader = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export default fp(plugin as unknown as never) as unknown as never;
