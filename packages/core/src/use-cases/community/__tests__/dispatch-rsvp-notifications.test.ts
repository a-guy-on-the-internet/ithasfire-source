import { describe, expect, it, vi } from "vitest";

import { renderNotification } from "../../comms/renderers";

import type { ClockPort } from "@th/ports/clock";
import type { RsvpNoticeRecord } from "@th/ports/repos/rsvp-notices";

import type { EventDateRecord } from "@th/ports/repos/event-dates";

import {
  dispatchRsvpNotifications,
  type DispatchRsvpNotificationsDeps,
} from "../dispatch-rsvp-notifications";
import { EVENT_ID, USER_ID, makeCommunityEvent } from "./helpers";

const NOW = new Date("2026-07-06T12:00:00.000Z");
/** Mirrors `makeCommunityEvent().slug` — multi-segment, like a real one. */
const EVENT_SLUG = "event/us/austin/weekly-open-mic-2026-08-01-2000--abc123";
const DATE_ID = "dddddddd-1111-4111-8111-dddddddddddd";

function buildNotice(
  overrides: Partial<RsvpNoticeRecord> = {},
): RsvpNoticeRecord {
  return {
    id: "notice-1",
    eventId: EVENT_ID,
    eventDateId: null,
    humanId: USER_ID,
    kind: "CONFIRMATION",
    createdAt: new Date("2026-07-06T11:00:00.000Z"),
    dispatchedAt: null,
    attempts: 0,
    ...overrides,
  };
}

