import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";

import { listBookingRequests, type ListBookingRequestsDeps } from "../list-booking-requests";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  OTHER_HUMAN_ID,
  PLACE_ID,
  REQUEST_ID,
  buildAgreementRecord,
  buildBookingRequestRecord,
  buildPlaceRecord,
  buildStageEventRecord,
  buildStageRepos,
  buildUnreadCountingRepo,
} from "./helpers";

/**
 * P5-fixes — the venue inbox row's booking-action fields (booking-the-night
 * FR-003 / FR-004): `bookingEvent`, `termsNight`, `bookWithoutTermsPayee` and
 * each hold's `askedFor`. Each is derived with the rule the booking use cases
 * refuse with, so the web never re-derives it (and never in the BROWSER's
 * timezone).
 */

const EVENT_ID = "99999999-9999-4999-8999-999999999999";
const CALENDAR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function setup(options: {
  records: BookingRequestRecord[];
  place?: Partial<PlaceRecord>;
  agreements?: AgreementRecord[];
  events?: EventRecord[];
  agreementsError?: Error;
  holds?: { bookingRequestId: string; date: string; position?: number; status?: "ACTIVE" | "CONFIRMED" }[];
  reportError?: ListBookingRequestsDeps["reportError"];
}) {
  const place = buildPlaceRecord(options.place);
  const stage = buildStageRepos({
    ...(options.agreements ? { agreements: options.agreements } : {}),
    ...(options.events ? { events: options.events } : {}),
    ...(options.agreementsError ? { agreementsError: options.agreementsError } : {}),
  });
  for (const hold of options.holds ?? []) {
    stage.bookingHolds.seed({ calendarId: CALENDAR_ID, ...hold });
  }
  const places = { getById: vi.fn(async () => place) };
  const deps: ListBookingRequestsDeps = {
    repos: {
      bookingRequests: {
        listForPlace: vi.fn(async () => options.records),
        listForPerformer: vi.fn(async () => options.records),
        listActsForRequests: vi.fn(async () => []),
      },
      places,
      authz: {
        getOrgMemberships: vi.fn(async () => []),
        getOrgMembership: vi.fn(async () => null),
      },
      humans: { getByIds: vi.fn(async () => [{ id: ACTOR_ID, name: "Act" }]) },
      organizations: { getByIds: vi.fn(async () => []) },
      bookingRequestMessages: buildUnreadCountingRepo(),
      agreements: stage.agreements,
      events: stage.events,
      bookingHolds: stage.bookingHolds,
      bookingTags: stage.bookingTags,
    } as unknown as ListBookingRequestsDeps["repos"],
    clock: { now: () => new Date("2026-10-01T12:00:00.000Z") },
    ...(options.reportError ? { reportError: options.reportError } : {}),
  } as ListBookingRequestsDeps;
  return { deps, places, holds: stage.bookingHolds };
}

async function venueList(deps: ListBookingRequestsDeps) {
  return listBookingRequests(deps, { actorHumanId: ACTOR_ID, scope: "venue", placeId: PLACE_ID });
}

