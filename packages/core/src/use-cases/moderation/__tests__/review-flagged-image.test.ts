import { describe, expect, it, vi } from "vitest";

import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";

import { renderNotification } from "../../comms/renderers";
import {
  reviewFlaggedImage,
  type ReviewFlaggedImageDeps,
} from "../review-flagged-image";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const RECORD_ID = "00000000-0000-4000-8000-0000000000aa";
const UPLOADER = "00000000-0000-4000-8000-0000000000bb";
const STORAGE_KEY = "events/event-1/images/img-1.png";

function makeRecord(
  overrides?: Partial<ImageModerationRecord>,
): ImageModerationRecord {
  return {
    id: RECORD_ID,
    storageKey: STORAGE_KEY,
    kind: "EVENT_HERO",
    status: "FLAGGED",
    subjectType: "EVENT",
    subjectId: "event-1",
    publicUrl: "https://cdn.example/img-1.png",
    contentType: "image/png",
    createdByHumanId: UPLOADER,
    maxSeverity: 4,
    categories: [{ category: "SEXUAL", severity: 4 }],
    provider: "azure-content-safety",
    degraded: false,
    moderatedAt: new Date("2026-07-08T00:00:00.000Z"),
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
  record: ImageModerationRecord | null;
  /** Record returned by a SECOND getById (the lost-race re-read); defaults to `record`. */
  rereadRecord?: ImageModerationRecord | null;
  reviewResult?: number;
  notify?: ReturnType<typeof vi.fn>;
  reportError?: ReturnType<typeof vi.fn>;
  /** Event returned by the subject-enrichment lookup; undefined → the default. */
  event?: unknown;
  /** When set, the enrichment lookup throws this. */
  eventLookupError?: Error;
  appBaseUrl?: string | null;
}): {
  deps: ReviewFlaggedImageDeps;
  review: ReturnType<typeof vi.fn>;
  enqueueMany: ReturnType<typeof vi.fn>;
  auditLog: ReturnType<typeof vi.fn>;
  getEventById: ReturnType<typeof vi.fn>;
  logger: any;
} {
  const review = vi.fn(async () => args.reviewResult ?? 1);
  const enqueueMany = vi.fn(async () => {});
  const auditLog = vi.fn(async () => {});

  let getByIdCalls = 0;
  const getById = vi.fn(async () => {
    getByIdCalls += 1;
    // First call = the pre-CAS load; second call = the lost-race re-read.
    if (getByIdCalls === 1) return args.record;
    return "rereadRecord" in args ? args.rereadRecord : args.record;
  });

  const getEventById = vi.fn(async () => {
    if (args.eventLookupError) throw args.eventLookupError;
    return "event" in args ? args.event : EVENT;
  });

  const repos: any = {
    imageModerationRecords: { getById, review },
    pendingObjectDeletions: { enqueueMany },
    audit: { log: auditLog },
    events: { getById: getEventById },
    tx: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(repos)),
  };

  const logger = makeLogger();
  const deps: ReviewFlaggedImageDeps = {
    repos,
    notify: args.notify,
    clock: { now: () => NOW },
    logger,
    appBaseUrl: "appBaseUrl" in args ? args.appBaseUrl : "https://app.example",
    reportError: args.reportError,
  };
  return { deps, review, enqueueMany, auditLog, getEventById, logger };
}

