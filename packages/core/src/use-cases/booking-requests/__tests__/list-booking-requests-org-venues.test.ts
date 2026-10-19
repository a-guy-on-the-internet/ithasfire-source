import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";

import { listBookingRequests } from "../list-booking-requests";
import type { ListBookingRequestsDeps } from "../list-booking-requests";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  EVENT_ID,
  ORG_ID,
  PLACE_ID,
  SECOND_AGREEMENT_ID,
  type SeededThreadMessage,
  buildAgreementRecord,
  buildBookingRequestRecord,
  buildOrganizerBookingRequestRecord,
  buildPlaceRecord,
  buildStageEventRecord,
  buildStageRepos,
  buildUnreadCountingRepo,
} from "./helpers";

/**
 * `scope: "org-venues"` — the org-level Bookings inbox: every TO_VENUE request
 * across every place the org owns, in ONE page.
 *
 * The load-bearing properties here are the ones that bite hardest if they slip:
 *   - CROSS-ORG ISOLATION: the query is scoped to the org's OWNED places, and a
 *     row for anything else is dropped and reported rather than rendered;
 *   - the owned-place enumeration is the SAME one `countOpenBookingRequests`
 *     uses, so the badge rail and the inbox behind it can't disagree;
 *   - the cut at the owned-place ceiling is SURFACED, never silent;
 *   - one batched unread-count call for the whole page (this scope can span
 *     100 venues — a per-row lookup would be the file's worst N+1).
 */

const SECOND_PLACE_ID = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";
const FOREIGN_PLACE_ID = "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c";
const OTHER_ORG_ID = "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b";
const SECOND_REQUEST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FIRST_REQUEST_ID = buildBookingRequestRecord().id;

type BuildDepsOptions = {
  membership?: OrgMembership | null;
  /** Places the org owns, keyed by org id — lets a test model TWO orgs. */
  ownedPlacesByOrg?: Record<string, PlaceRecord[]>;
  /** Every TO_VENUE row in the "database", keyed by placeId. */
  rowsByPlaceId?: Record<string, BookingRequestRecord[]>;
  /**
   * Rows the repo returns REGARDLESS of the requested place set — the only way
   * to exercise the cross-org backstop, which is unreachable through a
   * correctly-behaving adapter.
   */
  leakedRecords?: BookingRequestRecord[];
  messages?: SeededThreadMessage[];
  reportError?: ListBookingRequestsDeps["reportError"];
  logger?: ListBookingRequestsDeps["logger"];
  /** Agreements/events "in the database" for the stage projection. */
  agreements?: AgreementRecord[];
  events?: EventRecord[];
};

function buildDeps(options: BuildDepsOptions = {}) {
  const rowsByPlaceId = options.rowsByPlaceId ?? {};

  // Mirrors the port contract: ONE query for the whole place set, TO_VENUE
  // only, and nothing outside the requested places (the adapter's
  // `placeId: { in: [...] }`).
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
      async ({ ownerId }: { ownerId: string }) =>
        options.ownedPlacesByOrg?.[ownerId] ?? [],
    ),
    getById: vi.fn(async () => null),
  };

  const authz = {
    getOrgMembership: vi.fn(
      async ({ orgId }: { orgId: string }) =>
        options.membership && options.membership.orgId === orgId
          ? options.membership
          : null,
    ),
    getOrgMemberships: vi.fn(async () => []),
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

  // The unread rule lives in ONE place (the shared in-memory repo), never
  // re-implemented per suite — see `buildUnreadCountingRepo`.
  const bookingRequestMessages = buildUnreadCountingRepo(options.messages);

  // Stage projection (request → agreement → event). Empty by default so the
  // pre-existing assertions keep their no-agreement shape.
  const stage = buildStageRepos({
    ...(options.agreements ? { agreements: options.agreements } : {}),
    ...(options.events ? { events: options.events } : {}),
  });

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
    mocks: {
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
    },
  };
}

/** Membership-any is enough to view, exactly like the single-venue inbox. */
function membership(
  role: OrgMembership["role"] = "VIEWER",
  orgId = ORG_ID,
): OrgMembership {
  return { orgId, humanId: ACTOR_ID, role } as OrgMembership;
}

function ownedByTestOrg(): Record<string, PlaceRecord[]> {
  return {
    [ORG_ID]: [
      buildPlaceRecord({ id: PLACE_ID, name: "The Ember Room" }),
      buildPlaceRecord({ id: SECOND_PLACE_ID, name: "The Quiet Corner" }),
    ],
  };
}

