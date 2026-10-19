import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModerationQueueHealth } from "@th/ports/repos/image-moderation-records";

import {
  MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY,
  fingerprintQueueHealth,
  reportModerationQueueHealth,
  type ReportModerationQueueHealthDeps,
} from "../report-moderation-queue-health";

/**
 * Edge-trigger gating for the hourly moderation health job.
 *
 * The job used to page whenever any count was non-zero. Two of the five counts
 * (`awaitingReview`, `degradedExhausted`) never fall back to zero on their own,
 * and prod holds at least one permanently-stuck record, so the owner got the
 * same Discord post every hour forever — which is how the August 2026 outage
 * signal ended up in a channel nobody read.
 *
 * These tests pin the SEND decision, not the counting. The counting tests live
 * next door in report-moderation-queue-health.test.ts and are unchanged.
 */

const HEALTHY: ModerationQueueHealth = {
  pendingOverdue: 0,
  awaitingReview: 0,
  degradedRecent: 0,
  degradedExhausted: 0,
  orphanedRecent: 0,
};

/**
 * An in-memory PlatformSetting store that behaves like the real one: `get`
 * returns null for a key never written, and `upsert("")` is how the row is
 * cleared (the repo has no delete).
 */
function makeSettingsStore() {
  const rows = new Map<string, { key: string; value: string; updatedAt: Date; createdAt: Date }>();
  // The honest implementation, kept separate so a test can wrap `upsert` with
  // a partial failure and still fall through to a real write.
  const rawUpsert = async (key: string, value: string) => {
    const row = {
      key,
      value,
      updatedAt: new Date(),
      createdAt: rows.get(key)?.createdAt ?? new Date(),
    };
    rows.set(key, row);
    return row;
  };
  const get = vi.fn(async (key: string) => rows.get(key) ?? null);
  const upsert = vi.fn(rawUpsert);
  return {
    rows,
    get,
    upsert,
    rawUpsert,
    getAll: vi.fn(async () => [...rows.values()]),
  };
}

type Harness = {
  /** Runs the job at `at`, with the given counts. Returns the use case output. */
  run: (
    at: string,
    counts: Partial<ModerationQueueHealth>,
    input?: Record<string, unknown>,
  ) => Promise<Awaited<ReturnType<typeof reportModerationQueueHealth>>>;
  settings: ReturnType<typeof makeSettingsStore>;
  reportError: ReturnType<typeof vi.fn>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
};

function makeHarness(
  overrides: { settings?: ReturnType<typeof makeSettingsStore> } = {},
): Harness {
  const settings = overrides.settings ?? makeSettingsStore();
  const reportError = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const child = {
    child: vi.fn(function (this: unknown) {
      return this;
    }),
    withTime: vi.fn(async (_n: string, f: () => Promise<unknown>) => f()),
    log: vi.fn(),
    info,
    warn,
    error,
  };
  const logger = { ...child, child: () => child };

  const run = async (
    at: string,
    counts: Partial<ModerationQueueHealth>,
    input: Record<string, unknown> = {},
  ) => {
    const deps: ReportModerationQueueHealthDeps = {
      repos: {
        imageModerationRecords: {
          countQueueHealth: vi.fn(async () => ({ ...HEALTHY, ...counts })),
        },
        platformSettings: settings,
      } as never,
      clock: { now: () => new Date(at) },
      logger: logger as never,
      reportError,
    };
    return reportModerationQueueHealth(deps, input);
  };

  return { run, settings, reportError, logger: { info, warn, error } };
}

