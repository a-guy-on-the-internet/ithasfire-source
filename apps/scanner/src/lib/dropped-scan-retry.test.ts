import { describe, expect, it, vi } from "vitest";

import {
  retryDroppedScans,
  type RetryableDrop,
} from "./dropped-scan-retry";

const row = (over: Partial<RetryableDrop> = {}): RetryableDrop => ({
  dropId: "drop-q1",
  queueId: "q1",
  eventId: "evt_1",
  ticketCode: "TKT-ABC123",
  clientKey: "unified-scan-evt_1-hum_1",
  attempts: 8,
  reason: "max_attempts",
  ...over,
});

describe("retryDroppedScans — the acceptance criterion", () => {
  it("replays with the row's ORIGINAL clientKey", async () => {
    const scan = vi.fn().mockResolvedValue(undefined);
    await retryDroppedScans({
      rows: [row({ clientKey: "unified-scan-evt_1-hum_OPERATOR" })],
      scan,
      remove: vi.fn(),
      report: vi.fn(),
    });
    expect(scan).toHaveBeenCalledWith({
      eventId: "evt_1",
      ticketCode: "TKT-ABC123",
      // The server's idempotency key is (event, code, clientKey). A fresh key
      // here would make the replay a SECOND admission instead of a REPLAY.
      clientKey: "unified-scan-evt_1-hum_OPERATOR",
    });
  });

  it("does not mutate or derive the key from anything else", async () => {
    const keys: string[] = [];
    await retryDroppedScans({
      rows: [
        row({ dropId: "d1", clientKey: "k-one" }),
        row({ dropId: "d2", clientKey: "k-two" }),
      ],
      scan: async (args) => {
        keys.push(args.clientKey);
      },
      remove: vi.fn(),
      report: vi.fn(),
    });
    expect(keys).toEqual(["k-one", "k-two"]);
  });
});

describe("retryDroppedScans — partial failure", () => {
  it("clears rows INDIVIDUALLY so one failure cannot strand the successes", async () => {
    const removed: string[] = [];
    const report = vi.fn();
    const outcome = await retryDroppedScans({
      rows: [
        row({ dropId: "d1", ticketCode: "A" }),
        row({ dropId: "d2", ticketCode: "B" }),
        row({ dropId: "d3", ticketCode: "C" }),
      ],
      scan: async (args) => {
        if (args.ticketCode === "B") throw new Error("still offline");
      },
      remove: (id) => removed.push(id),
      report,
    });

    expect(removed).toEqual(["d1", "d3"]);
    expect(outcome).toEqual({ attempted: 3, succeeded: 2, remaining: 1 });
    // The failing row STAYS — visible, retryable, and not quietly deleted.
    expect(report).toHaveBeenCalledTimes(1);
    expect((report.mock.calls[0] as [unknown, RetryableDrop])[1].dropId).toBe(
      "d2",
    );
  });

  it("keeps going after a failure rather than aborting the pass", async () => {
    const scan = vi.fn().mockRejectedValue(new Error("nope"));
    const outcome = await retryDroppedScans({
      rows: [row({ dropId: "d1" }), row({ dropId: "d2" })],
      scan,
      remove: vi.fn(),
      report: vi.fn(),
    });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ attempted: 2, succeeded: 0, remaining: 2 });
  });

  it("runs SERIALLY — admissions must not burst at a door", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await retryDroppedScans({
      rows: [row({ dropId: "d1" }), row({ dropId: "d2" }), row({ dropId: "d3" })],
      scan: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      },
      remove: vi.fn(),
      report: vi.fn(),
    });
    expect(maxInFlight).toBe(1);
  });

  it("does NOT tag a local delete failure as a failed replay", async () => {
    // `remove` used to live inside the same `try` as `scan`, so a SQLite
    // failure after a SUCCESSFUL server replay was reported as
    // `dropped_scan_retry_failed` with `errorKind: "network"`. Behaviour was
    // safe (the row stays; the next retry replays the same key idempotently)
    // but the Sentry record pointed at the wrong layer.
    const report = vi.fn();
    const reportRemoveFailed = vi.fn();
    const outcome = await retryDroppedScans({
      rows: [row({ dropId: "d1" })],
      scan: vi.fn().mockResolvedValue(undefined),
      remove: () => {
        throw new Error("database is locked");
      },
      report,
      reportRemoveFailed,
    });

    expect(report).not.toHaveBeenCalled();
    expect(reportRemoveFailed).toHaveBeenCalledTimes(1);
    // The server DID accept it, so it counts as a success even though the local
    // row survives — a re-replay of an accepted key is a REPLAY, not a second
    // admission.
    expect(outcome).toEqual({ attempted: 1, succeeded: 1, remaining: 0 });
  });

  it("survives a local delete failure with no reporter wired", async () => {
    await expect(
      retryDroppedScans({
        rows: [row({ dropId: "d1" })],
        scan: vi.fn().mockResolvedValue(undefined),
        remove: () => {
          throw new Error("database is locked");
        },
        report: vi.fn(),
      }),
    ).resolves.toEqual({ attempted: 1, succeeded: 1, remaining: 0 });
  });

  it("is a no-op on an empty list", async () => {
    const scan = vi.fn();
    await expect(
      retryDroppedScans({
        rows: [],
        scan,
        remove: vi.fn(),
        report: vi.fn(),
      }),
    ).resolves.toEqual({ attempted: 0, succeeded: 0, remaining: 0 });
    expect(scan).not.toHaveBeenCalled();
  });
});
