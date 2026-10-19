import { describe, expect, it, vi } from "vitest";

import {
  requestEventAudioUpload,
  type RequestEventAudioUploadDeps,
} from "../request-event-audio-upload";
import {
  finalizeEventAudioUpload,
  type FinalizeEventAudioUploadDeps,
} from "../finalize-event-audio-upload";
import type { EventRecord } from "@th/ports/repos/events";
import type { AudioUploadRecord } from "@th/ports/repos/audio-uploads";

/**
 * Audio on COMMUNITY listings.
 *
 * Audio had NO community branch at all — neither request nor finalize — which
 * meant it was refused on EVERY community listing at EVERY status, not just
 * drafts: `canEditEvent` resolves an event's org and then its human owner, and
 * an ownerless row has neither, so it always answered false. The EventBuilder
 * mounts the audio uploader next to the image one, so a community listing
 * could carry a body image and never a track.
 *
 * The branch is deliberately NARROWER than the image one — MODERATOR + DRAFT,
 * where images also admit any signed-in user on a PUBLISHED listing. Images
 * have that arm because `heroImageId` is a whitelisted SUGGESTION field, so an
 * outsider's upload lands unattached and waits for approval. Audio has no
 * suggestion field and no approval step (finalize attaches it), so opening it
 * wider would be a content write on a public page outside the moderation
 * queue.
 */

const EVENT_ID = "40000000-0000-4000-8000-000000000001";
const MODERATOR_ID = "40000000-0000-4000-8000-000000000002";
const OTHER_USER_ID = "40000000-0000-4000-8000-000000000003";
const AUDIO_ID = "40000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-07-01T12:00:00.000Z");

function makeCommunityEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: null,
    stewardship: "COMMUNITY",
    attendanceMode: "RSVP",
    status: "DRAFT",
    title: "Community Listing",
    startsAt: NOW,
    endsAt: NOW,
    ...overrides,
  } as EventRecord;
}

