/**
 * lineup-notices.continue-sweep
 *
 * The jobs half of the post-publish lineup sweep continuation: Cloud Tasks
 * POSTs `{ eventId, attempt }`, the handler sweeps the event against the
 * API's ledger (namespace "api" — `ctx.lineupNoticeLedger`), re-queues itself
 * while rows remain and gives up (reported) at the bound.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScheduleNotSentError } from "@th/ports/delayed-jobs";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  LINEUP_SWEEP_CONTINUE_BUDGET_MS,
  LINEUP_SWEEP_CONTINUE_JOB,
  LINEUP_SWEEP_MAX_CONTINUATIONS,
  LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS,
} from "@th/core/use-cases/event-humans/_shared/lineup-sweep-continuation";
import {
  lineupNoticeOwedKey,
  lineupNoticeSentKey,
} from "@th/core/use-cases/event-humans/notify-lineup-notices";

// notify() is the comms use case; its own wiring is tested elsewhere. Here it
// stands in for "the person was told" — but with the shape the real use case
// RESOLVES with: `notifyOutputSchema` is `.strict()` and requires
// variant/category/scope/inApp, so a looser stub would let this suite assert
// something the product cannot emit.
const { notifyMock, notifySent } = vi.hoisted(() => {
  const eventId = "10000000-0000-4000-8000-000000000001";
  const sent = () => ({
    ok: true as const,
    variant: "event.lineup-added",
    // The lineup notice cannot be muted (core comms/lineup-renderers.ts).
    category: "transactional" as const,
    scope: { kind: "EVENT" as const, eventId },
    inApp: {
      status: "persisted" as const,
      notificationId: "0f000000-0000-4000-8000-00000000000b",
      createdAt: new Date("2026-09-30T12:00:00.000Z"),
    },
    email: { status: "sent" as const },
  });
  return {
    notifySent: sent,
    notifyMock: vi.fn(async (_deps: unknown, _input: { humanId: string }) =>
      sent(),
    ),
  };
});
vi.mock("@th/core/use-cases/comms/notify", () => ({ notify: notifyMock }));

const { continueLineupNoticeSweepJob, lineupNoticeJobs } = await import(
  "../jobs/lineup-notices"
);
const { REGISTERED_JOBS } = await import("../jobs/registry.generated");

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const EDITOR = "30000000-0000-4000-8000-000000000003";
const ids = Array.from(
  { length: 10 },
  (_, i) => `d3000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);

function rows() {
  return ids.map((id, i) => ({
    id,
    eventId: EVENT_ID,
    humanId: `e3000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    externalName: null,
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    profileSlug: null,
    humanDisplayName: null,
  }));
}

async function buildCtx(
  options: {
    ledger?: boolean;
    scheduler?: boolean | "throw" | "not_sent" | "hang";
    /**
     * false = the container resolved NO lineup-sweep continuation while the
     * search drain still has a scheduler: the handler must not reach for it.
     */
    lineupContinuation?: boolean;
    owed?: boolean;
    mailer?: boolean;
  } = {},
) {
  const ledger = createFakeIdempotencyPort();
  // Written by the API (namespace "api") when the rows were attached.
  if (options.owed !== false) {
    for (const id of ids) {
      await ledger.commit(lineupNoticeOwedKey(id), { addedByHumanId: EDITOR, via: "attach" });
    }
  }
  const jobsNamespace = createFakeIdempotencyPort();
  const scheduleOnce = vi.fn(async () => {
    if (options.scheduler === "throw") throw new Error("cloud tasks down");
    if (options.scheduler === "not_sent") {
      throw new ScheduleNotSentError("cloud_tasks_access_token_failed");
    }
    if (options.scheduler === "hang") return new Promise<never>(() => {});
    return { status: "scheduled" as const };
  });
  // The search drain's scheduler, a SEPARATE spy that always succeeds: a
  // handler that read `ctx.searchReindexDrain` for the next hop (as it did
  // before the dedicated queue) would pass every test sharing one spy.
  const searchDrainScheduleOnce = vi.fn(async () => ({
    status: "scheduled" as const,
  }));
  // The container hands out `MailerPort | null`; with null the notice's email
  // leg comes back `skipped: "port_unavailable"` and the row would still be
  // committed as SENT for 10 years, so the job refuses instead.
  const mailer = options.mailer === false ? null : { send: vi.fn() };
  const reportError = vi.fn();
  const lineup = rows();
  const ctx = {
    repos: {
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          orgId: ORG_ID,
          humanId: null,
          title: "Friday Night Sessions",
          status: "PUBLISHED",
          visibility: "PUBLIC",
          startsAt: new Date("2026-10-04T22:00:00.000Z"),
          endsAt: new Date("2026-10-05T02:00:00.000Z"),
          timezone: "America/Chicago",
        })),
        listTicketTypes: vi.fn(async () => []),
      },
      eventHumans: {
        getById: vi.fn(async (id: string) => lineup.find((r) => r.id === id) ?? null),
        listByEvent: vi.fn(async () => lineup),
      },
      humans: {
        getById: vi.fn(async (id: string) => ({ id, name: "Sam Rivera" })),
        getByIdWithIdentity: vi.fn(async () => null),
        listAuthAccounts: vi.fn(async () => []),
        // B2: the lineup-added notice goes only to verified accounts.
        listEmailVerifiedIds: vi.fn(async (ids: string[]) => ids),
      },
      organizations: {
        getById: vi.fn(async () => ({ id: ORG_ID, name: "Acme", slug: "acme" })),
        listMembers: vi.fn(async () => ({
          items: [{ humanId: EDITOR, role: "OWNER" }],
          total: 1,
        })),
      },
      entityPages: { getByOwner: vi.fn(async () => null) },
    },
    logger: createTestLogger(),
    clock: { now: () => new Date("2026-09-30T12:00:00.000Z") },
    idempotency: jobsNamespace,
    ...(options.ledger === false ? {} : { lineupNoticeLedger: ledger }),
    rateLimit: null,
    mailer,
    sms: null,
    push: null,
    appBaseUrl: "https://ithasfire.com",
    reportError,
    searchReindexDrain:
      options.scheduler === false
        ? null
        : { scheduler: { scheduleOnce: searchDrainScheduleOnce } },
    // What the composition root resolves for the NEXT hop (the dedicated
    // lineup-sweep queue, or the search drain's scheduler as its fallback —
    // that choice is container.ts's, not the handler's).
    lineupSweepContinuation:
      options.scheduler === false || options.lineupContinuation === false
        ? null
        : { scheduler: { scheduleOnce } },
  };
  return {
    ctx: ctx as any,
    ledger,
    jobsNamespace,
    scheduleOnce,
    searchDrainScheduleOnce,
    reportError,
    mailer,
  };
}

