import { describe, expect, it, vi } from "vitest";

import { updateHumanJobs } from "../update-human-jobs";
import type { UpdateHumanJobsDeps } from "../update-human-jobs";
import type { Repos } from "@th/ports/repos";
import type { HumansRepo } from "@th/ports/repos/humans";

const BASE_HUMAN = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Ada",
  status: "ACTIVE" as const,
  roles: ["USER"],
  locale: null,
  phone: null,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  trustTier: "NEW" as const,
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  jobs: [] as string[],
  genreTags: [] as string[],
  otherJobDescription: null as string | null,
  createdAt: new Date(),
};

function makeDeps(humansImpl: Partial<HumansRepo>): UpdateHumanJobsDeps {
  const humans = {
    getById: vi.fn(),
    getByIdWithIdentity: vi.fn(),
    getByEmail: vi.fn(),
    getByPhone: vi.fn(),
    getHumanIdForAuthUserId: vi.fn(),
    linkAuthUserToHuman: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateJobs: vi.fn(),
    ensureByProvider: vi.fn(),
    listForSearchIndex: vi.fn(),
    batchLookupHumanIdsByEmail: vi.fn(),
    searchByQuery: vi.fn(),
    getHumanTrustStats: vi.fn(),
    ...humansImpl,
  } as unknown as HumansRepo;

  const repos: Repos = {
    humans,
    audit: {} as any,
    tx: async () => {
      throw new Error("unexpected tx call");
    },
  } as unknown as Repos;

  return { repos };
}

describe("updateHumanJobs", () => {
  it("sets jobs for a valid human", async () => {
    const updated = { ...BASE_HUMAN, jobs: ["PHOTOGRAPHER", "DJ"] };
    const updateJobsFn = vi.fn(async () => updated);
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      updateJobs: updateJobsFn,
    });

    const result = await updateHumanJobs(deps, {
      actorHumanId: BASE_HUMAN.id,
      jobs: ["PHOTOGRAPHER", "DJ"],
    });

    expect(result).toEqual({ jobs: ["PHOTOGRAPHER", "DJ"], genreTags: [] });
    expect(updateJobsFn).toHaveBeenCalledWith(BASE_HUMAN.id, {
      jobs: ["PHOTOGRAPHER", "DJ"],
      genreTags: [],
      otherJobDescription: null,
    });
  });

  it("sets jobs + genreTags for a MUSICIAN", async () => {
    const updated = {
      ...BASE_HUMAN,
      jobs: ["MUSICIAN"],
      genreTags: ["jazz", "funk"],
    };
    const updateJobsFn = vi.fn(async () => updated);
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      updateJobs: updateJobsFn,
    });

    const result = await updateHumanJobs(deps, {
      actorHumanId: BASE_HUMAN.id,
      jobs: ["MUSICIAN"],
      genreTags: ["jazz", "funk"],
    });

    expect(result).toEqual({ jobs: ["MUSICIAN"], genreTags: ["jazz", "funk"] });
    expect(updateJobsFn).toHaveBeenCalledWith(BASE_HUMAN.id, {
      jobs: ["MUSICIAN"],
      genreTags: ["jazz", "funk"],
      otherJobDescription: null,
    });
  });

  it("sanitizes free-text fields (HTML, bidi overrides, control chars) before storing", async () => {
    const updated = {
      ...BASE_HUMAN,
      jobs: ["MUSICIAN", "OTHER"],
      genreTags: ["jazz"],
    };
    const updateJobsFn = vi.fn(async () => updated);
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      updateJobs: updateJobsFn,
    });

    await updateHumanJobs(deps, {
      actorHumanId: BASE_HUMAN.id,
      jobs: ["MUSICIAN", "OTHER"],
      // U+202E = RTL override (bidi spoofing); script tag content is discarded.
      genreTags: ["ja\u202Ezz<script>alert(1)</script>"],
      // U+200B = zero-width space, U+0007 = BEL control; tags are stripped.
      otherJobDescription: "Tour\u200B man\u0007ager <b>and</b> driver",
    });

    expect(updateJobsFn).toHaveBeenCalledWith(BASE_HUMAN.id, {
      jobs: ["MUSICIAN", "OTHER"],
      genreTags: ["jazz"],
      otherJobDescription: "Tour manager and driver",
    });
  });

  it("rejects a genre tag that collapses to empty after sanitization", async () => {
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      updateJobs: vi.fn(),
    });

    await expect(
      updateHumanJobs(deps, {
        actorHumanId: BASE_HUMAN.id,
        jobs: ["MUSICIAN"],
        // Entirely markup — sanitizes to "" and must fail min(1).
        genreTags: ["<script>alert(1)</script>"],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("strips genreTags when MUSICIAN is not in jobs", async () => {
    const updated = { ...BASE_HUMAN, jobs: ["DJ"], genreTags: [] };
    const updateJobsFn = vi.fn(async () => updated);
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      updateJobs: updateJobsFn,
    });

    const result = await updateHumanJobs(deps, {
      actorHumanId: BASE_HUMAN.id,
      jobs: ["DJ"],
      genreTags: ["jazz", "funk"],
    });

    expect(result).toEqual({ jobs: ["DJ"], genreTags: [] });
    expect(updateJobsFn).toHaveBeenCalledWith(BASE_HUMAN.id, {
      jobs: ["DJ"],
      genreTags: [],
      otherJobDescription: null,
    });
  });

  it("strips otherJobDescription when OTHER is not in jobs", async () => {
    const updated = {
      ...BASE_HUMAN,
      jobs: ["PHOTOGRAPHER"],
      otherJobDescription: null,
    };
    const updateJobsFn = vi.fn(async () => updated);
    const deps = makeDeps({
      getById: vi.fn(async () => BASE_HUMAN),
      updateJobs: updateJobsFn,
    });

    const result = await updateHumanJobs(deps, {
      actorHumanId: BASE_HUMAN.id,
      jobs: ["PHOTOGRAPHER"],
      otherJobDescription: "I do random stuff",
    });

    expect(result).toEqual({ jobs: ["PHOTOGRAPHER"], genreTags: [] });
    expect(updateJobsFn).toHaveBeenCalledWith(BASE_HUMAN.id, {
      jobs: ["PHOTOGRAPHER"],
      genreTags: [],
      otherJobDescription: null,
    });
  });

  it("returns not_found for missing human", async () => {
    const deps = makeDeps({
      getById: vi.fn(async () => null),
    });

    await expect(
      updateHumanJobs(deps, {
        actorHumanId: BASE_HUMAN.id,
        jobs: ["MUSICIAN"],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "HUMAN_NOT_FOUND" }));
  });

  it("is idempotent — calling twice with same input produces same result", async () => {
    const updated = {
      ...BASE_HUMAN,
      jobs: ["MUSICIAN", "OTHER"],
      genreTags: ["rock"],
      otherJobDescription: "session musician",
    };
    const updateJobsFn = vi.fn(async () => updated);
    const deps = makeDeps({
      getById: vi.fn(async () => updated),
      updateJobs: updateJobsFn,
    });

    const input = {
      actorHumanId: BASE_HUMAN.id,
      jobs: ["MUSICIAN", "OTHER"] as const,
      genreTags: ["rock"],
      otherJobDescription: "session musician",
    };

    const result1 = await updateHumanJobs(deps, input);
    const result2 = await updateHumanJobs(deps, input);

    expect(result1).toEqual(result2);
    expect(result1).toEqual({
      jobs: ["MUSICIAN", "OTHER"],
      genreTags: ["rock"],
    });
  });
});