function makeAudioUpload(
  overrides: Partial<AudioUploadRecord> = {},
): AudioUploadRecord {
  return {
    id: AUDIO_ID,
    eventId: EVENT_ID,
    sourceKey: `uploads/audio/${AUDIO_ID}.mp3`,
    sourceUrl: "",
    sourceContentType: "audio/mpeg",
    sourceSizeBytes: 1234n,
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
    createdByHumanId: MODERATOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as AudioUploadRecord;
}

// ─── requestEventAudioUpload ─────────────────────────────────────────────────

const REQUEST_INPUT = {
  actorHumanId: MODERATOR_ID,
  eventId: EVENT_ID,
  contentType: "audio/mpeg",
  sizeBytes: 1234,
};

function buildRequestDeps(
  event: EventRecord | null,
  options: { moderator?: boolean } = {},
) {
  const create = vi.fn(async () => makeAudioUpload());
  const canEditEvent = vi.fn(async () => ({ allowed: false }));
  const hasStaffRole = vi.fn(async () => ({
    allowed: options.moderator === true,
  }));
  const getById = vi.fn(async () => event);

  const deps: RequestEventAudioUploadDeps = {
    repos: {
      events: { getById },
      audioUploads: { create },
      resourceQuotas: {
        getEffectiveQuota: vi.fn(async () => ({
          kind: "STORAGE_BYTES_HUMAN" as const,
          limitValue: 10_000_000_000n,
          currentUsage: 0n,
          isOverride: false,
        })),
        hasPendingExpansionRequest: vi.fn(async () => false),
        incrementUsage: vi.fn(async () => ({})),
      },
      tx: vi.fn(),
    } as unknown as RequestEventAudioUploadDeps["repos"],
    authz: { canEditEvent, hasStaffRole },
    fileStorage: {
      presignPutObject: vi.fn(async () => ({
        uploadUrl: "https://r2.example/put",
      })),
    } as unknown as RequestEventAudioUploadDeps["fileStorage"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as RequestEventAudioUploadDeps["logger"],
  };

  return { deps, create, canEditEvent, hasStaffRole, getById };
}

describe("requestEventAudioUpload — COMMUNITY branch", () => {
  it("a COMMUNITY_MODERATOR may upload audio to a DRAFT listing", async () => {
    const { deps, create, canEditEvent } = buildRequestDeps(
      makeCommunityEvent(),
      { moderator: true },
    );

    const result = await requestEventAudioUpload(deps, REQUEST_INPUT);

    expect(result.audioUploadId).toBeTruthy();
    expect(result.uploadUrl).toBeTruthy();
    // canEditEvent is bypassed: it can never succeed on an ownerless row, and
    // asking it was the bug.
    expect(canEditEvent).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        createdByHumanId: MODERATOR_ID,
      }),
    );
  });

  it("refuses a non-moderator on a DRAFT listing", async () => {
    const { deps, create } = buildRequestDeps(makeCommunityEvent(), {
      moderator: false,
    });

    await expect(
      requestEventAudioUpload(deps, {
        ...REQUEST_INPUT,
        actorHumanId: OTHER_USER_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["PUBLISHED", "CANCELLED", "COMPLETED", "ARCHIVED"] as const)(
    "refuses even a MODERATOR on a %s community listing — narrower than the image path on purpose",
    async (status) => {
      const { deps, create } = buildRequestDeps(makeCommunityEvent({ status }), {
        moderator: true,
      });

      await expect(
        requestEventAudioUpload(deps, REQUEST_INPUT),
      ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("OWNED events are unchanged: canEditEvent still gates, and still says NOT_AUTHORIZED", async () => {
    const { deps, canEditEvent, hasStaffRole, create } = buildRequestDeps(
      makeCommunityEvent({ stewardship: "OWNED", humanId: OTHER_USER_ID }),
    );

    await expect(
      requestEventAudioUpload(deps, REQUEST_INPUT),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(canEditEvent).toHaveBeenCalled();
    // The owned hot path pays nothing for the community branch.
    expect(hasStaffRole).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  // Same oracle discipline as the image path: a community DRAFT's existence is
  // the secret, so the refusal must cost the same as "no such event".
  describe("a non-moderator cannot distinguish a DRAFT listing from a missing event", () => {
    const captureRefusal = async (event: EventRecord | null) => {
      const harness = buildRequestDeps(event, { moderator: false });
      let thrown: unknown;
      try {
        await requestEventAudioUpload(harness.deps, {
          ...REQUEST_INPUT,
          actorHumanId: OTHER_USER_ID,
        });
      } catch (err) {
        thrown = err;
      }
      const e = thrown as { code?: string; meta?: unknown; category?: unknown };
      return {
        observable: {
          code: e?.code,
          meta: e?.meta,
          category: e?.category,
          message: (thrown as Error | undefined)?.message,
        },
        work: {
          eventReads: harness.getById.mock.calls.length,
          staffProbes: harness.hasStaffRole.mock.calls.length,
          editProbes: harness.canEditEvent.mock.calls.length,
        },
        created: harness.create.mock.calls.length,
      };
    };

    it("returns a byte-identical error and performs identical work for both", async () => {
      const draft = await captureRefusal(makeCommunityEvent());
      const missing = await captureRefusal(null);

      expect(draft.created).toBe(0);
      expect(missing.created).toBe(0);
      expect(draft.observable.code).toBe("EVENT_NOT_FOUND");
      expect(draft.observable).toEqual(missing.observable);
      expect(draft.work).toEqual(missing.work);
      expect(draft.work.staffProbes).toBe(1);
    });
  });
});

// ─── finalizeEventAudioUpload ────────────────────────────────────────────────

function buildFinalizeDeps(options: {
  event: EventRecord | null;
  audioUpload?: AudioUploadRecord | null;
}) {
  const canEditEvent = vi.fn(async () => ({ allowed: false }));
  const markUploaded = vi.fn(async () => makeAudioUpload({ uploadedAt: NOW }));
  const audioUpload =
    options.audioUpload !== undefined ? options.audioUpload : makeAudioUpload();

  const deps: FinalizeEventAudioUploadDeps = {
    repos: {
      events: { getById: vi.fn(async () => options.event) },
      audioUploads: {
        getById: vi.fn(async () => audioUpload),
        markUploaded,
      },
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    } as unknown as FinalizeEventAudioUploadDeps["repos"],
    authz: { canEditEvent },
    fileStorage: {
      headObject: vi.fn(async () => ({ exists: true, size: 1234 })),
      deleteObject: vi.fn(async () => ({ ok: true })),
    } as unknown as FinalizeEventAudioUploadDeps["fileStorage"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as FinalizeEventAudioUploadDeps["logger"],
  };

  return { deps, canEditEvent, markUploaded };
}

describe("finalizeEventAudioUpload — COMMUNITY branch", () => {
  it("the UPLOADER may finalize their own upload on a community listing", async () => {
    // Mirrors finalizeEventImageUpload exactly: canEditEvent can never pass on
    // an ownerless row, so the gate is "you are the identity that passed
    // request's moderator+DRAFT check and holds the presigned PUT".
    const { deps, canEditEvent, markUploaded } = buildFinalizeDeps({
      event: makeCommunityEvent(),
    });

    const result = await finalizeEventAudioUpload(deps, {
      actorHumanId: MODERATOR_ID,
      audioUploadId: AUDIO_ID,
    });

    expect(result.audioUploadId).toBe(AUDIO_ID);
    expect(canEditEvent).not.toHaveBeenCalled();
    expect(markUploaded).toHaveBeenCalled();
  });

  it("someone ELSE cannot finalize another actor's community upload", async () => {
    const { deps, markUploaded } = buildFinalizeDeps({
      event: makeCommunityEvent(),
    });

    await expect(
      finalizeEventAudioUpload(deps, {
        actorHumanId: OTHER_USER_ID,
        audioUploadId: AUDIO_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(markUploaded).not.toHaveBeenCalled();
  });

  it("OWNED events are unchanged: canEditEvent still gates finalize", async () => {
    const { deps, canEditEvent, markUploaded } = buildFinalizeDeps({
      event: makeCommunityEvent({
        stewardship: "OWNED",
        humanId: OTHER_USER_ID,
      }),
    });

    await expect(
      finalizeEventAudioUpload(deps, {
        actorHumanId: MODERATOR_ID,
        audioUploadId: AUDIO_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(canEditEvent).toHaveBeenCalled();
    expect(markUploaded).not.toHaveBeenCalled();
  });

  it("a vanished event falls back to the OWNED gate rather than opening up", async () => {
    // `event` null means we cannot prove COMMUNITY, so the stricter branch
    // runs — fail closed, never the reverse.
    const { deps, canEditEvent } = buildFinalizeDeps({ event: null });

    await expect(
      finalizeEventAudioUpload(deps, {
        actorHumanId: MODERATOR_ID,
        audioUploadId: AUDIO_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(canEditEvent).toHaveBeenCalled();
  });
});
