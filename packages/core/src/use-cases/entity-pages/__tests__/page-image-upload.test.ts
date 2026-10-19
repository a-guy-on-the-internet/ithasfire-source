import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";

import { finalizePageImageUpload } from "../finalize-page-image-upload";
import {
  PAGE_IMAGE_COMMUNITY_UPLOAD_SOURCE,
  requestPageImageUpload,
} from "../request-page-image-upload";
import type { FinalizePageImageUploadDeps } from "../finalize-page-image-upload";
import type { RequestPageImageUploadDeps } from "../request-page-image-upload";
import { stripImageMetadata } from "../../../lib/images/strip-image-metadata";
import {
  GIF_TRAILER,
  SECRET,
  gifComment,
  gifGraphicControl,
  gifHeader,
  gifImage,
  gifNetscapeLoop,
  phoneJpeg,
} from "../../../lib/images/__tests__/image-fixtures";
import { strippedImageKey } from "../../storage/strip-uploaded-image";
import {
  abandonStrippedUpload,
  creditMarkerId,
  recordUploadRequest,
  uploadClaimId,
  uploadRequestId,
} from "../../storage/publish-stripped-upload";
import {
  CDN,
  makeObjectStore,
  makeOutbox,
  makeRepos,
} from "../../storage/__tests__/unrowed-upload-fakes";

const HUMAN_ID = "human-1";
const ORG_ID = "org-1";
const PLACE_ID = "place-1";

const EXISTING_PAGE = {
  id: "page-1",
  ownerType: "HUMAN" as const,
  ownerId: HUMAN_ID,
  slug: "alice",
  displayName: "Alice",
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC" as const,
  createdAt: new Date("2026-04-01"),
  updatedAt: new Date("2026-04-01"),
};

function makeClock(now: Date): ClockPort {
  return { now: () => now };
}

function makeAuthz(
  overrides?: Partial<{
    canManagePlaceResult: { allowed: boolean };
    requireOrgRole: () => Promise<void>;
  }>,
) {
  return {
    requireOrgRole: vi.fn(overrides?.requireOrgRole ?? (async () => {})),
    canManagePlace: vi.fn(
      async () => overrides?.canManagePlaceResult ?? { allowed: true },
    ),
  };
}

function makeRequestDeps(
  overrides?: Partial<{
    page: typeof EXISTING_PAGE | null;
    authz: ReturnType<typeof makeAuthz>;
    storage: Pick<FileStoragePort, "presignPutObject">;
    quotaLimit: bigint;
    quotaUsage: bigint;
  }>,
): RequestPageImageUploadDeps {
  const storage = overrides?.storage ?? {
    presignPutObject: vi.fn(async () => ({
      uploadUrl: "https://r2.example/upload",
    })),
  };

  return {
    repos: {
      entityPages: {
        getByOwner: vi.fn(async () => overrides?.page ?? EXISTING_PAGE),
      },
      resourceQuotas: {
        getEffectiveQuota: vi.fn(async ({ kind }) => ({
          kind,
          limitValue: overrides?.quotaLimit ?? 536_870_912n,
          currentUsage: overrides?.quotaUsage ?? 0n,
          isOverride: false,
        })),
        hasPendingExpansionRequest: vi.fn(async () => false),
        incrementUsage: vi.fn(async () => ({ currentUsage: 1234n })),
      },
      pendingObjectDeletions: makeOutbox().repo,
    } as any,
    authz: overrides?.authz ?? makeAuthz(),
    storage: storage as FileStoragePort,
    clock: makeClock(new Date("2026-04-30T12:00:00.000Z")),
  };
}

/** In-memory store, outbox and quota ledger; see unrowed-upload-fakes. */
function makeFinalizeDeps(
  overrides?: Partial<{
    page: typeof EXISTING_PAGE | null;
    authz: ReturnType<typeof makeAuthz>;
  }>,
) {
  const store = makeObjectStore();
  const db = makeRepos({
    page: overrides?.page === null ? null : (overrides?.page ?? EXISTING_PAGE),
  });
  const deps = {
    repos: db.repos,
    authz: overrides?.authz ?? makeAuthz(),
    clock: makeClock(new Date("2026-04-30T12:05:00.000Z")),
    storage: store.storage,
    reportError: vi.fn(),
  } as FinalizePageImageUploadDeps;
  return { deps, store, db };
}

const mintedKey = (prefix: string) => `${prefix}2026-04-30/${randomUUID()}.jpg`;

