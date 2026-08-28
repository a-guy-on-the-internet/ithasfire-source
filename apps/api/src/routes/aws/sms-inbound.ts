import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { recordSmsOptOut } from "@th/core/use-cases/comms/record-sms-opt-out";
import { recordSmsOptIn } from "@th/core/use-cases/comms/record-sms-opt-in";
import { isAppError } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { env } from "../../lib/env";
import { resolveWebhookAppCode } from "../../lib/webhook-app-code";
import {
  assertAmazonSnsUrl,
  defaultFetchCertPem,
  snsEnvelopeSchema,
  verifySnsSignature,
  type FetchCertPem,
} from "./sns-verify";

/**
 * AWS SNS two-way SMS inbound webhook (sms-opt-out-sns spec FR-004).
 *
 * SNS POSTs the standard envelope; the nested `Message` is the two-way SMS
 * JSON payload (originationNumber, messageKeyword, messageBody,
 * inboundMessageId, ...). STOP-family keywords are folded into the app-owned
 * SMS consent ledger via recordSmsOptOut; START-family re-consent signals go
 * through recordSmsOptIn (provider opt-in signal, FR-003). While AWS-managed
 * opt-outs stay enabled the reserved keywords may never arrive here — that's
 * fine, this endpoint is the reconciliation path for whichever mode is live.
 */

const SOURCE = "sns_inbound";

/** Max acceptable |now - envelope.Timestamp| (replay/skew bound). */
const TIMESTAMP_MAX_SKEW_MS = 60 * 60 * 1000;

/** Nested two-way SMS payload shape (AWS End User Messaging SMS). */
const twoWaySmsMessageSchema = z
  .object({
    originationNumber: z.string().min(1),
    destinationNumber: z.string().optional(),
    messageKeyword: z.string().optional(),
    messageBody: z.string().optional(),
    inboundMessageId: z.string().optional(),
    previousPublishedMessageId: z.string().optional(),
  })
  .loose();

export type TwoWaySmsMessage = z.infer<typeof twoWaySmsMessageSchema>;

/** STOP-family reserved keywords (carrier + AWS supported set). */
const STOP_KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "OPTOUT",
  "OPT-OUT",
  "OPT OUT",
  "REMOVE",
  "REVOKE",
  "ARRET",
  "TD",
]);

/** START-family re-consent keywords. */
const START_KEYWORDS = new Set([
  "START",
  "UNSTOP",
  "YES",
  "OPTIN",
  "OPT-IN",
  "OPT IN",
]);

export type InboundKeywordClassification = {
  kind: "opt_out" | "opt_in" | "other";
  keyword: string | null;
};

const normalizeToken = (raw: string): string =>
  raw.replace(/[.,!?;:]+$/, "").toUpperCase();

const classifyCandidate = (
  candidate: string,
): InboundKeywordClassification["kind"] | null => {
  if (STOP_KEYWORDS.has(candidate)) return "opt_out";
  if (START_KEYWORDS.has(candidate)) return "opt_in";
  return null;
};

/**
 * Classify the inbound reply.
 *
 * 1. AWS's `messageKeyword` (the provider's authoritative matched-keyword
 *    echo) wins when it itself classifies as STOP/START-family — it covers
 *    bodies like "Please stop" that token parsing misses.
 * 2. Otherwise fall back to the body: the first token, then the first TWO
 *    tokens joined (two-word forms like "OPT OUT"), trailing punctuation
 *    stripped, case-insensitive.
 */
