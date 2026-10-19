"use client";

import React, { useState, useCallback } from "react";
import { Tag, X } from "lucide-react";

import {
  BRAND_ORANGE,
  STEEL_BLUE,
  TEXT,
  TEXT_CAPTION,
  SURFACE,
  SURFACE_INPUT,
  SURFACE_MUTED,
  BORDER,
  BORDER_SUBTLE,
  DANGER,
  sectionLabelStyle,
} from "./embed-theme";

export type EmbedPromoCodeInputProps = {
  appliedCodes: string[];
  onApply: (code: string) => string | null;
  onRemove: (code: string) => void;
  disabled?: boolean;
};

export function EmbedPromoCodeInput({
  appliedCodes,
  onApply,
  onRemove,
  disabled = false,
}: EmbedPromoCodeInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  const handleApply = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    const errorMsg = onApply(trimmed);
    if (errorMsg) {
      setError(errorMsg);
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Section header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Tag size={14} style={{ color: STEEL_BLUE }} aria-hidden />
        <h3 style={sectionLabelStyle}>Promo code</h3>
      </div>

      {/* Input row */}
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
            border: isFocused
              ? `1px solid ${BRAND_ORANGE}`
              : `1px solid ${BORDER}`,
            borderRadius: 0,
            background: SURFACE_INPUT,
            transition: "border-color 0.15s",
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <input
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            disabled={disabled}
            placeholder="Enter code"
            aria-label="Promo code"
            style={{
              flex: 1,
              padding: "10px 0",
              fontSize: 14,
              fontFamily: "inherit",
              color: TEXT,
              background: "transparent",
              border: "none",
            }}
          />
        </div>
        <button
          type="button"
          onClick={handleApply}
          disabled={disabled || !inputValue.trim()}
          style={{
            padding: "0 16px",
            fontSize: 12,
            fontWeight: 700,
            fontFamily: "inherit",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: STEEL_BLUE,
            background: SURFACE,
            border: `1px solid ${BORDER}`,
            borderRadius: 0,
            cursor: disabled || !inputValue.trim() ? "not-allowed" : "pointer",
            opacity: disabled || !inputValue.trim() ? 0.4 : 1,
            transition: "background 0.15s, opacity 0.15s",
            whiteSpace: "nowrap",
          }}
        >
          Apply
        </button>
      </div>

      {/* Error */}
      {error && (
        <p
          role="alert"
          style={{
            margin: 0,
            fontSize: 12,
            color: DANGER,
            lineHeight: 1.4,
          }}
        >
          {error}
        </p>
      )}

      {/* Applied codes chips */}
      {appliedCodes.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {appliedCodes.map((code) => (
            <span
              key={code}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.04em",
                color: TEXT,
                background: SURFACE_MUTED,
                border: `1px solid ${BORDER_SUBTLE}`,
                borderRadius: 0,
              }}
            >
              {code.toUpperCase()}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onRemove(code)}
                  aria-label={`Remove ${code}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: TEXT_CAPTION,
                    lineHeight: 1,
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
