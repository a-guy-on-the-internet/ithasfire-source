import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ImageRecord } from "@th/ports/repos/images";

import {
  FINALIZE_IMAGE_DELETION_SOURCES,
  finalizeEventImageUpload,
  type FinalizeEventImageUploadDeps,
} from "../finalize-event-image-upload";
import { EVENT_IMAGE_PRESIGN_TTL_SECONDS } from "../request-event-image-upload";
import { stripImageMetadata } from "../../../lib/images/strip-image-metadata";
import {
  IMAGE_STRIP_BUSY,
  IMAGE_STRIP_CONCURRENCY,
  IMAGE_STRIP_MAX_WAITING,
  strippedImageKey,
  withImageStripSlot,
} from "../../storage/strip-uploaded-image";
import {
  PNG_SIGNATURE,
  SECRET,
  cleanPng,
  exifTiff,
  idat,
  iend,
  ihdr,
  pngChunk,
} from "../../../lib/images/__tests__/image-fixtures";

const ACTOR_HUMAN_ID = "human-1";
const IMAGE_ID = "image-1";
const EVENT_ID = "event-1";
const KEY = "events/event-1/images/0b9f6a1e-upload.png";

/** A 640x480 PNG carrying a text chunk and an EXIF block with GPS. */
function taggedPng(): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    ihdr(640, 480),
    pngChunk("tEXt", Buffer.from(`Comment\0${SECRET.png}`, "latin1")),
    pngChunk("eXIf", exifTiff()),
    idat(),
    iend(),
  ]);
}

/** Where finalize must put the stripped copy of `taggedPng()`. */
const STRIPPED_KEY = strippedImageKey(
  KEY,
  stripImageMetadata(taggedPng(), "image/png").bytes,
);
const STRIPPED_URL = `https://cdn.example/${STRIPPED_KEY}`;

/** Presign issued a minute ago, so the after-expiry deletion is still ahead. */
const CREATED_AT = new Date(Date.now() - 60_000);

