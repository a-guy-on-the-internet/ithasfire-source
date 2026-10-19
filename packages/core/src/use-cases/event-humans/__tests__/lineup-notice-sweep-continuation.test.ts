import { afterEach, describe, expect, it, vi } from "vitest";

import { ScheduleNotSentError } from "@th/ports/delayed-jobs";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  LINEUP_SWEEP_CONTINUE_BUDGET_MS,
  LINEUP_SWEEP_CONTINUE_JOB,
  LINEUP_SWEEP_MAX_CONTINUATIONS,
  LINEUP_SWEEP_OWED_SAMPLE_MAX,
  LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS,
  lineupSweepContinuationSlot,
} from "../_shared/lineup-sweep-continuation";
import { LINEUP_ADDED_VARIANT } from "../../comms/lineup-renderers";
import {
  notifyOutputSchema,
  type NotifyOutput,
} from "../../comms/notify";
import {
  continueLineupNoticeSweep,
  continueLineupNoticeSweepInputSchema,
} from "../continue-lineup-notice-sweep";
import {
  lineupNoticeOwedKey,
  lineupNoticeRecentKey,
  lineupNoticeSentKey,
  makeLineupNoticeHooks,
  notifyLineupNotices,
  recordLineupNoticeOwed,
  sweepLineupNoticesAfterPublish,
  type NotifyLineupNoticesDeps,
} from "../notify-lineup-notices";

// The publish sweep hands rows it ran out of time for to a delayed
// continuation run (Cloud Tasks → jobs `lineup-notices.continue-sweep`).

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const EDITOR = "30000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-09-30T12:00:00.000Z");

/**
 * What `notify()` actually RESOLVES with for this variant. `notifyOutputSchema`
 * is `.strict()` and requires variant/category/scope/inApp, so a looser stub
 * would let these tests assert a shape the product cannot emit.
 */
function notifySent(overrides: Partial<NotifyOutput> = {}): NotifyOutput {
  return {
    ok: true,
    variant: LINEUP_ADDED_VARIANT,
    // The lineup notice cannot be muted (lineup-renderers.ts).
    category: "transactional",
    scope: { kind: "EVENT", eventId: EVENT_ID },
    inApp: {
      status: "persisted",
      notificationId: "0f000000-0000-4000-8000-00000000000a",
      createdAt: NOW,
    },
    email: { status: "sent" },
    ...overrides,
  };
}

const ids = Array.from(
  { length: 10 },
  (_, i) => `d2000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);
const people = ids.map(
  (_, i) => `e2000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);

function row(id: string, humanId: string) {
  return {
    id,
    eventId: EVENT_ID,
    humanId,
    externalName: null,
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    profileSlug: null,
    humanDisplayName: null,
  };
}

function makeHarness(options: {
  /**
   * `not_sent_late` = fails with ScheduleNotSentError just inside the outer
   * timeout, as the Cloud Tasks adapter does when its token fetch overruns.
   */
  scheduler?:
    | "ok"
    | "duplicate"
    | "throw"
    | "not_sent"
    | "not_sent_late"
    | "hang"
    | "none";
  status?: "DRAFT" | "PUBLISHED";
} = {}) {
  const rows = ids.map((id, i) => row(id, people[i]!));
  const base = createFakeIdempotencyPort();
  // The fake has no `status`; the real adapters do. Track claim state so a
  // lost `begin` can be told apart (held vs already sent), as in production.
  const claims = new Map<string, "in_progress" | "succeeded">();
  const idempotency = {
    ...base,
    begin: async (key: string, ttl?: number, token?: string) => {
      const ok = await base.begin(key, ttl, token);
      if (ok) claims.set(key, "in_progress");
      return ok;
    },
    commit: async (key: string, result: unknown, keep?: number) => {
      await base.commit(key, result, keep);
      claims.set(key, "succeeded");
    },
    release: async (key: string, token: string) => {
      const ok = await base.release(key, token);
      if (ok) claims.delete(key);
      return ok;
    },
    status: async (key: string) => claims.get(key) ?? null,
  } as typeof base;
  const notify = vi.fn(async (_input: any) => notifySent()) as any;
  const reportError = vi.fn();
  const scheduleOnce = vi.fn(async (_input: any) => {
    if (options.scheduler === "throw") throw new Error("cloud tasks down");
    if (options.scheduler === "not_sent") {
      throw new ScheduleNotSentError("cloud_tasks_access_token_failed");
    }
    if (options.scheduler === "not_sent_late") {
      return new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new ScheduleNotSentError("cloud_tasks_access_token_timeout"),
            ),
          LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS - 500,
        ),
      );
    }
    if (options.scheduler === "hang") return new Promise<never>(() => {});
    return {
      status: options.scheduler === "duplicate" ? "duplicate" : "scheduled",
    } as const;
  });
  const repos = {
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        title: "Friday Night Sessions",
        status: options.status ?? "PUBLISHED",
        visibility: "PUBLIC",
        startsAt: new Date("2026-10-04T22:00:00.000Z"),
        endsAt: new Date("2026-10-05T02:00:00.000Z"),
        timezone: "America/Chicago",
      })),
      listTicketTypes: vi.fn(async () => []),
    },
    eventHumans: {
      getById: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
      listByEvent: vi.fn(async () => rows),
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, name: "Sam Rivera" })),
      getByIdWithIdentity: vi.fn(async () => null),
      listAuthAccounts: vi.fn(async () => []),
      listEmailVerifiedIds: vi.fn(async (ids: readonly string[]) => [...ids]),
    },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, name: "Acme", slug: "acme" })),
      listMembers: vi.fn(async () => ({
        items: [{ humanId: EDITOR, role: "OWNER" }],
        total: 1,
      })),
    },
    entityPages: { getByOwner: vi.fn(async () => null) },
  };
  const deps: NotifyLineupNoticesDeps = {
    repos: repos as any,
    idempotency,
    notify,
    mailer: null,
    publicAppUrl: "https://ithasfire.com",
    clock: { now: () => NOW },
    logger: createTestLogger(),
    reportError,
    ...(options.scheduler === "none"
      ? {}
      : { sweepContinuation: { scheduler: { scheduleOnce } } }),
  };
  return { deps, idempotency, notify, reportError, scheduleOnce };
}

