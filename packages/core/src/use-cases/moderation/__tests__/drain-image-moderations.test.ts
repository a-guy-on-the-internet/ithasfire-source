import { describe, expect, it, vi } from "vitest";

import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";

import { renderNotification } from "../../comms/renderers";
import {
  drainImageModerations,
  type DrainImageModerationsDeps,
} from "../drain-image-moderations";
import { moderateImage, type ModerateImageOutput } from "../moderate-image";

const HUMAN_ID = "human-1";

function makeRecord(
  overrides?: Partial<ImageModerationRecord>,
): ImageModerationRecord {
  return {
    id: "rec-1",
    storageKey: "events/event-1/images/img-1.png",
    kind: "EVENT_HERO",
    status: "PENDING",
    subjectType: "EVENT",
    subjectId: "event-1",
    publicUrl: "https://cdn.example/img-1.png",
    contentType: "image/png",
    createdByHumanId: HUMAN_ID,
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

const NOW = new Date("2026-07-08T12:00:00.000Z");

const EVENT = {
  id: "event-1",
  title: "Night Market Sessions",
  slug: "night-market-sessions",
  status: "PUBLISHED",
} as const;

function makeDeps(args: {
  records: ImageModerationRecord[];
  moderateImage: (key: string) => Promise<ModerateImageOutput>;
  notify?: ReturnType<typeof vi.fn>;
  reportError?: ReturnType<typeof vi.fn>;
  /** Event returned by the subject-enrichment lookup; undefined → the default. */
  event?: unknown;
  /** When set, the enrichment lookup throws this. */
  eventLookupError?: Error;
  appBaseUrl?: string;
}): {
  deps: DrainImageModerationsDeps;
  markResult: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
  getEventById: ReturnType<typeof vi.fn>;
  logger: any;
} {
  const markResult = vi.fn(async () => {});
  const markFailed = vi.fn(async () => {});
  const getEventById = vi.fn(async () => {
    if (args.eventLookupError) throw args.eventLookupError;
    return "event" in args ? args.event : EVENT;
  });
  const logger = makeLogger();
  const deps: DrainImageModerationsDeps = {
    repos: {
      imageModerationRecords: {
        claimDue: vi.fn(async () => args.records),
        markResult,
        markFailed,
      },
      events: { getById: getEventById },
    } as any,
    moderateImage: args.moderateImage,
    clock: { now: () => NOW },
    logger,
    notify: args.notify,
    appBaseUrl: "appBaseUrl" in args ? args.appBaseUrl : "https://app.example",
    reportError: args.reportError,
  };
  return { deps, markResult, markFailed, getEventById, logger };
}

const FLAGGED_VERDICT = async (): Promise<ModerateImageOutput> => ({
  status: "FLAGGED",
  maxSeverity: 4,
  degraded: false,
  noop: false,
});

describe("drainImageModerations", () => {
  it("moderates a claimed PENDING row and notifies on FLAGGED", async () => {
    const notify = vi.fn(async () => ({}));
    const moderateImage = vi.fn(
      async (): Promise<ModerateImageOutput> => ({
        status: "FLAGGED",
        maxSeverity: 4,
        degraded: false,
        noop: false,
      }),
    );
    const { deps } = makeDeps({
      records: [makeRecord()],
      moderateImage,
      notify,
    });

    const out = await drainImageModerations(deps, {});

    expect(out).toMatchObject({ processed: 1, moderated: 1, retried: 0, deadLettered: 0 });
    expect(moderateImage).toHaveBeenCalledWith("events/event-1/images/img-1.png");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: HUMAN_ID,
        variant: "image.moderation.held",
        idempotencyKey: "image-moderation-held:rec-1",
        payload: expect.objectContaining({
          // Enriched from ONE events.getById — names the event and links it by
          // slug, never by id.
          subjectTitle: "Night Market Sessions",
          subjectUrl: "https://app.example/events/night-market-sessions",
        }),
      }),
    );
  });

  it("reports a hold-notify failure to Sentry (guarded) without failing the drain", async () => {
    const notify = vi.fn(async () => {
      throw new Error("mailer down");
    });
    const reportError = vi.fn();
    const { deps } = makeDeps({
      records: [makeRecord()],
      moderateImage: async () => ({
        status: "FLAGGED",
        maxSeverity: 4,
        degraded: false,
        noop: false,
      }),
      notify,
      reportError,
    });

    const out = await drainImageModerations(deps, {});

    // The verdict is already committed — the notify failure is swallowed, but
    // reported (logger.warn is not Sentry-captured).
    expect(out).toMatchObject({ processed: 1, moderated: 1 });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "image-moderation", reason: "notify-failed" },
        extra: expect.objectContaining({ recordId: "rec-1" }),
      }),
    );
  });

  it("does NOT notify on an APPROVED verdict", async () => {
    const notify = vi.fn(async () => ({}));
    const { deps } = makeDeps({
      records: [makeRecord()],
      moderateImage: async () => ({
        status: "APPROVED",
        maxSeverity: 0,
        degraded: false,
        noop: false,
      }),
      notify,
    });

    const out = await drainImageModerations(deps, {});

    expect(out).toMatchObject({ moderated: 1 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("retries a transient failure with backoff (no dead-letter)", async () => {
    const { deps, markFailed, markResult } = makeDeps({
      records: [makeRecord({ attempts: 0 })],
      moderateImage: async () => {
        throw new Error("azure 503");
      },
    });

    const out = await drainImageModerations(deps, {
      maxAttempts: 5,
      baseBackoffSeconds: 30,
    });

    expect(out).toMatchObject({ processed: 1, moderated: 0, retried: 1, deadLettered: 0 });
    expect(markResult).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "rec-1",
        lastError: "azure 503",
        // attempts=1 → base * 2^0 = 30s
        nextAttemptAt: new Date(NOW.getTime() + 30_000),
      }),
    );
  });

  it("dead-letters to FLAGGED+degraded on exhaustion, notifying + reporting", async () => {
    const notify = vi.fn(async () => ({}));
    const reportError = vi.fn();
    const { deps, markResult, markFailed } = makeDeps({
      // one attempt away from exhaustion (attempts+1 === maxAttempts)
      records: [makeRecord({ attempts: 4 })],
      moderateImage: async () => {
        throw new Error("azure gone");
      },
      notify,
      reportError,
    });

    const out = await drainImageModerations(deps, { maxAttempts: 5 });

    expect(out).toMatchObject({ processed: 1, moderated: 0, retried: 0, deadLettered: 1 });
    expect(markFailed).not.toHaveBeenCalled();
    expect(markResult).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: "events/event-1/images/img-1.png",
        status: "FLAGGED",
        degraded: true,
        provider: "drain-exhausted",
        maxSeverity: 6,
      }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "image.moderation.held",
        idempotencyKey: "image-moderation-held:rec-1",
      }),
    );
  });

  it("skips a no-op result (concurrent run resolved it) without notifying", async () => {
    const notify = vi.fn(async () => ({}));
    const { deps } = makeDeps({
      records: [makeRecord()],
      moderateImage: async () => ({
        status: "FLAGGED",
        maxSeverity: 4,
        degraded: false,
        noop: true,
      }),
      notify,
    });

    const out = await drainImageModerations(deps, {});

    expect(out).toMatchObject({ processed: 1, moderated: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("one throwing row never aborts the batch", async () => {
    const outcomes: ModerateImageOutput[] = [
      { status: "APPROVED", maxSeverity: 0, degraded: false, noop: false },
    ];
    const moderateImage = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => outcomes[0]);

    const { deps } = makeDeps({
      records: [makeRecord({ id: "rec-1" }), makeRecord({ id: "rec-2" })],
      moderateImage,
    });

    const out = await drainImageModerations(deps, {});

    expect(out.processed).toBe(2);
    // rec-1 threw (retried), rec-2 moderated.
    expect(out.retried).toBe(1);
    expect(out.moderated).toBe(1);
  });

  describe("hold-notice subject enrichment", () => {
    it("looks the event up exactly ONCE per notice", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps, getEventById } = makeDeps({
        records: [makeRecord()],
        moderateImage: FLAGGED_VERDICT,
        notify,
      });

      await drainImageModerations(deps, {});

      expect(getEventById).toHaveBeenCalledTimes(1);
      expect(getEventById).toHaveBeenCalledWith("event-1");
    });

    it("still sends the notice with nulls (and reports) when the lookup throws", async () => {
      const notify = vi.fn(async () => ({}));
      const reportError = vi.fn();
      const { deps, logger } = makeDeps({
        records: [makeRecord()],
        moderateImage: FLAGGED_VERDICT,
        notify,
        reportError,
        eventLookupError: new Error("db down"),
      });

      const out = await drainImageModerations(deps, {});

      // Verdict committed, notice still sent — just without the enrichment.
      expect(out).toMatchObject({ processed: 1, moderated: 1 });
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "image.moderation.held",
          payload: expect.objectContaining({
            subjectTitle: null,
            subjectUrl: null,
          }),
        }),
      );
      // Sentry-visible swallow: logger.error (captured) + guarded reportError.
      expect(logger.error).toHaveBeenCalledWith(
        "moderation.subjectLookupFailed",
        expect.objectContaining({ recordId: "rec-1", subjectId: "event-1" }),
      );
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: {
            area: "image-moderation",
            reason: "subject-lookup-failed",
          },
        }),
      );
    });

    it("degrades to nulls when the event no longer exists", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({
        records: [makeRecord()],
        moderateImage: FLAGGED_VERDICT,
        notify,
        event: null,
      });

      await drainImageModerations(deps, {});

      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            subjectTitle: null,
            subjectUrl: null,
          }),
        }),
      );
    });

    it("names the event but omits the link when the event has no slug", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({
        records: [makeRecord()],
        moderateImage: FLAGGED_VERDICT,
        notify,
        event: {
          id: "event-1",
          title: "Night Market Sessions",
          slug: null,
          status: "PUBLISHED",
        },
      });

      await drainImageModerations(deps, {});

      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            subjectTitle: "Night Market Sessions",
            subjectUrl: null,
          }),
        }),
      );
    });

    it("omits the link when no appBaseUrl is configured", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({
        records: [makeRecord()],
        moderateImage: FLAGGED_VERDICT,
        notify,
        appBaseUrl: undefined,
      });

      await drainImageModerations(deps, {});

      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            subjectTitle: "Night Market Sessions",
            subjectUrl: null,
            helpUrl: null,
          }),
        }),
      );
    });

    it("passes nulls and does NOT look anything up for non-EVENT subjects", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps, getEventById } = makeDeps({
        records: [
          makeRecord({
            kind: "AVATAR",
            subjectType: "HUMAN",
            subjectId: HUMAN_ID,
          }),
        ],
        moderateImage: FLAGGED_VERDICT,
        notify,
      });

      await drainImageModerations(deps, {});

      expect(getEventById).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            subjectTitle: null,
            subjectUrl: null,
          }),
        }),
      );
    });

    it("keeps a multi-segment slug's separators intact in the URL", async () => {
      // Event slugs are paths (`org/us/general/my-event--ab12cd`) and
      // `/events/[...slug]` is a catch-all: percent-encoding the slashes 404s.
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({
        records: [makeRecord()],
        moderateImage: FLAGGED_VERDICT,
        notify,
        event: {
          id: "event-1",
          title: "VIP Members Only Night",
          slug: "bay-area-festivals/us/general/vip-members-only-night--00vfkyl834",
          status: "PUBLISHED",
        },
      });

      await drainImageModerations(deps, {});

      const payload = (notify.mock.calls[0] as any[])[0].payload as {
        subjectUrl: string;
      };
      expect(payload.subjectUrl).toBe(
        "https://app.example/events/bay-area-festivals/us/general/vip-members-only-night--00vfkyl834",
      );
      expect(payload.subjectUrl).not.toContain("%2F");
    });

    it("emits a payload the STRICT held renderer accepts end to end", async () => {
      // The renderer schema is `.strict()` and runs inside notify() BEFORE the
      // idempotency claim: a shape drift here would throw at send time, which
      // no spy-based assertion would catch.
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({
        records: [makeRecord({ id: "3f6f5f2c-0f2e-4a1e-9d5e-1a2b3c4d5e6f" })],
        moderateImage: FLAGGED_VERDICT,
        notify,
      });

      await drainImageModerations(deps, {});

      const { variant, payload } = (notify.mock.calls[0] as any[])[0];
      const rendered = renderNotification(variant, payload, {
        now: new Date("2026-07-08T12:00:00.000Z"),
      });
      expect(rendered.inApp?.action).toEqual({
        label: "View event",
        route: "/events/night-market-sessions",
      });
      expect(rendered.inApp?.body).toContain("Night Market Sessions");
    });

    it("names the event but drops BOTH links when the base URL is malformed", async () => {
      // `PUBLIC_WEB_URL=ithasfire.com` (no scheme). The renderer validates
      // helpUrl/subjectUrl with a strict `.url()` BEFORE notify() claims its
      // idempotency key, so an unparseable base must degrade to null rather
      // than throw and sink the whole notice.
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({
        // uuid id so the strict renderer check below exercises the URL fields,
        // not the record-id format.
        records: [makeRecord({ id: "3f6f5f2c-0f2e-4a1e-9d5e-1a2b3c4d5e6f" })],
        moderateImage: FLAGGED_VERDICT,
        notify,
        appBaseUrl: "ithasfire.com",
      });

      await drainImageModerations(deps, {});

      const { variant, payload } = (notify.mock.calls[0] as any[])[0];
      expect(payload).toMatchObject({
        subjectTitle: "Night Market Sessions",
        subjectUrl: null,
        helpUrl: null,
      });
      // And the notice still renders rather than throwing.
      expect(() =>
        renderNotification(variant, payload, { now: NOW }),
      ).not.toThrow();
    });

    it("still links a non-PUBLISHED event — its page renders", async () => {
      // The public event route has NO status gate, and `EventDetail` renders a
      // status banner for CANCELLED / ARCHIVED / COMPLETED / DRAFT precisely so
      // the page "never reads as a live event". Gating the link on PUBLISHED
      // would drop it exactly where the uploader most needs it.
      const notify = vi.fn(async () => ({}));
      for (const status of ["DRAFT", "ARCHIVED", "CANCELLED"] as const) {
        notify.mockClear();
        const { deps } = makeDeps({
          records: [makeRecord()],
          moderateImage: FLAGGED_VERDICT,
          notify,
          event: {
            id: "event-1",
            title: "Night Market Sessions",
            slug: "night-market-sessions",
            status,
          },
        });

        await drainImageModerations(deps, {});

        expect((notify.mock.calls[0] as any[])[0].payload).toMatchObject({
          subjectTitle: "Night Market Sessions",
          subjectUrl: "https://app.example/events/night-market-sessions",
        });
      }
    });

    it("truncates an oversized title so it can never bloat the payload", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({
        records: [makeRecord()],
        moderateImage: FLAGGED_VERDICT,
        notify,
        event: {
          id: "event-1",
          title: "x".repeat(500),
          slug: "e",
          status: "PUBLISHED",
        },
      });

      await drainImageModerations(deps, {});

      const payload = (notify.mock.calls[0] as any[])[0].payload as {
        subjectTitle: string;
      };
      expect(payload.subjectTitle.length).toBeLessThanOrEqual(200);
      expect(payload.subjectTitle.endsWith("…")).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Missing object → resolved in ONE pass (prod defect, Sentry HEARTH-FIRE-WEB-20)
//
// The record outlived its R2 object. Before this fix the drain treated the
// permanent `not_found` as transient: 22 attempts across a ~74h backoff window,
// then a dead-letter to FLAGGED+degraded plus a HOLD notice — which put an
// image that DOES NOT EXIST in front of a human, with an "approve" button that
// would have published it.
//
// These wire the REAL moderate-image use case into the drain rather than a
// canned outcome, so the two layers are proven to agree end to end.
// ─────────────────────────────────────────────────────────────────────────────

describe("drainImageModerations — missing object", () => {
  function makeOrphanDeps(args?: { notify?: ReturnType<typeof vi.fn> }) {
    const record = makeRecord();
    const markResult = vi.fn(async () => {});
    const markFailed = vi.fn(async () => {});
    const markOrphaned = vi.fn(async () => {});
    const moderate = vi.fn(async () => {
      throw new Error("provider must never be called for a missing object");
    });
    const logger = makeLogger();

    // The real use case, bound to a storage that answers `not_found` exactly
    // the way the R2/S3 adapters do (a plain object with a contracted `code`).
    const moderateImageFn = (storageKey: string) =>
      moderateImage(
        {
          repos: {
            imageModerationRecords: {
              getByKey: async () => record,
              markResult,
              markOrphaned,
            },
          } as any,
          fileStorage: {
            getObject: async () => {
              throw { code: "not_found", message: "object_not_found" };
            },
          } as any,
          moderation: { moderateImage: moderate } as any,
          config: { reviewThreshold: 4 },
          logger,
        },
        { storageKey },
      );

    const deps: DrainImageModerationsDeps = {
      repos: {
        imageModerationRecords: {
          claimDue: vi.fn(async () => [record]),
          markResult,
          markFailed,
          markOrphaned,
        },
        events: { getById: vi.fn(async () => EVENT) },
      } as any,
      moderateImage: moderateImageFn,
      clock: { now: () => NOW },
      logger,
      notify: args?.notify,
      appBaseUrl: "https://app.example",
    };

    return { deps, markResult, markFailed, markOrphaned, moderate };
  }

  it("resolves in ONE pass: no attempt charged, no retry scheduled, no dead-letter", async () => {
    const { deps, markResult, markFailed, markOrphaned } = makeOrphanDeps();

    const out = await drainImageModerations(deps, {});

    // Counted as its own outcome — not a verdict, not a failure.
    expect(out).toEqual({
      processed: 1,
      moderated: 0,
      orphaned: 1,
      removedBeforeScan: 0,
      retried: 0,
      deadLettered: 0,
      unprocessed: 0,
      passes: 1,
      hasMore: false,
    });

    // `markFailed` is what increments `attempts` and sets `nextAttemptAt`.
    // Neither may happen: there is nothing to try again.
    expect(markFailed).not.toHaveBeenCalled();
    // `markResult` is the dead-letter write (FLAGGED + degraded) as well as the
    // verdict write. Neither is legitimate here.
    expect(markResult).not.toHaveBeenCalled();
    expect(markOrphaned).toHaveBeenCalledTimes(1);
  });

  it("does not leave the row PENDING (it would be reclaimed forever)", async () => {
    const { deps, markOrphaned } = makeOrphanDeps();

    await drainImageModerations(deps, {});

    // The terminal write is the whole point — a row left PENDING is claimed by
    // every subsequent drain run, which is the infinite version of the bug.
    expect(markOrphaned).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: "events/event-1/images/img-1.png",
      }),
    );
  });

  it("never fires the uploader HOLD notification", async () => {
    const notify = vi.fn(async () => ({}));
    const { deps } = makeOrphanDeps({ notify });

    await drainImageModerations(deps, {});

    // FLAGGED is the only outcome that notifies. There is no image for the
    // uploader to act on, so a hold notice would be noise about nothing.
    expect(notify).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan circuit breaker.
//
// ORPHANED is terminal and unrecoverable by automation. That is correct for one
// object deleted out from under one record, and catastrophic if storage answers
// `not_found` for EVERY key — a whole batch would be terminally hidden per run,
// silently, until someone ran SQL. `mapS3Error` now keeps the known instance of
// that fault (a bad bucket) out of `not_found`; this is the backstop for the
// faults nobody has thought of yet.
// ─────────────────────────────────────────────────────────────────────────────

describe("drainImageModerations — orphan circuit breaker", () => {
  const ORPHAN: ModerateImageOutput = {
    status: "ORPHANED",
    maxSeverity: 0,
    degraded: false,
    noop: false,
  };

  it("stops the batch after 3 orphans and leaves the rest untouched", async () => {
    const notify = vi.fn(async () => ({}));
    const reportError = vi.fn();
    const moderateImage = vi.fn(async () => ORPHAN);
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ id: `rec-${i}`, storageKey: `events/e/img-${i}.png` }),
    );
    const { deps, markResult, markFailed } = makeDeps({
      records,
      moderateImage,
      notify,
      reportError,
    });

    const out = await drainImageModerations(deps, {});

    expect(out).toEqual({
      processed: 3,
      moderated: 0,
      orphaned: 3,
      removedBeforeScan: 0,
      retried: 0,
      deadLettered: 0,
      unprocessed: 7,
      // A tripped breaker ends the run: no second pass, no hand-off.
      passes: 1,
      hasMore: false,
    });

    // The breaker must STOP work, not do it differently: the 4th row onward is
    // never even handed to moderate-image.
    expect(moderateImage).toHaveBeenCalledTimes(3);
    // Nothing was written for the skipped rows — they stay PENDING with their
    // nextAttemptAt untouched, so the next scheduled run retries them.
    expect(markResult).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    // The stop is an anomaly a human needs to see.
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "image-moderation", reason: "orphan-breaker" },
        extra: expect.objectContaining({ orphaned: 3, unprocessed: 7 }),
      }),
    );
  });

  it("does not trip on an ordinary trickle of orphans", async () => {
    // Two orphans among other work is plausible — someone deleted two images.
    // The breaker must not turn that into a stalled queue.
    const moderateImage = vi.fn(async (key: string) =>
      key.endsWith("gone.png")
        ? ORPHAN
        : ({
            status: "APPROVED",
            maxSeverity: 0,
            degraded: false,
            noop: false,
          } as ModerateImageOutput),
    );
    const reportError = vi.fn();
    const { deps } = makeDeps({
      records: [
        makeRecord({ id: "a", storageKey: "events/e/gone.png" }),
        makeRecord({ id: "b", storageKey: "events/e/ok-1.png" }),
        makeRecord({ id: "c", storageKey: "events/e/gone.png" }),
        makeRecord({ id: "d", storageKey: "events/e/ok-2.png" }),
      ],
      moderateImage,
      reportError,
    });

    const out = await drainImageModerations(deps, {});

    expect(out).toMatchObject({
      processed: 4,
      moderated: 2,
      orphaned: 2,
      unprocessed: 0,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("place page images removed on purpose (a merge) never trip it", async () => {
    // merge-places deletes every page image of the duplicate with no grace,
    // so a moderator's unscanned photos all come back `not_found` in one run.
    const REMOVED: ModerateImageOutput = { ...ORPHAN, removedOnPurpose: true };
    const moderateImage = vi.fn(async () => REMOVED);
    const reportError = vi.fn();
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        id: `p-${i}`,
        kind: "PAGE_MEDIA",
        subjectType: "PLACE",
        subjectId: "place-1",
        storageKey: `entity-pages/place/place-1/2026-10-16/img-${i}.jpg`,
      }),
    );
    const { deps, markResult, markFailed, logger } = makeDeps({
      records,
      moderateImage,
      reportError,
    });

    const out = await drainImageModerations(deps, {});

    expect(out).toMatchObject({
      processed: 5,
      moderated: 0,
      orphaned: 0,
      removedBeforeScan: 5,
      unprocessed: 0,
    });
    expect(moderateImage).toHaveBeenCalledTimes(5);
    expect(markResult).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalledWith(
      "moderation.drainImageModerations.orphan_breaker_tripped",
      expect.anything(),
    );
  });

  it("removed-on-purpose rows do not bring real orphans closer to the breaker", async () => {
    const REMOVED: ModerateImageOutput = { ...ORPHAN, removedOnPurpose: true };
    const moderateImage = vi.fn(async (key: string) =>
      key.includes("removed") ? REMOVED : ORPHAN,
    );
    const reportError = vi.fn();
    const { deps } = makeDeps({
      records: [
        makeRecord({ id: "a", storageKey: "entity-pages/place/p/removed-1.jpg" }),
        makeRecord({ id: "b", storageKey: "events/e/gone-1.png" }),
        makeRecord({ id: "c", storageKey: "entity-pages/place/p/removed-2.jpg" }),
        makeRecord({ id: "d", storageKey: "events/e/gone-2.png" }),
        makeRecord({ id: "e", storageKey: "entity-pages/place/p/removed-3.jpg" }),
      ],
      moderateImage,
      reportError,
    });

    const out = await drainImageModerations(deps, {});

    expect(out).toMatchObject({
      processed: 5,
      orphaned: 2,
      removedBeforeScan: 3,
      unprocessed: 0,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a throwing reporter never stops the breaker from doing its job", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const { deps } = makeDeps({
      records: Array.from({ length: 6 }, (_, i) => makeRecord({ id: `r-${i}` })),
      moderateImage: async () => ORPHAN,
      reportError,
    });

    const out = await drainImageModerations(deps, {});

    expect(out).toMatchObject({ orphaned: 3, unprocessed: 3 });
  });
});

