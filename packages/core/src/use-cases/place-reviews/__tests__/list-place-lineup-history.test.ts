import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  ActAtPlaceRow,
  ActsAtPlacePage,
} from "@th/types/repos/event-humans";

import {
  humanProfileUrlFor,
  listPlaceLineupHistory,
  type ListPlaceLineupHistoryDeps,
} from "../list-place-lineup-history";

// Grouping by act, distinct-show counting, case/trim folding, ordering and
// the limit all live in the adapter's SQL since spec FU-006 — they are pinned
// by `packages/adapters/test/integration/event-humans-acts-by-place.test.ts`.
// This file pins what core still owns: the place gate, the filter / clock /
// limit it hands the adapter, and the mapping to the public shape.

const PLACE_ID = "00000000-0000-4000-8000-00000000000a";
const VENUE_ORG_ID = "22222222-2222-4222-8222-222222222222";
const HUMAN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-09-24T18:00:00.000Z");
const d = (iso: string) => new Date(iso);
const OTHER_PLACE_ID = "00000000-0000-4000-8000-00000000000b";
const actKeyAt = (placeId: string, humanId: string) =>
  `h:${createHash("sha256")
    .update(`${placeId}:${humanId}`)
    .digest("hex")
    .slice(0, 12)}`;
const HUMAN_A_KEY = actKeyAt(PLACE_ID, HUMAN_A);

function act(overrides: Partial<ActAtPlaceRow>): ActAtPlaceRow {
  return {
    humanId: null,
    externalName: null,
    name: "Unnamed",
    profileSlug: null,
    timesPlayed: 1,
    lastPlayedAt: d("2026-09-20T04:00:00Z"),
    ...overrides,
  };
}

function makeDeps(opts: {
  page?: ActsAtPlacePage;
  place?: "missing" | "archived" | "active";
  acceptsCommunityListings?: boolean;
}): ListPlaceLineupHistoryDeps {
  const {
    page = { acts: [], totalActs: 0 },
    place = "active",
    acceptsCommunityListings = false,
  } = opts;
  return {
    repos: {
      places: {
        getById: vi.fn(async (id: string) =>
          place === "missing"
            ? null
            : {
                id,
                status: place === "archived" ? "ARCHIVED" : "ACTIVE",
                orgIdsWithAccess: [VENUE_ORG_ID],
                humanIdsWithAccess: [],
                acceptsCommunityListings,
              },
        ),
      },
      eventHumans: {
        listActsByPlace: vi.fn(async () => page),
      },
    } as any,
    clock: { now: () => NOW },
  };
}

