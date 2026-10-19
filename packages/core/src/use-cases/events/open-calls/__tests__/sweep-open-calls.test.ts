/**
 * Open calls v1 step 8 — the sweep-open-calls job's use case: the FR-021
 * backstop (per application, incl. the one-remaining-date case and series),
 * FR-022 pulled calls, the notice reconcile (close's deferred notices,
 * failed declines, received), races and failure handling. Runs over the
 * open-call fake world, whose sweep queries mirror the adapter's SQL.
 */
import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { OC_SERIES_ID, createOpenCallWorld, type OpenCallWorld } from "@th/test-utils/fakes/open-calls";

import { listOpenCallDates } from "../_shared/open-call-anchor";
import {
  OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES,
  OPEN_CALL_NOTICE_FAILURES_KEEP_SEC,
  openCallNoticeFailuresKey,
} from "../_shared/open-call-notice-failures";
import { openCallNoticeKey, type OpenCallNoticeKind } from "../notify-open-call-notices";
import {
  OPEN_CALL_RECONCILE_MIN_AGE_MS,
  OPEN_CALL_RECONCILE_SCAN_MAX,
  OPEN_CALL_RECONCILE_WINDOW_DAYS,
  OPEN_CALL_SWEEP_SYSTEMIC_MIN_ATTEMPTS,
  OPEN_CALL_SWEEP_TIME_BUDGET_MS,
  openCallReconcileCursorKey,
  sweepOpenCalls,
  type SweepOpenCallsDeps,
} from "../sweep-open-calls";
import { DAY, addEventDate } from "./open-call-application-helpers";

const HOUR = 60 * 60 * 1000;

function setup(opts: { now?: Date } = {}) {
  const world = createOpenCallWorld();
  let now = opts.now ?? world.now;
  const clock = { now: () => now } as unknown as ClockPort;
  const idempotency = createFakeIdempotencyPort({ withStatus: true });
  const sent: Array<{ kind: OpenCallNoticeKind; submissionId: string; notice: unknown }> = [];
  /** Submission ids whose notice throws (once each, unless sticky). */
  const failing = new Set<string>();
  /** Submission ids whose notifier returns but leaves the ledger open. */
  const unsettled = new Set<string>();
  const settle = (kind: OpenCallNoticeKind) => async (notice: { submissionId: string }) => {
    if (failing.has(notice.submissionId)) throw new Error(`send failed for ${notice.submissionId}`);
    sent.push({ kind, submissionId: notice.submissionId, notice });
    if (unsettled.has(notice.submissionId)) return;
    const key = openCallNoticeKey(kind, notice.submissionId);
    await idempotency.begin(key, 60);
    await idempotency.commit(key, { sentAt: "x" }, 3600);
  };
  const notices = {
    notifyOpenCallNotThisTime: vi.fn(settle("not-this-time")),
    notifyOpenCallPulled: vi.fn(settle("pulled")),
    notifyOpenCallApplicationReceived: vi.fn(settle("received")),
  };
  const reportError = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  const deps: SweepOpenCallsDeps = {
    repos: world.repos,
    clock,
    idempotency,
    notices: notices as unknown as SweepOpenCallsDeps["notices"],
    reportError,
    logger: logger as unknown as SweepOpenCallsDeps["logger"],
  };
  return {
    world,
    deps,
    idempotency,
    notices,
    sent,
    failing,
    unsettled,
    reportError,
    setNow: (d: Date) => {
      now = d;
    },
    markSent: async (kind: OpenCallNoticeKind, submissionId: string) => {
      const key = openCallNoticeKey(kind, submissionId);
      await idempotency.begin(key, 60);
      await idempotency.commit(key, { sentAt: "x" }, 3600);
    },
  };
}

type Setup = ReturnType<typeof setup>;

function eventCall(world: OpenCallWorld, eventOverrides: Record<string, unknown> = {}) {
  const event = world.addEvent(eventOverrides);
  const call = world.addForm({ purpose: "PERFORM", eventId: event.id });
  return { event, call };
}

function seriesCall(world: OpenCallWorld, seriesOverrides: Record<string, unknown> = {}) {
  const series = world.addSeries(seriesOverrides);
  const call = world.addForm({ purpose: "PERFORM", seriesId: series.id });
  return { series, call };
}

const statusOf = (s: Setup, id: string) => s.world.submissions.find((x) => x.id === id)!.status;
const sentKinds = (s: Setup, id: string) => s.sent.filter((x) => x.submissionId === id).map((x) => x.kind);

