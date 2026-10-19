import { useTheme } from "tamagui";
import type { CSSProperties } from "react";
import { stubTheme } from "../../tokens/colors";
import { Reveal } from "../effects/Reveal";
import { CharCountTextarea } from "./CharCountTextarea";

// ---------------------------------------------------------------------------
// ChipGroup — single-select chip group with optional freeform detail reveal
//
// Swiss form pattern: rectangular chip buttons (borderRadius: 0), 44px min
// touch targets on mobile, accent color for selected state, and a conditional
// detail textarea that reveals when the user makes a selection.
// ---------------------------------------------------------------------------

export interface ChipGroupOption {
  key: string;
  label: string;
}

export interface ChipGroupProps {
  /** Options as key-label pairs. */
  options: ChipGroupOption[] | Record<string, string>;
  /** Currently selected key. */
  value: string;
  /** Called when a chip is selected. */
  onChange: (key: string) => void;
  /** Optional freeform detail text. */
  detail?: string;
  /** Called when detail text changes. Enables the detail textarea. */
  onDetailChange?: (value: string) => void;
  /** Placeholder for the detail textarea. */
  detailPlaceholder?: string;
  /** Max length for detail text. Default 500. */
  detailMaxLength?: number;
  /** Show error state — chip borders turn red. */
  error?: boolean;
  /** Test automation base id. */
  testIdBase?: string;
  /** Stretch chips to fill available row width when possible. */
  fillContainer?: boolean;
}

function normalizeOptions(
  options: ChipGroupOption[] | Record<string, string>,
): ChipGroupOption[] {
  if (Array.isArray(options)) return options;
  return Object.entries(options).map(([key, label]) => ({ key, label }));
}

export function ChipGroup({
  options,
  value,
  onChange,
  detail,
  onDetailChange,
  detailPlaceholder = "Add details (optional)...",
  detailMaxLength = 500,
  error,
  testIdBase,
  fillContainer = false,
}: ChipGroupProps) {
  const theme = useTheme();
  const items = normalizeOptions(options);
  // The #B93312 rung, NOT `brandSecondary` (#E2481D): `accent` fills the SELECTED chip, whose 11px
  // bold label is `onBrandSecondary` (white on Stub). White on #E2481D is 4.06:1 (fail); on the
  // rung it's 5.92:1. Ember/Swiss keep AA too (ink onBrandSecondary on #E84B19 = 4.61:1). Same
  // trade the EventCard/RangeCalendar/PriceBlock rung fixes make.
  const accent = theme.brandSecondaryHover?.val ?? stubTheme.brandSecondaryHover;
  const bg = theme.surfaceMuted?.val ?? stubTheme.surfaceMuted;
  const border = theme.borderColor?.val ?? stubTheme.borderColor;
  const muted = theme.colorMuted?.val ?? stubTheme.colorMuted;
  const errorColor = theme.danger?.val ?? stubTheme.danger;
  const unselectedBorder = error ? errorColor : border;

  const chipBase: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "6px 14px",
    minHeight: 44,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    borderRadius: 0,
    cursor: "pointer",
    transition: "all 150ms ease-out",
    whiteSpace: "nowrap",
    fontFamily: "var(--font-body, Inter, sans-serif)",
    border: "1px solid",
    ...(fillContainer
      ? {
          flex: "1 1 150px",
          maxWidth: "100%",
          whiteSpace: "normal" as const,
          overflowWrap: "anywhere" as const,
          lineHeight: 1.2,
          textAlign: "center" as const,
        }
      : {}),
  };

  return (
    <div
      {...(testIdBase ? { "data-testid": `${testIdBase}-chipgroup` } : {})}
      role="radiogroup"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map(({ key, label }) => {
          const selected = value === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(key)}
              style={{
                ...chipBase,
                background: selected ? accent : bg,
                borderColor: selected ? accent : unselectedBorder,
                color: selected
                  ? (theme.onBrandSecondary?.val ?? stubTheme.onBrandSecondary)
                  : muted,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      {onDetailChange && (
        <Reveal show={!!value} testIdBase={testIdBase}>
          <div style={{ paddingTop: 4 }}>
            <CharCountTextarea
              value={detail ?? ""}
              onChange={onDetailChange}
              placeholder={detailPlaceholder}
              maxLength={detailMaxLength}
              height={48}
              testIdBase={testIdBase ? `${testIdBase}-detail` : undefined}
            />
          </div>
        </Reveal>
      )}
    </div>
  );
}
