import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { Webhook } from "svix";

import type {
  EmailDeliverabilityPort,
  EmailDeliveryStatus,
  RecordEmailDeliveryProviderEventInput,
} from "@th/ports/comms/email-deliverability";
import type { LoggerPort } from "@th/ports/logger";

import { markBookingInquirerUndeliverable } from "@th/core/use-cases/booking-requests";
import { recordInviteComplaint } from "@th/core/use-cases/events/invites/invite-complaint-pause";

import { env } from "../../lib/env";
import { resolveWebhookAppCode } from "../../lib/webhook-app-code";

const PROVIDER = "resend";
const SUPPORTED_EVENT_TYPES = new Set(["email.bounced", "email.complained"]);

export type ParsedResendDeliveryEvent = Omit<
  RecordEmailDeliveryProviderEventInput,
  "provider"
> & {
  /**
   * The sent mail's metadata, read back from Resend's `meta_<key>` tags
   * (the mailer's mapping, reversed). Present only when the payload carried
   * any. Used by the invite-complaint fan-in only; never passed to
   * `recordProviderEvent`.
   */
  metadata?: Record<string, string>;
};

export type ResendWebhookHandleResult = {
  recorded: number;
  replayed: number;
  ignored: boolean;
  eventType: string | null;
  /**
   * Booking inquiries stamped undeliverable by this payload
   * (booking-inquirer-outreach). Absent when no fan-in was wired.
   */
  bookingInquiriesStamped?: number;
  /**
   * Complaints recorded against an invite organiser by this payload (invite
   * complaint auto-pause). Absent when no fan-in was wired.
   */
  inviteComplaintsRecorded?: number;
};

/**
 * Invite-complaint fan-in (invite complaint auto-pause, W4): a complaint on
 * a personal invite email counts against its organiser and can pause their
 * invites. Wraps core `recordInviteComplaint`, which ignores mail without
 * invite metadata and answers problems a retry can't fix (bad tag, owner
 * gone, constraint errors) with a result. A TRANSIENT failure (DB down)
 * throws on purpose: the route's catch answers 500 and Svix retries on its
 * backoff schedule, then gives up. Safe to retry and to replay: the
 * complaint write is unique on `providerEventId`.
 */
export type RecordInviteComplaintFn = (input: {
  providerEventId: string;
  email: string;
  occurredAt: Date;
  metadata: Record<string, string> | null;
}) => Promise<{ outcome: string }>;

/**
 * Booking-inquiry fan-in for a bounce/complaint.
 *
 * Separate from `EmailDeliverabilityPort` on purpose: that port keys
 * deliverability to an `AuthUser` and DELIBERATELY refuses to flag unverified
 * accounts, and every shadow minted for an anonymous booking inquirer is
 * unverified by construction — so a venue's bounced reply would otherwise
 * leave no trace on the inquiry itself. Optional so tests and any composition
 * root without the booking repos keep working unchanged.
 *
 * MUST NOT THROW (the core use case it wraps already swallows): a failure here
 * would turn a successfully-ingested delivery event into a 500 that Svix
 * keeps retrying on its backoff schedule until it gives up.
 */
export type MarkBookingInquirerUndeliverableFn = (input: {
  email: string;
  status: "BOUNCED" | "COMPLAINED";
  occurredAt: Date;
}) => Promise<{ stamped: number }>;

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

  const metadata = extractMetadata(data);

  return emails.map((email, index) => ({
    providerEventId:
      emails.length === 1 ? providerEventId : `${providerEventId}:${index}`,
    eventType,
    email,
    status,
    occurredAt,
    payload,
    ...(metadata ? { metadata } : {}),
  }));
}

