/**
 * `loadEventAudio`: the public event page's server read of the description's
 * audio URLs. A failure degrades to `[]`: the renderer then falls back to
 * URLs baked into the saved doc (possibly expired presigned links) or, with
 * none, the placeholder, so buyers may get no audio. It must be REPORTED; a
 * console line alone never reaches Sentry.
 */
import { TRPCClientError } from "@trpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureExceptionMock, resolveAudioQuery } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  resolveAudioQuery: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: captureExceptionMock,
}));

vi.mock("@/server/trpc-client", () => ({
  getServerTrpcClient: () => ({
    events: { resolveAudio: { query: resolveAudioQuery } },
  }),
  getPublicTrpcClient: vi.fn(),
}));

import { loadEventAudio } from "@/server/events";

let n = 0;
/** A fresh id per call, so React's `cache` can never hand back a prior result. */
const nextEventId = () => `33333333-3333-4333-8333-${String(++n).padStart(12, "0")}`;

const trpcError = (message: string, data: Record<string, unknown>) =>
  new TRPCClientError(message, { result: { error: { data } } } as never);

beforeEach(() => {
  vi.clearAllMocks();
  captureExceptionMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadEventAudio", () => {
  it("maps items, keeping the original file URL beside the playlist", async () => {
    const eventId = nextEventId();
    resolveAudioQuery.mockResolvedValue({
      items: [
        {
          id: "au-1",
          hlsPlaylistUrl: null,
          sourceUrl: "https://minio.example.com/a.mp3?sig=1",
          status: "FAILED",
          waveformPeaks: null,
        },
      ],
    });

    await expect(loadEventAudio(eventId)).resolves.toEqual([
      {
        id: "au-1",
        hlsPlaylistUrl: null,
        sourceUrl: "https://minio.example.com/a.mp3?sig=1",
        status: "FAILED",
        waveformPeaks: null,
      },
    ]);
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("degrades to [] and reports a failure", async () => {
    const eventId = nextEventId();
    const err = new TypeError("fetch failed");
    resolveAudioQuery.mockRejectedValue(err);

    await expect(loadEventAudio(eventId)).resolves.toEqual([]);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(err, {
      tags: { area: "event-page-ssr", section: "audio" },
      extra: { eventId },
    });
    // The log line stays alongside the report.
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("reports a rate limit at warning, under one fingerprint", async () => {
    const eventId = nextEventId();
    const err = trpcError("Too many requests", {
      code: "TOO_MANY_REQUESTS",
      httpStatus: 429,
    });
    resolveAudioQuery.mockRejectedValue(err);

    await expect(loadEventAudio(eventId)).resolves.toEqual([]);
    expect(captureExceptionMock).toHaveBeenCalledWith(err, {
      tags: { area: "event-page-ssr", section: "audio" },
      extra: { eventId },
      level: "warning",
      fingerprint: ["event-page-ssr", "audio", "TOO_MANY_REQUESTS"],
    });
  });

  it.each([
    ["NOT_FOUND", 404, "EVENT_NOT_FOUND"],
    ["FORBIDDEN", 403, "FORBIDDEN"],
  ])(
    "stays silent on the read gate's own %s",
    async (code, httpStatus, appCode) => {
      resolveAudioQuery.mockRejectedValue(
        trpcError(appCode, { code, httpStatus, appCode }),
      );

      await expect(loadEventAudio(nextEventId())).resolves.toEqual([]);
      expect(captureExceptionMock).not.toHaveBeenCalled();
    },
  );

  it("REPORTS tRPC's missing-procedure NOT_FOUND (no appCode: version skew)", async () => {
    const err = trpcError('No procedure found on path "events.resolveAudio"', {
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    resolveAudioQuery.mockRejectedValue(err);

    await expect(loadEventAudio(nextEventId())).resolves.toEqual([]);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it("still degrades to [] when the reporter itself throws", async () => {
    resolveAudioQuery.mockRejectedValue(new Error("down"));
    captureExceptionMock.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(loadEventAudio(nextEventId())).resolves.toEqual([]);
  });
});
