import { describe, expect, it, vi } from "vitest";

import type { CommunityListingPlatformRow } from "@th/ports/repos/events";

import {
  DEFAULT_COMMUNITY_LISTING_STATUSES,
  listCommunityListings,
  type ListCommunityListingsDeps,
} from "../list-community-listings";
import {
  ADMIN_ID,
  EVENT_ID,
  MODERATOR_ID,
  NOW,
  USER_ID,
  makeClock,
  makeStaffAuthz,
} from "./helpers";

const SECOND_EVENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const HOUR = 60 * 60 * 1000;

function makeRow(
  overrides: Partial<CommunityListingPlatformRow> = {},
): CommunityListingPlatformRow {
  return {
    id: EVENT_ID,
    title: "Open mic",
    status: "PUBLISHED",
    slug: "open-mic--abc123",
    timezone: "America/Chicago",
    startsAt: new Date(NOW.getTime() + 24 * HOUR),
    endsAt: new Date(NOW.getTime() + 27 * HOUR),
    recurring: false,
    placeId: PLACE_ID,
    placeName: "The Ember Room",
    placeCity: "Nashville",
    locality: "Nashville",
    nextScheduledDateStartsAt: null,
    upcomingScheduledDateCount: 0,
    publishedAt: new Date("2026-06-01T00:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  };
}

function buildDeps(
  rows: CommunityListingPlatformRow[] = [makeRow()],
  nextCursor: string | null = null,
) {
  const listCommunityListingsForPlatform = vi.fn(async () => ({
    items: rows,
    nextCursor,
  }));
  const deps: ListCommunityListingsDeps = {
    repos: {
      events: { listCommunityListingsForPlatform },
    } as unknown as ListCommunityListingsDeps["repos"],
    authz: makeStaffAuthz({
      [ADMIN_ID]: ["ADMIN"],
      [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
    }),
    clock: makeClock(),
  };
  return { deps, listCommunityListingsForPlatform };
}

describe("listCommunityListings", () => {
  it("returns the page for a platform ADMIN with the default statuses (no CANCELLED or ARCHIVED)", async () => {
    const { deps, listCommunityListingsForPlatform } = buildDeps();

    const result = await listCommunityListings(deps, {
      actorHumanId: ADMIN_ID,
    });

    expect(listCommunityListingsForPlatform).toHaveBeenCalledWith({
      statuses: DEFAULT_COMMUNITY_LISTING_STATUSES,
      titleContains: null,
      cursor: null,
      limit: 25,
      now: NOW,
    });
    expect(DEFAULT_COMMUNITY_LISTING_STATUSES).toEqual(["DRAFT", "PUBLISHED", "COMPLETED"]);
    expect(result.nextCursor).toBeNull();
    expect(result.items).toEqual([
      {
        id: EVENT_ID,
        title: "Open mic",
        status: "PUBLISHED",
        slug: "open-mic--abc123",
        timezone: "America/Chicago",
        startsAt: makeRow().startsAt,
        endsAt: makeRow().endsAt,
        recurring: false,
        placeId: PLACE_ID,
        placeName: "The Ember Room",
        city: "Nashville",
        nextNightStartsAt: makeRow().startsAt,
        upcomingNightCount: 1,
        publishedAt: makeRow().publishedAt,
        createdAt: makeRow().createdAt,
        updatedAt: makeRow().updatedAt,
      },
    ]);
  });

  it("carries no RSVP count on a row (FR-004)", async () => {
    const { deps } = buildDeps();
    const result = await listCommunityListings(deps, { actorHumanId: ADMIN_ID });
    const keys = Object.keys(result.items[0]!);
    expect(keys.some((key) => /rsvp|going|attend/i.test(key))).toBe(false);
  });

  it("refuses a COMMUNITY_MODERATOR with STAFF_ONLY and never reads", async () => {
    const { deps, listCommunityListingsForPlatform } = buildDeps();

    await expect(
      listCommunityListings(deps, { actorHumanId: MODERATOR_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(listCommunityListingsForPlatform).not.toHaveBeenCalled();
  });

  it("refuses a signed-in human with no staff role", async () => {
    const { deps, listCommunityListingsForPlatform } = buildDeps();

    await expect(
      listCommunityListings(deps, { actorHumanId: USER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(listCommunityListingsForPlatform).not.toHaveBeenCalled();
  });

  it("asks the authz port for ADMIN only", async () => {
    const { deps } = buildDeps();
    await listCommunityListings(deps, { actorHumanId: ADMIN_ID });
    expect(deps.authz.hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ADMIN_ID,
        requiredRoles: ["ADMIN"],
      }),
    );
  });

  it("rejects bad input as invalid_input", async () => {
    const { deps } = buildDeps();
    await expect(
      listCommunityListings(deps, { actorHumanId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      listCommunityListings(deps, {
        actorHumanId: ADMIN_ID,
        status: "DELETED",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      listCommunityListings(deps, { actorHumanId: ADMIN_ID, limit: 101 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      listCommunityListings(deps, {
        actorHumanId: ADMIN_ID,
        query: "x".repeat(201),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      listCommunityListings(deps, { actorHumanId: ADMIN_ID, orgId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("excludes CANCELLED by default but passes it when asked for", async () => {
    const { deps, listCommunityListingsForPlatform } = buildDeps([]);

    await listCommunityListings(deps, { actorHumanId: ADMIN_ID });
    expect(listCommunityListingsForPlatform).toHaveBeenLastCalledWith(
      expect.objectContaining({
        statuses: expect.not.arrayContaining(["CANCELLED"]),
      }),
    );

    await listCommunityListings(deps, {
      actorHumanId: ADMIN_ID,
      status: "CANCELLED",
    });
    expect(listCommunityListingsForPlatform).toHaveBeenLastCalledWith(
      expect.objectContaining({ statuses: ["CANCELLED"] }),
    );
  });

  it("passes one explicit status (ARCHIVED included) and the title query, sanitized", async () => {
    const { deps, listCommunityListingsForPlatform } = buildDeps([]);

    await listCommunityListings(deps, {
      actorHumanId: ADMIN_ID,
      status: "ARCHIVED",
      query: "  <b>Open</b> mic  ",
    });

    expect(listCommunityListingsForPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["ARCHIVED"],
        titleContains: "Open mic",
      }),
    );
  });

  it("treats a blank query as no title filter", async () => {
    const { deps, listCommunityListingsForPlatform } = buildDeps([]);
    await listCommunityListings(deps, { actorHumanId: ADMIN_ID, query: "   " });
    expect(listCommunityListingsForPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ titleContains: null }),
    );
  });

  describe("paging", () => {
    it("first page: forwards limit, returns the adapter's nextCursor", async () => {
      const { deps, listCommunityListingsForPlatform } = buildDeps(
        [makeRow(), makeRow({ id: SECOND_EVENT_ID })],
        SECOND_EVENT_ID,
      );

      const result = await listCommunityListings(deps, {
        actorHumanId: ADMIN_ID,
        limit: 2,
      });

      expect(listCommunityListingsForPlatform).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: null, limit: 2 }),
      );
      expect(result.items.map((item) => item.id)).toEqual([
        EVENT_ID,
        SECOND_EVENT_ID,
      ]);
      expect(result.nextCursor).toBe(SECOND_EVENT_ID);
    });

    it("next page: forwards the cursor; the last page has nextCursor null", async () => {
      const { deps, listCommunityListingsForPlatform } = buildDeps(
        [makeRow({ id: EVENT_ID })],
        null,
      );

      const result = await listCommunityListings(deps, {
        actorHumanId: ADMIN_ID,
        cursor: SECOND_EVENT_ID,
        limit: 2,
      });

      expect(listCommunityListingsForPlatform).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: SECOND_EVENT_ID, limit: 2 }),
      );
      expect(result.nextCursor).toBeNull();
    });

    it("an empty page is fine", async () => {
      const { deps } = buildDeps([], null);
      const result = await listCommunityListings(deps, {
        actorHumanId: ADMIN_ID,
      });
      expect(result).toEqual({ items: [], nextCursor: null });
    });

    it("rejects a non-uuid cursor", async () => {
      const { deps } = buildDeps();
      await expect(
        listCommunityListings(deps, {
          actorHumanId: ADMIN_ID,
          cursor: "not-an-id",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("night fields", () => {
    it("recurring: takes the next SCHEDULED date and its count from the adapter", async () => {
      const next = new Date(NOW.getTime() + 2 * 24 * HOUR);
      const { deps } = buildDeps([
        makeRow({
          recurring: true,
          nextScheduledDateStartsAt: next,
          upcomingScheduledDateCount: 7,
        }),
      ]);
      const [item] = (
        await listCommunityListings(deps, { actorHumanId: ADMIN_ID })
      ).items;
      expect(item).toMatchObject({
        recurring: true,
        nextNightStartsAt: next,
        upcomingNightCount: 7,
      });
    });

    it("recurring with every night past or called off: no next night, count 0", async () => {
      const { deps } = buildDeps([
        makeRow({
          recurring: true,
          nextScheduledDateStartsAt: null,
          upcomingScheduledDateCount: 0,
        }),
      ]);
      const [item] = (
        await listCommunityListings(deps, { actorHumanId: ADMIN_ID })
      ).items;
      expect(item).toMatchObject({ nextNightStartsAt: null, upcomingNightCount: 0 });
    });

    it.each(["CANCELLED", "COMPLETED", "ARCHIVED"] as const)(
      "recurring %s listing that still has SCHEDULED dates: no next night, count 0",
      async (status) => {
        const { deps } = buildDeps([
          makeRow({
            status,
            recurring: true,
            nextScheduledDateStartsAt: new Date(NOW.getTime() + 2 * 24 * HOUR),
            upcomingScheduledDateCount: 3,
          }),
        ]);
        const [item] = (
          await listCommunityListings(deps, { actorHumanId: ADMIN_ID })
        ).items;
        expect(item).toMatchObject({
          status,
          recurring: true,
          nextNightStartsAt: null,
          upcomingNightCount: 0,
        });
      },
    );

    it("recurring DRAFT listing counts its SCHEDULED dates", async () => {
      const next = new Date(NOW.getTime() + 2 * 24 * HOUR);
      const { deps } = buildDeps([
        makeRow({
          status: "DRAFT",
          recurring: true,
          nextScheduledDateStartsAt: next,
          upcomingScheduledDateCount: 4,
        }),
      ]);
      const [item] = (
        await listCommunityListings(deps, { actorHumanId: ADMIN_ID })
      ).items;
      expect(item).toMatchObject({ nextNightStartsAt: next, upcomingNightCount: 4 });
    });

    it("one-off that has ended: no next night", async () => {
      const { deps } = buildDeps([
        makeRow({
          startsAt: new Date(NOW.getTime() - 5 * HOUR),
          endsAt: new Date(NOW.getTime() - 2 * HOUR),
        }),
      ]);
      const [item] = (
        await listCommunityListings(deps, { actorHumanId: ADMIN_ID })
      ).items;
      expect(item).toMatchObject({ nextNightStartsAt: null, upcomingNightCount: 0 });
    });

    it("one-off happening now still counts (endsAt in the future)", async () => {
      const startsAt = new Date(NOW.getTime() - HOUR);
      const { deps } = buildDeps([
        makeRow({ startsAt, endsAt: new Date(NOW.getTime() + HOUR) }),
      ]);
      const [item] = (
        await listCommunityListings(deps, { actorHumanId: ADMIN_ID })
      ).items;
      expect(item).toMatchObject({ nextNightStartsAt: startsAt, upcomingNightCount: 1 });
    });

    it("one-off that is CANCELLED: its future night does not count", async () => {
      const { deps } = buildDeps([makeRow({ status: "CANCELLED" })]);
      const [item] = (
        await listCommunityListings(deps, { actorHumanId: ADMIN_ID })
      ).items;
      expect(item).toMatchObject({ nextNightStartsAt: null, upcomingNightCount: 0 });
    });

    it("city falls back to the listing's own locality when there is no place", async () => {
      const { deps } = buildDeps([
        makeRow({
          placeId: null,
          placeName: null,
          placeCity: null,
          locality: "Memphis",
        }),
      ]);
      const [item] = (
        await listCommunityListings(deps, { actorHumanId: ADMIN_ID })
      ).items;
      expect(item).toMatchObject({ placeName: null, city: "Memphis" });
    });
  });
});