function makeImage(overrides?: Partial<ImageRecord>): ImageRecord {
  return {
    id: IMAGE_ID,
    ownerType: "EVENT",
    ownerId: EVENT_ID,
    eventId: EVENT_ID,
    key: KEY,
    publicUrl: "",
    contentType: "image/png",
    sizeBytes: 1234n,
    width: null,
    height: null,
    uploadedAt: null,
    attached: false,
    attachedAt: null,
    detachedAt: null,
    deletedAt: null,
    createdByHumanId: ACTOR_HUMAN_ID,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

/** Overrides are vi.fn mocks of any arity. */
type AnyFn = (...args: any[]) => any;

function makeDeps(
  overrides?: Partial<{
    image: ImageRecord | null;
    /** Replaces `image`: a getById mock (e.g. to answer differently per call). */
    getImage: AnyFn;
    canEdit: { allowed: boolean };
    headObject: AnyFn;
    getObject: AnyFn;
    putObject: AnyFn;
    deleteObject: AnyFn;
    markUploaded: AnyFn;
    softDeleteIfUnfinalized: AnyFn;
    markDeleted: AnyFn;
    /** The event row finalize reads (null = the OWNED canEditEvent path). */
    event: Record<string, unknown> | null;
    reportError: AnyFn;
    /** Wraps the default tx runner (e.g. to fail before or after it). */
    tx: (run: (fn: (tx: any) => Promise<unknown>) => Promise<unknown>) => AnyFn;
  }>,
) {
  const markUploaded =
    overrides?.markUploaded ??
    vi.fn(async (input) => makeImage({ ...input, uploadedAt: input.uploadedAt }));
  const enqueueModeration = vi.fn(async (r) => r);
  const headObject =
    overrides?.headObject ?? vi.fn(async () => ({ exists: true, size: 1234 }));
  const getObjectUrl = vi.fn(async ({ key }) => ({ url: `https://cdn.example/${key}` }));
  const getObject =
    overrides?.getObject ?? vi.fn(async () => ({ content: taggedPng() }));
  const putObject =
    overrides?.putObject ??
    vi.fn(async ({ key }) => ({ url: `https://cdn.example/${key}` }));
  const deleteObject = overrides?.deleteObject ?? vi.fn(async () => ({ ok: true }));
  const getById =
    overrides?.getImage ??
    vi.fn(async () => (overrides && "image" in overrides ? overrides.image : makeImage()));

  /** The outbox as seen OUTSIDE the transaction. */
  const outbox = {
    enqueueMany: vi.fn(async () => undefined),
    markDeleted: overrides?.markDeleted ?? vi.fn(async () => 1),
  };
  /** The outbox as seen through the transaction handle. */
  const txOutbox = { enqueueMany: vi.fn(async () => undefined) };
  const softDeleteIfUnfinalized =
    overrides?.softDeleteIfUnfinalized ?? vi.fn(async () => true);
  const incrementUsage = vi.fn(async () => undefined);

  const images = { getById, markUploaded, softDeleteIfUnfinalized };
  const imageModerationRecords = { create: enqueueModeration };
  const txRepos = {
    images,
    imageModerationRecords,
    pendingObjectDeletions: txOutbox,
    resourceQuotas: { incrementUsage },
  };
  const run = async (fn: (tx: any) => Promise<unknown>) => fn(txRepos);

  const repos: any = {
    // OWNED path in these tests: no event record needed — a null event falls
    // through to the canEditEvent branch (pre-FR-015 behavior).
    events: { getById: vi.fn(async () => overrides?.event ?? null) },
    images,
    imageModerationRecords,
    pendingObjectDeletions: outbox,
    tx: vi.fn(overrides?.tx ? overrides.tx(run) : run),
  };

  const deps: FinalizeEventImageUploadDeps = {
    repos,
    authz: {
      canEditEvent: vi.fn(async () => overrides?.canEdit ?? { allowed: true }),
    } as unknown as Pick<AuthZPort, "canEditEvent">,
    fileStorage: {
      headObject,
      getObjectUrl,
      getObject,
      putObject,
      deleteObject,
    } as any,
    logger: makeLogger(),
    ...(overrides?.reportError ? { reportError: overrides.reportError } : {}),
  };
  return {
    deps,
    m: {
      repos,
      markUploaded,
      enqueueModeration,
      headObject,
      getObject,
      getObjectUrl,
      putObject,
      deleteObject,
      outbox,
      txOutbox,
      softDeleteIfUnfinalized,
      incrementUsage,
      logger: deps.logger as any,
    },
  };
}

const finalize = (deps: FinalizeEventImageUploadDeps) =>
  finalizeEventImageUpload(deps, { actorHumanId: ACTOR_HUMAN_ID, imageId: IMAGE_ID });

const afterPresign = new Date(
  CREATED_AT.getTime() + EVENT_IMAGE_PRESIGN_TTL_SECONDS * 1000 + 15 * 60 * 1000,
);

describe("finalizeEventImageUpload", () => {
  it("publishes a stripped copy under an unlinkable key and outboxes the original", async () => {
    const { deps, m } = makeDeps();

    const result = await finalize(deps);

    expect(result).toEqual({
      imageId: IMAGE_ID,
      publicUrl: STRIPPED_URL,
      contentType: "image/png",
      // The DECLARED size: quota was charged from it and is credited from it.
      sizeBytes: 1234,
      width: 640,
      height: 480,
    });

    // Reads the whole upload, writes the stripped bytes to the NEW key.
    expect(m.getObject).toHaveBeenCalledWith({ key: KEY });
    expect(m.putObject).toHaveBeenCalledTimes(1);
    const put = m.putObject.mock.calls[0]![0];
    expect(put.key).toBe(STRIPPED_KEY);
    expect(put.options).toEqual({ contentType: "image/png", public: true });
    expect(put.content.includes(Buffer.from(SECRET.png))).toBe(false);
    expect(put.content.includes(Buffer.from(SECRET.make))).toBe(false);
    expect(put.content.includes(Buffer.from("eXIf"))).toBe(false);

    // The public key reveals nothing about the upload key.
    expect(STRIPPED_KEY).toMatch(/^events\/event-1\/images\/[0-9a-f]{32}\.png$/);
    expect(STRIPPED_KEY).not.toContain("0b9f6a1e-upload");

    // The row and the moderation record both move to the stripped key.
    expect(m.repos.tx).toHaveBeenCalledTimes(1);
    expect(m.markUploaded).toHaveBeenCalledWith(
      expect.objectContaining({
        id: IMAGE_ID,
        key: STRIPPED_KEY,
        publicUrl: STRIPPED_URL,
        width: 640,
        height: 480,
      }),
    );
    expect(m.enqueueModeration).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: STRIPPED_KEY,
        kind: "EVENT_HERO",
        subjectType: "EVENT",
        subjectId: EVENT_ID,
        publicUrl: STRIPPED_URL,
        createdByHumanId: ACTOR_HUMAN_ID,
      }),
    );

    // The original's deletion is enqueued THROUGH THE TX: now, and again
    // after the presigned PUT URL expires.
    expect(m.outbox.enqueueMany).not.toHaveBeenCalled();
    expect(m.txOutbox.enqueueMany).toHaveBeenCalledTimes(1);
    expect(m.txOutbox.enqueueMany).toHaveBeenCalledWith([
      {
        id: expect.any(String),
        targetKey: KEY,
        targetKind: "KEY",
        source: FINALIZE_IMAGE_DELETION_SOURCES.original,
        sourceId: IMAGE_ID,
      },
      {
        targetKey: KEY,
        targetKind: "KEY",
        source: FINALIZE_IMAGE_DELETION_SOURCES.originalAfterPresign,
        sourceId: IMAGE_ID,
        notBefore: afterPresign,
      },
    ]);

    // Fast path: the original is deleted right after the commit...
    expect(m.deleteObject).toHaveBeenCalledTimes(1);
    expect(m.deleteObject).toHaveBeenCalledWith({ key: KEY });
    expect(m.deleteObject.mock.invocationCallOrder[0]).toBeGreaterThan(
      m.txOutbox.enqueueMany.mock.invocationCallOrder[0]!,
    );
    // ...and the due-now row it fulfilled is removed, leaving only the
    // delayed one for the drain (security N2).
    const dueNowId = (m.txOutbox.enqueueMany.mock.calls[0] as any)[0][0].id;
    expect(m.outbox.markDeleted).toHaveBeenCalledTimes(1);
    expect(m.outbox.markDeleted).toHaveBeenCalledWith(dueNowId);
    expect(m.outbox.markDeleted.mock.invocationCallOrder[0]).toBeGreaterThan(
      m.deleteObject.mock.invocationCallOrder[0]!,
    );
    expect(m.logger.info).toHaveBeenCalledWith(
      "Event image upload finalized",
      expect.objectContaining({
        metadataRemoved: ["PNG:tEXt", "PNG:eXIf"],
        metadataRemovedCount: 2,
      }),
    );
  });

  it("skips the after-presign deletion once the presign has long expired", async () => {
    const { deps, m } = makeDeps({
      image: makeImage({ createdAt: new Date("2026-06-27T00:00:00.000Z") }),
    });
    await finalize(deps);
    expect(m.txOutbox.enqueueMany).toHaveBeenCalledWith([
      expect.objectContaining({ source: FINALIZE_IMAGE_DELETION_SOURCES.original }),
    ]);
  });

  it("a failing transaction enqueues nothing and deletes nothing", async () => {
    // Runs the tx body, then rolls back (throws): the enqueue was on the tx
    // handle, so it is gone with the rollback; the fast path never runs.
    const { deps, m } = makeDeps({
      tx: (run) => async (fn) => {
        await run(fn);
        throw new Error("commit failed");
      },
    });

    await expect(finalize(deps)).rejects.toThrow("commit failed");
    expect(m.outbox.enqueueMany).not.toHaveBeenCalled();
    expect(m.deleteObject).not.toHaveBeenCalled();
  });

  it("a retry after a crash before commit re-derives the same stripped key", async () => {
    let attempt = 0;
    const { deps, m } = makeDeps({
      tx: (run) => async (fn) => {
        attempt += 1;
        if (attempt === 1) throw new Error("process died before commit");
        return run(fn);
      },
    });

    await expect(finalize(deps)).rejects.toThrow();
    await finalize(deps);

    const keys = m.putObject.mock.calls.map((c: any[]) => c[0].key);
    expect(keys).toEqual([STRIPPED_KEY, STRIPPED_KEY]);
    // Same bytes both times: the second write overwrites, it does not fork.
    const [first, second] = m.putObject.mock.calls;
    expect(first![0].content.equals(second![0].content)).toBe(true);
    expect(m.markUploaded).toHaveBeenCalledTimes(1);
    expect(m.deleteObject).toHaveBeenCalledTimes(1);
  });

  it("different bytes (a re-PUT) give a different stripped key", async () => {
    const { deps, m } = makeDeps({
      getObject: vi.fn(async () => ({ content: cleanPng(640, 480) })),
    });
    await finalize(deps);
    expect(m.putObject.mock.calls[0]![0].key).not.toBe(STRIPPED_KEY);
  });

  describe("concurrent finalize (conditional markUploaded)", () => {
    const winnerRow = (key: string) =>
      makeImage({
        uploadedAt: new Date(),
        key,
        publicUrl: `https://cdn.example/${key}`,
        width: 640,
        height: 480,
      });

    it("the loser with the SAME key enqueues nothing, skips moderation, returns the winner", async () => {
      // Reads: the initial one, the re-read in the strip slot, the winner.
      const getImage = vi
        .fn()
        .mockResolvedValueOnce(makeImage())
        .mockResolvedValueOnce(makeImage())
        .mockResolvedValueOnce(winnerRow(STRIPPED_KEY));
      const { deps, m } = makeDeps({ getImage, markUploaded: vi.fn(async () => null) });

      const result = await finalize(deps);

      expect(result).toMatchObject({ publicUrl: STRIPPED_URL, width: 640 });
      expect(m.enqueueModeration).not.toHaveBeenCalled();
      // The winner's object IS ours: deleting it would break the image.
      expect(m.txOutbox.enqueueMany).not.toHaveBeenCalled();
      expect(m.deleteObject).not.toHaveBeenCalled();
    });

    it("the loser with a DIFFERENT key outboxes its own copy", async () => {
      const winnerKey = "events/event-1/images/ffffffffffffffffffffffffffffffff.png";
      const getImage = vi
        .fn()
        .mockResolvedValueOnce(makeImage())
        .mockResolvedValueOnce(makeImage())
        .mockResolvedValueOnce(winnerRow(winnerKey));
      const { deps, m } = makeDeps({ getImage, markUploaded: vi.fn(async () => null) });

      const result = await finalize(deps);

      expect(result).toMatchObject({ publicUrl: `https://cdn.example/${winnerKey}` });
      expect(m.enqueueModeration).not.toHaveBeenCalled();
      expect(m.txOutbox.enqueueMany).toHaveBeenCalledWith([
        {
          targetKey: STRIPPED_KEY,
          targetKind: "KEY",
          source: FINALIZE_IMAGE_DELETION_SOURCES.losingCopy,
          sourceId: IMAGE_ID,
        },
      ]);
    });

    it("a row deleted mid-finalize outboxes the copy and reports IMAGE_NOT_FOUND", async () => {
      const getImage = vi
        .fn()
        .mockResolvedValueOnce(makeImage())
        .mockResolvedValueOnce(makeImage())
        .mockResolvedValueOnce(null);
      const { deps, m } = makeDeps({ getImage, markUploaded: vi.fn(async () => null) });

      await expect(finalize(deps)).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
      expect(m.txOutbox.enqueueMany).toHaveBeenCalledWith([
        expect.objectContaining({ targetKey: STRIPPED_KEY }),
      ]);
    });

    it("a not_found read (upload already deleted by the winner) returns the finished row", async () => {
      const getImage = vi
        .fn()
        .mockResolvedValueOnce(makeImage())
        .mockResolvedValueOnce(makeImage())
        .mockResolvedValueOnce(winnerRow(STRIPPED_KEY));
      const { deps, m } = makeDeps({
        getImage,
        getObject: vi.fn(async () => {
          throw { code: "not_found", message: "object_not_found" };
        }),
      });

      const result = await finalize(deps);

      expect(result).toMatchObject({ publicUrl: STRIPPED_URL });
      expect(m.putObject).not.toHaveBeenCalled();
      expect(m.markUploaded).not.toHaveBeenCalled();
    });

    it("a not_found read with the row still pending is UPLOAD_NOT_COMPLETE", async () => {
      const { deps } = makeDeps({
        getObject: vi.fn(async () => {
          throw { code: "not_found", message: "object_not_found" };
        }),
      });
      await expect(finalize(deps)).rejects.toMatchObject({ code: "UPLOAD_NOT_COMPLETE" });
    });

    it("a missing HEAD with the row already finished returns it", async () => {
      const getImage = vi
        .fn()
        .mockResolvedValueOnce(makeImage())
        .mockResolvedValueOnce(winnerRow(STRIPPED_KEY));
      const { deps, m } = makeDeps({
        getImage,
        headObject: vi.fn(async () => ({ exists: false })),
      });

      const result = await finalize(deps);

      expect(result).toMatchObject({ publicUrl: STRIPPED_URL, width: 640 });
      expect(m.putObject).not.toHaveBeenCalled();
      expect(m.markUploaded).not.toHaveBeenCalled();
    });
  });

  it("a failed fast-path delete is logged and reported; finalize still succeeds", async () => {
    const boom = { code: "transient", message: "socket hang up" };
    const reportError = vi.fn();
    const { deps, m } = makeDeps({
      reportError,
      deleteObject: vi.fn(async () => {
        throw boom;
      }),
    });

    const result = await finalize(deps);

    expect(result).toMatchObject({ imageId: IMAGE_ID, publicUrl: STRIPPED_URL });
    // The outbox rows are what make the delete happen eventually.
    expect(m.txOutbox.enqueueMany).toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        area: "image_metadata_strip",
        useCase: "finalizeEventImageUpload",
        step: "delete_original",
      },
      extra: { imageId: IMAGE_ID, key: KEY },
    });
    // The plain storage error is wrapped so Sentry gets a message to group
    // on; the original rides along as `cause`.
    const reported = reportError.mock.calls[0]![0] as Error;
    expect(reported.message).toBe("transient: socket hang up");
    expect(reported.cause).toBe(boom);
    expect(m.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("original"),
      expect.objectContaining({ imageId: IMAGE_ID, key: KEY, err: boom }),
    );
    // The due-now row stays: the drain still has a delete to do.
    expect(m.outbox.markDeleted).not.toHaveBeenCalled();
  });

  it("a failed removal of the fulfilled outbox row is reported; finalize still succeeds", async () => {
    const reportError = vi.fn();
    const { deps, m } = makeDeps({
      reportError,
      markDeleted: vi.fn(async () => {
        throw new Error("db blip");
      }),
    });

    const result = await finalize(deps);

    expect(result).toMatchObject({ publicUrl: STRIPPED_URL });
    expect(m.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("outbox"),
      expect.objectContaining({ imageId: IMAGE_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db blip" }),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "remove_fulfilled_deletion" }),
      }),
    );
  });

  it("a throwing reporter does not change the outcome", async () => {
    const { deps } = makeDeps({
      reportError: vi.fn(() => {
        throw new Error("sentry down");
      }),
      deleteObject: vi.fn(async () => {
        throw new Error("storage down");
      }),
    });

    const result = await finalize(deps);
    expect(result).toMatchObject({ publicUrl: STRIPPED_URL });
  });

  it("refuses bytes the stripper cannot parse: deletes the upload and retires the row", async () => {
    const reportError = vi.fn();
    const { deps, m } = makeDeps({
      reportError,
      getObject: vi.fn(async () => ({ content: Buffer.from("not an image") })),
    });

    await expect(finalize(deps)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "image_unreadable",
    });

    expect(m.putObject).not.toHaveBeenCalled();
    expect(m.deleteObject).toHaveBeenCalledWith({ key: KEY });
    // Retired in one tx: soft-deleted, then ONLY the delayed deletion is
    // outboxed (the inline delete landed, so no due-now row).
    expect(m.softDeleteIfUnfinalized).toHaveBeenCalledWith({
      id: IMAGE_ID,
      deletedAt: expect.any(Date),
    });
    expect(m.txOutbox.enqueueMany).toHaveBeenCalledTimes(1);
    expect(m.txOutbox.enqueueMany).toHaveBeenCalledWith([
      {
        targetKey: KEY,
        targetKind: "KEY",
        source: FINALIZE_IMAGE_DELETION_SOURCES.originalAfterPresign,
        sourceId: IMAGE_ID,
        notBefore: afterPresign,
      },
    ]);
    expect(m.outbox.enqueueMany).not.toHaveBeenCalled();
    expect(m.markUploaded).not.toHaveBeenCalled();
    expect(m.enqueueModeration).not.toHaveBeenCalled();
    // Reported: a real photo landing here would be a stripper bug.
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ImageMetadataStripError" }),
      expect.objectContaining({
        tags: expect.objectContaining({ area: "image_metadata_strip", step: "parse" }),
      }),
    );
  });

  it("a refusal whose inline delete failed also outboxes a due-now deletion", async () => {
    const { deps, m } = makeDeps({
      getObject: vi.fn(async () => ({ content: Buffer.from("not an image") })),
      deleteObject: vi.fn(async () => {
        throw { code: "transient", message: "socket hang up" };
      }),
    });

    await expect(finalize(deps)).rejects.toMatchObject({ message: "image_unreadable" });
    expect(m.txOutbox.enqueueMany).toHaveBeenCalledWith([
      expect.objectContaining({ source: FINALIZE_IMAGE_DELETION_SOURCES.original }),
      expect.objectContaining({ source: FINALIZE_IMAGE_DELETION_SOURCES.originalAfterPresign }),
    ]);
  });

  it("a refusal credits the declared bytes back to the subject they were charged to", async () => {
    const { deps, m } = makeDeps({
      event: { id: EVENT_ID, stewardship: "OWNED", orgId: "org-1", humanId: null },
      getObject: vi.fn(async () => ({ content: Buffer.from("not an image") })),
    });

    await expect(finalize(deps)).rejects.toMatchObject({ message: "image_unreadable" });
    expect(m.incrementUsage).toHaveBeenCalledWith({
      subjectType: "ORG",
      subjectId: "org-1",
      kind: "STORAGE_BYTES_ORG",
      delta: -1234n,
    });
  });

  it("a refusal that loses the retire race credits, enqueues and reports nothing", async () => {
    const reportError = vi.fn();
    const { deps, m } = makeDeps({
      reportError,
      event: { id: EVENT_ID, stewardship: "OWNED", orgId: "org-1", humanId: null },
      getObject: vi.fn(async () => ({ content: Buffer.from("not an image") })),
      softDeleteIfUnfinalized: vi.fn(async () => false),
    });

    await expect(finalize(deps)).rejects.toMatchObject({ message: "image_unreadable" });
    expect(m.incrementUsage).not.toHaveBeenCalled();
    expect(m.txOutbox.enqueueMany).not.toHaveBeenCalled();
    // Reported once per upload, by the call that retired it, not by every
    // racing refusal.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a refusal on a COMMUNITY listing credits the uploading human", async () => {
    // request-event-image-upload charges the uploader when the event has no
    // owner subject (ownerless community listing).
    const { deps, m } = makeDeps({
      event: { id: EVENT_ID, stewardship: "COMMUNITY", orgId: null, humanId: null },
      getObject: vi.fn(async () => ({ content: Buffer.from("not an image") })),
    });

    await expect(finalize(deps)).rejects.toMatchObject({ message: "image_unreadable" });
    expect(m.incrementUsage).toHaveBeenCalledTimes(1);
    expect(m.incrementUsage).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: ACTOR_HUMAN_ID,
      kind: "STORAGE_BYTES_HUMAN",
      delta: -1234n,
    });
  });

  it("a refusal on a personal (human-owned) event credits the event's owner", async () => {
    const { deps, m } = makeDeps({
      event: { id: EVENT_ID, stewardship: "OWNED", orgId: null, humanId: "human-owner" },
      getObject: vi.fn(async () => ({ content: Buffer.from("not an image") })),
    });

    await expect(finalize(deps)).rejects.toMatchObject({ message: "image_unreadable" });
    expect(m.incrementUsage).toHaveBeenCalledTimes(1);
    expect(m.incrementUsage).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: "human-owner",
      kind: "STORAGE_BYTES_HUMAN",
      delta: -1234n,
    });
  });

  it("a retired row cannot be finalized again: IMAGE_NOT_FOUND, no read, no enqueue", async () => {
    const { deps, m } = makeDeps({ image: makeImage({ deletedAt: new Date() }) });

    await expect(finalize(deps)).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
    expect(m.headObject).not.toHaveBeenCalled();
    expect(m.getObject).not.toHaveBeenCalled();
    expect(m.outbox.enqueueMany).not.toHaveBeenCalled();
    expect(m.repos.tx).not.toHaveBeenCalled();
  });

  it("a full strip queue: logged at error, reported as strip_busy, rethrown as RATE_LIMITED", async () => {
    const gates: Array<() => void> = [];
    const held = Array.from({ length: IMAGE_STRIP_CONCURRENCY + IMAGE_STRIP_MAX_WAITING }, () =>
      withImageStripSlot(() => new Promise<void>((resolve) => gates.push(resolve))),
    );
    await new Promise((r) => setTimeout(r, 0));
    try {
      const reportError = vi.fn();
      const { deps, m } = makeDeps({ reportError });

      await expect(finalize(deps)).rejects.toMatchObject({
        code: "RATE_LIMITED",
        message: IMAGE_STRIP_BUSY,
      });
      expect(m.getObject).not.toHaveBeenCalled();
      expect(m.repos.tx).not.toHaveBeenCalled();
      expect(m.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("strip queue is full"),
        expect.objectContaining({ imageId: IMAGE_ID }),
      );
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "RATE_LIMITED" }),
        {
          tags: {
            area: "image_metadata_strip",
            useCase: "finalizeEventImageUpload",
            step: "strip_busy",
          },
          extra: { imageId: IMAGE_ID },
        },
      );
    } finally {
      for (let i = 0; i < 100; i += 1) {
        gates.splice(0).forEach((open) => open());
        await new Promise((r) => setTimeout(r, 0));
      }
      await Promise.all(held);
    }
  });

  it("refuses bytes that do not match the declared type", async () => {
    const { deps, m } = makeDeps({
      image: makeImage({ contentType: "image/jpeg" }),
      getObject: vi.fn(async () => ({ content: cleanPng() })),
    });

    await expect(finalize(deps)).rejects.toMatchObject({ message: "image_unreadable" });
    expect(m.putObject).not.toHaveBeenCalled();
  });

  it("a storage failure reading the upload fails the finalize (nothing written)", async () => {
    const { deps, m } = makeDeps({
      getObject: vi.fn(async () => {
        throw { code: "transient", message: "socket hang up" };
      }),
    });

    await expect(finalize(deps)).rejects.toMatchObject({ code: "transient" });
    expect(m.putObject).not.toHaveBeenCalled();
    expect(m.deleteObject).not.toHaveBeenCalled();
    expect(m.markUploaded).not.toHaveBeenCalled();
  });

  it("an unreadable header after stripping is a plain null size", async () => {
    // A valid container whose IHDR says 0x0: strips fine, no dimensions.
    const { deps, m } = makeDeps({
      getObject: vi.fn(async () => ({ content: cleanPng(0, 0) })),
    });

    const result = await finalize(deps);

    expect(result).toMatchObject({ width: null, height: null });
    expect(m.markUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ width: null, height: null }),
    );
  });

  it("rejects when the uploaded object is missing in storage", async () => {
    const { deps, m } = makeDeps({ headObject: vi.fn(async () => ({ exists: false })) });

    await expect(finalize(deps)).rejects.toMatchObject({ code: "UPLOAD_NOT_COMPLETE" });
    expect(m.getObjectUrl).not.toHaveBeenCalled();
    expect(m.markUploaded).not.toHaveBeenCalled();
  });

  // F11 (2026-09-29): the quota was charged from the row's declared
  // `sizeBytes` (1234n in the fixture), so a bigger stored object is deleted
  // and refused, and the row stays un-finalized.
  it("deletes and rejects an object bigger than the declared sizeBytes, never reading it", async () => {
    const { deps, m } = makeDeps({
      headObject: vi.fn(async () => ({ exists: true, size: 1235 })),
    });

    await expect(finalize(deps)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "upload_size_exceeded",
    });
    expect(m.deleteObject).toHaveBeenCalledWith({ key: KEY });
    expect(m.getObject).not.toHaveBeenCalled();
    expect(m.markUploaded).not.toHaveBeenCalled();
  });

  it("accepts an object exactly at the declared sizeBytes", async () => {
    const { deps, m } = makeDeps({
      headObject: vi.fn(async () => ({ exists: true, size: 1234 })),
    });
    await finalize(deps);
    expect(m.markUploaded).toHaveBeenCalled();
  });

  it("returns existing data without re-finalizing when already uploaded", async () => {
    const { deps, m } = makeDeps({
      image: makeImage({
        uploadedAt: new Date("2026-06-26T00:00:00.000Z"),
        publicUrl: "https://cdn.example/already.png",
        width: 1080,
        height: 1350,
      }),
    });

    const result = await finalize(deps);

    expect(result).toEqual({
      imageId: IMAGE_ID,
      publicUrl: "https://cdn.example/already.png",
      contentType: "image/png",
      sizeBytes: 1234,
      width: 1080,
      height: 1350,
    });
    expect(m.headObject).not.toHaveBeenCalled();
    expect(m.getObject).not.toHaveBeenCalled();
    expect(m.putObject).not.toHaveBeenCalled();
    expect(m.deleteObject).not.toHaveBeenCalled();
    expect(m.markUploaded).not.toHaveBeenCalled();
    // A double-finalize (idempotent retry) must NOT re-enqueue moderation —
    // that would re-PENDING an already-decided record.
    expect(m.enqueueModeration).not.toHaveBeenCalled();
  });

  it("rejects when the actor cannot edit the event", async () => {
    const { deps, m } = makeDeps({ canEdit: { allowed: false } });

    await expect(finalize(deps)).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(m.headObject).not.toHaveBeenCalled();
    expect(m.getObject).not.toHaveBeenCalled();
    expect(m.markUploaded).not.toHaveBeenCalled();
  });

  it("rejects when the image record does not exist", async () => {
    const { deps, m } = makeDeps({ image: null });

    await expect(finalize(deps)).rejects.toMatchObject({ code: "IMAGE_NOT_FOUND" });
    expect(deps.authz.canEditEvent).not.toHaveBeenCalled();
    expect(m.headObject).not.toHaveBeenCalled();
  });

  // Security N1 (fix round 2): one tRPC batch of N finalizes for ONE 25 MB
  // upload used to read it N times at once.
  describe("memory bound under concurrent finalizes", () => {
    /** A stateful image table: markUploaded is conditional, like the adapter. */
    function table(ids: string[]) {
      const rows = new Map(
        ids.map((id) => [id, makeImage({ id, key: `events/event-1/images/u-${id}.png` })]),
      );
      return {
        rows,
        getImage: vi.fn(async (id: string) => rows.get(id) ?? null),
        markUploaded: vi.fn(async (input: any) => {
          const row = rows.get(input.id);
          if (!row || row.uploadedAt || row.deletedAt) return null;
          const next = { ...row, ...input };
          rows.set(input.id, next);
          return next;
        }),
      };
    }

    /** A getObject whose reads stay open until `releaseAll()`. */
    function gatedReads() {
      let inFlight = 0;
      let peak = 0;
      let released = false;
      const waiting: Array<() => void> = [];
      const getObject = vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        if (!released) await new Promise<void>((resolve) => waiting.push(resolve));
        inFlight -= 1;
        return { content: taggedPng() };
      });
      return {
        getObject,
        peak: () => peak,
        /** Lets every read finish, the waiting ones and any still to come. */
        releaseAll() {
          released = true;
          waiting.splice(0).forEach((resolve) => resolve());
        },
      };
    }

    /** Lets queued promise chains (reads, slot hand-offs) run. */
    const settle = async () => {
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
    };

    const finalizeId = (deps: FinalizeEventImageUploadDeps, imageId: string) =>
      finalizeEventImageUpload(deps, { actorHumanId: ACTOR_HUMAN_ID, imageId });

    it("N=20 concurrent finalizes of one image read the upload ONCE", async () => {
      const t = table([IMAGE_ID]);
      const reads = gatedReads();
      const { deps, m } = makeDeps({
        getImage: t.getImage,
        markUploaded: t.markUploaded,
        getObject: reads.getObject,
      });

      const calls = Array.from({ length: 20 }, () => finalizeId(deps, IMAGE_ID));
      await settle();
      reads.releaseAll();
      const results = await Promise.all(calls);

      expect(m.getObject).toHaveBeenCalledTimes(1);
      expect(m.putObject).toHaveBeenCalledTimes(1);
      // One winner: one moderation record, one set of outbox rows.
      expect(m.enqueueModeration).toHaveBeenCalledTimes(1);
      expect(m.txOutbox.enqueueMany).toHaveBeenCalledTimes(1);
      const urls = new Set(results.map((r) => r.publicUrl));
      expect(urls.size).toBe(1);
      expect([...urls][0]).toMatch(/\/[0-9a-f]{32}\.png$/);
    });

    it("never runs more than IMAGE_STRIP_CONCURRENCY reads at once", async () => {
      const ids = ["img-a", "img-b", "img-c", "img-d", "img-e", "img-f"];
      const t = table(ids);
      const reads = gatedReads();
      const { deps, m } = makeDeps({
        getImage: t.getImage,
        markUploaded: t.markUploaded,
        getObject: reads.getObject,
      });

      const calls = ids.map((id) => finalizeId(deps, id));
      // Let every call reach the slot queue before anything is released.
      await settle();
      expect(reads.peak()).toBe(IMAGE_STRIP_CONCURRENCY);
      reads.releaseAll();
      await Promise.all(calls);

      expect(reads.peak()).toBe(IMAGE_STRIP_CONCURRENCY);
      expect(m.getObject).toHaveBeenCalledTimes(ids.length);
    });

    it("a finalize that reaches a slot after the row was finalized never reads the object", async () => {
      // Two other images hold both slots; meanwhile "another process"
      // finalizes ours. When a slot frees, the re-read sees it and stops.
      const t = table(["busy-1", "busy-2", IMAGE_ID]);
      const reads = gatedReads();
      const { deps, m } = makeDeps({
        getImage: t.getImage,
        markUploaded: t.markUploaded,
        getObject: reads.getObject,
      });

      const busy = [finalizeId(deps, "busy-1"), finalizeId(deps, "busy-2")];
      await settle();
      const ours = finalizeId(deps, IMAGE_ID);
      await settle();
      t.rows.set(IMAGE_ID, {
        ...t.rows.get(IMAGE_ID)!,
        uploadedAt: new Date(),
        key: "events/event-1/images/elsewhere.png",
        publicUrl: "https://cdn.example/events/event-1/images/elsewhere.png",
      });

      reads.releaseAll();
      await Promise.all(busy);
      const result = await ours;

      expect(result.publicUrl).toBe("https://cdn.example/events/event-1/images/elsewhere.png");
      const readKeys = m.getObject.mock.calls.map((c: any[]) => c[0].key);
      expect(readKeys).not.toContain(`events/event-1/images/u-${IMAGE_ID}.png`);
      expect(m.getObject).toHaveBeenCalledTimes(2);
    });
  });
});
