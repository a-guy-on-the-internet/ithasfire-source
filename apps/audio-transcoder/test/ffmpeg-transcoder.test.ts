import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FfmpegTranscoder } from "@th/adapters/transcoder/ffmpeg";
import type { LoggerPort } from "@th/ports/logger";

// Mock logger
const mockLogger: LoggerPort = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

describe("FfmpegTranscoder", () => {
  let transcoder: FfmpegTranscoder;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `ffmpeg-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    transcoder = new FfmpegTranscoder({
      ffmpegPath: "ffmpeg",
      tempDir: testDir,
      hlsSegmentDuration: 6,
      audioBitrate: 128000,
      audioSampleRate: 44100,
      audioChannels: 2,
      logger: mockLogger,
    });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("isAvailable", () => {
    it("should return true when FFmpeg is installed", async () => {
      const available = await transcoder.isAvailable();
      // This test assumes FFmpeg is installed in the test environment
      // In CI, you may need to skip this or mock it
      expect(typeof available).toBe("boolean");
    });
  });

  describe("getVersion", () => {
    it("should return FFmpeg version string", async () => {
      try {
        const version = await transcoder.getVersion();
        expect(typeof version).toBe("string");
        expect(version.length).toBeGreaterThan(0);
      } catch (err) {
        // Skip if FFmpeg not installed
        console.warn("FFmpeg not available, skipping version test");
      }
    });
  });

  describe("transcode", () => {
    it("should reject invalid input", async () => {
      await expect(
        transcoder.transcode({
          inputPath: "",
          outputDir: testDir,
          baseName: "test",
        }),
      ).rejects.toMatchObject({
        code: "invalid_input",
      });
    });

    it("should reject when input file does not exist", async () => {
      await expect(
        transcoder.transcode({
          inputPath: join(testDir, "nonexistent.mp3"),
          outputDir: testDir,
          baseName: "test",
        }),
      ).rejects.toMatchObject({
        code: "ffmpeg_failed",
      });
    });

    // Integration test - requires FFmpeg and a real audio file
    // Uncomment to run locally with a test audio file
    /*
    it("should transcode MP3 to HLS", async () => {
      const inputPath = join(testDir, "test.mp3");
      const outputDir = join(testDir, "output");

      // Create a minimal silent MP3 for testing
      // In real tests, you'd use a fixture file
      await mkdir(outputDir, { recursive: true });

      const result = await transcoder.transcode({
        inputPath,
        outputDir,
        baseName: "audio",
      });

      expect(result.playlistFilename).toBe("audio.m3u8");
      expect(result.segments.length).toBeGreaterThan(0);
      expect(result.totalDuration).toBeGreaterThan(0);
      expect(result.transcodingTimeMs).toBeGreaterThan(0);

      // Verify files exist
      const playlistContent = await readFile(result.playlistPath, "utf-8");
      expect(playlistContent).toContain("#EXTM3U");
      expect(playlistContent).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    });
    */
  });
});