describe("reviewFlaggedImage", () => {
  it("APPROVE flips to APPROVED, audits, and notifies the uploader", async () => {
    const notify = vi.fn(async () => ({}));
    const { deps, review, enqueueMany, auditLog } = makeDeps({
      record: makeRecord(),
      notify,
    });

    const out = await reviewFlaggedImage(deps, {
      actorHumanId: ACTOR,
      recordId: RECORD_ID,
      decision: "APPROVE",
    });

    expect(out).toEqual({ status: "APPROVED", alreadyDecided: false });
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        id: RECORD_ID,
        status: "APPROVED",
        reviewedByHumanId: ACTOR,
      }),
    );
    expect(enqueueMany).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: UPLOADER,
        variant: "image.moderation.approved",
        idempotencyKey: `image-moderation-approved:${RECORD_ID}`,
        payload: expect.objectContaining({
          subjectTitle: "Night Market Sessions",
          subjectUrl: "https://app.example/events/night-market-sessions",
        }),
      }),
    );
  });

  it("REJECT enqueues R2 deletion, audits, and notifies", async () => {
    const notify = vi.fn(async () => ({}));
    const { deps, enqueueMany, auditLog } = makeDeps({
      record: makeRecord(),
      notify,
    });

    const out = await reviewFlaggedImage(deps, {
      actorHumanId: ACTOR,
      recordId: RECORD_ID,
      decision: "REJECT",
      note: "explicit content",
    });

    expect(out).toEqual({ status: "REJECTED", alreadyDecided: false });
    expect(enqueueMany).toHaveBeenCalledWith([
      expect.objectContaining({
        targetKey: STORAGE_KEY,
        targetKind: "KEY",
        source: "image-moderation-reject",
        sourceId: RECORD_ID,
      }),
    ]);
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "image.moderation.rejected",
        idempotencyKey: `image-moderation-rejected:${RECORD_ID}`,
        payload: expect.objectContaining({ note: "explicit content" }),
      }),
    );
  });

  it("on a lost cross-decision race returns the ACTUAL status, not the attempted decision", async () => {
    // This call REJECTs, but a peer already APPROVEd: the FLAGGED CAS affects 0
    // rows and the re-read shows APPROVED. The moderator must be told APPROVED
    // (+ alreadyDecided), never "REJECTED" while the image is live.
    const notify = vi.fn(async () => ({}));
    const { deps, enqueueMany, auditLog } = makeDeps({
      record: makeRecord(),
      rereadRecord: makeRecord({
        status: "APPROVED",
        reviewedByHumanId: "00000000-0000-4000-8000-0000000000cc",
      }),
      reviewResult: 0,
      notify,
    });

    const out = await reviewFlaggedImage(deps, {
      actorHumanId: ACTOR,
      recordId: RECORD_ID,
      decision: "REJECT",
    });

    expect(out).toEqual({ status: "APPROVED", alreadyDecided: true });
    expect(enqueueMany).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports a notify-failure swallow to Sentry (guarded), without failing the decision", async () => {
    const notify = vi.fn(async () => {
      throw new Error("mailer down");
    });
    const reportError = vi.fn();
    const { deps } = makeDeps({ record: makeRecord(), notify, reportError });

    const out = await reviewFlaggedImage(deps, {
      actorHumanId: ACTOR,
      recordId: RECORD_ID,
      decision: "APPROVE",
    });

    // Decision still committed despite the notify failure.
    expect(out).toEqual({ status: "APPROVED", alreadyDecided: false });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { area: "image-moderation", reason: "notify-failed" },
        extra: expect.objectContaining({ recordId: RECORD_ID, decision: "APPROVE" }),
      }),
    );
  });

  it("fails when the record does not exist", async () => {
    const { deps } = makeDeps({ record: null });

    await expect(
      reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision: "APPROVE",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns already-decided (no-op) when the record was APPROVED before the read", async () => {
    const notify = vi.fn(async () => ({}));
    const { deps, review, enqueueMany, auditLog } = makeDeps({
      record: makeRecord({
        status: "APPROVED",
        reviewedByHumanId: "00000000-0000-4000-8000-0000000000cc",
      }),
      notify,
    });

    const out = await reviewFlaggedImage(deps, {
      actorHumanId: ACTOR,
      recordId: RECORD_ID,
      decision: "REJECT",
    });

    expect(out).toEqual({ status: "APPROVED", alreadyDecided: true });
    // No new decision side effects.
    expect(review).not.toHaveBeenCalled();
    expect(enqueueMany).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("returns already-decided (no-op) when the record was REJECTED before the read", async () => {
    const notify = vi.fn(async () => ({}));
    const { deps, review, enqueueMany, auditLog } = makeDeps({
      record: makeRecord({
        status: "REJECTED",
        reviewedByHumanId: "00000000-0000-4000-8000-0000000000cc",
      }),
      notify,
    });

    const out = await reviewFlaggedImage(deps, {
      actorHumanId: ACTOR,
      recordId: RECORD_ID,
      decision: "APPROVE",
    });

    expect(out).toEqual({ status: "REJECTED", alreadyDecided: true });
    expect(review).not.toHaveBeenCalled();
    expect(enqueueMany).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("fails with INVALID_STATUS when the record is still PENDING (not yet flagged)", async () => {
    const { deps, review } = makeDeps({
      record: makeRecord({ status: "PENDING" }),
    });

    await expect(
      reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision: "APPROVE",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    expect(review).not.toHaveBeenCalled();
  });

  describe("decision-notice subject enrichment", () => {
    it("names the event and links it by SLUG on a REJECT", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps, getEventById } = makeDeps({
        record: makeRecord(),
        notify,
      });

      await reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision: "REJECT",
        note: "Please use a different photo.",
      });

      expect(getEventById).toHaveBeenCalledTimes(1);
      expect(getEventById).toHaveBeenCalledWith("event-1");
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "image.moderation.rejected",
          payload: expect.objectContaining({
            subjectTitle: "Night Market Sessions",
            subjectUrl: "https://app.example/events/night-market-sessions",
            note: "Please use a different photo.",
          }),
        }),
      );
    });

    it("still notifies with nulls (and reports) when the lookup throws", async () => {
      const notify = vi.fn(async () => ({}));
      const reportError = vi.fn();
      const { deps, logger } = makeDeps({
        record: makeRecord(),
        notify,
        reportError,
        eventLookupError: new Error("db down"),
      });

      const out = await reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision: "APPROVE",
      });

      // The decision is already committed — enrichment never blocks it.
      expect(out).toEqual({ status: "APPROVED", alreadyDecided: false });
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            subjectTitle: null,
            subjectUrl: null,
          }),
        }),
      );
      expect(logger.error).toHaveBeenCalledWith(
        "moderation.subjectLookupFailed",
        expect.objectContaining({ recordId: RECORD_ID, subjectId: "event-1" }),
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

    it("passes nulls and does NOT look anything up for non-EVENT subjects", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps, getEventById } = makeDeps({
        record: makeRecord({
          kind: "AVATAR",
          subjectType: "HUMAN",
          subjectId: UPLOADER,
        }),
        notify,
      });

      await reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision: "APPROVE",
      });

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

    it("emits payloads the STRICT approved/rejected renderers accept end to end", async () => {
      for (const decision of ["APPROVE", "REJECT"] as const) {
        const notify = vi.fn(async () => ({}));
        const { deps } = makeDeps({ record: makeRecord(), notify });

        await reviewFlaggedImage(deps, {
          actorHumanId: ACTOR,
          recordId: RECORD_ID,
          decision,
        });

        const { variant, payload } = (notify.mock.calls[0] as any[])[0];
        const rendered = renderNotification(variant, payload, {
          now: NOW,
        });
        expect(rendered.inApp?.action).toEqual({
          label: "View event",
          route: "/events/night-market-sessions",
        });
        expect(rendered.inApp?.body).toContain("Night Market Sessions");
      }
    });

    it("degrades both URLs to null when the base URL is malformed", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({
        record: makeRecord(),
        notify,
        appBaseUrl: "ithasfire.com",
      });

      await reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision: "REJECT",
      });

      const { variant, payload } = (notify.mock.calls[0] as any[])[0];
      expect(payload).toMatchObject({
        subjectTitle: "Night Market Sessions",
        subjectUrl: null,
        helpUrl: null,
      });
      expect(() =>
        renderNotification(variant, payload, { now: NOW }),
      ).not.toThrow();
    });

    it("still links a non-PUBLISHED event — its page renders", async () => {
      // See the matching drain test: the event route has no status gate.
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({
        record: makeRecord(),
        notify,
        event: {
          id: "event-1",
          title: "Night Market Sessions",
          slug: "night-market-sessions",
          status: "DRAFT",
        },
      });

      await reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision: "APPROVE",
      });

      expect((notify.mock.calls[0] as any[])[0].payload).toMatchObject({
        subjectTitle: "Night Market Sessions",
        subjectUrl: "https://app.example/events/night-market-sessions",
      });
    });

    it("carries the Help Center link on approvals and rejections too", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({ record: makeRecord(), notify });

      await reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision: "APPROVE",
      });

      expect((notify.mock.calls[0] as any[])[0].payload).toMatchObject({
        helpUrl: "https://app.example/help",
      });
    });

    it("names the event without a link when no appBaseUrl is configured", async () => {
      const notify = vi.fn(async () => ({}));
      const { deps } = makeDeps({
        record: makeRecord(),
        notify,
        appBaseUrl: null,
      });

      await reviewFlaggedImage(deps, {
        actorHumanId: ACTOR,
        recordId: RECORD_ID,
        decision: "APPROVE",
      });

      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            subjectTitle: "Night Market Sessions",
            subjectUrl: null,
          }),
        }),
      );
    });
  });
});
