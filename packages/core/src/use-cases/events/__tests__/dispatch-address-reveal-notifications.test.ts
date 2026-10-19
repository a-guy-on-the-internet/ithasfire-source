import { describe, expect, it, vi } from "vitest";

import { renderNotification } from "../../comms/renderers";

import type { ClockPort } from "@th/ports/clock";
import type { EventRecord } from "@th/ports/repos/events";

import {
  ADDRESS_REVEAL_VARIANT,
  DEFAULT_WINDOW_LOOKBACK_MS,
  MAX_ADDRESS_LENGTH,
  dispatchAddressRevealNotifications,
  type DispatchAddressRevealNotificationsDeps,
} from "../dispatch-address-reveal-notifications";

const NOW = new Date("2026-07-07T12:00:00.000Z");
const APP_BASE_URL = "https://ithasfire.com";

const EVENT_1 = "11111111-1111-4111-8111-111111111111";
const EVENT_2 = "22222222-2222-4222-8222-222222222222";
const EVENT_3 = "33333333-3333-4333-8333-333333333333";

const HOLDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOLDER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOLDER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const EMPTY_RESULT = {
  processed: 0,
  notifiedEvents: 0,
  lockedEvents: 0,
  failedEvents: 0,
  recipientsNotified: 0,
  recipientsSkipped: 0,
  recipientsAlreadyNotified: 0,
};

/**
 * Minimal EventRecord double — only the fields the dispatcher reads. Cast at
 * the deps boundary; adding real EventRecord fields here would just be noise.
 */
function buildEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_1,
    title: "Secret Loft Session",
    status: "PUBLISHED",
    locationMode: "OBSCURED",
    addressRevealAt: new Date("2026-07-07T11:50:00.000Z"),
    addressText: "1114 Fatherland St, Nashville, TN 37206",
    locationLabel: "East Nashville",
    lat: 36.1773,
    lng: -86.7554,
    timezone: "America/Chicago",
    startsAt: new Date("2026-08-14T20:00:00.000Z"),
    slug: "secret-loft-session",
    ...overrides,
  } as EventRecord;
}

/**
 * Stateful in-memory harness mirroring the real adapters:
 * - `markAddressRevealNotified` is a CONDITIONAL stamp (wins only while the
 *   cursor is unset — returns whether it won);
 * - the scan excludes stamped events for SCHEDULED runs, but an explicit
 *   `eventId` bypasses the cursor gate (ops re-drive path);
 * - every SUCCESSFUL notify() records into a durable ledger (the persisted
 *   in-app Notification row), which `findNotifiedHumanIdsForEvent` reads —
 *   so tests exercise true subtraction semantics across runs.
 */
function createDeps(args: {
  events: EventRecord[];
  holdersByEvent?: Record<string, string[]>;
  notify?: DispatchAddressRevealNotificationsDeps["notify"];
  /** Venue rows served by `places.getById`, keyed by place id. */
  placesById?: Record<string, unknown>;
  /**
   * What `events.getById(id)` returns, keyed by event id, when it should
   * differ from the scan row. Unset ⇒ the scan row itself; `null` ⇒ vanished.
   */
  currentById?: Record<string, EventRecord | null>;
  /**
   * Holders whose email is NOT verified (B2). Everyone else is verified, so
   * the existing cases keep their in-app channel.
   */
  unverifiedHumanIds?: string[];
}) {
  const notifiedAt = new Map<string, Date>();
  /** Durable per-recipient ledger: `${eventId}:${humanId}` of successful notifies. */
  const ledger = new Set<string>();

  const eventsRepo = {
    findObscuredEventsCrossingReveal: vi.fn(
      async (input: { windowStart: Date; windowEnd: Date; eventId?: string }) =>
        args.events.filter((event) => {
          if (input.eventId) {
            // Explicit re-drive: cursor gate bypassed, id must match.
            if (event.id !== input.eventId) return false;
          } else if (notifiedAt.has(event.id)) {
            // Scheduled scan: stamped events are never re-picked.
            return false;
          }
          const revealAt = event.addressRevealAt;
          if (!revealAt) return false;
          return (
            revealAt.getTime() > input.windowStart.getTime() &&
            revealAt.getTime() <= input.windowEnd.getTime()
          );
        }),
    ),
    // The start-keyed half (venue-confirmed events whose real reveal is
    // `startsAt − 24h`): PUBLISHED OBSCURED events AT A VENUE starting in
    // the window, same cursor gate.
    findObscuredPlaceEventsStartingIn: vi.fn(
      async (input: { startsAfter: Date; startsAtOrBefore: Date; eventId?: string }) =>
        args.events.filter((event) => {
          if (!event.placeId) return false;
          if (input.eventId) {
            if (event.id !== input.eventId) return false;
          } else if (notifiedAt.has(event.id)) {
            return false;
          }
          return (
            event.startsAt.getTime() > input.startsAfter.getTime() &&
            event.startsAt.getTime() <= input.startsAtOrBefore.getTime()
          );
        }),
    ),
    getById: vi.fn(
      async (id: string) =>
        args.currentById && id in args.currentById
          ? args.currentById[id]
          : (args.events.find((event) => event.id === id) ?? null),
    ),
    markAddressRevealNotified: vi.fn(async (eventId: string, at: Date) => {
      if (notifiedAt.has(eventId)) return false;
      notifiedAt.set(eventId, at);
      return true;
    }),
  };

  const ticketsRepo = {
    activeTicketHolderHumanIds: vi.fn(
      async (eventId: string) => args.holdersByEvent?.[eventId] ?? [],
    ),
  };

  const notificationsRepo = {
    findNotifiedHumanIdsForEvent: vi.fn(
      async (input: { eventId: string; variant: string; humanIds: string[] }) =>
        input.humanIds.filter((humanId) =>
          ledger.has(`${input.eventId}:${humanId}`),
        ),
    ),
  };

  const inner = args.notify ?? (async () => ({ ok: true }));
  // Wrap the caller's notify so a SUCCESS persists into the durable ledger —
  // exactly what the real notify() does by persisting the in-app row.
  // Only an IN-APP send writes the row the ledger reads: an email-only send
  // (`inApp: { enabled: false }`, B2) leaves nothing behind, as in prod.
  const notify = vi.fn(
    async (input: {
      humanId: string;
      payload?: unknown;
      channels?: { inApp?: { enabled?: boolean } };
    }) => {
      const result = await inner(
        input as Parameters<DispatchAddressRevealNotificationsDeps["notify"]>[0],
      );
      const eventId = (input.payload as { eventId?: string } | undefined)
        ?.eventId;
      if (eventId && input.channels?.inApp?.enabled !== false) {
        ledger.add(`${eventId}:${input.humanId}`);
      }
      return result;
    },
  );

  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const clock: ClockPort = { now: vi.fn(() => NOW) };

  const placesRepo = {
    getById: vi.fn(async (id: string) => args.placesById?.[id] ?? null),
  };

  const unverified = new Set(args.unverifiedHumanIds ?? []);
  const humansRepo = {
    listEmailVerifiedIds: vi.fn(async (humanIds: readonly string[]) =>
      humanIds.filter((humanId) => !unverified.has(humanId)),
    ),
  };

  const deps: DispatchAddressRevealNotificationsDeps = {
    repos: {
      events: eventsRepo,
      tickets: ticketsRepo,
      notifications: notificationsRepo,
      places: placesRepo,
      humans: humansRepo,
    } as unknown as DispatchAddressRevealNotificationsDeps["repos"],
    notify: notify as unknown as DispatchAddressRevealNotificationsDeps["notify"],
    clock,
    appBaseUrl: APP_BASE_URL,
    logger:
      logger as unknown as DispatchAddressRevealNotificationsDeps["logger"],
  };

  return {
    deps,
    mocks: {
      eventsRepo,
      ticketsRepo,
      notificationsRepo,
      placesRepo,
      humansRepo,
      notify,
      logger,
    },
    notifiedAt,
    ledger,
  };
}

