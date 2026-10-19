import { describe, expect, it, vi } from "vitest";

import type { ModerationQueueHealth } from "@th/ports/repos/image-moderation-records";

import {
  getModerationQueueSnapshot,
  listModerationQueueSignal,
  type ModerationQueueSnapshotDeps,
} from "../get-moderation-queue-snapshot";
import { reportModerationQueueHealth } from "../report-moderation-queue-health";

const NOW = new Date("2026-08-20T18:00:00.000Z");

const HEALTHY: ModerationQueueHealth = {
  pendingOverdue: 0,
  awaitingReview: 0,
  degradedRecent: 0,
  degradedExhausted: 0,
  orphanedRecent: 0,
};

const RECORD = {
  id: "rec-1",
  storageKey: "events/e1/hero.jpg",
  kind: "EVENT_HERO" as const,
  status: "FLAGGED" as const,
  subjectType: "EVENT" as const,
  subjectId: "e1",
  publicUrl: "https://cdn.example.com/events/e1/hero.jpg",
  contentType: "image/jpeg",
  createdByHumanId: "human-1",
  maxSeverity: 6,
  categories: [{ category: "HATE" as const, severity: 6 }],
  provider: "azure-content-safety",
  degraded: true,
  moderatedAt: new Date("2026-08-20T17:30:00.000Z"),
  reviewedByHumanId: null,
  reviewedAt: null,
  reviewNote: "held",
  attempts: 5,
  lastError: "azure 401",
  nextAttemptAt: new Date("2026-08-20T17:45:00.000Z"),
  requeues: 2,
  createdAt: NOW,
  updatedAt: NOW,
};

const NO_TOTALS = { awaitingReviewAll: 0, orphanedAll: 0 };
const HEALTHY_OUTBOX = { dead: 0, overdue: 0 };

function makeDeps(
  counts: Partial<ModerationQueueHealth> = {},
  items: (typeof RECORD)[] = [],
  extras: {
    totals?: Partial<typeof NO_TOTALS>;
    outbox?: Partial<typeof HEALTHY_OUTBOX>;
  } = {},
) {
  const countQueueHealth = vi.fn(async () => ({ ...HEALTHY, ...counts }));
  const countQueueTotals = vi.fn(async () => ({
    ...NO_TOTALS,
    ...extras.totals,
  }));
  const listQueueHealthSignal = vi.fn(async () => ({
    items,
    nextCursor: null as string | null,
  }));
  const countOutboxHealth = vi.fn(async () => ({
    ...HEALTHY_OUTBOX,
    ...extras.outbox,
  }));
  const deps = {
    repos: {
      imageModerationRecords: {
        countQueueHealth,
        countQueueTotals,
        listQueueHealthSignal,
      },
      pendingObjectDeletions: { countOutboxHealth },
    },
    clock: { now: () => NOW },
  } as unknown as ModerationQueueSnapshotDeps;
  return {
    deps,
    countQueueHealth,
    countQueueTotals,
    listQueueHealthSignal,
    countOutboxHealth,
  };
}