describe("entity page image uploads", () => {
  it("requests a public image upload URL and charges human quota for human pages", async () => {
    const deps = makeRequestDeps();

    const result = await requestPageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "HUMAN",
      ownerId: HUMAN_ID,
      contentType: "image/png",
      sizeBytes: 1234,
    });

    expect(result.uploadUrl).toBe("https://r2.example/upload");
    expect(result.key).toMatch(
      /^entity-pages\/human\/human-1\/2026-04-30\/.+\.png$/,
    );
    expect(deps.storage.presignPutObject).toHaveBeenCalledWith(
      expect.objectContaining({
        key: result.key,
        contentType: "image/png",
        sizeBytes: 1234,
        public: true,
        metadata: expect.objectContaining({
          "th-kind": "entity-page-image",
          "th-owner-type": "HUMAN",
          "th-owner-id": HUMAN_ID,
          // The finalize refuses an upload stamped with another human.
          "th-actor-human-id": HUMAN_ID,
        }),
      }),
    );
    expect(deps.repos.resourceQuotas.incrementUsage).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: HUMAN_ID,
      kind: "STORAGE_BYTES_HUMAN",
      delta: 1234n,
    });
    // N3: who asked for the key, recorded before the URL is handed out, as
    // the upload's deletion once the URL has expired (15 min + 15 min).
    expect(deps.repos.pendingObjectDeletions.enqueueOnce).toHaveBeenCalledWith({
      id: uploadRequestId(result.key),
      targetKey: result.key,
      targetKind: "KEY",
      source: "entity_page_image_upload_request",
      sourceId: HUMAN_ID,
      notBefore: new Date("2026-04-30T12:30:00.000Z"),
    });
    const recordedAt = vi.mocked(deps.repos.pendingObjectDeletions.enqueueOnce).mock
      .invocationCallOrder[0]!;
    const presignedAt = vi.mocked(deps.storage.presignPutObject).mock.invocationCallOrder[0]!;
    expect(recordedAt).toBeLessThan(presignedAt);
  });

  it("authorizes organization pages and charges org storage quota", async () => {
    const authz = makeAuthz();
    const deps = makeRequestDeps({
      authz,
      page: { ...EXISTING_PAGE, ownerType: "ORGANIZATION", ownerId: ORG_ID },
    });

    await requestPageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      contentType: "image/webp",
      sizeBytes: 4567,
    });

    expect(authz.requireOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ actorHumanId: HUMAN_ID, orgId: ORG_ID }),
    );
    expect(deps.repos.resourceQuotas.incrementUsage).toHaveBeenCalledWith({
      subjectType: "ORG",
      subjectId: ORG_ID,
      kind: "STORAGE_BYTES_ORG",
      delta: 4567n,
    });
  });

  it("uses actor human quota for place page uploads", async () => {
    const deps = makeRequestDeps({
      page: { ...EXISTING_PAGE, ownerType: "PLACE", ownerId: PLACE_ID },
    });

    await requestPageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      contentType: "image/jpeg",
      sizeBytes: 2000,
    });

    expect(deps.authz.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: HUMAN_ID,
      placeId: PLACE_ID,
    });
    expect(deps.repos.resourceQuotas.incrementUsage).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: HUMAN_ID,
      kind: "STORAGE_BYTES_HUMAN",
      delta: 2000n,
    });
  });

  it("accepts animated GIF uploads", async () => {
    const deps = makeRequestDeps();

    const result = await requestPageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "HUMAN",
      ownerId: HUMAN_ID,
      contentType: "image/gif",
      sizeBytes: 2048,
    });

    expect(result.key).toMatch(
      /^entity-pages\/human\/human-1\/2026-04-30\/.+\.gif$/,
    );
    expect(deps.storage.presignPutObject).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "image/gif" }),
    );
  });

  it("rejects uploads larger than the max image size", async () => {
    const deps = makeRequestDeps();

    await expect(
      requestPageImageUpload(deps, {
        actorHumanId: HUMAN_ID,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        contentType: "image/gif",
        sizeBytes: 25 * 1024 * 1024 + 1,
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: expect.arrayContaining([
        expect.objectContaining({ message: "file_too_large" }),
      ]),
    });

    expect(deps.storage.presignPutObject).not.toHaveBeenCalled();
  });

  it("rejects image upload requests from non-owners", async () => {
    const deps = makeRequestDeps();

    await expect(
      requestPageImageUpload(deps, {
        actorHumanId: HUMAN_ID,
        ownerType: "HUMAN",
        ownerId: "other-human",
        contentType: "image/png",
        sizeBytes: 1234,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(deps.storage.presignPutObject).not.toHaveBeenCalled();
  });

  it("rejects upload requests that exceed quota", async () => {
    const deps = makeRequestDeps({ quotaLimit: 100n, quotaUsage: 95n });

    await expect(
      requestPageImageUpload(deps, {
        actorHumanId: HUMAN_ID,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        contentType: "image/png",
        sizeBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: "quota_exceeded" });

    expect(deps.storage.presignPutObject).not.toHaveBeenCalled();
  });

  it("finalizes an owned page image: returns its STRIPPED copy's URL and deletes the upload", async () => {
    const { deps, store, db } = makeFinalizeDeps();
    const key = mintedKey("entity-pages/human/human-1/");
    const file = phoneJpeg().file;
    store.put(key, file, "image/jpeg");
    const copyKey = strippedImageKey(key, stripImageMetadata(file, "image/jpeg").bytes);

    const result = await finalizePageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "HUMAN",
      ownerId: HUMAN_ID,
      key,
    });

    expect(result.publicUrl).toBe(`${CDN}/${copyKey}`);
    expect(store.objects.has(key)).toBe(false);
    expect(store.objects.has(copyKey)).toBe(true);
    expect(db.outbox.list()).toEqual([
      expect.objectContaining({
        id: uploadClaimId(key),
        targetKey: key,
        source: "entity_page_image_upload_original_after_presign",
        sourceId: copyKey,
      }),
    ]);
  });

  it("rejects finalizing an image key outside the owner prefix", async () => {
    const { deps, store } = makeFinalizeDeps();

    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: HUMAN_ID,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        key: mintedKey("entity-pages/human/someone-else/"),
      }),
    ).rejects.toMatchObject({ code: "PAGE_IMAGE_KEY_NOT_OWNED" });

    expect(store.storage.headObject).not.toHaveBeenCalled();
  });

  it("rejects finalizing when the uploaded object is missing", async () => {
    const { deps, store } = makeFinalizeDeps();

    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: HUMAN_ID,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        key: mintedKey("entity-pages/human/human-1/"),
      }),
    ).rejects.toMatchObject({ code: "UPLOADED_PAGE_IMAGE_NOT_FOUND" });

    expect(store.storage.getObjectUrl).not.toHaveBeenCalled();
  });

  // F11 (2026-09-29): quota is charged from the declared size, so finalize
  // must refuse — and delete — an object bigger than its declaration.
  it("deletes and rejects an uploaded page image bigger than declared, without reading it", async () => {
    const { deps, store } = makeFinalizeDeps();
    const key = mintedKey("entity-pages/human/human-1/");
    store.put(key, phoneJpeg().file, "image/jpeg");
    store.storage.headObject.mockImplementationOnce(async () => ({
      exists: true,
      size: 2048,
      metadata: { "th-declared-bytes": "1" },
    }));

    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: HUMAN_ID,
        ownerType: "HUMAN",
        ownerId: HUMAN_ID,
        key,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "upload_size_exceeded",
    });
    expect(store.storage.deleteObject).toHaveBeenCalledWith({ key });
    expect(store.storage.getObject).not.toHaveBeenCalled();
  });

  it("place pages: the strip's savings go back to the uploading human's quota", async () => {
    const { deps, store, db } = makeFinalizeDeps();
    const key = mintedKey("entity-pages/place/place-1/");
    const file = phoneJpeg().file;
    store.put(key, file, "image/jpeg");

    await finalizePageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      key,
    });

    const copyBytes = stripImageMetadata(file, "image/jpeg").bytes;
    expect(db.quotaDeltas).toEqual([
      {
        subjectType: "HUMAN",
        subjectId: HUMAN_ID,
        kind: "STORAGE_BYTES_HUMAN",
        delta: -BigInt(file.length - copyBytes.length),
      },
    ]);
  });

  // A place page's prefix names the place, not the uploader, and the
  // request charged the REQUESTING human. Another manager who learns the
  // key must not finalize it: the strip's savings would be credited to
  // them, and the requester's own finalize would then be refused.
  it("place pages: a finalize by a manager other than the uploader is NOT_FOUND, touching nothing", async () => {
    const { deps, store, db } = makeFinalizeDeps();
    const key = mintedKey("entity-pages/place/place-1/");
    const file = phoneJpeg().file;
    store.put(key, file, "image/jpeg", { "th-actor-human-id": "uploader-human" });

    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: HUMAN_ID,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({ code: "UPLOADED_PAGE_IMAGE_NOT_FOUND" });

    expect(store.objects.get(key)?.content).toBe(file);
    expect(store.storage.deleteObject).not.toHaveBeenCalled();
    expect(store.storage.getObject).not.toHaveBeenCalled();
    expect(store.storage.putObject).not.toHaveBeenCalled();
    expect(db.quotaDeltas).toEqual([]);
    expect(db.outbox.list()).toEqual([]);

    // The uploader's own finalize still publishes it, credited to them.
    const result = await finalizePageImageUpload(deps, {
      actorHumanId: "uploader-human",
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      key,
    });
    const copyKey = strippedImageKey(key, stripImageMetadata(file, "image/jpeg").bytes);
    expect(result.publicUrl).toBe(`${CDN}/${copyKey}`);
    expect(db.quotaDeltas).toEqual([
      expect.objectContaining({ subjectType: "HUMAN", subjectId: "uploader-human" }),
    ]);
  });

  // N3 (round 2): the stamp above lives in presign-time metadata, which not
  // every store keeps (the SDK hoists it into the query string). The
  // request's outbox row names the uploader whatever the store does.
  it("place pages: the REQUEST ROW refuses another manager's finalize, with no metadata on the object", async () => {
    const { deps, store, db } = makeFinalizeDeps();
    const key = mintedKey("entity-pages/place/place-1/");
    const file = phoneJpeg().file;
    store.put(key, file, "image/jpeg"); // no metadata: a store that drops it
    await recordUploadRequest(db.outbox.repo, {
      kind: { source: "entity_page_image_upload", presignTtlSeconds: 900 },
      uploadKey: key,
      actorHumanId: "uploader-human",
      now: new Date(),
    });

    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: HUMAN_ID,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({ code: "UPLOADED_PAGE_IMAGE_NOT_FOUND" });

    // Refused before the HEAD: nothing read, deleted, written or credited.
    expect(store.storage.headObject).not.toHaveBeenCalled();
    expect(store.storage.deleteObject).not.toHaveBeenCalled();
    expect(store.objects.get(key)?.content).toBe(file);
    expect(db.quotaDeltas).toEqual([]);
    expect(db.outbox.list().map((r) => r.id)).toEqual([uploadRequestId(key)]);

    // The requester's own finalize publishes it, credited to them.
    await finalizePageImageUpload(deps, {
      actorHumanId: "uploader-human",
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      key,
    });
    expect(store.objects.has(key)).toBe(false);
    expect(db.quotaDeltas).toEqual([
      expect.objectContaining({ subjectId: "uploader-human" }),
    ]);
    // Both rows target the upload key; the drain deletes it twice (a no-op
    // the second time) and the request row's due time is not later.
    const request = db.outbox.rows.get(uploadRequestId(key))!;
    const claim = db.outbox.rows.get(uploadClaimId(key))!;
    expect(request.targetKey).toBe(key);
    expect(claim.targetKey).toBe(key);
    expect(request.nextAttemptAt.getTime()).toBeLessThanOrEqual(claim.nextAttemptAt.getTime());
  });

  it("a repeat whose copy has since been deleted is NOT_FOUND, not a storage error", async () => {
    const { deps, store } = makeFinalizeDeps();
    const key = mintedKey("entity-pages/human/human-1/");
    store.put(key, phoneJpeg().file, "image/jpeg");
    const input = { actorHumanId: HUMAN_ID, ownerType: "HUMAN" as const, ownerId: HUMAN_ID, key };
    const { publicUrl } = await finalizePageImageUpload(deps, input);
    store.objects.delete(publicUrl.slice(`${CDN}/`.length));

    await expect(finalizePageImageUpload(deps, input)).rejects.toMatchObject({
      code: "UPLOADED_PAGE_IMAGE_NOT_FOUND",
    });
  });

  it("an upload stamped with the finalizing human publishes as usual", async () => {
    const { deps, store } = makeFinalizeDeps();
    const key = mintedKey("entity-pages/place/place-1/");
    store.put(key, phoneJpeg().file, "image/jpeg", { "th-actor-human-id": HUMAN_ID });

    const result = await finalizePageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      key,
    });

    expect(result.publicUrl).toMatch(/^https:\/\/cdn\.example\/entity-pages\/place\/place-1\//);
    expect(store.objects.has(key)).toBe(false);
  });

  it("an animated GIF is published as a stripped GIF", async () => {
    const { deps, store } = makeFinalizeDeps();
    const key = mintedKey("entity-pages/human/human-1/").replace(/\.jpg$/, ".gif");
    store.put(
      key,
      Buffer.concat([gifHeader(), gifNetscapeLoop(), gifComment(), gifGraphicControl(), gifImage(), GIF_TRAILER]),
      "image/gif",
    );

    const result = await finalizePageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "HUMAN",
      ownerId: HUMAN_ID,
      key,
    });

    const copyKey = result.publicUrl.slice(CDN.length + 1);
    expect(copyKey).toMatch(/\/[0-9a-f]{32}\.gif$/);
    expect(store.objects.get(copyKey)?.contentType).toBe("image/gif");
    expect(store.objects.get(copyKey)?.content.includes(SECRET.gif)).toBe(false);
    expect(store.objects.has(key)).toBe(false);
  });
});

