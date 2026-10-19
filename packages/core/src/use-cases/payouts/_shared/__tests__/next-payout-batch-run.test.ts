import { describe, expect, it } from "vitest";

import {
  assertDailyMidnightCron,
  nextPayoutBatchRun,
  nextPayoutRunFor,
} from "../next-payout-batch-run";
import { PAYOUT_BATCH_CRON_SOURCE } from "../payout-batch-cycle";

const HOUR_MS = 60 * 60 * 1000;

/** The real schedule always answers; a null here is itself a failure. */
function mustRun(asOf: Date) {
  const r = nextPayoutBatchRun(asOf);
  if (!r) throw new Error("expected a next run for the daily-midnight cron");
  return r;
}

function next(iso: string) {
  const r = mustRun(new Date(iso));
  return { runAt: r.runAt.toISOString(), night: r.night };
}

describe("nextPayoutBatchRun", () => {
  it("an ordinary afternoon: tonight's midnight Central, night = today", () => {
    // 15:00 CDT (UTC-5) on Mon 12 Oct 2026.
    expect(next("2026-10-12T20:00:00.000Z")).toEqual({
      runAt: "2026-10-13T05:00:00.000Z",
      night: "2026-10-12",
    });
  });

  it("exactly at midnight: the run firing now is not next; the next is 24h later", () => {
    const asOf = "2026-10-13T05:00:00.000Z"; // 00:00 CDT, 13 Oct
    const r = mustRun(new Date(asOf));
    expect(r.runAt.toISOString()).toBe("2026-10-14T05:00:00.000Z");
    expect(r.night).toBe("2026-10-13");
    expect(r.runAt.getTime() - new Date(asOf).getTime()).toBe(24 * HOUR_MS);
  });

  it("one minute before midnight: the run a minute away, night = today", () => {
    // 23:59 CDT on 12 Oct.
    expect(next("2026-10-13T04:59:00.000Z")).toEqual({
      runAt: "2026-10-13T05:00:00.000Z",
      night: "2026-10-12",
    });
  });

  it("one millisecond after midnight: the following midnight", () => {
    expect(next("2026-10-13T05:00:00.001Z")).toEqual({
      runAt: "2026-10-14T05:00:00.000Z",
      night: "2026-10-13",
    });
  });

  it("fall-back day (1 Nov 2026): the run is at midnight CST, 25h after the previous one", () => {
    // 00:30 CDT on Sun 1 Nov; clocks fall back at 02:00 that morning.
    expect(next("2026-11-01T05:30:00.000Z")).toEqual({
      runAt: "2026-11-02T06:00:00.000Z",
      night: "2026-11-01",
    });
    // The midnight that opened the day was 05:00Z; the gap is 25 hours.
    const prev = mustRun(new Date("2026-10-31T12:00:00.000Z"));
    expect(prev.runAt.toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(
      new Date("2026-11-02T06:00:00.000Z").getTime() - prev.runAt.getTime(),
    ).toBe(25 * HOUR_MS);
  });

  it("spring-forward day (8 Mar 2026): the run is at midnight CDT, 23h after the previous one", () => {
    // 00:30 CST on Sun 8 Mar; clocks spring forward at 02:00 that morning.
    expect(next("2026-03-08T06:30:00.000Z")).toEqual({
      runAt: "2026-03-09T05:00:00.000Z",
      night: "2026-03-08",
    });
    const prev = mustRun(new Date("2026-03-07T12:00:00.000Z"));
    expect(prev.runAt.toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(
      new Date("2026-03-09T05:00:00.000Z").getTime() - prev.runAt.getTime(),
    ).toBe(23 * HOUR_MS);
  });

  it("UTC has already rolled over while Central is still the previous evening", () => {
    // 03:00Z on 13 Oct is 22:00 CDT on 12 Oct: the night is the 12th, not the 13th.
    expect(next("2026-10-13T03:00:00.000Z")).toEqual({
      runAt: "2026-10-13T05:00:00.000Z",
      night: "2026-10-12",
    });
    // Winter (CST, UTC-6): 05:30Z on 15 Dec is 23:30 CST on 14 Dec.
    expect(next("2026-12-15T05:30:00.000Z")).toEqual({
      runAt: "2026-12-15T06:00:00.000Z",
      night: "2026-12-14",
    });
  });

  it("throws on an invalid date rather than inventing one", () => {
    expect(() => nextPayoutBatchRun(new Date("not a date"))).toThrow(
      /invalid asOf/,
    );
  });
});

describe("a rescheduled batch: null, never a wrong date, never a crash", () => {
  it("returns null for any schedule but daily-at-midnight", () => {
    const asOf = new Date("2026-10-12T20:00:00.000Z");
    expect(nextPayoutBatchRun(asOf, "0 2 * * *")).toBeNull();
    expect(nextPayoutRunFor(asOf, "0 0 * * 1")).toBeNull();
  });

  it("serialises the real schedule's run for the wire", () => {
    expect(nextPayoutRunFor(new Date("2026-10-12T20:00:00.000Z"))).toEqual({
      runAt: "2026-10-13T05:00:00.000Z",
      night: "2026-10-12",
    });
  });
});

describe("assertDailyMidnightCron — the loud signal", () => {
  // THE PIN. If this fails, the payout batch was rescheduled: the page has
  // fallen back to its dateless caption. Teach next-payout-batch-run.ts the
  // new schedule (see payout-batch-cycle.ts) before updating this test.
  it("accepts the batch's recorded cron", () => {
    expect(PAYOUT_BATCH_CRON_SOURCE).toBe("0 0 * * *");
    expect(() => assertDailyMidnightCron(PAYOUT_BATCH_CRON_SOURCE)).not.toThrow();
  });

  it("fails loudly on any other schedule instead of guessing", () => {
    expect(() => assertDailyMidnightCron("0 2 * * *")).toThrow(
      /payout-batch-cycle\.ts/,
    );
    expect(() => assertDailyMidnightCron("0 0 * * 1")).toThrow(
      /rescheduled/,
    );
  });
});
