import { describe, expect, it, vi } from "vitest";

import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";

import {
  resolveUnscannableImage,
  type ResolveUnscannableImageDeps,
} from "../resolve-unscannable-image";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const RECORD_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-09-12T12:00:00.000Z");

/** The `degradedExhausted` shape: burned the requeue cap, unscannable. */
function makeRecord(
  overrides: Partial<ImageModerationRecord> = {},
): ImageModerationRecord {
  return {
    id: RECORD_ID,
    storageKey: "events/event-1/hero.jpg",
    kind: "EVENT_HERO",
    status: "FLAGGED",
    subjectType: "EVENT",
    subjectId: "event-1",
    publicUrl: "https://cdn.example/hero.jpg",
    contentType: "image/jpeg",
    createdByHumanId: "uploader-1",
    maxSeverity: null,
    categories: null,
    provider: null,
    degraded: true,
    moderatedAt: new Date("2026-09-09T00:00:00.000Z"),
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    attempts: 22,
    lastError: "azure 401",
    nextAttemptAt: new Date("2026-09-09T00:00:00.000Z"),
    requeues: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeLogger() {
  const logger: any = {
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_n: string, f: () => Promise<unknown>) => f()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

/**
 * A resolve fake that ENFORCES THE REAL WHERE.
 *
 * Deliberately not `vi.fn(async () => 1)`. The eligibility rule lives in SQL,
 * and a test whose fake says "yes" to everything would pass just as happily
 * against a repo that had dropped the `degraded` clause — i.e. it would assert
 * nothing about the one property this action must never lose. This mirrors the
 * four clauses so the use-case tests exercise the same refusal the database
 * would perform. The adapter's integration test pins the real SQL.
 */
function fakeResolve(record: ImageModerationRecord | null) {
  return vi.fn(async (input: { id: string; maxRequeues: number }) => {
    if (!record) return 0;
    const eligible =
      record.id === input.id &&
      record.status === "FLAGGED" &&
      record.degraded === true &&
      record.reviewedAt === null &&
      record.requeues >= input.maxRequeues;
    return eligible ? 1 : 0;
  });
}

function makeDeps(args: {
  record: ImageModerationRecord | null;
  rereadRecord?: ImageModerationRecord | null;
  /** Override the CAS entirely (for the lost-race case). */
  resolveResult?: number;
}) {
  let getByIdCalls = 0;
  const getById = vi.fn(async () => {
    getByIdCalls += 1;
    if (getByIdCalls === 1) return args.record;
    return "rereadRecord" in args ? args.rereadRecord : args.record;
  });
  const resolveUnscannable =
    args.resolveResult === undefined
      ? fakeResolve(args.record)
      : vi.fn(async () => args.resolveResult!);
  const auditLog = vi.fn(async () => {});

  const txRepos: any = {
    imageModerationRecords: { getById, resolveUnscannable },
    audit: { log: auditLog },
  };
  const repos: any = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(txRepos)),
  };

  const logger = makeLogger();
  const deps: ResolveUnscannableImageDeps = {
    repos,
    clock: { now: () => NOW },
    logger,
  };
  return { deps, getById, resolveUnscannable, auditLog, logger };
}

const call = (deps: ResolveUnscannableImageDeps, maxRequeues = 3) =>
  resolveUnscannableImage(deps, {
    actorHumanId: ACTOR,
    recordId: RECORD_ID,
    maxRequeues,
  });

describe("resolveUnscannableImage — what it must never touch", () => {
  // THE constraint. A `degraded: false` FLAGGED row is an image the provider
  // actually scored at or above threshold, waiting on a moderator. If this path
  // could resolve it, an ops button would be a backdoor around a moderation
  // decision — the judgement would simply disappear, terminally, with an audit
  // row that says "unscannable".
  it("REFUSES a genuine CONTENT hold (degraded:false), even with requeues over the cap", async () => {
    const { deps, auditLog } = makeDeps({
      record: makeRecord({ degraded: false, requeues: 99 }),
    });

    const out = await call(deps);

    expect(out).toEqual({
      resolved: false,
      status: "FLAGGED",
      reason: "not_eligible",
    });
    // Nothing was recorded, because nothing happened.
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("REFUSES a row still inside the requeue budget", async () => {
    // Automation has not given up on this one yet; the hourly requeue will
    // take another swing. It is not an operator's problem.
    const { deps } = makeDeps({ record: makeRecord({ requeues: 1 }) });

    const out = await call(deps, 3);

    expect(out.resolved).toBe(false);
    expect(out.reason).toBe("not_eligible");
  });

  it("REFUSES an already-reviewed row — the second click is a no-op", async () => {
    const { deps, auditLog } = makeDeps({
      record: makeRecord({
        status: "ORPHANED",
        reviewedByHumanId: ACTOR,
        reviewedAt: NOW,
      }),
    });

    const out = await call(deps);

    expect(out).toEqual({
      resolved: false,
      status: "ORPHANED",
      reason: "not_eligible",
    });
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("REFUSES an APPROVED or REJECTED terminal row", async () => {
    for (const status of ["APPROVED", "REJECTED"] as const) {
      const { deps } = makeDeps({
        record: makeRecord({ status, degraded: false, reviewedAt: NOW }),
      });
      const out = await call(deps);
      expect(out.resolved).toBe(false);
      expect(out.status).toBe(status);
    }
  });
});

describe("resolveUnscannableImage", () => {
  it("resolves an unscannable row to ORPHANED, not REJECTED", async () => {
    // REJECTED would enqueue an R2 deletion for an object we were never able
    // to FETCH, and fire the uploader's "your image was removed" notice for a
    // machine-side failure that says nothing about their image.
    const { deps, resolveUnscannable } = makeDeps({ record: makeRecord() });

    const out = await call(deps);

    expect(out).toEqual({
      resolved: true,
      status: "ORPHANED",
      reason: "resolved",
    });
    expect(resolveUnscannable).toHaveBeenCalledWith({
      id: RECORD_ID,
      maxRequeues: 3,
      resolvedByHumanId: ACTOR,
      resolvedAt: NOW,
      note: undefined,
    });
  });

  it("enforces eligibility against the cap the OPERATOR was shown", async () => {
    // `maxRequeues` is echoed from `snapshot.thresholds`, not defaulted. A repo
    // using its own number would refuse rows the operator can plainly see in
    // the list — an "it does nothing" bug with no error to read.
    const { deps, resolveUnscannable } = makeDeps({
      record: makeRecord({ requeues: 5 }),
    });

    await call(deps, 5);

    expect(resolveUnscannable).toHaveBeenCalledWith(
      expect.objectContaining({ maxRequeues: 5 }),
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["below the automation's cap", 1],
    ["one under the cap", 2],
  ])("REFUSES maxRequeues that is %s", async (_label, maxRequeues) => {
    // `.positive()` alone would accept 1 and 2, and the port promises this only
    // touches rows that have "genuinely exhausted the automation". With the
    // requeue job capped at 3, a caller passing 1 terminally resolves a
    // degraded row still TWO automated retries from being anyone's problem —
    // and during a provider outage, one that would very likely have recovered
    // on its own. It would then be hidden forever behind an audit row claiming
    // an operator judged it unscannable.
    const { deps, resolveUnscannable } = makeDeps({
      record: makeRecord({ requeues: 99 }),
    });

    await expect(
      resolveUnscannableImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        maxRequeues,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    // Rejected at the BOUNDARY — never clamped and quietly executed as a
    // different, terminal action than the one asked for.
    expect(resolveUnscannable).not.toHaveBeenCalled();
  });

  it("ACCEPTS the automation's cap and anything stricter", async () => {
    // The floor is a floor, not an equality. A caller may select more
    // conservatively than the requeue job; it may not select more loosely.
    for (const maxRequeues of [3, 4, 10]) {
      const { deps, resolveUnscannable } = makeDeps({
        record: makeRecord({ requeues: 99 }),
      });

      await expect(
        resolveUnscannableImage(deps, {
          actorHumanId: ACTOR,
          recordId: RECORD_ID,
          maxRequeues,
        }),
      ).resolves.toMatchObject({ resolved: true });
      expect(resolveUnscannable).toHaveBeenCalledWith(
        expect.objectContaining({ maxRequeues }),
      );
    }
  });

  it("records the operator and the eligibility evidence in the audit row", async () => {
    const { deps, auditLog } = makeDeps({ record: makeRecord() });

    await call(deps);

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "image_moderation_record",
        entityId: RECORD_ID,
        action: "image_moderation.resolved_unscannable",
        at: NOW,
        data: expect.objectContaining({
          actorHumanId: ACTOR,
          fromStatus: "FLAGGED",
          toStatus: "ORPHANED",
          degraded: true,
          requeues: 3,
          maxRequeues: 3,
          lastError: "azure 401",
          storageKey: "events/event-1/hero.jpg",
        }),
      }),
    );
  });

  it("sanitizes and forwards the operator note", async () => {
    const { deps, resolveUnscannable } = makeDeps({ record: makeRecord() });

    await resolveUnscannableImage(deps, {
      actorHumanId: ACTOR,
      recordId: RECORD_ID,
      maxRequeues: 3,
      note: "  event was deleted in July  ",
    });

    expect(resolveUnscannable).toHaveBeenCalledWith(
      expect.objectContaining({ note: "event was deleted in July" }),
    );
  });

  it("reports the row's REAL status when the CAS is lost mid-flight", async () => {
    const { deps, auditLog } = makeDeps({
      record: makeRecord(),
      rereadRecord: makeRecord({ status: "APPROVED", reviewedAt: NOW }),
      resolveResult: 0,
    });

    const out = await call(deps);

    expect(out).toEqual({
      resolved: false,
      status: "APPROVED",
      reason: "not_eligible",
    });
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for a record that does not exist", async () => {
    const { deps } = makeDeps({ record: null });

    await expect(call(deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects unknown input keys", async () => {
    const { deps } = makeDeps({ record: makeRecord() });

    await expect(
      resolveUnscannableImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        maxRequeues: 3,
        status: "REJECTED",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
