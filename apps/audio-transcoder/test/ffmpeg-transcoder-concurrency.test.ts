import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { FfmpegTranscoder } from "@th/adapters/transcoder/ffmpeg";
import type { LoggerPort } from "@th/ports/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_FFMPEG = join(__dirname, "fixtures", "fake-ffmpeg.mjs");

type TimingRecord = {
  mode: "hls" | "waveform";
  phase: "start" | "end";
  t: number;
  pid: number;
};

/**
 * The HLS encode and the waveform pass are two independent ffmpeg runs over
 * the same input. They used to run back to back (two full decodes serially);
 * these tests pin that they now OVERLAP, and that the waveform pass's
 * fault-tolerance contract survived the change.
 *
 * A fake ffmpeg (test/fixtures/fake-ffmpeg.mjs) stands in for the real binary
 * so the assertion is about scheduling, not encoding, and so it holds in CI
 * where ffmpeg may not be installed.
 */
describe("FfmpegTranscoder — concurrent HLS + waveform passes", () => {
  let testDir: string;
  let outputDir: string;
  let inputPath: string;
  let logPath: string;
  let logger: LoggerPort;

  const makeTranscoder = () =>
    new FfmpegTranscoder({
      ffmpegPath: FAKE_FFMPEG,
      tempDir: testDir,
      logger,
    });

  const readTimings = async (): Promise<TimingRecord[]> => {
    const raw = await readFile(logPath, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TimingRecord);
  };

  const span = (records: TimingRecord[], mode: TimingRecord["mode"]) => {
    const start = records.find((r) => r.mode === mode && r.phase === "start");
    const end = records.find((r) => r.mode === mode && r.phase === "end");
    expect(start, `${mode} pass never started`).toBeDefined();
    expect(end, `${mode} pass never finished`).toBeDefined();
    return { start: start!.t, end: end!.t };
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), `ffmpeg-conc-${randomUUID().slice(0, 8)}`);
    outputDir = join(testDir, "hls");
    await mkdir(outputDir, { recursive: true });

    inputPath = join(testDir, "source.mp3");
    await writeFile(inputPath, "not-really-audio");

    logPath = join(testDir, "timings.ndjson");
    await writeFile(logPath, "");

    process.env.FAKE_FFMPEG_LOG = logPath;
    // Generous relative to the thing being measured: the overlap assertion's
    // margin IS this delay, so it must comfortably exceed the jitter of two
    // Node processes booting on a saturated CI runner.
    process.env.FAKE_FFMPEG_DELAY_MS = "400";
    delete process.env.FAKE_FFMPEG_WAVEFORM_DELAY_MS;
    delete process.env.FAKE_FFMPEG_WAVEFORM_FAIL;
    delete process.env.FAKE_FFMPEG_HLS_FAIL;

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as LoggerPort;
  });

  afterEach(async () => {
    delete process.env.FAKE_FFMPEG_LOG;
    delete process.env.FAKE_FFMPEG_DELAY_MS;
    delete process.env.FAKE_FFMPEG_WAVEFORM_DELAY_MS;
    delete process.env.FAKE_FFMPEG_WAVEFORM_FAIL;
    delete process.env.FAKE_FFMPEG_HLS_FAIL;
    await rm(testDir, { recursive: true, force: true });
  });

  it("runs the waveform pass concurrently with the HLS encode", async () => {
    const result = await makeTranscoder().transcode({
      inputPath,
      outputDir,
      baseName: "audio",
    });

    const records = await readTimings();
    const hls = span(records, "hls");
    const waveform = span(records, "waveform");

    // Overlap, not back-to-back. This is the whole point of the change: with
    // the old serial code the waveform pass could not start until the HLS
    // encode had already exited.
    expect(waveform.start).toBeLessThan(hls.end);
    expect(hls.start).toBeLessThan(waveform.end);

    // Both passes still produced their outputs.
    expect(result.segments).toHaveLength(2);
    expect(result.playlistFilename).toBe("audio.m3u8");
    expect(result.totalDuration).toBeCloseTo(12, 5);
    expect(result.waveformPeaks).toHaveLength(200);
    expect(Math.max(...result.waveformPeaks)).toBeCloseTo(1, 5);
  });

  it("keeps the ffmpeg_transcode_complete log line and its fields", async () => {
    const result = await makeTranscoder().transcode({
      inputPath,
      outputDir,
      baseName: "audio",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "ffmpeg_transcode_complete",
      expect.objectContaining({
        playlistPath: result.playlistPath,
        segmentCount: 2,
        totalDuration: result.totalDuration,
        transcodingTimeMs: expect.any(Number),
        waveformPeakCount: 200,
      }),
    );
  });

  it("still succeeds with empty peaks when the waveform pass fails", async () => {
    process.env.FAKE_FFMPEG_WAVEFORM_FAIL = "1";

    const result = await makeTranscoder().transcode({
      inputPath,
      outputDir,
      baseName: "audio",
    });

    // Fault-tolerance contract: a waveform failure degrades to [] and MUST NOT
    // reject the transcode.
    expect(result.waveformPeaks).toEqual([]);
    expect(result.segments).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "waveform_extraction_failed",
      expect.objectContaining({ inputPath }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "ffmpeg_transcode_complete",
      expect.objectContaining({ waveformPeakCount: 0 }),
    );
  });

  it("kills the in-flight waveform child when the HLS pass fails", async () => {
    // The HLS pass fails fast while the waveform pass is still decoding. Run
    // concurrently, that child would otherwise outlive the rejected transcode
    // — decoding into a buffer nobody reads, on an instance Pub/Sub is about
    // to redeliver to. Under the old serial code it could never have started.
    process.env.FAKE_FFMPEG_HLS_FAIL = "1";
    // Long enough that the waveform child has certainly booted and logged its
    // pid before the HLS pass fails. (At 100ms the kill lands mid-boot — which
    // is correct behaviour, but leaves the test nothing to observe.)
    process.env.FAKE_FFMPEG_DELAY_MS = "1500";
    process.env.FAKE_FFMPEG_WAVEFORM_DELAY_MS = "30000";

    await expect(
      makeTranscoder().transcode({ inputPath, outputDir, baseName: "audio" }),
    ).rejects.toMatchObject({ code: "ffmpeg_failed" });

    const records = await readTimings();
    const waveformStart = records.find(
      (r) => r.mode === "waveform" && r.phase === "start",
    );
    expect(waveformStart, "waveform pass never started").toBeDefined();

    // It cannot have finished on its own: its delay is 30s and the transcode
    // rejected in ~100ms. So if the pid is gone, it was killed.
    expect(
      records.some((r) => r.mode === "waveform" && r.phase === "end"),
    ).toBe(false);

    const pid = waveformStart!.pid;
    const alive = () => {
      try {
        process.kill(pid, 0); // signal 0 = liveness probe, kills nothing
        return true;
      } catch {
        return false; // ESRCH — reaped and gone
      }
    };

    // Allow a beat for the SIGKILL to land and for Node to reap the zombie
    // (a zombie still answers `kill(pid, 0)`).
    const deadline = Date.now() + 5_000;
    while (alive() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(alive(), `waveform child ${pid} survived the failed HLS pass`).toBe(
      false,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "waveform_pass_killed",
      expect.objectContaining({ pid }),
    );
  }, 40_000);

  it("still rejects with ffmpeg_failed when the HLS pass fails", async () => {
    // A transcoder pointed at a binary that does not exist: the HLS pass must
    // still surface its own error, not be masked by the concurrent waveform
    // pass swallowing everything.
    const transcoder = new FfmpegTranscoder({
      ffmpegPath: join(testDir, "definitely-not-ffmpeg"),
      tempDir: testDir,
      logger,
    });

    await expect(
      transcoder.transcode({ inputPath, outputDir, baseName: "audio" }),
    ).rejects.toMatchObject({ code: "ffmpeg_failed" });
  });
});