export function classifyInboundKeyword(
  message: TwoWaySmsMessage,
): InboundKeywordClassification {
  const providerKeyword = normalizeToken((message.messageKeyword ?? "").trim());
  if (providerKeyword) {
    const kind = classifyCandidate(providerKeyword);
    if (kind) return { kind, keyword: providerKeyword };
  }

  const tokens = (message.messageBody ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(normalizeToken)
    .filter((token) => token.length > 0);

  const candidates: string[] = [];
  if (tokens[0]) candidates.push(tokens[0]);
  if (tokens.length === 2) candidates.push(tokens.join(" "));

  for (const candidate of candidates) {
    const kind = classifyCandidate(candidate);
    if (kind) return { kind, keyword: candidate };
  }

  const fallback = candidates[0] ?? (providerKeyword || null);
  return { kind: "other", keyword: fallback };
}

export type SmsInboundHandleResult =
  | { action: "opted_out"; phoneE164: string }
  | { action: "opted_in"; phoneE164: string }
  | { action: "ignored"; reason: string };

export type SmsInboundDeps = {
  repos: Repos;
  clock: ClockPort;
  logger: LoggerPort;
};

/**
 * Process one verified SNS Notification's nested two-way SMS message.
 * Permanent problems (malformed JSON, non-E.164 phone, non-keyword chatter)
 * are acked as "ignored" so SNS stops retrying; transient failures (DB down)
 * are rethrown so the caller 500s and SNS redelivers.
 */
export async function handleSmsInboundNotification(
  deps: SmsInboundDeps,
  rawMessage: string,
): Promise<SmsInboundHandleResult> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawMessage);
  } catch {
    deps.logger.warn("sns_sms_inbound_malformed_message", {});
    return { action: "ignored", reason: "malformed_message" };
  }

  const parsed = twoWaySmsMessageSchema.safeParse(parsedJson);
  if (!parsed.success) {
    deps.logger.warn("sns_sms_inbound_unrecognized_message_shape", {});
    return { action: "ignored", reason: "unrecognized_message_shape" };
  }
  const message = parsed.data;

  const classification = classifyInboundKeyword(message);
  if (classification.kind === "other") {
    deps.logger.info("sns_sms_inbound_ignored_keyword", {
      keyword: classification.keyword,
    });
    return { action: "ignored", reason: "unhandled_keyword" };
  }

  try {
    if (classification.kind === "opt_out") {
      const result = await recordSmsOptOut(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          phoneNumber: message.originationNumber,
          source: SOURCE,
          ...(classification.keyword
            ? { keyword: classification.keyword }
            : {}),
          ...(message.inboundMessageId
            ? { providerMessageId: message.inboundMessageId }
            : {}),
        },
      );
      return { action: "opted_out", phoneE164: result.phoneE164 };
    }

    const result = await recordSmsOptIn(
      { repos: deps.repos, clock: deps.clock, logger: deps.logger },
      {
        phoneNumber: message.originationNumber,
        source: SOURCE,
      },
    );
    return { action: "opted_in", phoneE164: result.phoneE164 };
  } catch (error) {
    // A phone AWS relayed that we cannot normalize will never succeed on
    // retry — ack it (logged) instead of making SNS redeliver forever.
    if (isAppError(error) && error.code === "PHONE_FORMAT_INVALID") {
      deps.logger.warn("sns_sms_inbound_invalid_phone", {});
      return { action: "ignored", reason: "invalid_phone" };
    }
    throw error;
  }
}

export type SmsInboundRouteOptions = {
  /** Test seam: overrides the HTTPS cert fetch for signature verification. */
  fetchCertPem?: FetchCertPem;
  /**
   * Test seam: overrides the SubscribeURL confirmation GET. The URL has
   * already passed assertAmazonSnsUrl when this is called.
   */
  confirmSubscription?: (subscribeUrl: string) => Promise<void>;
};

const defaultConfirmSubscription = async (
  subscribeUrl: string,
): Promise<void> => {
  const response = await fetch(subscribeUrl);
  if (!response.ok) {
    throw new Error(`sns_subscribe_confirm_failed_${response.status}`);
  }
};

