import { describe, it, expect } from "vitest";

import {
  resolveRefetchInterval,
  countUnread,
  mergeMessages,
  OPEN_INTERVAL_MS,
  COLLAPSED_INTERVAL_MS,
} from "../useSupportPolling";
import type { SupportMessageDto } from "../types";

function msg(over: Partial<SupportMessageDto>): SupportMessageDto {
  return {
    id: "m1",
    threadId: "t1",
    authorType: "HUMAN_AGENT",
    authorHumanId: null,
    body: "hi",
    createdAt: new Date(),
    readAt: null,
    ...over,
  } satisfies SupportMessageDto;
}

describe("resolveRefetchInterval", () => {
  it("STOPS polling once the query has errored (stale/foreign pointer guard)", () => {
    // Even while open + visible, an errored poll must not keep firing forever.
    expect(
      resolveRefetchInterval({ status: "error", tabVisible: true, isOpen: true }),
    ).toBe(false);
    expect(
      resolveRefetchInterval({ status: "error", tabVisible: true, isOpen: false }),
    ).toBe(false);
  });

  it("pauses while the tab is hidden", () => {
    expect(
      resolveRefetchInterval({
        status: "success",
        tabVisible: false,
        isOpen: true,
      }),
    ).toBe(false);
  });

  it("fast-polls while open + visible", () => {
    expect(
      resolveRefetchInterval({
        status: "success",
        tabVisible: true,
        isOpen: true,
      }),
    ).toBe(OPEN_INTERVAL_MS);
  });

  it("slow-polls while collapsed + visible", () => {
    expect(
      resolveRefetchInterval({
        status: "success",
        tabVisible: true,
        isOpen: false,
      }),
    ).toBe(COLLAPSED_INTERVAL_MS);
    // pending behaves like success (initial load is allowed to poll).
    expect(
      resolveRefetchInterval({
        status: "pending",
        tabVisible: true,
        isOpen: false,
      }),
    ).toBe(COLLAPSED_INTERVAL_MS);
  });
});

describe("countUnread", () => {
  it("counts only unread counterparty messages", () => {
    expect(
      countUnread([
        msg({ id: "a", authorType: "HUMAN_AGENT", readAt: null }),
        msg({ id: "b", authorType: "AI_CLERK", readAt: null }),
        msg({ id: "c", authorType: "SYSTEM", readAt: null }),
      ]),
    ).toBe(3);
  });

  it("ignores the user's own messages", () => {
    expect(
      countUnread([msg({ id: "a", authorType: "USER", readAt: null })]),
    ).toBe(0);
  });

  it("clears once readAt is stamped (markThreadRead path)", () => {
    expect(
      countUnread([
        msg({
          id: "a",
          authorType: "HUMAN_AGENT",
          readAt: new Date(),
        }),
      ]),
    ).toBe(0);
  });
});

describe("mergeMessages (incremental accumulator)", () => {
  const t0 = new Date("2026-06-23T11:00:00.000Z");
  const t1 = new Date("2026-06-23T11:05:00.000Z");
  const t2 = new Date("2026-06-23T11:10:00.000Z");

  it("appends new ids and keeps the list sorted by createdAt ascending", () => {
    const current = [msg({ id: "a", createdAt: t0 })];
    const delta = [
      msg({ id: "c", createdAt: t2 }),
      msg({ id: "b", createdAt: t1 }),
    ];
    expect(mergeMessages(current, delta).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("replaces an existing id so updated fields (readAt) propagate", () => {
    // This is the read-receipt path: markThreadRead re-fetch (if it ran) or a
    // local optimistic stamp must overwrite the OLD message, not duplicate it.
    const current = [msg({ id: "a", createdAt: t0, readAt: null })];
    const read = new Date();
    const merged = mergeMessages(current, [
      msg({ id: "a", createdAt: t0, readAt: read }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.readAt).toBe(read);
    expect(countUnread(merged)).toBe(0);
  });

  it("returns the same reference on an empty delta (caught-up poll)", () => {
    const current = [msg({ id: "a", createdAt: t0 })];
    expect(mergeMessages(current, [])).toBe(current);
  });

  it("accumulates across successive incremental deltas", () => {
    // Mirrors the hook: full history first, then a `gt since` delta of one new
    // message — the accumulator must carry the earlier history forward.
    const initial = mergeMessages([], [msg({ id: "a", createdAt: t0 })]);
    const afterDelta = mergeMessages(initial, [msg({ id: "b", createdAt: t1 })]);
    expect(afterDelta.map((m) => m.id)).toEqual(["a", "b"]);
  });
});