describe("sweepOpenCalls — FR-021 backstop", () => {
  it("single-date event: PENDING once the event has started → REJECTED + not this time", async () => {
    const s = setup();
    const { event, call } = eventCall(s.world, {
      startsAt: new Date(s.world.now.getTime() - HOUR),
      title: "Basement Show",
    });
    const sub = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - DAY) });

    const result = await sweepOpenCalls(s.deps, {});

    expect(result).toMatchObject({ due: 1, backstopRejected: 1, pulledExpired: 0, noticesSent: 1, lostRace: 0 });
    expect(statusOf(s, sub.id)).toBe("REJECTED");
    expect(s.world.submissions.find((x) => x.id === sub.id)!.reviewedAt).toEqual(s.world.now);
    expect(s.notices.notifyOpenCallNotThisTime).toHaveBeenCalledWith({
      kind: "open_call_not_this_time",
      submissionId: sub.id,
      formId: call.id,
      anchor: { kind: "event", eventId: event.id },
      title: "Basement Show",
      decisionReason: null,
    });
    expect(s.world.audit).toContainEqual(
      expect.objectContaining({
        action: "open_call_backstop_swept",
        entity: "event",
        entityId: event.id,
        data: expect.objectContaining({ formId: call.id, submissionIds: [sub.id] }),
      }),
    );
  });

  it("an upcoming single-date event is not touched", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "PENDING");
    const result = await sweepOpenCalls(s.deps, {});
    expect(result.due).toBe(0);
    expect(statusOf(s, sub.id)).toBe("PENDING");
    expect(s.sent).toEqual([]);
  });

  it("multi-date event: waits for the LAST chosen date, not the first", async () => {
    const s = setup();
    const { event, call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - 2 * DAY) });
    const past = addEventDate(s.world, new Date(s.world.now.getTime() - 2 * DAY), "SCHEDULED", event.id);
    const future = addEventDate(s.world, new Date(s.world.now.getTime() + 3 * DAY), "SCHEDULED", event.id);
    const sub = s.world.addSubmission(call.id, "PENDING", {
      createdAt: new Date(s.world.now.getTime() - 5 * DAY),
      dateChoices: [{ eventDateId: past.id }, { eventDateId: future.id }],
    });
    await s.markSent("received", sub.id);

    expect((await sweepOpenCalls(s.deps, {})).due).toBe(0);
    expect(statusOf(s, sub.id)).toBe("PENDING");

    s.setNow(new Date(future.startsAt.getTime() + HOUR));
    const result = await sweepOpenCalls(s.deps, {});
    expect(result.backstopRejected).toBe(1);
    expect(sentKinds(s, sub.id)).toEqual(["not-this-time"]);
  });

  it("one-remaining-date case: NO stored choice → the date that was upcoming at submit, not event.startsAt", async () => {
    const s = setup();
    // The event's own start (its first date) is long past; one date was left
    // when the act applied, so step 4 stored no choice.
    const { event, call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - 10 * DAY) });
    addEventDate(s.world, new Date(s.world.now.getTime() - 10 * DAY), "SCHEDULED", event.id);
    const remaining = addEventDate(s.world, new Date(s.world.now.getTime() + 2 * DAY), "SCHEDULED", event.id);
    const sub = s.world.addSubmission(call.id, "PENDING", {
      createdAt: new Date(s.world.now.getTime() - DAY),
      dateChoices: [],
    });

    expect((await sweepOpenCalls(s.deps, {})).due).toBe(0);
    expect(statusOf(s, sub.id)).toBe("PENDING");

    s.setNow(new Date(remaining.startsAt.getTime() + 1));
    expect((await sweepOpenCalls(s.deps, {})).backstopRejected).toBe(1);
    expect(statusOf(s, sub.id)).toBe("REJECTED");
  });

  it("series: per application — the call never ends, but an application whose chosen nights all started is answered", async () => {
    const s = setup();
    const { series, call } = seriesCall(s.world);
    const n1 = s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() - 2 * DAY) });
    const n2 = s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() - HOUR) });
    const n3 = s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() + 7 * DAY) });
    // More nights keep coming (n3 and beyond): the call stays open.
    const done = s.world.addSubmission(call.id, "PENDING", {
      createdAt: new Date(s.world.now.getTime() - 3 * DAY),
      dateChoices: [{ occurrenceId: n1.id }, { occurrenceId: n2.id }],
    });
    const waiting = s.world.addSubmission(call.id, "PENDING", {
      createdAt: new Date(s.world.now.getTime() - 3 * DAY),
      dateChoices: [{ occurrenceId: n1.id }, { occurrenceId: n3.id }],
    });

    const result = await sweepOpenCalls(s.deps, {});

    expect(result).toMatchObject({ due: 1, backstopRejected: 1 });
    expect(statusOf(s, done.id)).toBe("REJECTED");
    expect(statusOf(s, waiting.id)).toBe("PENDING");
    expect(s.notices.notifyOpenCallNotThisTime).toHaveBeenCalledWith(
      expect.objectContaining({ anchor: { kind: "series", seriesId: series.id }, title: series.name }),
    );
  });

  it("settles oldest first and stops at batchMax; the next run takes the rest", async () => {
    const s = setup();
    const { call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - HOUR) });
    const older = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - 2 * DAY) });
    const newer = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - DAY) });

    expect((await sweepOpenCalls(s.deps, { batchMax: 1 })).backstopRejected).toBe(1);
    expect(statusOf(s, older.id)).toBe("REJECTED");
    expect(statusOf(s, newer.id)).toBe("PENDING");

    await sweepOpenCalls(s.deps, { batchMax: 1 });
    expect(statusOf(s, newer.id)).toBe("REJECTED");
  });
});

