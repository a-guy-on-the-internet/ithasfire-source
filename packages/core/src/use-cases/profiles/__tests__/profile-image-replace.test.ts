import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ReporterPort } from "@th/ports/reporter";

import { stripImageMetadata } from "../../../lib/images/strip-image-metadata";
import { phoneJpeg } from "../../../lib/images/__tests__/image-fixtures";
import { strippedImageKey } from "../../storage/strip-uploaded-image";
import {
  CREDIT_MARKER_TTL_MS,
  claimStrippedUpload,
  creditMarkerId,
  uploadClaimId,
} from "../../storage/publish-stripped-upload";
import {
  CDN,
  makeLogger,
  makeObjectStore,
  makeRepos,
} from "../../storage/__tests__/unrowed-upload-fakes";
import { updatePage } from "../../entity-pages/update-page";
import {
  REPLACED_IMAGE_CREDIT_SOURCE,
  cleanupReplacedImage,
} from "../cleanup-replaced-image";
import { setAvatarFromUpload } from "../set-avatar-from-upload";
import { setBannerFromUpload } from "../set-banner-from-upload";

// ───────────────────────────────────────────────────────────────────────────
// Replacing a profile image. The page now names a STRIPPED COPY, so the
// replaced image's cleanup must delete the OLD page URL's key (the old copy,
// or the upload key of a profile set before stripping existed), never the
// copy just published, and credit back what the old object holds.
//
// The cleanup runs AFTER the profile transaction commits. It used to run
// inside it, in a bare `try {} catch {}`: a failed statement there aborts the
// Postgres transaction, Postgres answers COMMIT with ROLLBACK and no error,
// Prisma resolves anyway, so the new URL was silently discarded while the
// old blob was already deleted. The fakes have no rollback, so what these
// tests prove is ORDERING: the cleanup's storage and quota calls land after
// the commit boundary (`txCommitted`).
// ───────────────────────────────────────────────────────────────────────────

const HUMAN_ID = "00000000-0000-4000-8000-000000000000";
const day = "2026-10-08";

const cases = [
  {
    name: "avatar",
    field: "avatarUrl" as const,
    prefix: `avatars/human/${HUMAN_ID}/`,
    useCase: "setAvatarFromUpload",
    run: async (deps: Parameters<typeof setAvatarFromUpload>[0], key: string) =>
      (await setAvatarFromUpload(deps, { actorHumanId: HUMAN_ID, key })).avatarUrl,
  },
  {
    name: "banner",
    field: "bannerUrl" as const,
    prefix: `banners/human/${HUMAN_ID}/`,
    useCase: "setBannerFromUpload",
    run: async (deps: Parameters<typeof setBannerFromUpload>[0], key: string) =>
      (await setBannerFromUpload(deps, { actorHumanId: HUMAN_ID, key })).bannerUrl,
  },
];

