"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown } from "lucide-react";
import { Popover } from "@th/ui";
import {
  COUNTRIES,
  type CountryOption,
  type StateOption,
} from "@/lib/location/address-data";
import { BORDER_STRONG, MUTED, FG, INPUT_STYLE } from "../_shared/tokens";

// ─────────────────────────────────────────────────────────────────────────────
// CountryCombobox — searchable country selector with full keyboard nav
// ─────────────────────────────────────────────────────────────────────────────

interface CountryComboboxProps {
  value: string;
  onChange: (code: string) => void;
}

interface RegionComboboxProps {
  value: string;
  options: StateOption[];
  onChange: (code: string) => void;
}

type SearchableOption = CountryOption | StateOption;

interface SearchableCodeComboboxProps {
  value: string;
  options: SearchableOption[];
  onChange: (code: string) => void;
  placeholder: string;
  ariaLabel: string;
  enterKeyHint: "next" | "done";
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

const normalizeSearchText = (value: string) => value.trim().toLowerCase();

const matchesOptionQuery = (option: SearchableOption, rawQuery: string) => {
  const query = normalizeSearchText(rawQuery);
  if (!query) return true;

  return (
    option.name.toLowerCase().includes(query) ||
    option.code.toLowerCase().includes(query)
  );
};

function SearchableCodeCombobox({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  enterKeyHint,
}: SearchableCodeComboboxProps) {
  const listboxId = useId().replace(/:/g, "");
  const [query, setQuery] = useState(() => {
    if (!value) return "";
    const found = options.find((option) => option.code === value);
    return found?.name ?? "";
  });
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const blurRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeListbox = useCallback(() => {
    setOpen(false);
    setActiveIdx(-1);
  }, []);

  const restoreDisplayValue = useCallback(() => {
    if (!value) {
      setQuery("");
      return;
    }
    const found = options.find((option) => option.code === value);
    if (found) setQuery(found.name);
  }, [options, value]);

  useEffect(() => {
    restoreDisplayValue();
  }, [restoreDisplayValue]);

  const matches = useMemo(() => {
    const trimmed = normalizeSearchText(query);
    const filtered = trimmed
      ? options.filter((option) => matchesOptionQuery(option, trimmed))
      : options;
    return filtered.slice(0, 8);
  }, [options, query]);

  const listboxOpen = open && matches.length > 0;
  const activeDescendant =
    listboxOpen && activeIdx >= 0 && activeIdx < matches.length
      ? `${listboxId}-option-${matches[activeIdx].code}`
      : undefined;

  useEffect(() => {
    if (!listboxOpen || activeIdx < 0 || activeIdx >= matches.length) return;
    document
      .getElementById(`${listboxId}-option-${matches[activeIdx].code}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, listboxId, listboxOpen, matches]);

  const selectOption = useCallback(
    (option: SearchableOption) => {
      setQuery(option.name);
      onChange(option.code);
      closeListbox();
    },
    [closeListbox, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          if (!listboxOpen) {
            setOpen(true);
            setActiveIdx(matches.length > 0 ? 0 : -1);
            return;
          }
          setActiveIdx((prev) => Math.min(prev + 1, matches.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          if (!listboxOpen) {
            setOpen(true);
            setActiveIdx(matches.length > 0 ? matches.length - 1 : -1);
            return;
          }
          setActiveIdx((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          if (listboxOpen && activeIdx >= 0 && activeIdx < matches.length) {
            e.preventDefault();
            selectOption(matches[activeIdx]);
          }
          break;
        case "Escape":
          closeListbox();
          restoreDisplayValue();
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
    [
      activeIdx,
      closeListbox,
      listboxOpen,
      matches,
      restoreDisplayValue,
      selectOption,
    ],
  );

  return (
    <div style={{ position: "relative" }}>
      <span role="status" aria-live="polite" aria-atomic="true" style={srOnly}>
        {open
          ? matches.length > 0
            ? `${matches.length} ${ariaLabel.toLowerCase()} suggestion${matches.length === 1 ? "" : "s"} available`
            : `No ${ariaLabel.toLowerCase()} suggestions`
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
            <input
              type="text"
              role="combobox"
              autoComplete="off"
              enterKeyHint={enterKeyHint}
              aria-expanded={listboxOpen}
              aria-haspopup="listbox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={activeDescendant}
              aria-label={ariaLabel}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setActiveIdx(-1);
                if (!e.target.value) onChange("");
              }}
              onFocus={() => {
                if (blurRef.current) {
                  clearTimeout(blurRef.current);
                  blurRef.current = null;
                }
                setOpen(true);
              }}
              onBlur={() => {
                blurRef.current = setTimeout(() => {
                  closeListbox();
                  restoreDisplayValue();
                }, 160);
              }}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              style={{
                ...INPUT_STYLE,
                paddingRight: 32,
              }}
            />
            <ChevronDown
              size={14}
              style={{
                pointerEvents: "none",
                position: "absolute",
                right: 12,
                top: "50%",
                transform: "translateY(-50%)",
                color: MUTED,
              }}
            />
          </div>
        }
      >
        <div
          id={listboxId}
          role="listbox"
          aria-label={`${ariaLabel} suggestions`}
          style={{
            maxHeight: 200,
            overflowY: "auto",
            background: "#1a1a2e",
          }}
        >
          {matches.map((option, idx) => (
            <button
              key={option.code}
              id={`${listboxId}-option-${option.code}`}
              role="option"
              aria-selected={idx === activeIdx}
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectOption(option)}
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
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  width: "100%",
                }}
              >
                <span>{option.name}</span>
                <span
                  aria-hidden="true"
                  style={{
                    color: MUTED,
                    fontSize: 11,
                    letterSpacing: 0.8,
                    textTransform: "uppercase",
                  }}
                >
                  {option.code}
                </span>
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

export function CountryCombobox({ value, onChange }: CountryComboboxProps) {
  return (
    <SearchableCodeCombobox
      value={value}
      options={COUNTRIES}
      onChange={onChange}
      placeholder="Search country…"
      ariaLabel="Country"
      enterKeyHint="next"
    />
  );
}

export function RegionCombobox({
  value,
  options,
  onChange,
}: RegionComboboxProps) {
  return (
    <SearchableCodeCombobox
      value={value}
      options={options}
      onChange={onChange}
      placeholder="Search state or region…"
      ariaLabel="State or region"
      enterKeyHint="done"
    />
  );
}