// ── Community moderator on a PLACE nobody owns ─────────────────────────────
// Moderator place page spec (FR-001..FR-004, D4/D5): the request is advisory
// (it writes no page data); the finalize's claim runs under the place's
// claim lock, re-checked, and logs `entity_page.community_updated`.

const MODERATOR = "human-moderator";
const MODERATOR_NOW = new Date("2026-04-30T12:05:00.000Z");

/** The moderator's access fakes: places, events, audit, claim lock. */
function makeModeratorWorld(opts: { owned?: boolean } = {}) {
  let ownerships: { id: string; humanId: string; verified: boolean }[] = [];
  let onClaimLock: (() => void) | null = null;
  const place = {
    id: PLACE_ID,
    status: "ACTIVE",
    verificationStatus: "UNVERIFIED",
    orgIdsWithAccess: opts.owned ? [ORG_ID] : ([] as string[]),
    humanIdsWithAccess: [] as string[],
  };
  const places = {
    getById: vi.fn(async (id: string) => (id === PLACE_ID ? { ...place } : null)),
    listActiveOwnershipsForPlace: vi.fn(async () => [...ownerships]),
    lockPlaceForClaim: vi.fn(async () => {
      onClaimLock?.();
    }),
  };
  const events = { hasOwnedLiveEventsAtPlace: vi.fn(async () => false) };
  const audits: unknown[] = [];
  /** Which transaction (1-based) wrote each audit row. */
  const auditTx: number[] = [];
  const audit = { log: vi.fn(async (entry: unknown) => void audits.push(entry)) };
  const authz = {
    requireOrgRole: vi.fn(async () => {}),
    canManagePlace: vi.fn(async () => ({ allowed: false })),
    hasStaffRole: vi.fn(async (args: { actorHumanId: string }) => ({
      allowed: args.actorHumanId === MODERATOR,
    })),
  };
  return {
    places,
    events,
    audit,
    audits,
    auditTx,
    authz,
    setOwnerships: (next: typeof ownerships) => {
      ownerships = next;
    },
    onClaimLock: (fn: () => void) => {
      onClaimLock = fn;
    },
  };
}

