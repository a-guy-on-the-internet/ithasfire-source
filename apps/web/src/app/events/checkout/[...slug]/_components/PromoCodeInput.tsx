"use client";

import React, { useState, useCallback } from "react";
import type { CSSProperties } from "react";
import { Tag, X } from "lucide-react";
import { useTranslations } from "@th/ui";
import { ACCENT_FILL, ACCENT_TEXT, DANGER_TEXT, ON_ACCENT_FILL } from "@/lib/design-tokens";
import {
  FG as fg,
  FG_MUTED,
  DIVIDER_COLOR,
  SURFACE_OVERLAY,
  ACCENT,
  ACCENT_SOFT,
  FS_SM,
} from "./checkout-tokens";

export type PromoCodeInputProps = {
  /** Currently applied promo codes. */
  appliedCodes: string[];
  /** Called when the user wants to add a code. Returns an error key or null on success. */
  onApply: (code: string) => string | null;
  /** Called when the user removes an applied code. */
  onRemove: (code: string) => void;
  /** Whether the input should be disabled (e.g. during payment). */
  disabled?: boolean;
  /**
   * Applied codes that don't apply to the cart right now: normalized code →
   * the i18n key of the reason. The code stays applied (it may apply again
   * when the cart changes) and the reason is shown beside it.
   */
  rejections?: Record<string, string>;
  /**
   * Discounts couldn't be checked just now (the preview failed for a
   * non-promo reason). Typed codes stay applied and member discounts are
   * resolved again at payment; the note says so instead of leaving a $0
   * discount unexplained — with or without a typed code (a signed-in
   * member's benefit preview can fail with none).
   */
  checkUnavailable?: boolean;
  /**
   * The code from the buyer's LINK couldn't be checked (5xx / unreachable),
   * so it was not applied. Says so, and how to retry.
   */
  urlCheckUnavailable?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Styles
//
// Static style objects are module-level constants so React doesn't allocate
// new objects per render. Anything that depends on render state (focus,
// disabled, active) is a small builder function returning CSSProperties.
//
// Critical: the row wrapper, the input wrapper, and the <input> all need
// `minWidth: 0` so flexbox is allowed to shrink them below their intrinsic
// content size. Without it, at narrow viewports the wrapper refuses to
// shrink (default `min-width: auto` = min-content), pushing the Apply
// button past OrderSummary's `overflow: hidden` and clipping its right
// edge. `size={1}` on the input is the matching attribute-side fix; <input>
// ignores `min-width: 0` from flex unless its `size` is also small.
// ─────────────────────────────────────────────────────────────────────────────

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const inputRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "stretch",
  minWidth: 0,
};

const inputWrapperBaseStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 12px",
  borderRadius: 0,
  background: SURFACE_OVERLAY,
  transition: "border-color 0.15s",
};

const buildInputWrapperStyle = (
  isFocused: boolean,
  disabled: boolean,
): CSSProperties => ({
  ...inputWrapperBaseStyle,
  border: `1px solid ${isFocused ? ACCENT : DIVIDER_COLOR}`,
  opacity: disabled ? 0.5 : 1,
});

const tagIconStyle: CSSProperties = {
  color: fg,
  opacity: 0.5,
  flexShrink: 0,
};

const inputElementStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "10px 0",
  fontSize: FS_SM,
  fontFamily: "inherit",
  color: fg,
  background: "transparent",
  border: "none",
};

const applyButtonBaseStyle: CSSProperties = {
  flexShrink: 0,
  minWidth: 76,
  padding: "0 18px",
  fontSize: FS_SM,
  fontWeight: 700,
  fontFamily: "inherit",
  textTransform: "uppercase",
  letterSpacing: 1.5,
  borderRadius: 0,
  transition: "background 0.15s, color 0.15s, border-color 0.15s",
  whiteSpace: "nowrap",
};

const buildApplyButtonStyle = (isActive: boolean): CSSProperties => ({
  ...applyButtonBaseStyle,
  // The #B93312 rung + white (5.92:1) when enabled. This 13px/700 APPLY label cannot sit on
  // `ACCENT`: checkout-tokens already resolves that to Stub's #E2481D, which has NO AA foreground
  // in either polarity (white 4.06:1, ink 4.38:1) — so this button was already below the floor and
  // the old "never white-on-orange, 3.16:1" note was reasoning about the retired #FF5721.
  color: isActive ? ON_ACCENT_FILL : FG_MUTED,
  background: isActive ? ACCENT_FILL : "transparent",
  border: `1px solid ${isActive ? ACCENT_FILL : FG_MUTED}`,
  cursor: isActive ? "pointer" : "not-allowed",
});

const errorMessageStyle: CSSProperties = {
  margin: 0,
  fontSize: FS_SM,
  color: DANGER_TEXT,
  lineHeight: 1.4,
};

const appliedCodeListStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const appliedCodeChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  fontSize: FS_SM,
  fontWeight: 500,
  color: fg,
  background: "rgba(33,28,22,0.06)",
  border: `1px solid ${DIVIDER_COLOR}`,
  borderRadius: 0,
};

const appliedCodeRemoveButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: FG_MUTED,
  lineHeight: 1,
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const PromoCodeInput = ({
  appliedCodes,
  onApply,
  onRemove,
  disabled = false,
  rejections,
  checkUnavailable = false,
  urlCheckUnavailable = false,
}: PromoCodeInputProps) => {
  const t = useTranslations();
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  const handleApply = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    const errorKey = onApply(trimmed);
    if (errorKey) {
      setError(errorKey);
    } else {
      setInputValue("");
      setError(null);
    }
  }, [inputValue, onApply]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleApply();
      }
    },
    [handleApply],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setInputValue(e.target.value);
      setError(null);
    },
    [],
  );

  const isApplyActive = !disabled && inputValue.trim().length > 0;

  return (
    <div style={rootStyle}>
      <div style={inputRowStyle}>
        <div style={buildInputWrapperStyle(isFocused, disabled)}>
          <Tag size={14} style={tagIconStyle} />
          <input
            type="text"
            size={1}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            disabled={disabled}
            placeholder={String(t("checkout.promoCodePlaceholder"))}
            aria-label={String(t("checkout.promoCodePlaceholder"))}
            style={inputElementStyle}
          />
        </div>
        <button
          type="button"
          onClick={handleApply}
          disabled={!isApplyActive}
          style={buildApplyButtonStyle(isApplyActive)}
          // The inverted hover/focus swaps to the soft tint with ACCENT-as-ink, so the label rides
          // `ACCENT_TEXT` (#B93312) — `ACCENT` (#E2481D) as ink on a light tint is ~3.6:1. The
          // leave/blur handlers MUST restore the same pair `buildApplyButtonStyle` rests on, or the
          // button repaints a different colour than it started with.
          onMouseEnter={(e) => {
            if (isApplyActive) {
              e.currentTarget.style.background = ACCENT_SOFT;
              e.currentTarget.style.color = ACCENT_TEXT;
            }
          }}
          onMouseLeave={(e) => {
            if (isApplyActive) {
              e.currentTarget.style.background = ACCENT_FILL;
              e.currentTarget.style.color = ON_ACCENT_FILL;
            }
          }}
          onFocus={(e) => {
            if (isApplyActive) {
              e.currentTarget.style.background = ACCENT_SOFT;
              e.currentTarget.style.color = ACCENT_TEXT;
            }
          }}
          onBlur={(e) => {
            if (isApplyActive) {
              e.currentTarget.style.background = ACCENT_FILL;
              e.currentTarget.style.color = ON_ACCENT_FILL;
            }
          }}
        >
          {String(t("checkout.promoCodeApply"))}
        </button>
      </div>

      {error && (
        <p role="alert" style={errorMessageStyle}>
          {String(t(error as Parameters<typeof t>[0]))}
        </p>
      )}

      {appliedCodes.length > 0 && (
        <div style={appliedCodeListStyle}>
          {appliedCodes.map((code) => (
            <span key={code} style={appliedCodeChipStyle}>
              {code.toUpperCase()}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onRemove(code)}
                  aria-label={`${String(t("checkout.promoCodeRemove"))} ${code}`}
                  style={appliedCodeRemoveButtonStyle}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {checkUnavailable && (
        <p
          role="status"
          data-testid="promo-code-check-unavailable"
          style={errorMessageStyle}
        >
          {String(t("checkout.promoCheckUnavailable"))}
        </p>
      )}

      {urlCheckUnavailable && (
        <p
          role="status"
          data-testid="promo-code-url-check-unavailable"
          style={errorMessageStyle}
        >
          {String(t("checkout.promoUrlCheckUnavailable"))}
        </p>
      )}

      {appliedCodes.some((code) => rejections?.[code.trim().toUpperCase()]) && (
        <div role="status" aria-live="polite">
          {appliedCodes.map((code) => {
            const key = rejections?.[code.trim().toUpperCase()];
            if (!key) return null;
            return (
              <p
                key={code}
                data-testid="promo-code-rejection"
                style={errorMessageStyle}
              >
                {code.toUpperCase()}: {String(t(key as Parameters<typeof t>[0]))}
              </p>
            );
          })}
          {/* The server evaluates codes together and refuses the order on
              the first one that fails, so while one is flagged NONE apply —
              say so, rather than let the missing discount look like a bug. */}
          {appliedCodes.length > 1 && (
            <p data-testid="promo-code-others-blocked" style={errorMessageStyle}>
              {String(t("checkout.promoOthersBlocked"))}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