async function owe(h: ReturnType<typeof makeHarness>) {
  for (const id of ids) {
    await recordLineupNoticeOwed(h.deps, {
      eventHumanId: id,
      addedByHumanId: EDITOR,
      via: "attach",
    });
  }
}

/**
 * The sweep's deadline reads `Date.now()`. Each send moves the clock on by
 * `stepMs`, so a sweep's first wave (4 sends in flight) spends the budget
 * and the remaining 6 rows are never started — deterministic, no sleeps.
 */
function eachSendTakes(h: ReturnType<typeof makeHarness>, stepMs: number) {
  let offset = 0;
  const base = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => base + offset);
  h.notify.mockImplementation(async () => {
    offset += stepMs;
    return notifySent();
  });
}

const reasons = (h: ReturnType<typeof makeHarness>) =>
  h.reportError.mock.calls.map((c) => c[1].tags.reason);

/** The first queued hop's `owedSample`, sorted (rows are read concurrently). */
const sampleOf = (h: ReturnType<typeof makeHarness>): string[] =>
  [...(h.scheduleOnce.mock.calls[0]![0].payload.owedSample as string[])].sort();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lineup sweep continuation — the publish request's sweep", () => {
  it("an overflow queues ONE continuation run, attempt 1, and is not reported as lost", async () => {
    const h = makeHarness();
    await owe(h);
    eachSendTakes(h, 3_000); // 4 × 3s > the 10s publish budget
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });

    expect(h.notify).toHaveBeenCalledTimes(4);
    expect(h.scheduleOnce).toHaveBeenCalledTimes(1);
    const call = h.scheduleOnce.mock.calls[0]![0];
    expect(call).toMatchObject({
      jobName: LINEUP_SWEEP_CONTINUE_JOB,
      // `owedSeen` is the observation the continuation cannot re-derive: this
      // sweep DID reach owed rows, so a continuation that finds none is real
      // store drift (see continue-lineup-notice-sweep.ts).
      payload: { eventId: EVENT_ID, attempt: 1, owedSeen: true },
    });
    expect(call.runAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 30_000);
    expect(call.dedupeKey).toContain(EVENT_ID);
    // Handed off, not lost: no budget-exhausted report.
    expect(reasons(h)).not.toContain("sweep_budget_exhausted");
  });

  it("an overflow on a lineup with no owed row carries owedSeen: false", async () => {
    const h = makeHarness();
    // No owe(): every row is a volunteer-signup or booking-minted row. The
    // ledger PROBE alone (one `get` per row) spends the 10s publish budget,
    // so the continuation is queued with nothing wrong — and it must carry
    // that, or the continuation reads "no OWED record anywhere" as drift.
    let offset = 0;
    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + offset);
    const get = h.idempotency.get;
    (h.idempotency as any).get = vi.fn(async (key: string) => {
      offset += 4_000;
      return get(key);
    });
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });

    expect(h.notify).not.toHaveBeenCalled();
    expect(h.scheduleOnce).toHaveBeenCalledTimes(1);
    expect(h.scheduleOnce.mock.calls[0]![0].payload).toEqual({
      eventId: EVENT_ID,
      attempt: 1,
      owedSeen: false,
      owedSample: [],
    });
  });

  it("a duplicate (a run for this slot is already queued) counts as handed off", async () => {
    const h = makeHarness({ scheduler: "duplicate" });
    await owe(h);
    eachSendTakes(h, 3_000);
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });
    expect(h.scheduleOnce).toHaveBeenCalledTimes(1);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("no overflow → no continuation", async () => {
    const h = makeHarness();
    await owe(h);
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });
    expect(h.notify).toHaveBeenCalledTimes(10);
    expect(h.scheduleOnce).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("no scheduler wired → the shortfall is reported, as before", async () => {
    const h = makeHarness({ scheduler: "none" });
    await owe(h);
    eachSendTakes(h, 3_000);
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });
    const budget = h.reportError.mock.calls.find(
      (c) => c[1].tags.reason === "sweep_budget_exhausted",
    );
    expect(budget?.[1].extra).toMatchObject({ rowsNotReached: 6, rowsTotal: 10 });
  });

  it("a throwing scheduler is reported (both the failure and the shortfall); the publish step still resolves", async () => {
    const h = makeHarness({ scheduler: "throw" });
    await owe(h);
    eachSendTakes(h, 3_000);
    // Through the real publish wrapper, exactly as publishEvent /
    // publishCommunityListing call it.
    await expect(
      sweepLineupNoticesAfterPublish(
        {
          lineupNotices: makeLineupNoticeHooks(h.deps),
          reportError: h.reportError,
          logger: createTestLogger(),
        },
        EVENT_ID,
        "publishEvent",
      ),
    ).resolves.toBeUndefined();
    expect(h.scheduleOnce).toHaveBeenCalledTimes(1);
    expect(reasons(h)).toEqual(
      expect.arrayContaining([
        "sweep_continuation_schedule_failed",
        "sweep_budget_exhausted",
      ]),
    );
    // The 4 that were sent stay sent; the rest stay owed.
    const sent = await Promise.all(
      ids.map((id) => h.idempotency.get(lineupNoticeSentKey(id))),
    );
    expect(sent.filter(Boolean)).toHaveLength(4);
  });

  it("a throwing scheduler AND a throwing reporter still never escape", async () => {
    const h = makeHarness({ scheduler: "throw" });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    await owe(h);
    eachSendTakes(h, 3_000);
    await expect(
      notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID }),
    ).resolves.toBeUndefined();
  });
});

