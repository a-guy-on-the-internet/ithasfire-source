import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RangeSliderProps } from "@th/ui";

/**
 * `AmountSlider`'s commit rules, driven through the props it hands
 * `RangeSlider`. jsdom sanitises an `<input type="range">` value to the
 * native step grid, so a DOM change event cannot deliver the off-grid or
 * below-floor values these rules exist for; calling `onValueChange` directly
 * can.
 */

const captured = vi.hoisted(() => ({ props: null as RangeSliderProps | null }));

vi.mock("@th/ui", () => ({
  RangeSlider: (props: RangeSliderProps) => {
    captured.props = props;
    return null;
  },
}));

import { AmountSlider, keyboardAmountCents } from "../AmountSlider";

const renderSlider = (
  over: Partial<Parameters<typeof AmountSlider>[0]> = {},
) => {
  const onChange = vi.fn();
  render(
    <AmountSlider
      valueCents={1500}
      floorCents={500}
      maxCents={7500}
      onChange={onChange}
      label="Set amount for Sliding Scale"
      valueText="$15.00"
      {...over}
    />,
  );
  return { onChange, props: captured.props! };
};

beforeEach(() => {
  captured.props = null;
});

describe("AmountSlider — a drag commits a magnetized amount on the track", () => {
  it("regression: never below the floor, even where the magnet pulls under it", () => {
    // $10.15 is 15¢ from $10.00: the magnet pulls it to $10.00, under a
    // $10.10 floor.
    const { onChange, props } = renderSlider({ floorCents: 1010, valueCents: 1010 });
    props.onValueChange(1015);
    expect(onChange).toHaveBeenLastCalledWith(1010);
  });

  it("never past the track end, even where the magnet rounds up over it", () => {
    // A $52.35 end: $52.35 magnetizes to $52.50.
    const { onChange, props } = renderSlider({ maxCents: 5235 });
    props.onValueChange(5235);
    expect(onChange).toHaveBeenLastCalledWith(5235);
  });

  it("a floor off the 5¢ grid: the browser's $17.38 commits on the grid", () => {
    // min=1013 step=5 makes the native input hand over 1013 + 5k.
    const { onChange, props } = renderSlider({ floorCents: 1013, valueCents: 1013 });
    // Out of the magnet's reach ($17.00 is 38¢ away, $15/$20 further), so
    // only the grid snap applies.
    props.onValueChange(1738);
    expect(onChange).toHaveBeenLastCalledWith(1740);
    // The floor itself stays reachable (the drag's left end).
    props.onValueChange(1013);
    expect(onChange).toHaveBeenLastCalledWith(1013);
  });

  it("an anchor is committed exactly, off the grid or not", () => {
    const { onChange, props } = renderSlider({ magnetAnchorsCents: [1013, 1233] });
    props.onValueChange(1238);
    expect(onChange).toHaveBeenLastCalledWith(1233);
  });
});

describe("keyboardAmountCents — never against the key's direction", () => {
  const at = (valueCents: number, keyboardCeilingCents = 7500) => ({
    valueCents,
    floorCents: 500,
    maxCents: 7500,
    keyboardCeilingCents,
  });

  it("up keys step up to the ceiling, and do nothing at or above it", () => {
    expect(keyboardAmountCents("ArrowUp", at(1500))).toBe(1600);
    expect(keyboardAmountCents("PageUp", at(1500))).toBe(2000);
    expect(keyboardAmountCents("ArrowRight", at(7450))).toBe(7500);
    expect(keyboardAmountCents("ArrowUp", at(7500))).toBeNull();
    // A typed $200 above the track: up leaves it alone.
    expect(keyboardAmountCents("ArrowUp", at(20_000))).toBeNull();
    expect(keyboardAmountCents("End", at(20_000))).toBeNull();
  });

  it("down keys step down from the amount itself, never below the floor", () => {
    expect(keyboardAmountCents("ArrowDown", at(20_000))).toBe(19_900);
    expect(keyboardAmountCents("PageDown", at(20_000))).toBe(19_500);
    expect(keyboardAmountCents("ArrowLeft", at(550))).toBe(500);
    expect(keyboardAmountCents("ArrowDown", at(500))).toBeNull();
    // Under the floor: down does not raise it.
    expect(keyboardAmountCents("ArrowDown", at(300))).toBeNull();
  });

  it("the box office's open ceiling: up keeps going past the track end", () => {
    expect(keyboardAmountCents("ArrowUp", at(7500, Infinity))).toBe(7600);
  });

  it("Home is the floor, End the track end; other keys are not ours", () => {
    expect(keyboardAmountCents("Home", at(3000))).toBe(500);
    expect(keyboardAmountCents("End", at(3000))).toBe(7500);
    expect(keyboardAmountCents("Tab", at(3000))).toBeUndefined();
  });

  it("the component swallows a refused key so the native 5¢ step cannot run", () => {
    const { onChange, props } = renderSlider({ valueCents: 20_000, keyboardCeilingCents: 7500 });
    const event = { key: "ArrowUp", preventDefault: vi.fn() };
    props.onKeyDown!(event as never);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Alt/Cmd/Ctrl + a key passes through untouched (Alt+← is the browser's Back)", () => {
    const { onChange, props } = renderSlider();
    for (const mod of ["altKey", "metaKey", "ctrlKey"] as const) {
      const event = { key: "ArrowLeft", [mod]: true, preventDefault: vi.fn() };
      props.onKeyDown!(event as never);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(onChange).not.toHaveBeenCalled();
    // Control: the bare key is still a $1 step.
    props.onKeyDown!({ key: "ArrowLeft", preventDefault: vi.fn() } as never);
    expect(onChange).toHaveBeenCalledWith(1400);
  });
});
