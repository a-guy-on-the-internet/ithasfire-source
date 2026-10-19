import { describe, expect, it } from "vitest";

import { nextTabForKey, type EmbedsTabEntry } from "../embeds-tab-nav.helpers";

const TABS: EmbedsTabEntry[] = [
  { key: "events", id: "embeds-tab-events" },
  { key: "booking", id: "embeds-tab-booking" },
  { key: "memberships", id: "embeds-tab-memberships" },
];

describe("nextTabForKey (embeds)", () => {
  it("ArrowRight moves to the next tab and wraps", () => {
    expect(nextTabForKey("events", "ArrowRight", TABS)?.key).toBe("booking");
    expect(nextTabForKey("booking", "ArrowRight", TABS)?.key).toBe(
      "memberships",
    );
    expect(nextTabForKey("memberships", "ArrowRight", TABS)?.key).toBe(
      "events",
    );
  });

  it("ArrowLeft moves to the previous tab and wraps", () => {
    expect(nextTabForKey("booking", "ArrowLeft", TABS)?.key).toBe("events");
    expect(nextTabForKey("events", "ArrowLeft", TABS)?.key).toBe(
      "memberships",
    );
  });

  it("Home / End jump to the first / last tab", () => {
    expect(nextTabForKey("booking", "Home", TABS)?.key).toBe("events");
    expect(nextTabForKey("events", "End", TABS)?.key).toBe("memberships");
  });

  it("returns null for non-navigation keys (event passes through)", () => {
    for (const key of ["Enter", " ", "Tab", "a", "ArrowUp", "ArrowDown"]) {
      expect(nextTabForKey("events", key, TABS)).toBeNull();
    }
  });

  it("returns null when the current tab isn't in the set", () => {
    expect(
      nextTabForKey("booking", "ArrowRight", [
        { key: "events", id: "embeds-tab-events" },
      ]),
    ).toBeNull();
  });

  it("returns null for an empty tab order", () => {
    expect(nextTabForKey("events", "ArrowRight", [])).toBeNull();
  });
});
