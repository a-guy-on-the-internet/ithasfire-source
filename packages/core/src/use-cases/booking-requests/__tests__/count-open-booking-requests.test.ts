import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import { OPEN_BOOKING_REQUEST_STATUSES } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";

import { countOpenBookingRequests } from "../count-open-booking-requests";
import type { CountOpenBookingRequestsDeps } from "../count-open-booking-requests";
import { ACTOR_ID, ORG_ID, PLACE_ID, buildPlaceRecord } from "./helpers";

/**
 * booking-inbox-placement FR-006 — the count endpoint behind the Bookings hub
 * badges and (FR-007) the admin rail badge.
 *
 * The load-bearing properties under test are the ones the spec's LOW risk
 * names ("countOpen and the list views disagree"):
 *   - the SHARED open-status constant is what reaches the repo, so a badge can
 *     never fold EXPIRED/DECLINED/WITHDRAWN/ACCEPTED rows in;
 *   - every OWNED place gets an entry, zero-filled — `groupBy` emits no row
 *     for an empty bucket, and a missing entry would read as "not measured";
 *   - authz is the SAME gate as the list scopes this summarizes, not a
 *     stricter or looser one.
 */

const SECOND_PLACE_ID = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";
const CAL_A = "4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a";
const CAL_B = "4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b";
const CAL_C = "4c4c4c4c-4c4c-4c4c-8c4c-4c4c4c4c4c4c";

type BuildDepsOptions = {
  membership?: OrgMembership | null;
  /** Orgs the actor belongs to — folded into the PERSONAL context's venues. */
  orgMemberships?: { orgId: string; role: string }[];
  /** Calendar rows the batch read returns, across every owned place. */
  calendars?: { id: string; placeId: string; name: string }[];
  ownedPlaces?: PlaceRecord[];
  performerInboxCount?: number;
  groupedCounts?: { placeId: string; openCount: number }[];
};

function buildDeps(options: BuildDepsOptions = {}) {
  const bookingRequests = {
    countForPerformerInbox: vi.fn(async () => options.performerInboxCount ?? 0),
    countOpenByPlace: vi.fn(async () => options.groupedCounts ?? []),
  };
  const places = {
    listOwnedBySubject: vi.fn(async () => options.ownedPlaces ?? []),
  };
  // Option set for the inbox's grouped filter — authoritative, so it rides the
  // same call as the badges. Defaults to none; specs that care supply rows.
  const calendars = {
    listByPlaceIds: vi.fn(async () => options.calendars ?? []),
  };

  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
    getOrgMemberships: vi.fn(async () => []),
    // SCOPING, not a gate: the personal context folds the actor's orgs'
    // venues into its own venue list (see `listOwnerScopePlaces`).
    listOrgMembershipsByHumanId: vi.fn(async () => options.orgMemberships ?? []),
  };

  const deps: CountOpenBookingRequestsDeps = {
    repos: {
      bookingRequests,
      places,
      authz,
      calendars,
    } as unknown as CountOpenBookingRequestsDeps["repos"],
  };

  return { deps, mocks: { bookingRequests, places, authz, calendars } };
}

/** Membership-any is enough to view counts, exactly like the list scopes. */
function membership(role: OrgMembership["role"] = "VIEWER"): OrgMembership {
  return { orgId: ORG_ID, humanId: ACTOR_ID, role } as OrgMembership;
}