describe("sweepOpenCalls — FR-022 pulled call", () => {
  it("cancelled event: PENDING → EXPIRED + pulled (never not-this-time); decided rows untouched", async () => {
    const s = setup();
    const { event, call } = eventCall(s.world, { status: "CANCELLED" });
    const pending = s.world.addSubmission(call.id, "PENDING");
    const picked = s.world.addSubmission(call.id, "APPROVED");
    const told = s.world.addSubmission(call.id, "REJECTED", { reviewedAt: s.world.now });

    const result = await sweepOpenCalls(s.deps, {});

    expect(result).toMatchObject({ due: 1, pulledExpired: 1, backstopRejected: 0 });
    expect(statusOf(s, pending.id)).toBe("EXPIRED");
    expect(statusOf(s, picked.id)).toBe("APPROVED");
    expect(statusOf(s, told.id)).toBe("REJECTED");
    expect(s.notices.notifyOpenCallPulled).toHaveBeenCalledWith({
      kind: "open_call_pulled",
      submissionId: pending.id,
      formId: call.id,
      anchor: { kind: "event", eventId: event.id },
      title: event.title,
    });
    expect(s.notices.notifyOpenCallNotThisTime).not.toHaveBeenCalled();
    expect(s.world.audit).toContainEqual(expect.objectContaining({ action: "open_call_pulled_swept" }));
  });

  it("a cancelled event whose date already passed is still 'pulled' (the cancel is the truth)", async () => {
    const s = setup();
    const { call } = eventCall(s.world, { status: "CANCELLED", startsAt: new Date(s.world.now.getTime() - DAY) });
    const sub = s.world.addSubmission(call.id, "PENDING");
    await sweepOpenCalls(s.deps, {});
    expect(statusOf(s, sub.id)).toBe("EXPIRED");
  });

  it("series: every chosen night cancelled → pulled; one live night left → still pending", async () => {
    const s = setup();
    const { call } = seriesCall(s.world);
    const off = s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() + DAY), status: "CANCELLED" });
    const on = s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() + 2 * DAY) });
    const allOff = s.world.addSubmission(call.id, "PENDING", { dateChoices: [{ occurrenceId: off.id }] });
    const oneOn = s.world.addSubmission(call.id, "PENDING", {
      dateChoices: [{ occurrenceId: off.id }, { occurrenceId: on.id }],
    });

    await sweepOpenCalls(s.deps, {});

    expect(statusOf(s, allOff.id)).toBe("EXPIRED");
    expect(sentKinds(s, allOff.id)).toEqual(["pulled"]);
    expect(statusOf(s, oneOn.id)).toBe("PENDING");
  });

  it("series: a CANCELLED materialised event pulls its night even while the occurrence reads live", async () => {
    const s = setup();
    const { call } = seriesCall(s.world);
    const night = s.world.addEvent({
      id: "20000000-0000-4000-8000-00000000c0c0",
      status: "CANCELLED",
      startsAt: new Date(s.world.now.getTime() + DAY),
    });
    const occ = s.world.addOccurrence({ startsAt: night.startsAt, eventId: night.id, status: "GENERATED" });
    const sub = s.world.addSubmission(call.id, "PENDING", { dateChoices: [{ occurrenceId: occ.id }] });

    await sweepOpenCalls(s.deps, {});

    expect(statusOf(s, sub.id)).toBe("EXPIRED");
  });

  it("series archived while the chosen night is still ahead → pulled", async () => {
    const s = setup();
    const { call } = seriesCall(s.world, { archivedAt: s.world.now });
    const occ = s.world.addOccurrence({ startsAt: new Date(s.world.now.getTime() + DAY) });
    const sub = s.world.addSubmission(call.id, "PENDING", { dateChoices: [{ occurrenceId: occ.id }] });
    await sweepOpenCalls(s.deps, {});
    expect(statusOf(s, sub.id)).toBe("EXPIRED");
  });

  it("multi-date event with the implied night cancelled → pulled", async () => {
    const s = setup();
    const { event, call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - 5 * DAY) });
    addEventDate(s.world, new Date(s.world.now.getTime() - 5 * DAY), "SCHEDULED", event.id);
    addEventDate(s.world, new Date(s.world.now.getTime() + 2 * DAY), "CANCELLED", event.id);
    const sub = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - DAY) });
    await sweepOpenCalls(s.deps, {});
    expect(statusOf(s, sub.id)).toBe("EXPIRED");
  });
});

