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

    // Upload segments first
    for (const segment of transcodeResult.segments) {
      const segmentKey = `${outputPrefix}/${segment.filename}`;
      const segmentContent = await readFile(segment.path);

      await fileStorage.putObject({
        key: segmentKey,
        content: segmentContent,
        options: {
          contentType: "video/mp2t", // MPEG-2 Transport Stream
          public: true, // HLS files need to be publicly accessible
        },
      });
    }

    // Upload playlist
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
