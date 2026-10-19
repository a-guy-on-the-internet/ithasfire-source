import { useTheme } from "tamagui";
import type { CSSProperties } from "react";

import { stubTheme } from "../../tokens/colors";

// ---------------------------------------------------------------------------
// DayOfWeekSelect — 7 rectangular chip buttons (Mon–Sun), single-select
//
// Stores as Int (0 = Sun, 1 = Mon, …, 6 = Sat) matching JS Date.getDay().
// Swiss form pattern: rectangular chips, accent fill on selected state,
// 44px min touch targets, uppercase abbreviated labels.
// ---------------------------------------------------------------------------

const DAYS: { label: string; value: number }[] = [
  { label: "Sun", value: 0 },
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
];

export interface DayOfWeekSelectProps {
  /** Selected day (0=Sun through 6=Sat), or null/undefined for none. */
  value: number | null | undefined;
  /** Called when selection changes. Passes null if deselected. */
  onChange: (day: number | null) => void;
  /** Test automation base id. */
  testIdBase?: string;
}

export function DayOfWeekSelect({
  value,
  onChange,
  testIdBase,
}: DayOfWeekSelectProps) {
  const theme = useTheme();
  const accent = theme.brandSecondary?.val ?? stubTheme.brandSecondary;
  const bg = theme.surfaceMuted?.val ?? stubTheme.surfaceMuted;
  const border = theme.borderColor?.val ?? stubTheme.borderColor;
  const muted = theme.colorMuted?.val ?? stubTheme.colorMuted;

  const chipBase: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 44,
    minHeight: 44,
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    borderRadius: 0,
    cursor: "pointer",
    transition: "all 150ms ease-out",
    fontFamily: "var(--font-body, Inter, sans-serif)",
    border: "1px solid",
  };

  return (
    <div
      {...(testIdBase ? { "data-testid": `${testIdBase}-dayofweek` } : {})}
      role="radiogroup"
      aria-label="Day of the week"
      style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
    >
      {DAYS.map(({ label, value: dayValue }) => {
        const selected = value === dayValue;
        return (
          <button
            key={dayValue}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(selected ? null : dayValue)}
            style={{
              ...chipBase,
              background: selected ? accent : bg,
              borderColor: selected ? accent : border,
              color: selected
                ? (theme.onBrandSecondary?.val ?? stubTheme.onBrandSecondary)
                : muted,
            }}
            aria-label={label}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
