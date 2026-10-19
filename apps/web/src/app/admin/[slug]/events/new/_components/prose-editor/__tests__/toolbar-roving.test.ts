import { describe, expect, it } from "vitest";
import {
  ROVING_ITEM_ATTR,
  allRovingItems,
  rovingItems,
  rovingTarget,
  syncRovingTabStops,
} from "../toolbar-roving";

/** A toolbar of `n` items; the indexes in `disabled` get aria-disabled. */
function toolbar(n: number, disabled: number[] = []) {
  const root = document.createElement("div");
  const items: HTMLElement[] = [];
  for (let i = 0; i < n; i++) {
    const el = document.createElement("div");
    el.setAttribute("role", "button");
    el.setAttribute(ROVING_ITEM_ATTR, "");
    el.tabIndex = -1;
    el.textContent = String(i);
    if (disabled.includes(i)) el.setAttribute("aria-disabled", "true");
    root.appendChild(el);
    items.push(el);
  }
  // A non-item (the divider) must never become a stop.
  root.insertBefore(document.createElement("span"), items[1] ?? null);
  return { root, items };
}

const stops = (items: HTMLElement[]) =>
  items.filter((el) => el.tabIndex === 0).map((el) => el.textContent);

describe("syncRovingTabStops", () => {
  it("leaves exactly one tab stop, the first enabled item, by default", () => {
    const { root, items } = toolbar(4, [0]); // Undo disabled at load
    expect(syncRovingTabStops(root, null)).toBe(items[1]);
    expect(stops(items)).toEqual(["1"]);
  });

  it("keeps the stop on the last focused item", () => {
    const { root, items } = toolbar(4);
    syncRovingTabStops(root, items[2]);
    expect(stops(items)).toEqual(["2"]);
  });

  it("hands the stop on when the remembered item turns disabled", () => {
    const { root, items } = toolbar(4);
    syncRovingTabStops(root, items[2]);
    items[2].setAttribute("aria-disabled", "true");
    expect(syncRovingTabStops(root, items[2])).toBe(items[0]);
    expect(stops(items)).toEqual(["0"]);
  });

  it("hands the stop on when the remembered item has left the toolbar", () => {
    const { root, items } = toolbar(3);
    const gone = document.createElement("div");
    expect(syncRovingTabStops(root, gone)).toBe(items[0]);
  });

  it("has no stop when every item is disabled (a read-only editor)", () => {
    const { root, items } = toolbar(3, [0, 1, 2]);
    expect(syncRovingTabStops(root, null)).toBeNull();
    expect(stops(items)).toEqual([]);
  });
});

describe("rovingTarget", () => {
  const { root, items } = toolbar(4, [2]);
  const all = allRovingItems(root);
  const enabled = all;

  it("skips disabled items", () => {
    expect(rovingItems(root).map((el) => el.textContent)).toEqual([
      "0",
      "1",
      "3",
    ]);
    expect(rovingTarget(all, items[1], "ArrowRight")).toBe(items[3]);
    expect(rovingTarget(all, items[3], "ArrowLeft")).toBe(items[1]);
  });

  // Redo right after the redo that emptied the stack: focus still sits on it,
  // but it is disabled. Its neighbours are still its neighbours.
  it("steps from a focused item that has just turned disabled to ITS neighbours", () => {
    const t = toolbar(5);
    const list = allRovingItems(t.root);
    t.items[2].setAttribute("aria-disabled", "true");
    expect(rovingTarget(list, t.items[2], "ArrowRight")).toBe(t.items[3]);
    expect(rovingTarget(list, t.items[2], "ArrowLeft")).toBe(t.items[1]);
  });

  it("wraps past disabled items at the ends", () => {
    const t = toolbar(4, [0, 3]);
    const list = allRovingItems(t.root);
    expect(rovingTarget(list, t.items[2], "ArrowRight")).toBe(t.items[1]);
    expect(rovingTarget(list, t.items[1], "ArrowLeft")).toBe(t.items[2]);
    expect(rovingTarget(list, t.items[2], "Home")).toBe(t.items[1]);
    expect(rovingTarget(list, t.items[1], "End")).toBe(t.items[2]);
  });

  it("wraps Left and Right at the ends", () => {
    expect(rovingTarget(enabled, items[3], "ArrowRight")).toBe(items[0]);
    expect(rovingTarget(enabled, items[0], "ArrowLeft")).toBe(items[3]);
  });

  it("jumps with Home and End", () => {
    expect(rovingTarget(enabled, items[1], "Home")).toBe(items[0]);
    expect(rovingTarget(enabled, items[1], "End")).toBe(items[3]);
  });

  it("leaves Up/Down alone in a horizontal toolbar, uses them in a wrapped panel", () => {
    expect(rovingTarget(enabled, items[0], "ArrowDown")).toBeNull();
    expect(rovingTarget(enabled, items[0], "ArrowDown", "both")).toBe(items[1]);
    expect(rovingTarget(enabled, items[0], "ArrowUp", "both")).toBe(items[3]);
  });

  it("ignores every other key, Tab included (Tab leaves the toolbar)", () => {
    expect(rovingTarget(enabled, items[0], "Tab")).toBeNull();
    expect(rovingTarget(enabled, items[0], "a")).toBeNull();
  });
});