describe("lineup sweep continuation — the continuation run", () => {
  it("tells the rest, once each, with the larger budget, and does not continue again", async () => {
    const h = makeHarness();
    await owe(h);
    eachSendTakes(h, 3_000);
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });
    expect(h.notify).toHaveBeenCalledTimes(4);
    h.scheduleOnce.mockClear();

    // 6 × 3s = 18s, inside the 60s continuation budget.
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
    });
    expect(result).toEqual({
      outcome: "complete",
      rowsTotal: 10,
      rowsNotReached: 0,
      rowsFailed: 0,
      rowsHeld: 0,
      rowsOwed: 10,
    });
    expect(h.notify).toHaveBeenCalledTimes(10);
    const told = h.notify.mock.calls.map((c: any[]) => c[0].humanId);
    expect(new Set(told).size).toBe(10);
    expect(h.scheduleOnce).not.toHaveBeenCalled();
  });

  it("overflowing again queues attempt + 1", async () => {
    const h = makeHarness();
    await owe(h);
    // 4 × 20s > the 60s continuation budget.
    eachSendTakes(h, LINEUP_SWEEP_CONTINUE_BUDGET_MS / 3);
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 2,
    });
    expect(result.outcome).toBe("continued");
    expect(result.rowsNotReached).toBe(6);
    expect(h.scheduleOnce).toHaveBeenCalledTimes(1);
    expect(h.scheduleOnce.mock.calls[0]![0].payload).toEqual({
      eventId: EVENT_ID,
      attempt: 3,
      owedSeen: true,
      owedSample: expect.any(Array),
    });
    // The four rows it reached, all owed — and only those.
    expect(sampleOf(h)).toEqual(ids.slice(0, 4));
  });

  it(`stops at the bound (${LINEUP_SWEEP_MAX_CONTINUATIONS}): no new run, and the give-up is reported`, async () => {
    const h = makeHarness();
    await owe(h);
    eachSendTakes(h, LINEUP_SWEEP_CONTINUE_BUDGET_MS / 3);
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: LINEUP_SWEEP_MAX_CONTINUATIONS,
    });
    expect(result.outcome).toBe("gave_up");
    expect(h.scheduleOnce).not.toHaveBeenCalled();
    const gaveUp = h.reportError.mock.calls.find(
      (c) => c[1].tags.reason === "sweep_continuation_gave_up",
    );
    expect(gaveUp?.[1].extra).toMatchObject({
      eventId: EVENT_ID,
      rowsNotReached: 6,
      attempt: LINEUP_SWEEP_MAX_CONTINUATIONS,
    });
  });

  it("an event no longer published is skipped (nothing sent, nothing queued)", async () => {
    const h = makeHarness({ status: "DRAFT" });
    await owe(h);
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
    });
    expect(result.outcome).toBe("skipped");
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.scheduleOnce).not.toHaveBeenCalled();
  });

  it("rejects malformed input (attempt out of range, unknown keys)", async () => {
    const h = makeHarness();
    for (const bad of [
      { eventId: EVENT_ID, attempt: 0 },
      { eventId: EVENT_ID, attempt: LINEUP_SWEEP_MAX_CONTINUATIONS + 1 },
      { eventId: EVENT_ID, attempt: 1, extra: true },
      { eventId: EVENT_ID, attempt: 1, owedSeen: "yes" },
      { eventId: "", attempt: 1 },
      { eventId: "not-a-uuid", attempt: 1 },
    ]) {
      expect(continueLineupNoticeSweepInputSchema.safeParse(bad).success).toBe(false);
      await expect(continueLineupNoticeSweep(h.deps, bad)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    // A payload Cloud Tasks queued BEFORE `owedSeen` existed still parses —
    // the schema is `.strict()`, so a required field would have started
    // failing every in-flight task.
    for (const good of [
      { eventId: EVENT_ID, attempt: 1 },
      { eventId: EVENT_ID, attempt: 1, owedSeen: true },
      { eventId: EVENT_ID, attempt: 1, owedSeen: false },
    ]) {
      expect(continueLineupNoticeSweepInputSchema.safeParse(good).success).toBe(true);
    }
  });
});

