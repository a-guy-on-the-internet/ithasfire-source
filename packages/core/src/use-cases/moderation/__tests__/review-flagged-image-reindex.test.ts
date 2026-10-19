import { describe, expect, it, vi } from "vitest";

import type {
  ImageModerationRecord,
  ImageModerationSubjectType,
} from "@th/ports/repos/image-moderation-records";

const reindexAfterMutation = vi.fn();
vi.mock("../../search/reindex-after-mutation", () => ({
  reindexAfterMutation: (...args: unknown[]) => reindexAfterMutation(...args),
  reindexAllPublishedEvents: vi.fn(),
}));

import {
  reviewFlaggedImage,
  type ReviewFlaggedImageDeps,
} from "../review-flagged-image";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const RECORD_ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-07-08T12:00:00.000Z");

function makeRecord(
  overrides?: Partial<ImageModerationRecord>,
): ImageModerationRecord {
  return {
    id: RECORD_ID,
    storageKey: "events/event-1/images/img-1.png",
    kind: "EVENT_HERO",
    status: "FLAGGED",
    subjectType: "EVENT",
    subjectId: "11111111-1111-4111-8111-111111111111",
    publicUrl: "https://cdn.example/img-1.png",
    contentType: "image/png",
    createdByHumanId: null,
    maxSeverity: 4,
    categories: null,
    provider: "azure-content-safety",
    degraded: false,
    moderatedAt: new Date(NOW),
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date(NOW),
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
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

function makeDeps(record: ImageModerationRecord): {
  deps: ReviewFlaggedImageDeps;
  search: NonNullable<ReviewFlaggedImageDeps["search"]>;
  reportError: ReturnType<typeof vi.fn>;
} {
  const repos: any = {
    imageModerationRecords: {
      getById: vi.fn(async () => record),
      review: vi.fn(async () => 1),
    },
    pendingObjectDeletions: { enqueueMany: vi.fn(async () => {}) },
    audit: { log: vi.fn(async () => {}) },
    tx: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(repos)),
  };
  const search = {
    ensureIndexes: vi.fn(),
    upsertDocuments: vi.fn(),
    deleteDocuments: vi.fn(),
  } as unknown as NonNullable<ReviewFlaggedImageDeps["search"]>;
  const reportError = vi.fn();
  return {
    deps: { repos, clock: { now: () => NOW }, logger: makeLogger(), search, reportError },
    search,
    reportError,
  };
}

describe("reviewFlaggedImage — subject reindex wiring", () => {
  it.each(["APPROVE", "REJECT"] as const)(
    "%s reindexes the subject (event) with threaded search + reportError",
    async (decision) => {
      reindexAfterMutation.mockClear();
      const record = makeRecord();
      const { deps, search, reportError } = makeDeps(record);

      await reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision,
      });

      expect(reindexAfterMutation).toHaveBeenCalledTimes(1);
      const [reindexDeps, useCaseName, selector] =
        reindexAfterMutation.mock.calls[0];
      expect(useCaseName).toBe("reviewFlaggedImage");
      expect(selector).toEqual({ kind: "event", id: record.subjectId });
      expect(reindexDeps.search).toBe(search);
      expect(reindexDeps.reportError).toBe(reportError);
    },
  );

  it.each([
    ["PLACE", "place"],
    ["HUMAN", "human"],
    ["ORGANIZATION", "organization"],
  ] as const)(
    "maps subjectType %s to reindex kind %s (not hard-coded event)",
    async (subjectType, kind) => {
      reindexAfterMutation.mockClear();
      const record = makeRecord({
        subjectType: subjectType as ImageModerationSubjectType,
        subjectId: "22222222-2222-4222-8222-222222222222",
      });
      const { deps } = makeDeps(record);

      await reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision: "APPROVE",
      });

      const [, , selector] = reindexAfterMutation.mock.calls[0];
      expect(selector).toEqual({ kind, id: record.subjectId });
    },
  );

  it("skips the reindex when the subject can't be resolved (null subjectType)", async () => {
    reindexAfterMutation.mockClear();
    const record = makeRecord({ subjectType: null, subjectId: null });
    const { deps } = makeDeps(record);

    await reviewFlaggedImage(deps, {
      actorHumanId: ACTOR,
      recordId: RECORD_ID,
      decision: "APPROVE",
    });

    expect(reindexAfterMutation).not.toHaveBeenCalled();
  });

  it("does NOT reindex on an already-decided no-op (no genuine transition)", async () => {
    reindexAfterMutation.mockClear();
    const record = makeRecord({ status: "APPROVED" });
    const { deps } = makeDeps(record);

    await reviewFlaggedImage(deps, {
      actorHumanId: ACTOR,
      recordId: RECORD_ID,
      decision: "APPROVE",
    });

    expect(reindexAfterMutation).not.toHaveBeenCalled();
  });
});
