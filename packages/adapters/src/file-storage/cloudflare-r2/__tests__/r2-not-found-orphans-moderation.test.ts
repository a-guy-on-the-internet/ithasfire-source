import { describe, expect, it, vi } from "vitest";

import { moderateImage } from "@th/core/use-cases/moderation";

import { CloudflareR2Adapter } from "../r2-adapter";

// ─────────────────────────────────────────────────────────────────────────────
// The SEAM between "what R2 throws for a deleted object" and "what
// moderate-image detects" (prod defect, Sentry HEARTH-FIRE-WEB-20).
//
// Both halves have their own unit tests, and both passed while the bug was
// live. What nobody owned was the join: the use case's unit tests build the
// error by hand, so they would keep passing if `mapS3Error` stopped emitting
// `not_found`, and the adapter's tests never see a consumer. This drives the
// REAL adapter (with a stubbed S3 client that fails exactly the way the AWS SDK
// does on a missing key) into the REAL use case, so a change to either side
// that breaks the other fails here.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "events/0103c492/images/61a6cf13.svg";

/** The shape `@aws-sdk/client-s3` throws for GetObject on a deleted key. */
class NoSuchKey extends Error {
  readonly name = "NoSuchKey";
  readonly $metadata = { httpStatusCode: 404 };
  constructor() {
    super("The specified key does not exist.");
  }
}

function quietLogger() {
  const logger: Record<string, unknown> = {
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_n: string, f: () => Promise<unknown>) => f()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger as never;
}

function makeRecord() {
  return {
    id: "rec-1",
    storageKey: STORAGE_KEY,
    kind: "EVENT_HERO",
    status: "PENDING",
    subjectType: "EVENT",
    subjectId: "event-1",
    publicUrl: `https://cdn.example/${STORAGE_KEY}`,
    contentType: "image/svg+xml",
    createdByHumanId: "human-1",
    maxSeverity: null,
    categories: null,
    provider: null,
    degraded: false,
    moderatedAt: null,
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date("2026-09-08T00:00:00.000Z"),
    requeues: 0,
    createdAt: new Date("2026-09-08T00:00:00.000Z"),
    updatedAt: new Date("2026-09-08T00:00:00.000Z"),
  };
}

describe("R2 not_found → moderate-image ORPHANED (cross-layer seam)", () => {
  const buildStorage = (send: () => Promise<unknown>) =>
    new CloudflareR2Adapter({
      bucket: "test-bucket",
      publicBaseUrl: "https://cdn.example",
      client: { send } as never,
    } as never);

  it("orphans the record when the object is gone from the bucket", async () => {
    const fileStorage = buildStorage(async () => {
      throw new NoSuchKey();
    });

    // Sanity-check the adapter half in isolation first, so a failure below is
    // unambiguous about which side moved.
    await expect(
      fileStorage.getObject({ key: STORAGE_KEY }),
    ).rejects.toMatchObject({ code: "not_found" });

    const markResult = vi.fn(async () => {});
    const markOrphaned = vi.fn(async () => {});
    const provider = vi.fn(async () => {
      throw new Error("provider must never see a missing object");
    });
    const reportError = vi.fn();

    const out = await moderateImage(
      {
        repos: {
          imageModerationRecords: {
            getByKey: async () => makeRecord(),
            markResult,
            markOrphaned,
          },
        } as never,
        fileStorage,
        moderation: { moderateImage: provider } as never,
        config: { reviewThreshold: 4 },
        logger: quietLogger(),
        reportError,
      },
      { storageKey: STORAGE_KEY },
    );

    expect(out).toEqual({
      status: "ORPHANED",
      maxSeverity: 0,
      degraded: false,
      noop: false,
    });
    expect(markOrphaned).toHaveBeenCalledTimes(1);
    expect(markResult).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "image-moderation", reason: "orphaned_object" },
        extra: expect.objectContaining({ code: "not_found" }),
      }),
    );
  });

  it("does NOT orphan when the BUCKET is missing (404, but a config fault)", async () => {
    // S3 answers NoSuchBucket with 404. Classified by status alone it reads as
    // `not_found`, so a renamed or misconfigured bucket would make EVERY object
    // in a drain pass look deleted — terminally orphaning the whole batch,
    // invisibly, until someone ran SQL. `mapS3Error` must test bucket-scope
    // names BEFORE the status check.
    const fileStorage = buildStorage(async () => {
      const err = new Error("The specified bucket does not exist");
      Object.assign(err, {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      });
      throw err;
    });

    await expect(
      fileStorage.getObject({ key: STORAGE_KEY }),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    const markOrphaned = vi.fn(async () => {});

    await expect(
      moderateImage(
        {
          repos: {
            imageModerationRecords: {
              getByKey: async () => makeRecord(),
              markResult: vi.fn(async () => {}),
              markOrphaned,
            },
          } as never,
          fileStorage,
          moderation: { moderateImage: vi.fn() } as never,
          config: { reviewThreshold: 4 },
          logger: quietLogger(),
          reportError: vi.fn(),
        },
        { storageKey: STORAGE_KEY },
      ),
    ).rejects.toMatchObject({ code: "dependency_failed" });

    // Rethrown, so the drain retries and eventually dead-letters to FLAGGED —
    // where a human can actually SEE that something is wrong.
    expect(markOrphaned).not.toHaveBeenCalled();
  });

  it("still retries when the bucket returns a 5xx (object may be fine)", async () => {
    const fileStorage = buildStorage(async () => {
      const err = new Error("we encountered an internal error");
      Object.assign(err, {
        name: "InternalError",
        $metadata: { httpStatusCode: 503 },
      });
      throw err;
    });

    // `mapS3Error` classifies 5xx as `transient`, which must NOT orphan.
    await expect(
      fileStorage.getObject({ key: STORAGE_KEY }),
    ).rejects.toMatchObject({ code: "transient" });

    const markOrphaned = vi.fn(async () => {});

    await expect(
      moderateImage(
        {
          repos: {
            imageModerationRecords: {
              getByKey: async () => makeRecord(),
              markResult: vi.fn(async () => {}),
              markOrphaned,
            },
          } as never,
          fileStorage,
          moderation: { moderateImage: vi.fn() } as never,
          config: { reviewThreshold: 4 },
          logger: quietLogger(),
        },
        { storageKey: STORAGE_KEY },
      ),
    ).rejects.toMatchObject({ code: "transient" });

    expect(markOrphaned).not.toHaveBeenCalled();
  });
});
