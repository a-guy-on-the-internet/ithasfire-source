import { describe, expect, it } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";

import { listMyBookingHolds } from "../list-my-booking-holds";
import {
  ACT_A_ID,
  ACT_B_ID,
  ASSIGNEE_ID,
  CALENDAR_ID,
  DATE,
  NOW,
  ORG_ID,
  OUTSIDER_ID,
  PLACE_ID,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "./hold-test-context";

// ─────────────────────────────────────────────────────────────────────────────
// listMyBookingHolds — requester-side read (event-calendar-redesign FR-004).
//
// NFR-004 is the whole point of this file: an org/human id never receives
// another requester's holds. The harness's fake `listForRequester` applies
// the adapter's exact predicate (owner pair + TO_VENUE on the request row),
// so a widening in the use case — or a missing gate — shows up here.
// ─────────────────────────────────────────────────────────────────────────────

/** A band registered as an ORG, pitching the same venue. */
const BAND_ORG_ID = "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0";
const BAND_MEMBER_ID = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const REQUEST_BAND = "47474747-4747-4747-8747-474747474747";

const HOUR_MS = 60 * 60 * 1000;

function buildWorld() {
  const memberships: OrgMembership[] = [
    { orgId: ORG_ID, humanId: STAFF_ID, role: "EDITOR" },
    { orgId: ORG_ID, humanId: ASSIGNEE_ID, role: "ADMIN" },
    { orgId: ORG_ID, humanId: VIEWER_ID, role: "VIEWER" },
    // Viewing is membership-any — a VIEWER of the band's org sees its holds.
    { orgId: BAND_ORG_ID, humanId: BAND_MEMBER_ID, role: "VIEWER" },
  ];
  return buildHoldTestContext({
    memberships,
    requests: [
      {
        id: REQUEST_BAND,
        performerOwnerType: "organization",
        performerOwnerId: BAND_ORG_ID,
        actName: "The Band",
      },
    ],
  });
}

describe("listMyBookingHolds — tenant isolation (NFR-004)", () => {
  it("a human sees ONLY the holds its own requests placed — never another act's, never the band's", async () => {
    const ctx = buildWorld();
    const a = ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);
    const band = ctx.seedHold(REQUEST_BAND);

    const result = await listMyBookingHolds(ctx.deps, {
      actorHumanId: ACT_A_ID,
      ownerType: "HUMAN",
      ownerId: ACT_A_ID,
    });

    expect(result.holds.map((h) => h.id)).toEqual([a.id]);
    const ids = JSON.stringify(result);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(band.id);
    // The repo was asked for exactly this owner pair — the SQL scope.
    expect(ctx.bookingHolds.listForRequester).toHaveBeenCalledWith({
      ownerType: "human",
      ownerId: ACT_A_ID,
      statuses: ["ACTIVE", "CHALLENGED", "CONFIRMED"],
    });
  });

  it("an org member sees the org's holds only; a human's OWN holds are not folded into the org's read", async () => {
    const ctx = buildWorld();
    ctx.seedHold(REQUEST_A);
    const band = ctx.seedHold(REQUEST_BAND);

    const result = await listMyBookingHolds(ctx.deps, {
      actorHumanId: BAND_MEMBER_ID,
      ownerType: "ORGANIZATION",
      ownerId: BAND_ORG_ID,
    });

    expect(result.holds.map((h) => h.id)).toEqual([band.id]);
    expect(result.holds[0]).toMatchObject({
      placeId: PLACE_ID,
      placeName: ctx.place.name,
      requestTitle: "The Band",
      position: 2,
    });
  });

  it("a human asking for ANOTHER human's holds is refused before any read", async () => {
    const ctx = buildWorld();
    ctx.seedHold(REQUEST_B);

    await expect(
      listMyBookingHolds(ctx.deps, {
        actorHumanId: ACT_A_ID,
        ownerType: "HUMAN",
        ownerId: ACT_B_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.bookingHolds.listForRequester).not.toHaveBeenCalled();
  });

  it("a non-member asking for an org's holds is refused before any read", async () => {
    const ctx = buildWorld();
    ctx.seedHold(REQUEST_BAND);

    await expect(
      listMyBookingHolds(ctx.deps, {
        actorHumanId: OUTSIDER_ID,
        ownerType: "ORGANIZATION",
        ownerId: BAND_ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.bookingHolds.listForRequester).not.toHaveBeenCalled();
  });

  it("the venue's own staff get nothing through this read — it is requester-side, not venue-side", async () => {
    const ctx = buildWorld();
    ctx.seedHold(REQUEST_A);
    ctx.seedHold(REQUEST_BAND);

    // STAFF_ID is an EDITOR of the VENUE org — it owns no requests.
    const result = await listMyBookingHolds(ctx.deps, {
      actorHumanId: STAFF_ID,
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    });
    expect(result.holds).toEqual([]);
  });
});

describe("listMyBookingHolds — what a requester sees", () => {
  it("projects date/position/status/respondBy + the venue, and NOTHING about the venue's side of the line", async () => {
    const ctx = buildWorld();
    const respondBy = new Date(NOW.getTime() + 24 * HOUR_MS);
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy });

    const result = await listMyBookingHolds(ctx.deps, {
      actorHumanId: ACT_A_ID,
      ownerType: "HUMAN",
      ownerId: ACT_A_ID,
    });

    expect(result).toEqual({
      holds: [
        {
          id: a.id,
          bookingRequestId: REQUEST_A,
          calendarId: CALENDAR_ID,
          spaceId: null,
          placeId: PLACE_ID,
          placeName: ctx.place.name,
          date: DATE,
          position: 1,
          status: "CHALLENGED",
          respondBy,
          requestTitle: "Act A",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(STAFF_ID);
  });

  it("includes CONFIRMED (a won night renders solid) and excludes RELEASED", async () => {
    const ctx = buildWorld();
    const confirmed = ctx.seedHold(REQUEST_A, { status: "CONFIRMED" });
    ctx.seedHold(REQUEST_A, {
      date: "2026-06-21",
      status: "RELEASED",
      releasedReason: "MANUAL",
    });

    const result = await listMyBookingHolds(ctx.deps, {
      actorHumanId: ACT_A_ID,
      ownerType: "HUMAN",
      ownerId: ACT_A_ID,
    });
    expect(result.holds.map((h) => [h.id, h.status])).toEqual([
      [confirmed.id, "CONFIRMED"],
    ]);
  });

  it("drops lapsed holds (expired challenge, past date) without writing — reads never settle", async () => {
    const ctx = buildWorld();
    const expired = ctx.seedHold(REQUEST_A, {
      status: "CHALLENGED",
      respondBy: new Date(NOW.getTime() - 1),
    });
    const past = ctx.seedHold(REQUEST_A, { date: "2026-06-05" });
    const live = ctx.seedHold(REQUEST_A, { date: "2026-06-25" });

    const result = await listMyBookingHolds(ctx.deps, {
      actorHumanId: ACT_A_ID,
      ownerType: "HUMAN",
      ownerId: ACT_A_ID,
    });

    expect(result.holds.map((h) => h.id)).toEqual([live.id]);
    expect(ctx.bookingHolds.rows.get(expired.id)?.status).toBe("CHALLENGED");
    expect(ctx.bookingHolds.rows.get(past.id)?.status).toBe("ACTIVE");
  });

  it("rejects unknown keys and a non-uuid owner at the boundary", async () => {
    const ctx = buildWorld();
    await expect(
      listMyBookingHolds(ctx.deps, {
        actorHumanId: ACT_A_ID,
        ownerType: "HUMAN",
        ownerId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      listMyBookingHolds(ctx.deps, {
        actorHumanId: ACT_A_ID,
        ownerType: "HUMAN",
        ownerId: ACT_A_ID,
        extra: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
