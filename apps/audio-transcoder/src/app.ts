import Fastify from "fastify";
import * as Sentry from "@sentry/node";
import { z, ZodError } from "zod";

import { buildContainer, type TranscoderContainer } from "./lib/container";
import {
  transcodeAudio,
  transcodeAudioInputSchema,
} from "./use-cases/transcode-audio";

// ─────────────────────────────────────────────────────────────────────────────
// Pub/Sub Message Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pub/Sub push envelope schema.
 * Google Pub/Sub push subscriptions wrap the message in this structure.
 */
const pubSubEnvelopeSchema = z.object({
  message: z.object({
    /** Base64-encoded message data */
    data: z.string(),
    /** Message ID */
    messageId: z.string().optional(),
    /** Publish time */
    publishTime: z.string().optional(),
    /** Message attributes */
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  subscription: z.string().optional(),
});

/**
 * Decoded message payload schema
 */
const transcodeMessageSchema = transcodeAudioInputSchema;

/**
 * Warm-up message, published by the API when an organiser STARTS an audio
 * upload (`warmTranscoder` in packages/transport/trpc/src/routers/events.ts).
 * Prod runs this service at min 0 instances; the push request is what boots an
 * instance, so its cold start overlaps the file upload. The handler acks it
 * with a 200 and does nothing else. It is recognised by its body or by its
 * `kind` attribute (the API sets both).
 */
export const transcoderWarmMessageSchema = z
  .object({ kind: z.literal("warm") })
  .strict();

function isWarmMessage(
  attributes: Record<string, string> | undefined,
  decoded: unknown,
): boolean {
  return (
    attributes?.kind === "warm" ||
    transcoderWarmMessageSchema.safeParse(decoded).success
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// App Builder
// ─────────────────────────────────────────────────────────────────────────────

export async function createApp() {
  const container = await buildContainer();
  const logger = container.logger;

  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
  });

  // Graceful shutdown
  app.addHook("onClose", async () => {
    await container.close();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Health check
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/health", async () => {
    const ffmpegAvailable = await container.transcoder.isAvailable();
    return {
      status: ffmpegAvailable ? "ok" : "degraded",
      ffmpeg: ffmpegAvailable,
    };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Detailed health check (includes FFmpeg version)
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/health/detailed", async () => {
    try {
      const version = await container.transcoder.getVersion();
      return {
        status: "ok",
        ffmpeg: {
          available: true,
          version,
        },
      };
    } catch (err) {
      return {
        status: "degraded",
        ffmpeg: {
          available: false,
          error: err instanceof Error ? err.message : "unknown",
        },
      };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Pub/Sub Push Handler
  // POST /pubsub/push
  //
  // This endpoint receives messages from Google Pub/Sub push subscriptions.
  // The message is wrapped in a Pub/Sub envelope with base64-encoded data.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/pubsub/push", async (request, reply) => {
    const requestLogger = logger.child({ route: "pubsub_push" });

    // Hoisted out of the try so the catch below can attribute the failure to a
    // specific message and upload. Both stay at their defaults if we fail
    // before parsing, which is itself the useful signal.
    let messageId = "unknown";
    let audioUploadId: string | undefined;

    try {
      // Parse Pub/Sub envelope
      const envelope = pubSubEnvelopeSchema.parse(request.body);
      messageId = envelope.message.messageId ?? "unknown";

      requestLogger.info("pubsub_message_received", { messageId });

      // Decode base64 message data
      let decodedData: unknown;
      try {
        const jsonString = Buffer.from(
          envelope.message.data,
          "base64",
        ).toString("utf-8");
        decodedData = JSON.parse(jsonString);
      } catch (err) {
        requestLogger.error("pubsub_decode_failed", { messageId, err });
        // 400 does NOT stop a retry: Pub/Sub push treats any non-2xx as a
        // nack and redelivers (10s-600s backoff) until max_delivery_attempts
        // (5), then dead-letters to *-transcode-dlq. An undecodable message
        // therefore lands in the DLQ, which nothing alerts on yet.
        return reply.status(400).send({
          error: "invalid_message_format",
          message: "Failed to decode message data",
        });
      }

      // A warm-up carries no job: ack it before validation so it is never
      // logged as a bad payload, never retried, never dead-lettered.
      if (isWarmMessage(envelope.message.attributes, decodedData)) {
        requestLogger.info("pubsub_warm_acked", { messageId });
        return reply.status(200).send({ ok: true, warm: true });
      }

      // Parse and validate the transcode message
      const parseResult = transcodeMessageSchema.safeParse(decodedData);
      if (!parseResult.success) {
        requestLogger.error("pubsub_validation_failed", {
          messageId,
          errors: parseResult.error.format(),
        });
        // 400 is a nack, not "don't retry": Pub/Sub redelivers up to
        // max_delivery_attempts, then dead-letters (see the decode branch).
        return reply.status(400).send({
          error: "invalid_message_payload",
          details: parseResult.error.format(),
        });
      }

      const input = parseResult.data;
      audioUploadId = input.audioUploadId;
      requestLogger.info("transcode_job_start", {
        messageId,
        audioUploadId: input.audioUploadId,
        eventId: input.eventId,
      });

      // Execute transcoding
      const result = await transcodeAudio(
        {
          ...container,
          logger: requestLogger.child({ audioUploadId: input.audioUploadId }),
        },
        input,
      );

      requestLogger.info("transcode_job_complete", {
        messageId,
        audioUploadId: input.audioUploadId,
        playlistUrl: result.playlistUrl,
        processingTimeMs: result.processingTimeMs,
      });

      // Return 200 to acknowledge the message
      return reply.status(200).send({
        ok: true,
        audioUploadId: result.audioUploadId,
        playlistUrl: result.playlistUrl,
      });
    } catch (err) {
      // Determine if error is retryable
      const isRetryable = isRetryableError(err);

      requestLogger.error("transcode_job_failed", {
        err,
        retryable: isRetryable,
      });

      // Deliberate swallow: both branches below convert the error into an HTTP
      // response rather than letting it propagate, so nothing else can capture
      // it. The non-retryable branch is the dangerous one — it acks the message
      // and the upload is abandoned in TRANSCODING with no further signal.
      // Guarded so a failing reporter never changes the response.
      try {
        Sentry.captureException(err, {
          tags: {
            service: "audio-transcoder",
            route: "pubsub_push",
            retryable: String(isRetryable),
          },
          extra: { messageId, audioUploadId },
        });
        // The module hardcodes `cpu_idle = true`
        // (modules/cloud-run-audio-transcoder/main.tf), so CPU is throttled the
        // moment this handler returns. Without a flush the ingest POST can be
        // frozen mid-flight and the event never arrives — worst on the
        // non-retryable branch, which acks the message and is terminal, so
        // there is no redelivery to report it a second time.
        //
        // `flush` resolves false on timeout rather than throwing, and 2s is
        // well inside the Pub/Sub ack deadline.
        await Sentry.flush(2000);
      } catch {
        // Reporting must never be the reason a transcode result changes.
      }

      if (isRetryable) {
        // Return 500 to trigger Pub/Sub retry
        return reply.status(500).send({
          error: "transient_error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }

      // Non-retryable error - ack the message to prevent infinite retries
      return reply.status(200).send({
        ok: false,
        error: "permanent_error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Direct invoke (for testing/debugging)
  // POST /transcode
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/transcode", async (request, reply) => {
    const requestLogger = logger.child({ route: "transcode_direct" });

    try {
      const result = await transcodeAudio(
        {
          ...container,
          logger: requestLogger,
        },
        request.body,
      );

      return reply.send({ ok: true, ...result });
    } catch (err) {
      requestLogger.error("transcode_direct_failed", { err });

      if (err instanceof ZodError) {
        return reply.status(400).send({
          error: "invalid_input",
          details: err.format(),
        });
      }

      // Same deliberate swallow as the Pub/Sub branch. ZodError is excluded
      // above — a malformed debug-route payload is caller error, not a fault
      // worth alerting on.
      try {
        Sentry.captureException(err, {
          tags: { service: "audio-transcoder", route: "transcode_direct" },
        });
        await Sentry.flush(2000);
      } catch {
        // Reporting must never be the reason a transcode result changes.
      }

      const typedErr = err as { code?: string; message?: string };
      return reply.status(500).send({
        error: typedErr.code ?? "internal_error",
        message: typedErr.message ?? "Unknown error",
      });
    }
  });

  return { app, container };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine if an error is retryable.
 * Transient errors (network, temporary service unavailability) should be retried.
 * Permanent errors (bad input, missing file) should not.
 */
function isRetryableError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return true;

  const code = (err as { code?: string }).code;

  // Non-retryable error codes
  const permanentErrors = [
    "invalid_input",
    "audio_upload_not_found",
    "source_not_found",
    "unsupported_format",
  ];

  if (code && permanentErrors.includes(code)) {
    return false;
  }

  // Default to retryable (network errors, etc.)
  return true;
}
