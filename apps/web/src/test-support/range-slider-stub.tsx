import type { RangeSliderProps } from "@th/ui";

/**
 * Test stand-in for `@th/ui`'s `RangeSlider`, for suites that mock the design
 * system away. It renders the SAME DOM contract as the real one — a native
 * `<input type="range">` carrying `aria-label`, `aria-valuetext`,
 * `aria-valuemin/max/now` and `data-testid`, with `onKeyDown` forwarded — and
 * drops only the scoped `<style>` block (jsdom has no `CSS.escape`).
 *
 * Use it from an async mock factory:
 *
 *   vi.mock("@th/ui", async () => ({
 *     ...,
 *     RangeSlider: (await import("@/test-support/range-slider-stub")).RangeSliderStub,
 *   }));
 */
export function RangeSliderStub({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  valueText,
  disabled = false,
  testId,
  onKeyDown,
}: RangeSliderProps) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onValueChange(Number(event.target.value))}
      onKeyDown={onKeyDown}
      disabled={disabled}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      data-testid={testId}
    />
  );
}