function moderatorFinalizeDeps(world: ReturnType<typeof makeModeratorWorld>) {
  const built = makeFinalizeDeps({
    page: { ...EXISTING_PAGE, ownerType: "PLACE" as never, ownerId: PLACE_ID },
  });
  const root = built.deps.repos;
  // The image review records exist ONLY on the transaction's repos, so a
  // record created at all was created inside a transaction.
  const reviewRecords: Array<{ txIndex: number; input: unknown }> = [];
  let txIndex = 0;
  const repos = {
    ...root,
    places: world.places,
    events: world.events,
    tx: (fn: (tx: unknown) => Promise<unknown>) => {
      const index = ++txIndex;
      return root.tx((tx) =>
        fn({
          ...tx,
          places: world.places,
          events: world.events,
          audit: {
            log: vi.fn(async (entry: unknown) => {
              world.auditTx.push(index);
              await world.audit.log(entry);
            }),
          },
          imageModerationRecords: {
            create: vi.fn(async (input: unknown) => {
              reviewRecords.push({ txIndex: index, input });
            }),
          },
        }),
      );
    },
  };
  const deps = {
    ...built.deps,
    repos,
    authz: world.authz,
  } as unknown as FinalizePageImageUploadDeps;
  return { ...built, deps, reviewRecords };
}