describe("lineup sweep continuation — failed sends and held claims are retried", () => {
  it("a send that throws once queues a continuation, and the continuation tells that row", async () => {
    const h = makeHarness();
    await owe(h);
    let thrown = false;
    h.notify.mockImplementation(async (input: any) => {
      if (!thrown && input.humanId === people[3]) {
        thrown = true;
        throw new Error("notifications table down");
      }
      return notifySent();
    });
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });

    // Nothing ran out of time; one row failed and its claim was released.
    expect(h.scheduleOnce).toHaveBeenCalledTimes(1);
    expect(h.scheduleOnce.mock.calls[0]![0].payload).toEqual({
      eventId: EVENT_ID,
      attempt: 1,
      owedSeen: true,
      owedSample: expect.any(Array),
    });
    expect(sampleOf(h)).toEqual([...ids].sort());
    expect(await h.idempotency.get(lineupNoticeSentKey(ids[3]!))).toBeNull();
    expect(reasons(h)).toContain("lineup_added_failed");
    expect(reasons(h)).not.toContain("sweep_budget_exhausted");

    h.notify.mockClear();
    h.scheduleOnce.mockClear();
    const result = await continueLineupNoticeSweep(h.deps, { eventId: EVENT_ID, attempt: 1 });
    expect(result).toMatchObject({ outcome: "complete", rowsFailed: 0 });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0].humanId).toBe(people[3]);
    expect(await h.idempotency.get(lineupNoticeSentKey(ids[3]!))).not.toBeNull();
    expect(h.scheduleOnce).not.toHaveBeenCalled();
  });

  it("failures count toward the bound: still failing on the last attempt gives up (reported with rowsFailed)", async () => {
    const h = makeHarness();
    await owe(h);
    h.notify.mockImplementation(async (input: any) => {
      if (input.humanId === people[0]) throw new Error("still down");
      return notifySent();
    });
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: LINEUP_SWEEP_MAX_CONTINUATIONS,
    });
    expect(result).toMatchObject({ outcome: "gave_up", rowsFailed: 1, rowsNotReached: 0 });
    expect(h.scheduleOnce).not.toHaveBeenCalled();
    const gaveUp = h.reportError.mock.calls.find(
      (c) => c[1].tags.reason === "sweep_continuation_gave_up",
    );
    expect(gaveUp?.[0].message).toBe("lineup_sweep_gave_up");
    expect(gaveUp?.[1].extra).toMatchObject({ rowsFailed: 1 });
  });

  it("a SENT claim held by another sender (e.g. a dead instance) is retried after the claim TTL", async () => {
    const h = makeHarness();
    await owe(h);
    // Someone else took row 0's claim and never finished.
    expect(await h.idempotency.begin(lineupNoticeSentKey(ids[0]!), 300, "dead-instance")).toBe(true);
    const result = await continueLineupNoticeSweep(h.deps, { eventId: EVENT_ID, attempt: 1 });

    expect(result).toMatchObject({ outcome: "continued", rowsHeld: 1, rowsFailed: 0 });
    expect(h.notify).toHaveBeenCalledTimes(9);
    const call = h.scheduleOnce.mock.calls[0]![0];
    expect(call.payload).toEqual({
      eventId: EVENT_ID,
      attempt: 2,
      owedSeen: true,
      owedSample: expect.any(Array),
    });
    expect(sampleOf(h)).toEqual([...ids].sort());
    // Past the 300s claim TTL, not the default 30s.
    expect(call.runAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 300_000);
  });

  it("a SENT commit that fails AFTER delivery keeps the claim, and nothing re-sends", async () => {
    const h = makeHarness();
    await owe(h);
    const sentKey = lineupNoticeSentKey(ids[0]!);
    const commit = h.idempotency.commit;
    let sentCommits = 0;
    // A sub-second Redis blip is enough — the client carries a commandTimeout.
    (h.idempotency as any).commit = vi.fn(
      async (key: string, result: unknown, keep?: number) => {
        if (key === sentKey) {
          sentCommits += 1;
          throw new Error("redis command timeout");
        }
        await commit(key, result, keep);
      },
    );

    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });

    // The person WAS told; only the bookkeeping failed — twice: the commit
    // and the best-effort re-settle.
    expect(h.notify).toHaveBeenCalledTimes(10);
    expect(sentCommits).toBe(2);
    expect(reasons(h)).toContain("lineup_added_settle_failed");
    expect(reasons(h)).not.toContain("lineup_added_failed");
    // The claim was NOT released, so no other sender can take the row…
    expect(await h.idempotency.begin(sentKey, 300, "another-sender")).toBe(
      false,
    );
    // …the row is not counted as left, so the publish sweep finishes…
    expect(h.scheduleOnce).not.toHaveBeenCalled();
    // …and the 7-day RECENT record is written at DELIVERY, so even once the
    // claim lapses a later sweep suppresses the re-send instead of sending.
    expect(
      await h.idempotency.get(lineupNoticeRecentKey(EVENT_ID, people[0]!)),
    ).not.toBeNull();

    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
    });
    expect(result).toMatchObject({ rowsHeld: 1, rowsFailed: 0 });
    const told = h.notify.mock.calls.filter(
      (c: any[]) => c[0].humanId === people[0],
    );
    expect(told).toHaveLength(1);
  });

  it("a claim probe that throws leaves the row HELD and reported, never counted as a failed send", async () => {
    const h = makeHarness();
    await owe(h);
    // Someone else holds row 0's claim, so the probe runs for that row.
    await h.idempotency.begin(lineupNoticeSentKey(ids[0]!), 300, "dead-instance");
    (h.idempotency as any).status = vi.fn(async () => {
      throw new Error("redis command timeout");
    });

    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
      owedSeen: true,
    });

    // The probe is a CLASSIFICATION hint, not work: its failure must not
    // escape into the sweep's per-row catch and brand the row as a failed
    // send (which would schedule a continuation for a row that may already
    // be told, and at the 30s delay rather than past the claim's TTL).
    expect(result).toMatchObject({ outcome: "continued", rowsHeld: 1, rowsFailed: 0 });
    expect(reasons(h)).toContain("claim_probe_failed");
    expect(reasons(h)).not.toContain("sweep_row_failed");
    expect(
      h.scheduleOnce.mock.calls[0]![0].runAt.getTime(),
    ).toBeGreaterThanOrEqual(NOW.getTime() + 300_000);
  });

  it("a claim release that fails is REPORTED, not only logged", async () => {
    const h = makeHarness();
    await owe(h);
    h.notify.mockImplementation(async (input: any) => {
      if (input.humanId === people[0]) throw new Error("notifications table down");
      return notifySent();
    });
    (h.idempotency as any).release = vi.fn(async () => {
      throw new Error("redis command timeout");
    });

    await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
      owedSeen: true,
    });

    // This file now runs inside apps/jobs, which has NO pino → Sentry
    // integration: a bare logger.error there is dark, so the swallow needs
    // the explicit report (CLAUDE.md's Error Reporting Convention).
    expect(reasons(h)).toContain("release_failed");
    expect(reasons(h)).toContain("lineup_added_failed");
  });

  it("a row already SENT is skipped, not held: no continuation", async () => {
    const h = makeHarness();
    await owe(h);
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });
    h.scheduleOnce.mockClear();
    const result = await continueLineupNoticeSweep(h.deps, { eventId: EVENT_ID, attempt: 1 });
    expect(result).toMatchObject({ outcome: "complete", rowsHeld: 0 });
    expect(h.scheduleOnce).not.toHaveBeenCalled();
  });
});