describe("dispatchAddressRevealNotifications", () => {
  // B2: guest checkout attaches tickets BY EMAIL, so an unverified account
  // can hold someone else's ticket. The reveal still reaches the inbox, but
  // not that account's in-app feed, push devices or phone.
  it("sends an unverified holder the reveal by email only", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A, HOLDER_B] },
      unverifiedHumanIds: [HOLDER_B],
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result.recipientsNotified).toBe(2);
    expect(mocks.humansRepo.listEmailVerifiedIds).toHaveBeenCalledWith([
      HOLDER_A,
      HOLDER_B,
    ]);
    const calls = mocks.notify.mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.humanId === HOLDER_A)).toMatchObject({
      channels: { inApp: { enabled: true } },
    });
    const callB = calls.find((c) => c.humanId === HOLDER_B) as {
      channels?: Record<string, unknown>;
    };
    expect(callB.channels).toEqual({
      inApp: { enabled: false },
      push: { enabled: false },
      sms: { enabled: false },
    });
    // Email carries no override: it goes to the address on the ticket.
    expect(callB.channels).not.toHaveProperty("email");
  });

  it("an explicit re-drive does not mail an email-only holder the reveal again", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A, HOLDER_B] },
      unverifiedHumanIds: [HOLDER_B],
    });

    // First (scheduled) pass: A in-app, B by email only.
    await dispatchAddressRevealNotifications(deps, {});
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    mocks.notify.mockClear();

    // Operator re-drives the event later (past notify's 60 s replay window).
    const redrive = await dispatchAddressRevealNotifications(deps, {
      eventId: EVENT_1,
    });

    // A is subtracted by the in-app ledger; B, who left no ledger row, is
    // skipped rather than emailed twice.
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(redrive.recipientsAlreadyNotified).toBe(1);
    expect(redrive.recipientsSkipped).toBe(1);
  });

  it("an explicit re-drive still notifies a verified holder in the gap", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A, HOLDER_B] },
      unverifiedHumanIds: [HOLDER_B],
    });

    await dispatchAddressRevealNotifications(deps, { eventId: EVENT_1 });

    const calls = mocks.notify.mock.calls.map((c) => c[0].humanId);
    expect(calls).toEqual([HOLDER_A]);
  });

  it("does not look up verification when every holder was already notified", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [] },
    });

    await dispatchAddressRevealNotifications(deps, {});

    expect(mocks.humansRepo.listEmailVerifiedIds).not.toHaveBeenCalled();
  });

  it("sends nothing and leaves the cursor unset when the verification lookup fails", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });
    mocks.humansRepo.listEmailVerifiedIds.mockRejectedValueOnce(
      new Error("db down"),
    );

    await dispatchAddressRevealNotifications(deps, {});

    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.eventsRepo.markAddressRevealNotified).not.toHaveBeenCalled();
  });

  it("no-ops when the scan window is empty", async () => {
    const { deps, mocks } = createDeps({ events: [] });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual(EMPTY_RESULT);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.eventsRepo.markAddressRevealNotified).not.toHaveBeenCalled();
    // Default window: (now - lookback, now].
    expect(mocks.eventsRepo.findObscuredEventsCrossingReveal).toHaveBeenCalledWith(
      {
        windowStart: new Date(NOW.getTime() - DEFAULT_WINDOW_LOOKBACK_MS),
        windowEnd: NOW,
      },
    );
  });

  it("notifies each active holder once with the reveal variant, payload, key, and forced in-app channel", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A, HOLDER_B] },
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      notifiedEvents: 1,
      recipientsNotified: 2,
    });
    expect(mocks.notify).toHaveBeenCalledTimes(2);

    const calls = mocks.notify.mock.calls.map((c) => c[0]);
    const callA = calls.find((c) => c.humanId === HOLDER_A);
    expect(callA).toEqual({
      humanId: HOLDER_A,
      variant: ADDRESS_REVEAL_VARIANT,
      idempotencyKey: `event-location-revealed:${EVENT_1}:${HOLDER_A}`,
      // In-app is forced ON (non-suppressible); email/SMS carry NO override,
      // so they stay preference-driven inside notify(). Push is deferred
      // (no PushPort wired platform-wide).
      channels: { inApp: { enabled: true } },
      payload: {
        eventId: EVENT_1,
        eventTitle: "Secret Loft Session",
        address: "1114 Fatherland St, Nashville, TN 37206",
        venueName: "East Nashville",
        startsAtIso: "2026-08-14T20:00:00.000Z",
        timezone: "America/Chicago",
        mapUrl:
          "https://www.google.com/maps/search/?api=1&query=36.1773,-86.7554",
        directionsUrl:
          "https://www.google.com/maps/dir/?api=1&destination=36.1773,-86.7554",
        // Slug preferred over the raw id (matches get-performer-share-links).
        eventUrl: `${APP_BASE_URL}/events/secret-loft-session`,
        // No short ID on this event ⇒ no short link; the SMS keeps eventUrl.
        eventShortUrl: null,
      },
    });

    // Cursor stamped AFTER the fan-out.
    expect(mocks.eventsRepo.markAddressRevealNotified).toHaveBeenCalledWith(
      EVENT_1,
      NOW,
    );
  });

  it("still reveals the address when the event has no slug — just no link", async () => {
    // This used to fall back to `/events/{id}`, which 404s on the public route
    // (slug / slug-history only) — a dead link in the email, the SMS AND the
    // in-app action. It must DEGRADE, not suppress: the payload IS the address,
    // and suppressing loses the reveal permanently once the event ages out of
    // the lookback window.
    const { deps, mocks } = createDeps({
      events: [buildEvent({ slug: null })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    await dispatchAddressRevealNotifications(deps, {});

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const call = mocks.notify.mock.calls[0]?.[0];
    expect(call.payload.eventUrl).toBeNull();

    // End to end through the STRICT renderer: no throw, no action, and the
    // address still reaches every channel.
    const rendered = renderNotification(call.variant, call.payload, {
      now: NOW,
    });
    expect(rendered.inApp?.action).toBeNull();
    expect(rendered.inApp?.body).toContain("1114 Fatherland St");
    expect(rendered.email?.text).not.toContain("View the event");
    expect(rendered.sms?.body).toContain("1114 Fatherland St");
    expect(rendered.sms?.body.trim().endsWith(".")).toBe(true);
  });

  it("builds a SLUG-based eventUrl whose in-app route is not an id", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    await dispatchAddressRevealNotifications(deps, {});

    const call = mocks.notify.mock.calls[0]?.[0];
    expect(call?.payload).toMatchObject({
      eventUrl: `${APP_BASE_URL}/events/secret-loft-session`,
    });
    const rendered = renderNotification(call.variant, call.payload, {
      now: NOW,
    });
    expect(rendered.inApp?.action?.route).toBe("/events/secret-loft-session");
    expect(rendered.inApp?.action?.route).not.toContain(EVENT_1);
  });

  it("omits map/directions URLs when the event has no coordinates", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent({ lat: null, lng: null })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    await dispatchAddressRevealNotifications(deps, {});

    const call = mocks.notify.mock.calls[0]?.[0];
    expect(call?.payload).toMatchObject({
      mapUrl: null,
      directionsUrl: null,
    });
  });

  it("an empty-string locationLabel still fans out (venueName coerced to null, not '')", async () => {
    // Regression: `?? null` let a stored "" through to the renderer's
    // z.string().min(1), poisoning the whole event's fan-out every run.
    const { deps, mocks } = createDeps({
      events: [buildEvent({ locationLabel: "" })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result.recipientsNotified).toBe(1);
    expect(result.notifiedEvents).toBe(1);
    expect(mocks.notify.mock.calls[0]?.[0]?.payload).toMatchObject({
      venueName: null,
    });
  });

  it("truncates an oversized address to the renderer's 500-char cap", async () => {
    const longAddress = "9".repeat(MAX_ADDRESS_LENGTH + 100);
    const { deps, mocks } = createDeps({
      events: [buildEvent({ addressText: longAddress })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    await dispatchAddressRevealNotifications(deps, {});

    const payload = mocks.notify.mock.calls[0]?.[0]?.payload as {
      address: string;
    };
    expect(payload.address).toHaveLength(MAX_ADDRESS_LENGTH);
    expect(payload.address).toBe(longAddress.slice(0, MAX_ADDRESS_LENGTH));
  });

  it("overlapping-window double-run sends zero duplicates (cursor semantics = late buyers never re-fan-out)", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    const first = await dispatchAddressRevealNotifications(deps, {});
    expect(first.notifiedEvents).toBe(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);

    // Second run over the SAME window: the stamped cursor keeps the event out
    // of the scheduled scan entirely. This is also the FR-007 late-buyer
    // guarantee: a buyer who purchases after the stamp is never picked up by
    // the scheduled job — their TicketIssued email already carries the
    // unlocked address.
    const second = await dispatchAddressRevealNotifications(deps, {});
    expect(second).toEqual(EMPTY_RESULT);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.eventsRepo.markAddressRevealNotified).toHaveBeenCalledTimes(1);
  });

  it("overlapping ticks that both scanned the event send once (ledger subtraction + conditional stamp)", async () => {
    // Simulate two ticks whose scans BOTH picked the event up before either
    // stamped: force the scan to return the event regardless of the cursor.
    const event = buildEvent();
    const { deps, mocks } = createDeps({
      events: [event],
      holdersByEvent: { [EVENT_1]: [HOLDER_A, HOLDER_B] },
    });
    mocks.eventsRepo.findObscuredEventsCrossingReveal.mockImplementation(
      async () => [event],
    );

    const first = await dispatchAddressRevealNotifications(deps, {});
    expect(first.recipientsNotified).toBe(2);
    expect(first.notifiedEvents).toBe(1);

    // "Concurrent" second tick: subtraction removes both holders, and the
    // conditional stamp is lost — the event is skipped, ZERO duplicate sends.
    const second = await dispatchAddressRevealNotifications(deps, {});
    expect(second).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      recipientsAlreadyNotified: 2,
    });
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.cursor_already_stamped",
      { eventId: EVENT_1 },
    );
  });

  it("losing the conditional stamp race means another run owns the event (not counted as notified)", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });
    // A concurrent run stamped between our scan and our stamp attempt.
    mocks.eventsRepo.markAddressRevealNotified.mockResolvedValueOnce(false);

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      recipientsNotified: 1,
    });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.cursor_already_stamped",
      { eventId: EVENT_1 },
    );
  });

  it("partial failure stamps the cursor anyway (at-most-once) and ERROR-logs failedHumanIds — no storm", async () => {
    const events = [
      buildEvent({ id: EVENT_1 }),
      buildEvent({ id: EVENT_2, title: "Failing Show" }),
      buildEvent({ id: EVENT_3, title: "Third Show" }),
    ];
    const notify = vi.fn(async (input: { humanId: string }) => {
      if (input.humanId === HOLDER_B) {
        throw new Error("smtp down");
      }
      return { ok: true };
    });
    const { deps, mocks, notifiedAt } = createDeps({
      events,
      holdersByEvent: {
        [EVENT_1]: [HOLDER_A],
        [EVENT_2]: [HOLDER_B],
        [EVENT_3]: [HOLDER_C],
      },
      notify: notify as DispatchAddressRevealNotificationsDeps["notify"],
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({
      ...EMPTY_RESULT,
      processed: 3,
      notifiedEvents: 2,
      failedEvents: 1,
      recipientsNotified: 2,
    });
    // ALL cursors stamped — including the partially-failed event (at-most-once
    // backstop): the scheduled scan can never re-fan-out to healthy holders.
    expect(notifiedAt.has(EVENT_1)).toBe(true);
    expect(notifiedAt.has(EVENT_2)).toBe(true);
    expect(notifiedAt.has(EVENT_3)).toBe(true);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.event_partial_failure",
      expect.objectContaining({ eventId: EVENT_2, failedHumanIds: [HOLDER_B] }),
    );

    // Next scheduled tick: NOTHING is re-picked (all stamped) — the failed
    // recipient is NOT retried automatically (reveal stays pull-visible).
    const nextTick = await dispatchAddressRevealNotifications(deps, {});
    expect(nextTick).toEqual(EMPTY_RESULT);
  });

  it("storm scenario: repeated ticks after a persistent one-recipient failure send zero duplicates to healthy recipients", async () => {
    const notify = vi.fn(async (input: { humanId: string }) => {
      if (input.humanId === HOLDER_B) {
        throw new Error("mailbox on fire, permanently");
      }
      return { ok: true };
    });
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A, HOLDER_B, HOLDER_C] },
      notify: notify as DispatchAddressRevealNotificationsDeps["notify"],
    });

    const first = await dispatchAddressRevealNotifications(deps, {});
    expect(first.recipientsNotified).toBe(2);
    expect(first.failedEvents).toBe(1);

    // Four more 30-minute ticks with the failure still unresolved.
    for (let tick = 0; tick < 4; tick += 1) {
      const run = await dispatchAddressRevealNotifications(deps, {});
      expect(run).toEqual(EMPTY_RESULT);
    }

    // Healthy holders A and C were notified EXACTLY once across all ticks.
    const callsByHuman = mocks.notify.mock.calls.map((c) => c[0].humanId);
    expect(callsByHuman.filter((h) => h === HOLDER_A)).toHaveLength(1);
    expect(callsByHuman.filter((h) => h === HOLDER_C)).toHaveLength(1);
    // The failing holder was attempted once (first tick) — no blind retries.
    expect(callsByHuman.filter((h) => h === HOLDER_B)).toHaveLength(1);
  });

  it("explicit eventId re-drive after a partial failure re-notifies ONLY the gap (ledger subtraction)", async () => {
    const notify = vi.fn(async (input: { humanId: string }) => {
      if (input.humanId === HOLDER_B) {
        throw new Error("smtp down");
      }
      return { ok: true };
    });
    const { deps, mocks, notifiedAt } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A, HOLDER_B, HOLDER_C] },
      notify: notify as DispatchAddressRevealNotificationsDeps["notify"],
    });

    const first = await dispatchAddressRevealNotifications(deps, {});
    expect(first.recipientsNotified).toBe(2);
    expect(first.failedEvents).toBe(1);
    expect(notifiedAt.has(EVENT_1)).toBe(true);

    // Ops fixed the cause; explicit re-drive bypasses the cursor gate.
    notify.mockImplementation(async () => ({ ok: true }));
    const redrive = await dispatchAddressRevealNotifications(deps, {
      eventId: EVENT_1,
    });

    expect(redrive).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      recipientsNotified: 1,
      // A and C are durably subtracted — never re-notified.
      recipientsAlreadyNotified: 2,
    });
    const redriveCalls = mocks.notify.mock.calls
      .slice(3)
      .map((c) => c[0].humanId);
    expect(redriveCalls).toEqual([HOLDER_B]);

    // A second re-drive is a full no-op send-wise: everyone is in the ledger.
    const secondRedrive = await dispatchAddressRevealNotifications(deps, {
      eventId: EVENT_1,
    });
    expect(secondRedrive).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      recipientsAlreadyNotified: 3,
    });
    expect(mocks.notify).toHaveBeenCalledTimes(4);
  });

  it("a repo throw on one event is contained (outer guard) and other events still process", async () => {
    const events = [buildEvent({ id: EVENT_1 }), buildEvent({ id: EVENT_2 })];
    const { deps, mocks, notifiedAt } = createDeps({
      events,
      holdersByEvent: { [EVENT_1]: [HOLDER_A], [EVENT_2]: [HOLDER_B] },
    });
    mocks.ticketsRepo.activeTicketHolderHumanIds.mockImplementationOnce(
      async () => {
        throw new Error("db exploded");
      },
    );

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({
      ...EMPTY_RESULT,
      processed: 2,
      notifiedEvents: 1,
      failedEvents: 1,
      recipientsNotified: 1,
    });
    // Pre-fan-out throw: nothing sent, cursor untouched → safe to retry.
    expect(notifiedAt.has(EVENT_1)).toBe(false);
    expect(notifiedAt.has(EVENT_2)).toBe(true);
  });

  it("a ledger query failure is contained pre-fan-out (nothing sent, cursor untouched, retries)", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });
    mocks.notificationsRepo.findNotifiedHumanIdsForEvent.mockRejectedValueOnce(
      new Error("ledger query exploded"),
    );

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      failedEvents: 1,
    });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(notifiedAt.has(EVENT_1)).toBe(false);
  });

  it("explicit eventId mode narrows the scan and still stamps the cursor", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [buildEvent({ id: EVENT_1 }), buildEvent({ id: EVENT_2 })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A], [EVENT_2]: [HOLDER_B] },
    });

    const result = await dispatchAddressRevealNotifications(deps, {
      eventId: EVENT_2,
    });

    expect(result.processed).toBe(1);
    expect(result.notifiedEvents).toBe(1);
    expect(mocks.eventsRepo.findObscuredEventsCrossingReveal).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_2 }),
    );
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0]?.[0]).toMatchObject({
      humanId: HOLDER_B,
    });
    expect(notifiedAt.has(EVENT_1)).toBe(false);
    expect(notifiedAt.has(EVENT_2)).toBe(true);

    // A repeated explicit run re-picks the event (cursor gate bypassed for
    // re-drives) but the durable ledger makes it a send-wise no-op.
    const rerun = await dispatchAddressRevealNotifications(deps, {
      eventId: EVENT_2,
    });
    expect(rerun).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      recipientsAlreadyNotified: 1,
    });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("honors an explicit backfill window", async () => {
    const { deps, mocks } = createDeps({ events: [] });

    await dispatchAddressRevealNotifications(deps, {
      windowStartIso: "2026-07-01T00:00:00.000Z",
      windowEndIso: "2026-07-02T00:00:00.000Z",
    });

    expect(mocks.eventsRepo.findObscuredEventsCrossingReveal).toHaveBeenCalledWith(
      {
        windowStart: new Date("2026-07-01T00:00:00.000Z"),
        windowEnd: new Date("2026-07-02T00:00:00.000Z"),
      },
    );
  });

  it("clamps a future windowEnd to now — a pre-reveal event can never fan out early", async () => {
    const futureReveal = buildEvent({
      // Reveal is still an hour away.
      addressRevealAt: new Date(NOW.getTime() + 60 * 60 * 1000),
    });
    const { deps, mocks, notifiedAt } = createDeps({
      events: [futureReveal],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    const result = await dispatchAddressRevealNotifications(deps, {
      // Fat-fingered "backfill" two hours into the future.
      windowEndIso: new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    });

    // The scan itself receives the CLAMPED end (defense in the use case, not
    // just the repo), so the un-crossed reveal is unreachable.
    expect(mocks.eventsRepo.findObscuredEventsCrossingReveal).toHaveBeenCalledWith(
      expect.objectContaining({ windowEnd: NOW }),
    );
    expect(result).toEqual(EMPTY_RESULT);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(notifiedAt.has(EVENT_1)).toBe(false);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.window_end_clamped",
      expect.objectContaining({ clampedWindowEndIso: NOW.toISOString() }),
    );
  });

  it("rejects an inverted explicit window", async () => {
    const { deps } = createDeps({ events: [] });

    await expect(
      dispatchAddressRevealNotifications(deps, {
        windowStartIso: "2026-07-02T00:00:00.000Z",
        windowEndIso: "2026-07-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("an event with no stored address fails (cursor NOT stamped) instead of notifying nothing silently", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [buildEvent({ addressText: null })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      failedEvents: 1,
    });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(notifiedAt.has(EVENT_1)).toBe(false);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.missing_address",
      { eventId: EVENT_1 },
    );
  });

  it("a permanently-unnotifiable recipient (HUMAN_NOT_FOUND) is skipped without starving the cursor", async () => {
    // Real-world case observed in dev: a ticket whose owner Human row no
    // longer resolves. Retrying can never fix it — the event must still
    // stamp so the OTHER holders' fan-out completes exactly once.
    const notify = vi.fn(async (input: { humanId: string }) => {
      if (input.humanId === HOLDER_B) {
        throw Object.assign(new Error("HUMAN_NOT_FOUND"), {
          code: "HUMAN_NOT_FOUND",
        });
      }
      return { ok: true };
    });
    const { deps, mocks, notifiedAt } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A, HOLDER_B, HOLDER_C] },
      notify: notify as DispatchAddressRevealNotificationsDeps["notify"],
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      notifiedEvents: 1,
      recipientsNotified: 2,
      recipientsSkipped: 1,
    });
    expect(notifiedAt.has(EVENT_1)).toBe(true);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.recipient_skipped",
      expect.objectContaining({ eventId: EVENT_1, humanId: HOLDER_B }),
    );
  });

  it("an event with zero active holders still stamps the cursor (nothing to send, never re-scan)", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [] },
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      notifiedEvents: 1,
    });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(notifiedAt.has(EVENT_1)).toBe(true);
  });

  it("degrades gracefully when no notifications repo is wired (no subtraction, cursor backstop still holds)", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });
    (deps.repos as { notifications?: unknown }).notifications = undefined;

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      notifiedEvents: 1,
      recipientsNotified: 1,
    });
    expect(notifiedAt.has(EVENT_1)).toBe(true);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.ledger_unavailable",
      { eventId: EVENT_1 },
    );
  });
});

