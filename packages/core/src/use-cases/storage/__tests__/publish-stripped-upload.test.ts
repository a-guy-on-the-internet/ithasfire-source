import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ReporterPort } from "@th/ports/reporter";

import { stripImageMetadata } from "../../../lib/images/strip-image-metadata";
import {
  SECRET,
  cleanJpeg,
  phoneJpeg,
} from "../../../lib/images/__tests__/image-fixtures";
import { finalizePageImageUpload } from "../../entity-pages/finalize-page-image-upload";
import { PAGE_IMAGE_PRESIGN_TTL_SECONDS } from "../../entity-pages/request-page-image-upload";
import { AVATAR_PRESIGN_TTL_SECONDS } from "../../profiles/request-avatar-upload";
import { BANNER_PRESIGN_TTL_SECONDS } from "../../profiles/request-banner-upload";
import { setAvatarFromUpload } from "../../profiles/set-avatar-from-upload";
import { setBannerFromUpload } from "../../profiles/set-banner-from-upload";
import {
  PRESIGN_EXPIRY_MARGIN_MS,
  claimStrippedUpload,
  unrowedUploadSources,
  uploadClaimId,
  uploadKeyContentType,
} from "../publish-stripped-upload";
import {
  IMAGE_STRIP_BUSY,
  IMAGE_STRIP_CONCURRENCY,
  IMAGE_STRIP_MAX_WAITING,
  strippedImageKey,
  withImageStripSlot,
} from "../strip-uploaded-image";
import {
  CDN,
  makeLogger,
  makeObjectStore,
  makeRepos,
} from "./unrowed-upload-fakes";

const HUMAN_ID = "00000000-0000-4000-8000-000000000000";
const ORG_ID = "org-1";

type Harness = {
  store: ReturnType<typeof makeObjectStore>;
  db: ReturnType<typeof makeRepos>;
  logger: ReturnType<typeof makeLogger>;
  reportError: ReturnType<typeof vi.fn> & ReporterPort;
};

type PathCase = {
  name: string;
  source: string;
  ttlSeconds: number;
  quota: { subjectType: string; subjectId: string; kind: string };
  /** A fresh key in the shape the request use case mints. */
  mintKey: (ext?: string) => string;
  /** A key under someone else's prefix. */
  foreignKey: string;
  notFoundCode: string;
  notOwnedCode: string;
  /** Runs the finalize; resolves to the URL it returned. */
  run: (h: Harness, key: string) => Promise<string>;
  /** The URL the owner's page now shows for this kind (null: no page field). */
  pageUrl: (h: Harness) => string | null | undefined;
};

const day = "2026-10-08";