describe("listOpenCallDates — cancelled materialised event", () => {
  it("drops a night whose event was cancelled though its occurrence is GENERATED", async () => {
    const world = createOpenCallWorld();
    const series = world.addSeries();
    const night = world.addEvent({
      id: "20000000-0000-4000-8000-00000000c0c1",
      status: "CANCELLED",
      startsAt: new Date(world.now.getTime() + DAY),
    });
    world.addOccurrence({ startsAt: night.startsAt, eventId: night.id, status: "GENERATED" });
    const live = world.addOccurrence({ startsAt: new Date(world.now.getTime() + 2 * DAY) });
    const dates = await listOpenCallDates(
      world.repos,
      { kind: "series", series },
      { now: world.now, upcomingOnly: true },
    );
    expect(dates.map((d) => d.occurrenceId)).toEqual([live.id]);
    expect(series.id).toBe(OC_SERIES_ID);
  });
});

describe("sweepOpenCalls — reconcile (close-sweep durability, launch gate)", () => {
  const ago = (s: Setup, ms: number) => new Date(s.world.now.getTime() - ms);

  it("re-sends not-this-time for REJECTED rows the close never told, and skips the ones already told", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const deferred = s.world.addSubmission(call.id, "REJECTED", { reviewedAt: ago(s, HOUR), createdAt: ago(s, DAY) });
    const told = s.world.addSubmission(call.id, "REJECTED", { reviewedAt: ago(s, HOUR), createdAt: ago(s, DAY) });
    await s.markSent("not-this-time", told.id);
    await s.markSent("received", deferred.id);
    await s.markSent("received", told.id);

    const result = await sweepOpenCalls(s.deps, {});

    expect(result.reconcile["not-this-time"]).toMatchObject({ scanned: 2, alreadySent: 1, attempted: 1, sent: 1 });
    expect(sentKinds(s, deferred.id)).toEqual(["not-this-time"]);
    expect(sentKinds(s, told.id)).toEqual([]);

    // Idempotent: a second run sends nothing.
    s.sent.length = 0;
    const again = await sweepOpenCalls(s.deps, {});
    expect(again.reconcile["not-this-time"]).toMatchObject({ alreadySent: 2, attempted: 0 });
    expect(s.sent).toEqual([]);
  });

  it("re-sends pulled for EXPIRED and received for PENDING rows", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const expired = s.world.addSubmission(call.id, "EXPIRED", { reviewedAt: ago(s, HOUR), createdAt: ago(s, DAY) });
    const pending = s.world.addSubmission(call.id, "PENDING", { createdAt: ago(s, HOUR) });

    const result = await sweepOpenCalls(s.deps, {});

    expect(sentKinds(s, expired.id)).toEqual(["pulled"]);
    expect(sentKinds(s, pending.id)).toEqual(["received"]);
    expect(s.notices.notifyOpenCallApplicationReceived).toHaveBeenCalledWith({
      kind: "application_received",
      submissionId: pending.id,
      formId: call.id,
    });
    expect(result.reconcile.pulled.sent).toBe(1);
    expect(result.reconcile.received.sent).toBe(1);
  });

  it("leaves rows younger than the min age (their in-request send may still run) and older than the window", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const fresh = s.world.addSubmission(call.id, "PENDING", {
      createdAt: ago(s, OPEN_CALL_RECONCILE_MIN_AGE_MS - 1000),
    });
    const ancient = s.world.addSubmission(call.id, "REJECTED", {
      createdAt: ago(s, 30 * DAY),
      reviewedAt: ago(s, (OPEN_CALL_RECONCILE_WINDOW_DAYS + 1) * DAY),
    });
    await sweepOpenCalls(s.deps, {});
    expect(sentKinds(s, fresh.id)).toEqual([]);
    expect(sentKinds(s, ancient.id)).toEqual([]);
  });

  it("this run's own flips are not attempted twice in the same run", async () => {
    const s = setup();
    const { call } = eventCall(s.world, { startsAt: ago(s, HOUR) });
    const sub = s.world.addSubmission(call.id, "PENDING", { createdAt: ago(s, DAY) });
    await s.markSent("received", sub.id);
    s.failing.add(sub.id);
    const result = await sweepOpenCalls(s.deps, {});
    // The only notice failed: reported, below the systemic threshold; the
    // flip is committed.
    expect(result).toMatchObject({ noticesSent: 0, noticesFailed: 1 });
    expect(statusOf(s, sub.id)).toBe("REJECTED");
    expect(s.notices.notifyOpenCallNotThisTime).toHaveBeenCalledTimes(1);

    // Next run, past the min age: reconcile resends it.
    s.failing.delete(sub.id);
    s.setNow(new Date(s.world.now.getTime() + OPEN_CALL_RECONCILE_MIN_AGE_MS + 1000));
    const next = await sweepOpenCalls(s.deps, {});
    expect(next.reconcile["not-this-time"].sent).toBe(1);
    expect(sentKinds(s, sub.id)).toEqual(["not-this-time"]);
  });
});