// ── What is revealed, and whether it may be ──────────────────────────────────
//
// The dispatcher used to send `event.addressText` + `event.lat/lng`. At a venue
// that withholds its address those columns are the venue's PUBLIC projection
// (part 1), so the "reveal" would have sent the area label and pointed
// directions at the fuzzed circle. It now goes through the shared
// holder-address decision, which also refuses to reveal a NEVER event.

describe("dispatchAddressRevealNotifications — holder address source", () => {
  const PLACE_ID = "44444444-4444-4444-8444-444444444444";
  const VENUE_ORG = "55555555-5555-4555-8555-555555555555";

  /** Owned by VENUE_ORG, which also owns `projection` below. */
  const withheldPlace = {
    id: PLACE_ID,
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
    name: "The Blue Door House",
    formattedAddress: "901 Porter Rd",
    addressLine1: "901 Porter Rd",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: 36.1862,
    lng: -86.7291,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Nashville",
  };

  /** Part 1's storage for an event at a withheld venue: the public projection. */
  const projection = {
    orgId: VENUE_ORG,
    humanId: null,
    stewardship: "OWNED" as const,
    placeId: PLACE_ID,
    locationRadiusMeters: 800,
    addressRevealPreset: "DAY_BEFORE" as const,
    addressText: "East Nashville",
    lat: 36.18,
    lng: -86.75,
  };

  it("a withheld venue: reveals the Place's TRUE address and coordinates, not the Event projection", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent(projection)],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      placesById: { [PLACE_ID]: withheldPlace },
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toMatchObject({ processed: 1, notifiedEvents: 1 });
    expect(mocks.placesRepo.getById).toHaveBeenCalledWith(PLACE_ID);
    const payload = mocks.notify.mock.calls[0]?.[0].payload;
    expect(payload.address).toBe("901 Porter Rd");
    expect(payload.mapUrl).toBe(
      "https://www.google.com/maps/search/?api=1&query=36.1862,-86.7291",
    );
    expect(payload.directionsUrl).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=36.1862,-86.7291",
    );
    // Nothing from the projection is passed off as the revealed address.
    expect(payload.address).not.toBe(projection.addressText);
    expect(payload.mapUrl).not.toContain("36.18,-86.75");
  });

  it("a venue that publishes its address: the Event row, unchanged", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent({ placeId: PLACE_ID })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      placesById: {
        [PLACE_ID]: { ...withheldPlace, locationMode: "EXACT", locationRadiusMeters: null },
      },
    });

    await dispatchAddressRevealNotifications(deps, {});

    const payload = mocks.notify.mock.calls[0]?.[0].payload;
    expect(payload.address).toBe("1114 Fatherland St, Nashville, TN 37206");
    expect(payload.mapUrl).toBe(
      "https://www.google.com/maps/search/?api=1&query=36.1773,-86.7554",
    );
  });

  it("NEVER is never revealed, even when a stale reveal date crossed the window", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [buildEvent({ addressRevealPreset: "NEVER" })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A, HOLDER_B] },
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({ ...EMPTY_RESULT, processed: 1, failedEvents: 1 });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.ticketsRepo.activeTicketHolderHumanIds).not.toHaveBeenCalled();
    expect(notifiedAt.has(EVENT_1)).toBe(false);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.reveal_locked",
      { eventId: EVENT_1, never: true },
    );
  });

  it("a place lookup that throws is contained pre-fan-out (nothing sent, cursor untouched)", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [buildEvent(projection)],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });
    mocks.placesRepo.getById.mockRejectedValueOnce(new Error("db down"));

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({ ...EMPTY_RESULT, processed: 1, failedEvents: 1 });
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(notifiedAt.has(EVENT_1)).toBe(false);
  });
});

