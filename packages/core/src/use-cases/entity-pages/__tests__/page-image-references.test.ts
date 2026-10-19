import { describe, expect, it, vi } from "vitest";

import {
  isPageImageKeyReferenced,
  type PageImageReferenceRepos,
} from "../page-image-references";

const KEY =
  "entity-pages/place/place-1/2026-10-14/0123456789abcdef0123456789abcdef.jpg";
const URL = `https://cdn.example.test/${KEY}`;

type Parts = {
  page?: Record<string, unknown> | null;
  theme?: unknown;
  blocks?: unknown[];
  draft?: { data: unknown; placePatch: unknown } | null;
  place?: unknown;
};

function build(parts: Parts = {}) {
  const page =
    parts.page === undefined
      ? { id: "page-1", ownerType: "PLACE", ownerId: "place-1" }
      : parts.page;
  const getById = vi.fn(async () => page);
  const placeGetById = vi.fn(async () => parts.place ?? { id: "place-1" });
  const repos = {
    entityPages: {
      getById,
      getTheme: vi.fn(async () => parts.theme ?? null),
      listBlocks: vi.fn(async () =>
        (parts.blocks ?? []).map((data, i) => ({ id: `b${i}`, data })),
      ),
      getDraft: vi.fn(async () => parts.draft ?? null),
    },
    places: { getById: placeGetById },
  } as unknown as PageImageReferenceRepos;
  return { repos, placeGetById };
}

describe("isPageImageKeyReferenced", () => {
  it("is false when the key appears nowhere", async () => {
    const { repos } = build({ blocks: [{ text: "hello" }] });
    expect(await isPageImageKeyReferenced(repos, "page-1", KEY)).toBe(false);
  });

  it("is false when the page no longer exists", async () => {
    const { repos } = build({ page: null, blocks: [{ url: URL }] });
    expect(await isPageImageKeyReferenced(repos, "page-1", KEY)).toBe(false);
  });

  it("keeps a key on the page row (avatar)", async () => {
    const { repos } = build({
      page: {
        id: "page-1",
        ownerType: "PLACE",
        ownerId: "place-1",
        avatarUrl: URL,
      },
    });
    expect(await isPageImageKeyReferenced(repos, "page-1", KEY)).toBe(true);
  });

  it("keeps a key in the theme", async () => {
    const { repos } = build({ theme: { background: { image: URL } } });
    expect(await isPageImageKeyReferenced(repos, "page-1", KEY)).toBe(true);
  });

  it("keeps a key in a block of a non-first section", async () => {
    const { repos } = build({
      blocks: [
        { section: 0, text: "first" },
        { section: 2, photos: [{ url: URL }] },
      ],
    });
    expect(await isPageImageKeyReferenced(repos, "page-1", KEY)).toBe(true);
  });

  it("keeps a key in draft.data", async () => {
    const { repos } = build({
      draft: { data: { blocks: [{ url: URL }] }, placePatch: null },
    });
    expect(await isPageImageKeyReferenced(repos, "page-1", KEY)).toBe(true);
  });

  it("keeps a key in draft.placePatch", async () => {
    const { repos } = build({
      draft: { data: {}, placePatch: { imageUrl: URL } },
    });
    expect(await isPageImageKeyReferenced(repos, "page-1", KEY)).toBe(true);
  });

  it("keeps a key on the Place row of a PLACE page", async () => {
    const { repos, placeGetById } = build({
      place: { id: "place-1", imageUrl: URL },
    });
    expect(await isPageImageKeyReferenced(repos, "page-1", KEY)).toBe(true);
    expect(placeGetById).toHaveBeenCalledWith("place-1");
  });

  it("never reads a Place for a non-PLACE page", async () => {
    const { repos, placeGetById } = build({
      page: { id: "page-1", ownerType: "ORG", ownerId: "org-1" },
      place: { id: "place-1", imageUrl: URL },
    });
    expect(await isPageImageKeyReferenced(repos, "page-1", KEY)).toBe(false);
    expect(placeGetById).not.toHaveBeenCalled();
  });

  it("matches by substring, so a key that is a prefix of another is kept", async () => {
    // Current behaviour: `includes`, not an exact-key compare. The key ending
    // `.jpg` is a prefix of `.jpg.webp`-style siblings, so a page that holds
    // the longer key also "keeps" the shorter one. Erring toward keep is
    // intended: a dangling image is worse than a late delete.
    const longer = `${URL}.webp`;
    const { repos } = build({ blocks: [{ url: longer }] });
    expect(await isPageImageKeyReferenced(repos, "page-1", KEY)).toBe(true);
    // The reverse does not hold: the longer key is not in the shorter URL.
    const { repos: repos2 } = build({ blocks: [{ url: URL }] });
    expect(
      await isPageImageKeyReferenced(repos2, "page-1", `${KEY}.webp`),
    ).toBe(false);
  });
});
