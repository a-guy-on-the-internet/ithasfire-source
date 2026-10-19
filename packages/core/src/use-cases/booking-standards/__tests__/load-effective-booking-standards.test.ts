import { describe, expect, it, vi } from "vitest";

import { createFakeBookingStandards } from "@th/test-utils/fakes/booking-standards";

import {
  DROPPED_ITEMS_REPORT_DEDUPE_CAP,
  calendarRequestIntents,
  loadEffectiveBookingStandards,
  loadEffectiveBookingStandardsForCalendar,
  type LoadEffectiveBookingStandardsDeps,
  type LoadEffectiveBookingStandardsInput,
} from "../load-effective-booking-standards";
import { BOOKING_STANDARDS_PLATFORM_DEFAULTS } from "../platform-defaults";

// ─────────────────────────────────────────────────────────────────────────────
// The loader behind the options read and both create gates (venue-booking-
// standards spec, FR-003 / FR-004 / FR-006, NFR-002). Pinned here: ONE read,
// a failed read degrades to the platform defaults (logged + reported, never
// thrown), and a stale catalogue is reported once per load. The loader no
// longer knows about claimed vs unclaimed (FR-004 v1.1 / V8): an unclaimed
// venue takes no requests, so its callers refuse or offer nothing first.
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const CAL_A = "ca1e0da1-1111-4111-8111-111111111111";
const CAL_B = "ca1e0da1-2222-4222-8222-222222222222";
const OWNER = "11111111-1111-4111-8111-111111111111";

type Place = LoadEffectiveBookingStandardsInput["place"];

const CLAIMED: Place = {
  id: PLACE_ID,
  status: "ACTIVE",
  verificationStatus: "VERIFIED",
  humanIdsWithAccess: [OWNER],
  orgIdsWithAccess: [],
};

/** Nobody holds it (no verified, unrevoked ownership). */
const UNCLAIMED: Place = {
  ...CLAIMED,
  verificationStatus: "UNVERIFIED",
  humanIdsWithAccess: [],
};

