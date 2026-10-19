import { describe, expect, it, vi } from "vitest";

import {
  requestEventImageUpload,
  type RequestEventImageUploadDeps,
} from "../request-event-image-upload";
import type { EventRecord } from "@th/ports/repos/events";
import type { ImageRecord } from "@th/ports/repos/images";

/**
 * Content-type allowlist + storage-key extension mapping for event image
 * uploads. RASTER ONLY:
 *
 * - `image/svg+xml` is REJECTED for every caller, organizer-owned listings
 *   included. Azure AI Content Safety cannot analyze SVG (`400
 *   InvalidRequestBody "The image format is not supported."`), and a 400 is
 *   non-retryable in the moderation adapter, so an SVG hero failed closed to a
 *   degraded FLAGGED record — and FLAGGED is terminal, so it stayed invisible
 *   forever with no organizer-side fix. SVG used to be accepted here (keyed
 *   `.svg`, presigned with `Content-Disposition: attachment`); these tests pin
 *   the refusal so it cannot be reintroduced without also teaching the
 *   moderation pipeline to score it.
 * - Raster types are keyed from the explicit extension map, no
 *   Content-Disposition requested.
 * - Unknown types (e.g. `image/tiff`) are still rejected.
 */

const EVENT_ID = "40000000-0000-4000-8000-000000000001";
const UPLOADER_ID = "40000000-0000-4000-8000-000000000002";
const IMAGE_ID = "40000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-07-01T12:00:00.000Z");

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: UPLOADER_ID,
    stewardship: "OWNED",
    attendanceMode: "TICKETED",
    status: "PUBLISHED",
    title: "Owned Event",
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

