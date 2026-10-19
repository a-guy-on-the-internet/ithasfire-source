import { describe, expect, it, vi } from "vitest";

import { chipActivation } from "../chip-keyboard";

type KeyHandler = (e: { key: string; preventDefault: () => void }) => void;

const handlerFor = (onPress: () => void): KeyHandler =>
  (chipActivation(onPress) as { onKeyDown: KeyHandler }).onKeyDown;

const press = (handler: KeyHandler, key: string) => {
  const preventDefault = vi.fn();
  handler({ key, preventDefault });
  return preventDefault;
};

describe("chipActivation", () => {
  it("exposes exactly one prop, onKeyDown", () => {
    expect(Object.keys(chipActivation(() => {}))).toEqual(["onKeyDown"]);
  });

  it("fires onPress for Enter", () => {
    const onPress = vi.fn();
    press(handlerFor(onPress), "Enter");
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("fires onPress for Space", () => {
    const onPress = vi.fn();
    press(handlerFor(onPress), " ");
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("preventDefaults Space so the page does not also scroll", () => {
    const preventDefault = press(handlerFor(vi.fn()), " ");
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("does NOT preventDefault a key it ignores", () => {
    // Load-bearing: swallowing Tab would turn every chip into a keyboard trap.
    for (const key of ["Tab", "Escape", "a", "ArrowDown", "Shift"]) {
      const onPress = vi.fn();
      const preventDefault = press(handlerFor(onPress), key);
      expect(onPress, key).not.toHaveBeenCalled();
      expect(preventDefault, key).not.toHaveBeenCalled();
    }
  });

  it("calls the handler it was given, not a stale one", () => {
    const first = vi.fn();
    const second = vi.fn();
    press(handlerFor(first), "Enter");
    press(handlerFor(second), "Enter");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
