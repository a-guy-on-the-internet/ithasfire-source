import { afterEach, describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { eventsRouter } from "../events";
import * as eventsUseCases from "@th/core/use-cases/events";
import { createCaller as createCallerFromHelpers } from "./test-helpers";

// Same two module-boundary seams `events.test.ts` mocks: the post-commit
// dispatchers. Neither is under test here; they only need to not send mail.
vi.mock("@th/core/use-cases/booking-holds/notify-booking-hold-intents", () => ({
  dispatchBookingHoldIntents: vi.fn(async () => undefined),
  BOOKING_HOLD_VARIANTS: {},
  buildIdempotencyKey: vi.fn(),
}));
vi.mock("@th/core/use-cases/booking-requests/notify-booking-request-intents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/core/use-cases/booking-requests/notify-booking-request-intents")>()),
  dispatchBookingRequestIntents: vi.fn(async () => undefined),
}));
import { dispatchBookingRequestIntents } from "@th/core/use-cases/booking-requests";

/**
 * Event-first on the WIRE (venue-confirmation spec "UI / Flow › Event
 * builder"): the booking request a save created or found reaches the
 * builder as `bookingRequest`, so it can render "Sent to The Blue Room for
 * confirmation" / "This venue hasn't claimed its page yet". The intents
 * that ride the same server output are dispatched here and stripped.
 *
 * Transport-only: the use case is stubbed. WHEN a request is created and
 * what it carries is pinned in core (`save-event-event-first.test.ts`).
 */

const createCaller = (ctxOverrides?: Partial<Ctx>) =>
  createCallerFromHelpers(eventsRouter, ctxOverrides);

const EVENT_ID = "99999999-9999-4999-8999-999999999999";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const AT = new Date("2026-09-07T12:00:00.000Z");
const baseInput = {
  title: "Basement Show",
  startsAt: "2026-10-03T01:30:00.000Z",
  endsAt: "2026-10-03T04:00:00.000Z",
  location: { placeId: PLACE_ID },
  calendarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  clientKey: "abcdefgh",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createEventForHuman / createEventForOrg — `bookingRequest` on the wire", () => {
  it("createEventForHuman: a created request reaches the wire with its venue, intent and parking; the intents do not", async () => {
    const bookingRequest = {
      id: REQUEST_ID,
      placeId: PLACE_ID,
      placeName: "The Blue Room",
      intent: "PERFORM" as const,
      parked: false,
      outcome: "created" as const,
    };
    const intents = [{ kind: "request.received" as const, bookingRequestId: REQUEST_ID, placeId: PLACE_ID, at: AT }];
    vi.spyOn(eventsUseCases, "saveEventForHuman").mockResolvedValue({
      eventId: EVENT_ID,
      status: "DRAFT",
      bookingRequestNotificationIntents: intents,
      bookingRequest,
    });
    const dispatchMock = vi.mocked(dispatchBookingRequestIntents);
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue(undefined);
    const { caller } = createCaller({ publicAppUrl: "https://ithasfire.test" });

    const result = await caller.createEventForHuman(baseInput);

    expect(result).toEqual({ eventId: EVENT_ID, status: "DRAFT", bookingRequest });
    expect("bookingRequestNotificationIntents" in result).toBe(false);
    expect("notificationIntents" in result).toBe(false);
    expect("staffRecipientHint" in result).toBe(false);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  // Nothing parks since the 2026-09-25 amendment; a re-save that finds a
  // request parked BEFORE it (and not yet expired by the cleanup) still
  // reports it as parked until the field goes with the column.
  it("createEventForHuman: an OLD parked request found on re-save reaches the wire as parked:true", async () => {
    vi.spyOn(eventsUseCases, "saveEventForHuman").mockResolvedValue({
      eventId: EVENT_ID,
      status: "DRAFT",
      bookingRequest: {
        id: REQUEST_ID,
        placeId: PLACE_ID,
        placeName: "The Blue Room",
        intent: "PERFORM",
        parked: true,
        outcome: "existing",
      },
    });
    const { caller } = createCaller({ publicAppUrl: "https://ithasfire.test" });

    const result = await caller.createEventForHuman(baseInput);

    expect(result.bookingRequest).toMatchObject({ parked: true, placeName: "The Blue Room" });
  });

  it("createEventForOrg: an existing request (re-save) and a null (no request) both cross the wire as-is", async () => {
    const existing = {
      id: REQUEST_ID,
      placeId: PLACE_ID,
      placeName: "The Blue Room",
      intent: "RENT" as const,
      parked: false,
      outcome: "existing" as const,
    };
    const saveSpy = vi
      .spyOn(eventsUseCases, "saveEventForOrg")
      .mockResolvedValueOnce({ eventId: EVENT_ID, status: "DRAFT", bookingRequest: existing })
      .mockResolvedValueOnce({ eventId: EVENT_ID, status: "DRAFT", bookingRequest: null });
    const { caller } = createCaller({ publicAppUrl: "https://ithasfire.test" });
    const orgInput = { ...baseInput, orgId: "22222222-2222-4222-8222-222222222222" };

    const resave = await caller.createEventForOrg({ ...orgInput, eventId: EVENT_ID });
    expect(resave).toEqual({ eventId: EVENT_ID, status: "DRAFT", bookingRequest: existing });

    const none = await caller.createEventForOrg(orgInput);
    expect(none).toEqual({ eventId: EVENT_ID, status: "DRAFT", bookingRequest: null });
    expect(saveSpy).toHaveBeenCalledTimes(2);
  });

  it("createEventForHuman: a venue refusal the save absorbed reaches the wire as `outcome: 'skipped'` with the venue and the refusal (owner ruling 2026-09-08), never collapsed to null", async () => {
    const skipped = {
      outcome: "skipped" as const,
      reason: "venue_not_accepting" as const,
      code: "PLACE_NOT_ACCEPTING_REQUESTS",
      message: "booking_requests_unconfigured",
      placeId: PLACE_ID,
      placeName: "The Blue Room",
      intent: "PERFORM" as const,
    };
    vi.spyOn(eventsUseCases, "saveEventForHuman").mockResolvedValue({
      eventId: EVENT_ID,
      status: "DRAFT",
      bookingRequest: skipped,
    });
    const dispatchMock = vi.mocked(dispatchBookingRequestIntents);
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue(undefined);
    const { caller } = createCaller({ publicAppUrl: "https://ithasfire.test" });

    const result = await caller.createEventForHuman(baseInput);

    expect(result).toEqual({ eventId: EVENT_ID, status: "DRAFT", bookingRequest: skipped });
    // Nothing was created, so nothing is owed: no intents means no dispatch.
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
