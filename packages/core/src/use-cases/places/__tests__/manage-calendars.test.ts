import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

import {
  assignCalendarSpaces,
  createCalendar,
  createCalendarInputSchema,
  deleteCalendarAvailability,
  listCalendarAvailability,
  listCalendars,
  updateCalendar,
  upsertCalendarAvailability,
  type ManageCalendarsDeps,
} from "../manage-calendars";

// Calendars are a place's named programming streams, joined M:N onto spaces.
// The join table has no cross-place guard, so `assignCalendarSpaces` is THE
// isolation choke point this suite hammers: a foreign calendarId or spaceId
// must read as not-found and leave nothing mutated.

const PLACE_ID = "00000000-0000-4000-8000-00000000c001";
const OTHER_PLACE_ID = "00000000-0000-4000-8000-00000000c002";
const OWNER_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const STRANGER_HUMAN_ID = "33333333-3333-4333-8333-333333333333";
const BASE_DATE = new Date("2026-08-01T00:00:00.000Z");

function buildDeps(ownerHumanIds: string[] = [OWNER_HUMAN_ID]) {
  const spaces = createFakeSpacesRepo();
  const calendars = createFakeCalendarsRepo({ spaces });
  const audit = { log: vi.fn(async () => undefined) };
  const authz = {
    getPlaceAccessContext: vi.fn(async () => ({
      owningOrgIds: [],
      verifiedHumanOwnerIds: ownerHumanIds,
    })),
    getOrgMembership: vi.fn(async () => null),
  };

  const txRepos = { spaces, calendars, audit, authz } as unknown as TxRepos;
  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as ManageCalendarsDeps["repos"];

  const deps: ManageCalendarsDeps = {
    repos,
    clock: { now: () => BASE_DATE },
  };

  // Every calendar has ≥1 space (venue-confirmation spec): a default room per
  // place so the create cases have something valid to join.
  const mainSpace = spaces.seed({ placeId: PLACE_ID, name: "Main Space" });
  const otherMainSpace = spaces.seed({
    placeId: OTHER_PLACE_ID,
    name: "Other Main Space",
  });

  return { deps, spaces, calendars, audit, authz, mainSpace, otherMainSpace };
}

