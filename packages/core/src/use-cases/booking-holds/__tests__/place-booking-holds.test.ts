import { describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";

import { buildIdempotencyKey } from "../notify-booking-hold-intents";
import { placeBookingHold } from "../place-booking-hold";
import { placeBookingHolds } from "../place-booking-holds";
import {
  ASSIGNEE_ID,
  CALENDAR_ID,
  NOW,
  PLACE_ID,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "./hold-test-context";

// ─────────────────────────────────────────────────────────────────────────────
// placeBookingHolds (FR-002, batch) — one resolve, one transaction per date,
// partial success as a first-class outcome, and ONE digest notification.
// ─────────────────────────────────────────────────────────────────────────────

const D1 = "2026-06-20";
const D2 = "2026-06-21";
const D3 = "2026-06-22";

const ACT_HUMAN = "a0000000-0000-4000-8000-0000000000aa";

describe("placeBookingHolds", () => {
  it("places every date ascending, each at the end of its own line, with a ledger entry and an audit row per hold", async () => {
    const ctx = buildHoldTestContext();
    // Someone is already first on D2, so this act enters that line at 2 while
    // being first on D1 and D3 — positions are per line, never per batch.
    ctx.seedHold(REQUEST_B, { date: D2 });

    const result = await placeBookingHolds(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      // Deliberately unsorted + duplicated: the use case dedupes and sorts.
      dates: [D3, D1, D2, D1],
    });

    expect(result.failed).toEqual([]);
    expect(result.placed.map((h) => [h.date, h.position])).toEqual([
      [D1, 1],
      [D2, 2],
      [D3, 1],
    ]);
    // The calendar owns the room; a hold never reserved one.
    expect(result.placed.every((h) => h.spaceId === null)).toBe(true);

    // One system entry per hold — a "released Fri 21" line with no matching
    // "placed Fri 21" would read as a hole in the thread's history.
    expect(ctx.entries(REQUEST_A)).toEqual(
      result.placed.map((hold) => ({
        kind: "booking_hold.placed",
        data: { holdId: hold.id, date: hold.date, position: hold.position },
        actor: STAFF_ID,
      })),
    );
    expect(ctx.audit.log).toHaveBeenCalledTimes(3);
    // One transaction per date (plus nothing else) — the lines are locked
    // separately on purpose.
    expect(ctx.repos.tx).toHaveBeenCalledTimes(3);

    expect(result.staffRecipientHint).toEqual({
      assigneeHumanId: ASSIGNEE_ID,
      placedByHumanId: STAFF_ID,
      orgId: "22222222-2222-4222-8222-222222222222",
      placeId: PLACE_ID,
    });
  });

  it("emits exactly ONE hold.placed_batch intent for 2+ holds, carrying every date and position", async () => {
    const ctx = buildHoldTestContext();

    const result = await placeBookingHolds(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      dates: [D1, D2, D3],
    });

    const placedIntents = result.notificationIntents.filter((i) =>
      i.kind.startsWith("hold.placed"),
    );
    expect(placedIntents).toHaveLength(1);
    expect(placedIntents[0]).toEqual({
      kind: "hold.placed_batch",
      bookingRequestId: REQUEST_A,
      holdId: result.placed[0]!.id,
      audience: "act",
      date: D1,
      dates: [
        { date: D1, position: 1 },
        { date: D2, position: 1 },
        { date: D3, position: 1 },
      ],
      holdIds: result.placed.map((h) => h.id),
    });
  });

  it("a single-date batch emits the plain hold.placed intent — the one-date copy is unchanged", async () => {
    const ctx = buildHoldTestContext();

    const result = await placeBookingHolds(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      dates: [D1],
    });

    expect(result.notificationIntents).toEqual([
      {
        kind: "hold.placed",
        bookingRequestId: REQUEST_A,
        holdId: result.placed[0]!.id,
        audience: "act",
        date: D1,
        position: 1,
      },
    ]);
  });

  it("a batch that places nothing owes no notification", async () => {
    const ctx = buildHoldTestContext();

    const result = await placeBookingHolds(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      dates: ["2026-06-09"],
    });

    expect(result.placed).toEqual([]);
    expect(result.failed).toEqual([
      { date: "2026-06-09", code: "hold_date_in_past" },
    ]);
    expect(result.notificationIntents).toEqual([]);
  });

  it("partial success: a line already won by another act is reported, the rest stand", async () => {
    const ctx = buildHoldTestContext();
    ctx.seedHold(REQUEST_B, { date: D2, status: "CONFIRMED", confirmedAt: NOW });

    const result = await placeBookingHolds(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      dates: [D1, D2, D3],
    });

    expect(result.failed).toEqual([
      { date: D2, code: "HOLD_LINE_ALREADY_CONFIRMED" },
    ]);
    expect(result.placed.map((h) => h.date)).toEqual([D1, D3]);
    // Still a digest: two holds were placed.
    expect(result.notificationIntents.at(-1)).toMatchObject({
      kind: "hold.placed_batch",
      dates: [
        { date: D1, position: 1 },
        { date: D3, position: 1 },
      ],
    });
  });

  it("partial success: a date this request is ALREADY in line for is reported as booking_hold_exists", async () => {
    const ctx = buildHoldTestContext();
    await placeBookingHold(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      date: D1,
    });

    const result = await placeBookingHolds(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      dates: [D1, D2],
    });

    expect(result.failed).toEqual([{ date: D1, code: "booking_hold_exists" }]);
    expect(result.placed.map((h) => h.date)).toEqual([D2]);
    // One hold placed → the plain single-date intent, not a digest of one.
    expect(result.notificationIntents).toEqual([
      expect.objectContaining({ kind: "hold.placed", date: D2 }),
    ]);
  });

  it("records a past date and an unparseable day without touching the line", async () => {
    const ctx = buildHoldTestContext();

    const result = await placeBookingHolds(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      // NOW is 2026-06-10 07:00 Chicago; 2026-02-30 is not a real day.
      dates: ["2026-06-09", "2026-02-30", D1],
    });

    expect(result.failed).toEqual([
      { date: "2026-02-30", code: "invalid_calendar_date" },
      { date: "2026-06-09", code: "hold_date_in_past" },
    ]);
    expect(result.placed.map((h) => h.date)).toEqual([D1]);
    expect(ctx.repos.tx).toHaveBeenCalledTimes(1);
  });

  it("settles lapses on each line first, so every position handed out is real", async () => {
    const ctx = buildHoldTestContext();
    ctx.seedHold(REQUEST_B, {
      date: D1,
      status: "CHALLENGED",
      respondBy: new Date(NOW.getTime() - 1000),
    });

    const result = await placeBookingHolds(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      dates: [D1, D2],
    });

    // B's challenge expired and left the line, so A enters D1 at 1, not 2.
    expect(result.placed.map((h) => [h.date, h.position])).toEqual([
      [D1, 1],
      [D2, 1],
    ]);
    expect(
      result.notificationIntents.map((i) => [i.kind, i.bookingRequestId]),
    ).toEqual([
      ["hold.expired", REQUEST_B],
      ["hold.expired", REQUEST_B],
      ["hold.placed_batch", REQUEST_A],
    ]);
  });

  // ── Never throw once a hold is durable ────────────────────────────────
  // Each date commits in its OWN transaction, so a throw after date 1 has
  // landed would discard the notification intents for it: the act would hold
  // a date with no email and no push, silently (the ledger entry still
  // renders in-thread). These four pin that it cannot happen.

  it("an unknown failure AFTER a commit degrades to a failed date — the placed holds and their digest survive", async () => {
    const ctx = buildHoldTestContext();
    const reportError = vi.fn();
    // Dates are placed ascending, so this kills the THIRD date (D3).
    ctx.bookingHolds.create
      .mockImplementationOnce(ctx.bookingHolds.create.getMockImplementation()!)
      .mockImplementationOnce(ctx.bookingHolds.create.getMockImplementation()!)
      .mockRejectedValueOnce(new Error("connection terminated"));

    const result = await placeBookingHolds(
      { ...ctx.deps, reportError },
      {
        actorHumanId: STAFF_ID,
        bookingRequestId: REQUEST_A,
        calendarId: CALENDAR_ID,
        dates: [D1, D2, D3],
      },
    );

    expect(result.placed.map((h) => h.date)).toEqual([D1, D2]);
    expect(result.failed).toEqual([{ date: D3, code: "unknown_error" }]);

    // The whole point: the two durable holds still get their ONE digest.
    const digest = result.notificationIntents.filter(
      (i) => i.kind === "hold.placed_batch",
    );
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({
      dates: [
        { date: D1, position: 1 },
        { date: D2, position: 1 },
      ],
      holdIds: result.placed.map((h) => h.id),
    });

    // ReporterPort convention: the swallow is reported, not just logged.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "placeBookingHolds" },
      extra: { bookingRequestId: REQUEST_A, date: D3 },
    });
  });

  it("the SAME unknown failure with nothing committed still throws — a systemic failure is not 'one date didn't work'", async () => {
    const ctx = buildHoldTestContext();
    const reportError = vi.fn();
    ctx.bookingHolds.create.mockRejectedValue(new Error("connection terminated"));

    await expect(
      placeBookingHolds(
        { ...ctx.deps, reportError },
        {
          actorHumanId: STAFF_ID,
          bookingRequestId: REQUEST_A,
          calendarId: CALENDAR_ID,
          dates: [D1, D2],
        },
      ),
    ).rejects.toThrow("connection terminated");
    // Nothing committed, so the throw loses nothing and rides the transport
    // + Sentry backstops rather than the swallow reporter.
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the raw adapter conflict (create maps a deadlock to it)",
      { code: "conflict", message: "booking_hold_line_changed" } as const,
    ],
    [
      "the typed AppError (settleLine's release/renumber path already mapped it)",
      new AppError("HOLD_LINE_CHANGED"),
    ],
  ])(
    "a line that moved under one date — %s — is recorded as failed; the other dates stand",
    async (_label, thrown) => {
      const ctx = buildHoldTestContext();
      ctx.bookingHolds.create
        .mockImplementationOnce(ctx.bookingHolds.create.getMockImplementation()!)
        .mockRejectedValueOnce(thrown);

      const result = await placeBookingHolds(ctx.deps, {
        actorHumanId: STAFF_ID,
        bookingRequestId: REQUEST_A,
        calendarId: CALENDAR_ID,
        dates: [D1, D2, D3],
      });

      // Retryable and per-line: D2 rolled back, so no hold exists for it.
      expect(result.failed).toEqual([{ date: D2, code: "HOLD_LINE_CHANGED" }]);
      expect(result.placed.map((h) => h.date)).toEqual([D1, D3]);
      expect(result.notificationIntents.at(-1)).toMatchObject({
        kind: "hold.placed_batch",
        dates: [
          { date: D1, position: 1 },
          { date: D3, position: 1 },
        ],
      });
    },
  );

  it("a THROWING reportError cannot turn a degraded batch back into a failed one", async () => {
    const ctx = buildHoldTestContext();
    const reportError = vi.fn(() => {
      throw new Error("sentry is down");
    });
    ctx.bookingHolds.create
      .mockImplementationOnce(ctx.bookingHolds.create.getMockImplementation()!)
      .mockRejectedValueOnce(new Error("connection terminated"));

    const result = await placeBookingHolds(
      { ...ctx.deps, reportError },
      {
        actorHumanId: STAFF_ID,
        bookingRequestId: REQUEST_A,
        calendarId: CALENDAR_ID,
        dates: [D1, D2],
      },
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(result.placed.map((h) => h.date)).toEqual([D1]);
    expect(result.failed).toEqual([{ date: D2, code: "unknown_error" }]);
  });

  it("a throwing LOGGER in the tail degrades instead of discarding the committed holds' intents", async () => {
    const ctx = buildHoldTestContext();
    const reportError = vi.fn();
    // The invariant covers the whole call, not just the loop: by the time the
    // tail runs, two holds are already durable.
    const logger = {
      info: vi.fn(() => {
        throw new Error("log transport closed");
      }),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const result = await placeBookingHolds(
      { ...ctx.deps, logger: logger as never, reportError },
      {
        actorHumanId: STAFF_ID,
        bookingRequestId: REQUEST_A,
        calendarId: CALENDAR_ID,
        dates: [D1, D2],
      },
    );

    expect(result.placed.map((h) => h.date)).toEqual([D1, D2]);
    // The payload still carries the digest — the whole point.
    expect(result.notificationIntents.at(-1)).toMatchObject({
      kind: "hold.placed_batch",
      dates: [
        { date: D1, position: 1 },
        { date: D2, position: 1 },
      ],
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "placeBookingHolds", step: "finalize" },
    });
  });

  it("the SAME tail failure with nothing committed still throws", async () => {
    const ctx = buildHoldTestContext();
    const logger = {
      info: vi.fn(() => {
        throw new Error("log transport closed");
      }),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    await expect(
      placeBookingHolds(
        { ...ctx.deps, logger: logger as never },
        {
          actorHumanId: STAFF_ID,
          bookingRequestId: REQUEST_A,
          calendarId: CALENDAR_ID,
          // Past date: nothing is committed, so a malformed/failed result is
          // a bug worth surfacing loudly rather than degrading.
          dates: ["2026-06-09"],
        },
      ),
    ).rejects.toThrow("log transport closed");
  });

  it("applies the same gates as the single-date path (edit role, real calendar, open request, strict input)", async () => {
    const ctx = buildHoldTestContext();
    const base = {
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      dates: [D1],
    };

    await expect(
      placeBookingHolds(ctx.deps, { ...base, actorHumanId: VIEWER_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    await expect(
      placeBookingHolds(ctx.deps, {
        ...base,
        actorHumanId: STAFF_ID,
        calendarId: "cfcfcfcf-cfcf-4cfc-8cfc-cfcfcfcfcfcf",
      }),
    ).rejects.toMatchObject({ code: "CALENDAR_NOT_FOUND" });
    await expect(
      placeBookingHolds(ctx.deps, {
        ...base,
        actorHumanId: STAFF_ID,
        dates: [],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      placeBookingHolds(ctx.deps, {
        ...base,
        actorHumanId: STAFF_ID,
        dates: Array.from({ length: 13 }, (_, i) => `2026-07-${String(i + 1).padStart(2, "0")}`),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // The calendar owns the room — no space may be named.
    await expect(
      placeBookingHolds(ctx.deps, {
        ...base,
        actorHumanId: STAFF_ID,
        spaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    ctx.requests.set(REQUEST_A, {
      ...ctx.requests.get(REQUEST_A)!,
      status: "DECLINED",
    });
    await expect(
      placeBookingHolds(ctx.deps, { ...base, actorHumanId: STAFF_ID }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });

    expect(ctx.bookingHolds.rows.size).toBe(0);
  });

  it("the digest's idempotency key is stable over the SET of holds — a retry cannot double-send", async () => {
    const ctx = buildHoldTestContext();

    const result = await placeBookingHolds(ctx.deps, {
      actorHumanId: STAFF_ID,
      bookingRequestId: REQUEST_A,
      calendarId: CALENDAR_ID,
      dates: [D1, D2, D3],
    });
    const digest = result.notificationIntents.at(-1)!;

    const first = buildIdempotencyKey(digest, ACT_HUMAN);
    // Same set, different order (and a different anchor holdId): same key.
    const second = buildIdempotencyKey(
      {
        ...digest,
        holdId: digest.holdIds!.at(-1)!,
        holdIds: [...digest.holdIds!].reverse(),
      },
      ACT_HUMAN,
    );
    expect(second).toBe(first);
    expect(first).toMatch(/^booking-hold-batch:[0-9a-f]{32}:hold\.placed_batch:act:/);

    // A DIFFERENT set gets a different key.
    const dropped = buildIdempotencyKey(
      { ...digest, holdIds: digest.holdIds!.slice(0, 2) },
      ACT_HUMAN,
    );
    expect(dropped).not.toBe(first);

    // And it can never collide with a single-hold key (`booking-hold:{uuid}`).
    const single = buildIdempotencyKey(
      { ...digest, kind: "hold.placed", position: 1 },
      ACT_HUMAN,
    );
    expect(single.startsWith("booking-hold:")).toBe(true);
    expect(first.startsWith("booking-hold:")).toBe(false);
  });
});
