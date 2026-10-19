import { describe, expect, it, vi } from "vitest";

import {
  resolveEventAudio,
  resolveEventAudioInputSchema,
  type ResolveEventAudioDeps,
} from "../resolve-event-audio";
import { COMMUNITY_MODERATION_ROLES } from "../../community/_shared/suggestion-validation";

/**
 * The bug this suite pins: source audio is stored PRIVATE, so its URL is a
 * presigned credential with an expiry. `finalize-event-audio-upload` used to
 * mint one for 7 days and persist it to `audio_uploads.sourceUrl`, so every
 * event's audio 404'd exactly one week after upload — permanently, because
 * nothing in the read path ever refreshed it.
 *
 * The invariant now: the URL is MINTED PER READ from `sourceKey`, and the
 * stored column is never consulted.
 */

const SIX_HOURS = 6 * 60 * 60;

/** A body whose audioBlocks reference exactly these upload ids. */
function bodyReferencing(ids: string[]): unknown {
  return {
    sections: [
      {
        layout: {
          columns: [
            {
              blocks: [
                {
                  type: "richText",
                  doc: {
                    type: "doc",
                    content: ids.map((id) => ({
                      type: "audioBlock",
                      attrs: { audioUploadId: id },
                    })),
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

interface Upload {
  id: string;
  sourceKey?: string;
  sourceUrl?: string;
  deletedAt?: Date | null;
  hlsPlaylistUrl?: string | null;
  status?: string;
}

function createDeps(
  uploads: Upload[],
  signImpl?: () => Promise<{ url: string }>,
  eventOverrides?: {
    status?: string;
    canEdit?: boolean;
    body?: unknown;
    /** OWNED unless set. COMMUNITY selects the moderator arm of the authz probe. */
    stewardship?: string;
    /** Answer of `authz.hasStaffRole` — i.e. "is a community moderator". */
    isModerator?: boolean;
  },
) {
  const rows = uploads.map((u) => ({
    id: u.id,
    eventId: "evt-1",
    status: u.status ?? "READY",
    sourceKey: u.sourceKey ?? `uploads/audio/${u.id}.mp3`,
    // A long-expired presigned URL, exactly what production rows hold.
    sourceUrl:
      u.sourceUrl ??
      `https://r2.example.com/uploads/audio/${u.id}.mp3?X-Amz-Expires=604800&X-Amz-Signature=stale`,
    sourceContentType: "audio/mpeg",
    sourceSizeBytes: null,
    hlsPlaylistUrl: u.hlsPlaylistUrl ?? "https://cdn.example.com/hls/x.m3u8",
    durationSeconds: 12,
    waveformPeaks: null,
    attached: false,
    deletedAt: u.deletedAt ?? null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  }));

  const getObjectUrl = vi.fn(
    signImpl ??
      (async ({ key }: { key: string }) => ({
        url: `https://r2.example.com/${key}?X-Amz-Signature=FRESH`,
      })),
  );

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const reportError = vi.fn();

  const canEditEvent = vi.fn(async () => ({
    allowed: eventOverrides?.canEdit ?? false,
  }));
  const hasStaffRole = vi.fn(async () => ({
    allowed: eventOverrides?.isModerator ?? false,
  }));

  const deps: ResolveEventAudioDeps = {
    repos: {
      audioUploads: { listByEventId: vi.fn(async () => rows) },
      events: {
        getById: vi.fn(async () => ({
          id: "evt-1",
          status: eventOverrides?.status ?? "PUBLISHED",
          stewardship: eventOverrides?.stewardship ?? "OWNED",
        })),
        // `??` would swallow an explicit `body: null` (the "page has no audio"
        // case), so branch on presence of the key instead.
        getContent: vi.fn(async () =>
          eventOverrides && "body" in eventOverrides
            ? eventOverrides.body
            : bodyReferencing(uploads.map((u) => u.id)),
        ),
      },
    } as unknown as ResolveEventAudioDeps["repos"],
    authz: {
      canEditEvent,
      hasStaffRole,
    } as unknown as ResolveEventAudioDeps["authz"],
    fileStorage: { getObjectUrl } as unknown as ResolveEventAudioDeps["fileStorage"],
    logger: logger as unknown as ResolveEventAudioDeps["logger"],
    reportError,
  };

  return {
    deps,
    mocks: { getObjectUrl, logger, reportError, canEditEvent, hasStaffRole },
  };
}

describe("resolveEventAudio — source URLs are minted, never read from the row", () => {
  it("returns a freshly signed URL, not the stored one", async () => {
    const { deps } = createDeps([{ id: "aud-1" }]);

    const result = await resolveEventAudio(deps, { eventId: "evt-1" });

    expect(result.items[0]!.sourceUrl).toBe(
      "https://r2.example.com/uploads/audio/aud-1.mp3?X-Amz-Signature=FRESH",
    );
    // The stale persisted value must not leak through.
    expect(result.items[0]!.sourceUrl).not.toContain("stale");
  });

  it("signs from the storage KEY", async () => {
    const { deps, mocks } = createDeps([
      { id: "aud-1", sourceKey: "uploads/audio/custom.mp3" },
    ]);

    await resolveEventAudio(deps, { eventId: "evt-1" });

    expect(mocks.getObjectUrl).toHaveBeenCalledWith({
      key: "uploads/audio/custom.mp3",
      options: { expiresSec: SIX_HOURS },
    });
  });

  it("uses an expiry that outlives the page's ISR window but is not durable", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }]);

    await resolveEventAudio(deps, { eventId: "evt-1" });

    const { options } = mocks.getObjectUrl.mock.calls[0]![0];
    expect(options.expiresSec).toBeGreaterThan(60); // > ISR revalidate
    expect(options.expiresSec).toBeLessThan(24 * 60 * 60); // « the old 7 days
  });

  it("signs every active upload independently", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }, { id: "aud-2" }]);

    const result = await resolveEventAudio(deps, { eventId: "evt-1" });

    expect(mocks.getObjectUrl).toHaveBeenCalledTimes(2);
    expect(result.items.map((i) => i.sourceUrl)).toEqual([
      "https://r2.example.com/uploads/audio/aud-1.mp3?X-Amz-Signature=FRESH",
      "https://r2.example.com/uploads/audio/aud-2.mp3?X-Amz-Signature=FRESH",
    ]);
  });

  it("does not sign for soft-deleted uploads", async () => {
    const { deps, mocks } = createDeps([
      { id: "aud-1", deletedAt: new Date("2026-08-02T00:00:00.000Z") },
    ]);

    const result = await resolveEventAudio(deps, { eventId: "evt-1" });

    expect(result.items).toHaveLength(0);
    expect(mocks.getObjectUrl).not.toHaveBeenCalled();
  });
});

describe("resolveEventAudio — signing failure degrades one item, not the page", () => {
  it("returns null sourceUrl and keeps the HLS playlist when signing throws", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }], async () => {
      throw new Error("storage down");
    });

    const result = await resolveEventAudio(deps, { eventId: "evt-1" });

    expect(result.items[0]!.sourceUrl).toBeNull();
    // HLS still plays in Safari; the page is not failed.
    expect(result.items[0]!.hlsPlaylistUrl).toBe(
      "https://cdn.example.com/hls/x.m3u8",
    );
    expect(mocks.logger.error).toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalled();
  });

  it("keeps item order aligned when one of several fails", async () => {
    let call = 0;
    const { deps } = createDeps(
      [{ id: "aud-1" }, { id: "aud-2" }, { id: "aud-3" }],
      async () => {
        call++;
        if (call === 2) throw new Error("boom");
        return { url: `https://r2.example.com/ok-${call}` };
      },
    );

    const result = await resolveEventAudio(deps, { eventId: "evt-1" });

    // The failure must land on the SECOND item, not shift the others.
    expect(result.items.map((i) => i.id)).toEqual(["aud-1", "aud-2", "aud-3"]);
    expect(result.items[1]!.sourceUrl).toBeNull();
    expect(result.items[0]!.sourceUrl).not.toBeNull();
    expect(result.items[2]!.sourceUrl).not.toBeNull();
  });

  it("does NOT report a missing object — that is terminal, not an incident", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }], async () => {
      throw Object.assign(new Error("object_not_found"), {
        code: "not_found",
      });
    });

    const result = await resolveEventAudio(deps, { eventId: "evt-1" });

    expect(result.items[0]!.sourceUrl).toBeNull();
    // Would otherwise re-fire on every render for the life of the row.
    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it("returns null without signing when the upload has no key yet", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1", sourceKey: "" }]);

    const result = await resolveEventAudio(deps, { eventId: "evt-1" });

    expect(result.items[0]!.sourceUrl).toBeNull();
    expect(mocks.getObjectUrl).not.toHaveBeenCalled();
  });
});

