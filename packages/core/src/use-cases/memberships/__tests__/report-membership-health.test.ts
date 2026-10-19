import { describe, expect, it, vi } from "vitest";

import type {
  MembershipHealthCounts,
  MembershipHealthCountsQuery,
} from "@th/ports/repos/memberships";

import {
  MEMBERSHIP_HEALTH_ALERT_STATE_KEY,
  fingerprintMembershipHealth,
  reportMembershipHealth,
  reportMembershipHealthInputSchema,
  type ReportMembershipHealthDeps,
} from "../report-membership-health";
import {
  MEMBERSHIP_LIVE_STATUSES,
  MEMBERSHIP_PAYMENT_FAILING_STATUSES,
} from "../membership-status";

/**
 * The daily membership health read.
 *
 * WHY IT EXISTS, restated so this file is legible on its own: `past_due` was
 * watched by nothing. It is a known constant that DENIES benefits at
 * checkout, so a failed card silently stopped a member's perks and the first
 * anyone heard about it was a complaint. These tests pin the counting, the
 * thresholds the counts are measured against, and the gating.
 */

const HEALTHY: MembershipHealthCounts = {
  paymentFailing: 0,
  stuckIncomplete: 0,
  leavingSoon: 0,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function makeSettingsStore() {
  const rows = new Map<
    string,
    { key: string; value: string; updatedAt: Date; createdAt: Date }
  >();
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
  return {
    rows,
    rawUpsert,
    get: vi.fn(async (key: string) => rows.get(key) ?? null),
    upsert: vi.fn(rawUpsert),
    getAll: vi.fn(async () => [...rows.values()]),
  };
}

function makeHarness(
  overrides: { settings?: ReturnType<typeof makeSettingsStore> } = {},
) {
  const settings = overrides.settings ?? makeSettingsStore();
  const reportError = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const logger = {
    info,
    warn,
    error,
    debug: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  const countHealth = vi.fn(
    async (_query: MembershipHealthCountsQuery) => HEALTHY,
  );
  let now = new Date("2026-09-01T06:10:00.000Z");

  const deps = {
    repos: {
      memberships: { countHealth },
      platformSettings: settings,
    },
    clock: { now: () => now },
    logger,
    reportError,
  } as unknown as ReportMembershipHealthDeps;

  return {
    settings,
    reportError,
    logger: { info, warn, error },
    countHealth,
    run: (
      at: string,
      counts: Partial<MembershipHealthCounts>,
      input?: Record<string, unknown>,
    ) => {
      now = new Date(at);
      countHealth.mockResolvedValue({ ...HEALTHY, ...counts });
      return reportMembershipHealth(deps, input ?? {});
    },
  };
}

describe("reportMembershipHealth — counting and copy", () => {
  it("is healthy, silent and says nothing when every count is zero", async () => {
    const h = makeHarness();
    const out = await h.run("2026-09-01T06:10:00.000Z", {});

    expect(out.unhealthy).toBe(false);
    expect(out.problems).toEqual([]);
    expect(out.shouldAlert).toBe(false);
    expect(out.alertReason).toBe("healthy");
    expect(out.fingerprint).toBeNull();
    // The unhealthy log line must NOT fire on a clean run.
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("names the CONSEQUENCE of a failing card, not just the status", async () => {
    // The whole point of this job: "12 memberships are past_due" tells an
    // operator nothing they can act on. That benefits are already gone does.
    const h = makeHarness();
    const out = await h.run("2026-09-01T06:10:00.000Z", { paymentFailing: 12 });

    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]).toContain("12 membership(s)");
    expect(out.problems[0]).toMatch(/ALREADY DENIED/);
    expect(out.problems[0]).toMatch(/dunning/i);
  });

  it("reports the three signals separately, in table order, never summed", async () => {
    const h = makeHarness();
    const out = await h.run("2026-09-01T06:10:00.000Z", {
      paymentFailing: 2,
      stuckIncomplete: 1,
      leavingSoon: 5,
    });

    expect(out.problems).toHaveLength(3);
    expect(out.problems[0]).toContain("past_due");
    expect(out.problems[1]).toContain("incomplete");
    expect(out.problems[2]).toContain("5 membership(s) are set to end");
    expect(out.fingerprint).toBe(
      "paymentFailing|stuckIncomplete|leavingSoon",
    );
  });

  it("puts the caller's thresholds into the copy, so the numbers cannot drift from the query", async () => {
    const h = makeHarness();
    const out = await h.run(
      "2026-09-01T06:10:00.000Z",
      { stuckIncomplete: 1, leavingSoon: 1 },
      { incompleteGraceHours: 6, leavingWithinDays: 30 },
    );

    expect(out.problems[0]).toContain("6h");
    expect(out.problems[1]).toContain("30");
  });

  it("logs the unhealthy line on EVERY unhealthy run, sent or suppressed", async () => {
    const h = makeHarness();
    await h.run("2026-09-01T06:10:00.000Z", { paymentFailing: 3 });
    await h.run("2026-09-02T06:10:00.000Z", { paymentFailing: 3 });

    expect(h.logger.warn).toHaveBeenCalledTimes(2);
    expect(h.logger.warn.mock.calls[1]?.[1]).toMatchObject({
      shouldAlert: false,
      alertReason: "suppressed",
    });
  });
});

describe("reportMembershipHealth — thresholds handed to the repo", () => {
  it("measures the incomplete window back from now, and the leaving window forward", async () => {
    const h = makeHarness();
    await h.run("2026-09-10T06:10:00.000Z", {}, {
      incompleteGraceHours: 24,
      leavingWithinDays: 14,
    });

    const query = h.countHealth.mock.calls[0]?.[0] as MembershipHealthCountsQuery;
    const now = new Date("2026-09-10T06:10:00.000Z").getTime();
    expect(query.incompleteBefore.getTime()).toBe(now - 24 * HOUR_MS);
    expect(query.leavingBefore.getTime()).toBe(now + 14 * DAY_MS);
  });

  it("bounds the leaving window at NOW, so a period end already past is not a 'window to intervene'", async () => {
    const h = makeHarness();
    await h.run("2026-09-10T06:10:00.000Z", {});
    const query = h.countHealth.mock.calls[0]?.[0] as MembershipHealthCountsQuery;
    expect(query.leavingFrom.getTime()).toBe(
      new Date("2026-09-10T06:10:00.000Z").getTime(),
    );
  });

  it("passes the SHARED status constants, never a private copy", async () => {
    // A second list here would let the job page about a state the benefits
    // resolver still grants on — or stay quiet about one it does not.
    const h = makeHarness();
    await h.run("2026-09-10T06:10:00.000Z", {});
    const query = h.countHealth.mock.calls[0]?.[0] as MembershipHealthCountsQuery;
    expect(query.paymentFailingStatuses).toEqual([
      ...MEMBERSHIP_PAYMENT_FAILING_STATUSES,
    ]);
    expect(query.liveStatuses).toEqual([...MEMBERSHIP_LIVE_STATUSES]);
  });
});

describe("reportMembershipHealth — alert gating", () => {
  it("suppresses an unchanged picture and heartbeats after a WEEK, not a day", async () => {
    // Daily job: a 24h heartbeat would make the gate a no-op and re-page every
    // single run — the exact behaviour the gate exists to remove.
    const h = makeHarness();
    const first = await h.run("2026-09-01T06:10:00.000Z", {
      paymentFailing: 3,
    });
    expect(first.alertReason).toBe("changed");

    const nextDay = await h.run("2026-09-02T06:10:00.000Z", {
      paymentFailing: 4,
    });
    expect(nextDay.alertReason).toBe("suppressed");

    const sixDays = await h.run("2026-09-07T06:10:00.000Z", {
      paymentFailing: 4,
    });
    expect(sixDays.alertReason).toBe("suppressed");

    const weekLater = await h.run("2026-09-08T06:11:00.000Z", {
      paymentFailing: 4,
    });
    expect(weekLater.alertReason).toBe("heartbeat");
  });

  it("defaults reAlertAfterHours to a week", () => {
    expect(reportMembershipHealthInputSchema.parse({}).reAlertAfterHours).toBe(
      168,
    );
  });

  it("sends again when a NEW signal starts firing", async () => {
    const h = makeHarness();
    await h.run("2026-09-01T06:10:00.000Z", { paymentFailing: 3 });
    const changed = await h.run("2026-09-02T06:10:00.000Z", {
      paymentFailing: 3,
      leavingSoon: 1,
    });
    expect(changed).toMatchObject({
      shouldAlert: true,
      alertReason: "changed",
    });
  });

  it("clears on recovery so an identical recurrence alerts again", async () => {
    const h = makeHarness();
    await h.run("2026-09-01T06:10:00.000Z", { paymentFailing: 3 });
    const recovered = await h.run("2026-09-02T06:10:00.000Z", {});
    expect(recovered.alertReason).toBe("healthy");

    const recurred = await h.run("2026-09-03T06:10:00.000Z", {
      paymentFailing: 3,
    });
    expect(recurred.alertReason).toBe("changed");
  });

  it("owns its OWN PlatformSetting row, never moderation's", async () => {
    // Two jobs sharing one fingerprint row would suppress each other's
    // incidents — a silence bug with no symptom.
    const h = makeHarness();
    await h.run("2026-09-01T06:10:00.000Z", { paymentFailing: 3 });
    expect(MEMBERSHIP_HEALTH_ALERT_STATE_KEY).toBe(
      "memberships:healthAlertState",
    );
    expect([...h.settings.rows.keys()]).toEqual([
      MEMBERSHIP_HEALTH_ALERT_STATE_KEY,
    ]);
  });

  it("still alerts, and reports under the memberships area, when the state READ throws", async () => {
    const settings = makeSettingsStore();
    settings.get.mockRejectedValue(new Error("pg is down"));
    const h = makeHarness({ settings });

    const out = await h.run("2026-09-01T06:10:00.000Z", { paymentFailing: 3 });

    expect(out.shouldAlert).toBe(true);
    expect(h.reportError.mock.calls[0]?.[1]).toMatchObject({
      tags: { area: "memberships", operation: "read" },
    });
  });
});

describe("fingerprintMembershipHealth", () => {
  it("ignores magnitude — only whether a signal fires", () => {
    const at = (n: number) =>
      fingerprintMembershipHealth({ ...HEALTHY, paymentFailing: n });
    expect(at(1)).toBe(at(400));
    expect(at(0)).not.toBe(at(1));
  });

  it("distinguishes the same total spread across different signals", () => {
    expect(
      fingerprintMembershipHealth({ ...HEALTHY, paymentFailing: 4 }),
    ).not.toBe(fingerprintMembershipHealth({ ...HEALTHY, leavingSoon: 4 }));
  });
});
