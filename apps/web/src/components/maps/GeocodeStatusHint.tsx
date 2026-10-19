"use client";

import React from "react";

const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

export type GeocodeStatusHintProps = {
  /** From `useGeocodeSuggestions().status`. */
  status: "no-results" | "error" | null;
  noResultsText: string;
  errorText: string;
  /** Test id base; the visible hint is `${idPrefix}-hint`. */
  idPrefix: string;
  /** Extra style for the visible line; spacing is the caller's call. */
  style?: React.CSSProperties;
};

/**
 * The "found nothing" / "could not look" message for a geocode input.
 *
 * Rendered IN FLOW under the input, never inside the absolutely-positioned
 * suggestion popup: a popup message floats over the next field and has no
 * keyboard route to dismiss it. The live region is always mounted (assistive
 * tech has to observe it BEFORE its text changes) and is the only announcer;
 * the visible line is not live, so nothing is read twice.
 */
export const GeocodeStatusHint = ({
  status,
  noResultsText,
  errorText,
  idPrefix,
  style,
}: GeocodeStatusHintProps) => {
  const text =
    status === "error" ? errorText : status === "no-results" ? noResultsText : "";
  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" style={srOnly}>
        {text}
      </span>
      {text ? (
        <div
          data-testid={`${idPrefix}-hint`}
          style={{
            fontSize: 12,
            lineHeight: 1.4,
            color:
              "color-mix(in srgb, var(--foreground, #211C16) 65%, transparent)",
            ...style,
          }}
        >
          {text}
        </div>
      ) : null}
    </>
  );
};
