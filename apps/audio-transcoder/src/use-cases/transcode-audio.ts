import { z } from "zod";
import { createWriteStream } from "node:fs";
import { mkdir, rm, readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { TranscoderPort } from "@th/ports/transcoder";
import { isTranscoderError } from "@th/ports/transcoder";

// ─────────────────────────────────────────────────────────────────────────────
// Input/Output schemas
// ─────────────────────────────────────────────────────────────────────────────

export const transcodeAudioInputSchema = z.object({
  /** Unique identifier for the audio upload */
  audioUploadId: z.string().uuid(),
  /** Event ID this audio belongs to */
  eventId: z.string().uuid(),
  /** R2 object key for the source audio file */
  sourceKey: z.string().min(1),
  /** Output path prefix for HLS files (e.g., "events/{eventId}/audio/{audioId}") */
  outputPrefix: z.string().min(1),
  /** Whether to delete the source file after successful transcoding */
  deleteSourceOnSuccess: z.boolean().default(true),
});

export type TranscodeAudioInput = z.infer<typeof transcodeAudioInputSchema>;

export const transcodeAudioOutputSchema = z.object({
  /** Audio upload ID */
  audioUploadId: z.string().uuid(),
  /** URL to the HLS playlist */
  playlistUrl: z.string(),
  /** R2 key for the playlist */
  playlistKey: z.string(),
  /** Number of segments generated */
  segmentCount: z.number().int().nonnegative(),
  /** Total audio duration in seconds */
  totalDuration: z.number().nonnegative(),
  /** Processing time in milliseconds */
  processingTimeMs: z.number().int().nonnegative(),
  /** Whether source was deleted */
  sourceDeleted: z.boolean(),
});

export type TranscodeAudioOutput = z.infer<typeof transcodeAudioOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscodeAudioDeps {
  repos: Repos;
  logger: LoggerPort;
  clock: ClockPort;
  fileStorage: FileStoragePort;
  transcoder: TranscoderPort;
  tempDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error codes
// ─────────────────────────────────────────────────────────────────────────────

export type TranscodeAudioErrorCode =
  | "invalid_input"
  | "audio_upload_not_found"
  | "source_not_found"
  | "download_failed"
  | "transcode_failed"
  | "upload_failed"
  | "db_update_failed";

export interface TranscodeAudioError {
  code: TranscodeAudioErrorCode;
  message: string;
  details?: unknown;
}

function createError(
  code: TranscodeAudioErrorCode,
  message: string,
  details?: unknown,
): TranscodeAudioError {
  return { code, message, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// Segment upload concurrency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many HLS segments we upload to R2 at once.
 *
 * A 4-minute track at `hls_time 6` is ~40 segments, and uploading them one at
 * a time serialises ~40 `readFile` + network round trips — the single largest
 * chunk of wall-clock time in this use case.
 *
 * The bound matters as much as the parallelism. A bare `Promise.all` over the
 * whole array would, for a long podcast (hundreds of segments), open hundreds
 * of concurrent sockets against R2 in one go — which invites rate limiting and
 * connection churn — while buffering every segment's contents in memory at the
 * same time. This service is a 2 vCPU / 2Gi Cloud Run instance handling one
 * request at a time (see infra/terraform/envs/*: audio_transcoder_cpu
 * = "2", audio_transcoder_memory = "2Gi", module concurrency default 1), so
 * that headroom is finite and scales with the length of the uploaded file.
 *
 * 8 keeps the network pipe busy — uploads are I/O bound, so this is not
 * competing for the CPU the encode wants — with at most 8 segments (~1MB)
 * resident.
 */
const SEGMENT_UPLOAD_CONCURRENCY = 8;

/**
 * Runs `task` over `items` with at most `concurrency` in flight.
 *
 * Failure semantics are deliberately strict, because a partially-uploaded HLS
 * render that reports success would produce a playlist referencing segments
 * that 404:
 * - the first rejection is captured and rethrown once the pool has fully
 *   drained (so no in-flight rejection can be swallowed by a later resolve);
 * - no NEW work starts after a failure.
 *
 * Hand-rolled rather than pulling in `p-limit` — the transcoder image stays
 * dependency-light.
 *
 * Exported for unit tests; the only production call site is the segment upload
 * below.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  // A bound below 1 would make `Math.min` spawn ZERO workers: `Promise.all([])`
  // resolves, `failed` stays false, and the caller is told every item
  // succeeded having uploaded none of them — the exact catastrophic outcome
  // this helper exists to prevent. Unreachable from the single call site
  // today, but too sharp an edge to leave in a helper whose contract is
  // strictness.
  if (concurrency < 1) {
    throw new Error(
      `runWithConcurrency requires concurrency >= 1, got ${concurrency}`,
    );
  }

  let nextIndex = 0;
  let firstError: unknown;
  let failed = false;

  const worker = async (): Promise<void> => {
    // Workers never reject: a failure is recorded and the worker returns, so
    // `Promise.all` below always resolves and always means "pool drained".
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      try {
        await task(items[index]!, index);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failed) {
    throw firstError;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transcode an uploaded audio file from MP3 to HLS format.
 *
 * This use case:
 * 1. Downloads the source audio from R2 to a temp directory
 * 2. Transcodes it to HLS (AAC-LC, 128kbps, 44.1kHz stereo, 6s segments)
 * 3. Uploads all HLS files (playlist + segments) to R2
 * 4. Updates the AudioUpload record with the new URLs
 * 5. Optionally deletes the source MP3
 *
 * Idempotency is achieved by overwriting the same output paths on retry.
 * The playlist URL remains stable across retries.
 */
export async function transcodeAudio(
  deps: TranscodeAudioDeps,
  rawInput: unknown,
): Promise<TranscodeAudioOutput> {
  const {
    repos,
    logger,
    clock,
    fileStorage,
    transcoder,
    tempDir = "/tmp/transcoder",
  } = deps;
  const startTime = Date.now();

  // ─── Parse input ─────────────────────────────────────────────────────────────
  const parseResult = transcodeAudioInputSchema.safeParse(rawInput);
  if (!parseResult.success) {
    throw createError(
      "invalid_input",
      "Invalid input",
      parseResult.error.format(),
    );
  }

  const input = parseResult.data;
  const {
    audioUploadId,
    eventId,
    sourceKey,
    outputPrefix,
    deleteSourceOnSuccess,
  } = input;

  const log = logger.child({
    useCase: "transcodeAudio",
    audioUploadId,
    eventId,
    sourceKey,
  });

  log.info("transcode_audio_start", { outputPrefix });

  // ─── Create temp working directory ───────────────────────────────────────────
  const workDir = join(
    tempDir,
    `transcode-${audioUploadId}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(workDir, { recursive: true });

  try {
    // ─── Download source audio from R2 ───────────────────────────────────────────
    log.info("downloading_source", { sourceKey });

    const sourceFilename = basename(sourceKey);
    const sourcePath = join(workDir, sourceFilename);

    // Get a presigned URL to download
    const { url: downloadUrl } = await fileStorage.getObjectUrl({
      key: sourceKey,
      options: { expiresSec: 3600 }, // 1 hour
    });

    // Download the file
    const response = await fetch(downloadUrl);
    if (!response.ok || !response.body) {
      throw createError(
        "download_failed",
        `Failed to download source: ${response.status}`,
      );
    }

    // Stream to local file
    const writeStream = createWriteStream(sourcePath);
    await pipeline(Readable.fromWeb(response.body as any), writeStream);

    log.info("source_downloaded", { sourcePath });

    // ─── Transcode to HLS ────────────────────────────────────────────────────────
    log.info("transcoding_start", {});

    const hlsOutputDir = join(workDir, "hls");
    await mkdir(hlsOutputDir, { recursive: true });

    let transcodeResult;
    try {
      transcodeResult = await transcoder.transcode({
        inputPath: sourcePath,
        outputDir: hlsOutputDir,
        baseName: "audio",
      });
    } catch (err) {
      if (isTranscoderError(err)) {
        throw createError("transcode_failed", err.message, err.details);
      }
      throw createError("transcode_failed", "Transcoding failed", err);
    }

    log.info("transcoding_complete", {
      segmentCount: transcodeResult.segments.length,
      totalDuration: transcodeResult.totalDuration,
      transcodingTimeMs: transcodeResult.transcodingTimeMs,
    });

    // ─── Upload HLS files to R2 ──────────────────────────────────────────────────
    log.info("uploading_hls_files", {
      segmentCount: transcodeResult.segments.length,
    });

    const playlistKey = `${outputPrefix}/audio.m3u8`;

    // Upload segments first, in a bounded-concurrency pool. This `await`
    // resolves only once EVERY segment has landed, and rethrows the first
    // failure once the pool has drained — which is what keeps the playlist
    // upload below strictly ordered after them. A playlist visible before its
    // segments is a broken player, so a partial upload must fail the whole
    // step rather than report success.
    //
    // Not logged here: the failure propagates out of the use case and the
    // route already logs it with the full error (`transcode_job_failed`,
    // app.ts) and captures it to Sentry, so a log at this site would duplicate
    // both.
    //
    // Retry semantics change slightly and deliberately. `upload_failed` is
    // absent from app.ts's `permanentErrors` list, so a failed upload is
    // RETRYABLE and Pub/Sub redelivers, which is what we want for an R2
    // hiccup. It also reclassifies one case that used to be permanent: the
    // S3 adapter throws `invalid_input`/`public_base_url_not_configured` when
    // `public: true` is requested without a configured public base URL
    // (s3-adapter.ts), and every segment put sets `public: true`. That is
    // reachable by MISCONFIGURATION, not just by a malformed key —
    // `S3_PUBLIC_BASE_URL` is optional in env.ts and Terraform materialises
    // the unset case as "", which is falsy. Previously that ack'd the message
    // after one attempt and left the upload stuck in TRANSCODING forever;
    // now it retries and lands in the DLQ, which is louder and easier to
    // diagnose. The cost is 5 redeliveries that each re-download and
    // re-transcode before failing at the first put.
    await runWithConcurrency(
      transcodeResult.segments,
      SEGMENT_UPLOAD_CONCURRENCY,
      async (segment) => {
        const segmentKey = `${outputPrefix}/${segment.filename}`;

        try {
          const segmentContent = await readFile(segment.path);

          await fileStorage.putObject({
            key: segmentKey,
            content: segmentContent,
            options: {
              contentType: "video/mp2t", // MPEG-2 Transport Stream
              public: true, // HLS files need to be publicly accessible
            },
          });
        } catch (err) {
          throw createError(
            "upload_failed",
            `Failed to upload HLS segment ${segmentKey}`,
            err,
          );
        }
      },
    );

    // Upload playlist — strictly after every segment above.
    const playlistContent = await readFile(transcodeResult.playlistPath);
    const { url: playlistUrl } = await fileStorage.putObject({
      key: playlistKey,
      content: playlistContent,
      options: {
        contentType: "application/vnd.apple.mpegurl",
        public: true,
      },
    });

    log.info("hls_files_uploaded", { playlistKey, playlistUrl });

    // ─── Update database record ──────────────────────────────────────────────────
    log.info("updating_database", {});

    try {
      await repos.audioUploads.markTranscoded({
        id: audioUploadId,
        hlsPlaylistUrl: playlistUrl,
        hlsPlaylistKey: playlistKey,
        segmentCount: transcodeResult.segments.length,
        durationSeconds: transcodeResult.totalDuration,
        transcodedAt: clock.now(),
        waveformPeaks:
          transcodeResult.waveformPeaks.length > 0
            ? transcodeResult.waveformPeaks
            : undefined,
      });
    } catch (err) {
      // Log but don't fail - the files are uploaded and can be recovered
      log.error("db_update_failed", { err });
      // Note: In a real scenario, we might want to retry or queue this for later
    }

    // ─── Delete source file if requested ─────────────────────────────────────────
    let sourceDeleted = false;
    if (deleteSourceOnSuccess) {
      try {
        await fileStorage.deleteObject({ key: sourceKey });
        sourceDeleted = true;
        log.info("source_deleted", { sourceKey });
      } catch (err) {
        // Log but don't fail - transcoding succeeded
        log.warn("source_delete_failed", { sourceKey, err });
      }
    }

    const processingTimeMs = Date.now() - startTime;

    log.info("transcode_audio_complete", {
      playlistUrl,
      segmentCount: transcodeResult.segments.length,
      totalDuration: transcodeResult.totalDuration,
      processingTimeMs,
      sourceDeleted,
    });

    return {
      audioUploadId,
      playlistUrl,
      playlistKey,
      segmentCount: transcodeResult.segments.length,
      totalDuration: transcodeResult.totalDuration,
      processingTimeMs,
      sourceDeleted,
    };
  } finally {
    // ─── Cleanup temp directory ──────────────────────────────────────────────────
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (err) {
      log.warn("temp_cleanup_failed", { workDir, err });
    }
  }
}