/** A SCHEDULED occurrence of EVENT_ID with its OWN start/end times. */
function makeEventDate(
  overrides: Partial<EventDateRecord> = {},
): EventDateRecord {
  return {
    id: DATE_ID,
    eventId: EVENT_ID,
    ordinal: 3,
    startsAt: new Date("2026-08-18T20:00:00.000Z"),
    endsAt: new Date("2026-08-18T22:30:00.000Z"),
    status: "SCHEDULED",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createDeps(args: {
  notices: RsvpNoticeRecord[];
  event?: ReturnType<typeof makeCommunityEvent> | null;
  eventDate?: EventDateRecord | null;
  rsvpExists?: boolean;
  dateRsvpExists?: boolean;
  /** Any live RSVP on a CANCELLED night of the event (whole-listing check). */
  eventDateRsvpExists?: boolean;
  notify?: DispatchRsvpNotificationsDeps["notify"];
  appBaseUrl?: string;
  /** The event's venue row, served by `places.getById`. */
  place?: Record<string, unknown> | null;
}) {
  // Stateful in-memory outbox so a test can run the drain TWICE against the
  // same notices and observe retry/dead-letter behavior across ticks. Spies
  // still record every call.
  const outbox = args.notices;
  const rsvpNotices = {
    create: vi.fn(),
    // Return COPIES, like a real DB read: the drain's in-hand snapshot must
    // not be live-mutated by the incrementAttempts bookkeeping below
    // (production records are snapshots too).
    listUndispatched: vi.fn(async () =>
      outbox.filter((n) => n.dispatchedAt === null).map((n) => ({ ...n })),
    ),
    markDispatched: vi.fn(async (ids: string[], at: Date) => {
      for (const n of outbox) if (ids.includes(n.id)) n.dispatchedAt = at;
    }),
    incrementAttempts: vi.fn(async (ids: string[]) => {
      for (const n of outbox) if (ids.includes(n.id)) n.attempts += 1;
    }),
    deleteDispatchedBefore: vi.fn(async () => 0),
  };
  const events = {
    getById: vi.fn(async () =>
      args.event === undefined ? makeCommunityEvent() : args.event,
    ),
  };
  const eventRsvps = {
    existsForUser: vi.fn(async () => args.rsvpExists ?? true),
  };
  const eventDates = {
    getById: vi.fn(async () =>
      args.eventDate === undefined ? makeEventDate() : args.eventDate,
    ),
  };
  const eventDateRsvps = {
    existsForUser: vi.fn(async () => args.dateRsvpExists ?? true),
    existsForUserOnEvent: vi.fn(async () => args.eventDateRsvpExists ?? true),
  };
  const places = { getById: vi.fn(async () => args.place ?? null) };
  const notify = args.notify ?? vi.fn(async () => ({ ok: true }));
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const clock: ClockPort = { now: vi.fn(() => NOW) };

  const deps: DispatchRsvpNotificationsDeps = {
    repos: {
      rsvpNotices,
      events,
      eventRsvps,
      eventDates,
      eventDateRsvps,
      places,
    } as unknown as DispatchRsvpNotificationsDeps["repos"],
    notify,
    clock,
    // Trailing slash on purpose — the drain must trim it when building URLs.
    appBaseUrl: args.appBaseUrl ?? "https://ithasfire.com/",
    logger: logger as unknown as DispatchRsvpNotificationsDeps["logger"],
  };

  return {
    deps,
    mocks: {
      rsvpNotices,
      events,
      eventRsvps,
      eventDates,
      eventDateRsvps,
      places,
      notify,
      logger,
    },
  };
}

describe("dispatchRsvpNotifications", () => {
  it("no-ops on an empty outbox", async () => {
    const { deps, mocks } = createDeps({ notices: [] });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toEqual({
      processed: 0,
      dispatched: 0,
      skipped: 0,
      deadLettered: 0,
      recipientsNotified: 0,
      passes: 1,
      hasMore: false,
    });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.rsvpNotices.markDispatched).not.toHaveBeenCalled();
  });

  it("sends one rsvp.confirmed per notice with dispatch-time event details, then marks dispatched", async () => {
    const notice = buildNotice();
    const event = makeCommunityEvent({
      heroImageUrl: "https://img.example.com/hero.jpg",
      locationLabel: "The Corner Stage",
    });
    const { deps, mocks } = createDeps({ notices: [notice], event });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toMatchObject({
      processed: 1,
      dispatched: 1,
      skipped: 0,
      deadLettered: 0,
      recipientsNotified: 1,
    });

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith({
      humanId: USER_ID,
      variant: "rsvp.confirmed",
      idempotencyKey: "rsvp-confirmed:notice-1",
      payload: {
        eventId: EVENT_ID,
        eventTitle: "Weekly Open Mic",
        startsAtIso: event.startsAt.toISOString(),
        endsAtIso: event.endsAt!.toISOString(),
        timezone: "America/Chicago",
        venueName: "The Corner Stage",
        addressText: "123 Main St, Austin, TX",
        heroImageUrl: "https://img.example.com/hero.jpg",
        // Trailing slash on appBaseUrl trimmed; event page = cancel surface.
        // SLUG-based: `/events/<uuid>` 404s on the public route, so this link
        // was dead in every RSVP confirmation email until it was fixed.
        eventUrl: `https://ithasfire.com/events/${EVENT_SLUG}`,
        manageRsvpsUrl: "https://ithasfire.com/my-rsvps",
      },
    });

    expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-1"],
      NOW,
    );
    expect(mocks.rsvpNotices.incrementAttempts).not.toHaveBeenCalled();
    // An event-level notice (eventDateId null) never touches the per-date
    // repos — its behaviour is byte-identical to before per-date support.
    expect(mocks.eventDates.getById).not.toHaveBeenCalled();
    expect(mocks.eventDateRsvps.existsForUser).not.toHaveBeenCalled();
  });

  it("per-date notice: confirms with the DATE's start/end times (event tz/venue/urls unchanged)", async () => {
    const notice = buildNotice({ id: "notice-date", eventDateId: DATE_ID });
    const event = makeCommunityEvent({
      heroImageUrl: "https://img.example.com/hero.jpg",
      locationLabel: "The Corner Stage",
    });
    const eventDate = makeEventDate();
    const { deps, mocks } = createDeps({ notices: [notice], event, eventDate });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toMatchObject({
      processed: 1,
      dispatched: 1,
      skipped: 0,
      recipientsNotified: 1,
    });
    expect(mocks.eventDates.getById).toHaveBeenCalledWith(DATE_ID);
    // The per-date branch checks the per-date RSVP row, never the event-level one.
    expect(mocks.eventDateRsvps.existsForUser).toHaveBeenCalledWith({
      eventDateId: DATE_ID,
      humanId: USER_ID,
    });
    expect(mocks.eventRsvps.existsForUser).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith({
      humanId: USER_ID,
      variant: "rsvp.confirmed",
      idempotencyKey: "rsvp-confirmed:notice-date",
      payload: {
        eventId: EVENT_ID,
        eventTitle: "Weekly Open Mic",
        // The OCCURRENCE's times, not the parent event's.
        startsAtIso: eventDate.startsAt.toISOString(),
        endsAtIso: eventDate.endsAt!.toISOString(),
        timezone: "America/Chicago",
        venueName: "The Corner Stage",
        addressText: "123 Main St, Austin, TX",
        heroImageUrl: "https://img.example.com/hero.jpg",
        eventUrl: `https://ithasfire.com/events/${EVENT_SLUG}`,
        // Per-date RSVPs never appear on /my-rsvps (event-level only), so the
        // manage link points at the event page's date list instead.
        manageRsvpsUrl: `https://ithasfire.com/events/${EVENT_SLUG}`,
      },
    });
    expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-date"],
      NOW,
    );
  });

  it("per-date notice: a date without endsAt confirms with endsAtIso null (no backfill from the event)", async () => {
    const notice = buildNotice({ id: "notice-open-ended", eventDateId: DATE_ID });
    const eventDate = makeEventDate({ endsAt: null });
    const { deps, mocks } = createDeps({ notices: [notice], eventDate });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toMatchObject({ processed: 1, dispatched: 1 });
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          startsAtIso: eventDate.startsAt.toISOString(),
          endsAtIso: null,
        }),
      }),
    );
  });

  it("dispatches away a per-date notice whose date vanished — no send", async () => {
    const notice = buildNotice({ id: "notice-date-gone", eventDateId: DATE_ID });
    const { deps, mocks } = createDeps({ notices: [notice], eventDate: null });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-date-gone"],
      NOW,
    );
  });

  it("dispatches away a per-date notice whose date was called off (not SCHEDULED) — no send", async () => {
    const notice = buildNotice({
      id: "notice-date-called-off",
      eventDateId: DATE_ID,
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      eventDate: makeEventDate({ status: "CANCELLED" }),
    });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-date-called-off"],
      NOW,
    );
  });

  it("never confirms a cancelled per-date RSVP: per-date row gone → dispatch away", async () => {
    const notice = buildNotice({
      id: "notice-date-unrsvpd",
      eventDateId: DATE_ID,
    });
    const { deps, mocks } = createDeps({
      notices: [notice],
      dateRsvpExists: false,
      // Even if an event-level RSVP still exists, the per-date one governs.
      rsvpExists: true,
    });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.eventRsvps.existsForUser).not.toHaveBeenCalled();
    expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-date-unrsvpd"],
      NOW,
    );
  });

  it("dispatches away a notice whose event vanished — no send", async () => {
    const notice = buildNotice({ id: "notice-gone" });
    const { deps, mocks } = createDeps({ notices: [notice], event: null });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-gone"],
      NOW,
    );
  });

  it("dispatches away a notice whose event is no longer PUBLISHED — no send", async () => {
    const notice = buildNotice({ id: "notice-cancelled-event" });
    const { deps, mocks } = createDeps({
      notices: [notice],
      event: makeCommunityEvent({ status: "CANCELLED" }),
    });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-cancelled-event"],
      NOW,
    );
  });

  it("never confirms a cancelled RSVP: row gone → dispatch away without sending", async () => {
    const notice = buildNotice({ id: "notice-unrsvpd" });
    const { deps, mocks } = createDeps({
      notices: [notice],
      rsvpExists: false,
    });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
      ["notice-unrsvpd"],
      NOW,
    );
  });

  it("retries a failed send (attempts bumped, NOT dispatched) and dead-letters at maxAttempts", async () => {
    const notice = buildNotice({ id: "notice-flaky" });
    const notify = vi.fn(async () => {
      throw new Error("smtp down");
    });
    const { deps, mocks } = createDeps({ notices: [notice], notify });

    // Tick 1: failure → attempts 1 < 2 → retried, still undispatched.
    const first = await dispatchRsvpNotifications(deps, { maxAttempts: 2 });
    expect(first).toMatchObject({
      processed: 1,
      dispatched: 0,
      deadLettered: 0,
      recipientsNotified: 0,
    });
    expect(notice.attempts).toBe(1);
    expect(notice.dispatchedAt).toBeNull();

    // Tick 2: failure again → attempts 2 >= 2 → dead-lettered (dispatched
    // away so the queue can't clog forever), logged at ERROR.
    const second = await dispatchRsvpNotifications(deps, { maxAttempts: 2 });
    expect(second).toMatchObject({ processed: 1, deadLettered: 1 });
    expect(notice.attempts).toBe(2);
    expect(notice.dispatchedAt).toEqual(NOW);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "community.dispatchRsvpNotifications.dead_letter",
      expect.objectContaining({ noticeId: "notice-flaky" }),
    );
  });

  it("one bad notice never aborts the batch — the rest still dispatch", async () => {
    const bad = buildNotice({ id: "notice-bad" });
    const good = buildNotice({
      id: "notice-good",
      humanId: "33333333-3333-4333-8333-333333333333",
      createdAt: new Date("2026-07-06T11:30:00.000Z"),
    });
    const notify = vi.fn(async (input: { humanId: string }) => {
      if (input.humanId === USER_ID) {
        throw new Error("recipient send failed");
      }
      return { ok: true };
    });
    const { deps } = createDeps({ notices: [bad, good], notify });

    const result = await dispatchRsvpNotifications(deps, {});

    expect(result).toMatchObject({
      processed: 2,
      dispatched: 1,
      recipientsNotified: 1,
    });
    expect(bad.dispatchedAt).toBeNull();
    expect(bad.attempts).toBe(1);
    expect(good.dispatchedAt).toEqual(NOW);
  });

  it("respects batchLimit", async () => {
    const notices = [
      buildNotice({ id: "n1" }),
      buildNotice({ id: "n2", createdAt: new Date("2026-07-06T11:10:00Z") }),
      buildNotice({ id: "n3", createdAt: new Date("2026-07-06T11:20:00Z") }),
    ];
    const { deps, mocks } = createDeps({ notices });
    // The fake listUndispatched ignores limit, so assert the limit is passed
    // through — the adapter enforces it in SQL.
    await dispatchRsvpNotifications(deps, { batchLimit: 2 });
    expect(mocks.rsvpNotices.listUndispatched).toHaveBeenCalledWith({
      limit: 2,
    });
  });

  it("rejects malformed input with a typed error", async () => {
    const { deps } = createDeps({ notices: [] });
    await expect(
      dispatchRsvpNotifications(deps, { batchLimit: -1 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("still confirms (without a link) when the event somehow has no slug", async () => {
    // PUBLISHED implies a slug (publish-event assigns one in the publishing
    // transaction), so this is broken data — the confirmation must still send.
    const notify = vi.fn(async () => ({ ok: true }));
    const { deps, mocks } = createDeps({
      notices: [buildNotice()],
      event: { ...makeCommunityEvent(), slug: null },
      notify,
    });

    await dispatchRsvpNotifications(deps, {});

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
    expect(payload.eventUrl).toBeNull();
    // Manage still points somewhere real.
    expect(payload.manageRsvpsUrl).toBe("https://ithasfire.com/my-rsvps");

    // END TO END through the STRICT renderer. A spy alone would have pinned a
    // false belief: `eventUrl` used to be a REQUIRED `.url()`, so this payload
    // threw inside notify() — before the idempotency claim — and the
    // confirmation dead-lettered after burning its retries.
    const rendered = renderNotification(variant, payload, { now: NOW });
    expect(rendered.inApp?.action).toBeNull();
    expect(rendered.email?.text).not.toContain("View the event");
    expect(rendered.email?.text).toContain("Manage your RSVPs");
    expect(rendered.inApp?.body).toContain("Weekly Open Mic");
  });

  it("falls back to the generated OG Date Stub when the event has no poster", async () => {
    // The empty image slot this replaces: a posterless event's confirmation
    // email used to render no hero at all. The stub URL must survive the
    // STRICT `z.string().url()` in the renderer, which runs inside notify()
    // BEFORE the idempotency claim — a relative URL would sink the notice.
    const notify = vi.fn(async () => ({ ok: true }));
    const { deps, mocks } = createDeps({
      notices: [buildNotice()],
      event: makeCommunityEvent({ heroImageUrl: null }),
      notify,
    });

    await dispatchRsvpNotifications(deps, {});

    const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
    expect(payload.heroImageUrl).toMatch(
      new RegExp(
        `^https://ithasfire\\.com/og/event/${EVENT_SLUG}\\?v=[0-9a-f]{16}$`,
      ),
    );
    expect(() => renderNotification(variant, payload, { now: NOW })).not.toThrow();
  });

  it("renders end to end with BOTH links when the event has a slug", async () => {
    const notify = vi.fn(async () => ({ ok: true }));
    const { deps, mocks } = createDeps({
      notices: [buildNotice()],
      notify,
    });

    await dispatchRsvpNotifications(deps, {});

    const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
    const rendered = renderNotification(variant, payload, { now: NOW });
    expect(rendered.inApp?.action).toEqual({
      label: "View event",
      route: `/events/${EVENT_SLUG}`,
    });
    expect(rendered.email?.text).toContain(
      `View the event: https://ithasfire.com/events/${EVENT_SLUG}`,
    );
  });

  // ── DATE_CANCELLED notices ────────────────────────────────────────────────
  //
  // The branch that used to guarantee silence. A per-date notice on a
  // not-SCHEDULED occurrence was dispatched away unsent, which meant the one
  // moment you most want to reach someone — their night being called off — was
  // the one moment nothing could be sent.
  describe("call-off notices", () => {
    const buildCancellation = (overrides: Partial<RsvpNoticeRecord> = {}) =>
      buildNotice({
        id: "notice-called-off",
        eventDateId: DATE_ID,
        kind: "DATE_CANCELLED",
        ...overrides,
      });

    it("SENDS on a CANCELLED date — the skip branch is now the message", async () => {
      const { deps, mocks } = createDeps({
        notices: [buildCancellation()],
        eventDate: makeEventDate({ status: "CANCELLED" }),
      });

      const result = await dispatchRsvpNotifications(deps, {});

      expect(result).toMatchObject({ processed: 1, dispatched: 1, skipped: 0 });
      const call = (mocks.notify.mock.calls[0] as any[])[0];
      expect(call.variant).toBe("rsvp.date_cancelled");
      expect(call.humanId).toBe(USER_ID);
      // The OCCURRENCE's instant, not the event's — which night is the only
      // question the recipient has.
      expect(call.payload.startsAtIso).toBe(
        makeEventDate().startsAt.toISOString(),
      );
      expect(call.payload.eventDateId).toBe(DATE_ID);
      expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
        ["notice-called-off"],
        NOW,
      );
    });

    it("renders end to end: names the DATE, links to the rest of the schedule", async () => {
      const { deps, mocks } = createDeps({
        notices: [buildCancellation()],
        eventDate: makeEventDate({ status: "CANCELLED" }),
      });

      await dispatchRsvpNotifications(deps, {});

      const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
      const rendered = renderNotification(variant, payload, { now: NOW });
      // Never the bare "Weekly Open Mic has been cancelled" — the series is
      // not cancelled, one night of it is.
      expect(rendered.inApp?.title).toContain("Cancelled: Weekly Open Mic on");
      expect(rendered.inApp?.body).toContain("the rest of the schedule");
      expect(rendered.inApp?.kind).toBe("WARNING");
      expect(rendered.inApp?.action).toEqual({
        label: "See other dates",
        route: `/events/${EVENT_SLUG}`,
      });
      expect(rendered.category).toBe("transactional");
      // No push: a truncated lock-screen "X is cancelled" is a worse lie than
      // silence when only one night is off.
      expect(rendered.push).toBeUndefined();
    });

    it("a one-night call-off on a still-PUBLISHED listing keeps the per-night copy", async () => {
      const { deps, mocks } = createDeps({
        notices: [buildCancellation()],
        eventDate: makeEventDate({ status: "CANCELLED" }),
      });

      await dispatchRsvpNotifications(deps, {});

      const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
      expect(payload).not.toHaveProperty("listingCancelled");
      expect(payload.eventUrl).toBe(`https://ithasfire.com/events/${EVENT_SLUG}`);
      const rendered = renderNotification(variant, payload, { now: NOW });
      expect(rendered.inApp?.body).toContain("the rest of the schedule is unchanged");
      expect(rendered.inApp?.action?.label).toBe("See other dates");
    });

    // The cancel/archive take-down writes these notices in the SAME
    // transaction that flips the listing, so by dispatch the event is never
    // PUBLISHED. They used to be dispatched away unsent here, every one.
    // Completing a listing with nights still ahead calls them off the same
    // way (owner ruling 2026-10-16, Q5), so COMPLETED sends the same copy.
    //
    // THE LINK MATCHES THE PAGE. The event page's banner says "Event
    // cancelled" only for CANCELLED ("No longer available" for ARCHIVED,
    // "Event ended" for COMPLETED), so only a CANCELLED listing keeps the
    // link, and it is a plain "View event", never "other dates".
    it.each([
      ["CANCELLED", `https://ithasfire.com/events/${EVENT_SLUG}`],
      ["ARCHIVED", null],
      ["COMPLETED", null],
    ] as const)(
      "SENDS on a %s listing, with the whole-listing copy (eventUrl %s)",
      async (status, expectedUrl) => {
        const { deps, mocks } = createDeps({
          notices: [buildCancellation()],
          event: makeCommunityEvent({ status }),
          eventDate: makeEventDate({ status: "CANCELLED" }),
        });

        const result = await dispatchRsvpNotifications(deps, {});

        expect(result).toMatchObject({
          processed: 1,
          dispatched: 1,
          skipped: 0,
          recipientsNotified: 1,
        });
        expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
          ["notice-called-off"],
          NOW,
        );
        const { variant, payload } = (mocks.notify.mock.calls[0] as any[])[0];
        expect(variant).toBe("rsvp.date_cancelled");
        expect(payload).toMatchObject({
          listingCancelled: true,
          eventUrl: expectedUrl,
        });

        const rendered = renderNotification(variant, payload, { now: NOW });
        expect(rendered.inApp?.title).toBe("Cancelled: Weekly Open Mic");
        expect(rendered.inApp?.body).toBe(
          "None of its remaining nights will happen. Your RSVP is cancelled.",
        );
        if (expectedUrl) {
          expect(rendered.inApp?.action).toEqual({
            label: "View event",
            route: `/events/${EVENT_SLUG}`,
          });
          expect(rendered.email?.text).toContain(`View the event: ${expectedUrl}`);
        } else {
          expect(rendered.inApp?.action).toBeNull();
        }
        expect(rendered.email?.subject).toBe("Cancelled: Weekly Open Mic");
        expect(rendered.email?.text).not.toContain("other dates");

        const es = renderNotification(variant, payload, { now: NOW, locale: "es" });
        expect(es.inApp?.title).toBe("Evento cancelado: Weekly Open Mic");
      },
    );

    it("whole-listing notice still SENDS when the person withdrew only its anchor night", async () => {
      // One notice per person, hung on their earliest night. Dropping that
      // night's RSVP must not silence the message about every other night.
      const { deps, mocks } = createDeps({
        notices: [buildCancellation()],
        event: makeCommunityEvent({ status: "CANCELLED" }),
        eventDate: makeEventDate({ status: "CANCELLED" }),
        dateRsvpExists: false,
        eventDateRsvpExists: true,
      });

      const result = await dispatchRsvpNotifications(deps, {});

      expect(result).toMatchObject({ processed: 1, dispatched: 1, skipped: 0 });
      // Bounded at the anchor night's start: a night called off EARLIER
      // (not by this take-down) that the person still holds must not count.
      expect(mocks.eventDateRsvps.existsForUserOnEvent).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        humanId: USER_ID,
        dateStatus: "CANCELLED",
        startsAtFrom: makeEventDate().startsAt,
      });
      expect(mocks.eventDateRsvps.existsForUser).not.toHaveBeenCalled();
    });

    it("whole-listing notice is dropped when the person holds no called-off night any more", async () => {
      const { deps, mocks } = createDeps({
        notices: [buildCancellation()],
        event: makeCommunityEvent({ status: "ARCHIVED" }),
        eventDate: makeEventDate({ status: "CANCELLED" }),
        eventDateRsvpExists: false,
      });

      const result = await dispatchRsvpNotifications(deps, {});

      expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
      expect(mocks.notify).not.toHaveBeenCalled();
    });

    it("a one-night call-off still checks that night's own RSVP", async () => {
      const { deps, mocks } = createDeps({
        notices: [buildCancellation()],
        eventDate: makeEventDate({ status: "CANCELLED" }),
        dateRsvpExists: false,
        eventDateRsvpExists: true,
      });

      const result = await dispatchRsvpNotifications(deps, {});

      expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
      expect(mocks.eventDateRsvps.existsForUserOnEvent).not.toHaveBeenCalled();
    });

    it("still drops a cancellation on a listing that is neither PUBLISHED nor taken down", async () => {
      const { deps, mocks } = createDeps({
        notices: [buildCancellation()],
        event: makeCommunityEvent({ status: "DRAFT" }),
        eventDate: makeEventDate({ status: "CANCELLED" }),
      });

      const result = await dispatchRsvpNotifications(deps, {});

      expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
      expect(mocks.notify).not.toHaveBeenCalled();
    });

    it("never CONFIRMS on a CANCELLED listing, even a per-date notice", async () => {
      const { deps, mocks } = createDeps({
        notices: [buildNotice({ id: "notice-confirm", eventDateId: DATE_ID })],
        event: makeCommunityEvent({ status: "CANCELLED" }),
      });

      const result = await dispatchRsvpNotifications(deps, {});

      expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
      expect(mocks.notify).not.toHaveBeenCalled();
    });

    it("does NOT send when the date was restored between enqueue and dispatch", async () => {
      // The restore deletes undelivered notices in its own transaction, so
      // reaching this means something raced. Belt and braces.
      const { deps, mocks } = createDeps({
        notices: [buildCancellation()],
        eventDate: makeEventDate({ status: "SCHEDULED" }),
      });

      const result = await dispatchRsvpNotifications(deps, {});

      expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
      expect(mocks.notify).not.toHaveBeenCalled();
      expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
        ["notice-called-off"],
        NOW,
      );
    });

    it("does NOT send to someone who had already withdrawn their RSVP", async () => {
      const { deps, mocks } = createDeps({
        notices: [buildCancellation()],
        eventDate: makeEventDate({ status: "CANCELLED" }),
        dateRsvpExists: false,
      });

      const result = await dispatchRsvpNotifications(deps, {});

      expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
      expect(mocks.notify).not.toHaveBeenCalled();
    });

    it("still refuses to CONFIRM a night that is off — that person gets the cancellation instead", async () => {
      // Both notices exist for the same person: the confirmation they were
      // owed, and the cancellation the call-off enqueued. Exactly one sends.
      const { deps, mocks } = createDeps({
        notices: [
          buildNotice({ id: "notice-confirm", eventDateId: DATE_ID }),
          buildCancellation(),
        ],
        eventDate: makeEventDate({ status: "CANCELLED" }),
      });

      const result = await dispatchRsvpNotifications(deps, {});

      expect(result).toMatchObject({
        processed: 2,
        dispatched: 1,
        skipped: 1,
        recipientsNotified: 1,
      });
      expect(mocks.notify).toHaveBeenCalledTimes(1);
      expect((mocks.notify.mock.calls[0] as any[])[0].variant).toBe(
        "rsvp.date_cancelled",
      );
      // Both rows leave the outbox either way.
      expect(mocks.rsvpNotices.markDispatched).toHaveBeenCalledWith(
        ["notice-confirm"],
        NOW,
      );
    });

    it("uses a cancellation-scoped idempotency key so a retry cannot double-send", async () => {
      const { deps, mocks } = createDeps({
        notices: [buildCancellation()],
        eventDate: makeEventDate({ status: "CANCELLED" }),
      });

      await dispatchRsvpNotifications(deps, {});

      expect((mocks.notify.mock.calls[0] as any[])[0].idempotencyKey).toBe(
        "rsvp-date-cancelled:notice-called-off",
      );
    });

    it("retries and eventually dead-letters a failing cancellation, like any other notice", async () => {
      const notify = vi.fn(async () => {
        throw new Error("mailer down");
      });
      const { deps, mocks } = createDeps({
        notices: [buildCancellation({ attempts: 4 })],
        eventDate: makeEventDate({ status: "CANCELLED" }),
        notify,
      });

      const result = await dispatchRsvpNotifications(deps, { maxAttempts: 5 });

      expect(result).toMatchObject({ deadLettered: 1, dispatched: 0 });
      expect(mocks.rsvpNotices.incrementAttempts).toHaveBeenCalledWith([
        "notice-called-off",
      ]);
      // Dropping a cancellation on the floor is an ERROR-level event: someone
      // is going to show up to a night that is off.
      expect(mocks.logger.error).toHaveBeenCalledWith(
        "community.dispatchRsvpNotifications.dead_letter",
        expect.objectContaining({ noticeId: "notice-called-off" }),
      );
    });

    it("refuses a malformed cancellation with no date id rather than mailing a confirmation", async () => {
      const { deps, mocks } = createDeps({
        notices: [
          buildNotice({
            id: "notice-broken",
            eventDateId: null,
            kind: "DATE_CANCELLED",
          }),
        ],
      });

      const result = await dispatchRsvpNotifications(deps, {});

      expect(result).toMatchObject({ processed: 1, skipped: 1, dispatched: 0 });
      expect(mocks.notify).not.toHaveBeenCalled();
      expect(mocks.logger.error).toHaveBeenCalledWith(
        "community.dispatchRsvpNotifications.cancellation_without_date",
        expect.objectContaining({ noticeId: "notice-broken" }),
      );
    });
  });
});

