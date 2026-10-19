import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  transcodeAudio,
  runWithConcurrency,
} from "../src/use-cases/transcode-audio";

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
//
// The use case is exercised end-to-end with a fake transcoder + fake storage,
// so these assertions cover the ORDERING and FAILURE semantics of the upload
// step (the parts that a partially-uploaded HLS render would break), not
// ffmpeg itself — that lives in ffmpeg-transcoder.test.ts / e2e-transcode.
// ─────────────────────────────────────────────────────────────────────────────

const makeLogger = () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
};

type PutCall = {
  key: string;
  contentType?: string;
  public?: boolean;
  /** Monotonic order in which the put STARTED. */
  startedAt: number;
  /** Monotonic order in which the put RESOLVED. */
  settledAt?: number;
};

const OUTPUT_PREFIX = "events/e1/audio/a1";
const SOURCE_KEY = "audio/source/track.mp3";

describe("transcodeAudio — HLS upload step", () => {
  let workRoot: string;
  let hlsDir: string;

  beforeEach(async () => {
    workRoot = join(tmpdir(), `transcode-uc-${randomUUID().slice(0, 8)}`);
    hlsDir = join(workRoot, "hls-src");
    await mkdir(hlsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  /**
   * Writes `count` fake .ts segments plus a playlist to disk and returns a
   * transcoder stub that reports them.
   */
  const buildFixture = async (count: number) => {
    const segments = [];
    for (let i = 0; i < count; i++) {
      const filename = `audio_${String(i).padStart(3, "0")}.ts`;
      const path = join(hlsDir, filename);
      await writeFile(path, `segment-${i}`);
      segments.push({ filename, path, duration: 6, index: i });
    }

    const playlistPath = join(hlsDir, "audio.m3u8");
    await writeFile(playlistPath, "#EXTM3U\n");

    return {
      segments,
      playlistPath,
      playlistFilename: "audio.m3u8",
      totalDuration: count * 6,
      transcodingTimeMs: 1,
      waveformPeaks: [0.5, 1],
    };
  };

  const buildDeps = (
    transcodeResult: Awaited<ReturnType<typeof buildFixture>>,
    opts: {
      /** Key whose upload should reject. */
      failKey?: string;
      /** Artificial latency per put, so concurrency is observable. */
      putDelayMs?: number;
    } = {},
  ) => {
    const puts: PutCall[] = [];
    let tick = 0;
    let inFlight = 0;
    let maxInFlight = 0;

    const fileStorage = {
      getObjectUrl: vi.fn(async () => ({
        url: "https://example.test/source.mp3",
      })),
      putObject: vi.fn(async (input: any) => {
        const call: PutCall = {
          key: input.key,
          contentType: input.options?.contentType,
          public: input.options?.public,
          startedAt: tick++,
        };
        puts.push(call);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);

        await new Promise((r) => setTimeout(r, opts.putDelayMs ?? 1));

        inFlight -= 1;
        call.settledAt = tick++;

        if (opts.failKey && input.key === opts.failKey) {
          throw { code: "transient", message: "R2 said no" };
        }
        return { url: `https://cdn.test/${input.key}` };
      }),
      deleteObject: vi.fn(async () => ({ ok: true })),
    };

    const markTranscoded = vi.fn(async () => ({}));

    const deps = {
      repos: { audioUploads: { markTranscoded } },
      logger: makeLogger(),
      clock: { now: () => new Date("2026-09-03T00:00:00.000Z") },
      fileStorage,
      transcoder: { transcode: vi.fn(async () => transcodeResult) },
      tempDir: workRoot,
    };

    return {
      deps: deps as unknown as Parameters<typeof transcodeAudio>[0],
      puts,
      fileStorage,
      markTranscoded,
      stats: () => ({ maxInFlight }),
    };
  };

  const input = {
    audioUploadId: "550e8400-e29b-41d4-a716-446655440000",
    eventId: "550e8400-e29b-41d4-a716-446655440001",
    sourceKey: SOURCE_KEY,
    outputPrefix: OUTPUT_PREFIX,
    deleteSourceOnSuccess: false,
  };

  // The use case downloads the source over `fetch` before transcoding; stub it
  // with a tiny body so the pipeline reaches the upload step.
  const stubFetch = () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads every segment exactly once, with the right keys, before the playlist", async () => {
    stubFetch();
    const fixture = await buildFixture(21);
    const { deps, puts, stats } = buildDeps(fixture);

    const result = await transcodeAudio(deps, input);

    const playlistKey = `${OUTPUT_PREFIX}/audio.m3u8`;
    const segmentPuts = puts.filter((p) => p.key !== playlistKey);
    const playlistPuts = puts.filter((p) => p.key === playlistKey);

    // Exactly one put per segment, no duplicates, no misses.
    expect(segmentPuts).toHaveLength(21);
    expect(new Set(segmentPuts.map((p) => p.key)).size).toBe(21);
    expect(segmentPuts.map((p) => p.key).sort()).toEqual(
      fixture.segments.map((s) => `${OUTPUT_PREFIX}/${s.filename}`).sort(),
    );

    // Content type and public flag preserved verbatim.
    for (const put of segmentPuts) {
      expect(put.contentType).toBe("video/mp2t");
      expect(put.public).toBe(true);
    }

    // The playlist went up exactly once, and STRICTLY after every segment had
    // already settled. A playlist visible before its segments is a broken
    // player, so this is the load-bearing assertion of the whole change.
    expect(playlistPuts).toHaveLength(1);
    const playlistStart = playlistPuts[0]!.startedAt;
    for (const seg of segmentPuts) {
      expect(seg.settledAt).toBeDefined();
      expect(seg.settledAt!).toBeLessThan(playlistStart);
    }
    expect(playlistPuts[0]!.contentType).toBe("application/vnd.apple.mpegurl");
    expect(playlistPuts[0]!.public).toBe(true);

    // The pool actually ran concurrently, and stayed bounded at 8.
    expect(stats().maxInFlight).toBeGreaterThan(1);
    expect(stats().maxInFlight).toBeLessThanOrEqual(8);

    expect(result.segmentCount).toBe(21);
    expect(result.playlistKey).toBe(playlistKey);
  });

  it("rejects with upload_failed when a mid-pool segment upload fails, and never uploads the playlist", async () => {
    stubFetch();
    const fixture = await buildFixture(30);
    // Segment 12 is mid-pool: it starts after the first batch is under way.
    const failKey = `${OUTPUT_PREFIX}/${fixture.segments[12]!.filename}`;
    const { deps, puts, markTranscoded, fileStorage } = buildDeps(fixture, {
      failKey,
      putDelayMs: 2,
    });

    await expect(transcodeAudio(deps, input)).rejects.toMatchObject({
      code: "upload_failed",
      // Names the segment that failed, so the route log is actionable.
      message: `Failed to upload HLS segment ${failKey}`,
    });

    // The playlist MUST NOT have been written — that is the difference between
    // "nothing published" and "a playlist pointing at 404s".
    const playlistKey = `${OUTPUT_PREFIX}/audio.m3u8`;
    expect(puts.some((p) => p.key === playlistKey)).toBe(false);

    // And nothing downstream ran.
    expect(markTranscoded).not.toHaveBeenCalled();
    expect(fileStorage.deleteObject).not.toHaveBeenCalled();

    // Two bounds, each carrying its own weight. With 30 segments, concurrency
    // 8 and the failure at index 12:
    // - ABOVE 13: serial-with-abort would stop at exactly 13 puts (indices
    //   0..12), so exceeding that proves the uploads really did overlap. This
    //   is what makes the assertion distinguishing rather than decorative.
    // - BELOW 30: `while (!failed)` stopped the pool. Reaching 30 would mean
    //   the failure was ignored and the whole tail still went up.
    // Deliberately not a tight upper bound: each task does its own `readFile`
    // before the put, so exactly how many workers claim one more index before
    // the rejection lands is filesystem-scheduling dependent (observed 21).
    expect(puts.length).toBeGreaterThan(13);
    expect(puts.length).toBeLessThan(30);
  });

  it("surfaces the FIRST failure even when later segments resolve fine", async () => {
    stubFetch();
    const fixture = await buildFixture(9);
    const failKey = `${OUTPUT_PREFIX}/${fixture.segments[0]!.filename}`;
    const { deps } = buildDeps(fixture, { failKey, putDelayMs: 2 });

    // Segment 0 rejects while segments 1–7 are in flight and will resolve
    // after it. A rejection must not be swallowed by those later resolves.
    await expect(transcodeAudio(deps, input)).rejects.toMatchObject({
      code: "upload_failed",
    });
  });

  it("still succeeds when the transcoder returns no waveform peaks", async () => {
    stubFetch();
    const fixture = await buildFixture(3);
    // extractWaveformPeaks is fault-tolerant and yields [] on any failure.
    const { deps, markTranscoded } = buildDeps({
      ...fixture,
      waveformPeaks: [],
    });

    const result = await transcodeAudio(deps, input);

    expect(result.segmentCount).toBe(3);
    expect(result.playlistUrl).toContain(`${OUTPUT_PREFIX}/audio.m3u8`);
    // An empty peak array is passed as `undefined` rather than persisted as [].
    expect(markTranscoded).toHaveBeenCalledWith(
      expect.objectContaining({ waveformPeaks: undefined }),
    );
  });
});

describe("runWithConcurrency", () => {
  it("rejects a concurrency below 1 instead of silently doing nothing", async () => {
    // `Math.min(0, n)` would spawn zero workers, `Promise.all([])` resolves,
    // and the caller would be told every item succeeded having processed none
    // — which for the segment upload means a playlist over missing segments.
    const task = vi.fn(async () => {});

    for (const bad of [0, -1]) {
      await expect(runWithConcurrency([1, 2, 3], bad, task)).rejects.toThrow(
        /concurrency >= 1/,
      );
    }
    expect(task).not.toHaveBeenCalled();
  });

  it("is a no-op on an empty list", async () => {
    const task = vi.fn(async () => {});
    await expect(runWithConcurrency([], 8, task)).resolves.toBeUndefined();
    expect(task).not.toHaveBeenCalled();
  });

  it("processes every item when concurrency exceeds the item count", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 8, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });
});
