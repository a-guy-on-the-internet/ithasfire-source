import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { stripImageMetadata } from "../../../lib/images/strip-image-metadata";
import { phoneJpeg } from "../../../lib/images/__tests__/image-fixtures";
import { strippedImageKey } from "../../storage/strip-uploaded-image";
import {
  CDN,
  makeObjectStore,
  makeRepos,
} from "../../storage/__tests__/unrowed-upload-fakes";
import { setAvatarFromUpload, setBannerFromUpload } from "../index";

// F11 (2026-09-29): the quota is charged from the DECLARED size at presign
// time, so the finalize step must refuse (and delete) an object that is
// bigger than declared or bigger than the kind's cap, before reading it.

const HUMAN_ID = "00000000-0000-4000-8000-000000000000";

/** A store whose HEAD reports `head` for the upload instead of its real size. */
function makeStore(key: string, file: Buffer, head: { size?: number; declared?: string }) {
  const store = makeObjectStore();
  store.put(key, file, "image/jpeg");
  const realHead = store.storage.headObject.getMockImplementation()!;
  store.storage.headObject.mockImplementation(async (input: { key: string }) => {
    if (input.key !== key || !store.objects.has(key)) return realHead(input);
    return {
      exists: true,
      ...(head.size !== undefined ? { size: head.size } : {}),
      ...(head.declared ? { metadata: { "th-declared-bytes": head.declared } } : {}),
    };
  });
  return store;
}

const cases = [
  {
    name: "avatar",
    run: setAvatarFromUpload,
    prefix: `avatars/human/${HUMAN_ID}/2026-09-29/`,
    max: 5 * 1024 * 1024,
    field: "avatarUrl",
  },
  {
    name: "banner",
    run: setBannerFromUpload,
    prefix: `banners/human/${HUMAN_ID}/2026-09-29/`,
    max: 10 * 1024 * 1024,
    field: "bannerUrl",
  },
] as const;

describe.each(cases)("$name finalize size gate", (c) => {
  const file = phoneJpeg().file;

  it("deletes and rejects an object bigger than its declared size, without reading it", async () => {
    const key = `${c.prefix}${randomUUID()}.jpg`;
    const db = makeRepos({ page: { ownerId: HUMAN_ID } });
    const store = makeStore(key, file, { size: 2048, declared: "1" });

    await expect(
      c.run({ repos: db.repos, storage: store.storage }, { actorHumanId: HUMAN_ID, key }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "upload_size_exceeded",
    });
    expect(store.storage.deleteObject).toHaveBeenCalledWith({ key });
    expect(store.storage.getObject).not.toHaveBeenCalled();
    expect(db.entityPages.upsert).not.toHaveBeenCalled();
  });

  it("deletes and rejects an object bigger than the kind's cap", async () => {
    const key = `${c.prefix}${randomUUID()}.jpg`;
    const db = makeRepos({ page: { ownerId: HUMAN_ID } });
    const store = makeStore(key, file, { size: c.max + 1 });

    await expect(
      c.run({ repos: db.repos, storage: store.storage }, { actorHumanId: HUMAN_ID, key }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(store.storage.deleteObject).toHaveBeenCalledWith({ key });
    expect(db.entityPages.upsert).not.toHaveBeenCalled();
  });

  it("accepts an object that matches its declared size and publishes its stripped copy", async () => {
    const key = `${c.prefix}${randomUUID()}.jpg`;
    const db = makeRepos({ page: { ownerId: HUMAN_ID } });
    const store = makeStore(key, file, {
      size: file.length,
      declared: String(file.length),
    });
    const copyKey = strippedImageKey(key, stripImageMetadata(file, "image/jpeg").bytes);

    const out = await c.run(
      { repos: db.repos, storage: store.storage, reportError: vi.fn() },
      { actorHumanId: HUMAN_ID, key },
    );
    expect(out).toEqual({ [c.field]: `${CDN}/${copyKey}` });
    expect(db.entityPages.upsert).toHaveBeenCalledTimes(1);
  });
});
