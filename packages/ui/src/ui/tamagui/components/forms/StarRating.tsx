import { useTheme } from "tamagui";
import type { CSSProperties } from "react";

import { stubTheme } from "../../tokens/colors";

// ---------------------------------------------------------------------------
// StarRating — Swiss-style rectangular block rating (1-5)
//
// Not round stars — 5 rectangular blocks filled with accent color up to the
// selected rating. Click to select, click same to deselect. Displays
// numeric value next to the rating: "4 / 5".
// ---------------------------------------------------------------------------

export interface StarRatingProps {
  /** Currently selected rating (1-5, or 0/undefined for none). */
  value: number;
  /** Called when rating changes. Passes 0 if deselected. */
  onChange: (rating: number) => void;
  /** Maximum rating. Default 5. */
  max?: number;
  /** Test automation base id. */
  testIdBase?: string;
}

export function StarRating({
  value,
  onChange,
  max = 5,
  testIdBase,
}: StarRatingProps) {
  const theme = useTheme();
  const accent = theme.brandSecondary?.val ?? stubTheme.brandSecondary;
  const bg = theme.surfaceMuted?.val ?? stubTheme.surfaceMuted;
  const border = theme.borderColor?.val ?? stubTheme.borderColor;
  const muted = theme.colorMuted?.val ?? stubTheme.colorMuted;

  const blockStyle = (filled: boolean): CSSProperties => ({
    width: 32,
    height: 32,
    borderRadius: 0,
    border: `1px solid ${filled ? accent : border}`,
    background: filled ? accent : bg,
    cursor: "pointer",
    transition: "all 150ms ease-out",
    flexShrink: 0,
  });

  const blocks = Array.from({ length: max }, (_, i) => i + 1);

  return (
    <div
      {...(testIdBase ? { "data-testid": `${testIdBase}-starrating` } : {})}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      {blocks.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(value === n ? 0 : n)}
          style={blockStyle(n <= value)}
          aria-label={`${n} of ${max}`}
        />
      ))}
      <span
        style={{
          marginLeft: 10,
          fontSize: 13,
          fontWeight: 700,
          fontFamily: "var(--font-body, Inter, sans-serif)",
          color: value > 0 ? accent : muted,
          letterSpacing: "0.04em",
          minWidth: 40,
        }}
      >
        {value > 0 ? `${value} / ${max}` : `— / ${max}`}
      </span>
    </div>
  );
}
