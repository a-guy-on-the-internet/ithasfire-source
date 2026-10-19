import { describe, expect, it, vi } from "vitest";

import {
  BOOKING_LINEUP_INVITED_VARIANT,
  bookingLineupInvitedIdempotencyKey,
  notifyBookingLineupInvited,
  type NotifyBookingLineupInvitedDeps,
} from "../notify-booking-lineup-invited";
import { renderNotification } from "../../comms/renderers";
import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
} from "./helpers";

const TAGGED_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TAGGED_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const PUBLIC_APP_URL = "https://ithasfire.test/";
const place = { id: PLACE_ID, name: "The Corner Stage" };

/** A logger whose `child()` is itself, so the use case's scoped logs are observable. */
function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function buildDeps(
  options: {
    notifyImpl?: (input: unknown) => Promise<unknown>;
    humanName?: string | null;
    orgName?: string;
    publicAppUrl?: string | null;
    reportError?: NotifyBookingLineupInvitedDeps["reportError"];
  } = {},
) {
  const notify = vi.fn(options.notifyImpl ?? (async () => ({ ok: true })));
  const repos = {
    humans: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          name: options.humanName === undefined ? "Sam Promoter" : options.humanName,
        })),
      ),
    },
    organizations: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: options.orgName ?? "Corner Booking Collective" })),
      ),
    },
  };
  const deps = {
    repos,
    notify,
    logger: makeLogger(),
    reportError: options.reportError,
    publicAppUrl:
      options.publicAppUrl === undefined ? PUBLIC_APP_URL : options.publicAppUrl,
  } as unknown as NotifyBookingLineupInvitedDeps;
  return { deps, notify, repos };
}