describe.each(cases)("$name: replacing the current image", (c) => {
  const oldCopyKey = `${c.prefix}2026-09-01/${"e".repeat(32)}.jpg`;

  function setup(opts: { oldKey?: string; failDelete?: string[] } = {}) {
    const oldKey = opts.oldKey ?? oldCopyKey;
    const store = makeObjectStore();
    store.put(oldKey, Buffer.alloc(40_000, 7), "image/jpeg");
    for (const key of opts.failDelete ?? []) store.failDeletesOf.add(key);
    const db = makeRepos({
      page: { ownerId: HUMAN_ID, [c.field]: `${CDN}/${oldKey}` },
    });
    const uploadKey = `${c.prefix}${day}/${randomUUID()}.jpg`;
    const file = phoneJpeg().file;
    store.put(uploadKey, file, "image/jpeg");
    const newCopyKey = strippedImageKey(uploadKey, stripImageMetadata(file, "image/jpeg").bytes);
    const logger = makeLogger();
    const reportError = vi.fn() as ReturnType<typeof vi.fn> & ReporterPort;
    const deps = { repos: db.repos, storage: store.storage, logger, reportError };
    return { store, db, uploadKey, file, newCopyKey, oldKey, logger, reportError, deps };
  }

  it("points the page at the NEW copy, deletes the OLD copy and credits its size", async () => {
    const s = setup();

    const url = await c.run(s.deps, s.uploadKey);

    expect(url).toBe(`${CDN}/${s.newCopyKey}`);
    expect(s.db.page()?.[c.field]).toBe(url);
    expect(s.store.objects.has(s.oldKey)).toBe(false);
    expect(s.store.objects.has(s.newCopyKey)).toBe(true);
    // The strip's savings at publish, then the old copy's own size.
    expect(s.db.quotaDeltas.map((d) => d.delta)).toEqual([
      -BigInt(s.file.length - s.store.objects.get(s.newCopyKey)!.content.length),
      -40_000n,
    ]);
  });

  it("a profile set before stripping existed: the old UPLOAD key is cleaned up the same way", async () => {
    const legacyKey = `${c.prefix}2026-01-01/0b9f6a1e-1234-4abc-8def-0123456789ab.jpg`;
    const s = setup({ oldKey: legacyKey });

    await c.run(s.deps, s.uploadKey);

    expect(s.store.objects.has(legacyKey)).toBe(false);
    expect(s.store.objects.has(s.newCopyKey)).toBe(true);
  });

  it("an old URL outside this human's prefix is never deleted", async () => {
    const foreign = `avatars/human/11111111-1111-4111-8111-111111111111/2026-09-01/${"f".repeat(32)}.jpg`;
    const s = setup({ oldKey: foreign });

    await c.run(s.deps, s.uploadKey);

    expect(s.store.objects.has(foreign)).toBe(true);
    expect(s.store.storage.deleteObject).not.toHaveBeenCalledWith({ key: foreign });
  });

  it("a repeat never cleans up the copy it just published", async () => {
    const s = setup();
    const first = await c.run(s.deps, s.uploadKey);
    // Same bytes PUT again, then finalized again.
    s.store.put(s.uploadKey, s.file, "image/jpeg");
    const second = await c.run(s.deps, s.uploadKey);

    expect(second).toBe(first);
    expect(s.store.objects.has(s.newCopyKey)).toBe(true);
    expect(s.store.storage.deleteObject).not.toHaveBeenCalledWith({ key: s.newCopyKey });
    expect(s.db.entityPages.upsert).toHaveBeenCalledTimes(1);
  });

  it("runs the cleanup strictly AFTER the profile transaction commits", async () => {
    const s = setup();

    await c.run(s.deps, s.uploadKey);

    // Two commits: the claim + page write, then the cleanup's own quota tx.
    expect(s.db.txCommitted).toHaveBeenCalledTimes(2);
    const committedAt = s.db.txCommitted.mock.invocationCallOrder[0]!;
    const deleteCalls = s.store.storage.deleteObject.mock;
    const oldDeleteAt =
      deleteCalls.invocationCallOrder[
        deleteCalls.calls.findIndex(([arg]) => arg.key === s.oldKey)
      ]!;
    const upsertAt = s.db.entityPages.upsert.mock.invocationCallOrder[0]!;
    expect(upsertAt).toBeLessThan(committedAt);
    expect(oldDeleteAt).toBeGreaterThan(committedAt);
    const cleanupCreditAt = s.db.resourceQuotas.incrementUsage.mock.invocationCallOrder[1]!;
    expect(cleanupCreditAt).toBeGreaterThan(committedAt);
  });

  it("still saves the new image when the cleanup throws, and credits nothing for it", async () => {
    const s = setup({ failDelete: [oldCopyKey] });

    const url = await c.run(s.deps, s.uploadKey);

    expect(url).toBe(`${CDN}/${s.newCopyKey}`);
    expect(s.db.page()?.[c.field]).toBe(url);
    expect(s.store.objects.has(oldCopyKey)).toBe(true);
    // Only the strip's savings: a failed delete reclaims nothing.
    expect(s.db.quotaDeltas).toHaveLength(1);
  });

  it("reports the cleanup failure with useCase/stage tags and logs at error", async () => {
    const s = setup({ failDelete: [oldCopyKey] });

    await c.run(s.deps, s.uploadKey);

    expect(s.reportError).toHaveBeenCalledTimes(1);
    expect(s.reportError).toHaveBeenCalledWith(expect.objectContaining({ code: "transient" }), {
      tags: { useCase: c.useCase, stage: "cleanup_replaced_image" },
      extra: { humanId: HUMAN_ID, oldKey: oldCopyKey },
    });
    expect(s.logger.error).toHaveBeenCalledWith(
      "profile_image_cleanup_failed",
      expect.objectContaining({ useCase: c.useCase, oldKey: oldCopyKey }),
    );
  });

  it("a THROWING reporter does not change the outcome", async () => {
    const s = setup({ failDelete: [oldCopyKey] });
    s.reportError.mockImplementation(() => {
      throw new Error("sentry_down");
    });

    const url = await c.run(s.deps, s.uploadKey);

    expect(url).toBe(`${CDN}/${s.newCopyKey}`);
    expect(s.reportError).toHaveBeenCalledTimes(1);
  });

  it("does not call reportError on the success path", async () => {
    const s = setup();
    await c.run(s.deps, s.uploadKey);
    expect(s.reportError).not.toHaveBeenCalled();
  });

  it("a repeat after the image was replaced again is not found (its copy may be gone)", async () => {
    const s = setup();
    await c.run(s.deps, s.uploadKey);
    const nextKey = `${c.prefix}${day}/${randomUUID()}.jpg`;
    s.store.put(nextKey, phoneJpeg({ orientation: 3 }).file, "image/jpeg");
    await c.run(s.deps, nextKey);

    await expect(c.run(s.deps, s.uploadKey)).rejects.toMatchObject({
      code: c.name === "avatar" ? "UPLOADED_AVATAR_NOT_FOUND" : "UPLOADED_BANNER_NOT_FOUND",
    });
    // The first copy was cleaned up by the second publish.
    expect(s.store.objects.has(s.newCopyKey)).toBe(false);
    expect(s.db.outbox.rows.has(uploadClaimId(s.uploadKey))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The replaced image's credit (security review F1, image strip step 2). The
// cleanup hands the old object's size back to the quota; it must never hand
// back bytes nobody was charged for, and never twice for one key.
// ───────────────────────────────────────────────────────────────────────────

describe("cleanupReplacedImage: the credit", () => {
  const prefix = `avatars/human/${HUMAN_ID}/`;
  const oldKey = `${prefix}2026-09-01/${"e".repeat(32)}.jpg`;

  function setup() {
    const store = makeObjectStore();
    const db = makeRepos({ page: { ownerId: HUMAN_ID } });
    const logger = makeLogger();
    const reportError = vi.fn() as ReturnType<typeof vi.fn> & ReporterPort;
    const run = () =>
      cleanupReplacedImage(
        { storage: store.storage, logger, reportError },
        db.repos,
        { oldKey, humanId: HUMAN_ID },
        { useCase: "test" },
      );
    return { store, db, run, reportError };
  }

  it("credits the old object once and leaves a once-marker in the outbox", async () => {
    const s = setup();
    s.store.put(oldKey, Buffer.alloc(30_000, 1), "image/jpeg");
    const before = Date.now();

    await s.run();

    expect(s.store.objects.has(oldKey)).toBe(false);
    expect(s.db.quotaDeltas.map((d) => d.delta)).toEqual([-30_000n]);
    const marker = s.db.outbox.rows.get(creditMarkerId(oldKey));
    expect(marker).toMatchObject({
      targetKey: oldKey,
      targetKind: "KEY",
      source: REPLACED_IMAGE_CREDIT_SOURCE,
    });
    // Due well after any cleanup still racing on this key.
    expect(marker!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + CREDIT_MARKER_TTL_MS,
    );
    expect(s.reportError).not.toHaveBeenCalled();
  });

  it("two cleanups of the same key at once credit it ONCE", async () => {
    const s = setup();
    s.store.put(oldKey, Buffer.alloc(30_000, 1), "image/jpeg");

    await Promise.all([s.run(), s.run()]);

    // Both saw the object before either deleted it: without the marker,
    // both would have credited its size.
    const heads = await Promise.all(
      s.store.storage.headObject.mock.results.map((r) => r.value),
    );
    expect(heads).toEqual([
      expect.objectContaining({ exists: true, size: 30_000 }),
      expect.objectContaining({ exists: true, size: 30_000 }),
    ]);
    expect(s.db.quotaDeltas.map((d) => d.delta)).toEqual([-30_000n]);
    expect(s.store.objects.has(oldKey)).toBe(false);
  });

  it("the same key reappearing later is not credited again", async () => {
    const s = setup();
    s.store.put(oldKey, Buffer.alloc(30_000, 1), "image/jpeg");
    await s.run();
    s.store.put(oldKey, Buffer.alloc(30_000, 1), "image/jpeg");

    await s.run();

    expect(s.store.objects.has(oldKey)).toBe(false);
    expect(s.db.quotaDeltas.map((d) => d.delta)).toEqual([-30_000n]);
  });

  it("an old key that is a CLAIMED upload is deleted but NOT credited", async () => {
    const s = setup();
    const uploadKey = `${prefix}2026-10-08/${randomUUID()}.jpg`;
    // A finalize settled this upload's charge (published as a copy).
    s.db.outbox.rows.set(uploadClaimId(uploadKey), {
      id: uploadClaimId(uploadKey),
      targetKey: uploadKey,
      targetKind: "KEY",
      status: "PENDING",
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(Date.now() + 3_600_000),
      source: "avatar_upload_original_after_presign",
      sourceId: `${prefix}2026-10-08/${"a".repeat(32)}.jpg`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // ...and bytes re-PUT through its presigned URL since.
    s.store.put(uploadKey, Buffer.alloc(5_000_000, 1), "image/jpeg");

    await cleanupReplacedImage(
      { storage: s.store.storage },
      s.db.repos,
      { oldKey: uploadKey, humanId: HUMAN_ID },
      { useCase: "test" },
    );

    expect(s.store.objects.has(uploadKey)).toBe(false);
    expect(s.db.quotaDeltas).toEqual([]);
  });
});

// N2 (round 2): a finalize on another instance that passed the strip's
// `stillNeeded` check before the winner's claim committed writes its OWN
// copy, then loses the claim. That copy was never charged; it is outboxed,
// but lives under the profile prefix until the drain runs. Whatever points a
// profile at it, its cleanup must not credit it.
describe("N2: a copy whose finalize lost the claim is never credited", () => {
  const prefix = `avatars/human/${HUMAN_ID}/`;
  const kind = {
    source: "avatar_upload",
    useCase: "setAvatarFromUpload",
    maxBytes: 5 * 1024 * 1024,
    presignTtlSeconds: 900,
  };
  const quotaSubject = {
    subjectType: "HUMAN" as const,
    subjectId: HUMAN_ID,
    kind: "STORAGE_BYTES_HUMAN" as const,
  };

  it("the losing claim leaves the never-credit marker; the copy's cleanup then credits nothing", async () => {
    const store = makeObjectStore();
    const db = makeRepos({ page: { ownerId: HUMAN_ID } });
    const uploadKey = `${prefix}2026-10-08/${randomUUID()}.jpg`;
    const winnerCopy = `${prefix}2026-10-08/${"a".repeat(32)}.jpg`;
    const loserCopy = `${prefix}2026-10-08/${"b".repeat(32)}.jpg`;

    const tx = (db.repos as unknown as { pendingObjectDeletions: unknown; resourceQuotas: unknown });
    const won = await claimStrippedUpload(tx as never, {
      kind,
      uploadKey,
      copy: { key: winnerCopy, sizeBytes: 1_000 },
      uploadSize: 2_000,
      quotaSubject,
    });
    const before = Date.now();
    const lost = await claimStrippedUpload(tx as never, {
      kind,
      uploadKey,
      copy: { key: loserCopy, sizeBytes: 900 },
      uploadSize: 2_000,
      quotaSubject,
    });

    expect(won.status).toBe("claimed");
    expect(lost.status).toBe("refused");
    const marker = db.outbox.rows.get(creditMarkerId(loserCopy));
    expect(marker).toMatchObject({
      targetKey: loserCopy,
      targetKind: "KEY",
      source: "avatar_upload_stripped_unclaimed_no_credit",
    });
    expect(marker!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + CREDIT_MARKER_TTL_MS);
    // The winner's copy has no marker: its later replacement IS credited.
    expect(db.outbox.rows.has(creditMarkerId(winnerCopy))).toBe(false);

    // The loser's copy is still there (the drain has not run) and the
    // profile names it: replacing it deletes it and credits nothing.
    store.put(loserCopy, Buffer.alloc(900, 1), "image/jpeg");
    const creditsBefore = db.quotaDeltas.length;
    await cleanupReplacedImage(
      { storage: store.storage },
      db.repos,
      { oldKey: loserCopy, humanId: HUMAN_ID },
      { useCase: "test" },
    );
    expect(store.objects.has(loserCopy)).toBe(false);
    expect(db.quotaDeltas.length).toBe(creditsBefore);
  });
});

describe("F1: re-PUT an avatar upload, point the profile at it, replace it", () => {
  const prefix = `avatars/human/${HUMAN_ID}/`;

  it("updatePage refuses the upload's URL; a page pointing at it anyway is never credited", async () => {
    const store = makeObjectStore();
    const db = makeRepos({ page: { ownerId: HUMAN_ID } });
    const deps = { repos: db.repos, storage: store.storage, logger: makeLogger() };

    // Publish avatar from upload U (charged U's signed size at request).
    const uploadKey = `${prefix}2026-10-08/${randomUUID()}.jpg`;
    store.put(uploadKey, phoneJpeg().file, "image/jpeg");
    await setAvatarFromUpload(deps, { actorHumanId: HUMAN_ID, key: uploadKey });
    expect(store.objects.has(uploadKey)).toBe(false);
    const creditsAfterPublish = db.quotaDeltas.length;

    // Re-PUT U through its still-valid presigned URL (no new charge).
    store.put(uploadKey, Buffer.alloc(5_000_000, 1), "image/jpeg");

    // The entry point is closed: updatePage refuses an upload key's URL.
    await expect(
      updatePage(
        {
          repos: db.repos,
          storage: store.storage,
          clock: { now: () => new Date() },
          authz: {} as never,
        },
        {
          actorHumanId: HUMAN_ID,
          ownerType: "HUMAN",
          ownerId: HUMAN_ID,
          avatarUrl: `${CDN}/${uploadKey}`,
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", meta: { field: "avatarUrl" } });

    // Defence in depth: a page that names U anyway (any other writer) and is
    // then replaced deletes U and credits nothing for it.
    await db.repos.entityPages.upsert({
      ownerType: "HUMAN",
      ownerId: HUMAN_ID,
      slug: "me",
      displayName: "Me",
      avatarUrl: `${CDN}/${uploadKey}`,
    });
    const nextKey = `${prefix}2026-10-08/${randomUUID()}.jpg`;
    store.put(nextKey, phoneJpeg({ orientation: 3 }).file, "image/jpeg");
    await setAvatarFromUpload(deps, { actorHumanId: HUMAN_ID, key: nextKey });

    expect(store.objects.has(uploadKey)).toBe(false);
    // Only the second publish's strip savings; nothing for U's 5 MB.
    const later = db.quotaDeltas.slice(creditsAfterPublish).map((d) => d.delta);
    expect(later).toHaveLength(1);
    expect(later[0]! > -5_000_000n).toBe(true);
  });
});