describe("listPlaceLineupHistory (FR-013 / R7, FU-006)", () => {
  it("reads through the place's venue-confirmation filter, the clock, and pushes recentLimit into the query", async () => {
    const deps = makeDeps({ acceptsCommunityListings: true });
    await listPlaceLineupHistory(deps, { placeId: PLACE_ID, recentLimit: 8 });
    expect(deps.repos.eventHumans.listActsByPlace).toHaveBeenCalledTimes(1);
    expect(deps.repos.eventHumans.listActsByPlace).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      now: NOW,
      venueConfirmedFor: {
        orgIds: [VENUE_ORG_ID],
        humanIds: [],
        acceptsCommunityListings: true,
      },
      // The public block's recent line: 8 acts, not the venue's history.
      limit: 8,
    });
  });

  it("recentLimit null (the acts page) asks for EVERY act", async () => {
    const deps = makeDeps({});
    await listPlaceLineupHistory(deps, { placeId: PLACE_ID, recentLimit: null });
    expect(deps.repos.eventHumans.listActsByPlace).toHaveBeenCalledWith(
      expect.objectContaining({ limit: null }),
    );
  });

  it("maps acts to the public shape: /humans/{slug} for a PUBLIC-page act, null otherwise; no ids ride along", async () => {
    const deps = makeDeps({
      page: {
        acts: [
          act({
            humanId: HUMAN_A,
            name: "Ada",
            profileSlug: "ada",
            timesPlayed: 3,
            lastPlayedAt: d("2026-09-20T04:00:00Z"),
          }),
          act({
            externalName: "The Sundowners ",
            name: "The Sundowners",
            timesPlayed: 1,
            lastPlayedAt: d("2026-09-13T04:00:00Z"),
          }),
        ],
        totalActs: 2,
      },
    });
    const out = await listPlaceLineupHistory(deps, {
      placeId: PLACE_ID,
      recentLimit: null,
    });
    expect(out).toStrictEqual({
      recent: [
        {
          key: HUMAN_A_KEY,
          name: "Ada",
          profileUrl: "/humans/ada",
          timesPlayed: 3,
          lastPlayedAt: d("2026-09-20T04:00:00Z"),
        },
        {
          key: "n:the sundowners",
          name: "The Sundowners",
          profileUrl: null,
          timesPlayed: 1,
          lastPlayedAt: d("2026-09-13T04:00:00Z"),
        },
      ],
      all: [
        {
          key: HUMAN_A_KEY,
          name: "Ada",
          profileUrl: "/humans/ada",
          timesPlayed: 3,
          lastPlayedAt: d("2026-09-20T04:00:00Z"),
        },
        {
          key: "n:the sundowners",
          name: "The Sundowners",
          profileUrl: null,
          timesPlayed: 1,
          lastPlayedAt: d("2026-09-13T04:00:00Z"),
        },
      ],
      allActsCount: 2,
    });
  });

  describe("act key (the React key; review WARNING on same-name acts)", () => {
    it("linked → `h:` + 12 hex of SHA-256(humanId), never the raw id; unlinked → `n:` + the SQL-folded stage name", async () => {
      const deps = makeDeps({
        page: {
          acts: [
            act({ humanId: HUMAN_A, name: "Sam", profileSlug: null }),
            act({ externalName: " \tSam\n", name: "Sam" }),
          ],
          totalActs: 2,
        },
      });
      const out = await listPlaceLineupHistory(deps, {
        placeId: PLACE_ID,
        recentLimit: null,
      });
      const [linked, unlinked] = out.all;
      expect(linked!.key).toMatch(/^h:[0-9a-f]{12}$/);
      expect(linked!.key).toBe(HUMAN_A_KEY);
      expect(JSON.stringify(out)).not.toContain(HUMAN_A);
      expect(unlinked!.key).toBe("n:sam");
      // Same display name, no profile either side — distinct keys.
      expect(linked!.name).toBe(unlinked!.name);
      expect(linked!.profileUrl).toBe(unlinked!.profileUrl);
      expect(linked!.key).not.toBe(unlinked!.key);
    });

    it("a key that would repeat within one response is disambiguated in list order (uniqueness ENFORCED)", async () => {
      // Simulated: the fake hands back three groups that fold to ONE JS key.
      // The real SQL would have merged these; the case it cannot rule out is
      // Postgres `lower` and JS `toLowerCase` disagreeing on an exotic code
      // point — the guard must hold whatever the cause.
      const deps = makeDeps({
        page: {
          acts: [
            act({ externalName: "Sam", name: "Sam" }),
            act({ externalName: "SAM", name: "SAM" }),
            act({ externalName: "sam", name: "sam" }),
          ],
          totalActs: 3,
        },
      });
      const out = await listPlaceLineupHistory(deps, {
        placeId: PLACE_ID,
        recentLimit: null,
      });
      expect(out.all.map((a) => a.key)).toEqual(["n:sam", "n:sam#2", "n:sam#3"]);
    });

    it("the SAME human at two different places gets two different keys — history is not linkable across venues", async () => {
      const page = {
        acts: [act({ humanId: HUMAN_A, name: "Sam", profileSlug: null })],
        totalActs: 1,
      };
      const here = await listPlaceLineupHistory(makeDeps({ page }), {
        placeId: PLACE_ID,
        recentLimit: null,
      });
      const there = await listPlaceLineupHistory(makeDeps({ page }), {
        placeId: OTHER_PLACE_ID,
        recentLimit: null,
      });
      expect(here.all[0]!.key).toBe(actKeyAt(PLACE_ID, HUMAN_A));
      expect(there.all[0]!.key).toBe(actKeyAt(OTHER_PLACE_ID, HUMAN_A));
      expect(here.all[0]!.key).not.toBe(there.all[0]!.key);
      // Neither is the bare-humanId hash a place-less scheme would emit.
      const bare = `h:${createHash("sha256").update(HUMAN_A).digest("hex").slice(0, 12)}`;
      expect([here.all[0]!.key, there.all[0]!.key]).not.toContain(bare);
    });

    it("same place + same human → same key on the limited (venue page) and unlimited (Roster) reads", async () => {
      const page = {
        acts: [
          act({ humanId: HUMAN_A, name: "Ada", profileSlug: "ada" }),
          act({ externalName: "Duo", name: "Duo" }),
        ],
        totalActs: 2,
      };
      const limited = await listPlaceLineupHistory(makeDeps({ page }), {
        placeId: PLACE_ID,
        recentLimit: 8,
      });
      const unlimited = await listPlaceLineupHistory(makeDeps({ page }), {
        placeId: PLACE_ID,
        recentLimit: null,
      });
      expect(limited.recent.map((x) => x.key)).toEqual(
        unlimited.all.map((x) => x.key),
      );
      expect(limited.recent[0]!.key).toBe(HUMAN_A_KEY);
    });

    it("keys are stable across reads of the same data", async () => {
      const page = {
        acts: [
          act({ humanId: HUMAN_A, name: "Ada", profileSlug: "ada" }),
          act({ externalName: "Duo", name: "Duo" }),
        ],
        totalActs: 2,
      };
      const a = await listPlaceLineupHistory(makeDeps({ page }), {
        placeId: PLACE_ID,
        recentLimit: 8,
      });
      const b = await listPlaceLineupHistory(makeDeps({ page }), {
        placeId: PLACE_ID,
        recentLimit: 8,
      });
      expect(a.recent.map((x) => x.key)).toEqual(b.recent.map((x) => x.key));
    });
  });

  it("with a limit, allActsCount is the adapter's TOTAL, not the length of the bounded page", async () => {
    const deps = makeDeps({
      page: {
        acts: ["A", "B"].map((n, i) =>
          act({
            externalName: n,
            name: n,
            lastPlayedAt: d(`2026-09-${20 - i}T04:00:00Z`),
          }),
        ),
        totalActs: 57,
      },
    });
    const out = await listPlaceLineupHistory(deps, {
      placeId: PLACE_ID,
      recentLimit: 2,
    });
    expect(out.recent.map((a) => a.name)).toEqual(["A", "B"]);
    expect(out.all).toEqual(out.recent);
    expect(out.allActsCount).toBe(57);
  });

  it("preserves the adapter's order (the SQL owns it)", async () => {
    const deps = makeDeps({
      page: {
        acts: ["Zed", "Amy", "Bob"].map((n) => act({ externalName: n, name: n })),
        totalActs: 3,
      },
    });
    const out = await listPlaceLineupHistory(deps, {
      placeId: PLACE_ID,
      recentLimit: null,
    });
    expect(out.all.map((a) => a.name)).toEqual(["Zed", "Amy", "Bob"]);
  });

  it("input.now overrides the clock", async () => {
    const deps = makeDeps({});
    await listPlaceLineupHistory(deps, {
      placeId: PLACE_ID,
      recentLimit: null,
      now: d("2026-10-02T00:00:00Z"),
    });
    expect(deps.repos.eventHumans.listActsByPlace).toHaveBeenCalledWith(
      expect.objectContaining({ now: d("2026-10-02T00:00:00Z") }),
    );
  });

  it("empty history → empty lists, count 0", async () => {
    const out = await listPlaceLineupHistory(makeDeps({}), {
      placeId: PLACE_ID,
      recentLimit: 8,
    });
    expect(out).toEqual({ recent: [], all: [], allActsCount: 0 });
  });

  it("an adapter row that breaks the output contract (empty name, zero shows) is a loud failure, not a silent render", async () => {
    const deps = makeDeps({
      page: { acts: [act({ name: "", timesPlayed: 0 })], totalActs: 1 },
    });
    await expect(
      listPlaceLineupHistory(deps, { placeId: PLACE_ID, recentLimit: 8 }),
    ).rejects.toThrow();
  });

  it("unknown place → PLACE_NOT_FOUND; archived place → PLACE_ARCHIVED; neither reads lineups", async () => {
    const missing = makeDeps({ place: "missing" });
    await expect(
      listPlaceLineupHistory(missing, { placeId: PLACE_ID, recentLimit: 8 }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(missing.repos.eventHumans.listActsByPlace).not.toHaveBeenCalled();

    const archived = makeDeps({ place: "archived" });
    await expect(
      listPlaceLineupHistory(archived, { placeId: PLACE_ID, recentLimit: 8 }),
    ).rejects.toMatchObject({ code: "PLACE_ARCHIVED" });
    expect(archived.repos.eventHumans.listActsByPlace).not.toHaveBeenCalled();
  });

  it("rejects a malformed placeId, an unknown key, and a non-positive limit at the boundary", async () => {
    const deps = makeDeps({});
    await expect(
      listPlaceLineupHistory(deps, { placeId: "nope", recentLimit: 8 }),
    ).rejects.toThrow();
    await expect(
      listPlaceLineupHistory(deps, {
        placeId: PLACE_ID,
        recentLimit: 8,
        extra: 1,
      }),
    ).rejects.toThrow();
    await expect(
      listPlaceLineupHistory(deps, { placeId: PLACE_ID, recentLimit: 0 }),
    ).rejects.toThrow();
    expect(deps.repos.places.getById).not.toHaveBeenCalled();
  });
});