const cases: PathCase[] = [
  {
    name: "avatar",
    source: "avatar_upload",
    ttlSeconds: AVATAR_PRESIGN_TTL_SECONDS,
    quota: { subjectType: "HUMAN", subjectId: HUMAN_ID, kind: "STORAGE_BYTES_HUMAN" },
    mintKey: (ext = "jpg") => `avatars/human/${HUMAN_ID}/${day}/${randomUUID()}.${ext}`,
    foreignKey: `avatars/human/11111111-1111-4111-8111-111111111111/${day}/${randomUUID()}.jpg`,
    notFoundCode: "UPLOADED_AVATAR_NOT_FOUND",
    notOwnedCode: "AVATAR_KEY_NOT_OWNED",
    run: async (h, key) =>
      (
        await setAvatarFromUpload(
          { repos: h.db.repos, storage: h.store.storage, logger: h.logger, reportError: h.reportError },
          { actorHumanId: HUMAN_ID, key },
        )
      ).avatarUrl,
    pageUrl: (h) => h.db.page()?.avatarUrl,
  },
  {
    name: "banner",
    source: "banner_upload",
    ttlSeconds: BANNER_PRESIGN_TTL_SECONDS,
    quota: { subjectType: "HUMAN", subjectId: HUMAN_ID, kind: "STORAGE_BYTES_HUMAN" },
    mintKey: (ext = "jpg") => `banners/human/${HUMAN_ID}/${day}/${randomUUID()}.${ext}`,
    foreignKey: `banners/human/11111111-1111-4111-8111-111111111111/${day}/${randomUUID()}.jpg`,
    notFoundCode: "UPLOADED_BANNER_NOT_FOUND",
    notOwnedCode: "BANNER_KEY_NOT_OWNED",
    run: async (h, key) =>
      (
        await setBannerFromUpload(
          { repos: h.db.repos, storage: h.store.storage, logger: h.logger, reportError: h.reportError },
          { actorHumanId: HUMAN_ID, key },
        )
      ).bannerUrl,
    pageUrl: (h) => h.db.page()?.bannerUrl,
  },
  {
    name: "entity-page image",
    source: "entity_page_image_upload",
    ttlSeconds: PAGE_IMAGE_PRESIGN_TTL_SECONDS,
    // Org pages are charged to the org (request-page-image-upload).
    quota: { subjectType: "ORG", subjectId: ORG_ID, kind: "STORAGE_BYTES_ORG" },
    mintKey: (ext = "jpg") => `entity-pages/organization/${ORG_ID}/${day}/${randomUUID()}.${ext}`,
    foreignKey: `entity-pages/organization/org-2/${day}/${randomUUID()}.jpg`,
    notFoundCode: "UPLOADED_PAGE_IMAGE_NOT_FOUND",
    notOwnedCode: "PAGE_IMAGE_KEY_NOT_OWNED",
    run: async (h, key) =>
      (
        await finalizePageImageUpload(
          {
            repos: h.db.repos,
            authz: { requireOrgRole: vi.fn(async () => {}), canManagePlace: vi.fn() } as never,
            clock: { now: () => new Date() },
            storage: h.store.storage,
            logger: h.logger,
            reportError: h.reportError,
          },
          { actorHumanId: HUMAN_ID, ownerType: "ORGANIZATION", ownerId: ORG_ID, key },
        )
      ).publicUrl,
    pageUrl: () => undefined,
  },
];

function harness(): Harness {
  return {
    store: makeObjectStore(),
    db: makeRepos({ page: { ownerId: HUMAN_ID } }),
    logger: makeLogger(),
    reportError: vi.fn() as ReturnType<typeof vi.fn> & ReporterPort,
  };
}

/** A phone photo: EXIF with GPS, XMP, IPTC, a comment, an MPF thumbnail. */
const photo = () => phoneJpeg().file;
const strippedOf = (file: Buffer) => stripImageMetadata(file, "image/jpeg").bytes;

