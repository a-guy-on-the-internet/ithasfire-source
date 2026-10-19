import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { EventRecord } from "@th/ports/repos/events";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { PayoutTermsLineRecord } from "@th/ports/repos/payout-terms";

import { getBookingAgreement } from "../get-booking-agreement";
import type { GetBookingAgreementDeps } from "../get-booking-agreement";
import {
  AGREEMENT_ID,
  EVENT_ID,
  OUTSIDER_ID,
  PERFORMER_ID,
  PLACE_ID,
  TERMS_ID,
  THIRD_PARTY_HUMAN_ID,
  THIRD_PARTY_PAYEE_ID,
  VENUE_ADMIN_ID,
  VENUE_ORG_ID,
  VENUE_VIEWER_ID,
  ORGANIZER_ADMIN_ID,
  buildAgreementRecord,
  buildLineRecord,
  buildLinkedBookingRequest,
  buildOrganizerAgreementRecord,
  buildPayeeRecord,
  makeAgreementsRepoFake,
  makeAuthzFake,
} from "./helpers";

type BuildOptions = {
  agreement?: AgreementRecord | null;
  lines?: PayoutTermsLineRecord[];
  payees?: PayeeRecord[];
  bookingRequest?: Record<string, unknown> | null;
  /** The venue's address-derived zone (null = platform fallback). */
  placeTimezone?: string | null;
  /** Settlement currency of the agreement's PayoutTerms row. */
  settlementCurrency?: string | null;
  /** The terms' stored remainder holder: set = the terms carry a deal (FR-001). */
  remainderPayeeId?: string | null;
  /** Make `places.getById` throw (provenance deliberate-swallow path). */
  placesFail?: boolean;
  /**
   * What `events.getById` resolves for the agreement's linked event id.
   * Defaults to a DRAFT event at `EVENT_ID`; null = the row is gone.
   */
  event?: Partial<EventRecord> | null;
  /** Make `events.getById` throw (linked-event deliberate-swallow path). */
  eventsFail?: boolean;
  /**
   * The originating request's act rows, as `listActsForRequests` returns
   * them (v3 FR-011). Default: none (a request with no bill).
   */
  billActs?: readonly Record<string, unknown>[];
  /** Make the bill read throw (its deliberate-swallow path). */
  billFail?: boolean;
  /** PUBLIC pages by owner id (the bill's links). */
  publicPages?: Record<string, string>;
};

const DRAFT_EVENT_ID = "44444444-4444-4444-8444-222222222222";
const LINKED_EVENT_STARTS_AT = new Date("2026-07-10T01:00:00.000Z");

/** Only the columns the read projects — the fake is typed loosely on purpose. */
function buildLinkedEvent(
  overrides: Partial<EventRecord> = {},
): Partial<EventRecord> {
  return {
    id: EVENT_ID,
    status: "DRAFT",
    startsAt: LINKED_EVENT_STARTS_AT,
    ...overrides,
  };
}

/**
 * The originating pitch as `findByAgreementId` returns it. Carries the FULL
 * pitch-field set (not just what the read renders) because pitch PROVENANCE is
 * derived from `preferredDates` / `setLengthMinutes` / the fee ask.
 */
function buildOriginatingRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "44441111-4444-4111-8444-111144441111",
    status: "ACCEPTED",
    // The act pair is what makes the performer the ACT (terms-editor gate).
    direction: "TO_VENUE",
    performerOwnerType: "human",
    performerOwnerId: PERFORMER_ID,
    message: "We'd love to play.",
    preferredDates: ["2026-07-10"],
    expectedDraw: 80,
    genre: "punk",
    links: [],
    calendarId: null,
    setLengthMinutes: null,
    lineupSize: null,
    techNeeds: null,
    feeType: null,
    feeAmountCents: null,
    feeCurrency: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildDeps(options: BuildOptions = {}) {
  const agreements = makeAgreementsRepoFake(
    options.agreement === undefined
      ? buildAgreementRecord()
      : options.agreement,
  );

  const lines = options.lines ?? [buildLineRecord()];
  const payeeRecords = options.payees ?? [
    buildPayeeRecord({ id: THIRD_PARTY_PAYEE_ID }),
  ];

  const bookingRequest =
    options.bookingRequest === undefined
      ? buildOriginatingRequest()
      : options.bookingRequest;

  const reportError = vi.fn();
  const places = {
    getById: vi.fn(async () => {
      if (options.placesFail) throw new Error("places down");
      return { id: PLACE_ID, timezone: options.placeTimezone ?? null };
    }),
  };
  const calendars = { listByPlace: vi.fn(async () => []) };
  const linkedEvent =
    options.event === undefined ? buildLinkedEvent() : options.event;
  const events = {
    getById: vi.fn(async (id: string) => {
      if (options.eventsFail) throw new Error("events down");
      if (!linkedEvent) return null;
      return { ...linkedEvent, id };
    }),
  };

  const deps = {
    repos: {
      agreements: agreements.repo,
      places,
      calendars,
      events,
      payoutTerms: {
        listLines: vi.fn(async () => lines),
        // Pitch provenance refuses to attribute a guarantee it can't verify
        // the currency of, so this read is load-bearing for that label.
        getById: vi.fn(async () => ({
          id: TERMS_ID,
          settlementCurrency:
            options.settlementCurrency === undefined
              ? "usd"
              : options.settlementCurrency,
          remainderPayeeId: options.remainderPayeeId ?? null,
        })),
      },
      payees: {
        getByIds: vi.fn(async (ids: string[]) =>
          payeeRecords.filter((payee) => ids.includes(payee.id)),
        ),
      },
      bookingRequests: {
        findByAgreementId: vi.fn(async () => bookingRequest),
        listActsForRequests: vi.fn(async () => {
          if (options.billFail) throw new Error("acts down");
          return options.billActs ?? [];
        }),
      },
      entityPages: {
        getByOwners: vi.fn(async (ownerType: string, ids: string[]) =>
          ids
            .filter((id) => options.publicPages?.[id])
            .map((id) => ({
              ownerType,
              ownerId: id,
              slug: options.publicPages![id],
              displayName: null,
              visibility: "PUBLIC",
            })),
        ),
      },
      authz: makeAuthzFake(),
      humans: {
        getByIds: vi.fn(async (ids: string[]) =>
          ids.map((id) => ({
            id,
            name: id === THIRD_PARTY_HUMAN_ID ? "Sax Player" : "Performer",
          })),
        ),
      },
      organizations: {
        getByIds: vi.fn(async (ids: string[]) =>
          ids.map((id) => ({ id, name: "Venue Org" })),
        ),
      },
    } as unknown as GetBookingAgreementDeps["repos"],
    reportError,
  } satisfies GetBookingAgreementDeps;

  return { deps, reportError, places, calendars, events };
}