/** The request row a community moderator's request writes (pins the PLACE charge). */
async function recordCommunityRequest(
  outbox: ReturnType<typeof makeRepos>["outbox"],
  key: string,
  actor = MODERATOR,
) {
  await recordUploadRequest(outbox.repo, {
    kind: {
      source: PAGE_IMAGE_COMMUNITY_UPLOAD_SOURCE,
      presignTtlSeconds: 900,
    },
    uploadKey: key,
    actorHumanId: actor,
    now: new Date("2026-04-30T12:00:00.000Z"),
  });
}

const PLACE_QUOTA = {
  subjectType: "PLACE",
  subjectId: PLACE_ID,
  kind: "STORAGE_BYTES_PLACE",
} as const;

describe("page images: community moderator on an unowned PLACE page", () => {
  it("requests an upload on an unowned place (advisory: no lock, no audit)", async () => {
    const world = makeModeratorWorld();
    const base = makeRequestDeps({
      page: { ...EXISTING_PAGE, ownerType: "PLACE" as never, ownerId: PLACE_ID },
    });
    const deps = {
      ...base,
      repos: { ...base.repos, places: world.places, events: world.events },
      authz: world.authz,
    } as unknown as RequestPageImageUploadDeps;

    const result = await requestPageImageUpload(deps, {
      actorHumanId: MODERATOR,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      contentType: "image/jpeg",
      sizeBytes: 1234,
    });
    expect(result.key).toMatch(/^entity-pages\/place\/place-1\//);
    expect(world.places.lockPlaceForClaim).not.toHaveBeenCalled();
    expect(world.audits).toEqual([]);
  });

  it("refuses the request PLACE_HAS_OWNER on an owned place, presigning nothing", async () => {
    const world = makeModeratorWorld({ owned: true });
    const base = makeRequestDeps();
    const deps = {
      ...base,
      repos: { ...base.repos, places: world.places, events: world.events },
      authz: world.authz,
    } as unknown as RequestPageImageUploadDeps;
    await expect(
      requestPageImageUpload(deps, {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        contentType: "image/jpeg",
        sizeBytes: 1234,
      }),
    ).rejects.toMatchObject({ code: "PLACE_HAS_OWNER", meta: { reason: "OWNED" } });
    expect(deps.storage.presignPutObject).not.toHaveBeenCalled();
  });

  it("finalizes under the claim lock and logs one community audit row", async () => {
    const world = makeModeratorWorld();
    const { deps, store } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    const file = phoneJpeg().file;
    store.put(key, file, "image/jpeg", { "th-actor-human-id": MODERATOR });
    const copyKey = strippedImageKey(key, stripImageMetadata(file, "image/jpeg").bytes);

    const result = await finalizePageImageUpload(deps, {
      actorHumanId: MODERATOR,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      key,
    });

    expect(result.publicUrl).toBe(`${CDN}/${copyKey}`);
    expect(world.places.lockPlaceForClaim).toHaveBeenCalledWith(PLACE_ID);
    expect(world.audits).toEqual([
      {
        entity: "entity_page",
        entityId: "page-1",
        action: "entity_page.community_updated",
        data: {
          actorHumanId: MODERATOR,
          placeId: PLACE_ID,
          pageId: "page-1",
          op: "finalizePageImageUpload",
          fields: ["pageImage"],
          from: null,
          to: { key: copyKey, url: `${CDN}/${copyKey}` },
        },
        at: MODERATOR_NOW,
      },
    ]);
  });

  it("a claim landing before the finalize's lock refuses it (D4): nothing published or audited; the copy is outboxed and the charge credited back", async () => {
    const world = makeModeratorWorld();
    const { deps, store, db } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    const file = phoneJpeg().file;
    store.put(key, file, "image/jpeg", { "th-actor-human-id": MODERATOR });
    const copyKey = strippedImageKey(key, stripImageMetadata(file, "image/jpeg").bytes);
    world.onClaimLock(() =>
      world.setOwnerships([{ id: "own-1", humanId: "claimant", verified: false }]),
    );

    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "CLAIM_PENDING" },
    });
    expect(world.audits).toEqual([]);
    // The request charged the upload's size: all of it goes back, once.
    expect(db.quotaDeltas).toEqual([
      {
        subjectType: "HUMAN",
        subjectId: MODERATOR,
        kind: "STORAGE_BYTES_HUMAN",
        delta: -BigInt(file.length),
      },
    ]);
    // The upload is claimed as REFUSED (no later finalize can publish it),
    // and the never-charged copy is outboxed with its no-credit marker.
    const rows = db.outbox.list();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: uploadClaimId(key),
          targetKey: key,
          source: "entity_page_image_upload_refused",
        }),
        expect.objectContaining({
          targetKey: copyKey,
          source: "entity_page_image_upload_stripped_unclaimed",
        }),
        expect.objectContaining({
          targetKey: copyKey,
          source: "entity_page_image_upload_stripped_unclaimed_no_credit",
        }),
      ]),
    );
    // Fast path: the upload key is deleted after the abandon commits.
    expect(store.objects.has(key)).toBe(false);

    // A retry of the same finalize (the place freed again) publishes nothing.
    world.setOwnerships([]);
    world.onClaimLock(() => {});
    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({ code: "UPLOADED_PAGE_IMAGE_NOT_FOUND" });
    expect(db.quotaDeltas).toHaveLength(1);
  });

  it("refuses the finalize PLACE_HAS_OWNER on an owned place before any strip", async () => {
    const world = makeModeratorWorld({ owned: true });
    const { deps, store } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    store.put(key, phoneJpeg().file, "image/jpeg");
    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({ code: "PLACE_HAS_OWNER", meta: { reason: "OWNED" } });
    expect(store.storage.putObject).not.toHaveBeenCalled();
    expect(world.places.lockPlaceForClaim).not.toHaveBeenCalled();
  });

  it("a non-staff outsider is still NOT_RESOURCE_OWNER", async () => {
    const world = makeModeratorWorld();
    const { deps, store } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    store.put(key, phoneJpeg().file, "image/jpeg");
    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: "someone-else",
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("the owner's finalize takes no claim lock and writes no audit row", async () => {
    const world = makeModeratorWorld({ owned: true });
    world.authz.canManagePlace.mockResolvedValue({ allowed: true });
    const { deps, store } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    store.put(key, phoneJpeg().file, "image/jpeg");
    await finalizePageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      key,
    });
    expect(world.places.lockPlaceForClaim).not.toHaveBeenCalled();
    expect(world.audits).toEqual([]);
    expect(world.authz.hasStaffRole).not.toHaveBeenCalled();
  });
});