// ── C1: a withheld venue's address goes only where the venue vouched ────────

describe("dispatchAddressRevealNotifications — the venue's word (C1)", () => {
  const PLACE_ID = "44444444-4444-4444-8444-444444444444";
  const VENUE_ORG = "55555555-5555-4555-8555-555555555555";
  const STRANGER_ORG = "66666666-6666-4666-8666-666666666666";
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  const withheldPlace = {
    id: PLACE_ID,
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
    name: "The Blue Door House",
    formattedAddress: "901 Porter Rd",
    addressLine1: "901 Porter Rd",
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: 36.1862,
    lng: -86.7291,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
  };

  /** A stranger's event at the house: its own IMMEDIATELY date crossed just now. */
  const strangerAtHouse = {
    orgId: STRANGER_ORG,
    humanId: null,
    stewardship: "OWNED" as const,
    placeId: PLACE_ID,
    locationRadiusMeters: 800,
    addressRevealPreset: "IMMEDIATELY" as const,
    addressRevealAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    addressText: "East Nashville",
    lat: 36.18,
    lng: -86.75,
    startsAt: new Date(NOW.getTime() + 14 * DAY),
  };
  const stamp = {
    venueConfirmedAt: new Date(NOW.getTime() - 2 * DAY),
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: PLACE_ID,
  };

  function expectNothingSent(
    mocks: ReturnType<typeof createDeps>["mocks"],
    notifiedAt: Map<string, Date>,
  ) {
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.ticketsRepo.activeTicketHolderHumanIds).not.toHaveBeenCalled();
    expect(notifiedAt.has(EVENT_1)).toBe(false);
  }

  it("an UNCONFIRMED stranger's event: never notified, not an error, cursor left unset", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [buildEvent(strangerAtHouse)],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      placesById: { [PLACE_ID]: withheldPlace },
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({ ...EMPTY_RESULT, processed: 1, lockedEvents: 1 });
    expectNothingSent(mocks, notifiedAt);
    expect(mocks.logger.error).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.reveal_withheld",
      { eventId: EVENT_1, reason: "venueUnconfirmed", revealAtIso: null },
    );
  });

  it("a WITHDRAWN confirmation: never notified", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [
        buildEvent({
          ...strangerAtHouse,
          ...stamp,
          venueConfirmationWithdrawnAt: new Date(NOW.getTime() - DAY),
        }),
      ],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      placesById: { [PLACE_ID]: withheldPlace },
    });
    const result = await dispatchAddressRevealNotifications(deps, {});
    expect(result.lockedEvents).toBe(1);
    expectNothingSent(mocks, notifiedAt);
  });

  it("an ownerless community listing the house accepts: never notified", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [
        buildEvent({
          ...strangerAtHouse,
          orgId: null,
          stewardship: "COMMUNITY",
        }),
      ],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      placesById: { [PLACE_ID]: withheldPlace },
    });
    const result = await dispatchAddressRevealNotifications(deps, {});
    expect(result.lockedEvents).toBe(1);
    expectNothingSent(mocks, notifiedAt);
  });

  it("stamp arm, own date crossed but startsAt − 24h still ahead: held back, not failed, with the real date logged", async () => {
    const event = buildEvent({ ...strangerAtHouse, ...stamp });
    const { deps, mocks, notifiedAt } = createDeps({
      events: [event],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      placesById: { [PLACE_ID]: withheldPlace },
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toEqual({ ...EMPTY_RESULT, processed: 1, lockedEvents: 1 });
    expectNothingSent(mocks, notifiedAt);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.reveal_withheld",
      {
        eventId: EVENT_1,
        reason: "notYetRevealed",
        revealAtIso: new Date(event.startsAt.getTime() - DAY).toISOString(),
      },
    );
  });

  it("stamp arm, at startsAt − 24h: the start-keyed scan finds it (own date long gone) and reveals the Place's truth", async () => {
    // Own date crossed ten days ago — far outside the 24h lookback, so the
    // addressRevealAt scan never sees it again. The venue floor crossed
    // five minutes ago.
    const event = buildEvent({
      ...strangerAtHouse,
      ...stamp,
      addressRevealAt: new Date(NOW.getTime() - 10 * DAY),
      startsAt: new Date(NOW.getTime() + DAY - 5 * 60 * 1000),
    });
    const { deps, mocks, notifiedAt } = createDeps({
      events: [event],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      placesById: { [PLACE_ID]: withheldPlace },
    });

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(mocks.eventsRepo.findObscuredEventsCrossingReveal).toHaveBeenCalledTimes(1);
    expect(mocks.eventsRepo.findObscuredPlaceEventsStartingIn).toHaveBeenCalledWith({
      startsAfter: new Date(NOW.getTime() - DEFAULT_WINDOW_LOOKBACK_MS + DAY),
      startsAtOrBefore: new Date(NOW.getTime() + DAY),
    });
    expect(result).toEqual({
      ...EMPTY_RESULT,
      processed: 1,
      notifiedEvents: 1,
      recipientsNotified: 1,
    });
    const payload = mocks.notify.mock.calls[0]?.[0].payload;
    expect(payload.address).toBe("901 Porter Rd");
    expect(payload.directionsUrl).toContain("36.1862,-86.7291");
    expect(notifiedAt.has(EVENT_1)).toBe(true);
  });

  it("the start-keyed scan never releases an UNCONFIRMED event either", async () => {
    const { deps, mocks, notifiedAt } = createDeps({
      events: [
        buildEvent({
          ...strangerAtHouse,
          addressRevealAt: new Date(NOW.getTime() - 10 * DAY),
          startsAt: new Date(NOW.getTime() + DAY - 5 * 60 * 1000),
        }),
      ],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      placesById: { [PLACE_ID]: withheldPlace },
    });
    const result = await dispatchAddressRevealNotifications(deps, {});
    expect(result).toEqual({ ...EMPTY_RESULT, processed: 1, lockedEvents: 1 });
    expectNothingSent(mocks, notifiedAt);
  });

  it("an event both scans find is processed once", async () => {
    // The venue's own DAY_BEFORE show: own date == startsAt − 24h.
    const startsAt = new Date(NOW.getTime() + DAY - 5 * 60 * 1000);
    const { deps, mocks } = createDeps({
      events: [
        buildEvent({
          ...strangerAtHouse,
          orgId: VENUE_ORG,
          addressRevealPreset: "DAY_BEFORE",
          addressRevealAt: new Date(startsAt.getTime() - DAY),
          startsAt,
        }),
      ],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      placesById: { [PLACE_ID]: withheldPlace },
    });
    const result = await dispatchAddressRevealNotifications(deps, {});
    expect(result).toMatchObject({ processed: 1, notifiedEvents: 1 });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("runs BOTH scans every time — the start-keyed one is a required repo method", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent()],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });
    const result = await dispatchAddressRevealNotifications(deps, {});
    expect(result).toMatchObject({ processed: 1, notifiedEvents: 1 });
    expect(mocks.eventsRepo.findObscuredEventsCrossingReveal).toHaveBeenCalledTimes(1);
    expect(mocks.eventsRepo.findObscuredPlaceEventsStartingIn).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchAddressRevealNotifications — SMS short link", () => {
  const SHORT_ID = "wqsdk6pxzi";
  const SHORT_URL = `${APP_BASE_URL}/e/${SHORT_ID}`;
  const CANONICAL_URL = `${APP_BASE_URL}/events/secret-loft-session`;

  /** The harness types notify() loosely; this is what the dispatcher sends. */
  type SentCall = {
    variant: string;
    payload: { eventUrl?: string | null; eventShortUrl?: string | null };
  };
  const firstSent = (notify: { mock: { calls: unknown[][] } }): SentCall =>
    notify.mock.calls[0]?.[0] as SentCall;

  it("passes the short URL when the event has a short ID and is publicly readable, and the SMS carries it", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent({ shortId: SHORT_ID })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    await dispatchAddressRevealNotifications(deps, {});

    const call = firstSent(mocks.notify);
    expect(call.payload).toMatchObject({
      eventUrl: CANONICAL_URL,
      eventShortUrl: SHORT_URL,
    });
    // Same re-read the `/e/<shortId>` resolver makes.
    expect(mocks.eventsRepo.getById).toHaveBeenCalledWith(EVENT_1);

    const rendered = renderNotification(call.variant, call.payload, {
      now: NOW,
    });
    expect(rendered.sms?.body?.endsWith(` ${SHORT_URL}`)).toBe(true);
    expect(rendered.email?.text).toContain(`View the event: ${CANONICAL_URL}`);
    expect(rendered.inApp?.action?.route).toBe("/events/secret-loft-session");
  });

  it("passes no short URL when the event has no short ID (and never re-reads it)", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent({ shortId: null })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    await dispatchAddressRevealNotifications(deps, {});

    const call = firstSent(mocks.notify);
    expect(call.payload.eventShortUrl).toBeNull();
    expect(call.payload.eventUrl).toBe(CANONICAL_URL);
    expect(mocks.eventsRepo.getById).not.toHaveBeenCalled();
    const rendered = renderNotification(call.variant, call.payload, {
      now: NOW,
    });
    expect(rendered.sms?.body?.endsWith(` ${CANONICAL_URL}`)).toBe(true);
  });

  it("passes no short URL when the event is no longer publicly readable on re-read", async () => {
    const event = buildEvent({ shortId: SHORT_ID });
    const { deps, mocks } = createDeps({
      events: [event],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      currentById: {
        [EVENT_1]: { ...event, status: "DRAFT", publishedAt: null },
      },
    });

    await dispatchAddressRevealNotifications(deps, {});

    expect(firstSent(mocks.notify).payload.eventShortUrl).toBeNull();
  });

  it("passes no short URL when there is no canonical link (no slug)", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent({ shortId: SHORT_ID, slug: null })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });

    await dispatchAddressRevealNotifications(deps, {});

    const { payload } = firstSent(mocks.notify);
    expect(payload.eventUrl).toBeNull();
    expect(payload.eventShortUrl).toBeNull();
  });

  it("a throwing re-read DEGRADES: reported, notice still sent with the canonical URL in its SMS, cursor stamped", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent({ shortId: SHORT_ID })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A, HOLDER_B] },
    });
    const reportError = vi.fn();
    deps.reportError = reportError;
    const boom = new Error("db down");
    mocks.eventsRepo.getById.mockRejectedValueOnce(boom);

    const result = await dispatchAddressRevealNotifications(deps, {});

    // The link is a convenience; the address is the point.
    expect(result).toMatchObject({
      processed: 1,
      notifiedEvents: 1,
      failedEvents: 0,
      recipientsNotified: 2,
    });
    expect(mocks.eventsRepo.getById).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: {
        useCase: "events.dispatchAddressRevealNotifications",
        step: "sms_short_url",
      },
      extra: { eventId: EVENT_1 },
    });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "events.dispatchAddressRevealNotifications.sms_short_url_failed",
      expect.objectContaining({ eventId: EVENT_1 }),
    );

    const call = firstSent(mocks.notify);
    expect(call.payload.eventShortUrl).toBeNull();
    const rendered = renderNotification(call.variant, call.payload, {
      now: NOW,
    });
    expect(rendered.sms?.body?.endsWith(` ${CANONICAL_URL}`)).toBe(true);
    expect(mocks.eventsRepo.markAddressRevealNotified).toHaveBeenCalledWith(
      EVENT_1,
      NOW,
    );
  });

  it("a throwing reporter does not change the degraded outcome", async () => {
    const { deps, mocks } = createDeps({
      events: [buildEvent({ shortId: SHORT_ID })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });
    deps.reportError = () => {
      throw new Error("sentry down");
    };
    mocks.eventsRepo.getById.mockRejectedValueOnce(new Error("db down"));

    const result = await dispatchAddressRevealNotifications(deps, {});

    expect(result).toMatchObject({ notifiedEvents: 1, failedEvents: 0 });
    expect(firstSent(mocks.notify).payload.eventShortUrl).toBeNull();
  });

  it("skips the re-read when nobody is left to notify", async () => {
    const { deps, mocks, ledger } = createDeps({
      events: [buildEvent({ shortId: SHORT_ID })],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
    });
    // Already notified (e.g. an explicit re-drive after a complete fan-out).
    ledger.add(`${EVENT_1}:${HOLDER_A}`);

    await dispatchAddressRevealNotifications(deps, { eventId: EVENT_1 });

    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.eventsRepo.getById).not.toHaveBeenCalled();
  });

  it("builds the link from the RE-READ row, like the /e/ resolver", async () => {
    const event = buildEvent({ shortId: SHORT_ID });
    const { deps, mocks } = createDeps({
      events: [event],
      holdersByEvent: { [EVENT_1]: [HOLDER_A] },
      // The current row lost its slug since the scan: the redirect has no
      // target, so no short link.
      currentById: { [EVENT_1]: { ...event, slug: null } },
    });

    await dispatchAddressRevealNotifications(deps, {});

    expect(firstSent(mocks.notify).payload.eventShortUrl).toBeNull();
  });
});