/**
 * `resolveAudio` is reachable without authentication, and every call now mints
 * a working presigned URL for the PRIVATE source object. Without a visibility
 * check that is an open oracle: anyone holding an event id could pull the raw
 * audio of an unpublished event on demand, indefinitely.
 */
describe("resolveEventAudio — access", () => {
  it("rejects a client-supplied viewerHumanId at the schema", () => {
    // The transport omits this field so identity can only be server-derived;
    // pin that the schema itself is strict about the rest of the shape.
    expect(() =>
      resolveEventAudioInputSchema.parse({
        eventId: "evt-1",
        viewerHumanId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("serves a PUBLISHED event to an anonymous caller", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }], undefined, {
      status: "PUBLISHED",
    });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: null,
    });

    expect(result.items).toHaveLength(1);
    // No permission probe here BY DESIGN — but that is not the whole gate.
    // Password/application gating for PUBLISHED events is enforced at the
    // transport (`ensureFullEventReadAccessByEventId`), because only it can
    // see the anonymous unlock cookie. An earlier version of this comment
    // claimed `status === "PUBLISHED"` was the complete bar; it was not, and
    // that mistake left gated events' audio readable by anyone.
    expect(mocks.canEditEvent).not.toHaveBeenCalled();
  });

  it("returns nothing for a DRAFT event to an anonymous caller", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }], undefined, {
      status: "DRAFT",
    });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: null,
    });

    expect(result.items).toEqual([]);
    // No URL was minted for a private object of an unpublished event.
    expect(mocks.getObjectUrl).not.toHaveBeenCalled();
  });

  it("returns nothing for a DRAFT event to a signed-in non-editor", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }], undefined, {
      status: "DRAFT",
      canEdit: false,
    });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.items).toEqual([]);
    expect(mocks.getObjectUrl).not.toHaveBeenCalled();
  });

  it("serves a DRAFT event to someone who can edit it", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }], undefined, {
      status: "DRAFT",
      canEdit: true,
    });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: "22222222-2222-4222-8222-222222222222",
    });

    // The builder must keep working on unpublished events.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.sourceUrl).not.toBeNull();
    expect(mocks.canEditEvent).toHaveBeenCalledWith({
      actorHumanId: "22222222-2222-4222-8222-222222222222",
      eventId: "evt-1",
    });
  });

  it("returns an empty list rather than throwing for a missing event", async () => {
    const { deps } = createDeps([{ id: "aud-1" }]);
    (deps.repos.events.getById as any) = vi.fn(async () => null);

    // Not an existence probe: same shape as "no permission".
    await expect(
      resolveEventAudio(deps, { eventId: "nope", viewerHumanId: null }),
    ).resolves.toEqual({ items: [] });
  });
});