describe("getModerationQueueSnapshot", () => {
  it("returns the five counts from the repo untouched", async () => {
    const { deps } = makeDeps({ pendingOverdue: 7, orphanedRecent: 12 });

    const out = await getModerationQueueSnapshot(deps);

    expect(out.counts).toEqual({
      ...HEALTHY,
      pendingOverdue: 7,
      orphanedRecent: 12,
    });
  });

  it("derives every cutoff from the injected clock, matching the alert job exactly", async () => {
    // Not "similar to" — IDENTICAL. Both callers go through
    // `deriveQueueHealthCutoffs`, so this asserts the same four instants the
    // health job's own test pins (report-moderation-queue-health.test.ts).
    const { deps, countQueueHealth } = makeDeps();

    await getModerationQueueSnapshot(deps, {
      pendingOverdueMinutes: 60,
      awaitingReviewHours: 24,
      degradedWindowMinutes: 120,
      maxRequeues: 3,
    });

    expect(countQueueHealth).toHaveBeenCalledWith({
      pendingDueBefore: new Date("2026-08-20T17:00:00.000Z"),
      moderatedBefore: new Date("2026-08-19T18:00:00.000Z"),
      degradedSince: new Date("2026-08-20T16:00:00.000Z"),
      maxRequeues: 3,
    });
  });

  it("defaults to the same knobs the hourly alert uses", async () => {
    // The page must not quietly show a different window from the one that
    // pages people. Called with NO input, both must land on the same cutoffs.
    const snapshotDeps = makeDeps();
    await getModerationQueueSnapshot(snapshotDeps.deps);

    const alertCount = vi.fn(async () => HEALTHY);
    const settings = new Map<string, string>();
    const noop = vi.fn();
    const child = {
      child: vi.fn(function (this: unknown) {
        return this;
      }),
      withTime: vi.fn(async (_n: string, f: () => Promise<unknown>) => f()),
      log: noop,
      info: noop,
      warn: noop,
      error: noop,
    };
    await reportModerationQueueHealth({
      repos: {
        imageModerationRecords: { countQueueHealth: alertCount },
        platformSettings: {
          get: vi.fn(async (key: string) =>
            settings.has(key)
              ? { key, value: settings.get(key)!, updatedAt: NOW, createdAt: NOW }
              : null,
          ),
          getAll: vi.fn(async () => []),
          upsert: vi.fn(async (key: string, value: string) => {
            settings.set(key, value);
            return { key, value, updatedAt: NOW, createdAt: NOW };
          }),
        },
      },
      clock: { now: () => NOW },
      logger: { ...child, child: () => child },
    } as never);

    const snapshotArgs = (snapshotDeps.countQueueHealth.mock
      .calls as unknown[][])[0]![0];
    const alertArgs = (alertCount.mock.calls as unknown[][])[0]![0];
    expect(snapshotArgs).toEqual(alertArgs);
  });

  it("echoes the window so the UI can label a tile without hardcoding it", async () => {
    const { deps } = makeDeps();

    const out = await getModerationQueueSnapshot(deps, {
      degradedWindowMinutes: 30,
    });

    expect(out.thresholds).toEqual({
      pendingOverdueMinutes: 90,
      awaitingReviewHours: 24,
      degradedWindowMinutes: 30,
      maxRequeues: 3,
    });
    expect(out.cutoffs.degradedSince).toEqual(
      new Date("2026-08-20T17:30:00.000Z"),
    );
    expect(out.observedAt).toEqual(NOW);
  });

  it("NEVER touches platformSettings — a page load must not reset the alert state", async () => {
    // THE constraint of this file. `reportModerationQueueHealth` WRITES
    // `PlatformSetting["moderation:queueHealthAlertState"]` as part of its
    // edge-trigger gate, so a page-backed query that reused it would reset the
    // Discord fingerprint (and re-arm a suppressed alert) on every page load.
    // A throwing proxy is the clearest form of the assertion: any read of any
    // key, by any code path, fails the test loudly.
    const explode = new Proxy(
      {},
      {
        get(_t, key) {
          throw new Error(
            `get-moderation-queue-snapshot touched platformSettings.${String(key)}`,
          );
        },
      },
    );
    const { deps } = makeDeps({ pendingOverdue: 3 });
    const withSettings = {
      ...deps,
      repos: { ...deps.repos, platformSettings: explode },
    } as unknown as ModerationQueueSnapshotDeps;

    await expect(
      getModerationQueueSnapshot(withSettings),
    ).resolves.toMatchObject({ counts: { pendingOverdue: 3 } });

    await expect(
      listModerationQueueSignal(withSettings, {
        signal: "pendingOverdue",
        pendingDueBefore: new Date("2026-08-20T17:00:00.000Z"),
        moderatedBefore: new Date("2026-08-19T18:00:00.000Z"),
        degradedSince: new Date("2026-08-20T16:00:00.000Z"),
        maxRequeues: 3,
      }),
    ).resolves.toMatchObject({ signal: "pendingOverdue" });
  });

  it("propagates a repo failure instead of rendering an all-clear", async () => {
    // A swallow here would show zeroes during exactly the outage the page
    // exists to surface — and per CLAUDE.md would owe a reportError branch.
    // Throwing is both simpler and more honest for a read query.
    const boom = new Error("db down");
    const deps = {
      repos: {
        imageModerationRecords: {
          countQueueHealth: vi.fn(async () => {
            throw boom;
          }),
          countQueueTotals: vi.fn(async () => NO_TOTALS),
        },
        pendingObjectDeletions: {
          countOutboxHealth: vi.fn(async () => HEALTHY_OUTBOX),
        },
      },
      clock: { now: () => NOW },
    } as unknown as ModerationQueueSnapshotDeps;

    await expect(getModerationQueueSnapshot(deps)).rejects.toThrow("db down");
  });

  it("reports ALL-TIME totals beside the windowed counts", async () => {
    // THE comprehension trap this closes: six images flagged this morning are
    // none of them 24h old, so `awaitingReview` reads 0 and the tile is green
    // while six people wait. The totals are what make that legible.
    const { deps } = makeDeps(
      { awaitingReview: 0, orphanedRecent: 0 },
      [],
      { totals: { awaitingReviewAll: 6, orphanedAll: 4102 } },
    );

    const out = await getModerationQueueSnapshot(deps);

    expect(out.counts.awaitingReview).toBe(0);
    expect(out.totals).toEqual({ awaitingReviewAll: 6, orphanedAll: 4102 });
  });

  it("keeps totals OUT of `counts` — the alert's five predicates are untouched", async () => {
    // Structural, not cosmetic. `counts` is what the hourly Discord job pages
    // about, key for key; `report-moderation-queue-health.ts` types its signal
    // table as a TOTAL Record over those keys, so a sixth key there would
    // compile-force new alert copy and a new fingerprint segment — a new thing
    // that wakes someone up. A totals field leaking into `counts` is the
    // shape of that mistake, and this is what catches it.
    const { deps } = makeDeps({}, [], {
      totals: { awaitingReviewAll: 6, orphanedAll: 9 },
    });

    const out = await getModerationQueueSnapshot(deps);

    expect(Object.keys(out.counts).sort()).toEqual([
      "awaitingReview",
      "degradedExhausted",
      "degradedRecent",
      "orphanedRecent",
      "pendingOverdue",
    ]);
  });

  it("counts the REJECT deletion outbox, scoped to moderation's own rows", async () => {
    // A REJECT enqueues the R2 object in the same tx as the decision. If that
    // outbox stalls we have told an uploader their image was removed while the
    // bytes are still on a public CDN — and the moderation record still reads
    // REJECTED, which is true and beside the point.
    const { deps, countOutboxHealth } = makeDeps({}, [], {
      outbox: { dead: 2, overdue: 11 },
    });

    const out = await getModerationQueueSnapshot(deps);

    expect(out.deletionOutbox).toEqual({
      dead: 2,
      overdue: 11,
      // 60m default grace before NOW.
      dueBefore: new Date("2026-08-20T17:00:00.000Z"),
      overdueMinutes: 60,
      source: "image-moderation-reject",
    });
    expect(countOutboxHealth).toHaveBeenCalledWith({
      dueBefore: new Date("2026-08-20T17:00:00.000Z"),
      // The `source` scope is the difference between "images we told an
      // uploader we removed" and "everything anyone ever queued for deletion".
      source: "image-moderation-reject",
    });
  });

  it("NEVER measures deletion-overdue against `now` — every fresh row is due", async () => {
    // `nextAttemptAt` defaults to now() on enqueue, so a zero grace period
    // would count normal in-flight work and the tile would be loudest on the
    // outbox's healthiest days.
    const { deps, countOutboxHealth } = makeDeps();

    await getModerationQueueSnapshot(deps, { deletionOverdueMinutes: 5 });

    const arg = (countOutboxHealth.mock.calls as unknown[][])[0]![0] as {
      dueBefore: Date;
    };
    expect(arg.dueBefore.getTime()).toBeLessThan(NOW.getTime());
    expect(arg.dueBefore).toEqual(new Date("2026-08-20T17:55:00.000Z"));
  });

  it("propagates an outbox-count failure rather than showing a healthy tile", async () => {
    const { deps } = makeDeps();
    (
      deps.repos.pendingObjectDeletions as unknown as {
        countOutboxHealth: ReturnType<typeof vi.fn>;
      }
    ).countOutboxHealth.mockRejectedValueOnce(new Error("outbox down"));

    await expect(getModerationQueueSnapshot(deps)).rejects.toThrow(
      "outbox down",
    );
  });

  it("rejects unknown input keys", async () => {
    const { deps } = makeDeps();

    await expect(
      getModerationQueueSnapshot(deps, { signal: "pendingOverdue" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("listModerationQueueSignal", () => {
  // The drill-down takes ABSOLUTE cutoffs — exactly what `queueSnapshot`
  // returned — so the list and the tile cannot drift. These are the instants a
  // snapshot at NOW with default knobs produces.
  const WINDOW = {
    pendingDueBefore: new Date("2026-08-20T17:00:00.000Z"),
    moderatedBefore: new Date("2026-08-19T18:00:00.000Z"),
    degradedSince: new Date("2026-08-20T16:00:00.000Z"),
    maxRequeues: 3,
  };

  it("passes the caller's cutoffs straight through, plus the bucket", async () => {
    const { deps, listQueueHealthSignal } = makeDeps();

    await listModerationQueueSignal(deps, {
      ...WINDOW,
      signal: "degradedExhausted",
      limit: 10,
      cursor: "rec-0",
    });

    expect(listQueueHealthSignal).toHaveBeenCalledWith({
      ...WINDOW,
      signal: "degradedExhausted",
      limit: 10,
      cursor: "rec-0",
    });
  });

  it("reads NO clock — the window is the caller's, not a fresh one", async () => {
    // THE anti-drift property. A tile counted at 12:00:00 and a list built at
    // 12:00:40 disagree, and for the two `degradedSince` buckets the window
    // shrinks at the same end the DESC cursor walks toward, so a cursor row can
    // fall out of the set between pages and Prisma's `skip: 1` silently eats a
    // real row. A throwing clock proves no second `now` is taken.
    const explodingClock = {
      now: () => {
        throw new Error("listModerationQueueSignal read the clock");
      },
    };
    const { deps, listQueueHealthSignal } = makeDeps();

    await listModerationQueueSignal(
      { ...deps, clock: explodingClock } as never,
      { ...WINDOW, signal: "degradedRecent" },
    );

    expect(listQueueHealthSignal).toHaveBeenCalledWith(
      expect.objectContaining({ degradedSince: WINDOW.degradedSince }),
    );
  });

  it("echoes the window back verbatim so the page can match list to tile", async () => {
    const { deps } = makeDeps();

    const out = await listModerationQueueSignal(deps, {
      ...WINDOW,
      signal: "pendingOverdue",
    });

    expect(out.cutoffs).toEqual({
      pendingDueBefore: WINDOW.pendingDueBefore,
      moderatedBefore: WINDOW.moderatedBefore,
      degradedSince: WINDOW.degradedSince,
    });
    expect(out.maxRequeues).toBe(3);
    // No `observedAt` / `thresholds` here: there is no second clock read and no
    // relative knob to report.
    expect(out).not.toHaveProperty("observedAt");
    expect(out).not.toHaveProperty("thresholds");
  });

  it("accepts the useInfiniteQuery wire shape: a null cursor and a direction key", async () => {
    // `useInfiniteQuery` feeds `getNextPageParam`'s return value straight back
    // in — and `nextCursor` is `string | null`, so the LAST page hands back
    // null. It also injects a top-level `direction` on EVERY request. A
    // `.strict()` schema without both rejects the first paginated load with
    // `unrecognized_keys` and the last one with `invalid_type`. Mirrors
    // `listFlaggedImages`.
    const { deps, listQueueHealthSignal } = makeDeps();

    await listModerationQueueSignal(deps, {
      ...WINDOW,
      signal: "orphanedRecent",
      cursor: null,
      direction: "forward",
    });

    // null normalises to "no cursor", and `direction` is accepted and dropped.
    expect(listQueueHealthSignal).toHaveBeenCalledWith({
      ...WINDOW,
      signal: "orphanedRecent",
      limit: 30,
      cursor: undefined,
    });
  });

  it("withholds storageKey AND lastError for awaitingReview", async () => {
    // Dropping `publicUrl` alone was theatre. R2 composes public URLs by string
    // join (`${publicBaseUrl}/${key}`) and moderation gating is app-side, not
    // at the CDN, and the base URL is in every published event's markup. So a
    // DEVELOPER with no moderator role could rebuild the URL from the key and
    // view un-reviewed flagged content. `awaitingReview` is the one bucket of
    // un-reviewed CONTENT holds, so it is the one that loses both fields.
    //
    // `lastError` joined the list later, and for the same reason `publicUrl`
    // taught: it used to cross the wire here and be suppressed by the page's
    // `signalShowsLastError` helper at render time. A control in the renderer
    // is a decoration — the value is still in the payload for anyone who calls
    // the procedure directly.
    const { deps } = makeDeps({}, [RECORD]);

    const out = await listModerationQueueSignal(deps, {
      ...WINDOW,
      signal: "awaitingReview",
    });

    expect(out.items).toHaveLength(1);
    // An exhaustive `toEqual`, not a `toMatchObject`: this is the COMPLETE
    // payload for a content hold, so a newly added field has to be justified
    // here rather than sliding in unnoticed.
    expect(out.items[0]).toEqual({
      recordId: "rec-1",
      kind: "EVENT_HERO",
      status: "FLAGGED",
      subjectType: "EVENT",
      subjectId: "e1",
      degraded: true,
      requeues: 2,
      attempts: 5,
      moderatedAt: new Date("2026-08-20T17:30:00.000Z"),
      nextAttemptAt: new Date("2026-08-20T17:45:00.000Z"),
    });
    // ABSENT, not null. `null` would make "we are not telling you"
    // indistinguishable from "there was no error" / "there is no key".
    expect(out.items[0]).not.toHaveProperty("storageKey");
    expect(out.items[0]).not.toHaveProperty("lastError");
    expect(out.items[0]).not.toHaveProperty("publicUrl");
    // The SERIALIZED payload, not just the fields — a value smuggled anywhere
    // else travels just as well. This is the assertion that would have caught
    // the render-time-only version of this control.
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("events/e1/hero.jpg");
    expect(wire).not.toContain("cdn.example.com");
    expect(wire).not.toContain("azure 401");
    // Nor the reviewer's private note, nor the uploader's identity.
    expect(out.items[0]).not.toHaveProperty("reviewNote");
    expect(out.items[0]).not.toHaveProperty("createdByHumanId");
  });

  it("KEEPS storageKey AND lastError for the four operational buckets", async () => {
    // These are scanner failures, unscanned rows and vanished objects — not
    // content holds. An engineer triaging them needs to name the row AND read
    // why it failed; for the two degraded buckets `lastError` is the entire
    // point of the drill-down. Asserted for all four so a blanket "just drop
    // it everywhere" edit fails here rather than silently gutting triage.
    for (const signal of [
      "pendingOverdue",
      "degradedRecent",
      "degradedExhausted",
      "orphanedRecent",
    ] as const) {
      const { deps } = makeDeps({}, [RECORD]);

      const out = await listModerationQueueSignal(deps, { ...WINDOW, signal });

      expect({
        signal,
        key: out.items[0]?.storageKey,
        err: out.items[0]?.lastError,
      }).toEqual({
        signal,
        key: "events/e1/hero.jpg",
        err: "azure 401",
      });
      // Still never a URL.
      expect(out.items[0]).not.toHaveProperty("publicUrl");
    }
  });

  it("withholds the two fields TOGETHER — they cannot drift apart", async () => {
    // One predicate (`signalWithholdsContent`) decides both. Two conditions is
    // how they diverge, and the divergence is silent because each one still
    // looks correct on its own. Asserted as a single equality across every
    // bucket so a half-applied edit cannot pass.
    for (const signal of [
      "pendingOverdue",
      "awaitingReview",
      "degradedRecent",
      "degradedExhausted",
      "orphanedRecent",
    ] as const) {
      const { deps } = makeDeps({}, [RECORD]);

      const out = await listModerationQueueSignal(deps, { ...WINDOW, signal });
      const item = out.items[0]!;

      expect({
        signal,
        hasKey: Object.hasOwn(item, "storageKey"),
        hasErr: Object.hasOwn(item, "lastError"),
      }).toEqual({
        signal,
        hasKey: signal !== "awaitingReview",
        hasErr: signal !== "awaitingReview",
      });
    }
  });

  it("still carries a NULL lastError for an operational row that never failed", async () => {
    // The nullable half of `.nullable().optional()`. A degraded row with no
    // recorded error is a real state, and it must serialize as an explicitly
    // present `null` — otherwise a UI cannot tell it apart from the withheld
    // case and the whole point of omitting rather than nulling is lost.
    const { deps } = makeDeps({}, [{ ...RECORD, lastError: null }]);

    const out = await listModerationQueueSignal(deps, {
      ...WINDOW,
      signal: "degradedRecent",
    });

    expect(Object.hasOwn(out.items[0]!, "lastError")).toBe(true);
    expect(out.items[0]?.lastError).toBeNull();
  });

  it("defaults the page size and rejects an out-of-range limit", async () => {
    const { deps, listQueueHealthSignal } = makeDeps();

    await listModerationQueueSignal(deps, {
      ...WINDOW,
      signal: "orphanedRecent",
    });
    expect((listQueueHealthSignal.mock.calls as unknown[][])[0]![0]).toMatchObject({
      limit: 30,
      cursor: undefined,
    });

    await expect(
      listModerationQueueSignal(deps, {
        ...WINDOW,
        signal: "orphanedRecent",
        limit: 500,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a bucket that is not one of the five counted signals", async () => {
    const { deps, listQueueHealthSignal } = makeDeps();

    await expect(
      listModerationQueueSignal(deps, { ...WINDOW, signal: "somethingElse" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(listQueueHealthSignal).not.toHaveBeenCalled();
  });

  it("requires the window — a caller cannot silently get a default one", async () => {
    // If the cutoffs were optional the drill-down would quietly invent a
    // window, which is the bug this shape exists to make unrepresentable.
    const { deps } = makeDeps();

    await expect(
      listModerationQueueSignal(deps, { signal: "pendingOverdue" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
