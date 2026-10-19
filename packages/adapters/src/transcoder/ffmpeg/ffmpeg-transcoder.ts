import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

import type { LoggerPort } from "@th/ports/logger";
import {
  type TranscoderPort,
  type TranscodeInput,
  type TranscodeOutput,
  type HlsSegment,
  type HlsConfig,
  transcodeInputSchema,
  createTranscoderError,
} from "@th/ports/transcoder";

// ─────────────────────────────────────────────────────────────────────────────
// FFmpeg Transcoder Adapter
// ─────────────────────────────────────────────────────────────────────────────

export interface FfmpegTranscoderOptions {
  /** Path to FFmpeg binary */
  ffmpegPath?: string;
  /** Temp directory for processing */
  tempDir?: string;
  /** Default HLS segment duration in seconds */
  hlsSegmentDuration?: number;
  /** Default audio bitrate in bps */
  audioBitrate?: number;
  /** Default audio sample rate in Hz */
  audioSampleRate?: number;
  /** Default audio channels */
  audioChannels?: number;
  /** Logger for debugging */
  logger?: LoggerPort;
}

export class FfmpegTranscoder implements TranscoderPort {
  private readonly ffmpegPath: string;
  private readonly tempDir: string;
  private readonly defaultConfig: HlsConfig;
  private readonly logger?: LoggerPort;

  constructor(options: FfmpegTranscoderOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.tempDir = options.tempDir ?? "/tmp/transcoder";
    this.defaultConfig = {
      segmentDuration: options.hlsSegmentDuration ?? 6,
      audioBitrate: options.audioBitrate ?? 128000,
      audioSampleRate: options.audioSampleRate ?? 44100,
      audioChannels: options.audioChannels ?? 2,
    };
    this.logger = options.logger;
  }

  async transcode(input: TranscodeInput): Promise<TranscodeOutput> {
    const startTime = Date.now();

    // Validate input
    const parsed = transcodeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw createTranscoderError(
        "invalid_input",
        "Invalid transcoding input",
        parsed.error.format(),
      );
    }

    const {
      inputPath,
      outputDir,
      baseName,
      config: configOverrides,
    } = parsed.data;

    // Merge config with defaults
    const config: HlsConfig = {
      ...this.defaultConfig,
      ...configOverrides,
    };

    // Ensure output directory exists
    await mkdir(outputDir, { recursive: true });

    // Build FFmpeg command
    const playlistFilename = `${baseName}.m3u8`;
    const playlistPath = join(outputDir, playlistFilename);
    const segmentPattern = join(outputDir, `${baseName}_%03d.ts`);

    const args = this.buildFfmpegArgs(
      inputPath,
      playlistPath,
      segmentPattern,
      config,
    );

    this.logger?.info("ffmpeg_transcode_start", {
      inputPath,
      outputDir,
      playlistPath,
      config,
      args: args.join(" "),
    });

    // Start the waveform pass CONCURRENTLY with the HLS encode instead of
    // after it. Both decode the same input file, but the waveform pass writes
    // only to stdout and never touches `outputDir`, so the two cannot conflict
    // on any output. Serially this was two full decodes back to back.
    //
    // The two really do run in parallel rather than just timeshare: the audio
    // transcoder is a 2 vCPU Cloud Run instance serving one request at a time
    // (audio_transcoder_cpu = "2" in infra/terraform/envs/*, module request
    // concurrency default 1), so there is a spare core for the second process.
    // Even without one, the waveform pass is decode-only — mono, 8kHz, no
    // encoder — so it is far cheaper than the AAC encode it overlaps with.
    //
    // `extractWaveformPeaks` is contractually fault-tolerant — it try/catches
    // its whole body and resolves with `[]` on any failure — so a waveform
    // problem cannot reject the HLS path. The `.catch` below is belt-and-
    // braces for the one escape hatch that contract has (a logger that throws
    // from inside its own catch block), and it also guarantees this promise is
    // never an unhandled rejection if `executeFfmpeg` throws first.
    //
    // We keep the child's handle so a failing HLS pass can KILL it. Running
    // concurrently means the waveform decode can now outlive a failed
    // transcode, which the old serial code made impossible (it never started).
    // Left alone on e.g. an ENOSPC failure mid-encode it would keep decoding
    // and keep appending to an unbounded buffer in `extractRawPcm` that
    // nobody will ever read, on an instance Pub/Sub is about to redeliver to.
    let waveformProc: ChildProcess | undefined;
    const waveformPromise = this.extractWaveformPeaks(inputPath, (proc) => {
      waveformProc = proc;
    }).catch((err) => {
      // Only reachable if the fault-tolerance contract itself broke (its
      // internal catch threw). That is exactly the silent-degradation shape
      // this project's reporting convention exists to prevent, so it gets a
      // real error log rather than a bare swallow.
      try {
        this.logger?.error("waveform_pass_unhandled", { err });
      } catch {
        // A throwing logger is the ONLY way to get here, so logging the
        // logging failure is not an option. Swallow rather than convert a
        // degraded waveform into an unhandled rejection.
      }
      return [] as number[];
    });