const MODERATOR = "33333333-3333-4333-8333-333333333333";
const STRANGER = "44444444-4444-4444-8444-444444444444";

/**
 * COMMUNITY listings are ownerless, so `authz.canEditEvent` — org owner, then
 * human owner, then false — answers false for every one of them. That made
 * body audio write-only on a community draft: `requestAudioUpload` and
 * `finalizeAudioUpload` have COMMUNITY branches, so a moderator could upload a
 * track, but this read path could never hand back a player, in the builder or
 * in the preview. The builder had to hide the toolbar button rather than ship
 * one that swallowed files.
 *
 * The arm added here mirrors `getEventForEdit`'s exactly — same role constant,
 * same stewardship switch — and it is a READ widening only.
 */
describe("resolveEventAudio — COMMUNITY listings", () => {
  it("serves a DRAFT community listing to a moderator", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }], undefined, {
      status: "DRAFT",
      stewardship: "COMMUNITY",
      isModerator: true,
    });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: MODERATOR,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.sourceUrl).not.toBeNull();
    // Same gate the rest of the community pipeline uses, imported rather than
    // re-listed so the two cannot drift.
    expect(mocks.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: MODERATOR,
      requiredRoles: [...COMMUNITY_MODERATION_ROLES],
    });
    // The ownerless probe is not consulted — it would only ever say no, and
    // spending it would make the community arm cost more round trips than the
    // owned one.
    expect(mocks.canEditEvent).not.toHaveBeenCalled();
  });

  it("gives the moderator uploads the body has not referenced yet", async () => {
    // The builder shows transcode progress for a track before it is inserted,
    // which is the same reason owned-event editors get the unfiltered list.
    const { deps } = createDeps(
      [{ id: "aud-inserted" }, { id: "aud-still-transcoding" }],
      undefined,
      {
        status: "DRAFT",
        stewardship: "COMMUNITY",
        isModerator: true,
        body: bodyReferencing(["aud-inserted"]),
      },
    );

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: MODERATOR,
    });

    expect(result.items.map((i) => i.id)).toEqual([
      "aud-inserted",
      "aud-still-transcoding",
    ]);
  });

  it("returns nothing for a DRAFT community listing to a signed-in non-moderator", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }], undefined, {
      status: "DRAFT",
      stewardship: "COMMUNITY",
      isModerator: false,
    });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: STRANGER,
    });

    expect(result.items).toEqual([]);
    // No presigned URL was minted for the PRIVATE source object.
    expect(mocks.getObjectUrl).not.toHaveBeenCalled();
  });

  it("returns nothing for a DRAFT community listing to an anonymous caller", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }], undefined, {
      status: "DRAFT",
      stewardship: "COMMUNITY",
      isModerator: true,
    });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: null,
    });

    expect(result.items).toEqual([]);
    // Anonymous callers are never editors, so they cost no probe at all.
    expect(mocks.hasStaffRole).not.toHaveBeenCalled();
    expect(mocks.getObjectUrl).not.toHaveBeenCalled();
  });

  it("is indistinguishable from a missing event for a non-moderator", async () => {
    // A community DRAFT's EXISTENCE is the secret (its content is not public
    // yet), so probing one must look exactly like probing an id that was never
    // issued — in the response AND in the number of round trips, or latency
    // becomes the oracle the identical response was there to close.
    const draft = createDeps([{ id: "aud-1" }], undefined, {
      status: "DRAFT",
      stewardship: "COMMUNITY",
      isModerator: false,
    });
    const missing = createDeps([{ id: "aud-1" }]);
    (missing.deps.repos.events.getById as any) = vi.fn(async () => null);

    const draftResult = await resolveEventAudio(draft.deps, {
      eventId: "evt-1",
      viewerHumanId: STRANGER,
    });
    const missingResult = await resolveEventAudio(missing.deps, {
      eventId: "99999999-9999-4999-8999-999999999999",
      viewerHumanId: STRANGER,
    });

    // Same response, and neither throws.
    expect(draftResult).toEqual({ items: [] });
    expect(missingResult).toEqual({ items: [] });

    // Same number of authz round trips.
    expect(missing.mocks.hasStaffRole.mock.calls.length).toBe(
      draft.mocks.hasStaffRole.mock.calls.length,
    );
    expect(missing.mocks.hasStaffRole).toHaveBeenCalledTimes(1);
    expect(missing.mocks.canEditEvent).not.toHaveBeenCalled();
    expect(draft.mocks.canEditEvent).not.toHaveBeenCalled();

    // Same number of repo round trips: one event read, nothing more. A body
    // or upload read on only one of the two paths would leak the same bit.
    expect(missing.deps.repos.audioUploads.listByEventId).not.toHaveBeenCalled();
    expect(draft.deps.repos.audioUploads.listByEventId).not.toHaveBeenCalled();
  });

  it("still serves a PUBLISHED community listing to an anonymous caller", async () => {
    const { deps, mocks } = createDeps([{ id: "aud-1" }], undefined, {
      status: "PUBLISHED",
      stewardship: "COMMUNITY",
    });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: null,
    });

    expect(result.items).toHaveLength(1);
    expect(mocks.hasStaffRole).not.toHaveBeenCalled();
  });

  it("still shows a PUBLISHED community listing's non-moderator only what the body references", async () => {
    const { deps } = createDeps(
      [{ id: "aud-kept" }, { id: "aud-removed" }],
      undefined,
      {
        status: "PUBLISHED",
        stewardship: "COMMUNITY",
        isModerator: false,
        body: bodyReferencing(["aud-kept"]),
      },
    );

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: STRANGER,
    });

    expect(result.items.map((i) => i.id)).toEqual(["aud-kept"]);
  });

  it("leaves OWNED events on the canEditEvent path, staff role irrelevant", async () => {
    // Being a community moderator is not a skeleton key for somebody else's
    // owned draft — the stewardship switch, not the role, picks the arm.
    const { deps, mocks } = createDeps([{ id: "aud-1" }], undefined, {
      status: "DRAFT",
      stewardship: "OWNED",
      canEdit: false,
      isModerator: true,
    });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: MODERATOR,
    });

    expect(result.items).toEqual([]);
    expect(mocks.canEditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.hasStaffRole).not.toHaveBeenCalled();
  });
});

