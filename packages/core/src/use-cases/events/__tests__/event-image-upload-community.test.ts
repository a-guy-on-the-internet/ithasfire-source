import { describe, expect, it, vi } from "vitest";

import {
  requestEventImageUpload,
  type RequestEventImageUploadDeps,
} from "../request-event-image-upload";
import {
  finalizeEventImageUpload,
  type FinalizeEventImageUploadDeps,
} from "../finalize-event-image-upload";
import type { EventRecord } from "@th/ports/repos/events";
import type { ImageRecord } from "@th/ports/repos/images";
import { cleanJpeg } from "../../../lib/images/__tests__/image-fixtures";

/**
 * FR-015 (community-managed-event-listings spec): suggestion image uploads on
 * COMMUNITY listings — any SIGNED-IN user may upload, quota-checked against
 * THEIR personal storage, created UNATTACHED and never set as hero. OWNED
 * events keep the canEditEvent gate unchanged.
 */

const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const UPLOADER_ID = "30000000-0000-4000-8000-000000000002";
const OTHER_USER_ID = "30000000-0000-4000-8000-000000000003";
const IMAGE_ID = "30000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-07-01T12:00:00.000Z");

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: null,
    stewardship: "COMMUNITY",
    attendanceMode: "RSVP",
    status: "PUBLISHED",
    title: "Community Listing",
    startsAt: NOW,
    endsAt: NOW,
    ...overrides,
  } as EventRecord;
}

