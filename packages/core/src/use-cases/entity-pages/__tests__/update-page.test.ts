import { describe, expect, it, vi } from "vitest";

import { createFileStorageError } from "@th/ports/file-storage";

import { updatePage } from "../update-page";
import type { UpdatePageDeps } from "../update-page";

// ── Helpers ────────────────────────────────────────────────────────────────

const ACTOR_ID = "human-1";
const CDN = "https://cdn.example";

const EXISTING_PAGE = {
  id: "page-1",
  ownerType: "HUMAN" as const,
  ownerId: ACTOR_ID,
  slug: "alice",
  displayName: "Alice",
  bio: "Hello world",
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC" as const,
  createdAt: new Date("2025-06-01"),
  updatedAt: new Date("2025-06-01"),
};

function makeDeps(
  overrides?: Partial<{
    entityPages: Record<string, any>;
    authzError: Error | null;
    canManagePlaceResult: { allowed: boolean };
    publicBaseUrl: string;
    /** Keys that exist; any other key's `getObjectUrl` is `not_found`. */
    existingKeys: readonly string[];
  }>,
): UpdatePageDeps {
  const upsertFn = vi.fn(async (data: any) => ({
    ...EXISTING_PAGE,
    ...data,
    updatedAt: new Date(),
  }));

  return {
    clock: { now: () => new Date("2026-06-01T12:00:00.000Z") },
    storage: {
      // Like the adapters: HEADs the key, so a missing object is not_found.
      getObjectUrl: vi.fn(async ({ key }: { key: string }) => {
        if (!overrides?.existingKeys?.includes(key)) {
          throw createFileStorageError("not_found", "object_not_found");
        }
        return { url: `${overrides?.publicBaseUrl ?? CDN}/${key}` };
      }),
    },
    repos: withTx({
      entityPages: {
        getByOwner: vi.fn(async () => EXISTING_PAGE),
        isSlugAvailable: vi.fn(async () => true),
        recordSlugHistory: vi.fn(async () => {}),
        upsert: upsertFn,
        ...overrides?.entityPages,
      },
      authz: {},
    }) as any,
    authz: {
      hasOrgRole: vi.fn(),
      requireOrgRole: overrides?.authzError
        ? vi.fn(async () => {
            throw overrides.authzError;
          })
        : vi.fn(async () => {}),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(
        async () => overrides?.canManagePlaceResult ?? { allowed: true },
      ),
      canFinanceOrg: vi.fn(),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

/**
 * The write, its audit row and its search reindex mark share one
 * `repos.tx`; this fake runs the callback against the same repos.
 */
function withTx<T extends object>(repos: T): T {
  return Object.assign(repos, {
    tx: vi.fn(async (fn: (tx: T) => Promise<unknown>) => fn(repos)),
  });
}

describe("updatePage", () => {
  it("updates displayName and bio while preserving other fields", async () => {
    const deps = makeDeps();

    const result = await updatePage(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      displayName: "Alice Wonderland",
      bio: "Updated bio",
    });

    expect(result.page.displayName).toBe("Alice Wonderland");
    expect(result.page.bio).toBe("Updated bio");
    expect(result.page.slug).toBe("alice"); // unchanged
  });

  it("records old slug in history when slug changes", async () => {
    const recordSlugHistory = vi.fn(async () => {});
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => EXISTING_PAGE),
        isSlugAvailable: vi.fn(async () => true),
        recordSlugHistory,
        upsert: vi.fn(async (data: any) => ({
          ...EXISTING_PAGE,
          ...data,
          updatedAt: new Date(),
        })),
      },
    });

    const result = await updatePage(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      slug: "alice-new",
    });

    expect(recordSlugHistory).toHaveBeenCalledWith("page-1", "alice");
    expect(result.page.slug).toBe("alice-new");
  });

  it("does not record slug history when slug is unchanged", async () => {
    const recordSlugHistory = vi.fn(async () => {});
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => EXISTING_PAGE),
        isSlugAvailable: vi.fn(async () => true),
        recordSlugHistory,
        upsert: vi.fn(async (data: any) => ({
          ...EXISTING_PAGE,
          ...data,
          updatedAt: new Date(),
        })),
      },
    });

    await updatePage(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      slug: "alice", // same slug
    });

    expect(recordSlugHistory).not.toHaveBeenCalled();
  });

  it("throws conflict when new slug is taken", async () => {
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => EXISTING_PAGE),
        isSlugAvailable: vi.fn(async () => false),
        recordSlugHistory: vi.fn(),
        upsert: vi.fn(),
      },
    });

    await expect(
      updatePage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        slug: "taken-slug",
      }),
    ).rejects.toMatchObject({ code: "SLUG_TAKEN" });
  });

  it("throws not_found when page does not exist", async () => {
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => null),
        isSlugAvailable: vi.fn(),
        recordSlugHistory: vi.fn(),
        upsert: vi.fn(),
      },
    });

    await expect(
      updatePage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        displayName: "New Name",
      }),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });

  it("throws forbidden when human tries to edit another human's page", async () => {
    const deps = makeDeps();

    await expect(
      updatePage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: "someone-else",
        displayName: "Hacked",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("allows ORG editors to update an ORGANIZATION page using the resolved domain actor human id", async () => {
    const orgPage = {
      ...EXISTING_PAGE,
      ownerType: "ORGANIZATION" as const,
      ownerId: "org-1",
    };
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => orgPage),
        isSlugAvailable: vi.fn(async () => true),
        recordSlugHistory: vi.fn(),
        upsert: vi.fn(async (data: any) => ({
          ...orgPage,
          ...data,
          updatedAt: new Date(),
        })),
      },
    });

    const result = await updatePage(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "ORGANIZATION",
      ownerId: "org-1",
      bio: "Org bio",
    });

    expect(result.page.bio).toBe("Org bio");
    expect(deps.authz.requireOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        orgId: "org-1",
      }),
    );
  });

  it("sets field to null when explicitly passed null", async () => {
    const deps = makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => ({
          ...EXISTING_PAGE,
          bio: "Old bio",
        })),
        isSlugAvailable: vi.fn(async () => true),
        recordSlugHistory: vi.fn(),
        upsert: vi.fn(async (data: any) => ({
          ...EXISTING_PAGE,
          ...data,
          updatedAt: new Date(),
        })),
      },
    });

    const result = await updatePage(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      bio: null,
    });

    expect(result.page.bio).toBeNull();
  });

  it("throws forbidden when PLACE access is denied", async () => {
    const deps = makeDeps({ canManagePlaceResult: { allowed: false } });

    await expect(
      updatePage(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "PLACE",
        ownerId: "place-1",
        bio: "Nope",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(deps.repos.entityPages.upsert).not.toHaveBeenCalled();
  });
});