describe("reportModerationQueueHealth — alert gating", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("alerts on the first sighting of a problem", async () => {
    const out = await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(out.unhealthy).toBe(true);
    expect(out.shouldAlert).toBe(true);
    expect(out.alertReason).toBe("changed");
  });

  it("stays quiet on the next hour when the picture has not changed", async () => {
    // THE BUG. Before edge-triggering, this second run sent the identical
    // Discord post, and so did the 8,758 runs after it.
    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });
    const second = await h.run("2026-09-01T01:05:00.000Z", {
      awaitingReview: 3,
    });

    expect(second.unhealthy).toBe(true);
    expect(second.shouldAlert).toBe(false);
    expect(second.alertReason).toBe("suppressed");
  });

  it("stays quiet on drift inside a magnitude bucket", async () => {
    // 3 → 4 is a backlog breathing, not news — the firing SET is unchanged.
    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });
    const drifted = await h.run("2026-09-01T01:05:00.000Z", {
      awaitingReview: 4,
    });

    expect(drifted.shouldAlert).toBe(false);
    expect(drifted.alertReason).toBe("suppressed");
  });

  it("alerts when a NEW category starts firing alongside the old one", async () => {
    // A dead drain arriving on top of a known review backlog is a new
    // incident, and must not be swallowed by the backlog's cooldown.
    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });
    const widened = await h.run("2026-09-01T01:05:00.000Z", {
      awaitingReview: 3,
      pendingOverdue: 1,
    });

    expect(widened.shouldAlert).toBe(true);
    expect(widened.alertReason).toBe("changed");
  });

  it("alerts when a category stops firing but others remain", async () => {
    // Partial recovery changes what an operator should be looking at.
    await h.run("2026-09-01T00:05:00.000Z", {
      awaitingReview: 3,
      pendingOverdue: 1,
    });
    const narrowed = await h.run("2026-09-01T01:05:00.000Z", {
      awaitingReview: 3,
    });

    expect(narrowed.shouldAlert).toBe(true);
    expect(narrowed.alertReason).toBe("changed");
  });

  it("re-alerts once reAlertAfterHours has elapsed, so a backlog is not forgotten", async () => {
    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    // 23h later: still inside the window.
    const quiet = await h.run("2026-09-01T23:05:00.000Z", {
      awaitingReview: 3,
    });
    expect(quiet.shouldAlert).toBe(false);

    // 24h after the SEND: the heartbeat.
    const beat = await h.run("2026-09-02T00:05:00.000Z", { awaitingReview: 3 });
    expect(beat.shouldAlert).toBe(true);
    expect(beat.alertReason).toBe("heartbeat");
  });

  it("restarts the window from the heartbeat, not from the first sighting", async () => {
    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });
    const beat = await h.run("2026-09-02T00:05:00.000Z", { awaitingReview: 3 });
    expect(beat.alertReason).toBe("heartbeat");

    const after = await h.run("2026-09-02T01:05:00.000Z", {
      awaitingReview: 3,
    });
    expect(after.shouldAlert).toBe(false);
    expect(after.alertReason).toBe("suppressed");
  });

  it("honours a custom reAlertAfterHours", async () => {
    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 }, {
      reAlertAfterHours: 2,
    });
    const beat = await h.run("2026-09-01T02:05:00.000Z", { awaitingReview: 3 }, {
      reAlertAfterHours: 2,
    });

    expect(beat.shouldAlert).toBe(true);
    expect(beat.alertReason).toBe("heartbeat");
  });

  it("clears stored state when everything is healthy", async () => {
    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });
    expect(
      h.settings.rows.get(MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY)?.value,
    ).toContain("awaitingReview");

    const healthy = await h.run("2026-09-01T01:05:00.000Z", {});

    expect(healthy.unhealthy).toBe(false);
    expect(healthy.shouldAlert).toBe(false);
    expect(healthy.alertReason).toBe("healthy");
    expect(
      h.settings.rows.get(MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY)?.value,
    ).toBe("");
  });

  it("does not write on a healthy run when there was nothing stored", async () => {
    // An hourly job on a healthy platform must not rewrite a row forever.
    await h.run("2026-09-01T00:05:00.000Z", {});

    expect(h.settings.upsert).not.toHaveBeenCalled();
  });

  it("ALERTS AGAIN when a resolved problem recurs identically", async () => {
    // The failure mode this whole design must not have: an incident that
    // resolves and comes back with the same shape is NEWS, and would be
    // silenced by a stale fingerprint if the healthy run did not clear state.
    const first = await h.run("2026-09-01T00:05:00.000Z", {
      awaitingReview: 3,
    });
    expect(first.shouldAlert).toBe(true);

    const recovered = await h.run("2026-09-01T01:05:00.000Z", {});
    expect(recovered.alertReason).toBe("healthy");

    const recurred = await h.run("2026-09-01T02:05:00.000Z", {
      awaitingReview: 3,
    });
    expect(recurred.shouldAlert).toBe(true);
    expect(recurred.alertReason).toBe("changed");
  });

  it("keeps logging the unhealthy line every run, even while suppressed", async () => {
    // The page gets rarer; the hourly read must not disappear from logs.
    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });
    await h.run("2026-09-01T01:05:00.000Z", { awaitingReview: 3 });

    expect(h.logger.warn).toHaveBeenCalledTimes(2);
    expect(h.logger.warn.mock.calls[1]?.[1]).toMatchObject({
      shouldAlert: false,
      alertReason: "suppressed",
    });
  });
});