describe("sweepOpenCalls — races and failures", () => {
  it("a concurrent pick that commits first wins: no flip, no notice", async () => {
    const s = setup();
    const { call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - HOUR) });
    const sub = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - DAY) });
    await s.markSent("received", sub.id);
    const apps = s.world.repos.eventApplications;
    const original = apps.listOpenCallSweepDue.bind(apps);
    apps.listOpenCallSweepDue = async (input) => {
      const rows = await original(input);
      // The reviewer picks between the read and the guarded flip.
      s.world.submissions.find((x) => x.id === sub.id)!.status = "APPROVED";
      return rows;
    };

    const result = await sweepOpenCalls(s.deps, {});

    expect(result).toMatchObject({ due: 1, backstopRejected: 0, lostRace: 1, noticesSent: 0 });
    expect(statusOf(s, sub.id)).toBe("APPROVED");
    expect(s.notices.notifyOpenCallNotThisTime).not.toHaveBeenCalled();
  });

  it("one failing notice is reported and the run continues", async () => {
    const s = setup();
    const { call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - HOUR) });
    const bad = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - 2 * DAY) });
    const good = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - DAY) });
    await s.markSent("received", bad.id);
    await s.markSent("received", good.id);
    s.failing.add(bad.id);

    const result = await sweepOpenCalls(s.deps, {});

    expect(result).toMatchObject({ backstopRejected: 2, noticesSent: 1, noticesFailed: 1 });
    expect(sentKinds(s, good.id)).toEqual(["not-this-time"]);
    expect(s.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "sweepOpenCalls", reason: "notice_failed", kind: "not-this-time" }),
        extra: expect.objectContaining({ submissionId: bad.id }),
      }),
    );
  });

  it("a throwing reporter changes nothing", async () => {
    const s = setup();
    s.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    const { call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - HOUR) });
    const bad = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - 2 * DAY) });
    const good = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - DAY) });
    await s.markSent("received", bad.id);
    await s.markSent("received", good.id);
    s.failing.add(bad.id);
    await expect(sweepOpenCalls(s.deps, {})).resolves.toMatchObject({ noticesSent: 1, noticesFailed: 1 });
  });

  it("a notifier that returns but leaves the ledger open counts as failed", async () => {
    const s = setup();
    const { call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - HOUR) });
    const a = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - 2 * DAY) });
    const b = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - DAY) });
    await s.markSent("received", a.id);
    await s.markSent("received", b.id);
    s.unsettled.add(a.id);
    const result = await sweepOpenCalls(s.deps, {});
    expect(result).toMatchObject({ noticesSent: 1, noticesFailed: 1 });
  });

  it("systemic: the due query failing throws", async () => {
    const s = setup();
    s.world.repos.eventApplications.listOpenCallSweepDue = async () => {
      throw new Error("db down");
    };
    await expect(sweepOpenCalls(s.deps, {})).rejects.toThrow("db down");
  });

  it("systemic: every notice failing throws (after the flips commit) once the attempts reach the threshold", async () => {
    const s = setup();
    const { call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - HOUR) });
    const subs = Array.from({ length: OPEN_CALL_SWEEP_SYSTEMIC_MIN_ATTEMPTS }, (_, i) =>
      s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - (i + 1) * DAY) }),
    );
    for (const sub of subs) {
      await s.markSent("received", sub.id);
      s.failing.add(sub.id);
    }
    await expect(sweepOpenCalls(s.deps, {})).rejects.toThrow(/none settled/);
    for (const sub of subs) expect(statusOf(s, sub.id)).toBe("REJECTED");
  });

  it("one permanently dead notice does NOT fail the run every hour (below the threshold)", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const dead = s.world.addSubmission(call.id, "REJECTED", {
      reviewedAt: new Date(s.world.now.getTime() - HOUR),
      createdAt: new Date(s.world.now.getTime() - DAY),
    });
    await s.markSent("received", dead.id);
    s.failing.add(dead.id);
    for (let hour = 0; hour < 3; hour += 1) {
      s.setNow(new Date(s.world.now.getTime() + hour * HOUR));
      const result = await sweepOpenCalls(s.deps, {});
      expect(result.reconcile["not-this-time"]).toMatchObject({ attempted: 1, failed: 1 });
    }
    // Still reported per item, every run.
    expect(
      s.reportError.mock.calls.filter((c) => (c[1] as { tags: { reason: string } }).tags.reason === "notice_failed"),
    ).toHaveLength(3);
  });

  it("an empty run succeeds with zero counts", async () => {
    const s = setup();
    await expect(sweepOpenCalls(s.deps, {})).resolves.toMatchObject({ due: 0, noticesSent: 0 });
  });

  it("refuses unknown input keys", async () => {
    const s = setup();
    await expect(sweepOpenCalls(s.deps, { surprise: 1 })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("sweepOpenCalls — reconcile cursor (no starvation past the scan cap)", () => {
  it("resumes after the stored cursor and wraps: unsent rows beyond an all-sent prefix are reached", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const base = s.world.now.getTime() - DAY;
    // An all-sent prefix bigger than one run's scan cap, then two unsent rows.
    const prefix = OPEN_CALL_RECONCILE_SCAN_MAX + 10;
    for (let i = 0; i < prefix; i += 1) {
      const sub = s.world.addSubmission(call.id, "REJECTED", {
        reviewedAt: new Date(base + i * 1000),
        createdAt: new Date(base - DAY),
      });
      await s.markSent("not-this-time", sub.id);
    }
    const late = [0, 1].map((i) =>
      s.world.addSubmission(call.id, "REJECTED", {
        reviewedAt: new Date(base + (prefix + i) * 1000),
        createdAt: new Date(base - DAY),
      }),
    );

    // Run 1 stops at the scan cap with nothing sent, and stores where it stopped.
    const first = await sweepOpenCalls(s.deps, {});
    expect(first.reconcile["not-this-time"]).toMatchObject({
      scanned: OPEN_CALL_RECONCILE_SCAN_MAX,
      attempted: 0,
      scanCapped: true,
      passCompleted: false,
    });
    expect(await s.idempotency.get(openCallReconcileCursorKey("not-this-time"))).toMatchObject({
      at: expect.any(String),
    });

    // Run 2 resumes there, reaches the unsent rows, wraps, and finishes the pass.
    const second = await sweepOpenCalls(s.deps, {});
    expect(second.reconcile["not-this-time"]).toMatchObject({ attempted: 2, sent: 2 });
    for (const sub of late) expect(sentKinds(s, sub.id)).toEqual(["not-this-time"]);
  });

  it("a completed pass resets the cursor; the next run starts at the oldest row", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "REJECTED", {
      reviewedAt: new Date(s.world.now.getTime() - HOUR),
      createdAt: new Date(s.world.now.getTime() - DAY),
    });
    const result = await sweepOpenCalls(s.deps, {});
    expect(result.reconcile["not-this-time"]).toMatchObject({ passCompleted: true, sent: 1 });
    expect(await s.idempotency.get(openCallReconcileCursorKey("not-this-time"))).toEqual({
      at: null,
      submissionId: null,
    });
    expect(sentKinds(s, sub.id)).toEqual(["not-this-time"]);
  });

  it("a wrapped pass stops where it began and never re-sends within one run", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const base = s.world.now.getTime() - DAY;
    const subs = [0, 1, 2].map((i) =>
      s.world.addSubmission(call.id, "REJECTED", {
        reviewedAt: new Date(base + i * 1000),
        createdAt: new Date(base - DAY),
      }),
    );
    // Stored cursor sits on the middle row: the run takes the last, wraps, takes the first two.
    await s.idempotency.commit(
      openCallReconcileCursorKey("not-this-time"),
      { at: new Date(base + 1000).toISOString(), submissionId: subs[1]!.id },
      3600,
    );
    const result = await sweepOpenCalls(s.deps, {});
    expect(result.reconcile["not-this-time"]).toMatchObject({ attempted: 3, sent: 3, passCompleted: true });
    expect(s.sent.filter((x) => x.kind === "not-this-time").map((x) => x.submissionId)).toEqual([
      subs[2]!.id,
      subs[0]!.id,
      subs[1]!.id,
    ]);
  });

  it("rows sharing one reviewedAt: resumes mid-group, wraps, and stops mid-group where it began", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    // settleDue / close / expireUndecided stamp a whole batch with one `now`:
    // the (at equal AND id > cursor) branch is the common path.
    const at = new Date(s.world.now.getTime() - DAY);
    const ids = [0, 1, 2, 3]
      .map(() => s.world.addSubmission(call.id, "REJECTED", { reviewedAt: at, createdAt: new Date(at.getTime() - DAY) }).id)
      .sort();
    await s.idempotency.commit(
      openCallReconcileCursorKey("not-this-time"),
      { at: at.toISOString(), submissionId: ids[1]! },
      3600,
    );
    const result = await sweepOpenCalls(s.deps, {});
    expect(result.reconcile["not-this-time"]).toMatchObject({ attempted: 4, sent: 4, passCompleted: true });
    // After the cursor inside the group, then the wrap from the oldest up to
    // (and including) the cursor row, and no row twice.
    expect(s.sent.filter((x) => x.kind === "not-this-time").map((x) => x.submissionId)).toEqual([
      ids[2],
      ids[3],
      ids[0],
      ids[1],
    ]);
  });

  it("a failing cursor read is reported and the scan starts at the oldest row", async () => {
    const s = setup();
    const { call } = eventCall(s.world);
    const sub = s.world.addSubmission(call.id, "EXPIRED", {
      reviewedAt: new Date(s.world.now.getTime() - HOUR),
      createdAt: new Date(s.world.now.getTime() - DAY),
    });
    s.idempotency.__mocks.get.mockRejectedValueOnce(new Error("store down"));
    await sweepOpenCalls(s.deps, {});
    expect(sentKinds(s, sub.id)).toEqual(["pulled"]);
    expect(s.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: "reconcile_cursor_read_failed" }) }),
    );
  });
});

