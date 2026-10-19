import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { OrgMemberRecord } from "@th/types/repos/organizations";

import {
  BOOKING_CANCELLED_VARIANT,
  fireBookingCancelled,
  notifyBookingCancelled,
  type NotifyBookingCancelledArgs,
  type NotifyBookingCancelledDeps,
} from "../notify-booking-cancelled";
import { renderNotification } from "../../comms/renderers";
import { PLACE_ID, REQUEST_ID, buildBookingRequestRecord } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// booking-the-night N13 / FR-009, review W4: when a booked night is
// cancelled, BOTH sides hear it (in-app + email + push) with the canceller's
// reason — never the canceller themselves.
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC_APP_URL = "https://ithasfire.test";
const HOLD_ID = "b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0";
const ACT_HUMAN_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const VENUE_OWNER_ID = "11111111-1111-4111-8111-111111111111";
const VENUE_ORG_ID = "22222222-2222-4222-8222-222222222299";
const VENUE_ADMIN_ID = "99999999-9999-4999-8999-999999999991";
const VENUE_SCANNER_ID = "99999999-9999-4999-8999-999999999994";
const REASON = "The roof is leaking; we're shut that week.";

function member(humanId: string, role: OrgMemberRecord["role"]): OrgMemberRecord {
  return { humanId, name: null, email: null, role, joinedAt: new Date("2026-01-01T00:00:00.000Z") };
}

function buildDeps(options: { notifyImpl?: (input: unknown) => Promise<unknown>; publicAppUrl?: string | null } = {}) {
  const notify = vi.fn(options.notifyImpl ?? (async () => ({ ok: true })));
  const repos = {
    places: {
      getById: vi.fn(async (id: string) => ({
        id,
        humanIdsWithAccess: [VENUE_OWNER_ID],
        orgIdsWithAccess: [VENUE_ORG_ID],
      })),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({ id, name: "Corner Stage LLC", slug: "corner-stage" })),
      getByIds: vi.fn(async () => []),
      listMembers: vi.fn(async ({ offset }: { offset: number }) => ({
        items: offset === 0 ? [member(VENUE_ADMIN_ID, "ADMIN"), member(VENUE_SCANNER_ID, "SCANNER")] : [],
        total: 2,
      })),
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, name: "Alice Act" })),
      getByIdWithIdentity: vi.fn(async () => ({ identity: { username: "venue-owner" } })),
    },
    entityPages: { getByOwner: vi.fn(async () => null) },
    performerBookingDefaults: { getByOwner: vi.fn(async () => ({ actName: "The Midnight Ramblers" })) },
  };
  const reportError = vi.fn();
  const logger = createTestLogger();
  vi.mocked(logger.child).mockReturnValue(logger);
  const deps: NotifyBookingCancelledDeps = {
    repos: repos as unknown as NotifyBookingCancelledDeps["repos"],
    notify: notify as unknown as NotifyBookingCancelledDeps["notify"],
    logger,
    reportError,
    publicAppUrl: options.publicAppUrl === undefined ? PUBLIC_APP_URL : options.publicAppUrl,
  };
  return { deps, notify, reportError, logger };
}

const request = () =>
  buildBookingRequestRecord({
    performerOwnerType: "human",
    performerOwnerId: ACT_HUMAN_ID,
    placeName: "The Corner Stage",
    actName: null,
  } as Parameters<typeof buildBookingRequestRecord>[0]);

function args(over: Partial<NotifyBookingCancelledArgs> = {}): NotifyBookingCancelledArgs {
  return {
    bookingRequest: request(),
    holdId: HOLD_ID,
    night: "2026-10-17",
    cancelledBy: "venue",
    reason: REASON,
    eventCancelled: true,
    actorHumanId: VENUE_ADMIN_ID,
    ...over,
  };
}

type Call = { humanId: string; variant: string; idempotencyKey: string; payload: Record<string, unknown> };
const calls = (notify: { mock: { calls: unknown[][] } }) => notify.mock.calls.map((c) => c[0] as Call);

