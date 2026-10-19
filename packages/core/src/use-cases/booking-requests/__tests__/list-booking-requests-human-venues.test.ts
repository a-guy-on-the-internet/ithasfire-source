import { describe, expect, it, vi } from "vitest";

import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";

import { listBookingRequests } from "../list-booking-requests";
import type { ListBookingRequestsDeps } from "../list-booking-requests";
import {
  ACTOR_ID,
  ORG_ID,
  PLACE_ID,
  type SeededThreadMessage,
  buildBookingRequestRecord,
  buildPlaceRecord,
  buildStageRepos,
  buildUnreadCountingRepo,
} from "./helpers";

/**
 * `scope: "human-venues"` — the personal admin's cross-venue inbox: every
 * TO_VENUE request across every place the ACTOR owns directly (PlaceOwnership
 * ownerType HUMAN) AND every place owned by an org the actor belongs to, in
 * ONE page. The personal admin is a hub, not a tenant.
 *
 * Same contract as "org-venues", with two deliberate differences: there is no
 * membership GATE (the owner IS the actor), and the enumeration is a union
 * rather than one subject. What must hold:
 *   - the enumeration is keyed on the ACTOR — never on a client-supplied id,
 *     and never on the org gate methods;
 *   - the actor's orgs' venues are folded in, deduped and re-sorted;
 *   - a foreign row is dropped AND reported, with a human-shaped report;
 *   - truncation is surfaced, never silent;
 *   - the unread side is VENUE, in ONE batched call.
 */

const SECOND_PLACE_ID = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";
const FOREIGN_PLACE_ID = "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c";
const OTHER_HUMAN_ID = "12121212-1212-4121-8121-121212121212";
const SECOND_REQUEST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FIRST_REQUEST_ID = buildBookingRequestRecord().id;

type BuildDepsOptions = {
  /** Places owned, keyed by `${ownerType}:${ownerId}` — models BOTH subjects. */
  ownedPlacesBySubject?: Record<string, PlaceRecord[]>;
  rowsByPlaceId?: Record<string, BookingRequestRecord[]>;
  leakedRecords?: BookingRequestRecord[];
  messages?: SeededThreadMessage[];
  reportError?: ListBookingRequestsDeps["reportError"];
  logger?: ListBookingRequestsDeps["logger"];
  /** Orgs the actor belongs to — the SCOPING read, not a gate. */
  orgMemberships?: { orgId: string; role: string }[];
};

function buildDeps(options: BuildDepsOptions = {}) {
  const rowsByPlaceId = options.rowsByPlaceId ?? {};

  const listForPlaces = vi.fn(
    async ({ placeIds }: { placeIds: readonly string[] }) => {
      const rows = placeIds.flatMap((id) => rowsByPlaceId[id] ?? []);
      return [...rows, ...(options.leakedRecords ?? [])];
    },
  );

  const bookingRequests = {
    listForPlaces,
    listForPlace: vi.fn(async () => []),
    listForPerformer: vi.fn(async () => []),
    listForOrganizer: vi.fn(async () => []),
    listForPerformerInbox: vi.fn(async () => []),
    // The bill (lineup v2): pre-bill rows — no acts on any request.
    listActsForRequests: vi.fn(async () => []),
  };

  const places = {
    listOwnedBySubject: vi.fn(
      async ({ ownerType, ownerId }: { ownerType: string; ownerId: string }) =>
        options.ownedPlacesBySubject?.[`${ownerType}:${ownerId}`] ?? [],
    ),
    getById: vi.fn(async () => null),
  };

  // The human scope must never consult the org GATE methods — the subject is
  // the actor by construction, so a membership mock that returns nothing makes
  // any accidental gate fail LOUDLY. `listOrgMembershipsByHumanId` is a
  // different thing and IS expected: it is the SCOPING read that folds the
  // actor's orgs' venues into the personal hub.
  const authz = {
    getOrgMembership: vi.fn(async () => null),
    getOrgMemberships: vi.fn(async () => []),
    listOrgMembershipsByHumanId: vi.fn(
      async ({ roles }: { roles?: string[] }) =>
        (options.orgMemberships ?? []).filter(
          (membership) => !roles || roles.includes(membership.role),
        ),
    ),
  };

  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: "Test Performer" })),
    ),
  };
  const organizations = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: "Test Org" })),
    ),
  };

  const bookingRequestMessages = buildUnreadCountingRepo(options.messages);
  const stage = buildStageRepos({});

  const deps: ListBookingRequestsDeps = {
    repos: {
      bookingRequests,
      places,
      authz,
      humans,
      organizations,
      bookingRequestMessages,
      agreements: stage.agreements,
      bookingHolds: stage.bookingHolds,
      bookingTags: stage.bookingTags,
      events: stage.events,
    } as unknown as ListBookingRequestsDeps["repos"],
    ...(options.reportError ? { reportError: options.reportError } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  };

  return {
    deps,
    mocks: { bookingRequests, places, authz, bookingRequestMessages },
  };
}