    // Execute FFmpeg (HLS)
    try {
      await this.executeFfmpeg(args);
    } catch (err) {
      // Reap the orphan before propagating. Killing it makes `extractRawPcm`
      // reject, which `extractWaveformPeaks` catches and turns into `[]`, so
      // this cannot produce a rejection that masks the real HLS error.
      this.killWaveformPass(waveformProc);
      throw err;
    }

    // Parse results — reads the playlist the HLS pass just wrote, so this MUST
    // stay after the `await` above.
    const segments = await this.parseSegments(outputDir, baseName);
    const totalDuration = segments.reduce((sum, seg) => sum + seg.duration, 0);

    // Waveform peaks (fault-tolerant — never fails the transcode)
    const waveformPeaks = await waveformPromise;

    const transcodingTimeMs = Date.now() - startTime;

    this.logger?.info("ffmpeg_transcode_complete", {
      playlistPath,
      segmentCount: segments.length,
      totalDuration,
      transcodingTimeMs,
      waveformPeakCount: waveformPeaks.length,
    });

    return {
      playlistPath,
      playlistFilename,
      segments,
      totalDuration,
      transcodingTimeMs,
      waveformPeaks,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getVersion();
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, ["-version"]);
      let output = "";

      proc.stdout.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          // Extract version from first line: "ffmpeg version X.Y.Z ..."
          const match = output.match(/ffmpeg version (\S+)/);
          resolve(match?.[1] ?? "unknown");
        } else {
          reject(
            createTranscoderError(
              "ffmpeg_not_found",
              "FFmpeg not found or failed to run",
            ),
          );
        }
      });

      proc.on("error", (err) => {
        reject(
          createTranscoderError(
            "ffmpeg_not_found",
            `FFmpeg not found: ${err.message}`,
          ),
        );
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────────

  private static readonly WAVEFORM_BINS = 200;
  private static readonly WAVEFORM_SAMPLE_RATE = 8000;

  /**
   * Extract waveform peaks from an audio file.
   *
   * Runs a second ffmpeg pass to export raw PCM data at a low sample rate,
   * then computes peak amplitudes across 200 bins and normalizes to 0.0–1.0.
   *
   * This is fault-tolerant: on any error it logs a warning and returns an
   * empty array rather than failing the transcode. That includes being KILLED
   * by {@link killWaveformPass} when the HLS pass fails — the kill surfaces
   * here as a non-zero exit and degrades to `[]` like any other failure.
   *
   * `onSpawn` hands the caller the underlying child process so it can be
   * killed; it fires synchronously, before the returned promise settles.
   */
  private async extractWaveformPeaks(
    inputPath: string,
    onSpawn?: (proc: ChildProcess) => void,
  ): Promise<number[]> {
    try {
      const pcmBuffer = await this.extractRawPcm(inputPath, onSpawn);

      if (pcmBuffer.length === 0) {
        this.logger?.warn("waveform_empty_pcm", { inputPath });
        return [];
      }

      // Each sample is a 32-bit float (4 bytes)
      const sampleCount = Math.floor(pcmBuffer.length / 4);
      if (sampleCount === 0) {
        return [];
      }

      const samples = new Float32Array(
        pcmBuffer.buffer,
        pcmBuffer.byteOffset,
        sampleCount,
      );
      const binCount = Math.min(FfmpegTranscoder.WAVEFORM_BINS, sampleCount);
      const samplesPerBin = sampleCount / binCount;
      const peaks: number[] = new Array(binCount);

      // Compute peak absolute amplitude per bin
      for (let bin = 0; bin < binCount; bin++) {
        const start = Math.floor(bin * samplesPerBin);
        const end = Math.floor((bin + 1) * samplesPerBin);
        let peak = 0;
        for (let i = start; i < end; i++) {
          const abs = Math.abs(samples[i]!);
          if (abs > peak) peak = abs;
        }
        peaks[bin] = peak;
      }

      // Pad with zeros if we have fewer than 200 bins (very short audio)
      while (peaks.length < FfmpegTranscoder.WAVEFORM_BINS) {
        peaks.push(0);
      }

      // Normalize so the maximum peak is 1.0
      const maxPeak = Math.max(...peaks);
      if (maxPeak > 0) {
        for (let i = 0; i < peaks.length; i++) {
          peaks[i] = peaks[i]! / maxPeak;
        }
      }

      this.logger?.info("waveform_extracted", {
        inputPath,
        sampleCount,
        binCount,
        maxPeak,
      });

      return peaks;
    } catch (err) {
      this.logger?.warn("waveform_extraction_failed", {
        inputPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Run ffmpeg to export raw mono PCM f32le data at a low sample rate.
   *
   * `onSpawn` receives the child process so callers can kill it; it is invoked
   * synchronously immediately after `spawn`.
   */
  private extractRawPcm(
    inputPath: string,
    onSpawn?: (proc: ChildProcess) => void,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const args = [
        "-i",
        inputPath,
        "-ac",
        "1", // mono
        "-ar",
        `${FfmpegTranscoder.WAVEFORM_SAMPLE_RATE}`, // 8kHz
        "-f",
        "f32le", // 32-bit float little-endian
        "-acodec",
        "pcm_f32le",
        "pipe:1", // output to stdout
      ];

      const proc = spawn(this.ffmpegPath, args);
      onSpawn?.(proc);
      const chunks: Buffer[] = [];
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        chunks.push(data);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(
            new Error(
              `FFmpeg waveform extraction exited with code ${code}: ${stderr.slice(-500)}`,
            ),
          );
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`FFmpeg waveform extraction error: ${err.message}`));
      });
    });
  }

  /**
   * Terminates an in-flight waveform pass.
   *
   * Called only when the HLS encode has already failed, so the waveform output
   * is worthless — SIGKILL rather than SIGTERM, since there is nothing worth
   * letting ffmpeg flush and every second it keeps running is CPU and heap
   * taken from the retry that Pub/Sub is about to deliver.
   *
   * Never throws: this runs on an error path and must not mask the HLS error
   * that sent us here.
   */
  private killWaveformPass(proc: ChildProcess | undefined): void {
    // Nothing spawned, or it already exited on its own.
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;

    try {
      proc.kill("SIGKILL");
      this.logger?.warn("waveform_pass_killed", { pid: proc.pid });
    } catch (err) {
      // Best-effort diagnostic, itself guarded: a throwing logger here would
      // escape into `transcode()`'s catch block and REPLACE the real
      // `ffmpeg_failed` error with its own — turning a clear encode failure
      // into a mystery. Losing the log line is the lesser harm.
      try {
        this.logger?.warn("waveform_pass_kill_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // Nothing left to do; swallowing is the only non-masking option.
      }
    }
  }

  private buildFfmpegArgs(
    inputPath: string,
    playlistPath: string,
    segmentPattern: string,
    config: HlsConfig,
  ): string[] {
    // FFmpeg command for HLS audio-only transcoding
    // Key parameters per spec:
    // - AAC-LC codec (libfdk_aac if available, otherwise aac)
    // - 128kbps bitrate
    // - 44.1kHz sample rate
    // - Stereo
    // - 6 second segments
    // - VOD playlist type
    return [
      "-y", // Overwrite output files (idempotent)
      "-i",
      inputPath,

      // Audio codec settings
      "-c:a",
      "aac", // AAC codec (AAC-LC profile is default)
      "-b:a",
      `${config.audioBitrate}`, // Bitrate (128000 = 128kbps)
      "-ar",
      `${config.audioSampleRate}`, // Sample rate (44100 = 44.1kHz)
      "-ac",
      `${config.audioChannels}`, // Channels (2 = stereo)

      // AAC-LC specific settings
      "-profile:a",
      "aac_low", // Explicitly set AAC-LC profile

      // HLS settings
      "-f",
      "hls",
      "-hls_time",
      `${config.segmentDuration}`, // Segment duration
      "-hls_list_size",
      "0", // Include all segments in playlist (VOD)
      "-hls_playlist_type",
      "vod", // VOD playlist type
      "-hls_segment_filename",
      segmentPattern,

      // Output
      playlistPath,
    ];
  }

  private executeFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, args);
      let stderr = "";

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          this.logger?.error("ffmpeg_failed", {
            code,
            stderr: stderr.slice(-2000),
          });
          reject(
            createTranscoderError(
              "ffmpeg_failed",
              `FFmpeg exited with code ${code}`,
              {
                stderr: stderr.slice(-2000),
              },
            ),
          );
        }
      });

      proc.on("error", (err) => {
        this.logger?.error("ffmpeg_error", { error: err.message });
        reject(
          createTranscoderError(
            "ffmpeg_failed",
            `FFmpeg error: ${err.message}`,
          ),
        );
      });
    });
  }

  private async parseSegments(
    outputDir: string,
    baseName: string,
  ): Promise<HlsSegment[]> {
    const segments: HlsSegment[] = [];

    // Read the playlist to get segment info
    const playlistPath = join(outputDir, `${baseName}.m3u8`);
    const playlistContent = await readFile(playlistPath, "utf-8");

    // Parse M3U8 to extract segment info
    const lines = playlistContent.split("\n");
    let currentDuration = 0;
    let segmentIndex = 0;

    for (const line of lines) {
      // #EXTINF:duration,
      if (line.startsWith("#EXTINF:")) {
        const match = line.match(/#EXTINF:([\d.]+)/);
        if (match && match[1]) {
          currentDuration = parseFloat(match[1]);
        }
      }
      // Segment filename (ends with .ts)
      else if (line.endsWith(".ts")) {
        const filename = basename(line.trim());
        const path = join(outputDir, filename);

        segments.push({
          filename,
          path,
          duration: currentDuration,
          index: segmentIndex,
        });

        segmentIndex++;
        currentDuration = 0;
      }
    }

    return segments;
  }
}
