import type { CSSProperties, InputHTMLAttributes } from "react";

import styles from "./RadiusSlider.module.css";

export type RadiusSliderProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "min" | "max"
> & {
  value: number;
  min: number;
  max: number;
};

/**
 * The obfuscation-radius slider — a native `<input type="range">` in DS
 * colours rather than the browser's default blue. Shared by the event
 * builder's precision slider and the venue privacy fields so the two are
 * styled once.
 *
 * WebKit has no "filled part" pseudo-element, so the fill is a track gradient
 * driven by `--range-fill`, computed here from value/min/max. Firefox uses
 * `::-moz-range-progress`, and the variable is simply unused there.
 */
export function RadiusSlider({
  value,
  min,
  max,
  className,
  style,
  ...rest
}: RadiusSliderProps) {
  const span = max - min;
  const fill = span > 0 ? ((value - min) / span) * 100 : 0;
  return (
    <input
      {...rest}
      type="range"
      value={value}
      min={min}
      max={max}
      className={className ? `${styles.slider} ${className}` : styles.slider}
      style={
        {
          ...style,
          "--range-fill": `${Math.min(100, Math.max(0, fill))}%`,
        } as CSSProperties
      }
    />
  );
}
