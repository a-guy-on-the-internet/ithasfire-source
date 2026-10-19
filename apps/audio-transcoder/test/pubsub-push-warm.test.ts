import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * `/pubsub/push` and the upload-start warm-up message.
 *
 * Prod runs this service at min 0 instances (owner, 2026-10-17). The API
 * publishes `{ kind: "warm" }` (attribute kind=warm) when an organiser STARTS
 * an upload; delivering that push request is what boots an instance. The
 * handler must ack it with a 2xx and do nothing: no transcode, no validation
 * error, no retry, no dead letter.
 */

const { transcodeAudio } = vi.hoisted(() => ({ transcodeAudio: vi.fn() }));

vi.mock("../src/lib/container", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return {
    buildContainer: vi.fn(async () => ({
      logger,
      transcoder: { isAvailable: vi.fn(async () => true) },
      close: vi.fn(async () => undefined),
    })),
  };
});

vi.mock("../src/use-cases/transcode-audio", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/use-cases/transcode-audio")>();
  return { ...actual, transcodeAudio };
});

import { createApp } from "../src/app";

const TRANSCODE_PAYLOAD = {
  audioUploadId: "550e8400-e29b-41d4-a716-446655440000",
  eventId: "550e8400-e29b-41d4-a716-446655440001",
  sourceKey: "uploads/audio/550e8400-e29b-41d4-a716-446655440000.mp3",
  outputPrefix: "events/550e8400-e29b-41d4-a716-446655440001/audio/test",
};

const envelope = (data: unknown, attributes?: Record<string, string>) => ({
  message: {
    data: Buffer.from(JSON.stringify(data)).toString("base64"),
    messageId: "msg-1",
    ...(attributes ? { attributes } : {}),
  },
  subscription: "projects/p/subscriptions/s",
});

describe("POST /pubsub/push — warm-up", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await createApp());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    transcodeAudio.mockReset();
  });

  it("acks the API's warm message (body + attribute) with a 200 and does not transcode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/pubsub/push",
      payload: envelope({ kind: "warm" }, { kind: "warm" }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, warm: true });
    expect(transcodeAudio).not.toHaveBeenCalled();
  });

  it("recognises the warm body alone", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/pubsub/push",
      payload: envelope({ kind: "warm" }),
    });

    expect(res.statusCode).toBe(200);
    expect(transcodeAudio).not.toHaveBeenCalled();
  });

  it("recognises the kind=warm attribute alone", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/pubsub/push",
      payload: envelope({}, { kind: "warm" }),
    });

    expect(res.statusCode).toBe(200);
    expect(transcodeAudio).not.toHaveBeenCalled();
  });

  it("a normal transcode message still transcodes", async () => {
    transcodeAudio.mockResolvedValueOnce({
      audioUploadId: TRANSCODE_PAYLOAD.audioUploadId,
      playlistUrl: "https://cdn.example/playlist.m3u8",
      processingTimeMs: 12,
    });

    const res = await app.inject({
      method: "POST",
      url: "/pubsub/push",
      payload: envelope(TRANSCODE_PAYLOAD),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      audioUploadId: TRANSCODE_PAYLOAD.audioUploadId,
      playlistUrl: "https://cdn.example/playlist.m3u8",
    });
    expect(transcodeAudio).toHaveBeenCalledTimes(1);
    expect(transcodeAudio.mock.calls[0]?.[1]).toMatchObject(TRANSCODE_PAYLOAD);
  });

  it("a payload that is neither warm nor a transcode is still refused", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/pubsub/push",
      payload: envelope({ kind: "cold" }),
    });

    expect(res.statusCode).toBe(400);
    expect(transcodeAudio).not.toHaveBeenCalled();
  });
});