export async function handleResendWebhookPayload(input: {
  payload: unknown;
  webhookEventId?: string;
  deliverability: EmailDeliverabilityPort;
  logger: LoggerPort;
  markBookingInquirerUndeliverable?: MarkBookingInquirerUndeliverableFn;
  recordInviteComplaint?: RecordInviteComplaintFn;
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
  let bookingInquiriesStamped = 0;
  let inviteComplaintsRecorded = 0;
  for (const event of events) {
    const { metadata, ...deliveryEvent } = event;
    const record = await input.deliverability.recordProviderEvent({
      ...deliveryEvent,
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

    // Booking-inquiry fan-in. Runs on REPLAYS too: the underlying write is an
    // idempotent, monotonic stamp, and skipping replays would lose the fan-in
    // entirely if it was wired after the first delivery of an event.
    // DELIVERABLE never reaches here (`parseResendDeliveryEvents` only emits
    // the two suppressing statuses), but the narrowing keeps that honest.
    if (
      input.markBookingInquirerUndeliverable &&
      (event.status === "BOUNCED" || event.status === "COMPLAINED")
    ) {
      const { stamped } = await input.markBookingInquirerUndeliverable({
        email: event.email,
        status: event.status,
        occurredAt: event.occurredAt,
      });
      bookingInquiriesStamped += stamped;
    }

    // Invite-complaint fan-in. Complaints only; core ignores non-invite
    // mail. NOT caught here: a transient failure must reach the route's
    // catch (500) so Svix retries. Everything above is idempotent on retry.
    if (input.recordInviteComplaint && event.status === "COMPLAINED") {
      const { outcome } = await input.recordInviteComplaint({
        providerEventId: event.providerEventId,
        email: event.email,
        occurredAt: event.occurredAt,
        metadata: metadata ?? null,
      });
      if (outcome === "RECORDED") inviteComplaintsRecorded += 1;
    }
  }

  return {
    recorded: events.length,
    replayed,
    ignored: false,
    eventType,
    ...(input.markBookingInquirerUndeliverable ? { bookingInquiriesStamped } : {}),
    ...(input.recordInviteComplaint ? { inviteComplaintsRecorded } : {}),
  };
}

const plugin: FastifyPluginAsync = async (app) => {
  const logger = app.deps.logger.child({ route: "webhooks/resend" });

  // Resolved ONCE, at registration, and deliberately tolerant of a deps bag
  // without the tRPC repos: this plugin is also mounted by narrow harnesses
  // that decorate only `{ logger, emailDeliverability }`, and a bounce webhook
  // must never 500 because an OPTIONAL fan-in had nowhere to write. Absent
  // repos = no booking-inquiry stamping, everything else unchanged.
  const bookingRepos = app.deps.trpc?.repos;
  const markInquirerUndeliverable: MarkBookingInquirerUndeliverableFn | undefined =
    bookingRepos
      ? (bounce) =>
          markBookingInquirerUndeliverable(
            {
              repos: bookingRepos,
              logger,
              reportError: app.deps.trpc?.reportError ?? undefined,
            },
            bounce,
          )
      : undefined;

  // Invite-complaint fan-in, same tolerance: no repos = not wired.
  const trpcDeps = app.deps.trpc;
  const recordInviteComplaintFn: RecordInviteComplaintFn | undefined =
    trpcDeps?.repos
      ? (complaint) =>
          recordInviteComplaint(
            {
              repos: trpcDeps.repos,
              clock: trpcDeps.clock ?? { now: () => new Date() },
              inviteOptOutSecret: trpcDeps.inviteOptOutSecret ?? null,
              logger,
              reportError: trpcDeps.reportError ?? undefined,
            },
            complaint,
          )
      : undefined;

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
        markBookingInquirerUndeliverable: markInquirerUndeliverable,
        recordInviteComplaint: recordInviteComplaintFn,
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

const MAX_METADATA_ENTRIES = 20;
const MAX_METADATA_VALUE_LENGTH = 256;
const METADATA_TAG_PREFIX = "meta_";

/**
 * The mail's metadata from its tags: Resend echoes `data.tags` as an object
 * map (`{ "meta_inviteOwner": "org-…" }`); an array of `{ name, value }` is
 * accepted too. Only `meta_*` string tags, prefix stripped, bounded. Null
 * when there are none.
 */
const extractMetadata = (
  data: Record<string, unknown>,
): Record<string, string> | null => {
  const raw = data.tags;
  const pairs: Array<[unknown, unknown]> = Array.isArray(raw)
    ? raw.map((tag) => {
        const record = asRecord(tag);
        return [record.name, record.value];
      })
    : Object.entries(asRecord(raw));
  // No prototype: a `meta___proto__` tag must stay a plain key.
  const metadata: Record<string, string> = Object.create(null);
  let count = 0;
  for (const [name, value] of pairs) {
    if (count >= MAX_METADATA_ENTRIES) break;
    if (typeof name !== "string" || typeof value !== "string") continue;
    if (!name.startsWith(METADATA_TAG_PREFIX)) continue;
    const key = name.slice(METADATA_TAG_PREFIX.length);
    if (!key || value.length > MAX_METADATA_VALUE_LENGTH) continue;
    metadata[key] = value;
    count += 1;
  }
  return count > 0 ? metadata : null;
};

const parseDate = (value: string | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const firstHeader = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? "") : (value ?? "");

export default fp(plugin as unknown as never) as unknown as never;
