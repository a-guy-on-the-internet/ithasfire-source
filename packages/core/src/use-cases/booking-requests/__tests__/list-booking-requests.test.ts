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
  SECOND_EVENT_ID,
  type SeededThreadMessage,
  buildAgreementRecord,
  buildBookingRequestRecord,
  buildPlaceRecord,
  buildStageEventRecord,
  buildStageRepos,
  buildUnreadCountingRepo,
} from "./helpers";

type BuildDepsOptions = {
  place?: PlaceRecord | null;
  placeMemberships?: OrgMembership[];
  orgMembership?: OrgMembership | null;
  records?: BookingRequestRecord[];
  humanRecords?: { id: string; name: string | null }[];
  orgRecords?: { id: string; name: string }[];
  reportError?: ListBookingRequestsDeps["reportError"];
  logger?: ListBookingRequestsDeps["logger"];
  /**
   * Seeded thread messages the fake unread counter groups. Left empty by
   * default so every pre-existing assertion keeps its quiet-inbox shape.
   */
  messages?: SeededThreadMessage[];
  /** Force the unread lookup to blow up (deliberate-swallow coverage). */
  unreadError?: Error;
  /**
   * Drop the messages repo entirely — a composition root that forgot to wire
   * it. NOT the same thing as `unreadError`, and must NOT degrade quietly.
   */
  omitMessagesRepo?: boolean;
  // ── Booking STAGE (request → agreement → event) ──────────────────────────
  /** Agreements "in the database" for the stage projection. */
  agreements?: AgreementRecord[];
  /** Events "in the database" for the stage projection. */
  events?: EventRecord[];
  /** Force the agreement set-fetch to blow up (deliberate-swallow coverage). */
  agreementsError?: Error;
  /** Force the event set-fetch to blow up (same swallow, second hop). */
  eventsError?: Error;
  /** Drop the agreements repo entirely — a wiring omission, not a query fault. */
  omitAgreementsRepo?: boolean;
  /** Drop the events repo entirely — same class as `omitAgreementsRepo`. */
  omitEventsRepo?: boolean;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const records = options.records ?? [buildBookingRequestRecord()];
  const bookingRequests = {
    listForPlace: vi.fn(async () => records),
    listForPerformer: vi.fn(async () => records),
    // The bill (lineup v2): pre-bill rows — no acts on any request.
    listActsForRequests: vi.fn(async () => []),
  };
  // Mirrors the port contract (ONE grouped call, zero-unread requests ABSENT
  // from the map, SYSTEM entries never counted) because it IS the shared
  // in-memory repo — see `buildUnreadCountingRepo`.
  const bookingRequestMessages = buildUnreadCountingRepo(options.messages, {
    ...(options.unreadError ? { unreadError: options.unreadError } : {}),
  });
  const places = {
    getById: vi.fn(async () =>
      options.place === undefined ? buildPlaceRecord() : options.place,
    ),
  };
  const authz = {
    getOrgMemberships: vi.fn(async () => options.placeMemberships ?? []),
    getOrgMembership: vi.fn(async () => options.orgMembership ?? null),
  };
  const humans = {
    getByIds: vi.fn(
      async () =>
        options.humanRecords ?? [{ id: ACTOR_ID, name: "Test Performer" }],
    ),
  };
  const organizations = {
    getByIds: vi.fn(
      async () => options.orgRecords ?? [{ id: ORG_ID, name: "Test Org" }],
    ),
  };

  // Stage projection repos (agreement + event), spied for the batching
  // assertions — see `buildStageRepos`.
  const stage = buildStageRepos({
    ...(options.agreements ? { agreements: options.agreements } : {}),
    ...(options.events ? { events: options.events } : {}),
    ...(options.agreementsError
      ? { agreementsError: options.agreementsError }
      : {}),
    ...(options.eventsError ? { eventsError: options.eventsError } : {}),
  });

  const deps: ListBookingRequestsDeps = {
    repos: {
      bookingRequests,
      places,
      authz,
      humans,
      organizations,
      ...(options.omitMessagesRepo ? {} : { bookingRequestMessages }),
      ...(options.omitAgreementsRepo ? {} : { agreements: stage.agreements }),
      ...(options.omitEventsRepo ? {} : { events: stage.events }),
      bookingHolds: stage.bookingHolds,
      bookingTags: stage.bookingTags,
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

/** Anonymous embed inquiry row (booking-request-embed-button FR-005/FR-006). */
function buildAnonymousRecord(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return buildBookingRequestRecord({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: "The Basement Tapes",
    contactEmail: "band@example.com",
    source: "EMBED",
    embedId: "embed-widget-1",
    ...overrides,
  });
}

/**
 * A row violating the sender invariant (neither identity) — can only exist
 * through DB corruption / out-of-band writes; the CHECK constraint blocks new
 * ones. `getBookingRequestSender` throws on it.
 */
function buildCorruptRecord(): BookingRequestRecord {
  return buildBookingRequestRecord({
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: null,
    contactEmail: null,
  });
}

describe("listBookingRequests", () => {
  it("returns the venue inbox for a place owner (no verification gate)", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({ verificationStatus: "UNVERIFIED" }),
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      id: buildBookingRequestRecord().id,
      placeName: "Test Venue",
      performerDisplayName: "Test Performer",
      status: "PENDING",
    });
    expect(mocks.bookingRequests.listForPlace).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      statuses: undefined,
    });
  });

  it("batch-resolves performer display names (one lookup per owner kind, no N+1)", async () => {
    const { deps, mocks } = buildDeps({
      records: [
        buildBookingRequestRecord(),
        buildBookingRequestRecord({
          id: "99999999-9999-4999-8999-999999999999",
        }),
        buildBookingRequestRecord({
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          performerOwnerType: "organization",
          performerOwnerId: ORG_ID,
        }),
      ],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    // Distinct owner refs fetched once per kind — never per row.
    expect(mocks.humans.getByIds).toHaveBeenCalledTimes(1);
    expect(mocks.humans.getByIds).toHaveBeenCalledWith([ACTOR_ID]);
    expect(mocks.organizations.getByIds).toHaveBeenCalledTimes(1);
    expect(mocks.organizations.getByIds).toHaveBeenCalledWith([ORG_ID]);

    expect(result.requests.map((r) => r.performerDisplayName)).toEqual([
      "Test Performer",
      "Test Performer",
      "Test Org",
    ]);
  });

  it("falls back to a null display name for unresolved or nameless owners", async () => {
    const { deps, mocks } = buildDeps({
      humanRecords: [{ id: ACTOR_ID, name: null }],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    expect(result.requests[0]?.performerDisplayName).toBeNull();
    // No org senders in the list — the org lookup is skipped entirely.
    expect(mocks.organizations.getByIds).not.toHaveBeenCalled();
  });

  // ── Anonymous embed inquiries in the inbox (FR-006) ────────────────────────

  it("returns a mixed owned+anonymous inbox: contact card fields for anonymous, owner fields null", async () => {
    const { deps, mocks } = buildDeps({
      records: [buildBookingRequestRecord(), buildAnonymousRecord()],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    expect(result.requests).toHaveLength(2);

    const owned = result.requests[0]!;
    expect(owned).toMatchObject({
      performerOwnerType: "human",
      performerOwnerId: ACTOR_ID,
      performerDisplayName: "Test Performer",
      contactName: null,
      contactEmail: null,
      source: "PLATFORM",
    });

    const anonymous = result.requests[1]!;
    expect(anonymous).toMatchObject({
      performerOwnerType: null,
      performerOwnerId: null,
      // Anonymous inquiries display as their submitted contact name.
      performerDisplayName: "The Basement Tapes",
      contactName: "The Basement Tapes",
      contactEmail: "band@example.com",
      source: "EMBED",
    });

    // Anonymous rows never leak into the display-name resolution batches.
    expect(mocks.humans.getByIds).toHaveBeenCalledWith([ACTOR_ID]);
    expect(mocks.organizations.getByIds).not.toHaveBeenCalled();
  });

  it("carries the inquirer-outreach delivery stamp onto the summary", async () => {
    // booking-inquirer-outreach: the columns existed but stopped at core, so
    // "we mailed the venue's reply and it hard-bounced" reached no consumer.
    // The venue inbox is the only place a human can learn it.
    const at = new Date("2026-09-05T09:00:00.000Z");
    const { deps } = buildDeps({
      records: [
        buildAnonymousRecord({
          inquirerEmailMessageId: "<msg-1@ithasfire.com>",
          inquirerEmailUndeliverableAt: at,
          inquirerEmailUndeliverableStatus: "COMPLAINED",
        }),
      ],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    expect(result.requests[0]).toMatchObject({
      inquirerEmailUndeliverableAt: at,
      // The CAUSE travels with the timestamp: a bounce and a spam complaint
      // are different next steps for the venue, never one "delivery failed".
      inquirerEmailUndeliverableStatus: "COMPLAINED",
    });
  });

  it("leaves the delivery stamp null on an inquiry we never failed to reach", async () => {
    const { deps } = buildDeps({ records: [buildAnonymousRecord()] });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    expect(result.requests[0]).toMatchObject({
      inquirerEmailUndeliverableAt: null,
      inquirerEmailUndeliverableStatus: null,
    });
  });

  it("skips display-name lookups entirely for an all-anonymous inbox", async () => {
    const { deps, mocks } = buildDeps({ records: [buildAnonymousRecord()] });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    expect(result.requests[0]?.performerDisplayName).toBe("The Basement Tapes");
    expect(mocks.humans.getByIds).not.toHaveBeenCalled();
    expect(mocks.organizations.getByIds).not.toHaveBeenCalled();
  });

  // ── Corrupt-row resilience (belt-and-braces + ReporterPort convention) ─────

  describe("corrupt-row skip reporting", () => {
    it("skips a sender-invariant-violating row, returns the rest, and reports it", async () => {
      // One poisoned row must never take down the whole venue inbox; and the
      // skip must be VISIBLE to operators (reportError), not just logged.
      const reportError = vi.fn();
      const { deps } = buildDeps({
        records: [
          buildBookingRequestRecord(),
          buildCorruptRecord(),
          buildAnonymousRecord(),
        ],
        reportError,
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests.map((r) => r.id)).toEqual([
        buildBookingRequestRecord().id,
        buildAnonymousRecord().id,
      ]);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        tags: { useCase: "listBookingRequests" },
        extra: {
          bookingRequestId: buildCorruptRecord().id,
          placeId: PLACE_ID,
        },
      });
    });

    it("still skips-and-returns when reportError is not wired", async () => {
      const { deps } = buildDeps({
        records: [buildCorruptRecord(), buildBookingRequestRecord()],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]?.id).toBe(buildBookingRequestRecord().id);
    });

    it("a throwing reporter never breaks the skip-one-row fallback", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const { deps } = buildDeps({
        records: [buildCorruptRecord(), buildBookingRequestRecord()],
        reportError,
      });

      await expect(
        listBookingRequests(deps, {
          actorHumanId: ACTOR_ID,
          scope: "venue",
          placeId: PLACE_ID,
        }),
      ).resolves.toMatchObject({
        requests: [{ id: buildBookingRequestRecord().id }],
      });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("does not call reportError for a healthy list", async () => {
      const reportError = vi.fn();
      const { deps } = buildDeps({
        records: [buildBookingRequestRecord(), buildAnonymousRecord()],
        reportError,
      });

      await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(reportError).not.toHaveBeenCalled();
    });
  });

  // ── Per-SIDE unread message counts (list-surface badges) ──────────────────
  // Per-side, not per-human: one shared `readAt`, so a teammate's read clears
  // the badge for everyone on that side (documented v1 trade-off).

  describe("unreadMessageCount", () => {
    const SECOND_REQUEST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const FIRST_REQUEST_ID = buildBookingRequestRecord().id;

    it("counts a PERFORMER-authored unread message for the venue viewer, and never the venue's own", async () => {
      const { deps, mocks } = buildDeps({
        messages: [
          // The counterparty's reply — this is what the badge exists for.
          { bookingRequestId: FIRST_REQUEST_ID, authorSide: "PERFORMER" },
          // The venue's OWN outbound message, still unread by the act. It
          // must NOT badge the venue's own inbox row.
          { bookingRequestId: FIRST_REQUEST_ID, authorSide: "VENUE" },
          // Already-stamped counterparty message — read is read.
          {
            bookingRequestId: FIRST_REQUEST_ID,
            authorSide: "PERFORMER",
            readAt: new Date("2026-06-05T00:00:00.000Z"),
          },
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]?.unreadMessageCount).toBe(1);
      // The venue inbox reads as the VENUE side.
      expect(
        mocks.bookingRequestMessages.countUnreadByRequest,
      ).toHaveBeenCalledWith({
        bookingRequestIds: [FIRST_REQUEST_ID],
        side: "VENUE",
      });
    });

    // INVERTED with the system-entry migration: this used to assert a SYSTEM
    // row badged the venue inbox. It must not — otherwise every lifecycle
    // transition (which all become ledger entries) would badge the inbox for
    // something nobody sent, including your own actions.
    it("never counts SYSTEM entries as unread for the venue viewer", async () => {
      const { deps } = buildDeps({
        messages: [
          { bookingRequestId: FIRST_REQUEST_ID, authorSide: "SYSTEM" },
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]?.unreadMessageCount).toBe(0);
    });

    it("still counts a HUMAN message sitting next to a SYSTEM entry", async () => {
      // The other half of the guarantee: excluding entries must not silence
      // real mail on the same thread.
      const { deps } = buildDeps({
        messages: [
          { bookingRequestId: FIRST_REQUEST_ID, authorSide: "SYSTEM" },
          { bookingRequestId: FIRST_REQUEST_ID, authorSide: "PERFORMER" },
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]?.unreadMessageCount).toBe(1);
    });

    it("mirrors for the performer sent list: VENUE messages count, the act's own do not", async () => {
      const { deps, mocks } = buildDeps({
        messages: [
          { bookingRequestId: FIRST_REQUEST_ID, authorSide: "VENUE" },
          { bookingRequestId: FIRST_REQUEST_ID, authorSide: "VENUE" },
          { bookingRequestId: FIRST_REQUEST_ID, authorSide: "PERFORMER" },
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "performer",
      });

      expect(result.requests[0]?.unreadMessageCount).toBe(2);
      expect(
        mocks.bookingRequestMessages.countUnreadByRequest,
      ).toHaveBeenCalledWith({
        bookingRequestIds: [FIRST_REQUEST_ID],
        side: "PERFORMER",
      });
    });

    it("defaults requests absent from the count map to 0", async () => {
      const { deps } = buildDeps({
        records: [
          buildBookingRequestRecord(),
          buildBookingRequestRecord({ id: SECOND_REQUEST_ID }),
        ],
        // Only the SECOND request has any unread traffic; the first is absent
        // from the map entirely and must read 0, not undefined.
        messages: [
          { bookingRequestId: SECOND_REQUEST_ID, authorSide: "PERFORMER" },
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests.map((r) => [r.id, r.unreadMessageCount])).toEqual([
        [FIRST_REQUEST_ID, 0],
        [SECOND_REQUEST_ID, 1],
      ]);
    });

    it("batches: ONE count call for a multi-row list, never one per row", async () => {
      const { deps, mocks } = buildDeps({
        records: [
          buildBookingRequestRecord(),
          buildBookingRequestRecord({ id: SECOND_REQUEST_ID }),
          buildAnonymousRecord(),
        ],
      });

      await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(
        mocks.bookingRequestMessages.countUnreadByRequest,
      ).toHaveBeenCalledTimes(1);
      expect(
        mocks.bookingRequestMessages.countUnreadByRequest,
      ).toHaveBeenCalledWith({
        bookingRequestIds: [
          FIRST_REQUEST_ID,
          SECOND_REQUEST_ID,
          buildAnonymousRecord().id,
        ],
        side: "VENUE",
      });
    });

    it("does not query counts for an empty list", async () => {
      const { deps, mocks } = buildDeps({ records: [] });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests).toEqual([]);
      expect(
        mocks.bookingRequestMessages.countUnreadByRequest,
      ).not.toHaveBeenCalled();
    });

    // ── Deliberate swallow (ReporterPort convention) ────────────────────────

    it("degrades to 0 and REPORTS when the unread lookup fails", async () => {
      // A dead count query must not blank someone's inbox — but the
      // degradation has to be visible to operators, not silently forever-quiet.
      const unreadError = new Error("count query exploded");
      const reportError = vi.fn();
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };
      const { deps } = buildDeps({
        records: [buildBookingRequestRecord()],
        unreadError,
        reportError,
        logger: logger as unknown as ListBookingRequestsDeps["logger"],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]?.unreadMessageCount).toBe(0);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(unreadError, {
        tags: { useCase: "listBookingRequests", step: "unreadCounts" },
        extra: { scope: "venue", side: "VENUE", requestCount: 1 },
      });
      // The log line stays alongside the report (never demoted to warn).
      expect(logger.error).toHaveBeenCalledWith(
        "booking_requests.list.unread_counts_failed",
        expect.objectContaining({ scope: "venue", side: "VENUE" }),
      );
    });

    it("a throwing reporter never breaks the degrade-to-zero fallback", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const { deps } = buildDeps({
        unreadError: new Error("count query exploded"),
        reportError,
      });

      await expect(
        listBookingRequests(deps, {
          actorHumanId: ACTOR_ID,
          scope: "venue",
          placeId: PLACE_ID,
        }),
      ).resolves.toMatchObject({ requests: [{ unreadMessageCount: 0 }] });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("still degrades when reportError is not wired", async () => {
      const { deps } = buildDeps({
        unreadError: new Error("count query exploded"),
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]?.unreadMessageCount).toBe(0);
    });

    // ── Unwired repo is NOT the same class of failure as a dead query ───────

    it("THROWS NOT_CONFIGURED when the messages repo is unwired (never degrades)", async () => {
      // A transient query failure self-heals; a missing repo is permanent and
      // would ship a badge that reads 0 forever while every list renders
      // green. Loud beats silently-dead — same guard as `messagesIn`.
      const reportError = vi.fn();
      const { deps } = buildDeps({ omitMessagesRepo: true, reportError });

      await expect(
        listBookingRequests(deps, {
          actorHumanId: ACTOR_ID,
          scope: "venue",
          placeId: PLACE_ID,
        }),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
      // Not routed through the deliberate-swallow branch.
      expect(reportError).not.toHaveBeenCalled();
    });

    it("throws for an unwired repo even when the page is EMPTY", async () => {
      // The guard runs before the empty-page short-circuit so a wiring
      // omission cannot hide until someone happens to have a request.
      const { deps } = buildDeps({ omitMessagesRepo: true, records: [] });

      await expect(
        listBookingRequests(deps, {
          actorHumanId: ACTOR_ID,
          scope: "venue",
          placeId: PLACE_ID,
        }),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    });
  });

  // ── Booking STAGE projection (request → agreement → event) ────────────────
  // The row's `status` describes the REQUEST only. These four fields are what
  // let a stage rail distinguish "accepted, agreement still a draft" from
  // "accepted, terms agreed, event on sale".

  describe("stage projection: agreementStatus / eventId / eventStatus / eventStartsAt", () => {
    const SECOND_REQUEST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const FIRST_REQUEST_ID = buildBookingRequestRecord().id;
    const EVENT_STARTS_AT = new Date("2026-09-19T00:00:00.000Z");

    /** An ACCEPTED request carrying the agreement FK. */
    function buildAcceptedRecord(
      overrides: Partial<BookingRequestRecord> = {},
    ): BookingRequestRecord {
      return buildBookingRequestRecord({
        status: "ACCEPTED",
        agreementId: AGREEMENT_ID,
        ...overrides,
      });
    }

    it("reports all four fields null — and asks the DB nothing — when no row has an agreement", async () => {
      const { deps, mocks } = buildDeps({
        records: [buildBookingRequestRecord()],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]).toMatchObject({
        agreementId: null,
        agreementStatus: null,
        eventId: null,
        eventStatus: null,
        eventStartsAt: null,
      });
      // The common inbox costs ZERO extra queries.
      expect(mocks.agreements.findManyByIds).not.toHaveBeenCalled();
      expect(mocks.events.findManyByIds).not.toHaveBeenCalled();
    });

    it("a DRAFT agreement with no event reports DRAFT and null event fields (and skips the event query)", async () => {
      const { deps, mocks } = buildDeps({
        records: [buildAcceptedRecord()],
        agreements: [buildAgreementRecord({ status: "DRAFT" })],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]).toMatchObject({
        agreementId: AGREEMENT_ID,
        agreementStatus: "DRAFT",
        eventId: null,
        eventStatus: null,
        eventStartsAt: null,
      });
      expect(mocks.agreements.findManyByIds).toHaveBeenCalledWith([
        AGREEMENT_ID,
      ]);
      // Nothing to look up — no agreement carries either link column.
      expect(mocks.events.findManyByIds).not.toHaveBeenCalled();
    });

    it("FINDS the event through draftEventId alone — the state a booked event spends most of its life in", async () => {
      // The case a naive `eventId`-only projection misses entirely: finalize
      // can stay blocked on payout readiness indefinitely, so most real
      // bookings sit here.
      const { deps } = buildDeps({
        records: [buildAcceptedRecord()],
        agreements: [
          buildAgreementRecord({
            status: "ACCEPTED",
            eventId: null,
            draftEventId: EVENT_ID,
          }),
        ],
        events: [
          buildStageEventRecord({
            id: EVENT_ID,
            status: "DRAFT",
            startsAt: EVENT_STARTS_AT,
          }),
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]).toMatchObject({
        agreementStatus: "ACCEPTED",
        eventId: EVENT_ID,
        eventStatus: "DRAFT",
        eventStartsAt: EVENT_STARTS_AT,
      });
    });

    it("the FINALIZED eventId wins when both link columns are set", async () => {
      // Same precedence contract as `AgreementsRepo.findByLinkedEventId`: an
      // event can be one agreement's stale draft and another's finalized show,
      // and the money link is the only defensible answer.
      const { deps, mocks } = buildDeps({
        records: [buildAcceptedRecord()],
        agreements: [
          buildAgreementRecord({
            status: "ACCEPTED",
            eventId: EVENT_ID,
            draftEventId: SECOND_EVENT_ID,
          }),
        ],
        events: [
          buildStageEventRecord({
            id: EVENT_ID,
            status: "PUBLISHED",
            startsAt: EVENT_STARTS_AT,
          }),
          buildStageEventRecord({
            id: SECOND_EVENT_ID,
            status: "CANCELLED",
            startsAt: new Date("2026-01-01T00:00:00.000Z"),
          }),
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]).toMatchObject({
        eventId: EVENT_ID,
        eventStatus: "PUBLISHED",
        eventStartsAt: EVENT_STARTS_AT,
      });
      // The stale draft is never even fetched.
      expect(mocks.events.findManyByIds).toHaveBeenCalledWith([EVENT_ID]);
    });

    it("carries the event's OWN status, so the last stage says draft vs published vs cancelled", async () => {
      for (const status of ["DRAFT", "PUBLISHED", "CANCELLED"] as const) {
        const { deps } = buildDeps({
          records: [buildAcceptedRecord()],
          agreements: [
            buildAgreementRecord({ status: "ACCEPTED", eventId: EVENT_ID }),
          ],
          events: [buildStageEventRecord({ id: EVENT_ID, status })],
        });

        const result = await listBookingRequests(deps, {
          actorHumanId: ACTOR_ID,
          scope: "venue",
          placeId: PLACE_ID,
        });

        expect(result.requests[0]?.eventStatus).toBe(status);
      }
    });

    it("surfaces an eventStartsAt that DIVERGES from preferredDates", async () => {
      // The whole reason the date rides the row: the show landing on a
      // different night than the one pitched is the meaningful signal.
      const { deps } = buildDeps({
        records: [
          buildAcceptedRecord({ preferredDates: ["2026-07-10"] }),
        ],
        agreements: [
          buildAgreementRecord({ status: "ACCEPTED", eventId: EVENT_ID }),
        ],
        events: [
          buildStageEventRecord({ id: EVENT_ID, startsAt: EVENT_STARTS_AT }),
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]?.preferredDates).toEqual(["2026-07-10"]);
      expect(result.requests[0]?.eventStartsAt).toEqual(EVENT_STARTS_AT);
    });

    it("batches: ONE agreement call and ONE event call for a multi-row page", async () => {
      const { deps, mocks } = buildDeps({
        records: [
          buildAcceptedRecord(),
          buildAcceptedRecord({
            id: SECOND_REQUEST_ID,
            agreementId: SECOND_AGREEMENT_ID,
          }),
          // A row with no agreement rides along without adding a lookup.
          buildBookingRequestRecord({
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          }),
        ],
        agreements: [
          buildAgreementRecord({ status: "ACCEPTED", eventId: EVENT_ID }),
          buildAgreementRecord({
            id: SECOND_AGREEMENT_ID,
            status: "PROPOSED",
            draftEventId: SECOND_EVENT_ID,
          }),
        ],
        events: [
          buildStageEventRecord({ id: EVENT_ID, status: "PUBLISHED" }),
          buildStageEventRecord({ id: SECOND_EVENT_ID, status: "DRAFT" }),
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(mocks.agreements.findManyByIds).toHaveBeenCalledTimes(1);
      expect(mocks.agreements.findManyByIds).toHaveBeenCalledWith([
        AGREEMENT_ID,
        SECOND_AGREEMENT_ID,
      ]);
      expect(mocks.events.findManyByIds).toHaveBeenCalledTimes(1);
      expect(mocks.events.findManyByIds).toHaveBeenCalledWith([
        EVENT_ID,
        SECOND_EVENT_ID,
      ]);

      expect(
        result.requests.map((r) => [r.agreementStatus, r.eventStatus]),
      ).toEqual([
        ["ACCEPTED", "PUBLISHED"],
        ["PROPOSED", "DRAFT"],
        [null, null],
      ]);
    });

    it("only ever looks up ids taken off the rows the scope already authorized", async () => {
      // CROSS-ORG ISOLATION. The agreement/event hang off different aggregates
      // than the request, so the guarantee is "no id enters the batch that
      // didn't come from an already-authorized row". A foreign agreement
      // sitting in the same fake database must not be reachable.
      const FOREIGN_AGREEMENT_ID = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f5f";
      const FOREIGN_EVENT_ID = "efefefef-efef-4fef-8fef-efefefefefef";
      const { deps, mocks } = buildDeps({
        records: [buildAcceptedRecord()],
        agreements: [
          buildAgreementRecord({ status: "ACCEPTED", eventId: EVENT_ID }),
          buildAgreementRecord({
            id: FOREIGN_AGREEMENT_ID,
            status: "FULFILLED",
            eventId: FOREIGN_EVENT_ID,
          }),
        ],
        events: [
          buildStageEventRecord({ id: EVENT_ID, status: "DRAFT" }),
          buildStageEventRecord({
            id: FOREIGN_EVENT_ID,
            status: "PUBLISHED",
          }),
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(mocks.agreements.findManyByIds).toHaveBeenCalledWith([
        AGREEMENT_ID,
      ]);
      expect(mocks.events.findManyByIds).toHaveBeenCalledWith([EVENT_ID]);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({
        agreementStatus: "ACCEPTED",
        eventId: EVENT_ID,
      });
    });

    it("reads a dangling agreement FK as 'no stage', never a half-populated row", async () => {
      const { deps } = buildDeps({
        records: [buildAcceptedRecord()],
        // The agreement row is gone (deleted between the two reads).
        agreements: [],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]).toMatchObject({
        agreementId: AGREEMENT_ID,
        agreementStatus: null,
        eventId: null,
        eventStatus: null,
        eventStartsAt: null,
      });
    });

    it("keeps the event triple coherent: an unresolvable event row yields a null eventId too", async () => {
      // `eventId` non-null must ALWAYS mean "and I can describe it" — a rail
      // must never render a final stage it has nothing to say about.
      const { deps } = buildDeps({
        records: [buildAcceptedRecord()],
        agreements: [
          buildAgreementRecord({ status: "ACCEPTED", eventId: EVENT_ID }),
        ],
        events: [],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]).toMatchObject({
        agreementStatus: "ACCEPTED",
        eventId: null,
        eventStatus: null,
        eventStartsAt: null,
      });
    });

    // ── Deliberate swallow (ReporterPort convention) ───────────────────────

    it("degrades every stage field to null and REPORTS when the agreement lookup fails", async () => {
      const agreementsError = new Error("agreement query exploded");
      const reportError = vi.fn();
      const logger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      };
      const { deps } = buildDeps({
        records: [buildAcceptedRecord()],
        agreementsError,
        reportError,
        logger: logger as unknown as ListBookingRequestsDeps["logger"],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      // The inbox still renders — the rows were already in hand.
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toMatchObject({
        agreementStatus: null,
        eventId: null,
        eventStatus: null,
        eventStartsAt: null,
      });
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(agreementsError, {
        tags: { useCase: "listBookingRequests", step: "bookingStages" },
        extra: { scope: "venue", requestCount: 1, agreementCount: 1 },
      });
      // The log line stays alongside the report (never demoted to warn).
      expect(logger.error).toHaveBeenCalledWith(
        "booking_requests.list.stage_lookup_failed",
        expect.objectContaining({ scope: "venue", agreementCount: 1 }),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("degrades and reports when the SECOND hop (events) fails", async () => {
      const eventsError = new Error("event query exploded");
      const reportError = vi.fn();
      const { deps } = buildDeps({
        records: [buildAcceptedRecord()],
        agreements: [
          buildAgreementRecord({ status: "ACCEPTED", eventId: EVENT_ID }),
        ],
        eventsError,
        reportError,
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]).toMatchObject({
        agreementStatus: null,
        eventId: null,
        eventStatus: null,
        eventStartsAt: null,
      });
      expect(reportError).toHaveBeenCalledWith(eventsError, {
        tags: { useCase: "listBookingRequests", step: "bookingStages" },
        extra: { scope: "venue", requestCount: 1, agreementCount: 1 },
      });
    });

    it("a throwing reporter never breaks the degrade-to-null fallback", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const { deps } = buildDeps({
        records: [buildAcceptedRecord()],
        agreementsError: new Error("agreement query exploded"),
        reportError,
      });

      await expect(
        listBookingRequests(deps, {
          actorHumanId: ACTOR_ID,
          scope: "venue",
          placeId: PLACE_ID,
        }),
      ).resolves.toMatchObject({ requests: [{ agreementStatus: null }] });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("still degrades when reportError is not wired", async () => {
      const { deps } = buildDeps({
        records: [buildAcceptedRecord()],
        agreementsError: new Error("agreement query exploded"),
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      });

      expect(result.requests[0]?.agreementStatus).toBeNull();
    });

    // ── Unwired repo is NOT the same class of failure as a dead query ───────

    it("THROWS NOT_CONFIGURED when the agreements repo is unwired (never degrades)", async () => {
      const reportError = vi.fn();
      const { deps } = buildDeps({ omitAgreementsRepo: true, reportError });

      await expect(
        listBookingRequests(deps, {
          actorHumanId: ACTOR_ID,
          scope: "venue",
          placeId: PLACE_ID,
        }),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
      expect(reportError).not.toHaveBeenCalled();
    });

    it("THROWS NOT_CONFIGURED when the events repo is unwired", async () => {
      const { deps } = buildDeps({ omitEventsRepo: true });

      await expect(
        listBookingRequests(deps, {
          actorHumanId: ACTOR_ID,
          scope: "venue",
          placeId: PLACE_ID,
        }),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    });

    it("throws for an unwired repo even when NO row carries an agreement", async () => {
      // The guard runs before the no-agreements short-circuit, so a wiring
      // omission cannot hide until someone happens to accept a booking.
      const { deps } = buildDeps({
        omitAgreementsRepo: true,
        records: [buildBookingRequestRecord()],
      });

      await expect(
        listBookingRequests(deps, {
          actorHumanId: ACTOR_ID,
          scope: "venue",
          placeId: PLACE_ID,
        }),
      ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    });

    // ── Scope coverage: a rail that works on one surface is a non-starter ───

    it("populates on the performer sent list too (scope: performer)", async () => {
      const { deps } = buildDeps({
        records: [buildAcceptedRecord()],
        agreements: [
          buildAgreementRecord({
            status: "ACCEPTED",
            draftEventId: EVENT_ID,
          }),
        ],
        events: [
          buildStageEventRecord({
            id: EVENT_ID,
            status: "DRAFT",
            startsAt: EVENT_STARTS_AT,
          }),
        ],
      });

      const result = await listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "performer",
      });

      expect(result.requests[0]).toMatchObject({
        id: FIRST_REQUEST_ID,
        agreementStatus: "ACCEPTED",
        eventId: EVENT_ID,
        eventStatus: "DRAFT",
        eventStartsAt: EVENT_STARTS_AT,
      });
    });
  });

  it("requires placeId for venue scope", async () => {
    const { deps } = buildDeps();

    await expect(
      listBookingRequests(deps, { actorHumanId: ACTOR_ID, scope: "venue" }),
    ).rejects.toMatchObject({ code: "PLACE_ID_REQUIRED" });
  });

  it("allows an org VIEWER to list the venue inbox (membership-any)", async () => {
    const { deps, mocks } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      }),
      placeMemberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" }],
    });

    const result = await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

    expect(result.requests).toHaveLength(1);
    expect(mocks.bookingRequests.listForPlace).toHaveBeenCalled();
  });

  it("rejects a non-owner for venue scope", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: ["12121212-1212-4121-8121-121212121212"],
      }),
    });

    await expect(
      listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "venue",
        placeId: PLACE_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("defaults performer scope to the actor's human identity", async () => {
    const { deps, mocks } = buildDeps();

    await listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "performer",
    });

    expect(mocks.bookingRequests.listForPerformer).toHaveBeenCalledWith({
      ownerType: "human",
      ownerId: ACTOR_ID,
      statuses: undefined,
    });
  });

  it("rejects listing another human's sent requests", async () => {
    const { deps } = buildDeps();

    await expect(
      listBookingRequests(deps, {
        actorHumanId: ACTOR_ID,
        scope: "performer",
        performerOwnerType: "human",
        performerOwnerId: "12121212-1212-4121-8121-121212121212",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("requires org membership for an org performer scope", async () => {
    const denied = buildDeps({ orgMembership: null });
    await expect(
      listBookingRequests(denied.deps, {
        actorHumanId: ACTOR_ID,
        scope: "performer",
        performerOwnerType: "org",
        performerOwnerId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    const allowed = buildDeps({
      orgMembership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" },
    });
    await listBookingRequests(allowed.deps, {
      actorHumanId: ACTOR_ID,
      scope: "performer",
      performerOwnerType: "org",
      performerOwnerId: ORG_ID,
    });

    expect(allowed.mocks.bookingRequests.listForPerformer).toHaveBeenCalledWith(
      { ownerType: "organization", ownerId: ORG_ID, statuses: undefined },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Venue confirmation projection (venue-confirmation-and-booking-intents spec)
// ─────────────────────────────────────────────────────────────────────────────

describe("listBookingRequests — venueConfirmation / intent", () => {
  const OTHER_HUMAN_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

  /** An ACCEPTED request whose agreement anchors `EVENT_ID` as a live draft. */
  function seedAnchoredEvent(event: Partial<EventRecord>) {
    return buildDeps({
      records: [
        buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID }),
      ],
      agreements: [
        buildAgreementRecord({ status: "ACCEPTED", eventId: null, draftEventId: EVENT_ID }),
      ],
      events: [
        buildStageEventRecord({
          id: EVENT_ID,
          status: "DRAFT",
          placeId: PLACE_ID,
          orgId: null,
          humanId: OTHER_HUMAN_ID,
          ...event,
        }),
      ],
    });
  }

  const list = (deps: ListBookingRequestsDeps) =>
    listBookingRequests(deps, {
      actorHumanId: ACTOR_ID,
      scope: "venue",
      placeId: PLACE_ID,
    });

  it("carries the request's intent onto the summary", async () => {
    const { deps } = buildDeps({
      records: [buildBookingRequestRecord({ intent: "RENT" })],
    });
    const result = await list(deps);
    expect(result.requests[0]?.intent).toBe("RENT");
  });

  it("builtFromEvent is true for an event-built request (even once accepted) and false otherwise, without exposing the origin id", async () => {
    const { deps } = buildDeps({
      records: [
        buildBookingRequestRecord({ id: "00000000-0000-4000-8000-0000000000a1", originEventId: EVENT_ID }),
        buildBookingRequestRecord({
          id: "00000000-0000-4000-8000-0000000000a2",
          originEventId: EVENT_ID,
          status: "ACCEPTED",
          agreementId: AGREEMENT_ID,
        }),
        buildBookingRequestRecord({ id: "00000000-0000-4000-8000-0000000000a3" }),
      ],
      agreements: [buildAgreementRecord({ status: "ACCEPTED" })],
    });
    const result = await list(deps);
    const byId = new Map(result.requests.map((r) => [r.id, r]));
    expect(byId.get("00000000-0000-4000-8000-0000000000a1")?.builtFromEvent).toBe(true);
    expect(byId.get("00000000-0000-4000-8000-0000000000a2")?.builtFromEvent).toBe(true);
    expect(byId.get("00000000-0000-4000-8000-0000000000a3")?.builtFromEvent).toBe(false);
    expect(byId.get("00000000-0000-4000-8000-0000000000a1")).not.toHaveProperty("originEventId");
  });

  it("reads `none` with no event — and never reads a place for it", async () => {
    const { deps, mocks } = buildDeps({
      records: [buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID })],
      agreements: [buildAgreementRecord({ status: "DRAFT" })],
    });
    const result = await list(deps);
    expect(result.requests[0]?.venueConfirmation).toEqual({
      state: "none",
      eventId: null,
      ownerSide: null,
    });
    // The venue-scope authorization read is the ONLY place read.
    expect(mocks.places.getById).toHaveBeenCalledTimes(1);
  });

  it("a VENUE-OWNED event is confirmed by construction, ownerSide venue", async () => {
    // `buildPlaceRecord` lists ACTOR_ID as a direct human owner.
    const { deps } = seedAnchoredEvent({ humanId: ACTOR_ID });
    const result = await list(deps);
    expect(result.requests[0]?.venueConfirmation).toEqual({
      state: "confirmed",
      eventId: EVENT_ID,
      ownerSide: "place",
    });
  });

  it("a requester-owned event with an ACTIVE stamp for this place is confirmed, ownerSide requester", async () => {
    const { deps } = seedAnchoredEvent({
      venueConfirmedAt: new Date("2026-09-01T00:00:00.000Z"),
      venueConfirmedPlaceId: PLACE_ID,
      venueConfirmationWithdrawnAt: null,
    });
    const result = await list(deps);
    expect(result.requests[0]?.venueConfirmation).toEqual({
      state: "confirmed",
      eventId: EVENT_ID,
      ownerSide: "requester",
    });
  });

  it("a withdrawn stamp reads `withdrawn`, not `unconfirmed`", async () => {
    const { deps } = seedAnchoredEvent({
      venueConfirmedAt: new Date("2026-09-01T00:00:00.000Z"),
      venueConfirmedPlaceId: PLACE_ID,
      venueConfirmationWithdrawnAt: new Date("2026-09-02T00:00:00.000Z"),
    });
    const result = await list(deps);
    expect(result.requests[0]?.venueConfirmation).toMatchObject({
      state: "withdrawn",
      ownerSide: "requester",
    });
  });

  it("a requester-owned event with no stamp reads `unconfirmed`", async () => {
    const { deps } = seedAnchoredEvent({});
    const result = await list(deps);
    expect(result.requests[0]?.venueConfirmation).toEqual({
      state: "unconfirmed",
      eventId: EVENT_ID,
      ownerSide: "requester",
    });
  });

  it("a stamp issued for ANOTHER place is not this venue's word (unconfirmed)", async () => {
    const { deps } = seedAnchoredEvent({
      venueConfirmedAt: new Date("2026-09-01T00:00:00.000Z"),
      venueConfirmedPlaceId: "1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e",
    });
    const result = await list(deps);
    expect(result.requests[0]?.venueConfirmation.state).toBe("unconfirmed");
  });

  it("an EVENT-FIRST request (originEventId, no agreement) carries its event and its confirmation state", async () => {
    const { deps, mocks } = buildDeps({
      records: [
        buildBookingRequestRecord({ status: "PENDING", agreementId: null, originEventId: EVENT_ID }),
      ],
      events: [
        buildStageEventRecord({
          id: EVENT_ID,
          status: "PUBLISHED",
          placeId: PLACE_ID,
          orgId: null,
          humanId: OTHER_HUMAN_ID,
        }),
      ],
    });
    const result = await list(deps);
    expect(result.requests[0]).toMatchObject({
      agreementStatus: null,
      eventId: EVENT_ID,
      eventStatus: "PUBLISHED",
      venueConfirmation: { state: "unconfirmed", eventId: EVENT_ID, ownerSide: "requester" },
    });
    // No agreement on the page → the agreements repo is never asked.
    expect(mocks.agreements.findManyByIds).not.toHaveBeenCalled();
    expect(mocks.events.findManyByIds).toHaveBeenCalledWith([EVENT_ID]);
  });

  it("reads each place ONCE for the whole page, never once per row", async () => {
    const SECOND_REQUEST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const { deps, mocks } = buildDeps({
      records: [
        buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID }),
        buildBookingRequestRecord({
          id: SECOND_REQUEST_ID,
          status: "ACCEPTED",
          agreementId: SECOND_AGREEMENT_ID,
        }),
      ],
      agreements: [
        buildAgreementRecord({ status: "ACCEPTED", eventId: null, draftEventId: EVENT_ID }),
        buildAgreementRecord({
          id: SECOND_AGREEMENT_ID,
          status: "ACCEPTED",
          eventId: null,
          draftEventId: SECOND_EVENT_ID,
        }),
      ],
      events: [
        buildStageEventRecord({ id: EVENT_ID, placeId: PLACE_ID, orgId: null, humanId: OTHER_HUMAN_ID }),
        buildStageEventRecord({ id: SECOND_EVENT_ID, placeId: PLACE_ID, orgId: null, humanId: ACTOR_ID }),
      ],
    });
    const result = await list(deps);
    expect(result.requests.map((r) => r.venueConfirmation.state)).toEqual([
      "unconfirmed",
      "confirmed",
    ]);
    // One authorization read + one projection read for the single place.
    expect(mocks.places.getById).toHaveBeenCalledTimes(2);
  });

  it("degrades to `none` with the rest of the stage when the event hop fails", async () => {
    const reportError = vi.fn();
    const { deps } = buildDeps({
      records: [buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID })],
      agreements: [
        buildAgreementRecord({ status: "ACCEPTED", eventId: null, draftEventId: EVENT_ID }),
      ],
      eventsError: new Error("events down"),
      reportError,
    });
    const result = await list(deps);
    expect(result.requests[0]?.venueConfirmation).toEqual({
      state: "none",
      eventId: null,
      ownerSide: null,
    });
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