// ── Image review + place-held quota for moderator uploads (R5) ─────────────
// Owner ruling 2026-10-16: a moderator's page uploads go through the image
// review, and are held by the place (STORAGE_BYTES_PLACE), not the moderator.

describe("page images: a community moderator's upload is reviewed and held by the place (R5)", () => {
  function moderatorRequestDeps(world: ReturnType<typeof makeModeratorWorld>) {
    const base = makeRequestDeps({
      page: { ...EXISTING_PAGE, ownerType: "PLACE" as never, ownerId: PLACE_ID },
    });
    return {
      ...base,
      repos: { ...base.repos, places: world.places, events: world.events },
      authz: world.authz,
    } as unknown as RequestPageImageUploadDeps;
  }

  it("the moderator's request CHECKS the PLACE's quota, charges nothing, and pins the place in the request row", async () => {
    const world = makeModeratorWorld();
    const deps = moderatorRequestDeps(world);
    const result = await requestPageImageUpload(deps, {
      actorHumanId: MODERATOR,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      contentType: "image/jpeg",
      sizeBytes: 1234,
    });
    expect(deps.repos.resourceQuotas.getEffectiveQuota).toHaveBeenCalledWith({
      ...PLACE_QUOTA,
    });
    // Charged at finalize: a request nobody finalizes costs the place nothing.
    expect(deps.repos.resourceQuotas.incrementUsage).not.toHaveBeenCalled();
    expect(deps.repos.pendingObjectDeletions.enqueueOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        id: uploadRequestId(result.key),
        source: "entity_page_image_upload_community_request",
        sourceId: MODERATOR,
      }),
    );
  });

  it("the moderator's request is refused when the PLACE's quota cannot hold the declared size", async () => {
    const world = makeModeratorWorld();
    const base = makeRequestDeps({
      page: { ...EXISTING_PAGE, ownerType: "PLACE" as never, ownerId: PLACE_ID },
      quotaLimit: 2_000n,
      quotaUsage: 1_000n,
    });
    const deps = {
      ...base,
      repos: { ...base.repos, places: world.places, events: world.events },
      authz: world.authz,
    } as unknown as RequestPageImageUploadDeps;
    await expect(
      requestPageImageUpload(deps, {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        contentType: "image/jpeg",
        sizeBytes: 1_234,
      }),
    ).rejects.toMatchObject({
      message: "quota_exceeded",
      meta: { subjectType: "PLACE", kind: "STORAGE_BYTES_PLACE" },
    });
    expect(deps.storage.presignPutObject).not.toHaveBeenCalled();
    expect(deps.repos.resourceQuotas.incrementUsage).not.toHaveBeenCalled();
  });

  it("a place OWNER's request still charges the owner's human quota", async () => {
    const world = makeModeratorWorld({ owned: true });
    world.authz.canManagePlace.mockResolvedValue({ allowed: true });
    const deps = moderatorRequestDeps(world);
    await requestPageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      contentType: "image/jpeg",
      sizeBytes: 1234,
    });
    expect(deps.repos.resourceQuotas.incrementUsage).toHaveBeenCalledWith({
      subjectType: "HUMAN",
      subjectId: HUMAN_ID,
      kind: "STORAGE_BYTES_HUMAN",
      delta: 1234n,
    });
    expect(deps.repos.pendingObjectDeletions.enqueueOnce).toHaveBeenCalledWith(
      expect.objectContaining({ source: "entity_page_image_upload_request" }),
    );
  });

  it("the moderator's finalize enqueues ONE pending review record for the stripped copy, in the claim's transaction, and charges the stripped size to the PLACE once", async () => {
    const world = makeModeratorWorld();
    const { deps, store, db, reviewRecords } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    const file = phoneJpeg().file;
    store.put(key, file, "image/jpeg", { "th-actor-human-id": MODERATOR });
    await recordCommunityRequest(db.outbox, key);
    const copyKey = strippedImageKey(key, stripImageMetadata(file, "image/jpeg").bytes);

    const result = await finalizePageImageUpload(deps, {
      actorHumanId: MODERATOR,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      key,
    });

    expect(result.publicUrl).toBe(`${CDN}/${copyKey}`);
    expect(reviewRecords).toEqual([
      {
        txIndex: 1,
        input: {
          storageKey: copyKey,
          kind: "PAGE_MEDIA",
          subjectType: "PLACE",
          subjectId: PLACE_ID,
          publicUrl: `${CDN}/${copyKey}`,
          contentType: "image/jpeg",
          createdByHumanId: MODERATOR,
        },
      },
    ]);
    // Same transaction as the claim's audit row.
    expect(world.auditTx).toEqual([1]);
    // The place is charged the STORED copy's size (the phone JPEG loses its
    // EXIF), once; nothing is credited, since the request charged nothing.
    const strippedSize = stripImageMetadata(file, "image/jpeg").bytes.length;
    expect(strippedSize).toBeLessThan(file.length);
    expect(db.quotaDeltas).toEqual([
      { ...PLACE_QUOTA, delta: BigInt(strippedSize) },
    ]);

    // A repeat finalize enqueues nothing more and charges nothing more.
    const repeat = await finalizePageImageUpload(deps, {
      actorHumanId: MODERATOR,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      key,
    });
    expect(repeat.publicUrl).toBe(result.publicUrl);
    expect(reviewRecords).toHaveLength(1);
    expect(db.quotaDeltas).toHaveLength(1);
  });

  it("a moderator finalize the place's quota cannot hold is refused: no URL, no charge, no review record", async () => {
    const world = makeModeratorWorld();
    const { deps, store, db, reviewRecords } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    const file = phoneJpeg().file;
    store.put(key, file, "image/jpeg", { "th-actor-human-id": MODERATOR });
    await recordCommunityRequest(db.outbox, key);
    // Requests in flight together each passed the request's check.
    db.setQuotaLimit(10n);

    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "quota_exceeded",
      meta: { subjectType: "PLACE", kind: "STORAGE_BYTES_PLACE" },
    });
    expect(db.quotaDeltas).toEqual([]);
    expect(reviewRecords).toEqual([]);
    expect(world.audits).toEqual([]);
    expect(store.objects.has(key)).toBe(false);
  });

  it("the owner's finalize writes no review record", async () => {
    const world = makeModeratorWorld({ owned: true });
    world.authz.canManagePlace.mockResolvedValue({ allowed: true });
    const { deps, store, db, reviewRecords } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    store.put(key, phoneJpeg().file, "image/jpeg");
    await finalizePageImageUpload(deps, {
      actorHumanId: HUMAN_ID,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      key,
    });
    expect(reviewRecords).toEqual([]);
    for (const delta of db.quotaDeltas) {
      expect(delta).toMatchObject({
        subjectType: "HUMAN",
        subjectId: HUMAN_ID,
        kind: "STORAGE_BYTES_HUMAN",
      });
    }
  });

  it("a refused moderator finalize writes no review record and charges (and credits) the PLACE nothing", async () => {
    const world = makeModeratorWorld();
    const { deps, store, db, reviewRecords } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    const file = phoneJpeg().file;
    store.put(key, file, "image/jpeg", { "th-actor-human-id": MODERATOR });
    await recordCommunityRequest(db.outbox, key);
    world.onClaimLock(() =>
      world.setOwnerships([{ id: "own-1", humanId: "claimant", verified: false }]),
    );

    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({ code: "PLACE_HAS_OWNER" });
    expect(reviewRecords).toEqual([]);
    expect(db.quotaDeltas).toEqual([]);
  });

  it("an unreadable moderator upload charges (and credits) the PLACE nothing", async () => {
    const world = makeModeratorWorld();
    const { deps, store, db, reviewRecords } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    const junk = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    store.put(key, junk, "image/jpeg", { "th-actor-human-id": MODERATOR });
    await recordCommunityRequest(db.outbox, key);

    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(reviewRecords).toEqual([]);
    expect(db.quotaDeltas).toEqual([]);
  });

  it("the PLACE charge is pinned by the request row: a moderator who became the owner before finalizing is charged to the place, and not reviewed", async () => {
    const world = makeModeratorWorld({ owned: true });
    world.authz.canManagePlace.mockResolvedValue({ allowed: true });
    const { deps, store, db, reviewRecords } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    store.put(key, phoneJpeg().file, "image/jpeg", {
      "th-actor-human-id": MODERATOR,
    });
    await recordCommunityRequest(db.outbox, key);

    await finalizePageImageUpload(deps, {
      actorHumanId: MODERATOR,
      ownerType: "PLACE",
      ownerId: PLACE_ID,
      key,
    });
    expect(db.quotaDeltas).toHaveLength(1);
    expect(db.quotaDeltas[0]).toMatchObject(PLACE_QUOTA);
    expect(db.quotaDeltas[0]!.delta > 0n).toBe(true);
    expect(reviewRecords).toEqual([]);
  });
});