describe("listBookingRequests — booking-action fields (P5-fixes)", () => {
  it("reads a live event's night in the PLACE's zone, not UTC's (Berlin, 00:30 local)", async () => {
    // 22:30Z on Oct 17 is 00:30 on Oct 18 in Berlin (CEST). The UTC day — and
    // the day a browser in Los Angeles would read — is the 17th.
    const startsAt = new Date("2026-10-17T22:30:00.000Z");
    const { deps } = setup({
      place: { timezone: "Europe/Berlin" },
      records: [buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID })],
      agreements: [buildAgreementRecord({ status: "DRAFT", eventId: null, draftEventId: EVENT_ID })],
      events: [
        buildStageEventRecord({
          id: EVENT_ID,
          status: "DRAFT",
          startsAt,
          placeId: PLACE_ID,
          calendarId: CALENDAR_ID,
          humanId: ACTOR_ID,
          orgId: null,
        }),
      ],
    });
    const [row] = (await venueList(deps)).requests;
    expect(row?.bookingEvent).toEqual({ state: "live", night: "2026-10-18", calendarId: CALENDAR_ID });
    // ACTOR_ID owns the place (buildPlaceRecord): a venue-owned event pays the place.
    expect(row?.bookWithoutTermsPayee).toBe("place");
  });

  it("reads terms' night in the place zone too (Auckland, UTC day differs)", async () => {
    // 12:00Z on Oct 17 is 01:00 on Oct 18 in Auckland (NZDT).
    const { deps } = setup({
      place: { timezone: "Pacific/Auckland" },
      records: [buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID })],
      agreements: [
        buildAgreementRecord({
          status: "PROPOSED",
          proposedDate: new Date("2026-10-17T12:00:00.000Z"),
          eventId: null,
          draftEventId: null,
        }),
      ],
    });
    const [row] = (await venueList(deps)).requests;
    expect(row?.termsNight).toBe("2026-10-18");
    expect(row?.bookingEvent).toEqual({ state: "none" });
  });

  it("no agreement, no event: none, payee by intent — and no extra query", async () => {
    const { deps, places } = setup({
      records: [
        buildBookingRequestRecord({ id: REQUEST_ID, intent: "PERFORM" }),
        buildBookingRequestRecord({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", intent: "RENT" }),
      ],
    });
    const result = await venueList(deps);
    const byId = new Map(result.requests.map((r) => [r.id, r]));
    expect(byId.get(REQUEST_ID)?.bookingEvent).toEqual({ state: "none" });
    expect(byId.get(REQUEST_ID)?.bookWithoutTermsPayee).toBe("place");
    expect(byId.get("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")?.bookWithoutTermsPayee).toBe("requester");
    // The venue-scope authorization read is the only place read.
    expect(places.getById).toHaveBeenCalledTimes(1);
  });

  it("an event-first request whose event the SENDER owns pays the sender", async () => {
    const { deps } = setup({
      records: [buildBookingRequestRecord({ originEventId: EVENT_ID })],
      events: [
        buildStageEventRecord({
          id: EVENT_ID,
          status: "DRAFT",
          startsAt: new Date("2026-10-17T19:00:00.000Z"),
          placeId: PLACE_ID,
          calendarId: CALENDAR_ID,
          humanId: OTHER_HUMAN_ID,
          orgId: null,
        }),
      ],
    });
    const [row] = (await venueList(deps)).requests;
    expect(row?.bookingEvent?.state).toBe("live");
    expect(row?.bookWithoutTermsPayee).toBe("requester");
  });

  it("a cancelled event-first origin is gone (every booking path refuses it)", async () => {
    const { deps } = setup({
      records: [buildBookingRequestRecord({ originEventId: EVENT_ID })],
      events: [buildStageEventRecord({ id: EVENT_ID, status: "CANCELLED", placeId: PLACE_ID })],
    });
    const [row] = (await venueList(deps)).requests;
    expect(row?.bookingEvent).toEqual({ state: "gone" });
    expect(row?.bookWithoutTermsPayee).toBeNull();
  });

  it("a dead DRAFT anchor is no event (the mint replaces it)", async () => {
    const { deps } = setup({
      records: [buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID })],
      agreements: [buildAgreementRecord({ status: "DRAFT", eventId: null, draftEventId: EVENT_ID })],
      events: [buildStageEventRecord({ id: EVENT_ID, status: "CANCELLED", placeId: PLACE_ID })],
    });
    const [row] = (await venueList(deps)).requests;
    expect(row?.bookingEvent).toEqual({ state: "none" });
  });

  it("a degraded stage lookup says nothing (null) — the web fails closed", async () => {
    const { deps } = setup({
      records: [buildBookingRequestRecord({ status: "ACCEPTED", agreementId: AGREEMENT_ID })],
      agreementsError: new Error("db down"),
    });
    const [row] = (await venueList(deps)).requests;
    expect(row?.bookingEvent).toBeNull();
    expect(row?.bookWithoutTermsPayee).toBeNull();
  });

  it("marks each hold askedFor by isAskedForNight — a RENT window counts", async () => {
    const { deps } = setup({
      place: { timezone: "Europe/Berlin" },
      records: [
        buildBookingRequestRecord({
          intent: "RENT",
          preferredDates: ["2026-10-17"],
          requestedStartsAt: new Date("2026-10-17T16:00:00.000Z"),
          requestedEndsAt: new Date("2026-10-19T20:00:00.000Z"),
        }),
      ],
      holds: [
        { bookingRequestId: REQUEST_ID, date: "2026-10-18" },
        { bookingRequestId: REQUEST_ID, date: "2026-10-22" },
      ],
    });
    const [row] = (await venueList(deps)).requests;
    const byDate = new Map(row?.holds.map((h) => [h.date, h.askedFor]));
    expect(byDate.get("2026-10-18")).toBe(true);
    expect(byDate.get("2026-10-22")).toBe(false);
  });

  describe("hasBookedNight", () => {
    const OTHER_REQUEST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    it("is true only for a request holding a CONFIRMED hold — one batched read for the page", async () => {
      const { deps, holds } = setup({
        records: [buildBookingRequestRecord({ id: REQUEST_ID }), buildBookingRequestRecord({ id: OTHER_REQUEST })],
        holds: [
          { bookingRequestId: REQUEST_ID, date: "2026-10-17", status: "CONFIRMED" },
          { bookingRequestId: OTHER_REQUEST, date: "2026-10-18" },
        ],
      });
      const result = await venueList(deps);
      const byId = new Map(result.requests.map((r) => [r.id, r]));
      expect(byId.get(REQUEST_ID)?.hasBookedNight).toBe(true);
      expect(byId.get(OTHER_REQUEST)?.hasBookedNight).toBe(false);
      expect(holds.listRequestIdsWithConfirmedHold).toHaveBeenCalledTimes(1);
      expect(holds.listRequestIdsWithConfirmedHold).toHaveBeenCalledWith([REQUEST_ID, OTHER_REQUEST]);
    });

    it("degrades to null on a failed read — reported, and the rest of the stage intact", async () => {
      const reportError = vi.fn();
      const { deps, holds } = setup({ records: [buildBookingRequestRecord()], reportError });
      holds.listRequestIdsWithConfirmedHold.mockRejectedValueOnce(new Error("db down"));
      const [row] = (await venueList(deps)).requests;
      expect(row?.hasBookedNight).toBeNull();
      expect(row?.bookingEvent).toEqual({ state: "none" });
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: expect.objectContaining({ step: "bookedNights" }) }),
      );
    });

    it("a throwing reporter changes nothing — the list still resolves with null", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });
      const { deps, holds } = setup({ records: [buildBookingRequestRecord()], reportError });
      holds.listRequestIdsWithConfirmedHold.mockRejectedValueOnce(new Error("db down"));
      const [row] = (await venueList(deps)).requests;
      expect(row?.hasBookedNight).toBeNull();
      expect(row?.bookingEvent).toEqual({ state: "none" });
      expect(reportError).toHaveBeenCalledTimes(1);
    });
  });
});