describe("reportModerationQueueHealth — fingerprint", () => {
  it("ignores magnitude entirely — only whether a signal fires", () => {
    // Magnitude was deliberately removed. Bucketing counts meant a value
    // wobbling across a band edge paged every hour, which is the bug this
    // gate exists to remove. Escalation, if ever wanted, belongs in its own
    // signal with its own threshold.
    const at = (n: number) =>
      fingerprintQueueHealth({ ...HEALTHY, awaitingReview: n });

    expect(at(1)).toBe(at(2));
    expect(at(5)).toBe(at(6));
    expect(at(20)).toBe(at(21));
    expect(at(3)).toBe(at(4000));
    // Firing vs not firing is still the whole point.
    expect(at(0)).not.toBe(at(1));
  });

  it("does not depend on which key order the counts arrive in", () => {
    const a = fingerprintQueueHealth({
      pendingOverdue: 1,
      awaitingReview: 2,
      degradedRecent: 0,
      degradedExhausted: 0,
      orphanedRecent: 3,
    });
    const b = fingerprintQueueHealth({
      orphanedRecent: 3,
      degradedExhausted: 0,
      degradedRecent: 0,
      awaitingReview: 2,
      pendingOverdue: 1,
    } as ModerationQueueHealth);

    expect(a).toBe(b);
  });

  it("PINS the exact fingerprint string, table order included", () => {
    // The other tests here prove order-INDEPENDENCE of the input and
    // distinctness between signals — neither of which notices a reorder of
    // QUEUE_HEALTH_SIGNALS itself. A reorder changes the STORED string, so
    // every currently-suppressed incident re-pages once, and it changes the
    // order an operator reads the problems in. Both are silent under the
    // existing assertions; this literal is what makes them loud.
    //
    // Read together with the declaration order of QUEUE_HEALTH_SIGNALS and the
    // prose list in the use-case docblock: all three must agree.
    expect(
      fingerprintQueueHealth({
        pendingOverdue: 1,
        degradedRecent: 1,
        degradedExhausted: 1,
        orphanedRecent: 1,
        awaitingReview: 1,
      }),
    ).toBe(
      "pendingOverdue|degradedRecent|degradedExhausted|orphanedRecent|awaitingReview",
    );
    // And a partial firing set keeps table order rather than counts order.
    expect(
      fingerprintQueueHealth({
        ...HEALTHY,
        awaitingReview: 2,
        degradedRecent: 5,
      }),
    ).toBe("degradedRecent|awaitingReview");
  });

  it("distinguishes the same total spread across different categories", () => {
    // 4 stuck reviews and 4 dead-drain rows are different incidents.
    expect(
      fingerprintQueueHealth({ ...HEALTHY, awaitingReview: 4 }),
    ).not.toBe(fingerprintQueueHealth({ ...HEALTHY, pendingOverdue: 4 }));
  });

});

describe("reportModerationQueueHealth — storage failures fail toward sending", () => {
  it("still alerts, and reports, when the settings READ throws", async () => {
    const settings = makeSettingsStore();
    settings.get.mockRejectedValue(new Error("pg is down"));
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(out.shouldAlert).toBe(true);
    expect(out.alertReason).toBe("changed");
    expect(h.reportError).toHaveBeenCalledOnce();
    expect(h.reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { area: "image-moderation", operation: "read" },
    });
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("still alerts, and reports, when the settings WRITE throws", async () => {
    const settings = makeSettingsStore();
    settings.upsert.mockRejectedValue(new Error("pg is down"));
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(out.shouldAlert).toBe(true);
    expect(h.reportError).toHaveBeenCalledOnce();
    expect(h.reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { operation: "write" },
    });
  });

  it("reports when the healthy-run CLEAR throws, because a stale fingerprint silences a recurrence", async () => {
    const settings = makeSettingsStore();
    const h = makeHarness({ settings });
    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    settings.upsert.mockRejectedValue(new Error("pg is down"));
    const healthy = await h.run("2026-09-01T01:05:00.000Z", {});

    expect(healthy.alertReason).toBe("healthy");
    expect(h.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ operation: "clear" }) }),
    );
  });

  it("treats a corrupt stored value as no state and alerts", async () => {
    const settings = makeSettingsStore();
    await settings.upsert(MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY, "{not json");
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(out.shouldAlert).toBe(true);
    // Corruption is self-healing (the send overwrites the row) and is not
    // worth waking anyone for.
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("treats an unparseable sentAt as no state and alerts", async () => {
    const settings = makeSettingsStore();
    await settings.upsert(
      MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY,
      JSON.stringify({
        fingerprint: fingerprintQueueHealth({ ...HEALTHY, awaitingReview: 3 }),
        sentAt: "not-a-date",
      }),
    );
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(out.shouldAlert).toBe(true);
  });

  it("never lets a throwing reporter change the verdict", async () => {
    const settings = makeSettingsStore();
    settings.get.mockRejectedValue(new Error("pg is down"));
    const h = makeHarness({ settings });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is also down");
    });

    const out = await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(out.shouldAlert).toBe(true);
  });
});