describe("sweepOpenCalls — time budget", () => {
  it("stops starting sends once the budget is spent, reports it, and leaves the rest owed", async () => {
    const s = setup();
    const { call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - HOUR) });
    const subs = [0, 1, 2].map((i) =>
      s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - (3 - i) * DAY) }),
    );
    for (const sub of subs) await s.markSent("received", sub.id);
    // The first send takes the whole budget on the injected clock.
    const start = s.world.now.getTime();
    s.notices.notifyOpenCallNotThisTime.mockImplementationOnce(async (notice: { submissionId: string }) => {
      s.setNow(new Date(start + OPEN_CALL_SWEEP_TIME_BUDGET_MS));
      await s.markSent("not-this-time", notice.submissionId);
    });

    const result = await sweepOpenCalls(s.deps, {});

    expect(result).toMatchObject({
      backstopRejected: 3,
      noticesSent: 1,
      noticesDeferred: 2,
      timeBudgetExhausted: true,
    });
    expect(result.reconcile["not-this-time"]).toMatchObject({ scanned: 0, attempted: 0 });
    for (const sub of subs) expect(statusOf(s, sub.id)).toBe("REJECTED");
    expect(
      s.reportError.mock.calls.filter(
        (c) => (c[1] as { tags: { reason: string } }).tags.reason === "time_budget_exhausted",
      ),
    ).toHaveLength(1);

    // A later run (past the min age) reconciles the two deferred notices.
    s.setNow(new Date(start + 2 * HOUR));
    const next = await sweepOpenCalls(s.deps, {});
    expect(next.reconcile["not-this-time"]).toMatchObject({ sent: 2 });
  });
});

