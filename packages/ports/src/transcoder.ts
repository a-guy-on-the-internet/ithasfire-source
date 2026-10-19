import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Transcoder Port - Interface for audio transcoding to HLS format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HLS transcoding configuration
 */
export const hlsConfigSchema = z.object({
  /** Segment duration in seconds */
  segmentDuration: z.number().int().positive().default(6),
  /** Audio bitrate in bits per second (e.g., 128000 for 128kbps) */
  audioBitrate: z.number().int().positive().default(128000),
  /** Audio sample rate in Hz (e.g., 44100 for 44.1kHz) */
  audioSampleRate: z.number().int().positive().default(44100),
  /** Number of audio channels (1=mono, 2=stereo) */
  audioChannels: z.number().int().min(1).max(2).default(2),
});

export type HlsConfig = z.infer<typeof hlsConfigSchema>;

/**
 * Input for transcoding operation
 */
export const transcodeInputSchema = z.object({
  /** Local path to the source audio file */
  inputPath: z.string().min(1),
  /** Local directory to write HLS output files */
  outputDir: z.string().min(1),
  /** Base name for output files (e.g., "audio" -> "audio.m3u8", "audio_000.ts") */
  baseName: z.string().min(1).default("audio"),
  /** Optional configuration overrides */
  config: hlsConfigSchema.partial().optional(),
});

export type TranscodeInput = z.infer<typeof transcodeInputSchema>;

/**
 * Output segment metadata
 */
export const hlsSegmentSchema = z.object({
  /** Segment filename */
  filename: z.string(),
  /** Full local path to the segment file */
  path: z.string(),
  /** Segment duration in seconds */
  duration: z.number().positive(),
  /** Segment index (0-based) */
  index: z.number().int().nonnegative(),
});

export type HlsSegment = z.infer<typeof hlsSegmentSchema>;

/**
 * Transcoding result
 */
export const transcodeOutputSchema = z.object({
  /** Path to the master playlist (.m3u8) */
  playlistPath: z.string(),
  /** Playlist filename */
  playlistFilename: z.string(),
  /** List of generated segments */
  segments: z.array(hlsSegmentSchema),
  /** Total duration in seconds */
  totalDuration: z.number().nonnegative(),
  /** Transcoding time in milliseconds */
  transcodingTimeMs: z.number().int().nonnegative(),
  /** Normalized waveform peaks (0.0–1.0), typically 200 bins */
  waveformPeaks: z.array(z.number().min(0).max(1)),
});

export type TranscodeOutput = z.infer<typeof transcodeOutputSchema>;

/**
 * Error codes for transcoding operations
 */
export type TranscoderErrorCode =
  | "invalid_input"
  | "ffmpeg_not_found"
  | "ffmpeg_failed"
  | "input_not_found"
  | "unsupported_format"
  | "output_failed"
  | "timeout";

export interface TranscoderError {
  code: TranscoderErrorCode;
  message: string;
  details?: unknown;
}

export function createTranscoderError(
  code: TranscoderErrorCode,
  message: string,
  details?: unknown,
): TranscoderError {
  return { code, message, details };
}

export function isTranscoderError(err: unknown): err is TranscoderError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  );
}

/**
 * Transcoder port interface
 *
 * Responsible for converting audio files to HLS format.
 * This is a local adapter - input/output are local filesystem paths.
 */
export interface TranscoderPort {
  /**
   * Transcode an audio file to HLS format.
   *
   * @param input - Transcoding parameters
   * @returns Transcoding result with paths to generated files
   * @throws {TranscoderError} on failure
   */
  transcode(input: TranscodeInput): Promise<TranscodeOutput>;

  /**
   * Check if the transcoder is available and properly configured.
   * Useful for health checks.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get transcoder version information (e.g., FFmpeg version).
   */
  getVersion(): Promise<string>;
}
