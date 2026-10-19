"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { Popover, Spinner } from "@th/ui";
import { ACCENT } from "@/lib/design-tokens";
import { trpc } from "@/trpc";
import {
  BORDER_STRONG,
  MUTED,
  FG,
  ERROR_RED,
  INPUT_STYLE,
  MAX,
} from "../_shared/tokens";
import { LocationFields } from "./LocationFields";

// ─────────────────────────────────────────────────────────────────────────────
// PlaceAutocomplete — combobox venue search + custom venue fields
// ─────────────────────────────────────────────────────────────────────────────

interface PlaceAutocompleteProps {
  placeName: string;
  placeCity: string;
  placeCountry: string;
  placeState: string;
  placeId: string;
  onSelect: (id: string, name: string, city: string) => void;
  onCustom: (patch: {
    placeName?: string;
    placeCity?: string;
    placeCountry?: string;
    placeState?: string;
  }) => void;
  error?: string;
}

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

export function PlaceAutocomplete({
  placeName,
  placeCity,
  placeCountry,
  placeState,
  placeId,
  onSelect,
  onCustom,
  error,
}: PlaceAutocompleteProps) {
  const [query, setQuery] = useState(placeName);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [manualEntry, setManualEntry] = useState(false);
  const listboxId = useId().replace(/:/g, "");

  // Debounced query for server-side search (300ms)
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setDebouncedQuery("");
      return;
    }
    debounceRef.current = setTimeout(() => setDebouncedQuery(trimmed), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  useEffect(() => {
    setQuery(placeName);

    if (!placeId && !placeName) {
      setManualEntry(false);
      setOpen(false);
      setActiveIdx(-1);
      setDebouncedQuery("");
    }
  }, [placeId, placeName]);

  const { data, isFetching } = trpc.placeReviews.listDirectory.useQuery(
    { query: debouncedQuery },
    {
      enabled: debouncedQuery.length >= 2,
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    },
  );

  const matches = debouncedQuery.length >= 2 ? (data?.places ?? []) : [];

  const handleInput = useCallback(
    (val: string) => {
      setQuery(val);

      // When the user clears the input, reset manual-entry mode so the
      // location fields disappear and don't reopen until they explicitly
      // click "Add it as a new venue" again.
      if (val.length === 0) {
        setManualEntry(false);
        setOpen(false);
        onCustom({
          placeName: "",
          placeCity: "",
          placeCountry: "",
          placeState: "",
        });
        return;
      }

      setOpen(true);

      if (placeId || manualEntry) {
        onCustom({ placeName: val });
      }
    },
    [manualEntry, placeId, onCustom],
  );

  const showLocationFields =
    !placeId &&
    query.length >= 2 &&
    (matches.length === 0 || manualEntry) &&
    !isFetching;

  const listboxOpen = open && matches.length > 0 && debouncedQuery.length >= 2;
  const activeDescendant =
    listboxOpen && activeIdx >= 0 && activeIdx < matches.length
      ? `${listboxId}-option-${matches[activeIdx].id}`
      : undefined;

  useEffect(() => {
    if (!listboxOpen || activeIdx < 0 || activeIdx >= matches.length) return;
    document
      .getElementById(`${listboxId}-option-${matches[activeIdx].id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, listboxId, listboxOpen, matches]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!listboxOpen) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIdx((prev) => Math.min(prev + 1, matches.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIdx((prev) => Math.max(prev - 1, 0));
          break;
        case "Tab":
        case "Enter":
          if (activeIdx >= 0 && activeIdx < matches.length) {
            if (e.key === "Enter") e.preventDefault();
            const p = matches[activeIdx];
            onSelect(p.id, p.name, p.city ?? "");
            setQuery(p.name);
            setOpen(false);
            setActiveIdx(-1);
          }
          break;
        case "Escape":
          setOpen(false);
          setActiveIdx(-1);
          break;
        case "Home":
          if (listboxOpen) {
            e.preventDefault();
            setActiveIdx(0);
          }
          break;
        case "End":
          if (listboxOpen) {
            e.preventDefault();
            setActiveIdx(matches.length - 1);
          }
          break;
      }
    },
    [listboxOpen, activeIdx, matches, onSelect],
  );

  return (
    <div style={{ position: "relative" }}>
      <span role="status" aria-live="polite" aria-atomic="true" style={srOnly}>
        {isFetching && debouncedQuery.length >= 2
          ? "Searching places\u2026"
          : listboxOpen
            ? `${matches.length} place${matches.length === 1 ? "" : "s"} found`
            : showLocationFields
              ? "No matches \u2014 fill in details below"
              : ""}
      </span>
      <Popover
        open={listboxOpen}
        placement="bottom-start"
        offset={4}
        matchAnchorWidth
        contentProps={{
          padding: 0,
          zIndex: 4000,
          borderColor: BORDER_STRONG,
        }}
        anchor={
          <div style={{ position: "relative" }}>
            {isFetching && debouncedQuery.length >= 2 ? (
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  pointerEvents: "none",
                }}
              >
                <Spinner
                  width={14}
                  height={14}
                  borderWidth={2}
                  indicatorColor={ACCENT}
                />
              </div>
            ) : (
              <MapPin
                size={14}
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: MUTED,
                  pointerEvents: "none",
                }}
                aria-hidden="true"
              />
            )}
            <input
              id="venue-name"
              type="text"
              role="combobox"
              autoComplete="off"
              enterKeyHint="next"
              aria-expanded={listboxOpen}
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={activeDescendant}
              aria-label="Place name"
              aria-invalid={!!error}
              value={placeId ? placeName : query}
              onChange={(e) => {
                handleInput(e.target.value);
                setActiveIdx(-1);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() =>
                setTimeout(() => {
                  setOpen(false);
                  setActiveIdx(-1);
                }, 250)
              }
              onKeyDown={handleKeyDown}
              placeholder="Search or type a place…"
              maxLength={MAX.PLACE_NAME}
              style={{
                ...INPUT_STYLE,
                paddingLeft: 32,
                ...(error ? { borderColor: ERROR_RED } : {}),
              }}
            />
          </div>
        }
      >
        <div
          id={listboxId}
          role="listbox"
          aria-label="Place suggestions"
          style={{
            maxHeight: 200,
            overflowY: "auto",
            background: "#1a1a2e",
          }}
        >
          {matches.map((p, idx) => (
            <button
              key={p.id}
              id={`${listboxId}-option-${p.id}`}
              role="option"
              aria-selected={idx === activeIdx}
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(p.id, p.name, p.city ?? "");
                setQuery(p.name);
                setManualEntry(false);
                setOpen(false);
                setActiveIdx(-1);
              }}
              onMouseEnter={() => setActiveIdx(idx)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 12px",
                background:
                  idx === activeIdx ? "rgba(33,28,22,0.06)" : "transparent",
                border: "none",
                color: FG,
                fontSize: 13,
                cursor: "pointer",
                fontFamily: "var(--font-body, Inter, sans-serif)",
              }}
            >
              <span style={{ fontWeight: 600 }}>{p.name}</span>
              {p.city && (
                <span style={{ color: MUTED, marginLeft: 8, fontSize: 11 }}>
                  {p.city}
                </span>
              )}
            </button>
          ))}
        </div>
      </Popover>

      {!placeId && debouncedQuery.length >= 2 && isFetching && (
        <div
          style={{
            marginTop: 6,
            fontSize: 12,
            color: MUTED,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Spinner width={11} height={11} borderWidth={1.5} />
          Searching places…
        </div>
      )}
      {!placeId &&
        debouncedQuery.length >= 2 &&
        !isFetching &&
        matches.length === 0 && (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              color: ACCENT,
              letterSpacing: "0.01em",
            }}
          >
            New place — fill in the details below and we&rsquo;ll add it.
          </div>
        )}
      {!placeId &&
        debouncedQuery.length >= 2 &&
        !isFetching &&
        matches.length > 0 &&
        !manualEntry && (
          <div
            style={{
              marginTop: 8,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              fontSize: 11,
              color: MUTED,
              letterSpacing: "0.01em",
            }}
          >
            <span>Don&rsquo;t see the place?</span>
            <button
              type="button"
              onClick={() => {
                setManualEntry(true);
                setOpen(false);
                setActiveIdx(-1);
                onCustom({ placeName: query });
              }}
              style={{
                padding: 0,
                border: "none",
                background: "transparent",
                color: ACCENT,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                letterSpacing: "0.01em",
                textDecoration: "underline",
              }}
            >
              Add it as a new place.
            </button>
          </div>
        )}

      <LocationFields
        show={showLocationFields}
        placeName={query}
        placeCity={placeCity}
        placeCountry={placeCountry}
        placeState={placeState}
        onCustom={onCustom}
      />
    </div>
  );
}