const plugin: FastifyPluginAsync<SmsInboundRouteOptions> = async (
  app,
  opts,
) => {
  const logger = app.deps.logger.child({ route: "webhooks/aws/sms-inbound" });
  const fetchCertPem = opts.fetchCertPem ?? defaultFetchCertPem;
  const confirmSubscription =
    opts.confirmSubscription ?? defaultConfirmSubscription;

  app.post("/webhooks/aws/sms-inbound", async (request, reply) => {
    const allowedTopicArn = env.AWS_SNS_SMS_INBOUND_TOPIC_ARN;
    if (!allowedTopicArn) {
      logger.warn("sns_sms_inbound_unconfigured", {
        hasTopicArn: false,
      });
      return reply.status(503).send({ ok: false, error: "not_configured" });
    }

    // SNS posts text/plain — Fastify's built-in text parser yields a string;
    // other content types hit the raw-body catch-all and arrive as a Buffer.
    // Either is fine: the SNS signature covers envelope FIELDS, not raw
    // bytes, so no byte-exact body is needed for verification.
    const envelopeText = Buffer.isBuffer(request.body)
      ? request.body.toString("utf8")
      : typeof request.body === "string"
        ? request.body
        : null;
    if (envelopeText === null) {
      logger.warn("sns_sms_inbound_missing_raw_body", {
        bodyType: typeof request.body,
      });
      return reply.status(400).send({ ok: false, error: "missing_raw_body" });
    }

    let envelopeJson: unknown;
    try {
      envelopeJson = JSON.parse(envelopeText);
    } catch {
      logger.warn("sns_sms_inbound_malformed_envelope", {});
      return reply.status(400).send({ ok: false, error: "bad_envelope" });
    }

    const envelopeParsed = snsEnvelopeSchema.safeParse(envelopeJson);
    if (!envelopeParsed.success) {
      logger.warn("sns_sms_inbound_bad_envelope", {});
      return reply.status(400).send({ ok: false, error: "bad_envelope" });
    }
    const envelope = envelopeParsed.data;

    // Topic allow-list BEFORE any cert fetch (NFR-002): a payload for a
    // topic we never subscribed to is rejected outright.
    if (envelope.TopicArn !== allowedTopicArn) {
      logger.warn("sns_sms_inbound_topic_not_allowed", {
        topicArn: envelope.TopicArn,
      });
      return reply.status(403).send({ ok: false, error: "topic_not_allowed" });
    }

    // Replay bound: `Timestamp` is signature-covered, so a validly-signed
    // envelope this far outside the window is a replay (or hopeless queue
    // lag). ±1h tolerates clock skew and SNS retry backoff. Checked before
    // the signature so stale replays never cost a cert fetch.
    const timestampMs = Date.parse(envelope.Timestamp);
    const nowMs = app.deps.trpc.clock.now().getTime();
    if (
      Number.isNaN(timestampMs) ||
      Math.abs(nowMs - timestampMs) > TIMESTAMP_MAX_SKEW_MS
    ) {
      logger.warn("sns_sms_inbound_stale_timestamp", {
        timestamp: envelope.Timestamp,
      });
      return reply.status(400).send({ ok: false, error: "stale_timestamp" });
    }

    let signatureValid = false;
    try {
      signatureValid = await verifySnsSignature(envelope, fetchCertPem);
    } catch (error) {
      logger.warn("sns_sms_inbound_signature_check_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return reply.status(400).send({ ok: false, error: "bad_signature" });
    }
    if (!signatureValid) {
      logger.warn("sns_sms_inbound_bad_signature", {
        messageId: envelope.MessageId,
      });
      return reply.status(400).send({ ok: false, error: "bad_signature" });
    }

    if (envelope.Type === "SubscriptionConfirmation") {
      if (!envelope.SubscribeURL) {
        logger.warn("sns_sms_inbound_missing_subscribe_url", {});
        return reply.status(400).send({ ok: false, error: "bad_envelope" });
      }
      try {
        assertAmazonSnsUrl(envelope.SubscribeURL);
        await confirmSubscription(envelope.SubscribeURL);
      } catch (error) {
        logger.error("sns_sms_inbound_subscription_confirm_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Non-2xx makes SNS retry the confirmation delivery.
        throw error;
      }
      logger.info("sns_sms_inbound_subscription_confirmed", {
        topicArn: envelope.TopicArn,
      });
      return reply.send({ ok: true, action: "subscription_confirmed" });
    }

    if (envelope.Type === "UnsubscribeConfirmation") {
      // Deliberate no-op: never auto-resubscribe. Loud log so an unexpected
      // unsubscribe (someone detaching the endpoint) is visible.
      logger.warn("sns_sms_inbound_unsubscribe_confirmation", {
        topicArn: envelope.TopicArn,
      });
      return reply.send({ ok: true, action: "unsubscribe_acknowledged" });
    }

    try {
      const result = await handleSmsInboundNotification(
        {
          repos: app.deps.trpc.repos,
          clock: app.deps.trpc.clock,
          logger,
        },
        envelope.Message,
      );
      logger.info("sns_sms_inbound_processed", {
        messageId: envelope.MessageId,
        action: result.action,
        ...(result.action === "ignored" ? { reason: result.reason } : {}),
      });
      return reply.send({ ok: true, action: result.action });
    } catch (error) {
      // Log with the canonical AppErrorCode, then re-throw UNCHANGED so
      // Fastify's default 500 preserves SNS's retry semantics (mirrors the
      // resend webhook's failure contract).
      logger.error("sns_sms_inbound_processing_failed", {
        error: error instanceof Error ? error.message : String(error),
        appCode: resolveWebhookAppCode(error) ?? undefined,
        messageId: envelope.MessageId,
      });
      throw error;
    }
  });
};

export default fp(plugin as unknown as never) as unknown as never;
