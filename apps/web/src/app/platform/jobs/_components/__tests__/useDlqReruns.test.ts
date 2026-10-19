import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DlqRerunSettled } from "../dlq-rerun-outcome";
import { useDlqReruns } from "../useDlqReruns";

// The live stack seeds ONE dead-letter entry, so two entries in one queue
// cannot be exercised in the browser. The per-queue rules are pinned here.

const failed: DlqRerunSettled = {
  kind: "result",
  result: {
    outcome: "failed",
    runId: "run_a",
    status: 500,
    error: { message: "boom" },
  },
};
const ranRemoved: DlqRerunSettled = {
  kind: "result",
  result: { outcome: "ran", runId: "run_b", entryDeleted: true },
};
const ranKept: DlqRerunSettled = {
  kind: "result",
  result: { outcome: "ran", runId: "run_c", entryDeleted: false },
};
const thrown: DlqRerunSettled = {
  kind: "error",
  error: new Error("Jobs API 502: Bad Gateway"),
};

const setup = () => renderHook(() => useDlqReruns());

describe("useDlqReruns: one rerun per queue at a time", () => {
  it("claims the queue for the pressed entry and turns the others off", () => {
    const { result } = setup();

    let started = false;
    act(() => {
      started = result.current.start("search.reindex", "A");
    });

    expect(started).toBe(true);
    expect(result.current.rowState("search.reindex", "A")).toEqual({
      pending: true,
      blocked: false,
      ranEntryKept: false,
    });
    // Only the pressed row shows the pending label; its neighbours are off.
    expect(result.current.rowState("search.reindex", "B")).toEqual({
      pending: false,
      blocked: true,
      ranEntryKept: false,
    });
  });

  it("refuses a second entry in the same queue while the first is running", () => {
    const { result } = setup();
    act(() => {
      result.current.start("search.reindex", "A");
    });

    let second = true;
    act(() => {
      second = result.current.start("search.reindex", "B");
    });

    expect(second).toBe(false);
    expect(result.current.rowState("search.reindex", "A").pending).toBe(true);
    expect(result.current.rowState("search.reindex", "B").pending).toBe(false);
  });

  it("refuses a double press on the same entry inside one event", () => {
    const { result } = setup();
    const answers: boolean[] = [];
    // Both presses land before React re-renders: state is stale here, the
    // ref guard is not.
    act(() => {
      answers.push(result.current.start("search.reindex", "A"));
      answers.push(result.current.start("search.reindex", "A"));
    });
    expect(answers).toEqual([true, false]);
  });

  it("leaves other queues alone", () => {
    const { result } = setup();
    act(() => {
      result.current.start("search.reindex", "A");
    });

    expect(result.current.rowState("sitemaps.generate", "Z")).toEqual({
      pending: false,
      blocked: false,
      ranEntryKept: false,
    });
    let other = false;
    act(() => {
      other = result.current.start("sitemaps.generate", "Z");
    });
    expect(other).toBe(true);
  });

  it("releases the queue when the rerun settles, so the next entry can run", () => {
    const { result } = setup();
    act(() => {
      result.current.start("search.reindex", "A");
    });
    act(() => {
      result.current.finish("search.reindex", "A", failed);
    });

    expect(result.current.rowState("search.reindex", "A")).toEqual({
      pending: false,
      blocked: false,
      ranEntryKept: false,
    });
    expect(result.current.rowState("search.reindex", "B").blocked).toBe(false);

    let next = false;
    act(() => {
      next = result.current.start("search.reindex", "B");
    });
    expect(next).toBe(true);
  });

  it("releases the queue when the request throws", () => {
    const { result } = setup();
    act(() => {
      result.current.start("search.reindex", "A");
    });
    act(() => {
      result.current.finish("search.reindex", "A", thrown);
    });
    expect(result.current.rowState("search.reindex", "A").pending).toBe(false);
    expect(result.current.settledFor("search.reindex")).toBe(thrown);
  });
});