describe.each(cases)("$name finalize publishes a stripped copy", (c) => {
  it("writes the stripped copy to a new key and returns ITS url; the upload is deleted and outboxed", async () => {
    const h = harness();
    const key = c.mintKey();
    const file = photo();
    h.store.put(key, file, "image/jpeg");
    const copyBytes = strippedOf(file);
    const copyKey = strippedImageKey(key, copyBytes);
    const before = Date.now();

    const url = await c.run(h, key);

    expect(url).toBe(`${CDN}/${copyKey}`);
    expect(copyKey).not.toBe(key);
    expect(copyKey.slice(0, copyKey.lastIndexOf("/"))).toBe(key.slice(0, key.lastIndexOf("/")));
    const served = h.store.objects.get(copyKey)?.content;
    expect(served?.equals(Buffer.from(copyBytes))).toBe(true);
    for (const secret of [SECRET.make, SECRET.xmp, SECRET.iptc, SECRET.comment, SECRET.mpf]) {
      expect(served?.includes(secret)).toBe(false);
    }
    expect(h.store.objects.get(copyKey)?.contentType).toBe("image/jpeg");
    // The upload (with its GPS) is gone.
    expect(h.store.objects.has(key)).toBe(false);
    if (c.pageUrl(h) !== undefined) expect(c.pageUrl(h)).toBe(url);

    // Left in the outbox: only the claim, due after the presign expires; the
    // due-now row went with the fast-path delete.
    const rows = h.db.outbox.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: uploadClaimId(key),
      targetKey: key,
      targetKind: "KEY",
      source: `${c.source}_original_after_presign`,
      sourceId: copyKey,
    });
    const due = rows[0]!.nextAttemptAt.getTime();
    const expected = c.ttlSeconds * 1000 + PRESIGN_EXPIRY_MARGIN_MS;
    expect(due).toBeGreaterThanOrEqual(before + expected);
    expect(due).toBeLessThanOrEqual(Date.now() + expected);

    // The quota keeps the copy's size: the strip's savings are credited.
    expect(h.db.quotaDeltas).toEqual([
      { ...c.quota, delta: -BigInt(file.length - copyBytes.length) },
    ]);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("the outbox rows commit in the same transaction as the publish, before the upload is deleted", async () => {
    const h = harness();
    const key = c.mintKey();
    h.store.put(key, photo(), "image/jpeg");

    await c.run(h, key);

    const committed = h.db.txCommitted.mock.invocationCallOrder[0]!;
    const claimed = h.db.outbox.repo.enqueueOnce.mock.invocationCallOrder[0]!;
    const deleted = h.store.storage.deleteObject.mock.invocationCallOrder[0]!;
    expect(claimed).toBeLessThan(committed);
    expect(deleted).toBeGreaterThan(committed);
    expect(h.store.storage.deleteObject).toHaveBeenCalledWith({ key });
  });

  it("a failed delete of the upload keeps its due-now row, logs at error and reports", async () => {
    const h = harness();
    const key = c.mintKey();
    h.store.put(key, photo(), "image/jpeg");
    h.store.failDeletesOf.add(key);

    const url = await c.run(h, key);

    expect(url).toMatch(new RegExp(`^${CDN}/`));
    expect(h.db.outbox.list().map((r) => r.source).sort()).toEqual([
      `${c.source}_original`,
      `${c.source}_original_after_presign`,
    ]);
    expect(h.logger.error).toHaveBeenCalledWith(
      "Could not delete an original image upload",
      expect.objectContaining({ key }),
    );
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { area: "image_metadata_strip", useCase: expect.any(String), step: "delete_original" },
      extra: { key },
    });
  });

  it("a THROWING reporter does not change the outcome", async () => {
    const h = harness();
    h.reportError.mockImplementation(() => {
      throw new Error("sentry_down");
    });
    const key = c.mintKey();
    const file = photo();
    h.store.put(key, file, "image/jpeg");
    h.store.failDeletesOf.add(key);

    const url = await c.run(h, key);

    expect(url).toBe(`${CDN}/${strippedImageKey(key, strippedOf(file))}`);
    expect(h.reportError).toHaveBeenCalled();
  });

  it("unreadable bytes: refused, deleted, credited and reported ONCE, however often they are re-PUT", async () => {
    const h = harness();
    const key = c.mintKey();
    const junk = Buffer.from("this is not a jpeg at all, but it was declared as one");
    h.store.put(key, junk, "image/jpeg");

    await expect(c.run(h, key)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "image_unreadable",
    });
    expect(h.store.objects.has(key)).toBe(false);
    expect(h.store.storage.putObject).not.toHaveBeenCalled();
    expect(h.db.quotaDeltas).toEqual([{ ...c.quota, delta: -BigInt(junk.length) }]);
    expect(h.db.outbox.list()).toEqual([
      expect.objectContaining({
        id: uploadClaimId(key),
        targetKey: key,
        source: `${c.source}_refused`,
      }),
    ]);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.any(String) }),
      expect.objectContaining({
        tags: expect.objectContaining({ area: "image_metadata_strip", step: "parse" }),
      }),
    );

    // The presigned URL is still valid: the same bytes PUT again, finalized
    // again. Refused, deleted, but no second credit and no second report.
    h.store.put(key, junk, "image/jpeg");
    await expect(c.run(h, key)).rejects.toMatchObject({ code: c.notFoundCode });
    expect(h.store.objects.has(key)).toBe(false);
    expect(h.db.quotaDeltas).toHaveLength(1);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    // ...and nothing was published.
    expect(h.store.objects.size).toBe(0);
    expect(h.db.entityPages.upsert).not.toHaveBeenCalled();
  });

  it("a repeat after success returns the same URL without reading the object again", async () => {
    const h = harness();
    const key = c.mintKey();
    const file = photo();
    h.store.put(key, file, "image/jpeg");

    const first = await c.run(h, key);
    // The upload is gone: the claim answers.
    const second = await c.run(h, key);
    // The same bytes PUT again through the still-valid URL: still no read.
    h.store.put(key, file, "image/jpeg");
    const third = await c.run(h, key);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(h.store.storage.getObject).toHaveBeenCalledTimes(1);
    expect(h.store.storage.putObject).toHaveBeenCalledTimes(1);
    expect(h.store.objects.has(key)).toBe(false);
    expect(h.db.quotaDeltas).toHaveLength(1);
  });

  it("a different image re-PUT after success is never published", async () => {
    const h = harness();
    const key = c.mintKey();
    h.store.put(key, photo(), "image/jpeg");
    const first = await c.run(h, key);

    h.store.put(key, phoneJpeg({ orientation: 6 }).file, "image/jpeg");
    const second = await c.run(h, key);

    expect(second).toBe(first);
    expect(h.store.objects.has(key)).toBe(false);
    expect([...h.store.objects.keys()]).toEqual([first.slice(CDN.length + 1)]);
    expect(h.db.quotaDeltas).toHaveLength(1);
  });

  it("concurrent finalizes of one upload read it once and publish once", async () => {
    const h = harness();
    const key = c.mintKey();
    const file = photo();
    h.store.put(key, file, "image/jpeg");

    const urls = await Promise.all([c.run(h, key), c.run(h, key), c.run(h, key)]);

    expect(new Set(urls).size).toBe(1);
    expect(h.store.storage.getObject).toHaveBeenCalledTimes(1);
    expect(h.db.quotaDeltas).toHaveLength(1);
    expect(h.store.objects.has(key)).toBe(false);
    if (c.pageUrl(h) !== undefined) expect(h.db.entityPages.upsert).toHaveBeenCalledTimes(1);
    // Only the claim is left; every due-now row was fulfilled.
    expect(h.db.outbox.list().map((r) => r.id)).toEqual([uploadClaimId(key)]);
  });

  it("refuses a key the request did not mint, before any storage call", async () => {
    const h = harness();
    const own = c.mintKey();
    const copyShaped = `${own.slice(0, own.lastIndexOf("/") + 1)}${"a".repeat(32)}.jpg`;

    for (const key of [c.foreignKey, copyShaped, own.replace(/\.jpg$/, ".svg")]) {
      await expect(c.run(h, key)).rejects.toMatchObject({ code: c.notOwnedCode });
    }
    expect(h.store.storage.headObject).not.toHaveBeenCalled();
  });

  it("an upload that was never PUT is not found", async () => {
    const h = harness();
    await expect(c.run(h, c.mintKey())).rejects.toMatchObject({ code: c.notFoundCode });
    expect(h.db.outbox.list()).toEqual([]);
  });

  it("a full strip queue: logged at error, reported as strip_busy, rethrown as RATE_LIMITED", async () => {
    const gates: Array<() => void> = [];
    const held = Array.from({ length: IMAGE_STRIP_CONCURRENCY + IMAGE_STRIP_MAX_WAITING }, () =>
      withImageStripSlot(() => new Promise<void>((resolve) => gates.push(resolve))),
    );
    await new Promise((r) => setTimeout(r, 0));
    try {
      const h = harness();
      const key = c.mintKey();
      h.store.put(key, photo(), "image/jpeg");

      await expect(c.run(h, key)).rejects.toMatchObject({
        code: "RATE_LIMITED",
        message: IMAGE_STRIP_BUSY,
      });
      expect(h.store.storage.getObject).not.toHaveBeenCalled();
      expect(h.db.repos.tx).not.toHaveBeenCalled();
      expect(h.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("strip queue is full"),
        expect.any(Object),
      );
      expect(h.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "RATE_LIMITED" }),
        {
          tags: {
            area: "image_metadata_strip",
            useCase: expect.any(String),
            step: "strip_busy",
          },
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
});

describe("claimStrippedUpload", () => {
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
  const uploadKey = `avatars/human/${HUMAN_ID}/${day}/${randomUUID()}.jpg`;
  const tx = (db: ReturnType<typeof makeRepos>) =>
    ({
      pendingObjectDeletions: db.outbox.repo,
      resourceQuotas: db.resourceQuotas,
    }) as never;

  it("a racer that wrote a DIFFERENT copy loses: its copy is outboxed, nothing credited", async () => {
    const db = makeRepos();
    const first = await claimStrippedUpload(tx(db), {
      kind,
      uploadKey,
      copy: { key: "avatars/x/aaa.jpg", sizeBytes: 900 },
      uploadSize: 1000,
      quotaSubject,
    });
    const second = await claimStrippedUpload(tx(db), {
      kind,
      uploadKey,
      copy: { key: "avatars/x/bbb.jpg", sizeBytes: 800 },
      uploadSize: 1000,
      quotaSubject,
    });

    expect(first.status).toBe("claimed");
    expect(second.status).toBe("refused");
    expect(db.quotaDeltas).toEqual([{ ...quotaSubject, delta: -100n }]);
    expect(db.outbox.list()).toContainEqual(
      expect.objectContaining({
        targetKey: "avatars/x/bbb.jpg",
        source: unrowedUploadSources(kind).unclaimedCopy,
      }),
    );
  });

  it("a racer that wrote the SAME copy is a repeat; one after a refusal is refused", async () => {
    const db = makeRepos();
    const args = {
      kind,
      uploadKey,
      copy: { key: "avatars/x/aaa.jpg", sizeBytes: 1000 },
      uploadSize: 1000,
      quotaSubject,
    };
    expect((await claimStrippedUpload(tx(db), args)).status).toBe("claimed");
    expect((await claimStrippedUpload(tx(db), args)).status).toBe("repeat");
    // No savings, no credit.
    expect(db.quotaDeltas).toEqual([]);

    const refusedDb = makeRepos();
    await refusedDb.outbox.repo.enqueueOnce({
      id: uploadClaimId(uploadKey),
      targetKey: uploadKey,
      targetKind: "KEY",
      source: unrowedUploadSources(kind).refused,
    });
    expect((await claimStrippedUpload(tx(refusedDb), args)).status).toBe("refused");
  });
});

describe("uploadKeyContentType", () => {
  const map = { jpg: "image/jpeg", png: "image/png" };
  const prefix = "avatars/human/h1/";
  const uuid = "0b9f6a1e-1234-4abc-8def-0123456789ab";

  it("reads the type of a minted key and nothing else", () => {
    expect(uploadKeyContentType(`${prefix}${day}/${uuid}.jpg`, prefix, map)).toBe("image/jpeg");
    expect(uploadKeyContentType(`${prefix}${day}/${uuid}.png`, prefix, map)).toBe("image/png");
    for (const key of [
      `avatars/human/h2/${day}/${uuid}.jpg`,
      `${prefix}${day}/${"c".repeat(32)}.jpg`,
      `${prefix}${day}/${uuid}.gif`,
      `${prefix}${day}/${uuid}.constructor`,
      `${prefix}${day}/../${uuid}.jpg`,
      `${prefix}${uuid}.jpg`,
      `${prefix}${day}/${uuid}.jpg/x`,
    ]) {
      expect(uploadKeyContentType(key, prefix, map)).toBeNull();
    }
  });

  it("a plain JPEG with nothing to strip is still copied (never served at the upload key)", async () => {
    const h = harness();
    const key = cases[0]!.mintKey();
    h.store.put(key, cleanJpeg(), "image/jpeg");
    const url = await cases[0]!.run(h, key);
    expect(url).not.toContain(key);
    expect(h.store.objects.has(key)).toBe(false);
  });
});
