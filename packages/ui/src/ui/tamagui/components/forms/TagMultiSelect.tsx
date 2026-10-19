"use client";

import { useState, useCallback, useRef, type KeyboardEvent } from "react";
import { useTheme } from "tamagui";
import type { CSSProperties } from "react";

import { stubTheme } from "../../tokens/colors";

// ---------------------------------------------------------------------------
// TagMultiSelect — tag multi-select with pre-populated tags + custom input
//
// Swiss form pattern: wrapping flex row of rectangular chip buttons, toggle
// on/off, text input for filtering/custom tags. Popular tags sort first.
// Stores String[] of tag display names. Custom tags render as chips
// immediately after typing + Enter.
// ---------------------------------------------------------------------------

export interface TagMultiSelectProps {
  /** Pre-populated available tags (display names). */
  availableTags: string[];
  /** Currently selected tag names. */
  value: string[];
  /** Called when selection changes. */
  onChange: (tags: string[]) => void;
  /** Placeholder text for the input field. */
  placeholder?: string;
  /**
   * `name`/`id` for the search input.
   *
   * Chrome DevTools flags a form field with neither ("A form field element
   * should have an id or name attribute") — it defeats autofill heuristics and
   * password managers, and leaves the field unaddressable by `<label for>`.
   * The field is a filter box, not submitted data, so this is optional; supply
   * it whenever the component is inside a real form context.
   */
  inputName?: string;
  /** Test automation base id. */
  testIdBase?: string;
}

export function TagMultiSelect({
  availableTags,
  value,
  onChange,
  placeholder = "Search or add a tag…",
  inputName,
  testIdBase,
}: TagMultiSelectProps) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // SELECTED-chip fill. The #B93312 rung, NOT `brandSecondary` (#E2481D) —
  // identical reasoning (and wording) to `MultiChipGroup`, which sits in this
  // folder and already made the fix: the selected chip's label is 11px bold
  // `onBrandSecondary` (white on Stub), which is 4.06:1 on #E2481D — MEASURED
  // in the browser, and below the 4.5:1 small-text floor — versus 5.92:1 on the
  // rung. Ember/Swiss keep AA too. This component was the last chip renderer
  // still on the failing rung, so the job chips and the genre chips directly
  // below them were rendering two different reds.
  const accent =
    theme.brandSecondaryHover?.val ?? stubTheme.brandSecondaryHover;
  // The same hue at LABEL legibility, for the one place accent is used as text
  // (the "+ new tag" affordance). `accent` is a fill/graphic value; as a
  // control's accessible label it is 3.57:1 on Stub. On Stub `accentText`
  // resolves to the same #B93312 as the fill above; on Ember they differ.
  const accentLabel = theme.accentText?.val ?? stubTheme.accentText;
  const bg = theme.surfaceMuted?.val ?? stubTheme.surfaceMuted;
  const border = theme.borderColor?.val ?? stubTheme.borderColor;
  const muted = theme.colorMuted?.val ?? stubTheme.colorMuted;
  const fg = theme.color?.val ?? stubTheme.color;

  // Deduplicate: merge pre-populated + any custom tags already in value
  const allTags = Array.from(new Set([...availableTags, ...value]));

  // Filter by query (case-insensitive)
  const filtered = query
    ? allTags.filter((t) => t.toLowerCase().includes(query.toLowerCase()))
    : allTags;

  // Is the query a new custom tag?
  const isCustom =
    query.trim().length > 0 &&
    !allTags.some((t) => t.toLowerCase() === query.trim().toLowerCase());

  const toggle = useCallback(
    (tag: string) => {
      if (value.includes(tag)) {
        onChange(value.filter((t) => t !== tag));
      } else {
        onChange([...value, tag]);
      }
    },
    [value, onChange],
  );

  const addCustom = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (!value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setQuery("");
    inputRef.current?.focus();
  }, [query, value, onChange]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (isCustom) {
          addCustom();
        } else if (filtered.length === 1) {
          toggle(filtered[0]);
          setQuery("");
        }
      }
    },
    [isCustom, addCustom, filtered, toggle],
  );

  const chipBase: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "4px 12px",
    minHeight: 36,
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
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    // iOS Safari auto-zooms focused inputs with font-size < 16px.
    // Keep this at 16px to avoid disruptive viewport zoom on mobile.
    fontSize: 16,
    fontFamily: "var(--font-body, Inter, sans-serif)",
    background: "transparent",
    border: "none",
    borderBottom: `2px solid ${border}`,
    color: fg,
    borderRadius: 0,
    transition: "border-color 150ms ease-out",
  };

  return (
    <div
      {...(testIdBase ? { "data-testid": `${testIdBase}-tagmultiselect` } : {})}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      {/* Search / custom input */}
      <input
        ref={inputRef}
        type="text"
        role="searchbox"
        {...(inputName ? { id: inputName, name: inputName } : {})}
        aria-label={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        enterKeyHint="done"
        autoComplete="off"
        style={inputStyle}
        onFocus={(e) => {
          e.currentTarget.style.borderBottomColor = accent;
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderBottomColor = border;
        }}
      />
      {/* Chip grid */}
      <div
        role="group"
        aria-label="Available tags"
        style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
      >
        {filtered.map((tag) => {
          const selected = value.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={selected}
              onClick={() => toggle(tag)}
              style={{
                ...chipBase,
                background: selected ? accent : bg,
                borderColor: selected ? accent : border,
                color: selected
                  ? (theme.onBrandSecondary?.val ?? stubTheme.onBrandSecondary)
                  : muted,
              }}
            >
              {tag}
            </button>
          );
        })}
        {isCustom && (
          <button
            type="button"
            onClick={addCustom}
            style={{
              ...chipBase,
              background: "transparent",
              borderColor: accent,
              borderStyle: "dashed",
              // Label, not fill — see `accentLabel`.
              color: accentLabel,
            }}
          >
            + {query.trim()}
          </button>
        )}
      </div>
    </div>
  );
}
