import { describe, expect, it } from "vitest";

import {
  buildApplyResult,
  eventPickReminderAnchor,
  isCapacityFull,
  shouldHideVolunteerSection,
  shouldRetryVolunteerRolesQuery,
  VOLUNTEER_ROLES_MAX_RETRIES,
} from "../volunteer-section.helpers";

describe("shouldHideVolunteerSection", () => {
  it("hides unpublished events before querying", () => {
    expect(
      shouldHideVolunteerSection(
        "DRAFT",
        "2026-05-01T00:00:00.000Z",
        Date.parse("2026-04-24T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("hides events that have already ended", () => {
    expect(
      shouldHideVolunteerSection(
        "PUBLISHED",
        "2026-04-20T00:00:00.000Z",
        Date.parse("2026-04-24T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("keeps published upcoming events visible", () => {
    expect(
      shouldHideVolunteerSection(
        "PUBLISHED",
        "2026-05-01T00:00:00.000Z",
        Date.parse("2026-04-24T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  // Gap 8 (2026-06-11): day-of recruiting. An event that has STARTED but
  // not ended must keep the volunteer surface visible — Teardown shifts run
  // after the event, so mid-event signups have to stay possible.
  it("keeps in-progress events visible until endsAt", () => {
    // Event ends 2.5h after "now"; it started hours ago — only endsAt matters.
    expect(
      shouldHideVolunteerSection(
        "PUBLISHED",
        "2026-06-11T00:49:20.533Z",
        Date.parse("2026-06-10T22:19:00.000Z"),
      ),
    ).toBe(false);
  });

  it("does not hide at the exact endsAt instant (hide is strictly after)", () => {
    expect(
      shouldHideVolunteerSection(
        "PUBLISHED",
        "2026-04-24T00:00:00.000Z",
        Date.parse("2026-04-24T00:00:00.000Z"),
      ),
    ).toBe(false);
  });
});

describe("shouldRetryVolunteerRolesQuery", () => {
  // Gap 8 (2026-06-11): a single transient failure must not permanently
  // hide the Volunteer CTA for the session — retry transient errors,
  // but settle immediately on the server's intentional NOT_FOUND
  // ("volunteering disabled / event not visible") signal.
  it("never retries NOT_FOUND", () => {
    expect(
      shouldRetryVolunteerRolesQuery(0, { data: { code: "NOT_FOUND" } }),
    ).toBe(false);
  });

  it("retries transient errors up to the cap", () => {
    const networkError = { data: null };
    for (let i = 0; i < VOLUNTEER_ROLES_MAX_RETRIES; i++) {
      expect(shouldRetryVolunteerRolesQuery(i, networkError)).toBe(true);
    }
    expect(
      shouldRetryVolunteerRolesQuery(VOLUNTEER_ROLES_MAX_RETRIES, networkError),
    ).toBe(false);
  });

  it("retries server errors that are not NOT_FOUND", () => {
    expect(
      shouldRetryVolunteerRolesQuery(1, {
        data: { code: "INTERNAL_SERVER_ERROR" },
      }),
    ).toBe(true);
  });

  it("retries when the error shape is missing entirely", () => {
    expect(shouldRetryVolunteerRolesQuery(0, null)).toBe(true);
    expect(shouldRetryVolunteerRolesQuery(0, undefined)).toBe(true);
  });
});

describe("isCapacityFull", () => {
  it("is full when accepted signups have reached capacity", () => {
    expect(isCapacityFull({ capacity: 3, acceptedCount: 3 })).toBe(true);
    expect(isCapacityFull({ capacity: 3, acceptedCount: 4 })).toBe(true);
  });

  it("is not full below capacity", () => {
    expect(isCapacityFull({ capacity: 3, acceptedCount: 2 })).toBe(false);
  });

  it("is never full without a capacity or without a target", () => {
    expect(isCapacityFull({ capacity: null, acceptedCount: 99 })).toBe(false);
    expect(isCapacityFull(null)).toBe(false);
    expect(isCapacityFull(undefined)).toBe(false);
  });
});

describe("buildApplyResult", () => {
  const mapError = (reason: unknown) =>
    reason === null ? "generic" : `mapped:${String(reason)}`;

  it("marks auto-approved rows as confirmed, never waitlisted", () => {
    expect(
      buildApplyResult({
        key: "role-1::shift-1",
        label: "Bar Staff · Evening",
        settled: { status: "fulfilled", value: { status: "APPROVED" } },
        targetWasFull: false,
        mapError,
      }),
    ).toEqual({
      key: "role-1::shift-1",
      label: "Bar Staff · Evening",
      ok: true,
      status: "APPROVED",
      waitlisted: false,
    });
  });

  it("flags pending rows on a full target as waitlisted", () => {
    expect(
      buildApplyResult({
        key: "role-1::shift-1",
        label: "Bar Staff · Evening",
        settled: { status: "fulfilled", value: { status: "PENDING" } },
        targetWasFull: true,
        mapError,
      }),
    ).toEqual({
      key: "role-1::shift-1",
      label: "Bar Staff · Evening",
      ok: true,
      status: "PENDING",
      waitlisted: true,
    });
  });

  it("keeps pending rows with open capacity as normal review", () => {
    expect(
      buildApplyResult({
        key: "role-1::",
        label: "Bar Staff",
        settled: { status: "fulfilled", value: { status: "PENDING" } },
        targetWasFull: false,
        mapError,
      }),
    ).toEqual({
      key: "role-1::",
      label: "Bar Staff",
      ok: true,
      status: "PENDING",
      waitlisted: false,
    });
  });

  it("does not mark an approved row waitlisted even when the target was full", () => {
    // Race: someone withdrew between render and submit, or the server
    // auto-approved past the stale snapshot — the server status wins.
    expect(
      buildApplyResult({
        key: "role-1::shift-1",
        label: "Bar Staff · Evening",
        settled: { status: "fulfilled", value: { status: "APPROVED" } },
        targetWasFull: true,
        mapError,
      }),
    ).toMatchObject({ ok: true, status: "APPROVED", waitlisted: false });
  });

  it("maps rejected promises through mapError", () => {
    expect(
      buildApplyResult({
        key: "role-1::shift-1",
        label: "Bar Staff · Evening",
        settled: { status: "rejected", reason: "boom" },
        targetWasFull: false,
        mapError,
      }),
    ).toEqual({
      key: "role-1::shift-1",
      label: "Bar Staff · Evening",
      ok: false,
      error: "mapped:boom",
    });
  });

  it("treats a missing settled entry as a generic failure", () => {
    expect(
      buildApplyResult({
        key: "role-1::shift-1",
        label: "Bar Staff · Evening",
        settled: undefined,
        targetWasFull: false,
        mapError,
      }),
    ).toEqual({
      key: "role-1::shift-1",
      label: "Bar Staff · Evening",
      ok: false,
      error: "generic",
    });
  });
});

describe("eventPickReminderAnchor", () => {
  const roles = [
    { id: "shiftless", shifts: [] },
    { id: "shifted", shifts: [{ id: "shift_1" }] },
  ];

  it("a shift pick is reminded before its shift", () => {
    expect(
      eventPickReminderAnchor({ roleId: "shifted", shiftId: "shift_1" }, roles),
    ).toBe("SHIFT");
  });

  it("a pick on a role with no shifts is reminded before the event starts", () => {
    expect(
      eventPickReminderAnchor({ roleId: "shiftless", shiftId: null }, roles),
    ).toBe("EVENT_START");
  });

  it("a role-level pick on a role that has shifts is not reminded", () => {
    expect(
      eventPickReminderAnchor({ roleId: "shifted", shiftId: null }, roles),
    ).toBeNull();
  });

  it("an unknown role is not reminded (fail-closed)", () => {
    expect(
      eventPickReminderAnchor({ roleId: "gone", shiftId: null }, roles),
    ).toBeNull();
  });
});