describe("getBookingAgreement", () => {
  it("hydrates lines, parties, and the originating request for a party actor", async () => {
    const { deps } = buildDeps();

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.agreement.id).toBe(AGREEMENT_ID);
    expect(result.agreement.proposerDisplayName).toBe("Performer");
    expect(result.agreement.counterpartyDisplayName).toBe("Venue Org");
    expect(result.actorSide).toBe("proposer");
    // The originating request names the performer as the act, so this actor
    // reads the terms but never edits them (owner decision 2026-08-25).
    expect(result.viewerSide).toBe("act");
    expect(result.viewerCanEditTerms).toBe(false);
    expect(result.mayEdit).toBe(false);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      payeeId: THIRD_PARTY_PAYEE_ID,
      subjectType: "human",
      subjectId: THIRD_PARTY_HUMAN_ID,
      displayName: "Sax Player",
      requiresConfirmation: true,
      confirmationStatus: "PENDING",
    });
    expect(result.bookingRequest?.message).toBe("We'd love to play.");
  });

  it("lets an org VIEWER read but not edit", async () => {
    const { deps } = buildDeps();

    const result = await getBookingAgreement(deps, {
      actorHumanId: VENUE_VIEWER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.actorSide).toBe("counterparty");
    expect(result.mayEdit).toBe(false);
  });

  it("reports mayEdit=false outside DRAFT (viewerCanEditTerms is status-independent)", async () => {
    const { deps } = buildDeps({
      agreement: buildAgreementRecord({ status: "PROPOSED" }),
      bookingRequest: null,
    });

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.viewerCanEditTerms).toBe(true);
    expect(result.mayEdit).toBe(false);
  });

  // ── Terms side (owner decision 2026-08-25) ────────────────────────────────
  describe("viewerSide / viewerCanEditTerms", () => {
    it("UNLINKED: no act, either edit-level party may edit", async () => {
      const { deps } = buildDeps({ bookingRequest: null, lines: [] });

      const performer = await getBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
      });
      const venue = await getBookingAgreement(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(performer).toMatchObject({
        viewerSide: null,
        viewerCanEditTerms: true,
        mayEdit: true,
      });
      expect(venue).toMatchObject({
        viewerSide: null,
        viewerCanEditTerms: true,
        mayEdit: true,
      });
    });

    it("TO_VENUE: the performer is the act (read-only), the venue admin edits", async () => {
      const { deps } = buildDeps({
        bookingRequest: buildLinkedBookingRequest("TO_VENUE"),
      });

      const performer = await getBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
      });
      const venue = await getBookingAgreement(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(performer).toMatchObject({
        actorSide: "proposer",
        viewerSide: "act",
        viewerCanEditTerms: false,
        mayEdit: false,
      });
      expect(venue).toMatchObject({
        actorSide: "counterparty",
        viewerSide: "editor",
        viewerCanEditTerms: true,
        mayEdit: true,
      });
    });

    it("TO_PERFORMER: mirrored layout, same answer — the organizer edits", async () => {
      const { deps } = buildDeps({
        agreement: buildOrganizerAgreementRecord(),
        bookingRequest: buildLinkedBookingRequest("TO_PERFORMER"),
      });

      const performer = await getBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
      });
      const organizer = await getBookingAgreement(deps, {
        actorHumanId: ORGANIZER_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(performer).toMatchObject({
        actorSide: "counterparty",
        viewerSide: "act",
        viewerCanEditTerms: false,
      });
      expect(organizer).toMatchObject({
        actorSide: "proposer",
        viewerSide: "editor",
        viewerCanEditTerms: true,
      });
    });

    it("an editor-side VIEWER is on the editor side but still cannot edit (role bar)", async () => {
      const { deps } = buildDeps({
        bookingRequest: buildLinkedBookingRequest("TO_VENUE"),
      });

      const result = await getBookingAgreement(deps, {
        actorHumanId: VENUE_VIEWER_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(result).toMatchObject({
        viewerSide: "editor",
        viewerCanEditTerms: false,
        mayEdit: false,
      });
    });
  });

  it("rejects non-party actors", async () => {
    const { deps } = buildDeps();

    await expect(
      getBookingAgreement(deps, {
        actorHumanId: OUTSIDER_ID,
        agreementId: AGREEMENT_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
  });

  it("404s on a missing agreement", async () => {
    const { deps } = buildDeps({ agreement: null });

    await expect(
      getBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
      }),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_FOUND" });
  });

  // ── Linked event (stage rail context) ─────────────────────────────────────
  describe("event", () => {
    it("is null — with no read — when the agreement links no event", async () => {
      const { deps, events } = buildDeps({ bookingRequest: null, lines: [] });

      const result = await getBookingAgreement(deps, {
        actorHumanId: PERFORMER_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(result.event).toBeNull();
      expect(events.getById).not.toHaveBeenCalled();
    });

    it("resolves the FINALIZED event through `eventId`", async () => {
      const { deps, events } = buildDeps({
        agreement: buildAgreementRecord({
          status: "FULFILLED",
          eventId: EVENT_ID,
          draftEventId: null,
        }),
        event: buildLinkedEvent({ status: "PUBLISHED" }),
      });

      const result = await getBookingAgreement(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(result.event).toEqual({
        id: EVENT_ID,
        status: "PUBLISHED",
        startsAt: LINKED_EVENT_STARTS_AT,
      });
      expect(events.getById).toHaveBeenCalledTimes(1);
      expect(events.getById).toHaveBeenCalledWith(EVENT_ID);
    });

    it("falls back to the DRAFT anchor when finalize has not happened", async () => {
      const { deps, events } = buildDeps({
        agreement: buildAgreementRecord({
          status: "ACCEPTED",
          eventId: null,
          draftEventId: DRAFT_EVENT_ID,
        }),
      });

      const result = await getBookingAgreement(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(result.event).toEqual({
        id: DRAFT_EVENT_ID,
        status: "DRAFT",
        startsAt: LINKED_EVENT_STARTS_AT,
      });
      expect(events.getById).toHaveBeenCalledWith(DRAFT_EVENT_ID);
    });

    it("FINALIZED wins when both links are set (findByLinkedEventId precedence)", async () => {
      const { deps, events } = buildDeps({
        agreement: buildAgreementRecord({
          eventId: EVENT_ID,
          draftEventId: DRAFT_EVENT_ID,
        }),
      });

      const result = await getBookingAgreement(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(result.event?.id).toBe(EVENT_ID);
      expect(events.getById).toHaveBeenCalledTimes(1);
      expect(events.getById).toHaveBeenCalledWith(EVENT_ID);
    });

    it("is null (not half-populated, not reported) when the linked row is gone", async () => {
      const { deps, reportError } = buildDeps({
        agreement: buildAgreementRecord({ eventId: EVENT_ID }),
        event: null,
      });

      const result = await getBookingAgreement(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(result.event).toBeNull();
      expect(reportError).not.toHaveBeenCalled();
    });

    it("DEGRADES to null (never the read) when the events lookup fails, and REPORTS it", async () => {
      const { deps, reportError } = buildDeps({
        agreement: buildAgreementRecord({ eventId: EVENT_ID }),
        eventsFail: true,
      });

      const result = await getBookingAgreement(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(result.agreement.id).toBe(AGREEMENT_ID);
      expect(result.event).toBeNull();
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { useCase: "getBookingAgreement" },
          extra: expect.objectContaining({
            reason: "linked_event_lookup_failed",
            linkedEventId: EVENT_ID,
          }),
        }),
      );
    });

    it("keeps the read alive when a throwing reporter meets a failed lookup", async () => {
      const { deps, reportError } = buildDeps({
        agreement: buildAgreementRecord({ eventId: EVENT_ID }),
        eventsFail: true,
      });
      reportError.mockImplementation(() => {
        throw new Error("sentry is down");
      });

      const result = await getBookingAgreement(deps, {
        actorHumanId: VENUE_ADMIN_ID,
        agreementId: AGREEMENT_ID,
      });

      expect(result.event).toBeNull();
    });
  });

  it("returns null bookingRequest for standalone agreements", async () => {
    const { deps } = buildDeps({ bookingRequest: null, lines: [] });

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.bookingRequest).toBeNull();
    expect(result.lines).toEqual([]);
  });
});

/**
 * Provenance is DERIVED, not stored: the read re-computes the accept-time seed
 * and compares it to the stored header. One rule, one place — the UI reads
 * booleans rather than re-implementing the comparison and drifting from it.
 */
describe("getBookingAgreement — pitch provenance", () => {
  /** The header the accept would have seeded from `pitch`, in Chicago. */
  const SEEDED_DATE = new Date("2026-07-11T00:00:00.000Z"); // 19:00 CDT
  const SEEDED_END = new Date("2026-07-11T00:45:00.000Z"); // + 45 min

  const seededRequest = buildOriginatingRequest({
    setLengthMinutes: 45,
    feeType: "GUARANTEE",
    feeAmountCents: 50_000,
    feeCurrency: "usd",
  });

  it("labels every untouched seeded field as from the pitch", async () => {
    const { deps } = buildDeps({
      bookingRequest: seededRequest,
      agreement: buildAgreementRecord({
        proposedDate: SEEDED_DATE,
        proposedEndDate: SEEDED_END,
        guaranteeCents: 50_000,
      }),
    });

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.pitchProvenance).toEqual({
      proposedDate: true,
      proposedEndDate: true,
      guaranteeCents: true,
      // The fixture pitch carries no lineup / tech needs, and the guarantee
      // has a structured home — so nothing seeded the description.
      description: false,
    });
  });

  it("drops the label once the venue edits that field", async () => {
    const { deps } = buildDeps({
      bookingRequest: seededRequest,
      agreement: buildAgreementRecord({
        proposedDate: new Date("2026-07-18T01:00:00.000Z"), // moved a week
        proposedEndDate: SEEDED_END,
        guaranteeCents: 60_000, // negotiated up
      }),
    });

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.pitchProvenance).toMatchObject({
      proposedDate: false,
      guaranteeCents: false,
      // Untouched fields keep theirs.
      proposedEndDate: true,
    });
  });

  it("claims nothing on an agreement the accept seeded nothing into", async () => {
    const { deps } = buildDeps();

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.pitchProvenance).toEqual({
      proposedDate: false,
      proposedEndDate: false,
      guaranteeCents: false,
      description: false,
    });
  });

  it("is null when there is no originating request to attribute anything to", async () => {
    const { deps } = buildDeps({ bookingRequest: null, lines: [] });

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.pitchProvenance).toBeNull();
  });

  it("resolves the anchor in the VENUE's zone", async () => {
    const { deps } = buildDeps({
      placeTimezone: "America/New_York",
      bookingRequest: seededRequest,
      agreement: buildAgreementRecord({
        // 19:00 EDT, not the Chicago fallback.
        proposedDate: new Date("2026-07-10T23:00:00.000Z"),
      }),
    });

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.pitchProvenance?.proposedDate).toBe(true);
  });

  it("refuses to attribute a guarantee whose settlement currency it cannot read", async () => {
    const { deps } = buildDeps({
      settlementCurrency: null,
      bookingRequest: seededRequest,
      agreement: buildAgreementRecord({ guaranteeCents: 50_000 }),
    });

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    // Unverifiable is not the same as fine — for a MONEY label, silence wins.
    expect(result.pitchProvenance?.guaranteeCents).toBe(false);
  });

  it("skips the calendar read entirely when the pitch named its own time", async () => {
    const { deps, calendars } = buildDeps({
      bookingRequest: buildOriginatingRequest({
        calendarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        preferredDates: ["2026-07-10T21:00"],
      }),
    });

    await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(calendars.listByPlace).not.toHaveBeenCalled();
  });

  it("DEGRADES the label (never the read) when the places lookup fails, and REPORTS it", async () => {
    const { deps, reportError } = buildDeps({
      placesFail: true,
      bookingRequest: seededRequest,
      agreement: buildAgreementRecord({
        proposedDate: SEEDED_DATE,
        guaranteeCents: 50_000,
      }),
    });

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    // The agreement still loads; the zone falls back to the platform default,
    // which happens to be what this fixture's null timezone resolves to.
    expect(result.agreement.id).toBe(AGREEMENT_ID);
    expect(result.pitchProvenance?.proposedDate).toBe(true);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "getBookingAgreement" },
        extra: expect.objectContaining({ reason: "place_lookup_failed" }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The bill on the agreement (lineup-booking-requests v3, FR-011 / L2)
// ─────────────────────────────────────────────────────────────────────────────

describe("getBookingAgreement — the bill (v3 FR-011)", () => {
  const REQUEST_ROW_ID = "44441111-4444-4111-8444-111144441111";
  const JOINED_ID = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0";
  const INVITED_ID = "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0";
  const PASSED_ID = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
  const GROUP_ID = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";

  let seq = 0;
  const act = (over: Record<string, unknown>) => ({
    id: `e0e0e0e0-e0e0-4e0e-8e0e-${String(++seq).padStart(12, "0")}`,
    bookingRequestId: REQUEST_ROW_ID,
    actOwnerType: null,
    actOwnerId: null,
    externalName: null,
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    confirmation: "CONFIRMED",
    invitedAt: null,
    respondedAt: null,
    declineReason: null,
    removedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...over,
  });

  /** Stored order 0..5: SELF, passed, joined DJ, invited, a joined GROUP, free text. */
  const billActs = () => [
    act({ source: "SELF", actOwnerType: "human", actOwnerId: PERFORMER_ID, sortOrder: 0 }),
    act({ source: "TAGGED", actOwnerType: "human", actOwnerId: PASSED_ID, sortOrder: 1, confirmation: "DECLINED" }),
    act({ source: "TAGGED", actOwnerType: "human", actOwnerId: JOINED_ID, sortOrder: 2, role: "DJ" }),
    act({ source: "TAGGED", actOwnerType: "human", actOwnerId: INVITED_ID, sortOrder: 3, confirmation: "PENDING" }),
    act({ source: "TAGGED", actOwnerType: "organization", actOwnerId: GROUP_ID, sortOrder: 4, role: "OTHER", customRoleLabel: "Backing band" }),
    act({ source: "EXTERNAL", externalName: "The Weeds", externalUrl: "https://weeds.example", sortOrder: 5 }),
  ];

  for (const [side, actorHumanId] of [
    ["the act (sender) side", PERFORMER_ID],
    ["the venue side", VENUE_ADMIN_ID],
  ] as const) {
    it(`${side} reads the VENUE-FACING bill: passed absent, invited marked, positions dense, ids only for joined acts`, async () => {
      const { deps, reportError } = buildDeps({
        billActs: billActs(),
        publicPages: { [JOINED_ID]: "joined-dj", [GROUP_ID]: "the-group" },
      });

      const result = await getBookingAgreement(deps, {
        actorHumanId,
        agreementId: AGREEMENT_ID,
      });

      expect(result.billUnavailable).toBe(false);
      expect(
        result.bill.map((item) => [item.source, item.confirmation, item.sortOrder]),
      ).toEqual([
        ["SELF", "CONFIRMED", 0],
        // PASSED_ID (stored 1) is absent — and nothing renumbers around a hole.
        ["TAGGED", "CONFIRMED", 1],
        ["TAGGED", "PENDING", 2],
        ["TAGGED", "CONFIRMED", 3],
        ["EXTERNAL", "CONFIRMED", 4],
      ]);
      // NFR-002: no passed act reaches anything venue-facing.
      expect(JSON.stringify(result.bill)).not.toContain(PASSED_ID);
      // Payee suggestions (L2): joined platform acts only — the invited act's
      // id never leaves the server; by-name is never a platform identity.
      expect(result.bill.map((item) => item.joinedAs)).toEqual([
        { ownerType: "human", ownerId: PERFORMER_ID },
        { ownerType: "human", ownerId: JOINED_ID },
        null,
        { ownerType: "organization", ownerId: GROUP_ID },
        null,
      ]);
      expect(JSON.stringify(result.bill)).not.toContain(INVITED_ID);
      // Links: PUBLIC pages only; free text never linked even with a URL.
      expect(result.bill.map((item) => item.href)).toEqual([
        null,
        "/humans/joined-dj",
        null,
        "/orgs/the-group",
        null,
      ]);
      // Role + label ride along (L13).
      expect(result.bill[1]).toMatchObject({ role: "DJ", customRoleLabel: null });
      expect(result.bill[3]).toMatchObject({ role: "OTHER", customRoleLabel: "Backing band" });
      expect(reportError).not.toHaveBeenCalled();
    });
  }

  it("a sender-removed act is not on the agreement's bill", async () => {
    const { deps } = buildDeps({
      billActs: [
        act({ source: "SELF", actOwnerType: "human", actOwnerId: PERFORMER_ID, sortOrder: 0 }),
        act({
          source: "TAGGED",
          actOwnerType: "human",
          actOwnerId: JOINED_ID,
          sortOrder: 1,
          removedAt: new Date("2026-06-02T00:00:00.000Z"),
        }),
        act({ source: "EXTERNAL", externalName: "The Weeds", sortOrder: 2 }),
      ],
    });

    const result = await getBookingAgreement(deps, {
      actorHumanId: VENUE_ADMIN_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.bill.map((item) => [item.source, item.sortOrder])).toEqual([
      ["SELF", 0],
      ["EXTERNAL", 1],
    ]);
  });

  it("no originating request, or a TO_PERFORMER one → [] without reading acts", async () => {
    const none = buildDeps({ bookingRequest: null });
    const noneResult = await getBookingAgreement(none.deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });
    expect(noneResult).toMatchObject({ bill: [], billUnavailable: false });

    const organizer = buildDeps({
      bookingRequest: buildOriginatingRequest({ direction: "TO_PERFORMER" }),
      billActs: [act({ source: "SELF", actOwnerType: "human", actOwnerId: PERFORMER_ID, sortOrder: 0 })],
    });
    const organizerResult = await getBookingAgreement(organizer.deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });
    // NFR-004: a TO_PERFORMER request carries no bill — never read for it.
    expect(organizerResult).toMatchObject({ bill: [], billUnavailable: false });
    expect(
      (organizer.deps.repos.bookingRequests as unknown as {
        listActsForRequests: ReturnType<typeof vi.fn>;
      }).listActsForRequests,
    ).not.toHaveBeenCalled();
  });

  it("DEGRADES (never fails the read) when the bill read throws: [] + billUnavailable, REPORTED", async () => {
    const { deps, reportError } = buildDeps({ billFail: true });

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.agreement.id).toBe(AGREEMENT_ID);
    expect(result).toMatchObject({ bill: [], billUnavailable: true });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "getBookingAgreement" },
        extra: expect.objectContaining({ reason: "bill_lookup_failed" }),
      }),
    );
  });
});