function ownedByActor(): Record<string, PlaceRecord[]> {
  return {
    [`HUMAN:${ACTOR_ID}`]: [
      buildPlaceRecord({ id: PLACE_ID, name: "Red Rocks Amphitheatre" }),
      buildPlaceRecord({ id: SECOND_PLACE_ID, name: "The Quiet Corner" }),
    ],
  };
}

describe("listBookingRequests — scope: human-venues", () => {
  it("returns requests across EVERY directly-owned venue in one page, with placeId/placeName", async () => {
    const { deps, mocks } = buildDeps({
      ownedPlacesBySubject: ownedByActor(),
      rowsByPlaceId: {
        [PLACE_ID]: [buildBookingRequestRecord()],
        [SECOND_PLACE_ID]: [
          buildBookingRequestRecord({
            id: SECOND_REQUEST_ID,
            placeId: SECOND_PLACE_ID,
            placeName: "The Quiet Corner",
          }),
        ],
      },
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    expect(result.requests.map((r) => [r.id, r.placeId, r.placeName])).toEqual([
      [FIRST_REQUEST_ID, PLACE_ID, "Test Venue"],
      [SECOND_REQUEST_ID, SECOND_PLACE_ID, "The Quiet Corner"],
    ]);
    expect(result.ownedPlacesTruncated).toBe(false);

    // ONE set-shaped repo call — never a per-place loop.
    expect(mocks.bookingRequests.listForPlaces).toHaveBeenCalledTimes(1);
    expect(mocks.bookingRequests.listForPlaces).toHaveBeenCalledWith({
      placeIds: [PLACE_ID, SECOND_PLACE_ID],
      statuses: undefined,
    });
    expect(mocks.bookingRequests.listForPlace).not.toHaveBeenCalled();
  });

  it("enumerates ownerType HUMAN keyed on the ACTOR — the same helper countOpen uses", async () => {
    const { deps, mocks } = buildDeps({ ownedPlacesBySubject: ownedByActor() });

    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledTimes(1);
    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledWith({
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      limit: 100,
    });
  });

  it("has no membership gate and never touches the org relation", async () => {
    const { deps, mocks } = buildDeps({
      ownedPlacesBySubject: ownedByActor(),
      rowsByPlaceId: { [PLACE_ID]: [buildBookingRequestRecord()] },
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    expect(result.requests).toHaveLength(1);
    expect(mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    expect(mocks.authz.getOrgMemberships).not.toHaveBeenCalled();
  });

  it("a stray orgId does not widen the scope to org-owned venues", async () => {
    // `orgId` is accepted by the schema (it belongs to org-venues) but is
    // irrelevant here: the human scope reads HUMAN ownership for the actor
    // ONLY, and never the org's places.
    const { deps, mocks } = buildDeps({
      ownedPlacesBySubject: {
        [`ORGANIZATION:${ORG_ID}`]: [buildPlaceRecord({ id: PLACE_ID })],
        [`HUMAN:${ACTOR_ID}`]: [],
      },
      rowsByPlaceId: { [PLACE_ID]: [buildBookingRequestRecord()] },
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
      orgId: ORG_ID,
    });

    expect(result.requests).toEqual([]);
    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledTimes(1);
    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: "HUMAN", ownerId: ACTOR_ID }),
    );
  });

  it("one human CANNOT see another human's venues (enumeration is actor-keyed)", async () => {
    const { deps } = buildDeps({
      ownedPlacesBySubject: {
        [`HUMAN:${OTHER_HUMAN_ID}`]: [buildPlaceRecord({ id: PLACE_ID })],
      },
      rowsByPlaceId: { [PLACE_ID]: [buildBookingRequestRecord()] },
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    expect(result.requests).toEqual([]);
  });

  it("forwards a status filter to the set-shaped query", async () => {
    const { deps, mocks } = buildDeps({ ownedPlacesBySubject: ownedByActor() });

    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
      statuses: ["PENDING", "VIEWED"],
    });

    expect(mocks.bookingRequests.listForPlaces).toHaveBeenCalledWith({
      placeIds: [PLACE_ID, SECOND_PLACE_ID],
      statuses: ["PENDING", "VIEWED"],
    });
  });

  // ── Cross-owner backstop ──────────────────────────────────────────────────

  it("drops AND reports a row for a place the human does not own (backstop)", async () => {
    const reportError = vi.fn();
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const foreign = buildBookingRequestRecord({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      placeId: FOREIGN_PLACE_ID,
      placeName: "Someone Else's Bar",
    });
    const { deps } = buildDeps({
      ownedPlacesBySubject: {
        [`HUMAN:${ACTOR_ID}`]: [buildPlaceRecord({ id: PLACE_ID })],
      },
      rowsByPlaceId: { [PLACE_ID]: [buildBookingRequestRecord()] },
      leakedRecords: [foreign],
      reportError,
      logger: logger as unknown as ListBookingRequestsDeps["logger"],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    expect(result.requests.map((r) => r.id)).toEqual([FIRST_REQUEST_ID]);
    expect(reportError).toHaveBeenCalledTimes(1);
    // Human-shaped report: the owner is named as a human, never as an org.
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "listBookingRequests", step: "humanVenueScope" },
      extra: {
        ownerHumanId: ACTOR_ID,
        bookingRequestId: foreign.id,
        placeId: FOREIGN_PLACE_ID,
      },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.list.foreign_place_row_dropped",
      expect.objectContaining({
        scope: "human-venues",
        ownerHumanId: ACTOR_ID,
        placeId: FOREIGN_PLACE_ID,
      }),
    );
  });

  it("a throwing reporter never breaks the drop-the-foreign-row backstop", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down too");
    });
    const { deps } = buildDeps({
      ownedPlacesBySubject: {
        [`HUMAN:${ACTOR_ID}`]: [buildPlaceRecord({ id: PLACE_ID })],
      },
      rowsByPlaceId: { [PLACE_ID]: [buildBookingRequestRecord()] },
      leakedRecords: [
        buildBookingRequestRecord({
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          placeId: FOREIGN_PLACE_ID,
        }),
      ],
      reportError,
    });

    await expect(
      listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "human-venues",
      }),
    ).resolves.toMatchObject({ requests: [{ id: FIRST_REQUEST_ID }] });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  // ── Unread counts ─────────────────────────────────────────────────────────

  it("resolves unread counts in ONE call, side VENUE", async () => {
    const { deps, mocks } = buildDeps({
      ownedPlacesBySubject: ownedByActor(),
      rowsByPlaceId: {
        [PLACE_ID]: [buildBookingRequestRecord()],
        [SECOND_PLACE_ID]: [
          buildBookingRequestRecord({
            id: SECOND_REQUEST_ID,
            placeId: SECOND_PLACE_ID,
          }),
        ],
      },
      messages: [
        { bookingRequestId: SECOND_REQUEST_ID, authorSide: "PERFORMER" },
        { bookingRequestId: SECOND_REQUEST_ID, authorSide: "VENUE" },
      ],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    expect(result.requests.map((r) => [r.id, r.unreadMessageCount])).toEqual([
      [FIRST_REQUEST_ID, 0],
      [SECOND_REQUEST_ID, 1],
    ]);
    expect(
      mocks.bookingRequestMessages.countUnreadByRequest,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.bookingRequestMessages.countUnreadByRequest,
    ).toHaveBeenCalledWith({
      bookingRequestIds: [FIRST_REQUEST_ID, SECOND_REQUEST_ID],
      side: "VENUE",
    });
  });

  // ── Truncation ────────────────────────────────────────────────────────────

  it("flags AND logs truncation when the owned-place read comes back at the cap", async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const manyPlaces = Array.from({ length: 100 }, (_, index) =>
      buildPlaceRecord({
        id: `4${index.toString().padStart(7, "0")}-0000-4000-8000-000000000000`,
        name: `Venue ${index}`,
      }),
    );
    const { deps } = buildDeps({
      ownedPlacesBySubject: { [`HUMAN:${ACTOR_ID}`]: manyPlaces },
      logger: logger as unknown as ListBookingRequestsDeps["logger"],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    expect(result.ownedPlacesTruncated).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      "booking_requests.list.owned_places_truncated",
      expect.objectContaining({
        scope: "human-venues",
        ownerHumanId: ACTOR_ID,
        ownedPlaceCount: 100,
      }),
    );
  });

  it("returns an empty page (not an error) for a human who owns no venues", async () => {
    const { deps, mocks } = buildDeps();

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    expect(result).toEqual({ requests: [], ownedPlacesTruncated: false });
    expect(mocks.bookingRequests.listForPlaces).toHaveBeenCalledWith({
      placeIds: [],
      statuses: undefined,
    });
  });
});

describe("listBookingRequests — human-venues folds in the actor's orgs", () => {
  it("returns venues owned by the actor's orgs alongside their own, deduped and name-sorted", async () => {
    const ORG_PLACE_ID = "3d3d3d3d-3d3d-4d3d-8d3d-3d3d3d3d3d3d";
    const { deps, mocks } = buildDeps({
      orgMemberships: [{ orgId: ORG_ID, role: "ADMIN" }],
      ownedPlacesBySubject: {
        // "Red Rocks" sorts AFTER "Alpha Hall" — proving the union is
        // re-sorted rather than concatenated subject-by-subject.
        [`HUMAN:${ACTOR_ID}`]: [
          buildPlaceRecord({ id: PLACE_ID, name: "Red Rocks Amphitheatre" }),
        ],
        [`ORGANIZATION:${ORG_ID}`]: [
          buildPlaceRecord({ id: ORG_PLACE_ID, name: "Alpha Hall" }),
          // Co-owned by the person AND their org — must appear ONCE.
          buildPlaceRecord({ id: PLACE_ID, name: "Red Rocks Amphitheatre" }),
        ],
      },
    });

    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    const placeIds = mocks.bookingRequests.listForPlaces.mock.calls[0]![0]
      .placeIds as string[];
    expect(placeIds).toEqual([ORG_PLACE_ID, PLACE_ID]);
  });

  it("still enumerates the actor's own venues when they belong to no org", async () => {
    const { deps, mocks } = buildDeps({
      orgMemberships: [],
      ownedPlacesBySubject: {
        [`HUMAN:${ACTOR_ID}`]: [
          buildPlaceRecord({ id: PLACE_ID, name: "Red Rocks Amphitheatre" }),
        ],
      },
    });

    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    expect(
      mocks.bookingRequests.listForPlaces.mock.calls[0]![0].placeIds,
    ).toEqual([PLACE_ID]);
  });

  it("never enumerates an org the actor does not belong to", async () => {
    const FOREIGN_ORG_ID = "4e4e4e4e-4e4e-4e4e-8e4e-4e4e4e4e4e4e";
    const FOREIGN_ORG_PLACE = "4f4f4f4f-4f4f-4f4f-8f4f-4f4f4f4f4f4f";
    const { deps, mocks } = buildDeps({
      orgMemberships: [],
      ownedPlacesBySubject: {
        [`HUMAN:${ACTOR_ID}`]: [buildPlaceRecord({ id: PLACE_ID })],
        // Present in the world, absent from the actor's memberships — the
        // tenancy boundary this scope must hold.
        [`ORGANIZATION:${FOREIGN_ORG_ID}`]: [
          buildPlaceRecord({ id: FOREIGN_ORG_PLACE, name: "Not Yours" }),
        ],
      },
    });

    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });

    const placeIds = mocks.bookingRequests.listForPlaces.mock.calls[0]![0]
      .placeIds as string[];
    expect(placeIds).not.toContain(FOREIGN_ORG_PLACE);
    expect(mocks.places.listOwnedBySubject).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: FOREIGN_ORG_ID }),
    );
  });
});