function makeLogger() {
  return {
    child: vi.fn(),
    withTime: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

async function seededRepo() {
  const bookingStandards = createFakeBookingStandards();
  // Place default: a REQUIRED music link for PERFORM + a place example.
  await bookingStandards.replaceItems({
    ownerType: "PLACE",
    ownerId: PLACE_ID,
    intent: "PERFORM",
    items: [{ field: "LINK_MUSIC", label: "Send a music link", requirement: "REQUIRED" }],
  });
  await bookingStandards.replaceExamples({
    ownerType: "PLACE",
    ownerId: PLACE_ID,
    intent: "PERFORM",
    examples: [{ title: "Place example", body: "Place body" }],
  });
  // Calendar B overrides with its own list.
  await bookingStandards.replaceItems({
    ownerType: "CALENDAR",
    ownerId: CAL_B,
    intent: "PERFORM",
    items: [{ field: "EXPECTED_DRAW", label: "Your draw", requirement: "REQUIRED" }],
  });
  return bookingStandards;
}

function depsWith(
  bookingStandards: LoadEffectiveBookingStandardsDeps["repos"]["bookingStandards"],
  extra: Partial<LoadEffectiveBookingStandardsDeps> = {},
) {
  const logger = makeLogger();
  const reportError = vi.fn();
  const deps: LoadEffectiveBookingStandardsDeps = {
    repos: { bookingStandards },
    logger: logger as unknown as LoadEffectiveBookingStandardsDeps["logger"],
    reportError,
    ...extra,
  };
  return { deps, logger, reportError };
}

const platformPerform = BOOKING_STANDARDS_PLATFORM_DEFAULTS.PERFORM;

describe("loadEffectiveBookingStandards", () => {
  it("claimed place: calendar rows win, a calendar without rows inherits the place, examples are venue-first then platform — in ONE read", async () => {
    const bookingStandards = await seededRepo();
    const listSpy = vi.spyOn(bookingStandards, "listForOwners");
    const { deps, reportError, logger } = depsWith(bookingStandards);

    const out = await loadEffectiveBookingStandards(deps, {
      place: CLAIMED,
      targets: [
        { calendarId: CAL_A, intents: ["PERFORM", "RENT"] },
        { calendarId: CAL_B, intents: ["PERFORM"] },
      ],
    });

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith({
      owners: [
        { ownerType: "PLACE", ownerId: PLACE_ID },
        { ownerType: "CALENDAR", ownerId: CAL_A },
        { ownerType: "CALENDAR", ownerId: CAL_B },
      ],
    });
    expect(out.degraded).toBe(false);
    expect(out.targets.map((t) => t.calendarId)).toEqual([CAL_A, CAL_B]);

    const aPerform = out.targets[0]!.byIntent.PERFORM!;
    expect(aPerform.standards).toEqual([
      {
        source: "place",
        field: "LINK_MUSIC",
        requirement: "REQUIRED",
        label: "Send a music link",
        hint: null,
      },
    ]);
    expect(aPerform.examples[0]).toEqual({
      source: "place",
      title: "Place example",
      body: "Place body",
    });
    expect(aPerform.examples).toHaveLength(1 + platformPerform.examples.length);
    // RENT has no venue rows anywhere → platform.
    expect(out.targets[0]!.byIntent.RENT!.standards.every((s) => s.source === "platform")).toBe(true);
    // B's own list wins whole over the place's.
    expect(out.targets[1]!.byIntent.PERFORM!.standards).toEqual([
      expect.objectContaining({ source: "calendar", field: "EXPECTED_DRAW", label: "Your draw" }),
    ]);
    // Only the intents asked for are resolved.
    expect(out.targets[1]!.byIntent.RENT).toBeUndefined();

    expect(reportError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("narrows the read to the intent when every target asks for the same one", async () => {
    const bookingStandards = await seededRepo();
    const listSpy = vi.spyOn(bookingStandards, "listForOwners");
    const { deps } = depsWith(bookingStandards);

    await loadEffectiveBookingStandards(deps, {
      place: CLAIMED,
      targets: [{ calendarId: CAL_A, intents: ["PERFORM"] }],
    });

    expect(listSpy).toHaveBeenCalledWith({
      owners: [
        { ownerType: "PLACE", ownerId: PLACE_ID },
        { ownerType: "CALENDAR", ownerId: CAL_A },
      ],
      intent: "PERFORM",
    });
  });

  it("a null calendar (the place has none) resolves place → platform", async () => {
    const { deps } = depsWith(await seededRepo());

    const { effective, degraded } = await loadEffectiveBookingStandardsForCalendar(deps, {
      place: CLAIMED,
      calendarId: null,
      intent: "PERFORM",
    });

    expect(degraded).toBe(false);
    expect(effective.standards).toEqual([
      expect.objectContaining({ source: "place", field: "LINK_MUSIC", requirement: "REQUIRED" }),
    ]);
  });

  it("the parked branch is GONE (FR-004 v1.1 / V8): the loader resolves an unclaimed place like any other — its callers keep it from being asked", async () => {
    // No reader gets here for an unclaimed place any more: the pitch and the
    // embed refuse it first (PLACE_NOT_TAKING_REQUESTS), and the options read
    // asks for no intent. Pinned so the special case does not creep back.
    const bookingStandards = await seededRepo();
    const listSpy = vi.spyOn(bookingStandards, "listForOwners");
    const { deps } = depsWith(bookingStandards);

    await loadEffectiveBookingStandards(deps, {
      place: UNCLAIMED,
      targets: [{ calendarId: CAL_B, intents: ["PERFORM"] }],
    });

    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it("no intents requested: no read", async () => {
    const bookingStandards = await seededRepo();
    const listSpy = vi.spyOn(bookingStandards, "listForOwners");
    const { deps } = depsWith(bookingStandards);

    const out = await loadEffectiveBookingStandards(deps, {
      place: CLAIMED,
      targets: [{ calendarId: CAL_A, intents: [] }],
    });

    expect(listSpy).not.toHaveBeenCalled();
    expect(out.targets).toEqual([{ calendarId: CAL_A, byIntent: {} }]);
  });

  // ── Degrade (NFR-002 + the ReporterPort convention) ──────────────────────

  describe("when the read throws (e.g. the table is not migrated yet)", () => {
    const readFailure = new Error('relation "BookingStandardItem" does not exist');
    const throwingRepo = () => ({
      listForOwners: vi.fn(async () => {
        throw readFailure;
      }),
      replaceItems: vi.fn(),
      replaceExamples: vi.fn(),
    });

    it("degrades to the platform defaults for every target, logs at error and reports once", async () => {
      const { deps, logger, reportError } = depsWith(throwingRepo());

      const out = await loadEffectiveBookingStandards(deps, {
        place: CLAIMED,
        targets: [
          { calendarId: CAL_A, intents: ["PERFORM", "USE"] },
          { calendarId: CAL_B, intents: ["PERFORM"] },
        ],
      });

      expect(out.degraded).toBe(true);
      for (const target of out.targets) {
        for (const effective of Object.values(target.byIntent)) {
          expect(effective!.standards.every((s) => s.source === "platform")).toBe(true);
          expect(effective!.standards.every((s) => s.requirement === "SUGGESTED")).toBe(true);
        }
      }
      expect(Object.keys(out.targets[0]!.byIntent)).toEqual(["PERFORM", "USE"]);
      expect(logger.error).toHaveBeenCalledWith(
        "booking_standards.load_failed",
        expect.objectContaining({ placeId: PLACE_ID, err: readFailure }),
      );
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(readFailure, {
        tags: { useCase: "loadEffectiveBookingStandards" },
        extra: { placeId: PLACE_ID, calendarIds: [CAL_A, CAL_B] },
      });
    });

    it("still degrades when the reporter itself throws", async () => {
      const { deps } = depsWith(throwingRepo(), {
        reportError: vi.fn(() => {
          throw new Error("sentry down");
        }),
      });

      const out = await loadEffectiveBookingStandards(deps, {
        place: CLAIMED,
        targets: [{ calendarId: CAL_A, intents: ["PERFORM"] }],
      });

      expect(out.degraded).toBe(true);
    });

    it("still degrades with no reporter wired", async () => {
      const { deps } = depsWith(throwingRepo(), { reportError: undefined });

      const out = await loadEffectiveBookingStandards(deps, {
        place: CLAIMED,
        targets: [{ calendarId: CAL_A, intents: ["PERFORM"] }],
      });

      expect(out.degraded).toBe(true);
    });

    it("a repo bag without the port (a composition root that never wired it) degrades too", async () => {
      const { deps } = depsWith(
        undefined as unknown as LoadEffectiveBookingStandardsDeps["repos"]["bookingStandards"],
      );

      const out = await loadEffectiveBookingStandards(deps, {
        place: CLAIMED,
        targets: [{ calendarId: CAL_A, intents: ["PERFORM"] }],
      });

      expect(out.degraded).toBe(true);
    });
  });

  // ── Stale catalogue ──────────────────────────────────────────────────────

  describe("dropped items (stored rows the catalogue no longer applies)", () => {
    // The dedupe is module-level (per process), so every test here uses its
    // OWN place id — a shared one would be silently deduped by an earlier test.
    let placeSeq = 0;
    const freshPlace = (): Place => ({
      ...CLAIMED,
      id: `00000000-0000-4000-8000-${String(++placeSeq).padStart(12, "0")}`,
    });

    async function staleRepo() {
      const bookingStandards = createFakeBookingStandards();
      // PURPOSE is a RENT/USE field — on a PERFORM list it is stale data.
      await bookingStandards.replaceItems({
        ownerType: "CALENDAR",
        ownerId: CAL_A,
        intent: "PERFORM",
        items: [
          { field: "PURPOSE", label: "What is it", requirement: "SUGGESTED" },
          { field: "LINK_MUSIC", label: "Music", requirement: "REQUIRED" },
        ],
      });
      await bookingStandards.replaceItems({
        ownerType: "CALENDAR",
        ownerId: CAL_B,
        intent: "PERFORM",
        items: [{ field: "PURPOSE", label: "Also stale", requirement: "SUGGESTED" }],
      });
      return bookingStandards;
    }

    it("resolves anyway and reports ONCE per load, naming the first drop and listing all", async () => {
      const { deps, reportError, logger } = depsWith(await staleRepo());
      const place = freshPlace();

      const out = await loadEffectiveBookingStandards(deps, {
        place,
        targets: [
          { calendarId: CAL_A, intents: ["PERFORM"] },
          { calendarId: CAL_B, intents: ["PERFORM"] },
        ],
      });

      expect(out.degraded).toBe(false);
      // A keeps its applicable item; B was emptied → platform, never the place.
      expect(out.targets[0]!.byIntent.PERFORM!.standards).toEqual([
        expect.objectContaining({ source: "calendar", field: "LINK_MUSIC" }),
      ]);
      expect(
        out.targets[1]!.byIntent.PERFORM!.standards.every((s) => s.source === "platform"),
      ).toBe(true);

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "booking_standards_dropped_items" }),
        {
          tags: {
            useCase: "loadEffectiveBookingStandards",
            step: "dropped_items",
            severity: "warning",
          },
          extra: {
            placeId: place.id,
            calendarId: CAL_A,
            intent: "PERFORM",
            droppedCount: 1,
            drops: [
              { calendarId: CAL_A, intent: "PERFORM", droppedCount: 1 },
              { calendarId: CAL_B, intent: "PERFORM", droppedCount: 1 },
            ],
          },
        },
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "booking_standards.dropped_items",
        expect.objectContaining({ placeId: place.id }),
      );
    });

    it("a throwing reporter never fails the read", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });
      const { deps } = depsWith(await staleRepo(), { reportError });

      const out = await loadEffectiveBookingStandards(deps, {
        place: freshPlace(),
        targets: [{ calendarId: CAL_A, intents: ["PERFORM"] }],
      });

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(out.targets[0]!.byIntent.PERFORM!.standards).toHaveLength(1);
    });

    it("dedupes per place per process: two loads (two dialog opens) → ONE report; another place still reports", async () => {
      const { deps, reportError, logger } = depsWith(await staleRepo());
      const place = freshPlace();
      const load = (at: Place) =>
        loadEffectiveBookingStandards(deps, {
          place: at,
          targets: [{ calendarId: CAL_A, intents: ["PERFORM"] }],
        });

      const first = await load(place);
      const second = await load(place);

      // Both reads resolve identically; only the REPORT is deduped.
      expect(second).toEqual(first);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      await load(freshPlace());
      expect(reportError).toHaveBeenCalledTimes(2);
    });

    it(`is bounded: past ${DROPPED_ITEMS_REPORT_DEDUPE_CAP} places the oldest is forgotten and reports again`, async () => {
      const { deps, reportError } = depsWith(await staleRepo());
      const load = (at: Place) =>
        loadEffectiveBookingStandards(deps, {
          place: at,
          targets: [{ calendarId: CAL_A, intents: ["PERFORM"] }],
        });
      const oldest = freshPlace();
      await load(oldest);
      for (let i = 0; i < DROPPED_ITEMS_REPORT_DEDUPE_CAP; i += 1) {
        await load(freshPlace());
      }
      const before = reportError.mock.calls.length;

      await load(oldest);

      expect(reportError.mock.calls.length).toBe(before + 1);
    });
  });
});

describe("calendarRequestIntents", () => {
  it("folds INSTANT rental out of RENT (the options read and create gate rule)", () => {
    expect(
      calendarRequestIntents({
        acceptsPerform: true,
        acceptsRent: true,
        acceptsUse: true,
        rentalMode: "REQUEST",
      }),
    ).toEqual(["PERFORM", "RENT", "USE"]);
    expect(
      calendarRequestIntents({
        acceptsPerform: false,
        acceptsRent: true,
        acceptsUse: false,
        rentalMode: "INSTANT",
      }),
    ).toEqual([]);
  });
});