describe("lineup sweep continuation — guards", () => {
  it("sits above the Cloud Tasks adapter's whole budget (token 1.5s + request 3s), so the adapter's own answer wins the race", () => {
    // At 3s here the timer raced the create's abort, and a create that landed
    // server-side at ~2.9s could be read as "failed". An unbounded token
    // fetch then let the timer win over a hop never sent. The adapter's
    // defaults are pinned against this constant in
    // packages/adapters/src/queue/__tests__/cloud-tasks-scheduler.test.ts.
    expect(LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS).toBeGreaterThan(1_500 + 3_000);
  });

  it("a scheduler that never answers is UNCONFIRMED, not abandoned: reported, and the publish step still resolves", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = makeHarness({ scheduler: "hang" });
      await owe(h);
      eachSendTakes(h, 3_000);
      let settled = false;
      const done = sweepLineupNoticesAfterPublish(
        {
          lineupNotices: makeLineupNoticeHooks(h.deps),
          reportError: h.reportError,
          logger: createTestLogger(),
        },
        EVENT_ID,
        "publishEvent",
      ).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(settled).toBe(true);
      expect(h.scheduleOnce).toHaveBeenCalledTimes(1);
      // A timeout is told apart from a refusal: the task may well exist, so
      // neither report may claim the rows were abandoned.
      expect(reasons(h)).toEqual(
        expect.arrayContaining([
          "sweep_continuation_schedule_timeout",
          "sweep_continuation_unconfirmed",
        ]),
      );
      expect(reasons(h)).not.toContain("sweep_continuation_schedule_failed");
      expect(reasons(h)).not.toContain("sweep_budget_exhausted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a scheduler that never answers leaves the sweep `unconfirmed`, not `unfinished`", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = makeHarness({ scheduler: "hang" });
      await owe(h);
      // Someone else holds row 0's claim, so a row is left without any clock
      // games; the scheduler then hangs on the continuation request.
      await h.idempotency.begin(
        lineupNoticeSentKey(ids[0]!),
        300,
        "dead-instance",
      );
      const pending = continueLineupNoticeSweep(h.deps, {
        eventId: EVENT_ID,
        attempt: 1,
        owedSeen: true,
      });
      await vi.advanceTimersByTimeAsync(LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS);
      const result = await pending;
      // `unfinished` is what the jobs handler THROWS on (→ 500, DLQ, a
      // second chain from the Cloud Tasks retry). A timeout must not.
      expect(result.outcome).toBe("unconfirmed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a scheduler that fails BEFORE sending is `failed`, not unconfirmed: the publish sweep reports the rows as abandoned, flagged notSent: true", async () => {
    const h = makeHarness({ scheduler: "not_sent" });
    await owe(h);
    eachSendTakes(h, 3_000);
    await sweepLineupNoticesAfterPublish(
      {
        lineupNotices: makeLineupNoticeHooks(h.deps),
        reportError: h.reportError,
        logger: createTestLogger(),
      },
      EVENT_ID,
      "publishEvent",
    );
    expect(reasons(h)).toEqual(
      expect.arrayContaining([
        "sweep_continuation_schedule_failed",
        "sweep_budget_exhausted",
      ]),
    );
    expect(reasons(h)).not.toContain("sweep_continuation_schedule_timeout");
    expect(reasons(h)).not.toContain("sweep_continuation_unconfirmed");
    const failure = h.reportError.mock.calls.find(
      (c) => c[1].tags.reason === "sweep_continuation_schedule_failed",
    );
    // The report says the task certainly does not exist.
    expect(failure?.[1].extra.notSent).toBe(true);
  });

  it("any other scheduler failure is reported notSent: false (not KNOWN to be unsent)", async () => {
    const h = makeHarness({ scheduler: "throw" });
    await owe(h);
    eachSendTakes(h, 3_000);
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });
    const failure = h.reportError.mock.calls.find(
      (c) => c[1].tags.reason === "sweep_continuation_schedule_failed",
    );
    expect(failure?.[1].extra.notSent).toBe(false);
  });

  // Not a regression guard for the token budget (that is the adapter -> core
  // test in packages/adapters/src/queue/__tests__/cloud-tasks-scheduler.test.ts):
  // it pins how a continuation run maps a not-sent hop onto its outcome.
  it("a continuation run whose next hop was not sent ends `unfinished` (the jobs handler's retry path)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = makeHarness({ scheduler: "not_sent_late" });
      await owe(h);
      await h.idempotency.begin(
        lineupNoticeSentKey(ids[0]!),
        300,
        "dead-instance",
      );
      const pending = continueLineupNoticeSweep(h.deps, {
        eventId: EVENT_ID,
        attempt: 1,
        owedSeen: true,
      });
      await vi.advanceTimersByTimeAsync(LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS);
      const result = await pending;
      expect(result.outcome).toBe("unfinished");
      expect(reasons(h)).toContain("sweep_continuation_schedule_failed");
      expect(reasons(h)).not.toContain("sweep_continuation_unconfirmed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a continuation that finds no OWED record where the asking sweep saw some reports store drift", async () => {
    const h = makeHarness();
    // No owe(): the ledger THIS run reads has nothing, while the sweep that
    // queued it read these (still linked) rows as owed — the wrong
    // namespace/backend.
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
      owedSeen: true,
      owedSample: ids.slice(0, 3),
    });
    expect(result).toMatchObject({ outcome: "complete", rowsOwed: 0, rowsTotal: 10 });
    const drift = h.reportError.mock.calls.find(
      (c) => c[1].tags.reason === "sweep_no_owed_records",
    );
    expect(drift?.[0].message).toBe("lineup_sweep_no_owed_records");
    expect(drift?.[1].extra).toMatchObject({
      eventId: EVENT_ID,
      attempt: 1,
      rowsTotal: 10,
      sampledRowsNotOwed: 3,
    });
  });

  it("every owed row removed from the lineup before the hop is not drift", async () => {
    // The false alarm this guards: the asking sweep read rows X/Y as owed;
    // both people were removed (or left) before this run, so only the ten
    // volunteer/booking-minted rows — never OWED — are left. This run
    // reaches all of them and reads none as owed, which with `owedSeen`
    // alone looked exactly like a different store.
    const h = makeHarness();
    const removed = [
      "d3000000-0000-4000-8000-000000000001",
      "d3000000-0000-4000-8000-000000000002",
    ];
    // Their OWED records are still in the ledger (nothing deletes OWED);
    // their rows are gone (detach is a hard delete).
    for (const id of removed) {
      await recordLineupNoticeOwed(h.deps, {
        eventHumanId: id,
        addedByHumanId: EDITOR,
        via: "attach",
      });
    }
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
      owedSeen: true,
      owedSample: removed,
    });
    // The exact shape the old detector alarmed on…
    expect(result).toMatchObject({
      outcome: "complete",
      rowsOwed: 0,
      rowsNotReached: 0,
      rowsTotal: 10,
    });
    // …and now quiet.
    expect(reasons(h)).not.toContain("sweep_no_owed_records");
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("one sampled owed row still linked and read as not owed is enough to report, even if the rest were removed", async () => {
    const h = makeHarness();
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 2,
      owedSeen: true,
      owedSample: [
        "d3000000-0000-4000-8000-000000000001", // removed meanwhile
        ids[7]!, // still on the lineup; this store has no OWED for it
      ],
    });
    expect(result).toMatchObject({ outcome: "complete", rowsOwed: 0 });
    const drift = h.reportError.mock.calls.find(
      (c) => c[1].tags.reason === "sweep_no_owed_records",
    );
    expect(drift?.[1].extra).toMatchObject({ attempt: 2, sampledRowsNotOwed: 1 });
  });

  it("a payload written before `owedSample` existed (owedSeen: true, no sample) stays quiet", async () => {
    // Queued by the previous build: it cannot say WHICH rows were owed, so
    // it cannot tell drift from removed rows. Unknown = quiet.
    const h = makeHarness();
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
      owedSeen: true,
    });
    expect(result).toMatchObject({ outcome: "complete", rowsOwed: 0, rowsNotReached: 0 });
    expect(reasons(h)).not.toContain("sweep_no_owed_records");
  });

  it(`the queuing sweep carries at most ${LINEUP_SWEEP_OWED_SAMPLE_MAX} owed row ids, all of them rows it read as owed`, async () => {
    const h = makeHarness();
    const big = Array.from(
      { length: LINEUP_SWEEP_OWED_SAMPLE_MAX + 5 },
      (_, i) => `d4000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const volunteer = "d5000000-0000-4000-8000-000000000000"; // never owed
    const bigRows = [
      ...big.map((id, i) =>
        row(id, `e4000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
      ),
      row(volunteer, "e5000000-0000-4000-8000-000000000000"),
    ];
    (h.deps.repos.eventHumans.listByEvent as any).mockResolvedValue(bigRows);
    for (const id of big) {
      await recordLineupNoticeOwed(h.deps, {
        eventHumanId: id,
        addedByHumanId: EDITOR,
        via: "attach",
      });
    }
    // One failed send leaves a row to retry, so a continuation is queued.
    let thrown = false;
    h.notify.mockImplementation(async () => {
      if (!thrown) {
        thrown = true;
        throw new Error("notifications table down");
      }
      return notifySent();
    });
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });

    expect(h.scheduleOnce).toHaveBeenCalledTimes(1);
    const payload = h.scheduleOnce.mock.calls[0]![0].payload;
    expect(payload.owedSeen).toBe(true);
    expect(payload.owedSample).toHaveLength(LINEUP_SWEEP_OWED_SAMPLE_MAX);
    expect(new Set(payload.owedSample).size).toBe(LINEUP_SWEEP_OWED_SAMPLE_MAX);
    for (const id of payload.owedSample) expect(big).toContain(id);
    expect(payload.owedSample).not.toContain(volunteer);
    // What it writes, the hop accepts (the schema is `.strict()` + `.max()`).
    expect(continueLineupNoticeSweepInputSchema.safeParse(payload).success).toBe(true);
  });

  it(`the hop's schema bounds the sample (≤ ${LINEUP_SWEEP_OWED_SAMPLE_MAX} uuids)`, () => {
    const many = Array.from(
      { length: LINEUP_SWEEP_OWED_SAMPLE_MAX + 1 },
      (_, i) => `d4000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const parse = (owedSample: unknown) =>
      continueLineupNoticeSweepInputSchema.safeParse({
        eventId: EVENT_ID,
        attempt: 1,
        owedSeen: true,
        owedSample,
      }).success;
    expect(parse(many.slice(0, LINEUP_SWEEP_OWED_SAMPLE_MAX))).toBe(true);
    expect(parse([])).toBe(true);
    expect(parse(many)).toBe(false);
    expect(parse(["not-a-uuid"])).toBe(false);
    expect(parse("d4000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("a lineup with NO owed row anywhere is not drift: the asking sweep saw none either", async () => {
    // The festival shape: 10 linked rows, all volunteer-signup or
    // booking-minted (no OWED record). Probing them spends the publish
    // budget, a continuation is queued, and that run reaches every row and
    // finds nothing owed — the exact false alarm the old derived guard
    // raised on every publish of such an event.
    const h = makeHarness();
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
      owedSeen: false,
    });
    expect(result).toMatchObject({ outcome: "complete", rowsOwed: 0, rowsTotal: 10 });
    expect(reasons(h)).not.toContain("sweep_no_owed_records");
  });

  it("a payload written before `owedSeen` existed (no field) stays quiet", async () => {
    // Already queued in Cloud Tasks when this shipped: unknown, not drift.
    const h = makeHarness();
    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
    });
    expect(result).toMatchObject({ outcome: "complete", rowsOwed: 0 });
    expect(reasons(h)).not.toContain("sweep_no_owed_records");
  });

  it("does not report drift when OWED records are found, or on the publish request's own sweep", async () => {
    // Pins the `rowsOwed === 0` guard: the sampled row ids[0] IS reached and
    // reads as not owed (sampledRowsNotOwed = 1, every row reached), so the
    // only thing keeping this quiet is that rows 1-9 DO carry OWED here —
    // this run reads the right store.
    const owedHarness = makeHarness();
    for (const id of ids.slice(1)) {
      await recordLineupNoticeOwed(owedHarness.deps, {
        eventHumanId: id,
        addedByHumanId: EDITOR,
        via: "attach",
      });
    }
    const owedResult = await continueLineupNoticeSweep(owedHarness.deps, {
      eventId: EVENT_ID,
      attempt: 1,
      owedSeen: true,
      owedSample: [ids[0]!],
    });
    expect(owedResult).toMatchObject({ rowsNotReached: 0, rowsOwed: 9 });
    expect(reasons(owedHarness)).not.toContain("sweep_no_owed_records");

    // A publish of a lineup nobody is owed for is normal.
    const legacy = makeHarness();
    await notifyLineupNotices(legacy.deps, { kind: "published", eventId: EVENT_ID });
    expect(legacy.reportError).not.toHaveBeenCalled();
  });

  it("does not report drift when the budget ran out before any owed row", async () => {
    const h = makeHarness();
    // Only the LAST row is owed. The rows ahead of it are legacy/volunteer
    // rows with no OWED record, and merely probing them spends the budget —
    // the exact overflow this job exists for, which must not look like a
    // store-drift alarm next to a healthy `continued`.
    await recordLineupNoticeOwed(h.deps, {
      eventHumanId: ids[9]!,
      addedByHumanId: EDITOR,
      via: "attach",
    });
    let offset = 0;
    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + offset);
    const get = h.idempotency.get;
    (h.idempotency as any).get = vi.fn(async (key: string) => {
      offset += LINEUP_SWEEP_CONTINUE_BUDGET_MS / 3;
      return get(key);
    });

    const result = await continueLineupNoticeSweep(h.deps, {
      eventId: EVENT_ID,
      attempt: 1,
      // Pins the `rowsNotReached === 0` guard: ids[0] is sampled, reached
      // (asserted below) and has no OWED in this ledger, and rowsOwed is 0,
      // so every other condition holds — only "this run stopped early"
      // keeps it quiet.
      owedSeen: true,
      owedSample: [ids[0]!],
    });
    expect(h.idempotency.get).toHaveBeenCalledWith(lineupNoticeOwedKey(ids[0]!));
    expect(result.outcome).toBe("continued");
    expect(result.rowsOwed).toBe(0);
    // Rows were reached AND rows were left: the shape the old guard alarmed on.
    expect(result.rowsNotReached).toBeGreaterThan(0);
    expect(result.rowsTotal - result.rowsNotReached).toBeGreaterThan(0);
    expect(reasons(h)).not.toContain("sweep_no_owed_records");
  });

  it("the notify stub emits a shape the product can actually produce", () => {
    expect(notifyOutputSchema.safeParse(notifySent()).success).toBe(true);
    expect(
      notifyOutputSchema.safeParse(
        notifySent({ email: { status: "failed", reason: "port_error" } }),
      ).success,
    ).toBe(true);
  });

  it("report messages are stable (counts live in extra)", async () => {
    const h = makeHarness({ scheduler: "none" });
    await owe(h);
    eachSendTakes(h, 3_000);
    await notifyLineupNotices(h.deps, { kind: "published", eventId: EVENT_ID });
    const budget = h.reportError.mock.calls.find(
      (c) => c[1].tags.reason === "sweep_budget_exhausted",
    );
    expect(budget?.[0].message).toBe("lineup_sweep_budget_exhausted");
  });
});

describe("lineupSweepContinuationSlot", () => {
  it("is per event and attempt, and stable inside a slot", () => {
    // NOW is slot-aligned; +1ms and +10s land in the same (next) slot.
    const a = lineupSweepContinuationSlot(new Date(NOW.getTime() + 1), EVENT_ID, 1, 30_000);
    const b = lineupSweepContinuationSlot(new Date(NOW.getTime() + 10_000), EVENT_ID, 1, 30_000);
    const c = lineupSweepContinuationSlot(new Date(NOW.getTime() + 1), EVENT_ID, 2, 30_000);
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(c.dedupeKey).not.toBe(a.dedupeKey);
    expect(a.runAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 30_000);
  });
});