/**
 * There is no "remove audio" use case — taking a track off an event means
 * deleting its `audioBlock`. The row survives, so without a reachability check
 * every removed take stayed publicly listed with a freshly minted URL forever.
 */
describe("resolveEventAudio — the public only sees what the page references", () => {
  it("withholds an upload the body no longer references", async () => {
    const { deps } = createDeps(
      [{ id: "aud-kept" }, { id: "aud-removed" }],
      undefined,
      { body: bodyReferencing(["aud-kept"]) },
    );

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: null,
    });

    expect(result.items.map((i) => i.id)).toEqual(["aud-kept"]);
  });

  it("does not mint a URL for a withheld upload", async () => {
    const { deps, mocks } = createDeps(
      [{ id: "aud-kept" }, { id: "aud-removed" }],
      undefined,
      { body: bodyReferencing(["aud-kept"]) },
    );

    await resolveEventAudio(deps, { eventId: "evt-1", viewerHumanId: null });

    const keys = mocks.getObjectUrl.mock.calls.map((c: any[]) => c[0].key);
    expect(keys.some((k: string) => k.includes("aud-removed"))).toBe(false);
  });

  it("withholds everything when the body has no audio at all", async () => {
    const { deps } = createDeps([{ id: "aud-1" }], undefined, { body: null });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: null,
    });

    expect(result.items).toEqual([]);
  });

  it("still gives EDITORS the unreferenced uploads — the builder needs them", async () => {
    const { deps } = createDeps(
      [{ id: "aud-kept" }, { id: "aud-not-inserted-yet" }],
      undefined,
      {
        canEdit: true,
        body: bodyReferencing(["aud-kept"]),
      },
    );

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: "22222222-2222-4222-8222-222222222222",
    });

    // Transcode progress is shown before a track is placed in the body.
    expect(result.items.map((i) => i.id)).toEqual([
      "aud-kept",
      "aud-not-inserted-yet",
    ]);
  });

  it("finds a reference however the body nests it", async () => {
    const { deps } = createDeps([{ id: "aud-1" }], undefined, {
      body: { widgets: [{ kind: "player", audioUploadId: "aud-1" }] },
    });

    const result = await resolveEventAudio(deps, {
      eventId: "evt-1",
      viewerHumanId: null,
    });

    expect(result.items).toHaveLength(1);
  });
});
