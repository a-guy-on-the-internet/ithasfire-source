/**
 * E2E Test for Audio Transcoding
 *
 * This test runs FFmpeg locally to transcode a real MP3 file to HLS.
 * It verifies the entire transcoding pipeline produces valid HLS output.
 *
 * Prerequisites:
 * - FFmpeg installed locally (brew install ffmpeg)
 * - Test fixture: test/fixtures/test-audio.mp3
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile, readdir, rm, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FfmpegTranscoder } from "@th/adapters/transcoder/ffmpeg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, "fixtures");
const OUTPUT_DIR = join(__dirname, "fixtures", "output");
const TEST_AUDIO_PATH = join(FIXTURES_DIR, "test-audio.mp3");

// Create a simple logger for tests
const testLogger = {
  info: (msg: string, ctx?: object) => console.log(`[INFO] ${msg}`, ctx ?? ""),
  warn: (msg: string, ctx?: object) => console.warn(`[WARN] ${msg}`, ctx ?? ""),
  error: (msg: string, ctx?: object) =>
    console.error(`[ERROR] ${msg}`, ctx ?? ""),
  debug: (msg: string, ctx?: object) =>
    console.debug(`[DEBUG] ${msg}`, ctx ?? ""),
  child: () => testLogger,
};

describe("E2E: Audio Transcoding", () => {
  let transcoder: FfmpegTranscoder;
  let ffmpegAvailable = false;

  beforeAll(async () => {
    transcoder = new FfmpegTranscoder(testLogger);
    ffmpegAvailable = await transcoder.isAvailable();

    // Clean up any previous output
    if (existsSync(OUTPUT_DIR)) {
      await rm(OUTPUT_DIR, { recursive: true });
    }
    await mkdir(OUTPUT_DIR, { recursive: true });

    // Verify test fixture exists
    if (!existsSync(TEST_AUDIO_PATH)) {
      throw new Error(
        `Test fixture not found: ${TEST_AUDIO_PATH}\n` +
          "Please ensure test-audio.mp3 exists in test/fixtures/",
      );
    }
  });

  afterAll(async () => {
    // Keep output for manual inspection, but clean on next run
    console.log(`\n📁 HLS output preserved at: ${OUTPUT_DIR}`);
  });

  it("should have FFmpeg available", async () => {
    expect(ffmpegAvailable).toBe(true);

    const version = await transcoder.getVersion();
    console.log(`\n🎬 FFmpeg version: ${version}`);
    expect(version).toBeTruthy();
  });

  it("should transcode MP3 to HLS with segments", async () => {
    if (!ffmpegAvailable) {
      console.warn("⚠️ Skipping transcode test: FFmpeg not available");
      return;
    }

    console.log("\n🎵 Starting transcoding...");
    console.log(`   Input: ${TEST_AUDIO_PATH}`);
    console.log(`   Output: ${OUTPUT_DIR}`);

    const startTime = Date.now();

    const result = await transcoder.transcode({
      inputPath: TEST_AUDIO_PATH,
      outputDir: OUTPUT_DIR,
      segmentDuration: 6,
      options: {
        audioBitrate: "128k",
        audioCodec: "aac",
        sampleRate: 44100,
        channels: 2,
      },
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Transcoding complete in ${elapsed}s`);
    console.log(`   Playlist: ${result.playlistPath}`);
    console.log(`   Segments: ${result.segments.length}`);
    console.log(`   Duration: ${result.totalDuration.toFixed(2)}s`);

    // Verify playlist exists
    expect(existsSync(result.playlistPath)).toBe(true);

    // Read and validate playlist content
    const playlistContent = await readFile(result.playlistPath, "utf-8");
    console.log("\n📄 Playlist content:");
    console.log("─".repeat(50));
    console.log(playlistContent);
    console.log("─".repeat(50));

    // Validate HLS playlist structure
    expect(playlistContent).toContain("#EXTM3U");
    expect(playlistContent).toContain("#EXT-X-VERSION:");
    expect(playlistContent).toContain("#EXT-X-TARGETDURATION:");
    expect(playlistContent).toContain("#EXT-X-MEDIA-SEQUENCE:");
    expect(playlistContent).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(playlistContent).toContain("#EXT-X-ENDLIST");
    expect(playlistContent).toContain("#EXTINF:");
    expect(playlistContent).toContain(".ts");

    // Verify segments exist
    expect(result.segments.length).toBeGreaterThan(0);

    for (const segment of result.segments) {
      expect(existsSync(segment.path)).toBe(true);
      const segmentStat = await stat(segment.path);
      expect(segmentStat.size).toBeGreaterThan(0);
    }

    // Log segment info
    console.log("\n📦 Segments:");
    for (const segment of result.segments) {
      const segmentStat = await stat(segment.path);
      const sizeKB = (segmentStat.size / 1024).toFixed(1);
      console.log(
        `   ${segment.filename}: ${segment.duration.toFixed(2)}s (${sizeKB} KB)`,
      );
    }

    // Verify total duration is reasonable (should be > 3 minutes for All Star)
    expect(result.totalDuration).toBeGreaterThan(60);

    // List all output files
    const outputFiles = await readdir(OUTPUT_DIR);
    console.log("\n📁 Output directory contents:");
    for (const file of outputFiles) {
      const filePath = join(OUTPUT_DIR, file);
      const fileStat = await stat(filePath);
      const sizeKB = (fileStat.size / 1024).toFixed(1);
      console.log(`   ${file}: ${sizeKB} KB`);
    }
  }, 60000); // 60 second timeout for transcoding

  it("should produce playable HLS segments", async () => {
    if (!ffmpegAvailable) {
      console.warn("⚠️ Skipping validation test: FFmpeg not available");
      return;
    }

    const playlistPath = join(OUTPUT_DIR, "audio.m3u8");
    if (!existsSync(playlistPath)) {
      console.warn("⚠️ Skipping validation: No playlist from previous test");
      return;
    }

    // Use FFprobe to validate the HLS stream
    const { spawn } = await import("node:child_process");

    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration,format_name",
      "-of",
      "json",
      playlistPath,
    ]);

    let stdout = "";
    let stderr = "";

    ffprobe.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    await new Promise<void>((resolve, reject) => {
      ffprobe.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffprobe failed: ${stderr}`));
        }
      });
    });

    const probeResult = JSON.parse(stdout);
    console.log("\n🔍 FFprobe validation:");
    console.log(`   Format: ${probeResult.format?.format_name}`);
    console.log(`   Duration: ${probeResult.format?.duration}s`);

    expect(probeResult.format?.format_name).toContain("hls");
    expect(parseFloat(probeResult.format?.duration ?? "0")).toBeGreaterThan(60);
  }, 30000);
});