/**
 * The clear is the ONE write in this file whose failure falls toward silence:
 * a dropped clear leaves the old fingerprint AND the old `sentAt`, so a
 * genuinely new incident with the same shape is suppressed for the rest of the
 * original window, and nothing links that silence to the write that failed.
 */
describe("reportModerationQueueHealth — a dropped clear must not silence a recurrence", () => {
  it("retries the clear once, so a transient failure does not suppress the next incident", async () => {
    const settings = makeSettingsStore();
    const h = makeHarness({ settings });

    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    // Fail ONLY the first clear attempt — a dropped pooled connection, a Neon
    // compute waking, a statement timeout. The retry should land.
    let clearFailuresLeft = 1;
    settings.upsert.mockImplementation(async (key: string, value: string) => {
      if (value === "" && clearFailuresLeft > 0) {
        clearFailuresLeft -= 1;
        throw new Error("connection terminated unexpectedly");
      }
      return settings.rawUpsert(key, value);
    });

    const recovered = await h.run("2026-09-01T01:05:00.000Z", {});
    expect(recovered.alertReason).toBe("healthy");
    expect(clearFailuresLeft).toBe(0);
    // The retry actually wrote.
    expect(
      settings.rows.get(MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY)?.value,
    ).toBe("");
    // A transient blip is not worth a page of its own.
    expect(h.reportError).not.toHaveBeenCalled();

    // THE POINT: the same problem comes back and must be heard.
    const recurred = await h.run("2026-09-01T02:05:00.000Z", {
      awaitingReview: 3,
    });
    expect(recurred.shouldAlert).toBe(true);
    expect(recurred.alertReason).toBe("changed");
  });

  it("reports loudly when BOTH clear attempts fail, naming the silence it may cause", async () => {
    // Pins the residual gap honestly: two failures in a row DO leave a stale
    // fingerprint, and the next identical incident is suppressed. The retry
    // narrows this window; it does not close it. If someone later removes the
    // retry, the test above goes red; if someone claims this case is handled,
    // this test says otherwise.
    const settings = makeSettingsStore();
    const h = makeHarness({ settings });

    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    settings.upsert.mockImplementation(async (key: string, value: string) => {
      if (value === "") throw new Error("connection terminated unexpectedly");
      return settings.rawUpsert(key, value);
    });

    await h.run("2026-09-01T01:05:00.000Z", {});

    expect(settings.upsert).toHaveBeenCalledTimes(3); // 1 send + 2 clear attempts
    expect(h.reportError).toHaveBeenCalledOnce();
    expect(h.reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { operation: "clear" },
    });
    const logged = h.logger.error.mock.calls.at(-1)?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(String(logged?.consequence)).toMatch(/suppress an identical recurrence/i);

    // The stale row survives, and the recurrence is suppressed. Documented, not
    // endorsed.
    const recurred = await h.run("2026-09-01T02:05:00.000Z", {
      awaitingReview: 3,
    });
    expect(recurred.alertReason).toBe("suppressed");
  });
});

