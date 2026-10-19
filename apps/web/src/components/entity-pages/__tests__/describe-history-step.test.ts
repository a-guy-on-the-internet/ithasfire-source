/**
 * Block-history step classification. Pure function, so this is the real test —
 * no React, no mutation machinery, no mocks.
 */
import { describe, expect, it } from "vitest";

import {
  describeHistoryStep,
  formatBlockKind,
  readBlockTitle,
  type HistoryBlock,
} from "../describe-history-step";

const block = (
  id: string,
  overrides: Partial<HistoryBlock> = {},
): HistoryBlock => ({
  id,
  kind: "about",
  data: {},
  visible: true,
  ...overrides,
});

describe("describeHistoryStep", () => {
  it("classifies an added block and names it", () => {
    const from = [block("a")];
    const to = [block("a"), block("b", { kind: "shows" })];

    expect(describeHistoryStep(from, to)).toEqual({
      kind: "add",
      blockKind: "shows",
      blockTitle: null,
      multiple: false,
    });
  });

  it("classifies a deleted block", () => {
    const from = [block("a"), block("b", { kind: "links" })];
    const to = [block("a")];

    expect(describeHistoryStep(from, to)).toMatchObject({
      kind: "delete",
      blockKind: "links",
      multiple: false,
    });
  });

  it("classifies a data edit", () => {
    const from = [block("a", { data: { heading: "About" } })];
    const to = [block("a", { data: { heading: "About us" } })];

    expect(describeHistoryStep(from, to)).toEqual({
      kind: "edit",
      blockKind: "about",
      // Prefers the user-authored heading over the kind name.
      blockTitle: "About us",
      multiple: false,
    });
  });

  it("classifies a block being shown", () => {
    const from = [block("a", { visible: false })];
    const to = [block("a", { visible: true })];

    expect(describeHistoryStep(from, to)).toMatchObject({
      kind: "show",
      blockKind: "about",
      multiple: false,
    });
  });

  it("classifies a block being hidden, carrying its heading", () => {
    const from = [
      block("a", { kind: "shows", data: { heading: "Upcoming events" } }),
    ];
    const to = [
      block("a", {
        kind: "shows",
        data: { heading: "Upcoming events" },
        visible: false,
      }),
    ];

    expect(describeHistoryStep(from, to)).toEqual({
      kind: "hide",
      blockKind: "shows",
      blockTitle: "Upcoming events",
      multiple: false,
    });
  });

  it("classifies a reorder, and never names a single block for it", () => {
    const from = [block("a"), block("b"), block("c")];
    const to = [block("c"), block("a"), block("b")];

    expect(describeHistoryStep(from, to)).toEqual({
      kind: "reorder",
      blockKind: null,
      blockTitle: null,
      multiple: true,
    });
  });

  it("keeps ONE class generic when it spans several blocks", () => {
    const from = [block("a"), block("b")];
    const to = [
      block("a", { visible: false }),
      block("b", { visible: false }),
    ];

    // Generic phrase for the class — never a concatenated list of names.
    expect(describeHistoryStep(from, to)).toEqual({
      kind: "hide",
      blockKind: null,
      blockTitle: null,
      multiple: true,
    });
  });

  it("reports `mixed` when a step spans several change classes", () => {
    const from = [block("a", { data: { heading: "One" } })];
    const to = [
      block("a", { data: { heading: "Two" } }),
      block("b", { kind: "links" }),
    ];

    // An add AND an edit — calling it either one would be a lie.
    expect(describeHistoryStep(from, to)).toEqual({
      kind: "mixed",
      blockKind: null,
      blockTitle: null,
      multiple: true,
    });
  });

  it("reports `none` for identical snapshots", () => {
    const snapshot = [block("a", { data: { heading: "About" } }), block("b")];

    expect(describeHistoryStep(snapshot, snapshot)).toEqual({
      kind: "none",
      blockKind: null,
      blockTitle: null,
      multiple: false,
    });
  });

  it("reports `none` when only object key ORDER differs", () => {
    // Matches useBlockHistory's own stable comparison, so the classifier and
    // the recorder can never disagree about whether data changed.
    const from = [block("a", { data: { heading: "About", body: "x" } })];
    const to = [block("a", { data: { body: "x", heading: "About" } })];

    expect(describeHistoryStep(from, to).kind).toBe("none");
  });

  it("does not report a reorder when the set changed too", () => {
    // The add already explains the sequence difference.
    const from = [block("a"), block("b")];
    const to = [block("c", { kind: "links" }), block("a"), block("b")];

    expect(describeHistoryStep(from, to)).toMatchObject({
      kind: "add",
      blockKind: "links",
      multiple: false,
    });
  });
});

describe("readBlockTitle", () => {
  it("returns a trimmed heading", () => {
    expect(readBlockTitle({ heading: "  Press  " })).toBe("Press");
  });

  it("returns null for a blank, missing, or non-string heading", () => {
    expect(readBlockTitle({ heading: "   " })).toBeNull();
    expect(readBlockTitle({})).toBeNull();
    expect(readBlockTitle({ heading: 42 })).toBeNull();
    expect(readBlockTitle(null)).toBeNull();
    expect(readBlockTitle(["heading"])).toBeNull();
  });
});

describe("formatBlockKind", () => {
  it("humanises a snake_case kind", () => {
    expect(formatBlockKind("past_shows")).toBe("Past Shows");
    expect(formatBlockKind("about")).toBe("About");
  });
});