// ── The address an RSVP confirmation may carry ──────────────────────────────
//
// It used to be `event.addressText` with no mode, reveal or NEVER check. An
// RSVP is attendance, so the attendee gets exactly what a ticket holder gets.

describe("dispatchRsvpNotifications — address gate", () => {
  const PLACE_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
  const VENUE_ORG = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";
  const HOUR = 60 * 60 * 1000;

  /** A venue that withholds its address; the truth is only here. */
  const withheldPlace = {
    id: PLACE_ID,
    // Owned by VENUE_ORG; accepts community listings venue-wide.
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
    name: "The Blue Door House",
    formattedAddress: "901 Porter Rd",
    city: "Austin",
    region: "TX",
    postalCode: "78702",
    lat: 30.26,
    lng: -97.72,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Austin",
  };

  async function payloadFor(
    eventOverrides: Parameters<typeof makeCommunityEvent>[0],
    place: Record<string, unknown> | null = null,
  ) {
    const { deps, mocks } = createDeps({
      notices: [buildNotice()],
      event: makeCommunityEvent(eventOverrides),
      place,
    });
    await dispatchRsvpNotifications(deps, {});
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    return (mocks.notify.mock.calls[0] as unknown as [{ payload: Record<string, unknown> }])[0]
      .payload;
  }

  it("EXACT: unchanged — the organizer's label and the stored street", async () => {
    const payload = await payloadFor({ locationLabel: "The Corner Stage" });
    expect(payload.venueName).toBe("The Corner Stage");
    expect(payload.addressText).toBe("123 Main St, Austin, TX");
  });

  it("NEVER: no street, ever", async () => {
    const payload = await payloadFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "NEVER",
      addressRevealAt: null,
      locationLabel: null,
    });
    expect(payload.addressText).toBeNull();
    // Falls back to the coarse area so "Where" still says roughly where.
    expect(payload.venueName).toBe("Austin, TX");
    expect(JSON.stringify(payload)).not.toContain("123 Main St");
  });

  it("before the reveal: no street; the organizer's public label stays", async () => {
    const payload = await payloadFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: new Date(NOW.getTime() + 24 * HOUR),
      locationLabel: "East Austin",
    });
    expect(payload.addressText).toBeNull();
    expect(payload.venueName).toBe("East Austin");
    expect(JSON.stringify(payload)).not.toContain("123 Main St");
  });

  const revealedAtHouse = {
    placeId: PLACE_ID,
    locationMode: "OBSCURED" as const,
    locationRadiusMeters: 800,
    addressRevealPreset: "DAY_BEFORE" as const,
    addressRevealAt: new Date(NOW.getTime() - HOUR),
    // Part 1's storage: the Event row holds the venue's public projection.
    addressText: "East Austin",
    postalCode: null,
  };

  it("after the reveal at a withheld venue: the Place's street, not the Event projection", async () => {
    const payload = await payloadFor(
      // The venue's own RSVP night.
      { ...revealedAtHouse, orgId: VENUE_ORG, stewardship: "OWNED" },
      withheldPlace,
    );
    expect(payload.addressText).toBe("901 Porter Rd");
    expect(payload.addressText).not.toBe("East Austin");
  });

  it("C1: a community listing at a house that accepts listings: no street, ever", async () => {
    const payload = await payloadFor(revealedAtHouse, withheldPlace);
    expect(payload.addressText).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("Porter");
  });

  it("before the reveal at a withheld venue: neither the street nor the venue name", async () => {
    const payload = await payloadFor(
      {
        placeId: PLACE_ID,
        locationMode: "OBSCURED",
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date(NOW.getTime() + HOUR),
        addressText: "East Austin",
        locationLabel: null,
      },
      withheldPlace,
    );
    expect(payload.addressText).toBeNull();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("Porter");
    expect(serialized).not.toContain("Blue Door");
  });
});