describe("listBookingRequests — scope: org-venues", () => {
  it("returns requests across EVERY owned venue in one page, grouped-ready", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlacesByOrg: ownedByTestOrg(),
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
      scope: "org-venues",
      orgId: ORG_ID,
    });

    // placeId + placeName are populated on THIS path (the adapter denormalizes
    // the venue name on every read) — that is what lets the org page group by
    // venue without a second query.
    expect(result.requests.map((r) => [r.id, r.placeId, r.placeName])).toEqual([
      [FIRST_REQUEST_ID, PLACE_ID, "Test Venue"],
      [SECOND_REQUEST_ID, SECOND_PLACE_ID, "The Quiet Corner"],
    ]);

    // ONE set-shaped repo call for every owned venue — never a per-place loop.
    expect(mocks.bookingRequests.listForPlaces).toHaveBeenCalledTimes(1);
    expect(mocks.bookingRequests.listForPlaces).toHaveBeenCalledWith({
      placeIds: [PLACE_ID, SECOND_PLACE_ID],
      statuses: undefined,
    });
    expect(mocks.bookingRequests.listForPlace).not.toHaveBeenCalled();
  });

  it("uses the SAME owned-place enumeration as countOpenBookingRequests", async () => {
    // A second way to answer "which places does this org own" is a real bug
    // class: a venue present in the badge rail and absent from the inbox reads
    // as "quiet", not as "we never looked".
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlacesByOrg: ownedByTestOrg(),
    });

    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
    });

    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledTimes(1);
    expect(mocks.places.listOwnedBySubject).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      limit: 100,
    });
  });

  it("forwards a status filter to the set-shaped query", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlacesByOrg: ownedByTestOrg(),
    });

    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
      statuses: ["PENDING", "VIEWED"],
    });

    expect(mocks.bookingRequests.listForPlaces).toHaveBeenCalledWith({
      placeIds: [PLACE_ID, SECOND_PLACE_ID],
      statuses: ["PENDING", "VIEWED"],
    });
  });

  // ── Cross-org isolation (the #1 bug class) ───────────────────────────────

  it("an org CANNOT see another org's venue requests", async () => {
    const { deps, mocks } = buildDeps({
      // The actor is a member of OTHER_ORG only.
      membership: membership("OWNER", OTHER_ORG_ID),
      ownedPlacesByOrg: {
        // Org A owns the venue with the requests…
        [ORG_ID]: [buildPlaceRecord({ id: PLACE_ID })],
        // …org B owns nothing.
        [OTHER_ORG_ID]: [],
      },
      rowsByPlaceId: { [PLACE_ID]: [buildBookingRequestRecord()] },
    });

    // Reading org B's inbox never reaches org A's venue.
    const own = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: OTHER_ORG_ID,
    });
    expect(own.requests).toEqual([]);
    expect(mocks.bookingRequests.listForPlaces).toHaveBeenCalledWith({
      placeIds: [],
      statuses: undefined,
    });

    // And asking for org A's inbox directly fails the membership gate.
    await expect(
      listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "org-venues",
        orgId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("drops AND reports a row for a place the org does not own (backstop)", async () => {
    // Unreachable through a correct adapter; if it ever happens the leak must
    // page someone rather than quietly render in a stranger's inbox.
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
      membership: membership(),
      ownedPlacesByOrg: { [ORG_ID]: [buildPlaceRecord({ id: PLACE_ID })] },
      rowsByPlaceId: { [PLACE_ID]: [buildBookingRequestRecord()] },
      leakedRecords: [foreign],
      reportError,
      logger: logger as unknown as ListBookingRequestsDeps["logger"],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
    });

    expect(result.requests.map((r) => r.id)).toEqual([FIRST_REQUEST_ID]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "listBookingRequests", step: "orgVenueScope" },
      extra: {
        orgId: ORG_ID,
        bookingRequestId: foreign.id,
        placeId: FOREIGN_PLACE_ID,
      },
    });
    // The log line stays alongside the report (never demoted to warn).
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.list.foreign_place_row_dropped",
      expect.objectContaining({ orgId: ORG_ID, placeId: FOREIGN_PLACE_ID }),
    );
  });

  it("a throwing reporter never breaks the drop-the-foreign-row backstop", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down too");
    });
    const { deps } = buildDeps({
      membership: membership(),
      ownedPlacesByOrg: { [ORG_ID]: [buildPlaceRecord({ id: PLACE_ID })] },
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
        scope: "org-venues",
        orgId: ORG_ID,
      }),
    ).resolves.toMatchObject({ requests: [{ id: FIRST_REQUEST_ID }] });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("never surfaces a TO_PERFORMER row (direction scope is the repo's, backstopped here)", async () => {
    // The adapter's WHERE pins `direction: "TO_VENUE"` (NFR-001). Even a leaked
    // TO_PERFORMER row cannot land in this scope: its placeId is null, so the
    // owned-place backstop drops it.
    const reportError = vi.fn();
    const { deps } = buildDeps({
      membership: membership(),
      ownedPlacesByOrg: { [ORG_ID]: [buildPlaceRecord({ id: PLACE_ID })] },
      rowsByPlaceId: { [PLACE_ID]: [buildBookingRequestRecord()] },
      leakedRecords: [buildOrganizerBookingRequestRecord({ id: SECOND_REQUEST_ID })],
      reportError,
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
    });

    expect(result.requests.map((r) => r.direction)).toEqual(["TO_VENUE"]);
    expect(result.requests.map((r) => r.id)).toEqual([FIRST_REQUEST_ID]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  // ── Booking STAGE projection: ONE batched pass for the whole org page ─────

  it("projects agreement + event stage across every owned venue in ONE pair of calls", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlacesByOrg: ownedByTestOrg(),
      rowsByPlaceId: {
        [PLACE_ID]: [
          buildBookingRequestRecord({
            status: "ACCEPTED",
            agreementId: AGREEMENT_ID,
          }),
        ],
        [SECOND_PLACE_ID]: [
          buildBookingRequestRecord({
            id: SECOND_REQUEST_ID,
            placeId: SECOND_PLACE_ID,
            status: "ACCEPTED",
            agreementId: SECOND_AGREEMENT_ID,
          }),
        ],
      },
      agreements: [
        buildAgreementRecord({ status: "ACCEPTED", eventId: EVENT_ID }),
        // Draft anchor only — the state most booked events actually sit in.
        buildAgreementRecord({
          id: SECOND_AGREEMENT_ID,
          status: "PROPOSED",
          draftEventId: EVENT_ID,
        }),
      ],
      events: [
        buildStageEventRecord({
          id: EVENT_ID,
          status: "PUBLISHED",
          startsAt: new Date("2026-09-19T00:00:00.000Z"),
        }),
      ],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
    });

    // The org inbox spans up to 100 venues — a per-row lookup here would be
    // the file's worst N+1.
    expect(mocks.agreements.findManyByIds).toHaveBeenCalledTimes(1);
    expect(mocks.agreements.findManyByIds).toHaveBeenCalledWith([
      AGREEMENT_ID,
      SECOND_AGREEMENT_ID,
    ]);
    // Distinct event ids only — both agreements point at the same show.
    expect(mocks.events.findManyByIds).toHaveBeenCalledTimes(1);
    expect(mocks.events.findManyByIds).toHaveBeenCalledWith([EVENT_ID]);

    expect(
      result.requests.map((r) => [r.agreementStatus, r.eventStatus]),
    ).toEqual([
      ["ACCEPTED", "PUBLISHED"],
      ["PROPOSED", "PUBLISHED"],
    ]);
  });

  it("never looks up the agreement of a row the cross-org backstop dropped", async () => {
    // The stage pass runs on the SCOPED rows, so a foreign leak cannot even
    // cause a read of another org's agreement.
    const FOREIGN_AGREEMENT_ID = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f5f";
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlacesByOrg: { [ORG_ID]: [buildPlaceRecord({ id: PLACE_ID })] },
      rowsByPlaceId: {
        [PLACE_ID]: [
          buildBookingRequestRecord({
            status: "ACCEPTED",
            agreementId: AGREEMENT_ID,
          }),
        ],
      },
      leakedRecords: [
        buildBookingRequestRecord({
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          placeId: FOREIGN_PLACE_ID,
          status: "ACCEPTED",
          agreementId: FOREIGN_AGREEMENT_ID,
        }),
      ],
      agreements: [
        buildAgreementRecord({ status: "ACCEPTED" }),
        buildAgreementRecord({
          id: FOREIGN_AGREEMENT_ID,
          status: "FULFILLED",
        }),
      ],
      reportError: vi.fn(),
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
    });

    expect(mocks.agreements.findManyByIds).toHaveBeenCalledWith([
      AGREEMENT_ID,
    ]);
    expect(result.requests.map((r) => r.agreementStatus)).toEqual(["ACCEPTED"]);
  });

  // ── Unread counts: ONE batched call for the whole page ────────────────────

  it("resolves unread counts for every venue in ONE call, side VENUE", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlacesByOrg: ownedByTestOrg(),
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
        // The act's reply — what the badge exists for.
        { bookingRequestId: SECOND_REQUEST_ID, authorSide: "PERFORMER" },
        // The org's own outbound message must NOT badge its own row.
        { bookingRequestId: SECOND_REQUEST_ID, authorSide: "VENUE" },
        // Nor may a LEDGER ENTRY. Unread means "a human is waiting on you",
        // and every lifecycle transition now lands on this thread — counting
        // entries would badge the org's inbox for its own actions.
        {
          bookingRequestId: FIRST_REQUEST_ID,
          authorSide: "SYSTEM",
          body: "",
          systemKind: "booking_request.viewed",
          systemData: {},
        },
      ],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
    });

    expect(result.requests.map((r) => [r.id, r.unreadMessageCount])).toEqual([
      [FIRST_REQUEST_ID, 0],
      [SECOND_REQUEST_ID, 1],
    ]);
    expect(
      mocks.bookingRequestMessages.countUnreadByRequest,
    ).toHaveBeenCalledTimes(1);
    // The org inbox reads as the VENUE side — the enum's "non-act party" slot
    // on a TO_VENUE thread (side table in messages/_shared/thread-access.ts).
    expect(
      mocks.bookingRequestMessages.countUnreadByRequest,
    ).toHaveBeenCalledWith({
      bookingRequestIds: [FIRST_REQUEST_ID, SECOND_REQUEST_ID],
      side: "VENUE",
    });
  });

  it("does not query counts for an org with no requests", async () => {
    const { deps, mocks } = buildDeps({
      membership: membership(),
      ownedPlacesByOrg: ownedByTestOrg(),
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
    });

    expect(result.requests).toEqual([]);
    expect(
      mocks.bookingRequestMessages.countUnreadByRequest,
    ).not.toHaveBeenCalled();
  });

  // ── Truncation is surfaced, never silent ─────────────────────────────────

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
      membership: membership(),
      ownedPlacesByOrg: { [ORG_ID]: manyPlaces },
      logger: logger as unknown as ListBookingRequestsDeps["logger"],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
    });

    // A capped inbox must never read as "you have no more requests".
    expect(result.ownedPlacesTruncated).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      "booking_requests.list.owned_places_truncated",
      expect.objectContaining({ orgId: ORG_ID, ownedPlaceCount: 100 }),
    );
  });

  it("reports no truncation below the cap", async () => {
    const { deps } = buildDeps({
      membership: membership(),
      ownedPlacesByOrg: ownedByTestOrg(),
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
    });

    expect(result.ownedPlacesTruncated).toBe(false);
  });

  it("omits the truncation flag entirely on scopes with no owned-place read", async () => {
    // Absent means "not applicable to this scope", not "false" — the field only
    // has meaning where an owned-place enumeration happened.
    const { deps } = buildDeps({ membership: membership() });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "performer",
    });

    expect(result.ownedPlacesTruncated).toBeUndefined();
  });

  // ── Authz + input ────────────────────────────────────────────────────────

  it("requires org membership (any role is enough)", async () => {
    const denied = buildDeps({
      membership: null,
      ownedPlacesByOrg: ownedByTestOrg(),
    });
    await expect(
      listBookingRequests(denied.deps, {
        actorHumanId: ACTOR_ID,
        scope: "org-venues",
        orgId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    // Nothing is read once authz fails.
    expect(denied.mocks.places.listOwnedBySubject).not.toHaveBeenCalled();
    expect(denied.mocks.bookingRequests.listForPlaces).not.toHaveBeenCalled();

    const allowed = buildDeps({
      membership: membership("VIEWER"),
      ownedPlacesByOrg: ownedByTestOrg(),
      rowsByPlaceId: { [PLACE_ID]: [buildBookingRequestRecord()] },
    });
    const result = await listBookingRequests(allowed.deps, {
      actorHumanId: ACTOR_ID,
      scope: "org-venues",
      orgId: ORG_ID,
    });
    expect(result.requests).toHaveLength(1);
  });

  it("requires orgId", async () => {
    const { deps } = buildDeps({ membership: membership() });

    await expect(
      listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "org-venues",
      }),
    ).rejects.toMatchObject({ message: "org_id_required" });
  });

  it("rejects a non-uuid orgId and unknown keys (.strict)", async () => {
    const { deps } = buildDeps({ membership: membership() });

    await expect(
      listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "org-venues",
        orgId: "not-a-uuid",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "org-venues",
        orgId: ORG_ID,
        nope: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
