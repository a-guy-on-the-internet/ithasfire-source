import { describe, expect, it } from "vitest";

import { TRACK_RECORD_EVENT_STATUSES } from "@th/types/repos/events";
import { PLACE_STATS_ELIGIBLE_ORDER_STATUSES } from "@th/types/repos/orders";
import { ADMIT_SCAN_OUTCOMES } from "@th/types/repos/tickets";

import { STALE_WINDOW_DAYS, stalePlaceIdsSql } from "../place-reviews";

/**
 * Pins the RENDERING of the stale statement — no database. The integration
 * suite proves what it returns; this proves the shared constants actually
 * reach the SQL, so core's read set and the adapter's stale set cannot
 * drift (the review that produced it found the statuses hand-copied).
 */
describe("stalePlaceIdsSql (rendering)", () => {
  it("binds EVERY eligible order status, each cast to the enum", () => {
    const q = stalePlaceIdsSql(100);
    for (const status of PLACE_STATS_ELIGIBLE_ORDER_STATUSES) {
      expect(q.values).toContain(status);
    }
    // A bound text parameter does not coerce to a Postgres enum: one cast per
    // status, all in the order arm's IN list.
    expect(q.text.match(/::"OrderStatus"/g)).toHaveLength(
      PLACE_STATS_ELIGIBLE_ORDER_STATUSES.length,
    );
    expect(q.text).toMatch(/o\."status" IN \((\$\d+::"OrderStatus",?)+\)/);
  });

  it("binds the track-record event statuses in BOTH event arms (ended, no-row)", () => {
    const q = stalePlaceIdsSql(100);
    for (const status of TRACK_RECORD_EVENT_STATUSES) {
      expect(q.values.filter((v) => v === status)).toHaveLength(2);
    }
    expect(q.text.match(/::"EventStatus"/g)).toHaveLength(
      TRACK_RECORD_EVENT_STATUSES.length * 2,
    );
  });

  it("uses ONE window for the ticket arm, the order arm and the sweep (R12), and the limit twice", () => {
    const q = stalePlaceIdsSql(7, 30);
    expect(q.values.filter((v) => v === 30)).toHaveLength(3);
    expect(q.text.match(/make_interval\(days => \$\d+\)/g)).toHaveLength(3);
    // The sweep arm carries its own LIMIT, the outer query the other.
    expect(q.values.filter((v) => v === 7)).toHaveLength(2);
    expect(q.text.match(/LIMIT \$\d+/g)).toHaveLength(2);
  });

  it("the scan arm reads the TicketScan LOG, admits only — not Ticket.scannedAt (R11)", () => {
    const q = stalePlaceIdsSql(100);
    for (const outcome of ADMIT_SCAN_OUTCOMES) {
      expect(q.values).toContain(outcome);
    }
    expect(q.text.match(/::"TicketScanOutcome"/g)).toHaveLength(
      ADMIT_SCAN_OUTCOMES.length,
    );
    expect(q.text).toMatch(/FROM "TicketScan" s/);
    expect(q.text).toMatch(
      /s\."outcome" IN \((\$\d+::"TicketScanOutcome",?)+\)/,
    );
    expect(q.text).not.toMatch(/FROM "Ticket" /);
    expect(q.text).not.toMatch(/t\."scannedAt"/);
  });

  it("defaults the window to STALE_WINDOW_DAYS", () => {
    expect(STALE_WINDOW_DAYS).toBe(30);
    expect(stalePlaceIdsSql(100).values).toContain(STALE_WINDOW_DAYS);
  });
});
