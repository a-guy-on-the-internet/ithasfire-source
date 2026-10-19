import { useTheme } from "tamagui";
import type { CSSProperties } from "react";
import { stubTheme } from "../../tokens/colors";
import { Reveal } from "../effects/Reveal";
import { CharCountTextarea } from "./CharCountTextarea";

// ---------------------------------------------------------------------------
// MultiChipGroup — multi-select chip group with optional "Other" freeform
//
// Swiss form pattern: rectangular chips, accent fill on selected, and an
// optional detail reveal when the user selects any chip. Stores an array of
// selected keys.
// ---------------------------------------------------------------------------

export interface MultiChipGroupOption {
  key: string;
  label: string;
}

export interface MultiChipGroupProps {
  /** Options as key-label pairs. */
  options: MultiChipGroupOption[] | Record<string, string>;
  /** Currently selected keys. */
  value: string[];
  /** Called when selection changes. */
  onChange: (keys: string[]) => void;
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
  /**
   * Freeze the group. Needed wherever the surrounding form disables its inputs
   * during an in-flight save: without it this is the one control still live,
   * and a toggle made mid-save is silently overwritten when the form re-seeds
   * from the server response.
   */
  disabled?: boolean;
  /** Test automation base id. */
  testIdBase?: string;
  /** Stretch chips to fill available row width when possible. */
  fillContainer?: boolean;
}

function normalizeOptions(
  options: MultiChipGroupOption[] | Record<string, string>,
): MultiChipGroupOption[] {
  if (Array.isArray(options)) return options;
  return Object.entries(options).map(([key, label]) => ({ key, label }));
}

export function MultiChipGroup({
  options,
  value,
  onChange,
  detail,
  onDetailChange,
  detailPlaceholder = "Add details (optional)...",
  detailMaxLength = 500,
  error,
  disabled = false,
  testIdBase,
  fillContainer = false,
}: MultiChipGroupProps) {
  const theme = useTheme();
  const items = normalizeOptions(options);
  // The #B93312 rung, NOT `brandSecondary` (#E2481D): `accent` fills the SELECTED chip, whose 11px
  // bold label is `onBrandSecondary` (white on Stub). White on #E2481D is 4.06:1 (fail); on the
  // rung it's 5.92:1. Ember/Swiss keep AA too. Matches ChipGroup + the EventCard/calendar fixes.
  const accent = theme.brandSecondaryHover?.val ?? stubTheme.brandSecondaryHover;
  const bg = theme.surfaceMuted?.val ?? stubTheme.surfaceMuted;
  const border = theme.borderColor?.val ?? stubTheme.borderColor;
  const muted = theme.colorMuted?.val ?? stubTheme.colorMuted;
  const errorColor = theme.danger?.val ?? stubTheme.danger;
  const unselectedBorder = error ? errorColor : border;

  const toggle = (key: string) => {
    if (disabled) return;
    if (value.includes(key)) {
      onChange(value.filter((k) => k !== key));
    } else {
      onChange([...value, key]);
    }
  };

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
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
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

  const hasSelection = value.length > 0;

  return (
    <div
      {...(testIdBase ? { "data-testid": `${testIdBase}-multichipgroup` } : {})}
      role="group"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map(({ key, label }) => {
          const selected = value.includes(key);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => toggle(key)}
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
        <Reveal show={hasSelection} testIdBase={testIdBase}>
          <div style={{ paddingTop: 4 }}>
            <CharCountTextarea
              value={detail ?? ""}
              onChange={onDetailChange}
              placeholder={detailPlaceholder}
              maxLength={detailMaxLength}
              disabled={disabled}
              height={48}
              testIdBase={testIdBase ? `${testIdBase}-detail` : undefined}
            />
          </div>
        </Reveal>
      )}
    </div>
  );
}
