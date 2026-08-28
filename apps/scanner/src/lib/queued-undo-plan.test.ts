import { describe, expect, it } from "vitest";

import { planQueuedUndo } from "./queued-undo-plan";

/**
 * FR-006a is the headline of this build step and, until this file existed, it
 * had ZERO automated coverage — the decision lived inside `local-db.ts`, which
 * imports `expo-sqlite` and therefore cannot be loaded in node at all.
 */
describe("planQueuedUndo", () => {
  it("writes NOTHING when no queue row matches", () => {
    // Absence of a queue row means the server has it (or is about to).
    // Reverting locally would be a lie the next manifest sync overwrites, so
    // the caller must not mark the scan undone, must not revert the ticket.
    expect(planQueuedUndo({ rows: [] })).toEqual({ kind: "requires_server" });
  });

  it("cancels the single pending row", () => {
    expect(
      planQueuedUndo({ rows: [{ queueId: "q1", enqueuedAt: 1_000 }] }),
    ).toEqual({ kind: "cancel", queueIds: ["q1"] });
  });

  it("cancels ALL rows for the code, not just one", () => {
    // The bug: an individual admit and a bulk "admit all N from this order"
    // write TWO queue rows for one code. Cancelling one left the survivor to
    // re-admit on the next flush — an undo that silently un-does itself,
    // minutes later, with a success haptic already spent.
    const plan = planQueuedUndo({
      rows: [
        { queueId: "q_bulk", enqueuedAt: 2_000 },
        { queueId: "q_individual", enqueuedAt: 1_000 },
      ],
    });
    expect(plan).toEqual({
      kind: "cancel",
      // FIFO — the same order the flusher would have sent them in.
      queueIds: ["q_individual", "q_bulk"],
    });
  });

  it("de-duplicates repeated ids", () => {
    expect(
      planQueuedUndo({
        rows: [
          { queueId: "q1", enqueuedAt: 1_000 },
          { queueId: "q1", enqueuedAt: 1_000 },
        ],
      }),
    ).toEqual({ kind: "cancel", queueIds: ["q1"] });
  });

  it("does not mutate the caller's row array", () => {
    // It sorts; sorting the caller's array in place would reorder a live
    // result set under whoever else is holding it.
    const rows = [
      { queueId: "q_b", enqueuedAt: 2_000 },
      { queueId: "q_a", enqueuedAt: 1_000 },
    ];
    planQueuedUndo({ rows });
    expect(rows.map((r) => r.queueId)).toEqual(["q_b", "q_a"]);
  });
});