describe("notifyBookingLineupInvited", () => {
  it("sends ONE invite per tagged human with a (request, human) idempotency key, sms off, and an absolute confirm link", async () => {
    const { deps, notify } = buildDeps();
    const request = buildBookingRequestRecord({ preferredDates: ["2026-08-14"] });

    await notifyBookingLineupInvited(deps, {
      bookingRequest: request,
      place,
      // A repeated id is sent once.
      taggedHumanIds: [TAGGED_A, TAGGED_B, TAGGED_A],
    });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map(([input]) => (input as { humanId: string }).humanId)).toEqual([
      TAGGED_A,
      TAGGED_B,
    ]);
    expect(notify).toHaveBeenNthCalledWith(1, {
      humanId: TAGGED_A,
      variant: BOOKING_LINEUP_INVITED_VARIANT,
      idempotencyKey: `booking-lineup-invited:${REQUEST_ID}:${TAGGED_A}`,
      channels: { sms: { enabled: false } },
      payload: {
        bookingRequestId: REQUEST_ID,
        humanId: TAGGED_A,
        senderName: "Sam Promoter",
        venueName: "The Corner Stage",
        preferredDates: ["2026-08-14"],
        // Trailing slash on the base URL does not double up.
        targetUrl: `https://ithasfire.test/bookings/acts/${REQUEST_ID}`,
      },
    });
    expect(bookingLineupInvitedIdempotencyKey(REQUEST_ID, TAGGED_B)).toBe(
      `booking-lineup-invited:${REQUEST_ID}:${TAGGED_B}`,
    );
  });

  it("every payload it builds passes the real renderer (no notify-time schema failure)", async () => {
    const { deps, notify } = buildDeps();
    await notifyBookingLineupInvited(deps, {
      bookingRequest: buildBookingRequestRecord({ preferredDates: ["2026-08-14T20:00"] }),
      place,
      taggedHumanIds: [TAGGED_A],
    });
    const { variant, payload } = notify.mock.calls[0]![0] as { variant: string; payload: unknown };
    expect(() => renderNotification(variant, payload, { now: NOW })).not.toThrow();
  });

  it("names an ORG sender by the org's name", async () => {
    const { deps, notify } = buildDeps({ orgName: "Night Owl Presents" });
    await notifyBookingLineupInvited(deps, {
      bookingRequest: buildBookingRequestRecord({
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
      place,
      taggedHumanIds: [TAGGED_A],
    });
    expect(notify.mock.calls[0]![0]).toMatchObject({
      payload: { senderName: "Night Owl Presents" },
    });
  });

  it("an unresolvable sender is 'Someone' — NEVER the request's actName (it may name an act on the bill)", async () => {
    const { deps, notify } = buildDeps({ humanName: null });
    await notifyBookingLineupInvited(deps, {
      // A promoter bill's actName can be a free-text act's name; the tagged
      // artist must not be told that act "added you to a bill".
      bookingRequest: buildBookingRequestRecord({ actName: "The Openers" }),
      place,
      taggedHumanIds: [TAGGED_A],
    });
    expect(notify.mock.calls[0]![0]).toMatchObject({
      payload: { senderName: "Someone" },
    });
    expect(JSON.stringify(notify.mock.calls[0]![0])).not.toContain("The Openers");
  });

  it("a nameless venue gets its OWN neutral fallback, not the sender's", async () => {
    const { deps, notify } = buildDeps();
    await notifyBookingLineupInvited(deps, {
      bookingRequest: buildBookingRequestRecord(),
      place: { id: PLACE_ID, name: "  " },
      taggedHumanIds: [TAGGED_A],
    });
    expect(notify.mock.calls[0]![0]).toMatchObject({
      payload: { senderName: "Sam Promoter", venueName: "a place" },
    });
  });

  it("does nothing for an empty tag list", async () => {
    const { deps, notify, repos } = buildDeps({ publicAppUrl: null });
    await notifyBookingLineupInvited(deps, {
      bookingRequest: buildBookingRequestRecord(),
      place,
      taggedHumanIds: [],
    });
    expect(notify).not.toHaveBeenCalled();
    expect(repos.humans.getByIds).not.toHaveBeenCalled();
  });

  it("throws once (for the caller's swallow) when publicAppUrl is missing — no half-built links", async () => {
    const { deps, notify } = buildDeps({ publicAppUrl: null });
    await expect(
      notifyBookingLineupInvited(deps, {
        bookingRequest: buildBookingRequestRecord(),
        place,
        taggedHumanIds: [TAGGED_A],
      }),
    ).rejects.toThrow(/publicAppUrl/);
    expect(notify).not.toHaveBeenCalled();
  });

  it("isolates a failing recipient: logs at error, REPORTS it, and still invites the rest", async () => {
    const boom = new Error("push provider down");
    const reportError = vi.fn();
    const { deps, notify } = buildDeps({
      reportError,
      notifyImpl: async (input) => {
        if ((input as { humanId: string }).humanId === TAGGED_A) throw boom;
        return { ok: true };
      },
    });

    await expect(
      notifyBookingLineupInvited(deps, {
        bookingRequest: buildBookingRequestRecord(),
        place,
        taggedHumanIds: [TAGGED_A, TAGGED_B],
      }),
    ).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "notifyBookingLineupInvited" },
      extra: {
        bookingRequestId: REQUEST_ID,
        placeId: PLACE_ID,
        humanId: TAGGED_A,
        // A person invited as themselves, not via a tagged group.
        viaOrgId: null,
      },
    });
    const logger = deps.logger as unknown as ReturnType<typeof makeLogger>;
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.notify_lineup_invited.recipient_failed",
      expect.objectContaining({ humanId: TAGGED_A, err: boom }),
    );
  });

  it("a throwing reporter never escapes the per-recipient swallow", async () => {
    const { deps, notify } = buildDeps({
      reportError: () => {
        throw new Error("sentry down");
      },
      notifyImpl: async () => {
        throw new Error("mailer down");
      },
    });
    await expect(
      notifyBookingLineupInvited(deps, {
        bookingRequest: buildBookingRequestRecord({ performerOwnerId: ACTOR_ID }),
        place,
        taggedHumanIds: [TAGGED_A, TAGGED_B],
      }),
    ).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
