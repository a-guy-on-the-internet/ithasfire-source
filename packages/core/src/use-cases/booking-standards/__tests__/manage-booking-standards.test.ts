import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import { createFakeBookingStandards } from "@th/test-utils/fakes/booking-standards";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

import { updateCalendar } from "../../places/manage-calendars";
import {
  getBookingStandardsForEditing,
  setCalendarBookingStandards,
  setCalendarPitchExamples,
  setPlaceBookingStandards,
  setPlacePitchExamples,
  type ManageBookingStandardsDeps,
} from "../manage-booking-standards";
import { BOOKING_STANDARD_ITEMS_MAX } from "../standard-fields";

// ─────────────────────────────────────────────────────────────────────────────
// Authoring booking standards (venue-booking-standards spec, FR-007). Pinned:
// the calendar editor's authz (same gate, same refusal), cross-place
// isolation, the calendar-accepts-the-intent check, validation through the S1
// schemas, the audit row, and that writes are NOT degraded.
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_ID = "00000000-0000-4000-8000-00000000c001";
const OTHER_PLACE_ID = "00000000-0000-4000-8000-00000000c002";
const OWNER_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const STRANGER_HUMAN_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-25T12:00:00.000Z");

function buildDeps(options: { membershipRole?: string | null } = {}) {
  const spaces = createFakeSpacesRepo();
  const calendars = createFakeCalendarsRepo({ spaces });
  const bookingStandards = createFakeBookingStandards();
  const audit = { log: vi.fn(async () => undefined) };
  const authz = {
    getPlaceAccessContext: vi.fn(async (placeId: string) =>
      placeId === PLACE_ID || placeId === OTHER_PLACE_ID
        ? { owningOrgIds: [ORG_ID], verifiedHumanOwnerIds: [OWNER_HUMAN_ID] }
        : null,
    ),
    getOrgMembership: vi.fn(async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
      options.membershipRole ? { orgId, humanId, role: options.membershipRole } : null,
    ),
  };

  const txRepos = { spaces, calendars, bookingStandards, audit, authz } as unknown as TxRepos;
  const tx = vi.fn(async (fn: (bag: TxRepos) => Promise<unknown>) => fn(txRepos));
  const repos = { ...txRepos, tx } as unknown as ManageBookingStandardsDeps["repos"];
  const deps: ManageBookingStandardsDeps = { repos, clock: { now: () => NOW } };

  const main = calendars.seedCalendar({
    placeId: PLACE_ID,
    name: "Main Stage",
    isDefault: true,
    acceptsPerform: true,
    acceptsRent: true,
    rentalMode: "REQUEST",
  });
  const bar = calendars.seedCalendar({
    placeId: PLACE_ID,
    name: "Back Bar",
    acceptsPerform: true,
  });
  const foreign = calendars.seedCalendar({ placeId: OTHER_PLACE_ID, name: "Elsewhere" });

  return { deps, bookingStandards, audit, authz, tx, main, bar, foreign };
}

const musicRequired = {
  field: "LINK_MUSIC",
  label: "  A <b>music</b> link  ",
  hint: "Bandcamp or Spotify is fine",
  requirement: "REQUIRED",
};
const drawSuggested = { field: "EXPECTED_DRAW", label: "Your usual draw", requirement: "SUGGESTED" };

