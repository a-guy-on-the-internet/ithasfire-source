import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import type { BookingRequestNotificationIntent } from "../_shared/booking-request-intents";
import {
  dispatchBookingRequestIntents,
  type DispatchBookingRequestIntentsDeps,
} from "../notify-booking-request-intents";
import { ACTOR_ID, PLACE_ID, REQUEST_ID } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher for the booking-request intents (venue-confirmation spec). One
// kind since the 2026-09-25 amendment removed parking (and with it the venue
// claim invite and the unparked notice): `request.received`, the event-first
// create's FR-008 notice to the claimed venue.
// ─────────────────────────────────────────────────────────────────────────────

const AT = new Date("2026-09-07T12:00:00.000Z");

function buildDeps(options: { notifyError?: Error } = {}) {
  const notify = vi.fn(async () => {
    if (options.notifyError) throw options.notifyError;
    return { ok: true as const, variant: "x", category: "transactional" as const, scope: "user" as const, inApp: { delivered: false } };
  });
  const reportError = vi.fn();
  // The dispatcher logs through `logger.child(...)`; pin the child to the
  // parent so the info/error assertions below see the calls.
  const logger = createTestLogger();
  (logger.child as ReturnType<typeof vi.fn>).mockImplementation(() => logger);
  const deps = {
    repos: {
      places: {
        getById: vi.fn(async () => ({ id: PLACE_ID, name: "The Corner Stage", phone: null, website: null })),
      },
      organizations: {
        getById: vi.fn(async (id: string) => ({ id, slug: "corner-org" })),
        listMembers: vi.fn(async () => ({ items: [], total: 0 })),
      },
      humans: {
        getByIdWithIdentity: vi.fn(async (id: string) => ({ human: { id }, identity: { username: "sam" } })),
      },
      entityPages: { getByOwner: vi.fn(async () => null) },
    },
    notify,
    logger,
    reportError,
    publicAppUrl: "https://ithasfire.test/",
  } as unknown as DispatchBookingRequestIntentsDeps;
  return { deps, notify, reportError, logger };
}

const receivedIntent: BookingRequestNotificationIntent = {
  kind: "request.received",
  bookingRequestId: REQUEST_ID,
  placeId: PLACE_ID,
  at: AT,
};

describe("dispatchBookingRequestIntents — no intents", () => {
  it("no intents → no reads at all", async () => {
    const { deps, notify } = buildDeps();
    await expect(dispatchBookingRequestIntents(deps, { intents: [] })).resolves.toBeUndefined();
    expect(deps.repos.places.getById).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("dispatchBookingRequestIntents — request.received (event-first)", () => {
  function withRequest(deps: DispatchBookingRequestIntentsDeps, request: Record<string, unknown> | null) {
    (deps.repos as unknown as { bookingRequests: unknown }).bookingRequests = {
      getById: vi.fn(async () => request),
    };
    (deps.repos.places.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PLACE_ID,
      name: "The Corner Stage",
      humanIdsWithAccess: [ACTOR_ID],
      orgIdsWithAccess: [],
    });
    return deps;
  }

  it("re-reads the request + place and sends the claimed venue the SAME FR-008 notice a pitch sends (per-recipient key on the request id)", async () => {
    const { deps, notify } = buildDeps();
    withRequest(deps, {
      id: REQUEST_ID,
      placeId: PLACE_ID,
      performerOwnerType: "human",
      performerOwnerId: ACTOR_ID,
      contactName: null,
      contactEmail: null,
      message: "Basement Show",
      preferredDates: ["2026-10-02"],
      source: "PLATFORM",
      actName: "The Act",
    });

    await dispatchBookingRequestIntents(deps, { intents: [receivedIntent] });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: ACTOR_ID,
        variant: "booking.request-received",
        idempotencyKey: `booking-request-received:${REQUEST_ID}:${ACTOR_ID}`,
        payload: expect.objectContaining({ bookingRequestId: REQUEST_ID, placeId: PLACE_ID, message: "Basement Show" }),
      }),
    );
  });

  it("a request deleted between commit and dispatch is reported, nothing sent, nothing thrown", async () => {
    const { deps, notify, reportError } = buildDeps();
    withRequest(deps, null);

    await dispatchBookingRequestIntents(deps, { intents: [receivedIntent] });

    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "dispatchBookingRequestIntents" },
      extra: { bookingRequestId: REQUEST_ID, placeId: PLACE_ID, reason: "request_not_found" },
    });
  });
});