function buildDeps(event: EventRecord = makeEvent()) {
  const imageCreate = vi.fn(async () => makeImage());
  const presignPutObject = vi.fn(async () => ({
    uploadUrl: "https://r2.example/put",
  }));

  const deps: RequestEventImageUploadDeps = {
    repos: {
      events: { getById: vi.fn(async () => event) },
      images: { create: imageCreate },
      resourceQuotas: {
        getEffectiveQuota: vi.fn(async () => ({
          kind: "STORAGE_BYTES_HUMAN" as const,
          limitValue: 10_000_000n,
          currentUsage: 0n,
          isOverride: false,
        })),
        hasPendingExpansionRequest: vi.fn(async () => false),
        incrementUsage: vi.fn(async () => ({})),
      },
      tx: vi.fn(),
    } as unknown as RequestEventImageUploadDeps["repos"],
    authz: { canEditEvent: vi.fn(async () => ({ allowed: true })) },
    fileStorage: {
      presignPutObject,
    } as unknown as RequestEventImageUploadDeps["fileStorage"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as RequestEventImageUploadDeps["logger"],
  };

  return { deps, imageCreate, presignPutObject };
}

const baseInput = {
  actorHumanId: UPLOADER_ID,
  eventId: EVENT_ID,
  sizeBytes: 1234,
};

describe("requestEventImageUpload — content types & SVG handling", () => {
  it("rejects image/svg+xml before any presign or DB write", async () => {
    const { deps, imageCreate, presignPutObject } = buildDeps();

    await expect(
      requestEventImageUpload(deps, {
        ...baseInput,
        contentType: "image/svg+xml",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // No quota is consumed and no orphan Image row is minted for a refusal.
    expect(presignPutObject).not.toHaveBeenCalled();
    expect(imageCreate).not.toHaveBeenCalled();
  });

  it("never asks the storage port for a Content-Disposition", async () => {
    // The attachment header existed only to make a directly-navigated SVG
    // download rather than render. With SVG gone there is no signed header
    // beyond Content-Type, and uploadHeaders must stay a bare one-entry map —
    // the client sends it verbatim, so an unexpected key would 403 the PUT.
    const { deps, presignPutObject } = buildDeps();

    const result = await requestEventImageUpload(deps, {
      ...baseInput,
      contentType: "image/png",
    });

    expect(presignPutObject).toHaveBeenCalledWith(
      expect.not.objectContaining({ contentDisposition: expect.anything() }),
    );
    expect(result.uploadHeaders).toEqual({ "Content-Type": "image/png" });
  });

  it.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
  ] as const)(
    "keeps existing behavior for %s: extension .%s and NO Content-Disposition",
    async (contentType, extension) => {
      const { deps, presignPutObject } = buildDeps();

      const result = await requestEventImageUpload(deps, {
        ...baseInput,
        contentType,
      });

      expect(result.key).toMatch(new RegExp(`\\.${extension}$`));

      // No contentDisposition key at all — existing presign behavior is
      // untouched for raster types.
      const presignArg = presignPutObject.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect("contentDisposition" in presignArg).toBe(false);

      expect(result.uploadHeaders).toEqual({ "Content-Type": contentType });
    },
  );

  it.each([
    "image/tiff",
    "image/svg",
    "image/svg+xml",
    "text/html",
    "application/xml",
  ])(
    "still rejects unsupported content type %s",
    async (contentType) => {
      const { deps, imageCreate, presignPutObject } = buildDeps();

      await expect(
        requestEventImageUpload(deps, { ...baseInput, contentType }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(presignPutObject).not.toHaveBeenCalled();
      expect(imageCreate).not.toHaveBeenCalled();
    },
  );
});

describe("requestEventImageUpload — SVG is refused for every stewardship", () => {
  const communityEvent = () =>
    makeEvent({
      stewardship: "COMMUNITY",
      humanId: null,
      status: "PUBLISHED",
    });

  it("rejects image/svg+xml against a COMMUNITY listing before any presign or DB write", async () => {
    const { deps, imageCreate, presignPutObject } = buildDeps(communityEvent());

    await expect(
      requestEventImageUpload(deps, {
        ...baseInput,
        contentType: "image/svg+xml",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(presignPutObject).not.toHaveBeenCalled();
    expect(imageCreate).not.toHaveBeenCalled();
  });

  it("COMMUNITY listings still accept raster uploads (suggest-edit path unchanged)", async () => {
    const { deps, presignPutObject } = buildDeps(communityEvent());

    const result = await requestEventImageUpload(deps, {
      ...baseInput,
      contentType: "image/jpeg",
    });

    expect(result.key).toMatch(/\.jpg$/);
    expect(presignPutObject).toHaveBeenCalledOnce();
    expect(result.uploadHeaders).toEqual({ "Content-Type": "image/jpeg" });
  });

  it("builds the upload key from its own random token, never the image id", async () => {
    // The image id is public (event reads expose `heroImageId`); the
    // original, EXIF GPS and all, is readable at the upload key until
    // finalize deletes it, so the key must not be derivable from the id.
    const { deps, imageCreate, presignPutObject } = buildDeps(
      makeEvent({ stewardship: "OWNED" }),
    );

    const result = await requestEventImageUpload(deps, {
      ...baseInput,
      contentType: "image/jpeg",
    });

    expect(result.key).toMatch(
      new RegExp(`^events/${EVENT_ID}/images/u-[0-9a-f-]{36}\\.jpg$`),
    );
    expect(result.key).not.toContain(result.imageId);
    expect(presignPutObject).toHaveBeenCalledWith(
      expect.objectContaining({ key: result.key }),
    );
    expect(imageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: result.imageId, key: result.key }),
    );
  });

  it("organizer-owned events reject image/svg+xml too", async () => {
    // This is the case that inverted: SVG used to be an organizer-only
    // privilege. The moderation pipeline cannot score it for anyone, so the
    // refusal is now universal and the schema catches it ahead of the
    // stewardship branch entirely.
    const { deps, imageCreate, presignPutObject } = buildDeps(
      makeEvent({ stewardship: "OWNED" }),
    );

    await expect(
      requestEventImageUpload(deps, {
        ...baseInput,
        contentType: "image/svg+xml",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(presignPutObject).not.toHaveBeenCalled();
    expect(imageCreate).not.toHaveBeenCalled();
  });
});

// Owner ruling 2026-09-28: a delegate may upload to the principal's event —
// and the bytes count against the EVENT OWNER's quota (the subject delete
// credits back via `eventStorageQuotaSubject`), never the delegate's.
describe("requestEventImageUpload — quota subject is the event owner", () => {
  const PRINCIPAL_ID = "40000000-0000-4000-8000-0000000000aa";

  it("a delegate's upload is checked against and charged to the principal", async () => {
    const { deps } = buildDeps(makeEvent({ humanId: PRINCIPAL_ID }));
    const quotas = deps.repos.resourceQuotas as unknown as {
      getEffectiveQuota: ReturnType<typeof vi.fn>;
      incrementUsage: ReturnType<typeof vi.fn>;
    };

    await requestEventImageUpload(deps, {
      ...baseInput,
      contentType: "image/png",
    });

    expect(quotas.getEffectiveQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "HUMAN",
        subjectId: PRINCIPAL_ID,
        kind: "STORAGE_BYTES_HUMAN",
      }),
    );
    expect(quotas.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "HUMAN", subjectId: PRINCIPAL_ID }),
    );
    for (const call of [
      ...quotas.getEffectiveQuota.mock.calls,
      ...quotas.incrementUsage.mock.calls,
    ]) {
      expect(call[0]).not.toMatchObject({ subjectId: UPLOADER_ID });
    }
  });
});