describe("abandonStrippedUpload", () => {
  const KIND = {
    source: "entity_page_image_upload",
    useCase: "finalizePageImageUpload",
    maxBytes: 10_000_000,
    presignTtlSeconds: 900,
  };
  const QUOTA = {
    subjectType: "HUMAN" as const,
    subjectId: HUMAN_ID,
    kind: "STORAGE_BYTES_HUMAN" as const,
  };

  it("leaves a copy an earlier finalize of the SAME bytes published alone: only the upload is queued", async () => {
    const db = makeRepos();
    const uploadKey = mintedKey("entity-pages/place/place-1/");
    const copyKey = "entity-pages/place/place-1/2026-04-30/" + "c".repeat(32) + ".jpg";
    await db.outbox.repo.enqueueOnce({
      id: uploadClaimId(uploadKey),
      targetKey: uploadKey,
      targetKind: "KEY",
      source: "entity_page_image_upload_original_after_presign",
      sourceId: copyKey,
      notBefore: new Date(Date.now() + 3_600_000),
    });

    const result = await abandonStrippedUpload(
      { repos: db.repos },
      { kind: KIND, uploadKey, copy: { key: copyKey }, uploadSize: 1234, quotaSubject: QUOTA },
    );

    expect(result.credited).toBe(false);
    const rows = db.outbox.list();
    expect(rows.filter((row) => row.targetKey === copyKey)).toEqual([]);
    expect(rows.find((row) => row.id === creditMarkerId(copyKey))).toBeUndefined();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: result.dueNowId,
          targetKey: uploadKey,
          source: "entity_page_image_upload_original",
        }),
      ]),
    );
    expect(db.quotaDeltas).toEqual([]);
  });

  it("outboxes a copy nobody published, with its never-credit marker, and credits once", async () => {
    const db = makeRepos();
    const uploadKey = mintedKey("entity-pages/place/place-1/");
    const copyKey = "entity-pages/place/place-1/2026-04-30/" + "d".repeat(32) + ".jpg";
    const first = await abandonStrippedUpload(
      { repos: db.repos },
      { kind: KIND, uploadKey, copy: { key: copyKey }, uploadSize: 1234, quotaSubject: QUOTA },
    );
    expect(first.credited).toBe(true);
    expect(db.outbox.list().some((row) => row.targetKey === copyKey)).toBe(true);
    expect(db.outbox.list().some((row) => row.id === creditMarkerId(copyKey))).toBe(true);
    expect(db.quotaDeltas).toEqual([{ ...QUOTA, delta: -1234n }]);
  });

  it("a null subject (the request charged nothing) credits nothing, and still outboxes the copy", async () => {
    const db = makeRepos();
    const uploadKey = mintedKey("entity-pages/place/place-1/");
    const copyKey = "entity-pages/place/place-1/2026-04-30/" + "e".repeat(32) + ".jpg";
    const result = await abandonStrippedUpload(
      { repos: db.repos },
      { kind: KIND, uploadKey, copy: { key: copyKey }, uploadSize: 1234, quotaSubject: null },
    );
    expect(result.credited).toBe(false);
    expect(db.outbox.list().some((row) => row.targetKey === copyKey)).toBe(true);
    expect(db.quotaDeltas).toEqual([]);
  });
});

