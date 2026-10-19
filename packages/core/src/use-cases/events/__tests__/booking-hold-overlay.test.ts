import { describe, expect, it, vi } from "vitest";

import { resolveBookingHoldOverlay } from "../_shared/booking-hold-overlay";
import { createFakeBookingHoldsRepo } from "../../booking-holds/__tests__/fakes";

// ─────────────────────────────────────────────────────────────────────────────
// FR-014: the admin calendar overlay. Date window is place-local, rows carry
// the act name off the request plus the sender's resolved platform display
// name (ONE batched humans/orgs read), lapses are projected not written.
// ─────────────────────────────────────────────────────────────────────────────

const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const REQUEST_A = "44444444-4444-4444-8444-444444444444";
const REQUEST_B = "45454545-4545-4545-8545-454545454545";
const REQUEST_C = "46464646-4646-4646-8646-464646464646";
const REQUEST_D = "47474747-4747-4747-8747-474747474747";
const HUMAN_ID = "55555555-5555-4555-8555-555555555555";
const ORG_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-06-10T12:00:00.000Z");

const anon = { performerOwnerType: null, performerOwnerId: null, contactName: "Jo", contactEmail: "jo@x.test" };
const REQUESTS: Record<string, Record<string, unknown>> = {
  // Human-owned, pitched with an act name.
  [REQUEST_A]: { id: REQUEST_A, actName: "Act A", performerOwnerType: "human", performerOwnerId: HUMAN_ID, contactName: null, contactEmail: null },
  // Anonymous sender, no act name → nothing resolves.
  [REQUEST_B]: { id: REQUEST_B, actName: null, ...anon },
  // Org-owned, no act name → the org name is the fallback.
  [REQUEST_C]: { id: REQUEST_C, actName: null, performerOwnerType: "organization", performerOwnerId: ORG_ID, contactName: null, contactEmail: null },
  // Human-owned by someone who no longer resolves.
  [REQUEST_D]: { id: REQUEST_D, actName: null, performerOwnerType: "human", performerOwnerId: "77777777-7777-4777-8777-777777777777", contactName: null, contactEmail: null },
};

function build() {
  const bookingHolds = createFakeBookingHoldsRepo();
  const bookingRequests = { getById: vi.fn(async (id: string) => REQUESTS[id] ?? null) };
  const humans = { getByIds: vi.fn(async (ids: string[]) => (ids.includes(HUMAN_ID) ? [{ id: HUMAN_ID, name: "Willa" }] : [])) };
  const organizations = { getByIds: vi.fn(async (ids: string[]) => (ids.includes(ORG_ID) ? [{ id: ORG_ID, name: "The Wolves" }] : [])) };
  const reportError = vi.fn();
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  return {
    bookingHolds,
    bookingRequests,
    humans,
    organizations,
    reportError,
    logger,
    deps: {
      repos: { bookingHolds, bookingRequests, humans, organizations } as never,
      logger: logger as never,
      reportError,
      clock: { now: () => NOW },
    },
  };
}

const window = {
  place: { timezone: "America/Chicago" },
  // 2026-06-20 00:30 Chicago .. 2026-06-22 00:30 Chicago
  from: new Date("2026-06-20T05:30:00.000Z"),
  to: new Date("2026-06-22T05:30:00.000Z"),
};