describe("useDlqReruns: the outcome line", () => {
  it("is keyed by queue and never shows under another job", () => {
    const { result } = setup();
    act(() => {
      result.current.start("search.reindex", "A");
    });
    act(() => {
      result.current.finish("search.reindex", "A", failed);
    });

    expect(result.current.settledFor("search.reindex")).toBe(failed);
    expect(result.current.settledFor("sitemaps.generate")).toBeUndefined();
  });

  it("the regression: A fails, then B runs. B could not start until A had answered", () => {
    const { result } = setup();
    act(() => {
      result.current.start("search.reindex", "A");
    });
    // B is pressed while A is still running: nothing starts.
    act(() => {
      result.current.start("search.reindex", "B");
    });
    act(() => {
      result.current.finish("search.reindex", "A", failed);
    });
    // The line is A's failure, and it is the only rerun that happened.
    expect(result.current.settledFor("search.reindex")).toBe(failed);

    // Now B really runs. Starting it clears A's line; B's own answer follows.
    act(() => {
      result.current.start("search.reindex", "B");
    });
    expect(result.current.settledFor("search.reindex")).toBeUndefined();
    act(() => {
      result.current.finish("search.reindex", "B", ranRemoved);
    });
    expect(result.current.settledFor("search.reindex")).toBe(ranRemoved);
  });

  it("dismiss forgets one queue's line and no other", () => {
    const { result } = setup();
    act(() => {
      result.current.start("search.reindex", "A");
      result.current.start("sitemaps.generate", "Z");
    });
    act(() => {
      result.current.finish("search.reindex", "A", failed);
      result.current.finish("sitemaps.generate", "Z", thrown);
    });
    act(() => {
      result.current.dismiss("search.reindex");
    });

    expect(result.current.settledFor("search.reindex")).toBeUndefined();
    expect(result.current.settledFor("sitemaps.generate")).toBe(thrown);
  });
});

describe("useDlqReruns: an entry that ran but could not be removed", () => {
  const runKept = () => {
    const hook = setup();
    act(() => {
      hook.result.current.start("search.reindex", "A");
    });
    act(() => {
      hook.result.current.finish("search.reindex", "A", ranKept);
    });
    return hook;
  };

  it("stays marked and off, while its neighbours are usable again", () => {
    const { result } = runKept();

    expect(result.current.rowState("search.reindex", "A")).toEqual({
      pending: false,
      blocked: true,
      ranEntryKept: true,
    });
    expect(result.current.rowState("search.reindex", "B")).toEqual({
      pending: false,
      blocked: false,
      ranEntryKept: false,
    });
  });

  it("cannot be rerun: start refuses it and claims nothing", () => {
    const { result } = runKept();

    let again = true;
    act(() => {
      again = result.current.start("search.reindex", "A");
    });

    expect(again).toBe(false);
    expect(result.current.rowState("search.reindex", "A").pending).toBe(false);
    // The queue was not claimed by the refused press.
    expect(result.current.rowState("search.reindex", "B").blocked).toBe(false);
    // And the refusal did not wipe the line that explains it.
    expect(result.current.settledFor("search.reindex")).toBe(ranKept);
  });

  it("the mark outlives the status line being replaced or dismissed", () => {
    const { result } = runKept();

    // Another entry is rerun: the line moves on to that rerun.
    act(() => {
      result.current.start("search.reindex", "B");
    });
    act(() => {
      result.current.finish("search.reindex", "B", failed);
    });
    expect(result.current.settledFor("search.reindex")).toBe(failed);
    expect(result.current.rowState("search.reindex", "A").ranEntryKept).toBe(
      true,
    );

    // The panel closes: the line goes, the mark does not.
    act(() => {
      result.current.dismiss("search.reindex");
    });
    expect(result.current.settledFor("search.reindex")).toBeUndefined();
    expect(result.current.rowState("search.reindex", "A")).toEqual({
      pending: false,
      blocked: true,
      ranEntryKept: true,
    });
  });

  it("is per entry and per queue", () => {
    const { result } = runKept();
    expect(result.current.rowState("sitemaps.generate", "A").ranEntryKept).toBe(
      false,
    );
    expect(result.current.rowState("search.reindex", "B").ranEntryKept).toBe(
      false,
    );
  });

  it("a run whose entry WAS removed marks nothing", () => {
    const { result } = setup();
    act(() => {
      result.current.start("search.reindex", "A");
    });
    act(() => {
      result.current.finish("search.reindex", "A", ranRemoved);
    });
    expect(result.current.rowState("search.reindex", "A")).toEqual({
      pending: false,
      blocked: false,
      ranEntryKept: false,
    });
  });
});