// ── Avatar / banner URL guard ──────────────────────────────────────────────
//
// A new avatar/banner URL must be an existing METADATA-STRIPPED COPY of the
// page's own image uploads, at the storage's public origin. Before this
// guard the URL was free-form, which allowed (security review, image strip
// step 2):
//   F3: store the raw UPLOAD key's URL, skipping the finalize; the original
//       (GPS and all) stayed public on the profile, and nothing deleted it.
//   F1: point the avatar at an upload re-PUT through its still-valid
//       presigned URL, then replace the avatar; the replaced-image cleanup
//       credited the re-PUT's bytes back to the quota, never charged.
//   N2: point it at a copy under the PROFILE prefix that a losing finalize
//       wrote (never charged, not yet drained), then replace it: credited.

describe("updatePage: avatar/banner URLs", () => {
  const day = "2026-10-08";
  const hex = "0123456789abcdef0123456789abcdef";
  const uuid = "0b9f6a1e-1234-4abc-8def-0123456789ab";
  const pageKey = (owner: string) => `entity-pages/${owner}/${day}/${hex}.webp`;
  const ownPageKey = pageKey(`human/${ACTOR_ID}`);
  const ownPageCopy = `${CDN}/${ownPageKey}`;
  const ownAvatarKey = `avatars/human/${ACTOR_ID}/${day}/${hex}.jpg`;

  async function attempt(
    patch: Record<string, unknown>,
    opts: {
      ownerType?: "HUMAN" | "ORGANIZATION" | "PLACE";
      ownerId?: string;
      existing?: Partial<typeof EXISTING_PAGE>;
      publicBaseUrl?: string;
      existingKeys?: readonly string[];
    } = {},
  ) {
    const ownerType = opts.ownerType ?? "HUMAN";
    const ownerId = opts.ownerId ?? ACTOR_ID;
    const page = { ...EXISTING_PAGE, ownerType, ownerId, ...opts.existing };
    const deps = makeDeps({
      publicBaseUrl: opts.publicBaseUrl,
      existingKeys: opts.existingKeys,
      entityPages: {
        getByOwner: vi.fn(async () => page),
        isSlugAvailable: vi.fn(async () => true),
        recordSlugHistory: vi.fn(),
        upsert: vi.fn(async (data: any) => ({ ...page, ...data, updatedAt: new Date() })),
      },
    });
    const run = () =>
      updatePage(deps, { actorHumanId: ACTOR_ID, ownerType, ownerId, ...patch });
    return { deps, run };
  }

  const refused = (field: "avatarUrl" | "bannerUrl") => ({
    code: "INVALID_INPUT",
    meta: { field },
  });

  it("F3: refuses the raw UPLOAD key's URL (the unstripped original)", async () => {
    const key = `entity-pages/human/${ACTOR_ID}/${day}/${uuid}.png`;
    const { deps, run } = await attempt({ bannerUrl: `${CDN}/${key}` }, { existingKeys: [key] });
    await expect(run()).rejects.toMatchObject(refused("bannerUrl"));
    expect(deps.repos.entityPages.upsert).not.toHaveBeenCalled();
  });

  it("F3: refuses a profile upload key too", async () => {
    const key = `avatars/human/${ACTOR_ID}/${day}/${uuid}.jpg`;
    const { run } = await attempt({ avatarUrl: `${CDN}/${key}` }, { existingKeys: [key] });
    await expect(run()).rejects.toMatchObject(refused("avatarUrl"));
  });

  it("N2: refuses a NEW stripped copy under the profile prefixes, even its own", async () => {
    const avatar = await attempt(
      { avatarUrl: `${CDN}/${ownAvatarKey}` },
      { existingKeys: [ownAvatarKey] },
    );
    await expect(avatar.run()).rejects.toMatchObject(refused("avatarUrl"));
    expect(avatar.deps.repos.entityPages.upsert).not.toHaveBeenCalled();

    const bannerKey = `banners/human/${ACTOR_ID}/${day}/${hex}.jpg`;
    const banner = await attempt(
      { bannerUrl: `${CDN}/${bannerKey}` },
      { existingKeys: [bannerKey] },
    );
    await expect(banner.run()).rejects.toMatchObject(refused("bannerUrl"));
  });

  it("N5: refuses an own page copy that no longer exists, as INVALID_INPUT (not a storage error)", async () => {
    const { deps, run } = await attempt({ avatarUrl: ownPageCopy }, { existingKeys: [] });
    await expect(run()).rejects.toMatchObject(refused("avatarUrl"));
    expect(deps.storage.getObjectUrl).toHaveBeenCalledWith({
      key: ownPageKey,
      options: { public: true },
    });
    expect(deps.repos.entityPages.upsert).not.toHaveBeenCalled();
  });

  it("a storage failure other than not_found is not dressed up as bad input", async () => {
    const { deps, run } = await attempt({ avatarUrl: ownPageCopy });
    vi.mocked(deps.storage.getObjectUrl).mockRejectedValueOnce(
      createFileStorageError("transient", "r2_unavailable"),
    );
    await expect(run()).rejects.toMatchObject({ code: "transient" });
  });

  it("refuses another owner's page copy", async () => {
    const other = pageKey("human/human-2");
    const { deps, run } = await attempt(
      { avatarUrl: `${CDN}/${other}` },
      { existingKeys: [other] },
    );
    await expect(run()).rejects.toMatchObject(refused("avatarUrl"));
    expect(deps.repos.entityPages.upsert).not.toHaveBeenCalled();
  });

  it("refuses a foreign host serving an own-prefix path (the object exists)", async () => {
    const { run } = await attempt(
      { avatarUrl: `https://evil.example/${ownPageKey}` },
      { existingKeys: [ownPageKey] },
    );
    await expect(run()).rejects.toMatchObject(refused("avatarUrl"));
  });

  it("refuses an own copy with a query string or fragment appended", async () => {
    for (const avatarUrl of [`${ownPageCopy}?x=1`, `${ownPageCopy}#x`]) {
      const { run } = await attempt({ avatarUrl }, { existingKeys: [ownPageKey] });
      await expect(run()).rejects.toMatchObject(refused("avatarUrl"));
    }
  });

  it("refuses a foreign prefix (an event image)", async () => {
    const key = `events/e1/images/${hex}.jpg`;
    const { run } = await attempt({ avatarUrl: `${CDN}/${key}` }, { existingKeys: [key] });
    await expect(run()).rejects.toMatchObject(refused("avatarUrl"));
  });

  it("refuses an arbitrary external URL as a NEW value", async () => {
    const { run } = await attempt({ bannerUrl: "https://example.com/pic.jpg" });
    await expect(run()).rejects.toMatchObject(refused("bannerUrl"));
  });

  it("accepts the owner's own existing page copy, as avatar or banner", async () => {
    const avatar = await attempt({ avatarUrl: ownPageCopy }, { existingKeys: [ownPageKey] });
    await expect(avatar.run()).resolves.toMatchObject({ page: { avatarUrl: ownPageCopy } });
    expect(avatar.deps.repos.entityPages.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ avatarUrl: ownPageCopy }),
    );

    const banner = await attempt({ bannerUrl: ownPageCopy }, { existingKeys: [ownPageKey] });
    await expect(banner.run()).resolves.toMatchObject({ page: { bannerUrl: ownPageCopy } });
  });

  it("accepts a copy when the public base URL has a path (local MinIO)", async () => {
    const base = "http://localhost:9000/th-dev";
    const url = `${base}/${ownPageKey}`;
    const { run } = await attempt(
      { avatarUrl: url },
      { publicBaseUrl: base, existingKeys: [ownPageKey] },
    );
    await expect(run()).resolves.toMatchObject({ page: { avatarUrl: url } });
  });

  it("ORG and PLACE pages accept only their own page-image copies", async () => {
    const orgKey = pageKey("organization/org-1");
    const org = await attempt(
      { avatarUrl: `${CDN}/${orgKey}` },
      { ownerType: "ORGANIZATION", ownerId: "org-1", existingKeys: [orgKey] },
    );
    await expect(org.run()).resolves.toMatchObject({ page: { avatarUrl: `${CDN}/${orgKey}` } });

    const humanCopyOnOrg = await attempt(
      { avatarUrl: ownPageCopy },
      { ownerType: "ORGANIZATION", ownerId: "org-1", existingKeys: [ownPageKey] },
    );
    await expect(humanCopyOnOrg.run()).rejects.toMatchObject(refused("avatarUrl"));

    const placeKey = pageKey("place/place-1");
    const place = await attempt(
      { bannerUrl: `${CDN}/${placeKey}` },
      { ownerType: "PLACE", ownerId: "place-1", existingKeys: [placeKey] },
    );
    await expect(place.run()).resolves.toMatchObject({ page: { bannerUrl: `${CDN}/${placeKey}` } });

    const otherPlaceKey = pageKey("place/place-2");
    const otherPlace = await attempt(
      { bannerUrl: `${CDN}/${otherPlaceKey}` },
      { ownerType: "PLACE", ownerId: "place-1", existingKeys: [otherPlaceKey] },
    );
    await expect(otherPlace.run()).rejects.toMatchObject(refused("bannerUrl"));
  });

  it("an UNCHANGED value passes whatever it is (an OAuth avatar, a profile copy)", async () => {
    const oauth = "https://lh3.googleusercontent.com/a/photo=s96-c";
    const profileCopy = `${CDN}/${ownAvatarKey}`;
    const { deps, run } = await attempt(
      { avatarUrl: oauth, bannerUrl: profileCopy, bio: "new bio" },
      { existing: { avatarUrl: oauth, bannerUrl: profileCopy } },
    );
    await expect(run()).resolves.toMatchObject({
      page: { avatarUrl: oauth, bannerUrl: profileCopy, bio: "new bio" },
    });
    expect(deps.storage.getObjectUrl).not.toHaveBeenCalled();
  });

  it("clearing (null) always passes", async () => {
    const { run } = await attempt(
      { avatarUrl: null, bannerUrl: null },
      { existing: { avatarUrl: `${CDN}/${ownAvatarKey}`, bannerUrl: "https://example.com/b.jpg" } },
    );
    await expect(run()).resolves.toMatchObject({ page: { avatarUrl: null, bannerUrl: null } });
  });
});
