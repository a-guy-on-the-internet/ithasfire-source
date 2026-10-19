import { describe, expect, it, vi } from "vitest";

import type { AudioUploadRecord } from "@th/ports/repos/audio-uploads";

import {
  finalizeEventAudioUpload,
  type FinalizeEventAudioUploadDeps,
} from "../finalize-event-audio-upload";

// F11 (2026-09-29): the audio quota is charged from `sourceSizeBytes` at
// request time, so finalize must refuse (and delete) a bigger object. Also
// pins the missing-object branch: `headObject` answers `{ exists: false }`
// rather than throwing, and the old try/catch marked such uploads UPLOADED.

const EVENT_ID = "50000000-0000-4000-8000-000000000001";
const ACTOR_ID = "50000000-0000-4000-8000-000000000002";
const AUDIO_ID = "50000000-0000-4000-8000-000000000003";
const SOURCE_KEY = `uploads/audio/${AUDIO_ID}.mp3`;
const NOW = new Date("2026-09-29T12:00:00.000Z");

function makeAudioUpload(): AudioUploadRecord {
  return {
    id: AUDIO_ID,
    eventId: EVENT_ID,
    sourceKey: SOURCE_KEY,
    sourceUrl: "",
    sourceContentType: "audio/mpeg",
    sourceSizeBytes: 5000n,
    hlsPlaylistKey: null,
    hlsPlaylistUrl: null,
    segmentCount: null,
    durationSeconds: null,
    waveformPeaks: null,
    status: "PENDING",
    uploadedAt: null,
    transcodedAt: null,
    failedAt: null,
    failureReason: null,
    attached: false,
    attachedAt: null,
    detachedAt: null,
    deletedAt: null,
    createdByHumanId: ACTOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
  } as AudioUploadRecord;
}

function makeDeps(head: { exists: boolean; size?: number }) {
  const markUploaded = vi.fn(async () => undefined);
  const enqueueTranscodeJob = vi.fn(async () => undefined);
  const fileStorage = {
    headObject: vi.fn(async () => head),
    deleteObject: vi.fn(async () => ({ ok: true as const })),
  };
  const deps: FinalizeEventAudioUploadDeps = {
    repos: {
      events: { getById: vi.fn(async () => null) },
      audioUploads: {
        getById: vi.fn(async () => makeAudioUpload()),
        markUploaded,
      },
      tx: vi.fn(),
    } as unknown as FinalizeEventAudioUploadDeps["repos"],
    authz: { canEditEvent: vi.fn(async () => ({ allowed: true })) } as any,
    fileStorage,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as FinalizeEventAudioUploadDeps["logger"],
    enqueueTranscodeJob,
  };
  return { deps, fileStorage, markUploaded, enqueueTranscodeJob };
}

describe("finalizeEventAudioUpload size gate", () => {
  it("deletes and rejects a source bigger than the declared sourceSizeBytes", async () => {
    const { deps, fileStorage, markUploaded, enqueueTranscodeJob } = makeDeps({
      exists: true,
      size: 50_000_000,
    });

    await expect(
      finalizeEventAudioUpload(deps, {
        actorHumanId: ACTOR_ID,
        audioUploadId: AUDIO_ID,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "upload_size_exceeded",
    });
    expect(fileStorage.deleteObject).toHaveBeenCalledWith({ key: SOURCE_KEY });
    expect(markUploaded).not.toHaveBeenCalled();
    expect(enqueueTranscodeJob).not.toHaveBeenCalled();
  });

  it("refuses to mark a never-uploaded source as UPLOADED", async () => {
    const { deps, fileStorage, markUploaded } = makeDeps({ exists: false });

    await expect(
      finalizeEventAudioUpload(deps, {
        actorHumanId: ACTOR_ID,
        audioUploadId: AUDIO_ID,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_NOT_COMPLETE" });
    expect(fileStorage.deleteObject).not.toHaveBeenCalled();
    expect(markUploaded).not.toHaveBeenCalled();
  });

  it("finalizes a source that matches its declared size", async () => {
    const { deps, fileStorage, markUploaded, enqueueTranscodeJob } = makeDeps({
      exists: true,
      size: 5000,
    });

    await expect(
      finalizeEventAudioUpload(deps, {
        actorHumanId: ACTOR_ID,
        audioUploadId: AUDIO_ID,
      }),
    ).resolves.toEqual({ audioUploadId: AUDIO_ID, status: "UPLOADED" });
    expect(fileStorage.deleteObject).not.toHaveBeenCalled();
    expect(markUploaded).toHaveBeenCalledTimes(1);
    expect(enqueueTranscodeJob).toHaveBeenCalledTimes(1);
  });

  it("reports (and swallows) a failed transcode enqueue", async () => {
    const { deps, markUploaded, enqueueTranscodeJob } = makeDeps({
      exists: true,
      size: 5000,
    });
    const boom = new Error("pubsub down");
    enqueueTranscodeJob.mockRejectedValueOnce(boom);
    const reportError = vi.fn();

    await expect(
      finalizeEventAudioUpload(
        { ...deps, reportError },
        { actorHumanId: ACTOR_ID, audioUploadId: AUDIO_ID },
      ),
    ).resolves.toEqual({ audioUploadId: AUDIO_ID, status: "UPLOADED" });
    expect(markUploaded).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ area: "audio_transcode_enqueue" }),
        extra: expect.objectContaining({ audioUploadId: AUDIO_ID }),
      }),
    );
  });

  it("a throwing reporter doesn't fail the finalize", async () => {
    const { deps, enqueueTranscodeJob } = makeDeps({
      exists: true,
      size: 5000,
    });
    enqueueTranscodeJob.mockRejectedValueOnce(new Error("pubsub down"));

    await expect(
      finalizeEventAudioUpload(
        {
          ...deps,
          reportError: () => {
            throw new Error("sentry down");
          },
        },
        { actorHumanId: ACTOR_ID, audioUploadId: AUDIO_ID },
      ),
    ).resolves.toEqual({ audioUploadId: AUDIO_ID, status: "UPLOADED" });
  });
});