describe("drainImageModerations — maxOrphansPerRun is tunable", () => {
  const ORPHAN_OUT: ModerateImageOutput = {
    status: "ORPHANED",
    maxSeverity: 0,
    degraded: false,
    noop: false,
  };

  it("honours a raised threshold so an operator can work a backlog", async () => {
    // The breaker's default is deliberately tight, but a known backlog (e.g.
    // requeue-degraded revived rows whose objects were already swept) would
    // otherwise take ~34 runs to clear at 3 per run. An operator must be able
    // to raise the bar without a deploy — every other bound here is tunable.
    const moderateImage = vi.fn(async () => ORPHAN_OUT);
    const { deps } = makeDeps({
      records: Array.from({ length: 10 }, (_, i) =>
        makeRecord({ id: `rec-${i}` }),
      ),
      moderateImage,
    });

    const out = await drainImageModerations(deps, { maxOrphansPerRun: 8 });

    expect(out).toMatchObject({ processed: 8, orphaned: 8, unprocessed: 2 });
    expect(moderateImage).toHaveBeenCalledTimes(8);
  });

  it("defaults to 3 when the caller says nothing", async () => {
    const { deps } = makeDeps({
      records: Array.from({ length: 10 }, (_, i) =>
        makeRecord({ id: `rec-${i}` }),
      ),
      moderateImage: async () => ORPHAN_OUT,
    });

    const out = await drainImageModerations(deps, {});

    expect(out).toMatchObject({ orphaned: 3, unprocessed: 7 });
  });

  it("rejects a non-positive threshold rather than disabling the breaker", async () => {
    // `0` would make `orphaned >= 0` true on the first row and stall the queue
    // outright; a negative is meaningless. The schema is the guard.
    const { deps } = makeDeps({
      records: [makeRecord()],
      moderateImage: async () => ORPHAN_OUT,
    });

    await expect(
      drainImageModerations(deps, { maxOrphansPerRun: 0 }),
    ).rejects.toBeDefined();
  });
});
