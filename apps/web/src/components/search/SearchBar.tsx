"use client";

import type { FormEvent, CSSProperties } from "react";
import { useCallback } from "react";
import { Search, ArrowRight } from "lucide-react";
import { useTranslations } from "@th/ui";

/* ------------------------------------------------------------------ */
/*  Style factory (parameterised by height so callers can customise)    */
/* ------------------------------------------------------------------ */

const buildStyles = (height: number) => {
  const iconLeft = height <= 44 ? 12 : 14;
  const inputPaddingLeft = iconLeft + 28;

  return {
    form: {
      display: "flex",
      width: "100%",
      alignItems: "stretch",
    } satisfies CSSProperties,

    inputWrapper: {
      flex: 1,
      position: "relative",
      display: "flex",
    } satisfies CSSProperties,

    icon: {
      position: "absolute",
      left: iconLeft,
      top: 0,
      bottom: 0,
      display: "flex",
      alignItems: "center",
      pointerEvents: "none",
    } satisfies CSSProperties,

    input: {
      width: "100%",
      height,
      paddingLeft: inputPaddingLeft,
      paddingRight: 12,
      border: "1px solid var(--borderColor)",
      borderRight: "none",
      borderRadius: 0,
      backgroundColor: "var(--surface)",
      color: "var(--color)",
      fontSize: 15,
      fontFamily: "var(--font-body)",
      boxSizing: "border-box",
    } satisfies CSSProperties,

    button: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: height,
      height,
      border: "1px solid var(--accent)",
      borderRadius: 0,
      backgroundColor: "var(--accent)",
      cursor: "pointer",
      flexShrink: 0,
      boxSizing: "border-box",
    } satisfies CSSProperties,

    buttonDisabled: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: height,
      height,
      border: "1px solid var(--accent)",
      borderRadius: 0,
      backgroundColor: "var(--accent)",
      cursor: "default",
      flexShrink: 0,
      boxSizing: "border-box",
      opacity: 0.5,
    } satisfies CSSProperties,
  };
};

/* Pre-built for common sizes so we avoid object allocation on every render */
const STYLES_44 = buildStyles(44);
const STYLES_48 = buildStyles(48);

const stylesForHeight = (h: number) => {
  if (h === 44) return STYLES_44;
  if (h === 48) return STYLES_48;
  return buildStyles(h);
};

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export type SearchBarProps = {
  /** Current search value (controlled). */
  value: string;
  /** Called when the text changes. */
  onChangeValue: (value: string) => void;
  /** Called when the form is submitted with a non-empty trimmed value. */
  onSubmit: (trimmedValue: string) => void;
  /** Placeholder text. @default "Search events..." */
  placeholder?: string;
  /** Height of the input + button in px. @default 48 */
  height?: number;
  /** data-testid applied to the wrapping `<form>`. */
  testId?: string;
  /** aria-label for the input. @default "Search events" */
  ariaLabel?: string;
};

export const SearchBar = ({
  value,
  onChangeValue,
  onSubmit,
  placeholder,
  height = 48,
  testId,
  ariaLabel,
}: SearchBarProps) => {
  const t = useTranslations();
  const s = stylesForHeight(height);
  const hasValue = value.trim().length > 0;

  const handleFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) return;
      onSubmit(trimmed);
    },
    [value, onSubmit],
  );

  return (
    <form onSubmit={handleFormSubmit} data-testid={testId} style={s.form}>
      <div style={s.inputWrapper}>
        <span style={s.icon} aria-hidden="true">
          <Search size={18} color="var(--colorMuted)" />
        </span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChangeValue(e.target.value)}
          placeholder={placeholder ?? (t("search.searchEvents") as string)}
          aria-label={ariaLabel ?? (t("search.searchEventsLabel") as string)}
          style={s.input}
        />
      </div>
      <button
        type="submit"
        aria-label={t("search.searchButton") as string}
        disabled={!hasValue}
        style={hasValue ? s.button : s.buttonDisabled}
      >
        {/* Submit button fills with var(--accent) — glyph rides its paired
            $onBrandSecondary (white on Stub's #E2481D, ink on Ember's
            #FF5721, where a white arrow would be 3.16:1). */}
        <ArrowRight
          size={20}
          color="var(--onBrandSecondary, #FFFFFF)"
          aria-hidden="true"
        />
      </button>
    </form>
  );
};

SearchBar.displayName = "SearchBar";