/**
 * FR-001: once the terms carry a deal, the header guarantee is The deal's
 * (derived on every deal save), and the read says so.
 */
describe("getBookingAgreement — guaranteeFromDeal", () => {
  const seededRequest = buildOriginatingRequest({
    feeType: "GUARANTEE",
    feeAmountCents: 50_000,
    feeCurrency: "usd",
  });

  it("is false while the terms carry no deal: the header is the typed / pitched number", async () => {
    const { deps } = buildDeps({
      bookingRequest: seededRequest,
      agreement: buildAgreementRecord({ guaranteeCents: 50_000 }),
    });

    const result = await getBookingAgreement(deps, {
      actorHumanId: VENUE_ADMIN_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.guaranteeFromDeal).toBe(false);
    // The act's pitched amount is readable for the Guarantee preset's pre-fill.
    expect(result.agreement.guaranteeCents).toBe(50_000);
    expect(result.pitchProvenance?.guaranteeCents).toBe(true);
  });

  it("is true once the terms carry a deal, and the pitch label gives way to it", async () => {
    const { deps } = buildDeps({
      bookingRequest: seededRequest,
      agreement: buildAgreementRecord({ guaranteeCents: 50_000 }),
      remainderPayeeId: THIRD_PARTY_PAYEE_ID,
    });

    const result = await getBookingAgreement(deps, {
      actorHumanId: VENUE_ADMIN_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.guaranteeFromDeal).toBe(true);
    expect(result.agreement.guaranteeCents).toBe(50_000);
    expect(result.pitchProvenance?.guaranteeCents).toBe(false);
  });

  it("is false on an agreement with no originating request (no act side to derive for)", async () => {
    const { deps } = buildDeps({
      bookingRequest: null,
      remainderPayeeId: THIRD_PARTY_PAYEE_ID,
    });

    const result = await getBookingAgreement(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
    });

    expect(result.guaranteeFromDeal).toBe(false);
  });
});