describe("finalizePageImageUpload: a failing cleanup after a moderator refusal", () => {
  it("reports the cleanup error and still throws the ORIGINAL refusal", async () => {
    const world = makeModeratorWorld();
    const { deps, store } = moderatorFinalizeDeps(world);
    const key = mintedKey("entity-pages/place/place-1/");
    store.put(key, phoneJpeg().file, "image/jpeg", { "th-actor-human-id": MODERATOR });
    world.onClaimLock(() =>
      world.setOwnerships([{ id: "own-1", humanId: "claimant", verified: false }]),
    );
    // The claim tx refuses; the next tx (the abandon) fails.
    const repos = deps.repos as unknown as { tx: (fn: unknown) => Promise<unknown> };
    const realTx = repos.tx;
    let txCalls = 0;
    repos.tx = (fn) => {
      txCalls += 1;
      return txCalls === 2 ? Promise.reject(new Error("db down")) : realTx(fn);
    };

    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "CLAIM_PENDING" },
    });
    expect(deps.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db down" }),
      expect.objectContaining({
        tags: {
          useCase: "finalizePageImageUpload",
          step: "abandon_refused_upload",
        },
      }),
    );
  });

  it("a THROWING reporter does not change the refusal", async () => {
    const world = makeModeratorWorld();
    const { deps, store } = moderatorFinalizeDeps(world);
    (deps as { reportError: unknown }).reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    const key = mintedKey("entity-pages/place/place-1/");
    store.put(key, phoneJpeg().file, "image/jpeg", { "th-actor-human-id": MODERATOR });
    world.onClaimLock(() =>
      world.setOwnerships([{ id: "own-1", humanId: "claimant", verified: true }]),
    );
    const repos = deps.repos as unknown as { tx: (fn: unknown) => Promise<unknown> };
    const realTx = repos.tx;
    let txCalls = 0;
    repos.tx = (fn) => {
      txCalls += 1;
      return txCalls === 2 ? Promise.reject(new Error("db down")) : realTx(fn);
    };
    await expect(
      finalizePageImageUpload(deps, {
        actorHumanId: MODERATOR,
        ownerType: "PLACE",
        ownerId: PLACE_ID,
        key,
      }),
    ).rejects.toMatchObject({ code: "PLACE_HAS_OWNER", meta: { reason: "OWNED" } });
  });
});
