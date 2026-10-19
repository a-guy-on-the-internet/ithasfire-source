import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import { createFakeBookingStandards } from "@th/test-utils/fakes/booking-standards";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

import type { Ctx } from "../../context";
import { placesRouter } from "../places";
import { createCaller } from "./test-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Transport coverage for the booking-standards procedures (venue-booking-
// standards spec, FR-007): the four replace-all writes and the editor read.
// Pinned: the actor is injected from ctx (a smuggled one is refused), a
// non-editor gets the calendar editor's FORBIDDEN, validation is a
// BAD_REQUEST, an anonymous caller is UNAUTHORIZED, and the writes carry a
// per-actor rate limit.
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_ID = "00000000-0000-4000-8000-00000000b501";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const STRANGER_ID = "33333333-3333-4333-8333-333333333333";

function buildWorld() {
  const spaces = createFakeSpacesRepo();
  const calendars = createFakeCalendarsRepo({ spaces });
  const bookingStandards = createFakeBookingStandards();
  const calendar = calendars.seedCalendar({
    placeId: PLACE_ID,
    name: "Main",
    isDefault: true,
    acceptsPerform: true,
  });
  const audit = { log: vi.fn(async () => undefined) };
  const authz = {
    getPlaceAccessContext: vi.fn(async () => ({
      owningOrgIds: [],
      verifiedHumanOwnerIds: [OWNER_ID],
    })),
    getOrgMembership: vi.fn(async () => null),
  };
  const txRepos = { calendars, spaces, bookingStandards, audit, authz } as unknown as TxRepos;
  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Ctx["repos"];
  return { repos, bookingStandards, audit, calendar };
}

function callerFor(
  repos: Ctx["repos"],
  actorHumanId: string | null,
  extra: Partial<Ctx> = {},
) {
  return createCaller({ places: placesRouter }, { repos, actorHumanId, ...extra }).caller;
}

const music = { field: "LINK_MUSIC", label: "A music link", requirement: "REQUIRED" };