describe("sweepOpenCalls — dead notices (owner ruling 2026-10-07)", () => {
  const reasonsOf = (s: Setup) =>
    s.reportError.mock.calls.map((c) => (c[1] as { tags: { reason: string } }).tags.reason);
  function rejectedRows(s: Setup, count: number) {
    const { call } = eventCall(s.world);
    return Array.from({ length: count }, (_, i) =>
      s.world.addSubmission(call.id, "REJECTED", {
        reviewedAt: new Date(s.world.now.getTime() - (i + 1) * HOUR),
        createdAt: new Date(s.world.now.getTime() - 2 * DAY),
      }),
    );
  }
  async function markDead(s: Setup, kind: OpenCallNoticeKind, id: string) {
    await s.idempotency.commit(
      openCallNoticeFailuresKey(kind, id),
      { count: OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES },
      OPEN_CALL_NOTICE_FAILURES_KEEP_SEC,
    );
  }

  it("three dead rows in a quiet hour: not re-sent, no throw, no per-item noise", async () => {
    const s = setup();
    const subs = rejectedRows(s, OPEN_CALL_SWEEP_SYSTEMIC_MIN_ATTEMPTS);
    for (const sub of subs) {
      await s.markSent("received", sub.id);
      await markDead(s, "not-this-time", sub.id);
      s.failing.add(sub.id);
    }
    const result = await sweepOpenCalls(s.deps, {});
    expect(result.reconcile["not-this-time"]).toMatchObject({
      scanned: subs.length,
      skippedDead: subs.length,
      attempted: 0,
      failed: 0,
    });
    expect(s.notices.notifyOpenCallNotThisTime).not.toHaveBeenCalled();
    expect(reasonsOf(s)).toEqual([]);
  });

  it("dead rows are skipped (no attempt, no cap slot); a fresh row beside them is still sent", async () => {
    const s = setup();
    const [fresh, ...dead] = rejectedRows(s, 4); // fresh is the newest
    for (const sub of [fresh!, ...dead]) await s.markSent("received", sub.id);
    for (const sub of dead) await markDead(s, "not-this-time", sub.id);
    const result = await sweepOpenCalls(s.deps, {});
    expect(result.reconcile["not-this-time"]).toMatchObject({ skippedDead: 3, attempted: 1, sent: 1 });
    expect(sentKinds(s, fresh!.id)).toEqual(["not-this-time"]);
  });

  it("three fresh failures still throw; the third makes each row dead (reported once), and the next hour is quiet", async () => {
    const s = setup();
    const subs = rejectedRows(s, OPEN_CALL_SWEEP_SYSTEMIC_MIN_ATTEMPTS);
    for (const sub of subs) {
      await s.markSent("received", sub.id);
      s.failing.add(sub.id);
    }
    for (let hour = 1; hour <= OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES; hour += 1) {
      await expect(sweepOpenCalls(s.deps, {})).rejects.toThrow(/none settled/);
      for (const sub of subs) {
        expect(await s.idempotency.get(openCallNoticeFailuresKey("not-this-time", sub.id))).toEqual({ count: hour });
      }
    }
    const crossed = s.reportError.mock.calls.filter(
      (c) => (c[1] as { tags: { reason: string } }).tags.reason === "notice_undeliverable",
    );
    expect(crossed.map((c) => (c[1] as { extra: { submissionId: string } }).extra.submissionId).sort()).toEqual(
      subs.map((x) => x.id).sort(),
    );

    s.reportError.mockClear();
    const quiet = await sweepOpenCalls(s.deps, {});
    expect(quiet.reconcile["not-this-time"]).toMatchObject({ skippedDead: 3, attempted: 0 });
    expect(reasonsOf(s)).toEqual([]);
  });

  describe("fail-closed counter paths", () => {
    const FAILURES_PREFIX = "open-call-notice-failures:";
    function rejectOnFailureKeys(s: Setup, method: "get" | "commit") {
      const mock = s.idempotency.__mocks[method];
      const real = mock.getMockImplementation()!;
      mock.mockImplementation(async (key: string, ...rest: unknown[]) => {
        if (key.startsWith(FAILURES_PREFIX)) throw new Error(`${method} down`);
        return real(key, ...rest);
      });
      return { restore: () => mock.mockImplementation(real) };
    }

    it("notice_failure_count_failed: reported, the row is not dead and is attempted again next run", async () => {
      const s = setup();
      const [sub] = rejectedRows(s, 1);
      await s.markSent("received", sub!.id);
      s.failing.add(sub!.id);
      const patch = rejectOnFailureKeys(s, "commit");
      await sweepOpenCalls(s.deps, {});
      expect(reasonsOf(s)).toContain("notice_failure_count_failed");
      expect(s.idempotency.__store.has(openCallNoticeFailuresKey("not-this-time", sub!.id))).toBe(false);

      patch.restore();
      s.reportError.mockClear();
      const next = await sweepOpenCalls(s.deps, {});
      expect(next.reconcile["not-this-time"]).toMatchObject({ skippedDead: 0, attempted: 1 });
      expect(await s.idempotency.get(openCallNoticeFailuresKey("not-this-time", sub!.id))).toEqual({ count: 1 });
    });

    it("notice_failure_count_read_failed: reported, counted as 0, the row is still sent and not skipped", async () => {
      const s = setup();
      const [sub] = rejectedRows(s, 1);
      await s.markSent("received", sub!.id);
      rejectOnFailureKeys(s, "get");
      const result = await sweepOpenCalls(s.deps, {});
      expect(reasonsOf(s)).toContain("notice_failure_count_read_failed");
      expect(result.reconcile["not-this-time"]).toMatchObject({ skippedDead: 0, attempted: 1, sent: 1 });
      expect(sentKinds(s, sub!.id)).toEqual(["not-this-time"]);
    });
  });

  it("a settle-pass failure counts toward the row's dead threshold too", async () => {
    const s = setup();
    const { call } = eventCall(s.world, { startsAt: new Date(s.world.now.getTime() - HOUR) });
    const sub = s.world.addSubmission(call.id, "PENDING", { createdAt: new Date(s.world.now.getTime() - DAY) });
    await s.markSent("received", sub.id);
    s.unsettled.add(sub.id);
    await sweepOpenCalls(s.deps, {});
    expect(await s.idempotency.get(openCallNoticeFailuresKey("not-this-time", sub.id))).toEqual({ count: 1 });
  });
});