describe("setCalendarBookingStandards", () => {
  it("writes the calendar's list for the intent (sanitized, ordered) and audits it on the calendar", async () => {
    const { deps, bookingStandards, audit, main } = buildDeps();

    const out = await setCalendarBookingStandards(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      calendarId: main.id,
      intent: "PERFORM",
      items: [musicRequired, drawSuggested],
    });

    expect(out).toEqual({
      intent: "PERFORM",
      items: [
        {
          field: "LINK_MUSIC",
          label: "A music link",
          hint: "Bandcamp or Spotify is fine",
          requirement: "REQUIRED",
          sortOrder: 0,
        },
        {
          field: "EXPECTED_DRAW",
          label: "Your usual draw",
          hint: null,
          requirement: "SUGGESTED",
          sortOrder: 1,
        },
      ],
    });
    const stored = await bookingStandards.listForOwners({
      owners: [{ ownerType: "CALENDAR", ownerId: main.id }],
    });
    expect(stored.items.map((row) => row.field)).toEqual(["LINK_MUSIC", "EXPECTED_DRAW"]);
    expect(audit.log).toHaveBeenCalledWith({
      entity: "calendar",
      entityId: main.id,
      action: "booking_standards_updated",
      data: expect.objectContaining({
        placeId: PLACE_ID,
        actorHumanId: OWNER_HUMAN_ID,
        intent: "PERFORM",
      }),
      at: NOW,
    });
  });

  it("an org EDIT-role member may write (the calendar editor's rule)", async () => {
    const { deps, main } = buildDeps({ membershipRole: "EDITOR" });

    await expect(
      setCalendarBookingStandards(deps, {
        actorHumanId: STRANGER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: main.id,
        intent: "PERFORM",
        items: [drawSuggested],
      }),
    ).resolves.toMatchObject({ items: [expect.objectContaining({ field: "EXPECTED_DRAW" })] });
  });

  it("a non-editor is refused with EXACTLY the calendar editor's error, before anything is read or written", async () => {
    const { deps, bookingStandards, tx, main } = buildDeps({ membershipRole: "VIEWER" });

    const calendarEditorError = await updateCalendar(
      { repos: deps.repos, clock: deps.clock } as Parameters<typeof updateCalendar>[0],
      {
        actorHumanId: STRANGER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: main.id,
        patch: { name: "Hijacked" },
      },
    ).catch((err: unknown) => err);
    const standardsError = await setCalendarBookingStandards(deps, {
      actorHumanId: STRANGER_HUMAN_ID,
      placeId: PLACE_ID,
      calendarId: main.id,
      intent: "PERFORM",
      items: [drawSuggested],
    }).catch((err: unknown) => err);

    expect(calendarEditorError).toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "place" },
    });
    expect(standardsError).toMatchObject({
      code: (calendarEditorError as { code: string }).code,
      meta: (calendarEditorError as { meta: unknown }).meta,
    });
    expect(tx).not.toHaveBeenCalled();
    expect(bookingStandards.items.size).toBe(0);
  });

  it("a calendar of ANOTHER place is CALENDAR_NOT_FOUND and nothing is written", async () => {
    const { deps, bookingStandards, foreign } = buildDeps();

    await expect(
      setCalendarBookingStandards(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: foreign.id,
        intent: "PERFORM",
        items: [drawSuggested],
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
    expect(bookingStandards.items.size).toBe(0);
  });

  it("an intent the calendar does not take requests for is a clear BAD_REQUEST (calendar_rejects_intent)", async () => {
    const { deps, bookingStandards, bar } = buildDeps();

    await expect(
      setCalendarBookingStandards(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: bar.id,
        intent: "RENT",
        items: [{ field: "EXPECTED_ATTENDANCE", label: "Headcount", requirement: "REQUIRED" }],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "calendar_rejects_intent",
      meta: { calendarId: bar.id, intent: "RENT" },
    });
    expect(bookingStandards.items.size).toBe(0);
  });

  it("`[]` clears the calendar's list (it falls back to the venue default)", async () => {
    const { deps, bookingStandards, main } = buildDeps();
    const base = {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      calendarId: main.id,
      intent: "PERFORM",
    };
    await setCalendarBookingStandards(deps, { ...base, items: [drawSuggested] });

    const out = await setCalendarBookingStandards(deps, { ...base, items: [] });

    expect(out.items).toEqual([]);
    expect(bookingStandards.items.size).toBe(0);
  });

  describe("validation (S1 schemas + the intent refine)", () => {
    const cases: [string, Record<string, unknown>[]][] = [
      ["a CUSTOM item marked REQUIRED (D2a)", [{ field: "CUSTOM", label: "Stage plot", requirement: "REQUIRED" }]],
      ["a schema-mandatory field marked REQUIRED (D2b)", [{ field: "MESSAGE", label: "A message", requirement: "REQUIRED" }]],
      ["a field the intent's form does not have", [{ field: "PURPOSE", label: "What is it", requirement: "SUGGESTED" }]],
      ["a link in a label (NFR-001)", [{ field: "LINK_MUSIC", label: "see bandcamp.com", requirement: "SUGGESTED" }]],
      ["the same known field twice", [drawSuggested, { ...drawSuggested, label: "Draw again" }]],
      [
        `more than ${BOOKING_STANDARD_ITEMS_MAX} items`,
        Array.from({ length: BOOKING_STANDARD_ITEMS_MAX + 1 }, (_, i) => ({
          field: "CUSTOM",
          label: `Line ${i}`,
          requirement: "SUGGESTED",
        })),
      ],
    ];

    it.each(cases)("refuses %s as invalid_input, writing nothing", async (_name, items) => {
      const { deps, bookingStandards, tx, main } = buildDeps();

      await expect(
        setCalendarBookingStandards(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          calendarId: main.id,
          intent: "PERFORM",
          items,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(tx).not.toHaveBeenCalled();
      expect(bookingStandards.items.size).toBe(0);
    });

    it("refuses unknown keys (strict)", async () => {
      const { deps, main } = buildDeps();

      await expect(
        setCalendarBookingStandards(deps, {
          actorHumanId: OWNER_HUMAN_ID,
          placeId: PLACE_ID,
          calendarId: main.id,
          intent: "PERFORM",
          items: [],
          ownerType: "PLACE",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  it("is NOT degraded: a storage failure fails the write loudly", async () => {
    const { deps, bookingStandards, main } = buildDeps();
    vi.spyOn(bookingStandards, "replaceItems").mockRejectedValueOnce(
      new Error('relation "BookingStandardItem" does not exist'),
    );

    await expect(
      setCalendarBookingStandards(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: main.id,
        intent: "PERFORM",
        items: [drawSuggested],
      }),
    ).rejects.toThrow("does not exist");
  });
});

describe("setCalendarPitchExamples", () => {
  it("writes the calendar's examples and audits them", async () => {
    const { deps, audit, main } = buildDeps();

    const out = await setCalendarPitchExamples(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      calendarId: main.id,
      intent: "PERFORM",
      examples: [{ title: "A good pitch", body: "Line one\nLine two" }],
    });

    expect(out).toEqual({
      intent: "PERFORM",
      examples: [{ title: "A good pitch", body: "Line one\nLine two", sortOrder: 0 }],
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "calendar",
        entityId: main.id,
        action: "pitch_examples_updated",
      }),
    );
  });

  it("refuses more than three examples", async () => {
    const { deps, main } = buildDeps();

    await expect(
      setCalendarPitchExamples(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: main.id,
        intent: "PERFORM",
        examples: Array.from({ length: 4 }, (_, i) => ({ title: `T${i}`, body: "B" })),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a non-editor with the calendar editor's error", async () => {
    const { deps, main } = buildDeps();

    await expect(
      setCalendarPitchExamples(deps, {
        actorHumanId: STRANGER_HUMAN_ID,
        placeId: PLACE_ID,
        calendarId: main.id,
        intent: "PERFORM",
        examples: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });
});

describe("setPlaceBookingStandards / setPlacePitchExamples", () => {
  it("writes the PLACE default (any intent — no calendar check) and audits it on the place", async () => {
    const { deps, bookingStandards, audit } = buildDeps();

    await setPlaceBookingStandards(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      intent: "USE",
      items: [{ field: "EXPECTED_ATTENDANCE", label: "Headcount", requirement: "REQUIRED" }],
    });
    await setPlacePitchExamples(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      intent: "USE",
      examples: [{ title: "Book club", body: "Twelve of us, Tuesday evenings." }],
    });

    const stored = await bookingStandards.listForOwners({
      owners: [{ ownerType: "PLACE", ownerId: PLACE_ID }],
    });
    expect(stored.items).toEqual([
      expect.objectContaining({ intent: "USE", field: "EXPECTED_ATTENDANCE", requirement: "REQUIRED" }),
    ]);
    expect(stored.examples).toEqual([expect.objectContaining({ intent: "USE", title: "Book club" })]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "place", entityId: PLACE_ID, action: "booking_standards_updated" }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "place", entityId: PLACE_ID, action: "pitch_examples_updated" }),
    );
  });

  it("refuses a non-editor with the calendar editor's error", async () => {
    const { deps, bookingStandards } = buildDeps();

    await expect(
      setPlaceBookingStandards(deps, {
        actorHumanId: STRANGER_HUMAN_ID,
        placeId: PLACE_ID,
        intent: "PERFORM",
        items: [drawSuggested],
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER", meta: { entity: "place" } });
    await expect(
      setPlacePitchExamples(deps, {
        actorHumanId: STRANGER_HUMAN_ID,
        placeId: PLACE_ID,
        intent: "PERFORM",
        examples: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(bookingStandards.items.size).toBe(0);
  });

  it("an unknown place is PLACE_NOT_FOUND", async () => {
    const { deps } = buildDeps();

    await expect(
      setPlaceBookingStandards(deps, {
        actorHumanId: OWNER_HUMAN_ID,
        placeId: "00000000-0000-4000-8000-00000000ffff",
        intent: "PERFORM",
        items: [],
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });
});

describe("getBookingStandardsForEditing", () => {
  it("per owner per intent: the owner's RAW rows plus what a requester sees there", async () => {
    const { deps, main, bar } = buildDeps();
    await setPlaceBookingStandards(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      intent: "PERFORM",
      items: [musicRequired],
    });
    await setCalendarBookingStandards(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
      calendarId: bar.id,
      intent: "PERFORM",
      items: [drawSuggested],
    });

    const out = await getBookingStandardsForEditing(deps, {
      actorHumanId: OWNER_HUMAN_ID,
      placeId: PLACE_ID,
    });

    // The place default, every intent.
    expect(Object.keys(out.place)).toEqual(["PERFORM", "RENT", "USE"]);
    expect(out.place.PERFORM.items).toEqual([
      expect.objectContaining({ field: "LINK_MUSIC", label: "A music link", requirement: "REQUIRED" }),
    ]);
    expect(out.place.PERFORM.effective.standards).toEqual([
      expect.objectContaining({ source: "place", field: "LINK_MUSIC" }),
    ]);
    expect(out.place.RENT.items).toEqual([]);
    expect(out.place.RENT.effective.standards.every((s) => s.source === "platform")).toBe(true);

    // Main has no rows: nothing of its own, and it SHOWS the venue default.
    const mainOut = out.calendars.find((c) => c.id === main.id)!;
    expect(mainOut.intents).toEqual(["PERFORM", "RENT"]);
    expect(mainOut.standards.PERFORM!.items).toEqual([]);
    expect(mainOut.standards.PERFORM!.effective.standards).toEqual([
      expect.objectContaining({ source: "place", field: "LINK_MUSIC", label: "A music link" }),
    ]);
    expect(mainOut.standards.USE).toBeUndefined();

    // Bar overrides with its own.
    const barOut = out.calendars.find((c) => c.id === bar.id)!;
    expect(barOut.standards.PERFORM!.items).toEqual([
      expect.objectContaining({ field: "EXPECTED_DRAW", label: "Your usual draw" }),
    ]);
    expect(barOut.standards.PERFORM!.effective.standards).toEqual([
      expect.objectContaining({ source: "calendar", field: "EXPECTED_DRAW" }),
    ]);

    // No other place's calendar leaks in.
    expect(out.calendars.map((c) => c.name).sort()).toEqual(["Back Bar", "Main Stage"]);
  });

  it("refuses a non-editor with the calendar editor's error", async () => {
    const { deps } = buildDeps();

    await expect(
      getBookingStandardsForEditing(deps, { actorHumanId: STRANGER_HUMAN_ID, placeId: PLACE_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER", meta: { entity: "place" } });
  });
});