describe("places booking-standards procedures", () => {
  it("setCalendarBookingStandards: writes as the ctx actor and returns the stored rows", async () => {
    const { repos, bookingStandards, audit, calendar } = buildWorld();

    const out = await callerFor(repos, OWNER_ID).places.setCalendarBookingStandards({
      placeId: PLACE_ID,
      calendarId: calendar.id,
      intent: "PERFORM",
      items: [music],
    });

    expect(out).toEqual({
      intent: "PERFORM",
      items: [
        { field: "LINK_MUSIC", label: "A music link", hint: null, requirement: "REQUIRED", sortOrder: 0 },
      ],
    });
    expect(bookingStandards.items.size).toBe(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "calendar",
        data: expect.objectContaining({ actorHumanId: OWNER_ID }),
      }),
    );
  });

  it("setCalendarPitchExamples / setBookingStandards / setPitchExamples: happy paths", async () => {
    const { repos, bookingStandards, calendar } = buildWorld();
    const caller = callerFor(repos, OWNER_ID);

    await expect(
      caller.places.setCalendarPitchExamples({
        placeId: PLACE_ID,
        calendarId: calendar.id,
        intent: "PERFORM",
        examples: [{ title: "Good pitch", body: "Hello" }],
      }),
    ).resolves.toEqual({
      intent: "PERFORM",
      examples: [{ title: "Good pitch", body: "Hello", sortOrder: 0 }],
    });
    await expect(
      caller.places.setBookingStandards({ placeId: PLACE_ID, intent: "PERFORM", items: [music] }),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ field: "LINK_MUSIC" })] });
    await expect(
      caller.places.setPitchExamples({
        placeId: PLACE_ID,
        intent: "RENT",
        examples: [{ title: "Party", body: "Forty guests" }],
      }),
    ).resolves.toMatchObject({ intent: "RENT" });

    expect(bookingStandards.items.size).toBe(1);
    expect(bookingStandards.examples.size).toBe(2);
  });

  it("getBookingStandardsForEditing: raw rows + the effective list per owner", async () => {
    const { repos, calendar } = buildWorld();
    const caller = callerFor(repos, OWNER_ID);
    await caller.places.setBookingStandards({ placeId: PLACE_ID, intent: "PERFORM", items: [music] });

    const out = await caller.places.getBookingStandardsForEditing({ placeId: PLACE_ID });

    expect(out.place.PERFORM.items).toHaveLength(1);
    const main = out.calendars.find((c: { id: string }) => c.id === calendar.id);
    expect(main.standards.PERFORM.items).toEqual([]);
    expect(main.standards.PERFORM.effective.standards).toEqual([
      expect.objectContaining({ source: "place", field: "LINK_MUSIC", label: "A music link" }),
    ]);
  });

  it("a non-editor is FORBIDDEN (NOT_RESOURCE_OWNER) on every procedure, and nothing is written", async () => {
    const { repos, bookingStandards, calendar } = buildWorld();
    const caller = callerFor(repos, STRANGER_ID);

    const calls = [
      caller.places.setCalendarBookingStandards({
        placeId: PLACE_ID,
        calendarId: calendar.id,
        intent: "PERFORM",
        items: [music],
      }),
      caller.places.setCalendarPitchExamples({
        placeId: PLACE_ID,
        calendarId: calendar.id,
        intent: "PERFORM",
        examples: [],
      }),
      caller.places.setBookingStandards({ placeId: PLACE_ID, intent: "PERFORM", items: [music] }),
      caller.places.setPitchExamples({ placeId: PLACE_ID, intent: "PERFORM", examples: [] }),
      caller.places.getBookingStandardsForEditing({ placeId: PLACE_ID }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(bookingStandards.items.size).toBe(0);
    expect(bookingStandards.examples.size).toBe(0);
  });

  it("an anonymous caller is UNAUTHORIZED", async () => {
    const { repos } = buildWorld();

    await expect(
      callerFor(repos, null, { auth: null, authToken: null }).places.setBookingStandards({
        placeId: PLACE_ID,
        intent: "PERFORM",
        items: [],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  describe("validation → BAD_REQUEST", () => {
    it("a REQUIRED custom item (D2a)", async () => {
      const { repos } = buildWorld();
      await expect(
        callerFor(repos, OWNER_ID).places.setBookingStandards({
          placeId: PLACE_ID,
          intent: "PERFORM",
          items: [{ field: "CUSTOM", label: "Stage plot", requirement: "REQUIRED" }],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("a field not on the intent's form is refused at the procedure input, pathed to the row", async () => {
      const { repos, calendar } = buildWorld();
      const err = await callerFor(repos, OWNER_ID)
        .places.setCalendarBookingStandards({
          placeId: PLACE_ID,
          calendarId: calendar.id,
          intent: "PERFORM",
          items: [{ field: "PURPOSE", label: "What is it", requirement: "SUGGESTED" }],
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "BAD_REQUEST" });
      // The procedure-input refine (not the use case's bare invalid_input):
      // the issue carries the row's path, so the editor can mark the row.
      const issues = (err as { cause?: { issues?: unknown[] } }).cause?.issues;
      expect(issues).toEqual([
        expect.objectContaining({
          message: "booking_standard_field_not_for_intent",
          path: ["items", 0, "field"],
        }),
      ]);
    });

    it("an intent the calendar does not take (use-case refusal, still BAD_REQUEST)", async () => {
      const { repos, calendar } = buildWorld();
      await expect(
        callerFor(repos, OWNER_ID).places.setCalendarBookingStandards({
          placeId: PLACE_ID,
          calendarId: calendar.id,
          intent: "USE",
          items: [],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "calendar_rejects_intent" });
    });

    it("a smuggled actorHumanId (strict input)", async () => {
      const { repos } = buildWorld();
      await expect(
        callerFor(repos, STRANGER_ID).places.setBookingStandards({
          placeId: PLACE_ID,
          intent: "PERFORM",
          items: [],
          actorHumanId: OWNER_ID,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        callerFor(repos, STRANGER_ID).places.setCalendarBookingStandards({
          placeId: PLACE_ID,
          calendarId: "ca1e0da1-1111-4111-8111-111111111111",
          intent: "PERFORM",
          items: [],
          actorHumanId: OWNER_ID,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  it("the writes are rate-limited per actor", async () => {
    const { repos } = buildWorld();
    const key = `places:bookingStandards:write:${OWNER_ID}`;
    // Deny ONLY the procedure's own bucket — the authedProcedure floor passes.
    const consume = vi.fn(async (bucket: string) =>
      bucket === key
        ? { allowed: false, remaining: 0, retryAfterSeconds: 42 }
        : { allowed: true, remaining: 100, retryAfterSeconds: 0 },
    );
    const caller = callerFor(repos, OWNER_ID, {
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });

    await expect(
      caller.places.setBookingStandards({ placeId: PLACE_ID, intent: "PERFORM", items: [] }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(consume).toHaveBeenCalledWith(key, 30, 60);
    expect(repos.tx).not.toHaveBeenCalled();
  });
});