describe("listBookingRequests — the personal hub only carries what you can answer", () => {
  const ORG_PLACE_ID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";

  function buildWithRole(role: string) {
    return buildDeps({
      orgMemberships: [{ orgId: ORG_ID, role }],
      ownedPlacesBySubject: {
        [`HUMAN:${ACTOR_ID}`]: [buildPlaceRecord({ id: PLACE_ID })],
        [`ORGANIZATION:${ORG_ID}`]: [
          buildPlaceRecord({ id: ORG_PLACE_ID, name: "Org Room" }),
        ],
      },
    });
  }

  it.each(["OWNER", "ADMIN", "EDITOR"])(
    "folds in an org's venues for a %s (they can respond)",
    async (role) => {
      const { deps, mocks } = buildWithRole(role);
      await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "human-venues",
      });
      expect(
        mocks.bookingRequests.listForPlaces.mock.calls[0]![0].placeIds,
      ).toContain(ORG_PLACE_ID);
    },
  );

  it.each(["VIEWER", "FINANCE", "SCANNER"])(
    "leaves an org's venues OUT for a %s — respond would refuse them",
    async (role) => {
      const { deps, mocks } = buildWithRole(role);
      await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "human-venues",
      });
      const placeIds = mocks.bookingRequests.listForPlaces.mock.calls[0]![0]
        .placeIds as string[];
      expect(placeIds).not.toContain(ORG_PLACE_ID);
      // Their OWN venue is never role-gated — there is no role to hold.
      expect(placeIds).toContain(PLACE_ID);
    },
  );

  it("asks the membership repo for the edit roles only", async () => {
    const { deps, mocks } = buildWithRole("EDITOR");
    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "human-venues",
    });
    expect(mocks.authz.listOrgMembershipsByHumanId).toHaveBeenCalledWith({
      humanId: ACTOR_ID,
      roles: ["OWNER", "ADMIN", "EDITOR"],
    });
  });
});