/** Each send moves the sweep's `Date.now()` deadline clock on by `stepMs`. */
function eachSendTakes(stepMs: number) {
  let offset = 0;
  const base = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => base + offset);
  notifyMock.mockImplementation(async () => {
    offset += stepMs;
    return notifySent();
  });
}

function run(ctx: unknown, input: unknown) {
  const parsed = continueLineupNoticeSweepJob.input.parse(input);
  return continueLineupNoticeSweepJob.handler({ input: parsed, ctx: ctx as any });
}

afterEach(() => {
  vi.restoreAllMocks();
  notifyMock.mockReset();
  notifyMock.mockImplementation(async () => notifySent());
});

describe("lineup-notices.continue-sweep", () => {
  it("is the job core schedules, and is registered", () => {
    expect(continueLineupNoticeSweepJob.name).toBe(LINEUP_SWEEP_CONTINUE_JOB);
    expect(lineupNoticeJobs).toContain(continueLineupNoticeSweepJob);
    expect(REGISTERED_JOBS.some((j) => j.name === LINEUP_SWEEP_CONTINUE_JOB)).toBe(true);
  });

  it("runs the sweep against the API's ledger: tells every owed row once, queues nothing", async () => {
    const { ctx, ledger, jobsNamespace, scheduleOnce, reportError } = await buildCtx();
    const out = await run(ctx, { eventId: EVENT_ID, attempt: 1 });

    expect(out).toEqual({
      success: true,
      result: {
        outcome: "complete",
        rowsTotal: 10,
        rowsNotReached: 0,
        rowsFailed: 0,
        rowsHeld: 0,
        rowsOwed: 10,
      },
    });
    expect(notifyMock).toHaveBeenCalledTimes(10);
    // The SENT claims land in the API's namespace, not the jobs one — a later
    // publish (API) must see them.
    for (const id of ids) {
      expect(await ledger.get(lineupNoticeSentKey(id))).not.toBeNull();
      expect(await jobsNamespace.get(lineupNoticeSentKey(id))).toBeNull();
    }
    expect(scheduleOnce).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("re-enqueues itself with attempt + 1 when it runs out of budget, through the lineup continuation, never the search drain", async () => {
    const { ctx, scheduleOnce, searchDrainScheduleOnce } = await buildCtx();
    eachSendTakes(LINEUP_SWEEP_CONTINUE_BUDGET_MS / 3); // 4 sends spend 60s
    const out = await run(ctx, { eventId: EVENT_ID, attempt: 2 });

    expect(out.success).toBe(true);
    expect(out.result).toMatchObject({ outcome: "continued", rowsNotReached: 6 });
    expect(scheduleOnce).toHaveBeenCalledTimes(1);
    expect(scheduleOnce.mock.calls[0]).toEqual([
      expect.objectContaining({
        jobName: LINEUP_SWEEP_CONTINUE_JOB,
        payload: {
          eventId: EVENT_ID,
          attempt: 3,
          owedSeen: true,
          // The four rows it reached, all read as owed.
          owedSample: expect.arrayContaining(ids.slice(0, 4)),
        },
      }),
    ]);
    const [hop] = scheduleOnce.mock.calls[0] as unknown as [
      { payload: { owedSample: string[] } },
    ];
    expect(hop.payload.owedSample).toHaveLength(4);
    expect(searchDrainScheduleOnce).not.toHaveBeenCalled();
  });

  it("with no lineup continuation resolved, does NOT fall back to the search drain itself: it throws for a retry", async () => {
    const { ctx, scheduleOnce, searchDrainScheduleOnce, reportError } =
      await buildCtx({ lineupContinuation: false });
    eachSendTakes(LINEUP_SWEEP_CONTINUE_BUDGET_MS / 3);
    await expect(run(ctx, { eventId: EVENT_ID, attempt: 1 })).rejects.toThrow(
      /could not be queued/,
    );
    expect(scheduleOnce).not.toHaveBeenCalled();
    expect(searchDrainScheduleOnce).not.toHaveBeenCalled();
    const tags = reportError.mock.calls.map((c) => c[1].tags.reason);
    expect(tags).toContain("sweep_budget_exhausted");
  });

  it("THROWS when the next hop was never sent (e.g. no access token), so Cloud Tasks retries this attempt", async () => {
    const { ctx, scheduleOnce, reportError } = await buildCtx({
      scheduler: "not_sent",
    });
    eachSendTakes(LINEUP_SWEEP_CONTINUE_BUDGET_MS / 3);
    await expect(run(ctx, { eventId: EVENT_ID, attempt: 1 })).rejects.toThrow(
      /could not be queued/,
    );
    expect(scheduleOnce).toHaveBeenCalledTimes(1);
    const failed = reportError.mock.calls.find(
      (c) => c[1].tags.reason === "sweep_continuation_schedule_failed",
    );
    expect(failed?.[1].extra.notSent).toBe(true);
    const tags = reportError.mock.calls.map((c) => c[1].tags.reason);
    expect(tags).not.toContain("sweep_continuation_unconfirmed");
  });

  it(`stops at the bound (attempt ${LINEUP_SWEEP_MAX_CONTINUATIONS}) and reports the give-up`, async () => {
    const { ctx, scheduleOnce, reportError } = await buildCtx();
    eachSendTakes(LINEUP_SWEEP_CONTINUE_BUDGET_MS / 3);
    const out = await run(ctx, {
      eventId: EVENT_ID,
      attempt: LINEUP_SWEEP_MAX_CONTINUATIONS,
    });

    expect(out.success).toBe(false);
    expect(out.result).toMatchObject({ outcome: "gave_up", rowsNotReached: 6 });
    expect(scheduleOnce).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "sweep_continuation_gave_up" }),
      }),
    );
  });

  it("THROWS when rows are left and attempt + 1 cannot be queued, so Cloud Tasks retries this attempt", async () => {
    const { ctx, scheduleOnce, reportError } = await buildCtx({ scheduler: "throw" });
    eachSendTakes(LINEUP_SWEEP_CONTINUE_BUDGET_MS / 3);
    await expect(run(ctx, { eventId: EVENT_ID, attempt: 1 })).rejects.toThrow(
      /could not be queued/,
    );
    expect(scheduleOnce).toHaveBeenCalledTimes(1);
    const tags = reportError.mock.calls.map((c) => c[1].tags.reason);
    expect(tags).toEqual(
      expect.arrayContaining(["sweep_continuation_schedule_failed", "sweep_budget_exhausted"]),
    );
  });

  it("reports store drift when linked rows exist but the ledger it reads has no OWED record", async () => {
    const { ctx, reportError } = await buildCtx({ owed: false });
    // `owedSample` = rows the asking sweep (the API, against its own
    // namespace) read as owed; they are still linked, so this run reading
    // them as not owed is the wrong store.
    const out = await run(ctx, {
      eventId: EVENT_ID,
      attempt: 1,
      owedSeen: true,
      owedSample: ids.slice(0, 2),
    });
    expect(out.result).toMatchObject({ outcome: "complete", rowsOwed: 0, rowsTotal: 10 });
    expect(notifyMock).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "sweep_no_owed_records" }),
      }),
    );
  });

  it("does NOT report drift on a lineup the asking sweep saw no owed row on either", async () => {
    // The festival shape: every linked row is a volunteer-signup or
    // booking-minted row, so nothing is owed and nothing is wrong. Probing
    // them is what spent the publish budget.
    const { ctx, reportError } = await buildCtx({ owed: false });
    const out = await run(ctx, { eventId: EVENT_ID, attempt: 1, owedSeen: false });
    expect(out.result).toMatchObject({ outcome: "complete", rowsOwed: 0, rowsTotal: 10 });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("refuses (reported) with no MAILER rather than committing an in-app-only notice for 10 years", async () => {
    const { ctx, reportError } = await buildCtx({ mailer: false });
    // Without a mailer `sendEmail` returns `skipped: "port_unavailable"` —
    // NOT "failed" — so nothing reports it, and the row's SENT record is
    // still committed for 10 years. Refuse loudly instead; Cloud Tasks
    // retries, and the rows stay owed meanwhile.
    //
    // It must THROW, not return `{ success: false }`: app.ts answers 200 for
    // any value a handler returns, so a returned refusal is a hop Cloud Tasks
    // reads as delivered and never retries. app.test.ts asserts the status
    // code that follows from this throw.
    await expect(
      run(ctx, { eventId: EVENT_ID, attempt: 1, owedSeen: true }),
    ).rejects.toThrow(/mailer not configured/);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { job: "lineup-notices.continue-sweep", reason: "no_mailer" },
    });
  });

  it("does NOT throw when the scheduler never answers: the next run may well be queued", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { ctx, reportError } = await buildCtx({ scheduler: "hang" });
      eachSendTakes(LINEUP_SWEEP_CONTINUE_BUDGET_MS / 3);
      const pending = run(ctx, { eventId: EVENT_ID, attempt: 1, owedSeen: true });
      await vi.advanceTimersByTimeAsync(LINEUP_SWEEP_SCHEDULE_TIMEOUT_MS);
      const out = await pending;

      // Throwing here would mean a 500, a DLQ entry and a Cloud Tasks retry
      // that queues a SECOND chain for this attempt — on no evidence that
      // the first one is missing. Reported, not retried.
      expect(out.result).toMatchObject({ outcome: "unconfirmed" });
      expect(out.success).toBe(false);
      const tags = reportError.mock.calls.map((c) => c[1].tags.reason);
      expect(tags).toEqual(
        expect.arrayContaining([
          "sweep_continuation_schedule_timeout",
          "sweep_continuation_unconfirmed",
        ]),
      );
      expect(tags).not.toContain("sweep_budget_exhausted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses (reported) without the API ledger rather than telling nobody and succeeding", async () => {
    const { ctx, reportError } = await buildCtx({ ledger: false });
    // Throws for the same reason as the no-mailer refusal above: a returned
    // `{ success: false }` leaves app.ts answering 200 and the chain dead.
    await expect(run(ctx, { eventId: EVENT_ID, attempt: 1 })).rejects.toThrow(
      /lineupNoticeLedger not wired/,
    );
    expect(notifyMock).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("rejects a payload it did not write", () => {
    expect(() =>
      continueLineupNoticeSweepJob.input.parse({ eventId: EVENT_ID, attempt: 1, x: 1 }),
    ).toThrow();
    expect(() =>
      continueLineupNoticeSweepJob.input.parse({ eventId: EVENT_ID, attempt: 99 }),
    ).toThrow();
    expect(() =>
      continueLineupNoticeSweepJob.input.parse({ eventId: "not-a-uuid", attempt: 1 }),
    ).toThrow();
    expect(() =>
      continueLineupNoticeSweepJob.input.parse({
        eventId: EVENT_ID,
        attempt: 1,
        owedSeen: "yes",
      }),
    ).toThrow();
    // Queued before `owedSeen` existed: still accepted (treated as unknown).
    expect(
      continueLineupNoticeSweepJob.input.parse({ eventId: EVENT_ID, attempt: 1 }),
    ).toEqual({ eventId: EVENT_ID, attempt: 1 });
  });
});
