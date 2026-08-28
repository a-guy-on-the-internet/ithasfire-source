import Fastify from "fastify";
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

    try {
      // Parse Pub/Sub envelope
      const envelope = pubSubEnvelopeSchema.parse(request.body);
      const messageId = envelope.message.messageId ?? "unknown";

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
        // Return 400 to tell Pub/Sub not to retry (bad message format)
        return reply.status(400).send({
          error: "invalid_message_format",
          message: "Failed to decode message data",
        });
      }

      // Parse and validate the transcode message
      const parseResult = transcodeMessageSchema.safeParse(decodedData);
      if (!parseResult.success) {
        requestLogger.error("pubsub_validation_failed", {
          messageId,
          errors: parseResult.error.format(),
        });
        // Return 400 - bad message, don't retry
        return reply.status(400).send({
          error: "invalid_message_payload",
          details: parseResult.error.format(),
        });
      }

      const input = parseResult.data;
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
