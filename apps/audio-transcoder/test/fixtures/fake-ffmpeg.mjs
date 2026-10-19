#!/usr/bin/env node
/**
 * A stand-in for the `ffmpeg` binary, used by ffmpeg-transcoder-concurrency.test.ts.
 *
 * Real ffmpeg is not a dependency we can rely on in CI (and the transcode of a
 * real fixture takes seconds), but the thing under test is the SCHEDULING of
 * the two passes, not the encoding. So this script does the minimum each pass
 * needs, sleeps for a known duration, and records start/end timestamps to a
 * log file so the test can prove the two runs overlapped.
 *
 * Controlled entirely through env vars (spawn inherits process.env):
 * - FAKE_FFMPEG_LOG                path to the NDJSON timing log (required)
 * - FAKE_FFMPEG_DELAY_MS           how long each pass "takes" (default 150)
 * - FAKE_FFMPEG_WAVEFORM_DELAY_MS  overrides the delay for the waveform pass
 * - FAKE_FFMPEG_WAVEFORM_FAIL      when "1", the waveform pass exits non-zero
 * - FAKE_FFMPEG_HLS_FAIL           when "1", the HLS pass exits non-zero
 *
 * Each pass logs its own pid on "start" so a test can check liveness with
 * `process.kill(pid, 0)`, and only logs "end" if it ran to completion — so a
 * missing "end" plus a dead pid proves it was killed rather than finished.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const logPath = process.env.FAKE_FFMPEG_LOG;

// The waveform pass is the one that writes raw PCM to stdout.
const mode = args.includes("pipe:1") ? "waveform" : "hls";

const baseDelayMs = Number(process.env.FAKE_FFMPEG_DELAY_MS ?? "150");
const delayMs =
  mode === "waveform" && process.env.FAKE_FFMPEG_WAVEFORM_DELAY_MS
    ? Number(process.env.FAKE_FFMPEG_WAVEFORM_DELAY_MS)
    : baseDelayMs;

const record = (phase) => {
  if (!logPath) return;
  appendFileSync(
    logPath,
    JSON.stringify({ mode, phase, t: Date.now(), pid: process.pid }) + "\n",
  );
};

record("start");
await sleep(delayMs);

if (mode === "waveform") {
  if (process.env.FAKE_FFMPEG_WAVEFORM_FAIL === "1") {
    process.stderr.write("fake ffmpeg: waveform pass failed on purpose\n");
    record("end");
    process.exit(1);
  }
  // 400 f32le samples ramping 0 → 1 so the peak normaliser has real input.
  const sampleCount = 400;
  const buf = Buffer.alloc(sampleCount * 4);
  for (let i = 0; i < sampleCount; i++) {
    buf.writeFloatLE((i + 1) / sampleCount, i * 4);
  }
  process.stdout.write(buf);
  record("end");
  process.exit(0);
}

if (process.env.FAKE_FFMPEG_HLS_FAIL === "1") {
  process.stderr.write("fake ffmpeg: hls pass failed on purpose\n");
  record("end");
  process.exit(1);
}

// HLS pass: write two segments and a VOD playlist that references them.
const segmentPattern = args[args.indexOf("-hls_segment_filename") + 1];
const playlistPath = args[args.length - 1];

const segmentNames = [];
for (let i = 0; i < 2; i++) {
  const path = segmentPattern.replace("%03d", String(i).padStart(3, "0"));
  writeFileSync(path, `fake-segment-${i}`);
  segmentNames.push(path.slice(path.lastIndexOf("/") + 1));
}

writeFileSync(
  playlistPath,
  [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    ...segmentNames.flatMap((name) => ["#EXTINF:6.000000,", name]),
    "#EXT-X-ENDLIST",
    "",
  ].join("\n"),
);

record("end");
process.exit(0);