describe("reportModerationQueueHealth — a future-dated sentAt must not stall the heartbeat", () => {
  const seedState = async (
    settings: ReturnType<typeof makeSettingsStore>,
    counts: Partial<ModerationQueueHealth>,
    sentAt: string,
  ) => {
    await settings.rawUpsert(
      MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY,
      JSON.stringify({
        fingerprint: fingerprintQueueHealth({ ...HEALTHY, ...counts }),
        sentAt,
      }),
    );
  };

  it("sends when the stored sentAt is in the future", async () => {
    // Clock skew on the writing run, or a clock stepped back afterwards. A bare
    // `elapsed >= window` reads a negative elapsed as "no time has passed" and
    // suppresses for skew + 24h — silence, and exactly the forgetting this file
    // promises not to do.
    const settings = makeSettingsStore();
    await seedState(settings, { awaitingReview: 3 }, "2026-09-05T00:00:00.000Z");
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(out.shouldAlert).toBe(true);
    expect(out.alertReason).toBe("heartbeat");
  });

  it("rewrites sentAt to the current clock, so the skew does not persist", async () => {
    const settings = makeSettingsStore();
    await seedState(settings, { awaitingReview: 3 }, "2026-09-05T00:00:00.000Z");
    const h = makeHarness({ settings });

    await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(
      settings.rows.get(MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY)?.value,
    ).toContain("2026-09-01T00:05:00.000Z");

    // And the window now behaves normally from the corrected timestamp.
    const next = await h.run("2026-09-01T01:05:00.000Z", { awaitingReview: 3 });
    expect(next.alertReason).toBe("suppressed");
  });

  it("still suppresses a normal, non-skewed picture inside the window", async () => {
    // Guards against "fix it by always sending", which would restore the bug.
    const settings = makeSettingsStore();
    await seedState(settings, { awaitingReview: 3 }, "2026-09-01T00:05:00.000Z");
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T01:05:00.000Z", { awaitingReview: 3 });

    expect(out.alertReason).toBe("suppressed");
  });
});

describe("reportModerationQueueHealth — corruption is diagnosable, not just survivable", () => {
  it("logs an error for unparseable JSON so recurring corruption is greppable", async () => {
    // No reportError: the row self-heals on the next send. But total silence
    // would leave "the hourly paging came back and nobody knows why" — the
    // noise this change removes, in disguise. logger.error is Sentry-captured
    // via pinoIntegration, so the symptom stays diagnosable.
    const settings = makeSettingsStore();
    await settings.rawUpsert(MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY, "{not json");
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(out.shouldAlert).toBe(true);
    expect(h.reportError).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledOnce();
    expect(h.logger.error.mock.calls[0]?.[0]).toBe(
      "moderationQueueHealth.alertState.corrupt",
    );
    expect(h.logger.error.mock.calls[0]?.[1]).toMatchObject({
      reason: "invalid_json",
    });
  });

  it("logs an error for a well-formed row of the wrong shape", async () => {
    const settings = makeSettingsStore();
    await settings.rawUpsert(
      MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY,
      JSON.stringify({ somethingElse: true }),
    );
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(out.shouldAlert).toBe(true);
    expect(h.logger.error.mock.calls[0]?.[1]).toMatchObject({
      reason: "unexpected_shape",
    });
  });

  it("logs an error for an unparseable sentAt", async () => {
    const settings = makeSettingsStore();
    await settings.rawUpsert(
      MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY,
      JSON.stringify({
        fingerprint: fingerprintQueueHealth({ ...HEALTHY, awaitingReview: 3 }),
        sentAt: "not-a-date",
      }),
    );
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T00:05:00.000Z", { awaitingReview: 3 });

    expect(out.shouldAlert).toBe(true);
    expect(h.logger.error.mock.calls[0]?.[1]).toMatchObject({
      reason: "unparseable_sentAt",
    });
  });
});

describe("reportModerationQueueHealth — one table drives both the copy and the fingerprint", () => {
  it("names every count in ModerationQueueHealth in the fingerprint", async () => {
    // A signal wired into `problems` but not the fingerprint raises `unhealthy`
    // without moving the string, so during any standing suppression window it
    // says nothing. The Record<keyof ModerationQueueHealth, …> in the use case
    // makes omission a COMPILE error; this pins the runtime half — every count
    // that can fire must appear in the fingerprint.
    const h = makeHarness();
    const allFiring: ModerationQueueHealth = {
      pendingOverdue: 1,
      awaitingReview: 1,
      degradedRecent: 1,
      degradedExhausted: 1,
      orphanedRecent: 1,
    };

    const out = await h.run("2026-09-01T00:05:00.000Z", allFiring);

    expect(out.problems).toHaveLength(Object.keys(allFiring).length);
    for (const key of Object.keys(allFiring)) {
      expect(out.fingerprint).toContain(key);
    }
  });

  it("moves the fingerprint whenever any single count starts firing", async () => {
    const keys: (keyof ModerationQueueHealth)[] = [
      "pendingOverdue",
      "awaitingReview",
      "degradedRecent",
      "degradedExhausted",
      "orphanedRecent",
    ];
    const baseline = fingerprintQueueHealth(HEALTHY);
    const seen = new Set<string>([baseline]);

    for (const key of keys) {
      const fp = fingerprintQueueHealth({ ...HEALTHY, [key]: 1 });
      expect(fp).not.toBe(baseline);
      expect(seen.has(fp)).toBe(false);
      seen.add(fp);
    }
  });
});
