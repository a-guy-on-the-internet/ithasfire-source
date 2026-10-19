import { describe, it, expect, vi, beforeEach } from "vitest";

import { setEventTags } from "./set-event-tags";
import type { SetEventTagsDeps } from "./set-event-tags";
import type { Repos, TxRepos } from "@th/ports/repos";

// ── Constants ──────────────────────────────────────────────────────────────

const HUMAN_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const TAG_ID_1 = "00000000-0000-4000-8000-000000000010";
const TAG_ID_2 = "00000000-0000-4000-8000-000000000011";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDeps(overrides?: {
  event?: Record<string, unknown> | null;
  membership?: { role: string } | null;
  setEventTagsResult?: Array<{
    id: string;
    eventId: string;
    tagId: string;
    sortOrder: number;
    createdAt: Date;
    tag: { id: string; slug: string; name: string; createdAt: Date };
  }>;
}): SetEventTagsDeps & { txRepos: TxRepos } {
  const event =
    overrides && "event" in overrides
      ? overrides.event
      : {
          id: EVENT_ID,
          humanId: null,
          orgId: ORG_ID,
          status: "DRAFT",
          categoryId: null,
        };

  const membership =
    overrides && "membership" in overrides
      ? overrides.membership
      : { role: "OWNER" };

  const setResult = overrides?.setEventTagsResult ?? [];

  const txRepos: TxRepos = {
    events: {
      getById: vi.fn().mockResolvedValue(event),
    },
    authz: {
      getOrgMembership: vi.fn().mockResolvedValue(membership),
    },
    tags: {
      setEventTags: vi.fn().mockResolvedValue(setResult),
    },
    audit: {
      log: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as TxRepos;

  const repos: Repos = {
    tx: vi
      .fn()
      .mockImplementation(async (fn: (tx: TxRepos) => unknown) => fn(txRepos)),
  } as unknown as Repos;

  return {
    repos,
    // Never reached on these OWNED fixtures (the guard branches on
    // stewardship), but wired so the deps object is a real SetEventTagsDeps
    // rather than one that only happens to work.
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
    clock: { now: () => new Date("2025-06-01T00:00:00Z") },
    txRepos,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("setEventTags", () => {
  it("sets tags on an event and returns them", async () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const deps = makeDeps({
      setEventTagsResult: [
        {
          id: "00000000-0000-4000-8000-000000000020",
          eventId: EVENT_ID,
          tagId: TAG_ID_1,
          sortOrder: 0,
          createdAt: now,
          tag: {
            id: TAG_ID_1,
            slug: "live-music",
            name: "Live Music",
            createdAt: now,
          },
        },
        {
          id: "00000000-0000-4000-8000-000000000021",
          eventId: EVENT_ID,
          tagId: TAG_ID_2,
          sortOrder: 1,
          createdAt: now,
          tag: {
            id: TAG_ID_2,
            slug: "outdoor",
            name: "Outdoor",
            createdAt: now,
          },
        },
      ],
    });

    const result = await setEventTags(deps, {
      actorHumanId: HUMAN_ID,
      eventId: EVENT_ID,
      tags: [
        { slug: "live-music", name: "Live Music" },
        { slug: "outdoor", name: "Outdoor" },
      ],
    });

    expect(result.eventId).toBe(EVENT_ID);
    expect(result.tags).toHaveLength(2);
    expect(result.tags[0]).toEqual({
      id: TAG_ID_1,
      slug: "live-music",
      name: "Live Music",
    });
    expect(result.tags[1]).toEqual({
      id: TAG_ID_2,
      slug: "outdoor",
      name: "Outdoor",
    });

    // Verify setEventTags was called with deduplicated, ordered tags
    expect(deps.txRepos.tags.setEventTags).toHaveBeenCalledWith(EVENT_ID, [
      { slug: "live-music", name: "Live Music", sortOrder: 0 },
      { slug: "outdoor", name: "Outdoor", sortOrder: 1 },
    ]);

    // Verify audit log
    expect(deps.txRepos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "tags_set",
        data: expect.objectContaining({
          actorHumanId: HUMAN_ID,
          tags: ["live-music", "outdoor"],
        }),
      }),
    );
  });

  it("deduplicates tags by slug", async () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const deps = makeDeps({
      setEventTagsResult: [
        {
          id: "00000000-0000-4000-8000-000000000020",
          eventId: EVENT_ID,
          tagId: TAG_ID_1,
          sortOrder: 0,
          createdAt: now,
          tag: {
            id: TAG_ID_1,
            slug: "live-music",
            name: "Live Music",
            createdAt: now,
          },
        },
      ],
    });

    await setEventTags(deps, {
      actorHumanId: HUMAN_ID,
      eventId: EVENT_ID,
      tags: [
        { slug: "live-music", name: "Live Music" },
        { slug: "live-music", name: "Live Music Duplicate" },
      ],
    });

    // Should only pass deduplicated tags
    expect(deps.txRepos.tags.setEventTags).toHaveBeenCalledWith(EVENT_ID, [
      { slug: "live-music", name: "Live Music", sortOrder: 0 },
    ]);
  });

  it("clears all tags when empty array is passed", async () => {
    const deps = makeDeps({ setEventTagsResult: [] });

    const result = await setEventTags(deps, {
      actorHumanId: HUMAN_ID,
      eventId: EVENT_ID,
      tags: [],
    });

    expect(result.tags).toHaveLength(0);
    expect(deps.txRepos.tags.setEventTags).toHaveBeenCalledWith(EVENT_ID, []);
  });

  it("throws not_found when event does not exist", async () => {
    const deps = makeDeps({ event: null });

    await expect(
      setEventTags(deps, {
        actorHumanId: HUMAN_ID,
        eventId: EVENT_ID,
        tags: [{ slug: "test", name: "Test" }],
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws forbidden when actor lacks org role", async () => {
    const deps = makeDeps({ membership: null });

    await expect(
      setEventTags(deps, {
        actorHumanId: HUMAN_ID,
        eventId: EVENT_ID,
        tags: [{ slug: "test", name: "Test" }],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws forbidden for VIEWER role", async () => {
    const deps = makeDeps({ membership: { role: "VIEWER" } });

    await expect(
      setEventTags(deps, {
        actorHumanId: HUMAN_ID,
        eventId: EVENT_ID,
        tags: [{ slug: "test", name: "Test" }],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws conflict for archived events", async () => {
    const deps = makeDeps({
      event: {
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        status: "ARCHIVED",
        categoryId: null,
      },
    });

    await expect(
      setEventTags(deps, {
        actorHumanId: HUMAN_ID,
        eventId: EVENT_ID,
        tags: [{ slug: "test", name: "Test" }],
      }),
    ).rejects.toMatchObject({ code: "EVENT_ARCHIVED" });
  });

  it("throws conflict for completed events", async () => {
    const deps = makeDeps({
      event: {
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        status: "COMPLETED",
        categoryId: null,
      },
    });

    await expect(
      setEventTags(deps, {
        actorHumanId: HUMAN_ID,
        eventId: EVENT_ID,
        tags: [{ slug: "test", name: "Test" }],
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_EDITABLE" });
  });

  it("allows personal event owner to set tags", async () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const deps = makeDeps({
      event: {
        id: EVENT_ID,
        humanId: HUMAN_ID,
        orgId: null,
        status: "DRAFT",
        categoryId: null,
      },
      membership: null, // no org membership needed
      setEventTagsResult: [
        {
          id: "00000000-0000-4000-8000-000000000020",
          eventId: EVENT_ID,
          tagId: TAG_ID_1,
          sortOrder: 0,
          createdAt: now,
          tag: { id: TAG_ID_1, slug: "test", name: "Test", createdAt: now },
        },
      ],
    });

    const result = await setEventTags(deps, {
      actorHumanId: HUMAN_ID,
      eventId: EVENT_ID,
      tags: [{ slug: "test", name: "Test" }],
    });

    expect(result.tags).toHaveLength(1);
  });

  it("rejects invalid input (missing eventId)", async () => {
    const deps = makeDeps();

    await expect(
      setEventTags(deps, {
        actorHumanId: HUMAN_ID,
        tags: [{ slug: "test", name: "Test" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
