import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock google-auth-library so getAccessToken returns a deterministic token
// without touching ADC / the network.
const getAccessToken = vi.fn(async () => ({ token: "fake-access-token" }));
const getClient = vi.fn(async () => ({ getAccessToken }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({ getClient })),
}));

import { dispatchTranscodeJob, warmTranscoder } from "../events";

const PAYLOAD = {
  audioUploadId: "11111111-1111-1111-1111-111111111111",
  sourceKey: "events/evt/audio/src.mp3",
  outputPrefix: "events/evt/audio/aud",
  eventId: "22222222-2222-2222-2222-222222222222",
  deleteSourceOnSuccess: true,
};

const okResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    text: async () => "",
  }) as unknown as Response;

/** Let the fire-and-forget dispatch promise chain settle. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("dispatchTranscodeJob", () => {
  const ORIGINAL_ENV = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    child: ReturnType<typeof vi.fn>;
  };
  let markTranscoding: ReturnType<typeof vi.fn>;
  let markFailed: ReturnType<typeof vi.fn>;

  const makeDeps = () => ({
    logger: logger as never,
    markTranscoding,
    markFailed,
  });

  beforeEach(() => {
    delete process.env.AUDIO_TRANSCODE_TOPIC;
    delete process.env.AUDIO_TRANSCODER_URL;

    fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);

    markTranscoding = vi.fn(async () => undefined);
    markFailed = vi.fn(async () => undefined);

    getClient.mockClear();
    getAccessToken.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("publishes to Pub/Sub when AUDIO_TRANSCODE_TOPIC is set", async () => {
    const topic = "projects/hf-491918/topics/hf-dev-audio-transcoder-transcode";
    process.env.AUDIO_TRANSCODE_TOPIC = topic;

    await dispatchTranscodeJob(PAYLOAD, makeDeps());
    await flush();

    // Marks TRANSCODING before dispatching.
    expect(markTranscoding).toHaveBeenCalledWith({ id: PAYLOAD.audioUploadId });
    expect(markTranscoding.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0] ?? 0,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://pubsub.googleapis.com/v1/${topic}:publish`);

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fake-access-token");

    const body = JSON.parse(init.body as string) as {
      messages: { data: string }[];
    };
    const messageData = body.messages[0]?.data ?? "";
    const decoded = JSON.parse(
      Buffer.from(messageData, "base64").toString("utf-8"),
    );
    expect(decoded).toEqual(PAYLOAD);

    expect(markFailed).not.toHaveBeenCalled();
  });

  it("falls back to direct /transcode fetch when only AUDIO_TRANSCODER_URL is set", async () => {
    process.env.AUDIO_TRANSCODER_URL = "http://localhost:8080";

    await dispatchTranscodeJob(PAYLOAD, makeDeps());
    await flush();

    expect(markTranscoding).toHaveBeenCalledWith({ id: PAYLOAD.audioUploadId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/transcode");

    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();

    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
    expect(getClient).not.toHaveBeenCalled();
  });

  it("skips with a warning when neither env var is set", async () => {
    await dispatchTranscodeJob(PAYLOAD, makeDeps());
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(markTranscoding).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping transcode enqueue"),
      { audioUploadId: PAYLOAD.audioUploadId },
    );
  });

  it("logs 'Transcode job failed' and marks failed on a non-ok Pub/Sub response", async () => {
    process.env.AUDIO_TRANSCODE_TOPIC = "projects/p/topics/t";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "permission denied",
    } as unknown as Response);

    await dispatchTranscodeJob(PAYLOAD, makeDeps());
    await flush();
    await flush();

    expect(logger.error).toHaveBeenCalledWith("Transcode job failed", {
      audioUploadId: PAYLOAD.audioUploadId,
      status: 403,
      body: "permission denied",
    });
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PAYLOAD.audioUploadId,
        failureReason: "Transcoder responded 403: permission denied",
      }),
    );
  });
});

describe("warmTranscoder", () => {
  const ORIGINAL_ENV = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  const warmDeps = () => ({ logger: logger as never });

  beforeEach(() => {
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    delete process.env.AUDIO_TRANSCODE_TOPIC;
    delete process.env.AUDIO_TRANSCODER_URL;
    fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    getClient.mockClear();
    getAccessToken.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("publishes one { kind: 'warm' } message, with a kind=warm attribute, to the transcode topic", async () => {
    const topic =
      "projects/hf-491918/topics/hf-prod-audio-transcoder-transcode";
    process.env.AUDIO_TRANSCODE_TOPIC = topic;

    await warmTranscoder(warmDeps());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://pubsub.googleapis.com/v1/${topic}:publish`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fake-access-token");

    const body = JSON.parse(init.body as string) as {
      messages: { data: string; attributes?: Record<string, string> }[];
    };
    expect(body.messages).toHaveLength(1);
    const message = body.messages[0];
    expect(message?.attributes).toEqual({ kind: "warm" });
    expect(
      JSON.parse(Buffer.from(message?.data ?? "", "base64").toString("utf-8")),
    ).toEqual({ kind: "warm" });
  });

  it("locally GETs the transcoder's /health instead", async () => {
    process.env.AUDIO_TRANSCODER_URL = "http://localhost:8080";

    await warmTranscoder(warmDeps());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8080/health");
    expect(init.method).toBeUndefined();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("locally, an unreachable transcoder resolves quietly: warn only, nothing to report", async () => {
    process.env.AUDIO_TRANSCODER_URL = "http://localhost:8080";
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(warmTranscoder(warmDeps())).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      "Local audio transcoder not reachable for warm-up",
      { error: "fetch failed" },
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("locally, a non-ok /health resolves quietly with a warn", async () => {
    process.env.AUDIO_TRANSCODER_URL = "http://localhost:8080";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "",
    } as unknown as Response);

    await expect(warmTranscoder(warmDeps())).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      "Local audio transcoder warm-up got a non-ok status",
      { status: 503 },
    );
  });

  it("does nothing when neither env var is set", async () => {
    await warmTranscoder(warmDeps());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects on a non-ok publish so the use case can report it", async () => {
    process.env.AUDIO_TRANSCODE_TOPIC = "projects/p/topics/t";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "permission denied",
    } as unknown as Response);

    await expect(warmTranscoder(warmDeps())).rejects.toThrow(
      "Transcoder warm-up responded 403: permission denied",
    );
  });

  it("existing transcode jobs publish without attributes, unchanged", async () => {
    process.env.AUDIO_TRANSCODE_TOPIC = "projects/p/topics/t";

    await dispatchTranscodeJob(PAYLOAD, {
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
      } as never,
      markTranscoding: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    });
    await flush();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Record<string, unknown>[];
    };
    expect(Object.keys(body.messages[0] ?? {})).toEqual(["data"]);
  });
});