describe("notifyBookingCancelled", () => {
  it("the venue cancels: the act AND the venue's other people hear it with the reason; the canceller and scanners do not", async () => {
    const { deps, notify } = buildDeps();

    await notifyBookingCancelled(deps, args());

    const sent = calls(notify);
    expect(sent.map((c) => c.humanId).sort()).toEqual([ACT_HUMAN_ID, VENUE_OWNER_ID].sort());
    const toAct = sent.find((c) => c.humanId === ACT_HUMAN_ID)!;
    expect(toAct).toEqual({
      humanId: ACT_HUMAN_ID,
      variant: BOOKING_CANCELLED_VARIANT,
      idempotencyKey: `booking-cancelled:${REQUEST_ID}:${HOLD_ID}:${ACT_HUMAN_ID}`,
      payload: {
        bookingRequestId: REQUEST_ID,
        cancelledByName: "The Corner Stage",
        cancelledBy: "place",
        date: "2026-10-17",
        reason: REASON,
        eventCancelled: true,
        targetUrl: `${PUBLIC_APP_URL}/account/settings/booking-requests`,
      },
      channels: { sms: { enabled: false } },
    });
    expect(sent.find((c) => c.humanId === VENUE_OWNER_ID)!.payload.targetUrl).toBe(
      `${PUBLIC_APP_URL}/admin/@venue-owner/places/${PLACE_ID}/bookings`,
    );
  });

  it("the act cancels: every venue person hears it under the act's name; the act does not", async () => {
    const { deps, notify } = buildDeps();

    await notifyBookingCancelled(
      deps,
      args({ cancelledBy: "sender", actorHumanId: ACT_HUMAN_ID, eventCancelled: false }),
    );

    const sent = calls(notify);
    expect(sent.map((c) => c.humanId).sort()).toEqual([VENUE_ADMIN_ID, VENUE_OWNER_ID].sort());
    for (const c of sent) {
      expect(c.payload).toMatchObject({
        cancelledByName: "The Midnight Ramblers",
        cancelledBy: "sender",
        reason: REASON,
        eventCancelled: false,
      });
    }
    expect(sent.find((c) => c.humanId === VENUE_ADMIN_ID)!.payload.targetUrl).toBe(
      `${PUBLIC_APP_URL}/admin/corner-stage/places/${PLACE_ID}/bookings`,
    );
  });

  it("a canceller who is BOTH venue staff and the act (the owner books their own band) is excluded once from each side; the others still hear it", async () => {
    const { deps, notify } = buildDeps();
    // The venue's human owner is also the request's sender pair.
    const both = buildBookingRequestRecord({
      performerOwnerType: "human",
      performerOwnerId: VENUE_OWNER_ID,
      placeName: "The Corner Stage",
      actName: "Owner's Own Band",
    } as Parameters<typeof buildBookingRequestRecord>[0]);

    await notifyBookingCancelled(
      deps,
      args({ bookingRequest: both, cancelledBy: "sender", actorHumanId: VENUE_OWNER_ID }),
    );

    const sent = calls(notify);
    // Not as the act (the sender side), not as the owner (the venue side);
    // the scanner is below the edit bar as ever. Only the org's admin hears.
    expect(sent.map((c) => c.humanId)).toEqual([VENUE_ADMIN_ID]);
    expect(sent[0]!.payload).toMatchObject({ cancelledBy: "sender", cancelledByName: "Owner's Own Band", reason: REASON });
  });

  it("renders in-app, push AND the booking_cancelled email, the reason included", async () => {
    const { deps, notify } = buildDeps();
    await notifyBookingCancelled(deps, args());

    const call = calls(notify)[0]!;
    const rendered = renderNotification(call.variant, call.payload, { now: new Date() });
    expect(rendered.inApp?.title).toMatch(/^The Corner Stage cancelled the booking for .*Oct 17/);
    expect(rendered.inApp?.body).toContain(REASON);
    expect(rendered.push?.title).toBe(rendered.inApp?.title);
    expect(rendered.email?.template?.key).toBe("booking.booking_cancelled");
    expect(rendered.email?.template?.variables).toMatchObject({ reason: REASON, eventCancelled: true });
  });

  it("one recipient's failure is logged + reported; the others are still told", async () => {
    const boom = new Error("smtp down");
    const { deps, notify, reportError, logger } = buildDeps({
      notifyImpl: async (input) => {
        if ((input as Call).humanId === ACT_HUMAN_ID) throw boom;
        return { ok: true };
      },
    });

    await notifyBookingCancelled(deps, args());

    expect(notify).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.notify_booking_cancelled.recipient_failed",
      expect.objectContaining({ humanId: ACT_HUMAN_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ tags: { useCase: "notifyBookingCancelled" } }),
    );
  });

  it("refuses without publicAppUrl before telling anyone", async () => {
    const { deps, notify } = buildDeps({ publicAppUrl: null });
    await expect(notifyBookingCancelled(deps, args())).rejects.toThrow(/publicAppUrl/);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("fireBookingCancelled", () => {
  it("swallows a thrown hook: logger.error + reportError with the step tag; a throwing reporter changes nothing", async () => {
    const boom = new Error("notify down");
    const logger = createTestLogger();
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });

    await expect(
      fireBookingCancelled(
        { notifyBookingCancelled: vi.fn(async () => { throw boom; }), logger, reportError },
        args(),
        "cancelBooking",
      ),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.notify_booking_cancelled_failed",
      expect.objectContaining({ bookingRequestId: REQUEST_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "cancelBooking", step: "booking_cancelled" },
      extra: { bookingRequestId: REQUEST_ID },
    });
  });
});
