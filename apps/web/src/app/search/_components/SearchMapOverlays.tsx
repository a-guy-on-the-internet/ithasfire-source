"use client";

import type { CSSProperties } from "react";

import type { SearchMapKind } from "./search-map-items";

// Overlays that sit ON the results map but are not map paint: the two-chip
// layer legend (All scope) and the "N venues keep their location private"
// line. Plain DOM, so they are real controls/text — outside the map's
// role="img" region, reachable by keyboard and screen readers.

const FONT_BODY = "var(--font-body, Montserrat, sans-serif)";
const FONT_MONO = "var(--font-mono, ui-monospace, monospace)";
const INK = "var(--color, #211C16)";
const SURFACE = "var(--surface, #FDFAF3)";
const BORDER = "var(--borderColor, #211C16)";

const legendStyle: CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  zIndex: 5,
  display: "flex",
  gap: 4,
};

const chipBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0 9px",
  fontFamily: FONT_BODY,
  fontSize: 11,
  fontWeight: 700,
  color: INK,
  background: SURFACE,
  border: `2px solid ${BORDER}`,
  borderRadius: 0,
  cursor: "pointer",
  transition: "opacity 150ms ease",
};

const countStyle: CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.4px",
  fontVariantNumeric: "tabular-nums",
};

const noteStyle: CSSProperties = {
  position: "absolute",
  left: 8,
  right: 8,
  bottom: 8,
  zIndex: 4,
  margin: 0,
  padding: "5px 8px",
  fontFamily: FONT_BODY,
  fontSize: 11,
  lineHeight: 1.4,
  color: INK,
  background: SURFACE,
  border: `1px solid ${BORDER}`,
};

/** The legend key: an event is a dot, a venue is a square — as on the map. */
function LayerGlyph({ kind }: { kind: SearchMapKind }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden focusable="false">
      {kind === "event" ? (
        <circle
          cx="5"
          cy="5"
          r="3.75"
          fill="var(--accent, #E2481D)"
          stroke="var(--color, #211C16)"
          strokeWidth="1.25"
        />
      ) : (
        <rect x="1" y="1" width="8" height="8" fill="var(--color, #211C16)" />
      )}
    </svg>
  );
}

export type SearchMapLegendProps = {
  counts: Record<SearchMapKind, number>;
  layers: Record<SearchMapKind, boolean>;
  onToggle: (kind: SearchMapKind) => void;
  labels: { group: string; event: string; venue: string };
  /** Touch surfaces (the full-bleed map view) get 44px targets. */
  touch?: boolean;
};

export function SearchMapLegend({
  counts,
  layers,
  onToggle,
  labels,
  touch,
}: SearchMapLegendProps) {
  const kinds: SearchMapKind[] = ["event", "venue"];
  return (
    <div role="group" aria-label={labels.group} style={legendStyle}>
      {kinds.map((kind) => {
        const on = layers[kind];
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={on}
            disabled={counts[kind] === 0}
            onClick={() => onToggle(kind)}
            data-testid={`map-layer-${kind}`}
            style={{
              ...chipBase,
              minHeight: touch ? 44 : 32,
              opacity: on && counts[kind] > 0 ? 1 : 0.45,
              cursor: counts[kind] === 0 ? "default" : "pointer",
            }}
          >
            <LayerGlyph kind={kind} />
            {kind === "event" ? labels.event : labels.venue}
            <span style={countStyle}>{counts[kind]}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SearchMapPrivateNote({ text }: { text: string }) {
  return (
    <p style={noteStyle} data-testid="map-private-venues">
      {text}
    </p>
  );
}
