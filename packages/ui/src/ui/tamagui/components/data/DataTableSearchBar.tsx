"use client";

import { Search, X } from "lucide-react";

import { DT_BORDER, DT_INK, DT_INK_MUTED, DT_SURFACE } from "./tokens";

interface DataTableSearchBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  onClear: () => void;
  testIdBase: string;
  /** Consumers localise the default copy via these two props. */
  placeholder?: string;
  clearLabel?: string;
}

/** Built-in search bar (web; renders above the table AND in card mode). */
export function DataTableSearchBar({
  query,
  onQueryChange,
  onClear,
  testIdBase,
  placeholder = "Search",
  clearLabel = "Clear search",
}: DataTableSearchBarProps) {
  return (
    <div
      role="search"
      aria-label={placeholder}
      className="dt-search-bar"
      data-testid={`${testIdBase}-search`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        maxWidth: 420,
        marginBottom: 8,
        padding: "0 10px",
        minHeight: 40,
        border: `2px solid ${DT_BORDER}`,
        borderRadius: 0,
        background: DT_SURFACE,
      }}
    >
      <Search
        size={16}
        aria-hidden="true"
        style={{ flexShrink: 0, color: DT_INK_MUTED }}
      />
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        enterKeyHint="search"
        data-testid={`${testIdBase}-search-input`}
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          background: "transparent",
          font: "inherit",
          fontSize: 14,
          color: DT_INK,
          padding: "8px 0",
        }}
      />
      {query ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel}
          data-testid={`${testIdBase}-search-clear`}
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            padding: 0,
            border: "none",
            borderRadius: 0,
            background: "transparent",
            cursor: "pointer",
            color: DT_INK_MUTED,
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
