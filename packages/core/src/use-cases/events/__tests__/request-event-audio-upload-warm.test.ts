import { describe, expect, it, vi } from "vitest";

import {
  requestEventAudioUpload,
  WARM_UP_WAIT_MS,
  type RequestEventAudioUploadDeps,
} from "../request-event-audio-upload";
import type { EventRecord } from "@th/ports/repos/events";

/**
 * Upload start wakes the audio transcoder.
 *
 * Prod runs the transcoder at min 0 instances (owner, 2026-10-17: the warm
 * instance cost $25.82 in 30 days for 3 uploads). The cold start is hidden by
 * waking it when the upload STARTS, so the boot overlaps the browser's PUT.
 * The upload must succeed whatever the warm-up does and waits for it at most
 * WARM_UP_WAIT_MS (the API's CPU is throttled after the response, so a fully
 * un-awaited publish could stall). A failure is a deliberate swallow, so it is
 * reported (ReporterPort).
 */

const EVENT_ID = "50000000-0000-4000-8000-000000000001";
const OWNER_ID = "50000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-17T12:00:00.000Z");

const INPUT = {
  actorHumanId: OWNER_ID,
  eventId: EVENT_ID,
  contentType: "audio/mpeg",
  sizeBytes: 1234,
};

/** Let the fire-and-forget warm-up chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function buildDeps(
  extra: Pick<RequestEventAudioUploadDeps, "warmTranscoder" | "reportError">,
) {
  const event = {
    id: EVENT_ID,
    orgId: null,
    humanId: OWNER_ID,
    stewardship: "OWNED",
    status: "DRAFT",
    title: "Owned Show",
    startsAt: NOW,
    endsAt: NOW,
  } as EventRecord;
  const create = vi.fn(async () => ({}));
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const deps: RequestEventAudioUploadDeps = {
    repos: {
      events: { getById: vi.fn(async () => event) },
      audioUploads: { create },
      resourceQuotas: {
        getEffectiveQuota: vi.fn(async () => ({
          kind: "STORAGE_BYTES_HUMAN" as const,
          limitValue: 10_000_000_000n,
          currentUsage: 0n,
          isOverride: false,
        })),
        hasPendingExpansionRequest: vi.fn(async () => false),
        incrementUsage: vi.fn(async () => ({})),
      },
      tx: vi.fn(),
    } as unknown as RequestEventAudioUploadDeps["repos"],
    authz: {
      canEditEvent: vi.fn(async () => ({ allowed: true })),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as RequestEventAudioUploadDeps["authz"],
    fileStorage: {
      presignPutObject: vi.fn(async () => ({
        uploadUrl: "https://r2.example/put",
      })),
    } as unknown as RequestEventAudioUploadDeps["fileStorage"],
    logger: logger as unknown as RequestEventAudioUploadDeps["logger"],
    ...extra,
  };

  return { deps, create, logger };
}

describe("requestEventAudioUpload — transcoder warm-up", () => {
  it("wakes the transcoder once, before presign and the upload row, so they overlap", async () => {
    const warmTranscoder = vi.fn(async () => undefined);
    const reportError = vi.fn();
    const { deps, create } = buildDeps({ warmTranscoder, reportError });

    const result = await requestEventAudioUpload(deps, INPUT);

    expect(result.uploadUrl).toBe("https://r2.example/put");
    expect(warmTranscoder).toHaveBeenCalledTimes(1);
    expect(warmTranscoder.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      create.mock.invocationCallOrder[0] ?? 0,
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("waits for a slow warm-up at most WARM_UP_WAIT_MS, then returns anyway", async () => {
    vi.useFakeTimers();
    try {
      const warmTranscoder = vi.fn(() => new Promise<void>(() => {}));
      const { deps } = buildDeps({ warmTranscoder });

      let settled = false;
      const running = requestEventAudioUpload(deps, INPUT).then((r) => {
        settled = true;
        return r;
      });

      await vi.advanceTimersByTimeAsync(WARM_UP_WAIT_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const result = await running;
      expect(settled).toBe(true);
      expect(result.audioUploadId).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still succeeds when the warm-up rejects, and logs and reports it", async () => {
    const failure = new Error("pubsub publish 403");
    const warmTranscoder = vi.fn(async () => {
      throw failure;
    });
    const reportError = vi.fn();
    const { deps, logger } = buildDeps({ warmTranscoder, reportError });

    const result = await requestEventAudioUpload(deps, INPUT);
    await flush();

    expect(result.uploadUrl).toBe("https://r2.example/put");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(failure, {
      tags: { useCase: "requestEventAudioUpload", stage: "warm_transcoder" },
      extra: { audioUploadId: result.audioUploadId, eventId: EVENT_ID },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "Audio transcoder warm-up failed",
      expect.objectContaining({ err: failure, eventId: EVENT_ID }),
    );
  });

  it("still succeeds when the warm-up throws synchronously", async () => {
    const failure = new Error("boom");
    const warmTranscoder = vi.fn((): Promise<void> => {
      throw failure;
    });
    const reportError = vi.fn();
    const { deps } = buildDeps({ warmTranscoder, reportError });

    const result = await requestEventAudioUpload(deps, INPUT);

    expect(result.uploadUrl).toBe("https://r2.example/put");
    expect(reportError).toHaveBeenCalledWith(failure, expect.anything());
  });

  it("a throwing reporter changes nothing", async () => {
    const warmTranscoder = vi.fn(async () => {
      throw new Error("pubsub down");
    });
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const { deps } = buildDeps({ warmTranscoder, reportError });

    const result = await requestEventAudioUpload(deps, INPUT);
    await flush();

    expect(result.uploadUrl).toBe("https://r2.example/put");
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("does not warm when the upload is refused", async () => {
    const warmTranscoder = vi.fn(async () => undefined);
    const { deps } = buildDeps({ warmTranscoder });
    (deps.authz.canEditEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: false,
    });

    await expect(requestEventAudioUpload(deps, INPUT)).rejects.toMatchObject({
      code: "NOT_AUTHORIZED",
    });
    expect(warmTranscoder).not.toHaveBeenCalled();
  });

  it("no warmTranscoder dep: the upload is unchanged", async () => {
    const { deps } = buildDeps({});

    const result = await requestEventAudioUpload(deps, INPUT);

    expect(result.uploadUrl).toBe("https://r2.example/put");
  });
});