describe("resolveBookingHoldOverlay", () => {
  it("converts the instant window to place-local days, projects lapsed, resolves actName once per request", async () => {
    const { bookingHolds, bookingRequests, deps } = build();
    const a = bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-20" });
    const a2 = bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-21" });
    const b = bookingHolds.seed({
      bookingRequestId: REQUEST_B,
      calendarId: CALENDAR_ID,
      date: "2026-06-20",
      status: "CHALLENGED",
      respondBy: new Date(NOW.getTime() - 1),
    });
    // Outside the window.
    bookingHolds.seed({ bookingRequestId: REQUEST_B, calendarId: CALENDAR_ID, date: "2026-07-20" });

    const overlay = await resolveBookingHoldOverlay(deps, { scope: { kind: "calendar", calendarId: CALENDAR_ID }, ...window });

    expect(bookingHolds.listLiveForCalendarRange).toHaveBeenCalledWith({ calendarId: CALENDAR_ID, from: "2026-06-20", to: "2026-06-22", statuses: ["ACTIVE", "CHALLENGED", "CONFIRMED"] });
    expect(overlay.map((h) => [h.id, h.actName, h.lapsed])).toEqual([
      [a.id, "Act A", false],
      [a2.id, "Act A", false],
      [b.id, null, true],
    ]);
    expect(bookingRequests.getById).toHaveBeenCalledTimes(2);
    // Reads never write.
    expect(bookingHolds.updateStatus).not.toHaveBeenCalled();
  });

  it("resolves performerDisplayName from the owner pair in ONE batched humans + orgs read; null when unresolvable", async () => {
    const { bookingHolds, humans, organizations, reportError, deps } = build();
    const a = bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-20" });
    const a2 = bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-21" });
    const b = bookingHolds.seed({ bookingRequestId: REQUEST_B, calendarId: CALENDAR_ID, date: "2026-06-20" });
    const c = bookingHolds.seed({ bookingRequestId: REQUEST_C, calendarId: CALENDAR_ID, date: "2026-06-20" });
    const d = bookingHolds.seed({ bookingRequestId: REQUEST_D, calendarId: CALENDAR_ID, date: "2026-06-21" });

    const overlay = await resolveBookingHoldOverlay(deps, { scope: { kind: "calendar", calendarId: CALENDAR_ID }, ...window });

    const byId = (x: readonly [string, ...unknown[]], y: readonly [string, ...unknown[]]) => x[0].localeCompare(y[0]);
    expect(overlay.map((h) => [h.id, h.actName, h.performerDisplayName] as const).sort(byId)).toEqual(
      (
        [
          [a.id, "Act A", "Willa"],
          [a2.id, "Act A", "Willa"],
          [b.id, null, null],
          [c.id, null, "The Wolves"],
          [d.id, null, null],
        ] as const
      )
        .slice()
        .sort(byId),
    );
    // One batched call per owner kind for the whole window — never per hold.
    expect(humans.getByIds).toHaveBeenCalledTimes(1);
    expect(humans.getByIds).toHaveBeenCalledWith(expect.arrayContaining([HUMAN_ID]));
    expect(humans.getByIds.mock.calls[0]![0]).toHaveLength(2);
    expect(organizations.getByIds).toHaveBeenCalledTimes(1);
    expect(organizations.getByIds).toHaveBeenCalledWith([ORG_ID]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("DEGRADES when the name lookup throws: every hold still renders with a null name, and the failure is reported", async () => {
    const { bookingHolds, humans, reportError, logger, deps } = build();
    humans.getByIds.mockRejectedValueOnce(new Error("humans down"));
    const a = bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-20" });
    const c = bookingHolds.seed({ bookingRequestId: REQUEST_C, calendarId: CALENDAR_ID, date: "2026-06-20" });

    const overlay = await resolveBookingHoldOverlay(deps, { scope: { kind: "calendar", calendarId: CALENDAR_ID }, ...window });

    expect(overlay.map((h) => [h.id, h.actName, h.performerDisplayName])).toEqual([
      [a.id, "Act A", null],
      [c.id, null, null],
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "humans down" }),
      expect.objectContaining({ tags: expect.objectContaining({ useCase: "booking-hold-overlay" }) }),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("a throwing reporter never changes the degraded result", async () => {
    const { bookingHolds, humans, reportError, deps } = build();
    humans.getByIds.mockRejectedValueOnce(new Error("humans down"));
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    const a = bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-20" });

    const overlay = await resolveBookingHoldOverlay(deps, { scope: { kind: "calendar", calendarId: CALENDAR_ID }, ...window });
    expect(overlay.map((h) => [h.id, h.performerDisplayName])).toEqual([[a.id, null]]);
  });

  it("carries a CONFIRMED hold so a settled night cannot render as open, and still excludes RELEASED", async () => {
    const { bookingHolds, deps } = build();
    const active = bookingHolds.seed({ bookingRequestId: REQUEST_A, calendarId: CALENDAR_ID, date: "2026-06-20" });
    // The exact state placeHoldOnLine refuses with
    // HOLD_LINE_ALREADY_CONFIRMED — invisible before this change, so staff
    // saw an open night, pressed Hold and ate the refusal.
    const confirmed = bookingHolds.seed({
      bookingRequestId: REQUEST_C,
      calendarId: CALENDAR_ID,
      date: "2026-06-21",
      status: "CONFIRMED",
      confirmedAt: NOW,
    });
    // A released hold is not a claim on the night — it stays out.
    bookingHolds.seed({
      bookingRequestId: REQUEST_B,
      calendarId: CALENDAR_ID,
      date: "2026-06-22",
      status: "RELEASED",
      releasedReason: "MANUAL",
    });

    const overlay = await resolveBookingHoldOverlay(deps, { scope: { kind: "calendar", calendarId: CALENDAR_ID }, ...window });

    expect(overlay.map((h) => [h.id, h.status])).toEqual([
      [active.id, "ACTIVE"],
      [confirmed.id, "CONFIRMED"],
    ]);
    // The wire shape already carried `status`, so the client discriminates on
    // it with no new field.
    expect(overlay.find((h) => h.id === confirmed.id)).toMatchObject({
      status: "CONFIRMED",
      date: "2026-06-21",
      lapsed: false,
    });
  });

  it("place scope reads through listLiveForPlaceRange; an empty window short-circuits the request and name reads", async () => {
    const { bookingHolds, bookingRequests, humans, organizations, deps } = build();
    const overlay = await resolveBookingHoldOverlay(deps, {
      scope: { kind: "place", placeId: PLACE_ID },
      place: null,
      from: new Date("2026-06-20T05:30:00.000Z"),
      to: new Date("2026-06-22T05:30:00.000Z"),
    });
    expect(overlay).toEqual([]);
    expect(bookingHolds.listLiveForPlaceRange).toHaveBeenCalledWith({ placeId: PLACE_ID, from: "2026-06-20", to: "2026-06-22", statuses: ["ACTIVE", "CHALLENGED", "CONFIRMED"] });
    expect(bookingRequests.getById).not.toHaveBeenCalled();
    expect(humans.getByIds).not.toHaveBeenCalled();
    expect(organizations.getByIds).not.toHaveBeenCalled();
  });
});