function makeImage(overrides: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: IMAGE_ID,
    ownerType: "EVENT",
    ownerId: EVENT_ID,
    eventId: EVENT_ID,
    key: `events/${EVENT_ID}/images/${IMAGE_ID}.jpg`,
    publicUrl: "",
    contentType: "image/jpeg",
    sizeBytes: 1234n,
    width: null,
    height: null,
    uploadedAt: null,
    attached: false,
    attachedAt: null,
    detachedAt: null,
    deletedAt: null,
    createdByHumanId: UPLOADER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── requestEventImageUpload ─────────────────────────────────────────────────

function buildRequestDeps(
  event: EventRecord | null,
  options: { moderator?: boolean } = {},
) {
  const imageCreate = vi.fn(async (_input: Record<string, unknown>) =>
    makeImage(),
  );
  const canEditEvent = vi.fn(async () => ({ allowed: false }));
  const hasStaffRole = vi.fn(async () => ({
    allowed: options.moderator === true,
  }));
  const getById = vi.fn(async () => event);
  const getEffectiveQuota = vi.fn(async () => ({
    kind: "STORAGE_BYTES_HUMAN" as const,
    limitValue: 10_000_000n,
    currentUsage: 0n,
    isOverride: false,
  }));
  const incrementUsage = vi.fn(async () => ({}));

  const deps: RequestEventImageUploadDeps = {
    repos: {
      events: { getById },
      images: { create: imageCreate },
      resourceQuotas: {
        getEffectiveQuota,
        hasPendingExpansionRequest: vi.fn(async () => false),
        incrementUsage,
      },
      tx: vi.fn(),
    } as unknown as RequestEventImageUploadDeps["repos"],
    authz: { canEditEvent, hasStaffRole },
    fileStorage: {
      presignPutObject: vi.fn(async () => ({
        uploadUrl: "https://r2.example/put",
      })),
    } as unknown as RequestEventImageUploadDeps["fileStorage"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as RequestEventImageUploadDeps["logger"],
  };

  return {
    deps,
    imageCreate,
    canEditEvent,
    hasStaffRole,
    getById,
    getEffectiveQuota,
    incrementUsage,
  };
}

const REQUEST_INPUT = {
  actorHumanId: UPLOADER_ID,
  eventId: EVENT_ID,
  contentType: "image/jpeg",
  sizeBytes: 1234,
};

describe("requestEventImageUpload — FR-015 COMMUNITY branch", () => {
  it("any signed-in user may upload to a COMMUNITY listing (canEditEvent bypassed, human quota charged, unattached)", async () => {
    const { deps, imageCreate, canEditEvent, getEffectiveQuota } =
      buildRequestDeps(makeEvent());

    const result = await requestEventImageUpload(deps, REQUEST_INPUT);

    expect(result.imageId).toBeTruthy();
    expect(canEditEvent).not.toHaveBeenCalled();
    // Quota charged to the UPLOADER's personal storage.
    expect(getEffectiveQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "HUMAN",
        subjectId: UPLOADER_ID,
        kind: "STORAGE_BYTES_HUMAN",
      }),
    );
    // Created UNATTACHED (create() never sets attached/hero).
    expect(imageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: "EVENT",
        ownerId: EVENT_ID,
        createdByHumanId: UPLOADER_ID,
      }),
    );
    const createInput = imageCreate.mock.calls[0]![0];
    expect("attached" in createInput).toBe(false);
    expect("heroImageId" in createInput).toBe(false);
  });

  it("OWNED events are unchanged: canEditEvent still gates the upload", async () => {
    const { deps, canEditEvent, imageCreate } = buildRequestDeps(
      makeEvent({ stewardship: "OWNED", humanId: OTHER_USER_ID }),
    );

    await expect(
      requestEventImageUpload(deps, REQUEST_INPUT),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(canEditEvent).toHaveBeenCalled();
    expect(imageCreate).not.toHaveBeenCalled();
  });

  it("rejects uploads to a non-PUBLISHED community listing (sweep fodder otherwise)", async () => {
    const { deps, imageCreate, canEditEvent } = buildRequestDeps(
      makeEvent({ status: "CANCELLED" }),
    );

    await expect(
      requestEventImageUpload(deps, REQUEST_INPUT),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(canEditEvent).not.toHaveBeenCalled();
    expect(imageCreate).not.toHaveBeenCalled();
  });

  it("does NOT probe the staff role on the PUBLISHED community path (the hot path stays one read)", async () => {
    const { deps, hasStaffRole } = buildRequestDeps(makeEvent());

    await requestEventImageUpload(deps, REQUEST_INPUT);

    expect(hasStaffRole).not.toHaveBeenCalled();
  });

  it("a COMMUNITY_MODERATOR may upload to a DRAFT listing (the EventBuilder authoring path)", async () => {
    const { deps, imageCreate, canEditEvent, getEffectiveQuota } =
      buildRequestDeps(makeEvent({ status: "DRAFT" }), { moderator: true });

    const result = await requestEventImageUpload(deps, REQUEST_INPUT);

    expect(result.imageId).toBeTruthy();
    expect(result.uploadUrl).toBeTruthy();
    // Same shape as the PUBLISHED community path: canEditEvent is still
    // bypassed (ownerless row) and quota is the uploader's personal storage.
    expect(canEditEvent).not.toHaveBeenCalled();
    expect(getEffectiveQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "HUMAN",
        subjectId: UPLOADER_ID,
      }),
    );
    expect(imageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: EVENT_ID }),
    );
  });

  it.each(["CANCELLED", "COMPLETED", "ARCHIVED"] as const)(
    "refuses even a MODERATOR on a %s community listing (dead listings stay sweep fodder)",
    async (status) => {
      const { deps, imageCreate } = buildRequestDeps(makeEvent({ status }), {
        moderator: true,
      });

      await expect(
        requestEventImageUpload(deps, REQUEST_INPUT),
      ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
      expect(imageCreate).not.toHaveBeenCalled();
    },
  );

  // ── THE ORACLE PIN ─────────────────────────────────────────────────────────
  //
  // This branch is the reason the DRAFT arm needed care at all. The COMMUNITY
  // arm above lets ANY signed-in user upload, so "DRAFT listings are
  // uploadable" would have made this endpoint an existence oracle: guess an
  // id, read the response, learn whether an unpublished draft is sitting
  // there. The refusal a non-moderator gets for a REAL DRAFT must therefore be
  // indistinguishable from the one they get for an id that does not exist — in
  // the error, and in the work done to produce it.
  describe("a non-moderator cannot distinguish a DRAFT listing from a missing event", () => {
    const captureRefusal = async (event: EventRecord | null) => {
      const harness = buildRequestDeps(event, { moderator: false });
      let thrown: unknown;
      try {
        await requestEventImageUpload(harness.deps, REQUEST_INPUT);
      } catch (err) {
        thrown = err;
      }
      const e = thrown as { code?: string; meta?: unknown; category?: unknown };
      return {
        // Everything the caller can observe.
        observable: {
          code: e?.code,
          meta: e?.meta,
          category: e?.category,
          message: (thrown as Error | undefined)?.message,
        },
        // …and everything they could infer from how long it took, reduced to
        // the round-trips actually made.
        work: {
          eventReads: harness.getById.mock.calls.length,
          staffProbes: harness.hasStaffRole.mock.calls.length,
          editProbes: harness.canEditEvent.mock.calls.length,
        },
        imageCreated: harness.imageCreate.mock.calls.length,
      };
    };

    it("returns a byte-identical error and performs identical work for both", async () => {
      const draft = await captureRefusal(makeEvent({ status: "DRAFT" }));
      const missing = await captureRefusal(null);

      // Nothing was written in either case.
      expect(draft.imageCreated).toBe(0);
      expect(missing.imageCreated).toBe(0);

      // Same error, field for field — not merely "both are 404s".
      expect(draft.observable.code).toBe("EVENT_NOT_FOUND");
      expect(draft.observable).toEqual(missing.observable);

      // Same round-trips. Probing the staff role ONLY on the draft branch
      // would leave a measurable extra call on exactly the case that must not
      // be measurable, so the probe is hoisted onto the missing-event path
      // too. If someone "optimises" that away, this fails.
      expect(draft.work).toEqual(missing.work);
      expect(draft.work.staffProbes).toBe(1);
      expect(missing.work.staffProbes).toBe(1);
    });

    it("a CANCELLED listing is indistinguishable from both as well", async () => {
      const cancelled = await captureRefusal(makeEvent({ status: "CANCELLED" }));
      const missing = await captureRefusal(null);

      expect(cancelled.observable).toEqual(missing.observable);
      expect(cancelled.work).toEqual(missing.work);
    });
  });

  it("anonymous callers cannot reach the branch (actorHumanId is required input)", async () => {
    const { deps } = buildRequestDeps(makeEvent());
    const { actorHumanId: _omitted, ...anonInput } = REQUEST_INPUT;

    await expect(
      requestEventImageUpload(deps, anonInput),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ─── finalizeEventImageUpload ────────────────────────────────────────────────

function buildFinalizeDeps(options: {
  event: EventRecord | null;
  image?: ImageRecord | null;
}) {
  const canEditEvent = vi.fn(async () => ({ allowed: false }));
  const markUploaded = vi.fn(async () => makeImage({ uploadedAt: NOW }));
  // finalize now marks-uploaded + enqueues an EVENT_HERO moderation record in
  // one tx; the tx callback runs against `repos` so these spies fire.
  const enqueueModeration = vi.fn(async () => ({}));

  const repos = {
    events: { getById: vi.fn(async () => options.event) },
    images: {
      getById: vi.fn(async () =>
        options.image !== undefined ? options.image : makeImage(),
      ),
      markUploaded,
    },
    imageModerationRecords: {
      create: enqueueModeration,
    },
    // Finalize outboxes the original upload's deletion in its tx.
    pendingObjectDeletions: { enqueueMany: vi.fn(async () => undefined) },
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repos)),
  } as unknown as FinalizeEventImageUploadDeps["repos"];

  const deps: FinalizeEventImageUploadDeps = {
    repos,
    authz: { canEditEvent },
    fileStorage: {
      headObject: vi.fn(async () => ({ exists: true, size: 1234 })),
      getObjectUrl: vi.fn(async () => ({ url: "https://cdn.example/img" })),
      // Finalize reads the upload, writes its metadata-stripped copy and
      // deletes the original.
      getObject: vi.fn(async () => ({ content: cleanJpeg() })),
      putObject: vi.fn(async () => ({ url: "https://cdn.example/img" })),
      deleteObject: vi.fn(async () => ({ ok: true })),
    } as unknown as FinalizeEventImageUploadDeps["fileStorage"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as FinalizeEventImageUploadDeps["logger"],
  };

  return { deps, canEditEvent, markUploaded, enqueueModeration };
}

describe("finalizeEventImageUpload — FR-015 COMMUNITY branch", () => {
  it("the uploader finalizes their own COMMUNITY upload without canEditEvent", async () => {
    const { deps, canEditEvent, markUploaded } = buildFinalizeDeps({
      event: makeEvent(),
    });

    const result = await finalizeEventImageUpload(deps, {
      actorHumanId: UPLOADER_ID,
      imageId: IMAGE_ID,
    });

    expect(result.imageId).toBe(IMAGE_ID);
    expect(canEditEvent).not.toHaveBeenCalled();
    expect(markUploaded).toHaveBeenCalled();
  });

  it("a DIFFERENT signed-in user cannot finalize someone else's COMMUNITY upload", async () => {
    const { deps, markUploaded } = buildFinalizeDeps({ event: makeEvent() });

    await expect(
      finalizeEventImageUpload(deps, {
        actorHumanId: OTHER_USER_ID,
        imageId: IMAGE_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(markUploaded).not.toHaveBeenCalled();
  });

  it("OWNED events are unchanged: canEditEvent still gates finalize", async () => {
    const { deps, canEditEvent } = buildFinalizeDeps({
      event: makeEvent({ stewardship: "OWNED", humanId: OTHER_USER_ID }),
    });

    await expect(
      finalizeEventImageUpload(deps, {
        actorHumanId: UPLOADER_ID,
        imageId: IMAGE_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(canEditEvent).toHaveBeenCalled();
  });

  // Finalize needed NO change for the DRAFT authoring flow — it carries no
  // status gate at all, only "are you the uploader". Pinned rather than
  // assumed, because request→PUT→finalize is only half a feature if the last
  // step 404s, and nothing else in the suite would have caught it.
  it("finalizes an upload on a DRAFT listing (no status gate here, by design)", async () => {
    const { deps, canEditEvent, markUploaded } = buildFinalizeDeps({
      event: makeEvent({ status: "DRAFT" }),
    });

    const result = await finalizeEventImageUpload(deps, {
      actorHumanId: UPLOADER_ID,
      imageId: IMAGE_ID,
    });

    expect(result.imageId).toBe(IMAGE_ID);
    expect(canEditEvent).not.toHaveBeenCalled();
    expect(markUploaded).toHaveBeenCalled();
  });
});