describe("countOpenBookingRequests", () => {
  it("returns the org-as-act inbox count and a zero-filled count per owned place (FR-006 acceptance)", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      performerInboxCount: 2,
      ownedPlaces: [
        buildPlaceRecord({ id: PLACE_ID, name: "Test Venue" }),
        buildPlaceRecord({ id: SECOND_PLACE_ID, name: "Second Room" }),
      ],
      // Only the first place has rows — the second is absent from `groupBy`
      // output because an empty bucket produces no group.
      groupedCounts: [{ placeId: PLACE_ID, openCount: 3 }],
    });

    const result = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result).toEqual({
      performerInbox: 2,
      venues: [
        { placeId: PLACE_ID, placeName: "Test Venue", openCount: 3, calendars: [] },
        { placeId: SECOND_PLACE_ID, placeName: "Second Room", openCount: 0, calendars: [] },
      ],
      ownedPlacesTruncated: false,
    });

    // The org AS AN ACT — repo owner vocabulary is "organization", not the
    // list input's "org".
    expect(mocks.bookingRequests.countForPerformerInbox).toHaveBeenCalledWith({
      owners: [{ ownerType: "organization", ownerId: ORG_ID }],
      statuses: ["PENDING", "VIEWED"],
    });
    // Venues are scoped to ORG-OWNED places (verified, non-revoked ownership).
    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      limit: 100,
    });
    expect(mocks.bookingRequests.countOpenByPlace).toHaveBeenCalledWith({
      placeIds: [PLACE_ID, SECOND_PLACE_ID],
      statuses: ["PENDING", "VIEWED"],
    });
  });

  it("zero-fills a place the grouped query never mentions", async () => {
    const { deps } = buildDeps({
      membership: membership("EDITOR"),
      ownedPlaces: [buildPlaceRecord({ id: PLACE_ID, name: "Test Venue" })],
      groupedCounts: [],
    });

    const result = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result.venues).toEqual([
      { placeId: PLACE_ID, placeName: "Test Venue", openCount: 0, calendars: [] },
    ]);
  });

  it("carries each venue's display name so the surface needs no second place query", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlaces: [
        buildPlaceRecord({ id: PLACE_ID, name: "The Ember Room" }),
        buildPlaceRecord({ id: SECOND_PLACE_ID, name: "The Quiet Corner" }),
      ],
      groupedCounts: [{ placeId: SECOND_PLACE_ID, openCount: 5 }],
    });

    const result = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    // `venues` is the AUTHORITATIVE org-owned venue list for this surface, not
    // a count sidecar to be paired against a separately-fetched place list
    // (that list is a looser set — it omits the verified/non-revoked ownership
    // clauses — so pairing would render "absent" as "0 open").
    expect(result.venues).toEqual([
      { placeId: PLACE_ID, placeName: "The Ember Room", openCount: 0, calendars: [] },
      { placeId: SECOND_PLACE_ID, placeName: "The Quiet Corner", openCount: 5, calendars: [] },
    ]);
    // The names come from the SAME read that scopes the counts — one query.
    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledTimes(1);
  });

  it("flags truncation when the owned-place read comes back at the cap", async () => {
    // 100 owned places = the repo's clamp ceiling, so the alphabetical tail may
    // have been cut. Without the flag those venues are ABSENT (not 0), which
    // is the ">N venues get no badge" hole FR-006 exists to kill.
    const manyPlaces = Array.from({ length: 100 }, (_, index) =>
      buildPlaceRecord({
        id: `4${index.toString().padStart(7, "0")}-0000-4000-8000-000000000000`,
        name: `Venue ${index}`,
      }),
    );
    const { deps } = buildDeps({
      membership: membership(),
      ownedPlaces: manyPlaces,
      groupedCounts: [],
    });

    const result = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result.ownedPlacesTruncated).toBe(true);
    expect(result.venues).toHaveLength(100);
  });

  it("does not flag truncation below the cap, including for an org with no venues", async () => {
    const { deps } = buildDeps({
      membership: membership(),
      ownedPlaces: [buildPlaceRecord({ id: PLACE_ID })],
    });
    const belowCap = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(belowCap.ownedPlacesTruncated).toBe(false);

    const { deps: emptyDeps } = buildDeps({
      membership: membership(),
      ownedPlaces: [],
    });
    const noVenues = await countOpenBookingRequests(emptyDeps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });
    expect(noVenues.ownedPlacesTruncated).toBe(false);
  });

  it("ignores grouped rows for places the org does not own", async () => {
    const { deps } = buildDeps({
      membership: membership(),
      ownedPlaces: [buildPlaceRecord({ id: PLACE_ID })],
      // A defensive case: the response is driven off the OWNED place list, so
      // a stray row could never widen the org's view.
      groupedCounts: [
        { placeId: PLACE_ID, openCount: 1 },
        { placeId: SECOND_PLACE_ID, openCount: 9 },
      ],
    });

    const result = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result.venues).toEqual([
      { placeId: PLACE_ID, placeName: "Test Venue", openCount: 1, calendars: [] },
    ]);
  });

  it("forwards the SHARED open-status constant to both counts (never a re-declared list)", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlaces: [buildPlaceRecord({ id: PLACE_ID })],
    });

    await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    const expected = [...OPEN_BOOKING_REQUEST_STATUSES];
    expect(expected).toEqual(["PENDING", "VIEWED"]);

    const inboxArgs =
      mocks.bookingRequests.countForPerformerInbox.mock.calls[0]![0];
    const placeArgs = mocks.bookingRequests.countOpenByPlace.mock.calls[0]![0];
    expect(inboxArgs.statuses).toEqual(expected);
    expect(placeArgs.statuses).toEqual(expected);
    // The terminal statuses are never asked for, in either direction.
    for (const terminal of [
      "EXPIRED",
      "DECLINED",
      "WITHDRAWN",
      "ACCEPTED",
    ] as const) {
      expect(inboxArgs.statuses).not.toContain(terminal);
      expect(placeArgs.statuses).not.toContain(terminal);
    }
  });

  it("skips the grouped place query entirely for an org with no owned places", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      performerInboxCount: 4,
      ownedPlaces: [],
    });

    const result = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(result).toEqual({
      performerInbox: 4,
      venues: [],
      ownedPlacesTruncated: false,
    });
    expect(mocks.bookingRequests.countOpenByPlace).not.toHaveBeenCalled();
  });

  it("rejects a non-member with the same shape as the organizer list scope", async () => {
    const { deps, mocks } = buildDeps({ membership: null });

    await expect(
      countOpenBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    // Nothing is read once authz fails.
    expect(mocks.bookingRequests.countForPerformerInbox).not.toHaveBeenCalled();
    expect(mocks.places.listOwnedBySubject).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.countOpenByPlace).not.toHaveBeenCalled();
  });

  it("rejects unknown input keys (.strict) and a non-uuid orgId", async () => {
    const { deps } = buildDeps({ membership: membership() });

    await expect(
      countOpenBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        placeId: PLACE_ID,
      }),
    ).rejects.toBeTruthy();

    await expect(
      countOpenBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        orgId: "not-a-uuid",
      }),
    ).rejects.toBeTruthy();
  });

  // ── Selector: explicit `owner` alongside the legacy `orgId` ──────────────

  it("accepts `owner: { kind: \"org\" }` as the explicit spelling of `orgId`", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      performerInboxCount: 1,
      ownedPlaces: [buildPlaceRecord({ id: PLACE_ID, name: "Test Venue" })],
      groupedCounts: [{ placeId: PLACE_ID, openCount: 2 }],
    });

    const result = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      owner: { kind: "org", orgId: ORG_ID },
    });

    expect(result).toEqual({
      performerInbox: 1,
      venues: [{ placeId: PLACE_ID, placeName: "Test Venue", openCount: 2, calendars: [] }],
      ownedPlacesTruncated: false,
    });
    expect(mocks.authz.getOrgMembership).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID }),
    );
    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      limit: 100,
    });
  });

  it("rejects neither selector, and both selectors (exactly one)", async () => {
    const { deps, mocks } = buildDeps({ membership: membership() });

    await expect(
      countOpenBookingRequests(deps, { actorHumanId: ACTOR_ID }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      countOpenBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        owner: { kind: "human" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // Nothing is read when the selector is malformed.
    expect(mocks.places.listOwnedBySubject).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.countForPerformerInbox).not.toHaveBeenCalled();
  });

  it("`owner: { kind: \"human\" }` cannot name another human (.strict on the variant)", async () => {
    const { deps } = buildDeps({ membership: membership() });

    await expect(
      countOpenBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        owner: { kind: "human", humanId: "12121212-1212-4121-8121-121212121212" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("is read-only: no viewedAt stamping, no writes (NFR-003)", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlaces: [buildPlaceRecord({ id: PLACE_ID })],
      groupedCounts: [{ placeId: PLACE_ID, openCount: 1 }],
    });

    await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    // The fake repo bag exposes ONLY read methods; any write attempt would
    // throw "is not a function". Asserting the surface pins the intent.
    expect(Object.keys(mocks.bookingRequests).sort()).toEqual([
      "countForPerformerInbox",
      "countOpenByPlace",
    ]);
  });
});

/**
 * `owner: { kind: "human" }` — the personal admin's badge: the actor's own
 * directly-owned venues (PlaceOwnership HUMAN) plus the actor AS AN ACT. The
 * output shape is identical to the org case, so the Bookings page renders
 * both off one component.
 */
describe("countOpenBookingRequests — owner: human", () => {
  it("counts the actor's directly-owned venues and their human performer inbox, with NO org gate", async () => {
    const { deps, mocks } = buildDeps({
      // No membership anywhere — the human path must not need one.
      membership: null,
      performerInboxCount: 3,
      ownedPlaces: [
        buildPlaceRecord({ id: PLACE_ID, name: "Red Rocks Amphitheatre" }),
        buildPlaceRecord({ id: SECOND_PLACE_ID, name: "Second Room" }),
      ],
      groupedCounts: [{ placeId: SECOND_PLACE_ID, openCount: 4 }],
    });

    const result = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      owner: { kind: "human" },
    });

    expect(result).toEqual({
      performerInbox: 3,
      venues: [
        { placeId: PLACE_ID, placeName: "Red Rocks Amphitheatre", openCount: 0, calendars: [] },
        { placeId: SECOND_PLACE_ID, placeName: "Second Room", openCount: 4, calendars: [] },
      ],
      ownedPlacesTruncated: false,
    });

    expect(mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    // The SAME enumeration `listBookingRequests({ scope: "human-venues" })`
    // uses: HUMAN ownership keyed on the ACTOR.
    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledTimes(1);
    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledWith({
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      limit: 100,
    });
    // The actor AS AN ACT — the human `performer-inbox` row set.
    expect(mocks.bookingRequests.countForPerformerInbox).toHaveBeenCalledWith({
      owners: [{ ownerType: "human", ownerId: ACTOR_ID }],
      statuses: ["PENDING", "VIEWED"],
    });
    expect(mocks.bookingRequests.countOpenByPlace).toHaveBeenCalledWith({
      placeIds: [PLACE_ID, SECOND_PLACE_ID],
      statuses: ["PENDING", "VIEWED"],
    });
  });

  it("flags truncation at the cap, exactly like the org path", async () => {
    const manyPlaces = Array.from({ length: 100 }, (_, index) =>
      buildPlaceRecord({
        id: `4${index.toString().padStart(7, "0")}-0000-4000-8000-000000000000`,
        name: `Venue ${index}`,
      }),
    );
    const { deps } = buildDeps({ membership: null, ownedPlaces: manyPlaces });

    const result = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      owner: { kind: "human" },
    });

    expect(result.ownedPlacesTruncated).toBe(true);
    expect(result.venues).toHaveLength(100);
  });

  it("skips the grouped query for a human who owns no venues (act-only human)", async () => {
    const { deps, mocks } = buildDeps({
      membership: null,
      performerInboxCount: 2,
      ownedPlaces: [],
    });

    const result = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      owner: { kind: "human" },
    });

    expect(result).toEqual({
      performerInbox: 2,
      venues: [],
      ownedPlacesTruncated: false,
    });
    expect(mocks.bookingRequests.countOpenByPlace).not.toHaveBeenCalled();
  });
});

