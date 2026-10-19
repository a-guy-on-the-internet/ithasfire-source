/**
 * A community moderator's place page image (PAGE_MEDIA, subject PLACE) can be
 * deleted before the moderation drain scans it: a handover Clear or a draft
 * discard (after their grace), or a place merge. That `not_found` is not a
 * storage fault: the row is resolved ORPHANED with `removedOnPurpose` (kept
 * out of `orphanedRecent`) and nothing goes to Sentry. A key the page still
 * names that is gone IS a fault and is reported as before.
 */

import { describe, expect, it, vi } from "vitest";

import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";

import { moderateImage, type ModerateImageDeps } from "../moderate-image";

const PLACE_ID = "place-1";
const CDN = "https://cdn.example";
const KEY = `entity-pages/place/${PLACE_ID}/2026-10-16/${"a".repeat(32)}.jpg`;
const OTHER_KEY = `entity-pages/place/${PLACE_ID}/2026-10-16/${"b".repeat(32)}.jpg`;

function record(overrides: Partial<ImageModerationRecord> = {}): ImageModerationRecord {
  return {
    id: "rec-1",
    storageKey: KEY,
    kind: "PAGE_MEDIA",
    status: "PENDING",
    subjectType: "PLACE",
    subjectId: PLACE_ID,
    publicUrl: `${CDN}/${KEY}`,
    contentType: "image/jpeg",
    createdByHumanId: "human-moderator",
    maxSeverity: null,
    categories: null,
    provider: null,
    degraded: false,
    moderatedAt: null,
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date("2026-10-16T00:00:00.000Z"),
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
    updatedAt: new Date("2026-10-16T00:00:00.000Z"),
    ...overrides,
  };
}

type PageState = {
  page?: { id: string; avatarUrl: string | null; bannerUrl: string | null } | null;
  blocks?: { data: unknown }[];
  draft?: { data: unknown; placePatch: unknown } | null;
  throws?: boolean;
};

function makeDeps(rec: ImageModerationRecord, pageState: PageState | null) {
  const markOrphaned = vi.fn(async () => {});
  const reportError = vi.fn();
  const logger = {
    child: vi.fn(function (this: unknown) {
      return this;
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const entityPages =
    pageState === null
      ? undefined
      : {
          getByOwner: vi.fn(async () => {
            if (pageState.throws) throw new Error("db down");
            return pageState.page === undefined
              ? { id: "page-1", avatarUrl: null, bannerUrl: null }
              : pageState.page;
          }),
          getTheme: vi.fn(async () => null),
          listBlocks: vi.fn(async () => pageState.blocks ?? []),
          getDraft: vi.fn(async () => pageState.draft ?? null),
        };
  const deps = {
    repos: {
      imageModerationRecords: {
        getByKey: vi.fn(async () => rec),
        markOrphaned,
        markResult: vi.fn(),
      },
      ...(entityPages ? { entityPages } : {}),
    },
    fileStorage: {
      getObject: vi.fn(async () => {
        throw { code: "not_found", message: "object_not_found" };
      }),
    },
    moderation: { moderateImage: vi.fn() },
    config: { reviewThreshold: 4 },
    logger,
    reportError,
  } as unknown as ModerateImageDeps;
  return { deps, markOrphaned, reportError, logger };
}

describe("moderateImage: a place page image removed before its scan", () => {
  it("nothing on the page names it: ORPHANED on purpose, no report", async () => {
    const { deps, markOrphaned, reportError } = makeDeps(record(), {
      blocks: [{ data: { photos: [{ url: `${CDN}/${OTHER_KEY}` }] } }],
    });
    await expect(moderateImage(deps, { storageKey: KEY })).resolves.toEqual({
      status: "ORPHANED",
      maxSeverity: 0,
      degraded: false,
      noop: false,
      removedOnPurpose: true,
    });
    expect(markOrphaned).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: KEY,
        removedOnPurpose: true,
        lastError: "removed_before_scan: object_not_found",
      }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("the place's page is gone (a merge): ORPHANED on purpose, no report", async () => {
    const { deps, markOrphaned, reportError } = makeDeps(record(), { page: null });
    await moderateImage(deps, { storageKey: KEY });
    expect(markOrphaned).toHaveBeenCalledWith(
      expect.objectContaining({ removedOnPurpose: true }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a block still shows it: a real fault, reported as before", async () => {
    const { deps, markOrphaned, reportError } = makeDeps(record(), {
      blocks: [{ data: { photos: [{ url: `${CDN}/${KEY}` }] } }],
    });
    await moderateImage(deps, { storageKey: KEY });
    expect(markOrphaned).toHaveBeenCalledWith(
      expect.not.objectContaining({ removedOnPurpose: true }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("the avatar or the draft still names it: reported", async () => {
    const avatar = makeDeps(record(), {
      page: { id: "page-1", avatarUrl: `${CDN}/${KEY}`, bannerUrl: null },
    });
    await moderateImage(avatar.deps, { storageKey: KEY });
    expect(avatar.reportError).toHaveBeenCalledTimes(1);

    const draft = makeDeps(record(), {
      draft: { data: { blocks: [{ data: { url: `${CDN}/${KEY}` } }] }, placePatch: null },
    });
    await moderateImage(draft.deps, { storageKey: KEY });
    expect(draft.reportError).toHaveBeenCalledTimes(1);
  });

  it("a lookup that throws is reported, not hidden", async () => {
    const { deps, markOrphaned, reportError } = makeDeps(record(), { throws: true });
    const out = await moderateImage(deps, { storageKey: KEY });
    expect(out.removedOnPurpose).toBeUndefined();
    expect(markOrphaned).toHaveBeenCalledWith(
      expect.not.objectContaining({ removedOnPurpose: true }),
    );
    // Two reports: the failed lookup itself, then the ordinary orphan.
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db down" }),
      {
        tags: { area: "image-moderation", step: "page_reference_check" },
        extra: { recordId: "rec-1", storageKey: KEY },
      },
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "image-moderation", reason: "orphaned_object" },
      }),
    );
  });

  it("a throwing reporter on the failed lookup changes nothing", async () => {
    const { deps, markOrphaned, reportError } = makeDeps(record(), { throws: true });
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    await expect(moderateImage(deps, { storageKey: KEY })).resolves.toMatchObject({
      status: "ORPHANED",
      noop: false,
    });
    expect(markOrphaned).toHaveBeenCalledWith(
      expect.not.objectContaining({ removedOnPurpose: true }),
    );
  });

  it("without the entityPages dep, or for another kind, every missing object is reported", async () => {
    const noDep = makeDeps(record(), null);
    await moderateImage(noDep.deps, { storageKey: KEY });
    expect(noDep.reportError).toHaveBeenCalledTimes(1);

    const hero = makeDeps(
      record({ kind: "EVENT_HERO", subjectType: "EVENT", subjectId: "event-1" }),
      {},
    );
    await moderateImage(hero.deps, { storageKey: KEY });
    expect(hero.reportError).toHaveBeenCalledTimes(1);
  });
});