describe("manage calendars", () => {
  describe("createCalendar", () => {
    it("derives the slug from the name via the shared slugifier", async () => {
      const { deps, mainSpace } = buildDeps();

      const calendar = await createCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceIds: [mainSpace.id],
        name: "Drkmttr Live Music!",
      });

      expect(calendar.slug).toBe("drkmttr-live-music");
      expect(calendar.isDefault).toBe(false);
    });

    it("de-dupes a derived slug with a numeric suffix", async () => {
      const { deps, calendars, mainSpace } = buildDeps();
      calendars.seedCalendar({
        placeId: PLACE_ID,
        name: "Live Music",
        slug: "live-music",
      });

      const calendar = await createCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceIds: [mainSpace.id],
        name: "Live Music",
      });

      expect(calendar.slug).toBe("live-music-2");
    });

    it("keeps suffix headroom when a max-length base collides (minted slug round-trips the explicit-slug schema)", async () => {
      const { deps, calendars, mainSpace } = buildDeps();
      // 80 chars slugify to a base truncated at CALENDAR_SLUG_MAX (64).
      const longName = "a".repeat(80);
      calendars.seedCalendar({
        placeId: PLACE_ID,
        name: longName,
        slug: "a".repeat(64),
      });

      const calendar = await createCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceIds: [mainSpace.id],
        name: longName,
      });

      // The base is trimmed to leave room for "-2" — never exceeds the max.
      expect(calendar.slug).toBe(`${"a".repeat(62)}-2`);
      // A slug the system minted must survive being fed back as an EXPLICIT
      // slug (`.max` + kebab regex) — the round-trip the reviewer flagged.
      expect(() =>
        createCalendarInputSchema.parse({
          actorHumanId: OWNER_HUMAN_ID,
          placeId: OTHER_PLACE_ID,
          spaceIds: [mainSpace.id],
          name: longName,
          slug: calendar.slug,
        }),
      ).not.toThrow();
    });

    it("rejects an EXPLICIT slug that collides within the place", async () => {
      const { deps, calendars, mainSpace } = buildDeps();
      calendars.seedCalendar({ placeId: PLACE_ID, slug: "social-club" });

      await expect(
        createCalendar(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          spaceIds: [mainSpace.id],
          name: "Social Club Redux",
          slug: "social-club",
        }),
      ).rejects.toMatchObject({ code: "CALENDAR_SLUG_TAKEN" });
    });

    it("allows the same slug on a DIFFERENT place (uniqueness is per-place)", async () => {
      const { deps, calendars, mainSpace } = buildDeps();
      calendars.seedCalendar({ placeId: OTHER_PLACE_ID, slug: "social-club" });

      const calendar = await createCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceIds: [mainSpace.id],
        name: "Social Club",
      });

      expect(calendar.slug).toBe("social-club");
    });

    it("never accepts isDefault (the default calendar is minted at place creation)", async () => {
      const { deps, mainSpace } = buildDeps();

      await expect(
        createCalendar(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          spaceIds: [mainSpace.id],
          name: "Coup Calendar",
          isDefault: true, // unknown key → strict schema rejects
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("joins the given spaces at create (every calendar has ≥1 space)", async () => {
      const { deps, spaces, calendars, mainSpace } = buildDeps();
      const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio" });

      const calendar = await createCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceIds: [mainSpace.id, patio.id, patio.id],
        name: "Patio Sessions",
      });

      // Deduped, in the same write as the row.
      expect(calendars.joins.get(calendar.id)).toEqual([mainSpace.id, patio.id]);
    });

    it("rejects an EMPTY spaceIds at the boundary (invalid_input, nothing created)", async () => {
      const { deps, calendars } = buildDeps();

      await expect(
        createCalendar(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          spaceIds: [],
          name: "Roomless",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(calendars.calendars.size).toBe(0);
    });

    it("rejects a spaceId belonging to another place (cross-place isolation at create)", async () => {
      const { deps, calendars, mainSpace, otherMainSpace } = buildDeps();
      const createSpy = vi.spyOn(calendars, "create");

      await expect(
        createCalendar(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          spaceIds: [mainSpace.id, otherMainSpace.id],
          name: "Sneaky Join",
        }),
      ).rejects.toMatchObject({ code: "SPACE_NOT_FOUND" });

      // The assert fires BEFORE the repo create, inside the tx.
      expect(createSpy).not.toHaveBeenCalled();
      expect(calendars.calendars.size).toBe(0);
    });

    // ── The PRIMARY space (owner ruling 2026-09-24) ────────────────────────
    // `Calendar.primarySpaceId` is NOT NULL and FK-pinned to an ACTIVE Space,
    // so the use case must NAME one. Which one is not arbitrary: it has to be
    // the same room every reader resolves as the calendar's main one, or the
    // constraint and the UI disagree about the same calendar.

    it("names the FIRST ACTIVE member of the set as the calendar's PRIMARY space", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const patio = spaces.seed({
        placeId: PLACE_ID,
        name: "Patio",
        sortOrder: 5,
      });
      const createSpy = vi.spyOn(calendars, "create");

      const created = await createCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceIds: [patio.id],
        name: "Patio Sessions",
      });

      expect(created.primarySpaceId).toBe(patio.id);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ primarySpaceId: patio.id }),
      );
    });

    it("SKIPS a leading RETIRED space when choosing the primary", async () => {
      // The admin checklist lists retired rooms as checkable, so a set whose
      // FIRST entry is retired is reachable from the real UI. Passing that id
      // as the primary would fail the FK in Postgres — a raw error for what is
      // a perfectly legal set.
      const { deps, spaces } = buildDeps();
      const ghost = spaces.seed({
        placeId: PLACE_ID,
        name: "Demolished Annex",
        status: "RETIRED",
      });
      const live = spaces.seed({ placeId: PLACE_ID, name: "Cellar" });

      const created = await createCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceIds: [ghost.id, live.id],
        name: "Mixed",
      });

      expect(created.primarySpaceId).toBe(live.id);
    });

    it("rejects an ALL-RETIRED space set — one JOIN is not one ACTIVE room", async () => {
      // Owner ruling 2026-09-23: roomless calendars are illegal everywhere.
      // `min(1)` at the boundary passes here; the use case must not.
      const { deps, spaces, calendars } = buildDeps();
      const ghost = spaces.seed({
        placeId: PLACE_ID,
        name: "Demolished Annex",
        status: "RETIRED",
      });
      const createSpy = vi.spyOn(calendars, "create");

      await expect(
        createCalendar(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          spaceIds: [ghost.id],
          name: "Annex Nights",
        }),
      ).rejects.toMatchObject({
        code: "CALENDAR_REQUIRES_ACTIVE_SPACE",
        meta: { placeId: PLACE_ID, spaceIds: [ghost.id] },
      });

      expect(createSpy).not.toHaveBeenCalled();
      expect(calendars.calendars.size).toBe(0);
    });

    it("accepts a set that mixes a retired room with an active one", async () => {
      const { deps, spaces, calendars, mainSpace } = buildDeps();
      const ghost = spaces.seed({
        placeId: PLACE_ID,
        name: "Demolished Annex",
        status: "RETIRED",
      });

      const created = await createCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceIds: [mainSpace.id, ghost.id],
        name: "Mixed",
      });

      expect(calendars.joins.get(created.id)).toEqual([mainSpace.id, ghost.id]);
    });

    it("refuses creation from a non-owner", async () => {
      const { deps, calendars, mainSpace } = buildDeps();

      await expect(
        createCalendar(deps, {
          actorHumanId: STRANGER_HUMAN_ID,
          placeId: PLACE_ID,
          spaceIds: [mainSpace.id],
          name: "Sneaky Calendar",
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(calendars.calendars.size).toBe(0);
    });
  });

  describe("createCalendar — availability-onboarding FR-003 nudge", () => {
    it("calls the hook post-commit for a created calendar (hook owns suppression + idempotency)", async () => {
      const { deps, mainSpace } = buildDeps();
      const notifyAvailabilitySetupNeeded = vi.fn(async () => undefined);
      deps.notifyAvailabilitySetupNeeded = notifyAvailabilitySetupNeeded;

      const created = await createCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceIds: [mainSpace.id],
        name: "Live Music",
      });

      expect(created.slug).toBe("live-music");
      expect(notifyAvailabilitySetupNeeded).toHaveBeenCalledTimes(1);
      expect(notifyAvailabilitySetupNeeded).toHaveBeenCalledWith({
        placeId: PLACE_ID,
        actorHumanId: OWNER_HUMAN_ID,
      });
    });

    it("a throwing hook never fails the committed create (swallow + report)", async () => {
      const { deps, mainSpace } = buildDeps();
      const reportError = vi.fn();
      deps.notifyAvailabilitySetupNeeded = vi.fn(async () => {
        throw new Error("notify down");
      });
      deps.reportError = reportError;

      const created = await createCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        spaceIds: [mainSpace.id],
        name: "Live Music",
      });

      expect(created.slug).toBe("live-music");
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does NOT call the hook when the create itself fails", async () => {
      const { deps, calendars, mainSpace } = buildDeps();
      calendars.seedCalendar({ placeId: PLACE_ID, slug: "live-music" });
      const notifyAvailabilitySetupNeeded = vi.fn(async () => undefined);
      deps.notifyAvailabilitySetupNeeded = notifyAvailabilitySetupNeeded;

      await expect(
        createCalendar(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          spaceIds: [mainSpace.id],
          name: "Live Music",
          slug: "live-music",
        }),
      ).rejects.toMatchObject({ code: "CALENDAR_SLUG_TAKEN" });
      expect(notifyAvailabilitySetupNeeded).not.toHaveBeenCalled();
    });
  });

  describe("updateCalendar", () => {
    it("patches fields of a same-place calendar", async () => {
      const { deps, calendars } = buildDeps();
      const calendar = calendars.seedCalendar({
        placeId: PLACE_ID,
        name: "Social Club",
      });

      const updated = await updateCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: calendar.id,
        patch: {
          defaultStartTime: "20:00",
          eventTemplate: { titleTemplate: "{act} at Social Club" },
        },
      });

      expect(updated.defaultStartTime).toBe("20:00");
      expect(updated.eventTemplate).toEqual({
        titleTemplate: "{act} at Social Club",
      });
    });

    it("rejects a patch addressing another place's calendar (cross-place isolation)", async () => {
      const { deps, calendars } = buildDeps();
      const foreign = calendars.seedCalendar({
        placeId: OTHER_PLACE_ID,
        name: "Foreign",
      });

      await expect(
        updateCalendar(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          calendarId: foreign.id,
          patch: { name: "Hijacked" },
        }),
      ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
      expect(calendars.calendars.get(foreign.id)?.name).toBe("Foreign");
    });

    it("rejects a defaultStartTime that is not 24h HH:mm", async () => {
      const { deps, calendars } = buildDeps();
      const calendar = calendars.seedCalendar({ placeId: PLACE_ID });

      for (const bad of ["25:00", "8pm", "19:5", "24:00"]) {
        await expect(
          updateCalendar(deps, {
            actorHumanId: OWNER_HUMAN_ID,
            placeId: PLACE_ID,
            calendarId: calendar.id,
            patch: { defaultStartTime: bad },
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }
    });

    it("rejects a non-object eventTemplate", async () => {
      const { deps, calendars } = buildDeps();
      const calendar = calendars.seedCalendar({ placeId: PLACE_ID });

      for (const bad of [["not", "an", "object"], "string", 42]) {
        await expect(
          updateCalendar(deps, {
            actorHumanId: OWNER_HUMAN_ID,
            placeId: PLACE_ID,
            calendarId: calendar.id,
            patch: { eventTemplate: bad },
          }),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }
    });

    it("does not allow slug or isDefault through the patch", async () => {
      const { deps, calendars } = buildDeps();
      const calendar = calendars.seedCalendar({
        placeId: PLACE_ID,
        slug: "stable-slug",
      });

      await expect(
        updateCalendar(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          calendarId: calendar.id,
          patch: { slug: "new-slug" },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        updateCalendar(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          calendarId: calendar.id,
          patch: { isDefault: true },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("assignCalendarSpaces", () => {
    it("replaces the calendar's spaces with same-place spaces", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
      const patio = spaces.seed({ placeId: PLACE_ID, name: "Patio" });
      const calendar = calendars.seedCalendar({ placeId: PLACE_ID });

      const result = await assignCalendarSpaces(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: calendar.id,
        spaceIds: [main.id, patio.id],
      });

      expect(calendars.joins.get(calendar.id)).toEqual([main.id, patio.id]);
      const returned = result.find((c) => c.id === calendar.id);
      expect(returned?.spaces.map((r) => r.id).sort()).toEqual(
        [main.id, patio.id].sort(),
      );
    });

    it("rejects a spaceId belonging to another place (THE isolation test)", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const own = spaces.seed({ placeId: PLACE_ID, name: "Main" });
      const foreign = spaces.seed({ placeId: OTHER_PLACE_ID, name: "Foreign" });
      const calendar = calendars.seedCalendar({ placeId: PLACE_ID });
      const setSpacesSpy = vi.spyOn(calendars, "setSpaces");

      await expect(
        assignCalendarSpaces(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          calendarId: calendar.id,
          spaceIds: [own.id, foreign.id],
        }),
      ).rejects.toMatchObject({ code: "SPACE_NOT_FOUND" });

      // Nothing mutated — the assert fires BEFORE setSpaces, inside the tx.
      expect(setSpacesSpy).not.toHaveBeenCalled();
      expect(calendars.joins.get(calendar.id)).toEqual([]);
    });

    it("rejects a calendarId belonging to another place", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const own = spaces.seed({ placeId: PLACE_ID, name: "Main" });
      const foreignCalendar = calendars.seedCalendar({
        placeId: OTHER_PLACE_ID,
      });

      await expect(
        assignCalendarSpaces(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          calendarId: foreignCalendar.id,
          spaceIds: [own.id],
        }),
      ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
      expect(calendars.joins.get(foreignCalendar.id)).toEqual([]);
    });

    it("REFUSES an empty space set (every calendar has ≥1 space — invalid_input, joins untouched)", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
      const calendar = calendars.seedCalendar({ placeId: PLACE_ID });
      calendars.seedJoins(calendar.id, [main.id]);
      const setSpacesSpy = vi.spyOn(calendars, "setSpaces");

      await expect(
        assignCalendarSpaces(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          calendarId: calendar.id,
          spaceIds: [],
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(setSpacesSpy).not.toHaveBeenCalled();
      expect(calendars.joins.get(calendar.id)).toEqual([main.id]);
    });

    // ── ≥1 ACTIVE space (owner ruling 2026-09-23) ──────────────────────────
    // `min(1)` at the boundary buys one JOIN, not one ACTIVE room. The admin
    // checklist lists retired rooms as checkable, so an all-retired set is
    // reachable from the real UI.

    it("REFUSES a replacement set with no ACTIVE space, joins untouched", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
      const ghost = spaces.seed({
        placeId: PLACE_ID,
        name: "Demolished Annex",
        status: "RETIRED",
      });
      const calendar = calendars.seedCalendar({ placeId: PLACE_ID });
      calendars.seedJoins(calendar.id, [main.id]);
      const setSpacesSpy = vi.spyOn(calendars, "setSpaces");

      await expect(
        assignCalendarSpaces(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          calendarId: calendar.id,
          spaceIds: [ghost.id],
        }),
      ).rejects.toMatchObject({
        code: "CALENDAR_REQUIRES_ACTIVE_SPACE",
        meta: { placeId: PLACE_ID, calendarId: calendar.id },
      });

      expect(setSpacesSpy).not.toHaveBeenCalled();
      expect(calendars.joins.get(calendar.id)).toEqual([main.id]);
    });

    // ── The PRIMARY travels with the set (owner ruling 2026-09-24) ─────────
    // `Calendar.primarySpaceId` is FK-pinned to an ACTIVE Space but NOT to the
    // calendar's own joins, so a replacement that dropped the primary and left
    // the column alone would leave it naming a room the calendar no longer
    // serves. Nothing in the database would object.

    it("REPOINTS the primary when the replacement set drops it", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const main = spaces.seed({
        placeId: PLACE_ID,
        name: "Main",
        sortOrder: 0,
      });
      const patio = spaces.seed({
        placeId: PLACE_ID,
        name: "Patio",
        sortOrder: 1,
      });
      const calendar = calendars.seedCalendar({
        placeId: PLACE_ID,
        primarySpaceId: main.id,
      });
      await calendars.setSpaces({
        calendarId: calendar.id,
        spaceIds: [main.id, patio.id],
        primarySpaceId: main.id,
      });

      await assignCalendarSpaces(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: calendar.id,
        spaceIds: [patio.id],
      });

      expect(calendars.calendars.get(calendar.id)!.primarySpaceId).toBe(
        patio.id,
      );
      expect(calendars.joins.get(calendar.id)).toEqual([patio.id]);
    });

    it("KEEPS the primary when it survives the replacement", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const main = spaces.seed({
        placeId: PLACE_ID,
        name: "Main",
        sortOrder: 0,
      });
      const patio = spaces.seed({
        placeId: PLACE_ID,
        name: "Patio",
        sortOrder: 1,
      });
      const calendar = calendars.seedCalendar({
        placeId: PLACE_ID,
        primarySpaceId: main.id,
      });
      await calendars.setSpaces({
        calendarId: calendar.id,
        spaceIds: [main.id],
        primarySpaceId: main.id,
      });

      await assignCalendarSpaces(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: calendar.id,
        spaceIds: [main.id, patio.id],
      });

      expect(calendars.calendars.get(calendar.id)!.primarySpaceId).toBe(
        main.id,
      );
    });

    it("passes the primary to setSpaces even when UNCHANGED — the write takes the row lock", async () => {
      // The unconditional write is not cosmetic. It is what makes a concurrent
      // `setSpaceStatus` queue behind this transaction instead of promoting
      // around it; skipping it reopens the 2026-09-23 race in a new shape (see
      // the port doc on `CalendarsRepo.setSpaces`, and
      // adapters/test/integration/calendar-primary-space-race.test.ts).
      const { deps, spaces, calendars } = buildDeps();
      const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
      const calendar = calendars.seedCalendar({
        placeId: PLACE_ID,
        primarySpaceId: main.id,
      });
      await calendars.setSpaces({
        calendarId: calendar.id,
        spaceIds: [main.id],
        primarySpaceId: main.id,
      });
      const setSpacesSpy = vi.spyOn(calendars, "setSpaces");

      await assignCalendarSpaces(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: calendar.id,
        spaceIds: [main.id],
      });

      expect(setSpacesSpy).toHaveBeenCalledWith({
        calendarId: calendar.id,
        spaceIds: [main.id],
        primarySpaceId: main.id,
      });
    });

    it("skips a RETIRED leading id when repointing (a retired join may ride along)", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const ghost = spaces.seed({
        placeId: PLACE_ID,
        name: "Demolished Annex",
        status: "RETIRED",
        sortOrder: 0,
      });
      const live = spaces.seed({
        placeId: PLACE_ID,
        name: "Cellar",
        sortOrder: 1,
      });
      const calendar = calendars.seedCalendar({
        placeId: PLACE_ID,
        primarySpaceId: live.id,
      });

      await assignCalendarSpaces(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: calendar.id,
        spaceIds: [ghost.id, live.id],
      });

      expect(calendars.calendars.get(calendar.id)!.primarySpaceId).toBe(
        live.id,
      );
      expect(calendars.joins.get(calendar.id)).toEqual([ghost.id, live.id]);
    });

    it("ACCEPTS a retired space alongside an active one (history joins still assignable)", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
      const ghost = spaces.seed({
        placeId: PLACE_ID,
        name: "Demolished Annex",
        status: "RETIRED",
      });
      const calendar = calendars.seedCalendar({ placeId: PLACE_ID });

      await assignCalendarSpaces(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: calendar.id,
        spaceIds: [main.id, ghost.id],
      });

      expect(calendars.joins.get(calendar.id)).toEqual([main.id, ghost.id]);
    });
  });

  describe("availability", () => {
    it("accepts a PLACE-WIDE row (calendarId null = all calendars)", async () => {
      const { deps } = buildDeps();

      const row = await upsertCalendarAvailability(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: null,
        date: new Date("2026-12-24T00:00:00.000Z"),
        isOpen: false,
        note: "closed for the holidays",
      });

      expect(row.calendarId).toBeNull();
      expect(row.isOpen).toBe(false);
    });

    it("asserts the scoping calendar belongs to the place", async () => {
      const { deps, calendars } = buildDeps();
      const foreign = calendars.seedCalendar({ placeId: OTHER_PLACE_ID });

      await expect(
        upsertCalendarAvailability(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          calendarId: foreign.id,
          dayOfWeek: 5,
          startTime: "19:00",
          endTime: "23:00",
          isOpen: true,
        }),
      ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
      expect(calendars.availability.size).toBe(0);
    });

    it("enforces dayOfWeek XOR date", async () => {
      const { deps } = buildDeps();

      // Neither → reject.
      await expect(
        upsertCalendarAvailability(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          isOpen: true,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      // Both → reject.
      await expect(
        upsertCalendarAvailability(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          dayOfWeek: 5,
          date: new Date("2026-12-24T00:00:00.000Z"),
          isOpen: true,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      // Exactly one → ok (recurring weekday window).
      const weekly = await upsertCalendarAvailability(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        dayOfWeek: 5,
        startTime: "19:00",
        endTime: "23:00",
        isOpen: true,
      });
      expect(weekly.dayOfWeek).toBe(5);
      expect(weekly.date).toBeNull();
    });

    it("rejects an update whose row id belongs to another place", async () => {
      const { deps, calendars } = buildDeps();
      const foreignRow = calendars.seedAvailability({
        placeId: OTHER_PLACE_ID,
        dayOfWeek: 5,
      });

      await expect(
        upsertCalendarAvailability(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          id: foreignRow.id,
          dayOfWeek: 6,
          isOpen: true,
        }),
      ).rejects.toMatchObject({ code: "AVAILABILITY_NOT_FOUND" });
      expect(calendars.availability.get(foreignRow.id)?.dayOfWeek).toBe(5);
    });

    it("keeps a row's calendar scope immutable on update", async () => {
      const { deps, calendars } = buildDeps();
      const calendar = calendars.seedCalendar({ placeId: PLACE_ID });
      const placeWideRow = calendars.seedAvailability({
        placeId: PLACE_ID,
        calendarId: null,
        dayOfWeek: 5,
      });

      // Attempt to re-scope a place-wide row onto one calendar.
      await expect(
        upsertCalendarAvailability(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          id: placeWideRow.id,
          calendarId: calendar.id,
          dayOfWeek: 5,
          isOpen: true,
        }),
      ).rejects.toMatchObject({ code: "AVAILABILITY_NOT_FOUND" });
    });

    it("REQUIRES isOpen — omitting it is invalid_input, never a silent default (full-PUT)", async () => {
      const { deps, calendars } = buildDeps();
      // The landmine the required field kills: a Christmas blackout…
      const blackout = calendars.seedAvailability({
        placeId: PLACE_ID,
        calendarId: null,
        date: new Date("2026-12-24T00:00:00.000Z"),
        isOpen: false,
        note: "closed for the holidays",
      });

      // …whose note is edited WITHOUT isOpen. With the old `.default(true)`
      // this parsed fine and silently reopened every calendar on that date.
      await expect(
        upsertCalendarAvailability(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          id: blackout.id,
          date: new Date("2026-12-24T00:00:00.000Z"),
          note: "closed — staff party",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      // The blackout survives untouched.
      expect(calendars.availability.get(blackout.id)?.isOpen).toBe(false);
      expect(calendars.availability.get(blackout.id)?.note).toBe(
        "closed for the holidays",
      );

      // Creates must state it too.
      await expect(
        upsertCalendarAvailability(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          dayOfWeek: 5,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("lists scoped AND place-wide rows in one merged read", async () => {
      const { deps, calendars } = buildDeps();
      const calendar = calendars.seedCalendar({ placeId: PLACE_ID });
      calendars.seedAvailability({
        placeId: PLACE_ID,
        calendarId: calendar.id,
        dayOfWeek: 5,
      });
      calendars.seedAvailability({
        placeId: PLACE_ID,
        calendarId: null,
        date: new Date("2026-12-24T00:00:00.000Z"),
        isOpen: false,
      });
      calendars.seedAvailability({
        placeId: OTHER_PLACE_ID,
        dayOfWeek: 1,
      });

      const rows = await listCalendarAvailability(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
      });

      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.calendarId))).toEqual(
        new Set([calendar.id, null]),
      );
    });

    it("deletes an own row and silently no-ops on a foreign row id", async () => {
      const { deps, calendars } = buildDeps();
      const own = calendars.seedAvailability({
        placeId: PLACE_ID,
        dayOfWeek: 5,
      });
      const foreign = calendars.seedAvailability({
        placeId: OTHER_PLACE_ID,
        dayOfWeek: 5,
      });

      await deleteCalendarAvailability(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        id: own.id,
      });
      const result = await deleteCalendarAvailability(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        id: foreign.id,
      });

      expect(result).toEqual({ deleted: true });
      expect(calendars.availability.has(own.id)).toBe(false);
      // The foreign place's row is untouched — the placeId-scoped WHERE is
      // the IDOR backstop.
      expect(calendars.availability.has(foreign.id)).toBe(true);
    });
  });

  describe("listCalendars", () => {
    it("is owner-gated and returns calendars with their spaces", async () => {
      const { deps, spaces, calendars } = buildDeps();
      const main = spaces.seed({ placeId: PLACE_ID, name: "Main" });
      const calendar = calendars.seedCalendar({
        placeId: PLACE_ID,
        name: "Main Calendar",
        isDefault: true,
      });
      calendars.seedJoins(calendar.id, [main.id]);

      const result = await listCalendars(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.spaces.map((r) => r.id)).toEqual([main.id]);

      await expect(
        listCalendars(deps, {
          actorHumanId: STRANGER_HUMAN_ID,
          placeId: PLACE_ID,
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking config layer (venue-confirmation spec, docs/specs/2026-08-27):
// intent toggles + rental rate on create/update. `rentalMode` is never
// accepted from input (INSTANT is reserved for its own spec).
// ─────────────────────────────────────────────────────────────────────────────

describe("manage calendars — booking config (venue-confirmation spec)", () => {
  it("createCalendar passes the given config through and leaves omitted fields to the DB defaults", async () => {
    const { deps, calendars, mainSpace } = buildDeps();
    const createSpy = vi.spyOn(calendars, "create");
    const created = await createCalendar(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceIds: [mainSpace.id],
      name: "Rentals",
      acceptsRent: true,
      acceptsUse: true,
      rentalRateCents: 25_000,
      rentalRateCurrency: "USD",
      rentalRateVisible: true,
    });
    expect(created).toMatchObject({
      acceptsPerform: true,
      acceptsRent: true,
      acceptsUse: true,
      rentalRateCents: 25_000,
      rentalRateCurrency: "USD",
      rentalRateVisible: true,
      rentalMode: "REQUEST",
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptsRent: true,
        acceptsUse: true,
        rentalRateCents: 25_000,
        rentalRateCurrency: "USD",
        rentalRateVisible: true,
      }),
    );
    // Omitted keys are NOT sent (the DB owns the defaults).
    const sent = createSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect("acceptsPerform" in sent).toBe(false);
    expect("rentalMode" in sent).toBe(false);

    const plain = await createCalendar(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceIds: [mainSpace.id],
      name: "Plain",
    });
    expect(plain).toMatchObject({ acceptsPerform: true, acceptsRent: false, acceptsUse: false, rentalRateCents: null });
  });

  it("createCalendar rejects rentalMode, a negative/fractional rate, and a non-ISO currency at the boundary", async () => {
    const { deps, calendars, mainSpace } = buildDeps();
    const createSpy = vi.spyOn(calendars, "create");
    const base = { actorHumanId: OWNER_HUMAN_ID, placeId: PLACE_ID, spaceIds: [mainSpace.id], name: "Bad" };
    for (const bad of [
      { rentalMode: "INSTANT" },
      { rentalMode: "REQUEST" },
      { rentalRateCents: -1 },
      { rentalRateCents: 10.5 },
      { rentalRateCurrency: "usd" },
      { rentalRateCurrency: "DOLLARS" },
    ]) {
      await expect(createCalendar(deps, { ...base, ...bad })).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("updateCalendar patches the config fields, accepts nulls to clear the rate, and refuses rentalMode", async () => {
    const { deps, calendars, mainSpace } = buildDeps();
    const updateSpy = vi.spyOn(calendars, "update");
    const created = await createCalendar(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceIds: [mainSpace.id],
      name: "Rentals",
      acceptsRent: true,
      rentalRateCents: 25_000,
      rentalRateCurrency: "USD",
    });

    const updated = await updateCalendar(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      calendarId: created.id,
      patch: { acceptsPerform: false, acceptsUse: true, rentalRateVisible: true },
    });
    expect(updated).toMatchObject({
      acceptsPerform: false,
      acceptsRent: true,
      acceptsUse: true,
      rentalRateCents: 25_000,
      rentalRateCurrency: "USD",
      rentalRateVisible: true,
      rentalMode: "REQUEST",
    });

    const cleared = await updateCalendar(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      calendarId: created.id,
      patch: { rentalRateCents: null, rentalRateCurrency: null },
    });
    expect(cleared).toMatchObject({ rentalRateCents: null, rentalRateCurrency: null, acceptsRent: true });

    await expect(
      updateCalendar(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: created.id,
        patch: { rentalMode: "INSTANT" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });
});

describe("manage calendars — rental rate is a PAIR (amount + currency)", () => {
  it("create: one without the other is invalid_input; both, or neither, is fine", async () => {
    const { deps, mainSpace } = buildDeps();
    const base = { actorHumanId: OWNER_HUMAN_ID, placeId: PLACE_ID, spaceIds: [mainSpace.id], name: "Rate" };
    await expect(createCalendar(deps, { ...base, rentalRateCents: 5000 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createCalendar(deps, { ...base, rentalRateCurrency: "USD" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createCalendar(deps, { ...base, rentalRateCents: 5000, rentalRateCurrency: null })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(createCalendar(deps, { ...base, rentalRateCents: null, rentalRateCurrency: null })).resolves.toMatchObject({
      rentalRateCents: null,
      rentalRateCurrency: null,
    });
    await expect(createCalendar(deps, { ...base, name: "Rate 2", rentalRateCents: 0, rentalRateCurrency: "EUR" })).resolves.toMatchObject({
      rentalRateCents: 0,
      rentalRateCurrency: "EUR",
    });
  });

  it("update: a patch carrying one half must carry the other; clearing both is fine", async () => {
    const { deps, mainSpace } = buildDeps();
    const created = await createCalendar(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      spaceIds: [mainSpace.id],
      name: "Rate",
      rentalRateCents: 5000,
      rentalRateCurrency: "USD",
    });
    const patch = (p: Record<string, unknown>) =>
      updateCalendar(deps, { actorHumanId: OWNER_HUMAN_ID, placeId: PLACE_ID, calendarId: created.id, patch: p });
    await expect(patch({ rentalRateCents: 7000 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(patch({ rentalRateCurrency: "EUR" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(patch({ rentalRateCents: null })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(patch({ rentalRateCents: 7000, rentalRateCurrency: "EUR" })).resolves.toMatchObject({
      rentalRateCents: 7000,
      rentalRateCurrency: "EUR",
    });
    await expect(patch({ rentalRateCents: null, rentalRateCurrency: null })).resolves.toMatchObject({
      rentalRateCents: null,
      rentalRateCurrency: null,
    });
    // A patch with neither touches nothing about the rate.
    await expect(patch({ acceptsUse: true })).resolves.toMatchObject({ rentalRateCents: null, acceptsUse: true });
  });
});
