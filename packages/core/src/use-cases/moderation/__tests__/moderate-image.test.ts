import { describe, expect, it, vi } from "vitest";

import type { ImageModerationResult } from "@th/ports/moderation";
import type {
  ImageModerationRecord,
  MarkImageModerationResultInput,
} from "@th/ports/repos/image-moderation-records";

import {
  moderateImage,
  exceedsCategoryThreshold,
  type ModerateImageDeps,
} from "../moderate-image";

const STORAGE_KEY = "events/event-1/images/img-1.png";

function makeRecord(
  overrides?: Partial<ImageModerationRecord>,
): ImageModerationRecord {
  return {
    id: "rec-1",
    storageKey: STORAGE_KEY,
    kind: "EVENT_HERO",
    status: "PENDING",
    subjectType: "EVENT",
    subjectId: "event-1",
    publicUrl: `https://cdn.example/${STORAGE_KEY}`,
    contentType: "image/png",
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
    nextAttemptAt: new Date("2026-07-08T00:00:00.000Z"),
    createdAt: new Date("2026-07-08T00:00:00.000Z"),
    updatedAt: new Date("2026-07-08T00:00:00.000Z"),
    ...overrides,
  };
}

function makeLogger() {
  return {
    child: vi.fn(function () {
      return this;
    }),
    withTime: vi.fn(async (_n: string, f: () => Promise<unknown>) => f()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function makeResult(
  overrides?: Partial<ImageModerationResult>,
): ImageModerationResult {
  return {
    verdict: "APPROVED",
    maxSeverity: 0,
    categories: [{ category: "SEXUAL", severity: 0 }],
    provider: "azure-content-safety",
    rawSeverityScale: "four",
    degraded: false,
    ...overrides,
  };
}

function makeDeps(args: {
  record: ImageModerationRecord | null;
  result?: ImageModerationResult;
  reviewThreshold?: number;
  categoryThresholds?: Partial<Record<string, number>>;
  reportError?: ReturnType<typeof vi.fn>;
  getObject?: ReturnType<typeof vi.fn>;
}): {
  deps: ModerateImageDeps;
  markResult: ReturnType<typeof vi.fn>;
  markOrphaned: ReturnType<typeof vi.fn>;
  moderate: ReturnType<typeof vi.fn>;
} {
  const markResult = vi.fn(async (_input: MarkImageModerationResultInput) => {});
  const markOrphaned = vi.fn(async () => {});
  const moderate = vi.fn(async () => args.result ?? makeResult());
  const getObject =
    args.getObject ??
    vi.fn(async () => ({
      content: Buffer.from("bytes"),
      contentType: "image/png",
      size: 5,
    }));

  const deps: ModerateImageDeps = {
    repos: {
      imageModerationRecords: {
        getByKey: vi.fn(async () => args.record),
        markResult,
        markOrphaned,
      },
    } as any,
    fileStorage: { getObject } as any,
    moderation: { moderateImage: moderate },
    config: {
      reviewThreshold: args.reviewThreshold ?? 4,
      ...(args.categoryThresholds
        ? { categoryThresholds: args.categoryThresholds as any }
        : {}),
    },
    logger: makeLogger(),
    reportError: args.reportError,
  };
  return { deps, markResult, markOrphaned, moderate };
}

/**
 * A `FileStorageError` exactly as the R2/S3 adapters throw it: a PLAIN OBJECT
 * carrying a contracted `code`, not an `Error` subclass. Tests must use this
 * shape — a fixture that threw `new Error("object_not_found")` would pass a
 * message-matching implementation and prove nothing about the code check.
 */
function storageError(code: string, message: string) {
  return { code, message };
}

describe("moderateImage", () => {
  it("APPROVES a low-severity image and writes the verdict", async () => {
    const { deps, markResult } = makeDeps({
      record: makeRecord(),
      result: makeResult({ maxSeverity: 2 }),
    });

    const out = await moderateImage(deps, { storageKey: STORAGE_KEY });

    expect(out).toMatchObject({ status: "APPROVED", degraded: false, noop: false });
    expect(markResult).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: STORAGE_KEY,
        status: "APPROVED",
        maxSeverity: 2,
        degraded: false,
        provider: "azure-content-safety",
      }),
    );
  });

  it("FLAGS an at/above-threshold image", async () => {
    // `categories` drives the decision, not `maxSeverity` — so the fixture has
    // to carry a category actually AT the bar. It previously set maxSeverity 4
    // while leaving every category at 0, which Azure cannot produce (the max is
    // derived from the categories) and which now reads as APPROVED, correctly.
    const { deps, markResult } = makeDeps({
      record: makeRecord(),
      result: makeResult({
        maxSeverity: 4,
        verdict: "FLAGGED",
        categories: [{ category: "SEXUAL", severity: 4 }],
      }),
    });

    const out = await moderateImage(deps, { storageKey: STORAGE_KEY });

    expect(out).toMatchObject({ status: "FLAGGED", noop: false });
    expect(markResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FLAGGED", maxSeverity: 4 }),
    );
  });

  it("FLAGS a degraded (fail-closed) result and reports to Sentry", async () => {
    const reportError = vi.fn();
    const { deps, markResult } = makeDeps({
      record: makeRecord(),
      result: makeResult({ degraded: true, maxSeverity: 0, provider: "azure-content-safety" }),
      reportError,
    });

    const out = await moderateImage(deps, { storageKey: STORAGE_KEY });

    expect(out).toMatchObject({ status: "FLAGGED", degraded: true, noop: false });
    expect(markResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FLAGGED", degraded: true }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "image-moderation", provider: "azure-content-safety" },
        extra: expect.objectContaining({ storageKey: STORAGE_KEY }),
      }),
    );
  });

  it("a throwing reporter never changes the FLAGGED outcome", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const { deps } = makeDeps({
      record: makeRecord(),
      result: makeResult({ degraded: true }),
      reportError,
    });

    await expect(
      moderateImage(deps, { storageKey: STORAGE_KEY }),
    ).resolves.toMatchObject({ status: "FLAGGED", degraded: true });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for an already-decided record", async () => {
    const { deps, markResult, moderate } = makeDeps({
      record: makeRecord({ status: "APPROVED", maxSeverity: 2 }),
    });

    const out = await moderateImage(deps, { storageKey: STORAGE_KEY });

    expect(out).toMatchObject({ status: "APPROVED", noop: true });
    expect(moderate).not.toHaveBeenCalled();
    expect(markResult).not.toHaveBeenCalled();
  });

  it("is a no-op when no record exists for the key", async () => {
    const { deps, markResult, moderate } = makeDeps({ record: null });

    const out = await moderateImage(deps, { storageKey: STORAGE_KEY });

    // Missing record → honest "PENDING" (we-don't-know), not a fabricated
    // verdict. Behaviour is unchanged: drain only branches on `noop`.
    expect(out).toMatchObject({ status: "PENDING", noop: true });
    expect(moderate).not.toHaveBeenCalled();
    expect(markResult).not.toHaveBeenCalled();
  });

  it("rethrows (does NOT markResult) when fetching bytes fails transiently", async () => {
    const { deps, markResult } = makeDeps({
      record: makeRecord(),
      getObject: vi.fn(async () => {
        throw new Error("R2 unavailable");
      }),
    });

    await expect(
      moderateImage(deps, { storageKey: STORAGE_KEY }),
    ).rejects.toThrow("R2 unavailable");
    expect(markResult).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Missing object → ORPHANED (prod defect, Sentry HEARTH-FIRE-WEB-20)
//
// A record outlived its R2 object. `not_found` is PERMANENT, so treating it as
// transient burned all 22 attempts and then dead-lettered the row to FLAGGED —
// parking a moderator in front of an image that does not exist, where the
// "approve" button would publish a broken image. The FIRST pass must resolve it.
// ─────────────────────────────────────────────────────────────────────────────

describe("moderateImage — missing object", () => {
  it("resolves a not_found object to ORPHANED without scoring or throwing", async () => {
    const reportError = vi.fn();
    const { deps, markResult, markOrphaned, moderate } = makeDeps({
      record: makeRecord(),
      reportError,
      getObject: vi.fn(async () => {
        throw storageError("not_found", "object_not_found");
      }),
    });

    const out = await moderateImage(deps, { storageKey: STORAGE_KEY });

    // A resolution, not a no-op: the drain must count it and stop retrying.
    expect(out).toEqual({
      status: "ORPHANED",
      maxSeverity: 0,
      degraded: false,
      noop: false,
    });

    expect(markOrphaned).toHaveBeenCalledTimes(1);
    expect(markOrphaned).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: STORAGE_KEY,
        lastError: "object_not_found",
        resolvedAt: expect.any(Date),
      }),
    );

    // No bytes were read, so nothing may be scored and no verdict may be
    // written. `degraded: true` in particular would make the row eligible for
    // requeueDegraded and restart the churn this fix exists to end.
    expect(moderate).not.toHaveBeenCalled();
    expect(markResult).not.toHaveBeenCalled();
  });

  it("reports the orphan to Sentry exactly once with the orphaned_object tag", async () => {
    const reportError = vi.fn();
    const { deps } = makeDeps({
      record: makeRecord(),
      reportError,
      getObject: vi.fn(async () => {
        throw storageError("not_found", "object_not_found");
      }),
    });

    await moderateImage(deps, { storageKey: STORAGE_KEY });

    // The swallow is invisible to the product by design — nobody is notified,
    // nothing surfaces in the queue. Sentry is the ONLY visibility, so this
    // report is required, not decorative (CLAUDE.md error convention).
    expect(reportError).toHaveBeenCalledTimes(1);

    // A real Error, not the caught plain object: Sentry renders a bare
    // `{ code, message }` as "Object captured as exception with keys: …" under
    // a synthetic stack, which collapses every orphan into one shapeless issue.
    const [captured, context] = reportError.mock.calls[0] as [
      unknown,
      { tags: unknown; extra: Record<string, unknown> },
    ];
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe(
      "image moderation object missing (orphaned)",
    );
    expect(context.tags).toEqual({
      area: "image-moderation",
      reason: "orphaned_object",
    });
    // The original code/message must survive onto the event, not be discarded.
    expect(context.extra).toMatchObject({
      code: "not_found",
      message: "object_not_found",
      storageKey: STORAGE_KEY,
      recordId: "rec-1",
    });
  });

  it("falls back to a default detail when the error carries no message", async () => {
    // `isFileStorageError` only validates `code`, so `message` is a type-level
    // assertion. An adapter throwing a bare `{ code }` would pass `undefined`
    // to Prisma, which reads it as "leave the column alone" — a silently blank
    // `last_error` on the one row that exists to explain itself.
    const reportError = vi.fn();
    const { deps, markOrphaned } = makeDeps({
      record: makeRecord(),
      reportError,
      getObject: vi.fn(async () => {
        throw { code: "not_found" };
      }),
    });

    await expect(
      moderateImage(deps, { storageKey: STORAGE_KEY }),
    ).resolves.toMatchObject({ status: "ORPHANED" });

    expect(markOrphaned).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: "object_not_found" }),
    );
    const [, context] = reportError.mock.calls[0] as [
      unknown,
      { extra: Record<string, unknown> },
    ];
    expect(context.extra.message).toBe("object_not_found");
  });

  it("a throwing reporter never changes the ORPHANED outcome", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const { deps, markOrphaned } = makeDeps({
      record: makeRecord(),
      reportError,
      getObject: vi.fn(async () => {
        throw storageError("not_found", "object_not_found");
      }),
    });

    await expect(
      moderateImage(deps, { storageKey: STORAGE_KEY }),
    ).resolves.toMatchObject({ status: "ORPHANED", noop: false });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(markOrphaned).toHaveBeenCalledTimes(1);
  });

  it.each(["transient", "dependency_failed"])(
    "still RETHROWS a %s storage error and marks nothing",
    async (code) => {
      const reportError = vi.fn();
      const { deps, markResult, markOrphaned, moderate } = makeDeps({
        record: makeRecord(),
        reportError,
        getObject: vi.fn(async () => {
          throw storageError(code, "storage_unavailable");
        }),
      });

      // The object may well still be there — storage is just not answering.
      // The drain's backoff + dead-letter path stays exactly as it was.
      await expect(
        moderateImage(deps, { storageKey: STORAGE_KEY }),
      ).rejects.toMatchObject({ code });

      expect(markOrphaned).not.toHaveBeenCalled();
      expect(markResult).not.toHaveBeenCalled();
      expect(moderate).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it("does not orphan on a plain Error whose message merely says not_found", async () => {
    // Detection is by the port's contracted `code`, never a message match.
    const { deps, markOrphaned } = makeDeps({
      record: makeRecord(),
      getObject: vi.fn(async () => {
        throw new Error('{"code":"not_found","message":"object_not_found"}');
      }),
    });

    await expect(
      moderateImage(deps, { storageKey: STORAGE_KEY }),
    ).rejects.toThrow("not_found");
    expect(markOrphaned).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-category thresholds (decided 2026-08-20)
//
// A uniform threshold cannot express "HATE 2 is a hold but SEXUAL 4 is fine",
// which is exactly what a live-music catalogue needs: gig posters for metal,
// burlesque, drag and horror-themed shows score SEXUAL/VIOLENCE honestly, while
// nothing legitimate scores HATE or SELF_HARM at all.
// ─────────────────────────────────────────────────────────────────────────────

const SHIPPED_THRESHOLDS = {
  SEXUAL: 6,
  VIOLENCE: 6,
  HATE: 2,
  SELF_HARM: 2,
} as const;

describe("moderateImage — per-category thresholds", () => {
  it("APPROVES a SEXUAL-4 poster that a uniform threshold of 4 would have held", async () => {
    // The regression this whole change exists to prevent.
    const { deps, markResult } = makeDeps({
      record: makeRecord(),
      categoryThresholds: SHIPPED_THRESHOLDS,
      result: makeResult({
        maxSeverity: 4,
        categories: [
          { category: "SEXUAL", severity: 4 },
          { category: "VIOLENCE", severity: 0 },
          { category: "HATE", severity: 0 },
          { category: "SELF_HARM", severity: 0 },
        ],
      }),
    });

    const out = await moderateImage(deps, { storageKey: STORAGE_KEY });

    expect(out.status).toBe("APPROVED");
    expect(markResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "APPROVED" }),
    );
  });

  it("FLAGS a HATE-2 image that a uniform threshold of 4 would have let through", async () => {
    const { deps, markResult } = makeDeps({
      record: makeRecord(),
      categoryThresholds: SHIPPED_THRESHOLDS,
      result: makeResult({
        maxSeverity: 2,
        categories: [
          { category: "SEXUAL", severity: 0 },
          { category: "VIOLENCE", severity: 0 },
          { category: "HATE", severity: 2 },
          { category: "SELF_HARM", severity: 0 },
        ],
      }),
    });

    const out = await moderateImage(deps, { storageKey: STORAGE_KEY });

    expect(out.status).toBe("FLAGGED");
    expect(markResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FLAGGED" }),
    );
  });

  it("FLAGS on SELF_HARM-2 even when maxSeverity sits below every other bar", async () => {
    const { deps } = makeDeps({
      record: makeRecord(),
      categoryThresholds: SHIPPED_THRESHOLDS,
      result: makeResult({
        maxSeverity: 2,
        categories: [
          { category: "SEXUAL", severity: 2 },
          { category: "VIOLENCE", severity: 2 },
          { category: "HATE", severity: 0 },
          { category: "SELF_HARM", severity: 2 },
        ],
      }),
    });

    expect((await moderateImage(deps, { storageKey: STORAGE_KEY })).status).toBe(
      "FLAGGED",
    );
  });

  it("falls back to the uniform threshold for any category without an override", async () => {
    // Half-configured environment: only HATE is set. VIOLENCE-4 must still be
    // caught by the fallback of 4 rather than silently sliding to 0-or-ignored.
    const { deps } = makeDeps({
      record: makeRecord(),
      reviewThreshold: 4,
      categoryThresholds: { HATE: 2 },
      result: makeResult({
        maxSeverity: 4,
        categories: [
          { category: "VIOLENCE", severity: 4 },
          { category: "HATE", severity: 0 },
        ],
      }),
    });

    expect((await moderateImage(deps, { storageKey: STORAGE_KEY })).status).toBe(
      "FLAGGED",
    );
  });

  it("still FLAGS a degraded verdict regardless of category thresholds", async () => {
    // Degraded carries an EMPTY categories array. If the degraded branch were
    // ever reordered behind the category check, this would APPROVE an image
    // that was never scanned — the fail-OPEN this suite exists to forbid.
    const { deps } = makeDeps({
      record: makeRecord(),
      categoryThresholds: SHIPPED_THRESHOLDS,
      result: makeResult({
        verdict: "FLAGGED",
        maxSeverity: 6,
        categories: [],
        degraded: true,
      }),
    });

    const out = await moderateImage(deps, { storageKey: STORAGE_KEY });
    expect(out.status).toBe("FLAGGED");
    expect(out.degraded).toBe(true);
  });
});

describe("exceedsCategoryThreshold", () => {
  it("returns false for an empty category list", () => {
    // The degraded shape. Must never independently authorise an APPROVE.
    expect(
      exceedsCategoryThreshold([], {
        reviewThreshold: 0,
        categoryThresholds: SHIPPED_THRESHOLDS,
      }),
    ).toBe(false);
  });

  it("compares each category against its OWN bar, not the max", () => {
    const config = {
      reviewThreshold: 4,
      categoryThresholds: SHIPPED_THRESHOLDS,
    };
    expect(
      exceedsCategoryThreshold(
        [
          { category: "SEXUAL", severity: 4 },
          { category: "HATE", severity: 0 },
        ],
        config,
      ),
    ).toBe(false);
    expect(
      exceedsCategoryThreshold(
        [
          { category: "SEXUAL", severity: 0 },
          { category: "HATE", severity: 2 },
        ],
        config,
      ),
    ).toBe(true);
  });
});