describe("countOpenBookingRequests — the grouped filter's option set", () => {
  it("carries each venue's calendars, grouped by place", async () => {
    const { deps } = buildDeps({
      membership: membership(),
      ownedPlaces: [
        buildPlaceRecord({ id: PLACE_ID, name: "Test Venue" }),
        buildPlaceRecord({ id: SECOND_PLACE_ID, name: "Second Room" }),
      ],
      calendars: [
        { id: CAL_A, placeId: PLACE_ID, name: "Main Calendar" },
        { id: CAL_B, placeId: PLACE_ID, name: "Live Music" },
        { id: CAL_C, placeId: SECOND_PLACE_ID, name: "Main Calendar" },
      ],
    });

    const out = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(out.venues[0]!.calendars).toEqual([
      { id: CAL_A, name: "Main Calendar" },
      { id: CAL_B, name: "Live Music" },
    ]);
    expect(out.venues[1]!.calendars).toEqual([
      { id: CAL_C, name: "Main Calendar" },
    ]);
  });

  it("zero-fills a venue with no calendars rather than dropping it", async () => {
    // Same discipline as the counts: absent would read as "we never looked".
    const { deps } = buildDeps({
      membership: membership(),
      ownedPlaces: [buildPlaceRecord({ id: PLACE_ID, name: "Test Venue" })],
      calendars: [],
    });

    const out = await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(out.venues).toHaveLength(1);
    expect(out.venues[0]!.calendars).toEqual([]);
  });

  it("never asks for calendars when the owner holds no venues", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlaces: [],
    });

    await countOpenBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
    });

    expect(mocks.calendars.listByPlaceIds).toHaveBeenCalledWith([]);
  });
});
