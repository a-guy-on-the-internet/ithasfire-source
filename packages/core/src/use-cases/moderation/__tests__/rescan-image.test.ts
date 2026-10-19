import { describe, expect, it, vi } from "vitest";

import type {
  ImageModerationRecord,
  ImageModerationStatus,
} from "@th/ports/repos/image-moderation-records";

import { rescanImage, type RescanImageDeps } from "../rescan-image";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const RECORD_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-09-12T12:00:00.000Z");

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
    moderatedAt: new Date("2026-09-11T00:00:00.000Z"),
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    attempts: 22,
    lastError: "azure 401",
    nextAttemptAt: new Date("2026-09-11T00:00:00.000Z"),
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

function makeDeps(args: {
  record: ImageModerationRecord | null;
  /** Second `getById` (the lost-race re-read). Defaults to `record`. */
  rereadRecord?: ImageModerationRecord | null;
  /** Rows the CAS claims to have moved. Defaults to 1. */
  requeueResult?: number;
}) {
  let getByIdCalls = 0;
  const getById = vi.fn(async () => {
    getByIdCalls += 1;
    if (getByIdCalls === 1) return args.record;
    return "rereadRecord" in args ? args.rereadRecord : args.record;
  });
  const requeueForRescan = vi.fn(async () => args.requeueResult ?? 1);
  const auditLog = vi.fn(async () => {});

  const txRepos: any = {
    imageModerationRecords: { getById, requeueForRescan },
    audit: { log: auditLog },
  };
  // Spread, not `{ tx } as Repos`: a fake whose only surface is inside the
  // transaction makes any post-commit `deps.repos.<x>` read silently undefined,
  // and this repo has been bitten by that four times in one week.
  const repos: any = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(txRepos)),
  };

  const logger = makeLogger();
  const deps: RescanImageDeps = { repos, clock: { now: () => NOW }, logger };
  return { deps, getById, requeueForRescan, auditLog, logger };
}

const call = (deps: RescanImageDeps) =>
  rescanImage(deps, { actorHumanId: ACTOR, recordId: RECORD_ID });

describe("rescanImage — the human-decision guard", () => {
  // THE test this whole action exists around. `create()` (the underlying
  // mechanism) resets ANY row, so a naive re-scan of a REJECTED record revives
  // a moderator's decision — and a clean re-score lands on APPROVED, which
  // read-time gating passes. That is an ops button putting rejected content
  // back into circulation.
  it("REFUSES a REJECTED record — re-scanning it could put the image back live", async () => {
    const { deps, requeueForRescan, auditLog } = makeDeps({
      record: makeRecord({
        status: "REJECTED",
        degraded: false,
        reviewedByHumanId: "moderator-1",
        reviewedAt: new Date("2026-09-11T09:00:00.000Z"),
      }),
    });

    const out = await call(deps);

    expect(out).toEqual({
      requeued: false,
      status: "REJECTED",
      reason: "human_decided",
    });
    // Not "it returned the right shape" — it never reached the write at all.
    expect(requeueForRescan).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("REFUSES an APPROVED record", async () => {
    const { deps, requeueForRescan } = makeDeps({
      record: makeRecord({
        status: "APPROVED",
        degraded: false,
        reviewedByHumanId: "moderator-1",
        reviewedAt: new Date("2026-09-11T09:00:00.000Z"),
      }),
    });

    const out = await call(deps);

    expect(out.requeued).toBe(false);
    expect(out.reason).toBe("human_decided");
    expect(requeueForRescan).not.toHaveBeenCalled();
  });

  it("REFUSES a FLAGGED CONTENT hold — degraded:false is a verdict, not a failure", async () => {
    // The subtle one. FLAGGED alone is not enough to refuse or to allow: a
    // degraded FLAGGED row is a scanner failure (rescannable) and a
    // non-degraded one is an image the provider actually scored at or above
    // threshold, waiting on a moderator. Re-scanning the latter clears the
    // verdict out from under the review queue.
    const { deps, requeueForRescan } = makeDeps({
      record: makeRecord({ status: "FLAGGED", degraded: false }),
    });

    const out = await call(deps);

    expect(out).toEqual({
      requeued: false,
      status: "FLAGGED",
      reason: "human_decided",
    });
    expect(requeueForRescan).not.toHaveBeenCalled();
  });

  it.each<[ImageModerationStatus, boolean]>([
    ["PENDING", false],
    ["ORPHANED", false],
    ["FLAGGED", true],
  ])("ALLOWS the machine state %s (degraded=%s)", async (status, degraded) => {
    const { deps, requeueForRescan } = makeDeps({
      record: makeRecord({ status, degraded }),
    });

    const out = await call(deps);

    expect(out).toEqual({
      requeued: true,
      status: "PENDING",
      reason: "requeued",
    });
    expect(requeueForRescan).toHaveBeenCalledWith({ id: RECORD_ID, now: NOW });
  });
});

describe("rescanImage", () => {
  it("audits the requeue with the verdict it is discarding", async () => {
    // Recorded from the PRE-reset read on purpose: after the requeue these
    // columns are null and the audit row could not say what was thrown away.
    const { deps, auditLog } = makeDeps({
      record: makeRecord({
        status: "FLAGGED",
        degraded: true,
        maxSeverity: 6,
        provider: "azure-content-safety",
      }),
    });

    await call(deps);

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "image_moderation_record",
        entityId: RECORD_ID,
        action: "image_moderation.rescan_requested",
        at: NOW,
        data: expect.objectContaining({
          actorHumanId: ACTOR,
          fromStatus: "FLAGGED",
          toStatus: "PENDING",
          previousMaxSeverity: 6,
          previousProvider: "azure-content-safety",
          storageKey: "events/event-1/hero.jpg",
        }),
      }),
    );
  });

  it("treats a lost CAS as a human decision, reporting the row's REAL status", async () => {
    // The pre-read said machine state and the WHERE disagreed, which means a
    // moderator decided this row between the two statements. The repo-level
    // guard is what makes that safe; this asserts the caller is told the truth
    // rather than the state it expected.
    const { deps, auditLog } = makeDeps({
      record: makeRecord({ status: "FLAGGED", degraded: true }),
      rereadRecord: makeRecord({ status: "REJECTED", degraded: false }),
      requeueResult: 0,
    });

    const out = await call(deps);

    expect(out).toEqual({
      requeued: false,
      status: "REJECTED",
      reason: "human_decided",
    });
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND for a record that does not exist", async () => {
    // Distinct from "not eligible": the operator is holding an id for nothing.
    const { deps } = makeDeps({ record: null });

    await expect(call(deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("gives the client no way to name the actor", async () => {
    const { deps } = makeDeps({ record: makeRecord({ degraded: true }) });

    await expect(
      rescanImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        impersonate: "somebody-else",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