describe("humanProfileUrlFor", () => {
  it("builds /humans/{slug} and returns null for a missing or blank slug", () => {
    expect(humanProfileUrlFor("ada-lovelace")).toBe("/humans/ada-lovelace");
    expect(humanProfileUrlFor(" ada ")).toBe("/humans/ada");
    expect(humanProfileUrlFor(null)).toBeNull();
    expect(humanProfileUrlFor("   ")).toBeNull();
  });
});

describe("listPlaceLineupHistory — a group is its own act (lineup v3 FR-015)", () => {
  const GROUP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const groupKeyAt = (placeId: string) =>
    `o:${createHash("sha256")
      .update(`${placeId}:${GROUP}`)
      .digest("hex")
      .slice(0, 12)}`;

  it("keys a group by a PLACE-scoped hash of its org id (never the raw id) and links its PUBLIC org page", async () => {
    const page = {
      acts: [
        act({ orgId: GROUP, orgPageSlug: "paper-moth", name: "Paper Moth" }),
        act({ orgId: GROUP, orgPageSlug: null, name: "Paper Moth" }),
      ],
      totalActs: 2,
    };
    const here = await listPlaceLineupHistory(makeDeps({ page }), {
      placeId: PLACE_ID,
      recentLimit: null,
    });
    expect(here.all[0]).toMatchObject({
      key: groupKeyAt(PLACE_ID),
      profileUrl: "/orgs/paper-moth",
    });
    // No public page → no link; a repeat key is still made unique.
    expect(here.all[1]).toMatchObject({
      key: `${groupKeyAt(PLACE_ID)}#2`,
      profileUrl: null,
    });
    expect(JSON.stringify(here)).not.toContain(GROUP);

    // Unlinkable across venues, like a person's key.
    const elsewhere = await listPlaceLineupHistory(makeDeps({ page }), {
      placeId: OTHER_PLACE_ID,
      recentLimit: null,
    });
    expect(elsewhere.all[0]!.key).not.toBe(here.all[0]!.key);
    // A group and a person never share a key space.
    expect(here.all[0]!.key.startsWith("o:")).toBe(true);
    expect(HUMAN_A_KEY.startsWith("h:")).toBe(true);
  });
});
