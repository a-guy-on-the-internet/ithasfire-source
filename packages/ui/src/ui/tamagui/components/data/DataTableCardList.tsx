"use client";

/**
 * Mobile "card mode" internals for `DataTable` (web only).
 *
 * This module also hosts plumbing shared between table mode and card mode
 * (row-state class names, the expand/collapse reveal animation, and the
 * mobile-breakpoint hook). It lives here — rather than in `DataTable.tsx` —
 * so the import graph stays one-directional: `DataTable.tsx` imports from
 * this file, never the reverse.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Checkbox } from "../forms/Checkbox";
import { Text } from "../typography/Text";
import {
  DT_BORDER,
  DT_BORDER_SOFT,
  DT_BORDER_STRONG,
  DT_SURFACE,
  DT_SURFACE_MUTED,
} from "./tokens";

// ── Row-state class names (web only, styles injected by DataTable) ────────
export const HOVER_ROW_CLASS = "dt-row-hover";
export const FOCUS_ROW_CLASS = "dt-row-focus";
/**
 * Class applied to a selected row's <tr> and to a selected card. Carries the
 * accent-soft wash and the 3px accent rail (the rail means SELECTED; hover is
 * a wash only).
 */
export const SELECTED_ROW_CLASS = "dt-row-selected";
/**
 * Class on the card list's outer frame (data and skeleton states). Inside an
 * element marked `data-dt-frame` (a container that already draws the
 * ledger's top/bottom rules, e.g. apps/web `TableContainer`) the list's own
 * rules stand down, so there is ONE 2px rule above and below.
 */
export const CARD_LIST_CLASS = "dt-card-list";
/** Attribute a wrapper sets when it draws the table's top/bottom rules itself. */
export const DT_FRAME_ATTR = "data-dt-frame";

// ── Mobile breakpoint ──────────────────────────────────────────────────────
/**
 * Matches the app-side `useIsMobile` convention (apps/web/src/hooks).
 * Inlined here because `@th/ui` cannot import from apps.
 */
const MOBILE_BREAKPOINT = 600;

/**
 * Returns `true` when `enabled` and the viewport is narrower than 600px.
 *
 * SSR-safe: defaults to `false` (desktop/table) on the server and on the
 * first client render to avoid hydration mismatch, then syncs via
 * `matchMedia` on mount. The listener is only attached while `enabled`.
 */
export function useIsBelowMobileBreakpoint(enabled: boolean): boolean {
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    if (
      !enabled ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => setIsNarrow(mql.matches);
    onChange(); // sync on mount
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [enabled]);

  return enabled && isNarrow;
}

// ── Expand/collapse reveal animation (shared by table + card modes) ───────
export const EXPAND_MS = 280;
// Material standard for opacity (no overshoot).
const EASE_STANDARD = "cubic-bezier(0.4, 0, 0.2, 1)";
// Subtle spring with a touch of overshoot for the height. Restrained for admin UI.
const EASE_SPRING = "cubic-bezier(0.34, 1.3, 0.64, 1)";

const REVEAL_STYLE_ID = "dt-reveal-styles";
const REVEAL_FRAME_CLASS = "dt-expand-reveal";

/**
 * Inject the reveal transition once (web only). Living in a class — rather
 * than an inline style — lets `prefers-reduced-motion` disable it for both
 * table and card modes in one place.
 */
function ensureRevealStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(REVEAL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = REVEAL_STYLE_ID;
  style.textContent = `
    .${REVEAL_FRAME_CLASS} {
      transition: grid-template-rows ${EXPAND_MS}ms ${EASE_SPRING}, opacity ${EXPAND_MS - 80}ms ${EASE_STANDARD};
    }
    @media (prefers-reduced-motion: reduce) {
      .${REVEAL_FRAME_CLASS} {
        transition: none;
      }
    }
  `;
  document.head.appendChild(style);
}

export interface ExpandRevealState {
  isOpen: boolean;
  /** Stays true for EXPAND_MS after close so the exit animation can play. */
  mounted: boolean;
  visualOpen: boolean;
  /** Last non-null content, kept alive during the collapse animation. */
  lastContent: ReactNode;
}

/**
 * State machine for the CSS grid (0fr ↔ 1fr) expand/collapse reveal.
 * Keeps the last non-null content alive during the collapse so the exit
 * animation has something to shrink.
 */
export function useExpandReveal(content: ReactNode | null): ExpandRevealState {
  const isOpen = content != null;
  const lastContentRef = useRef<ReactNode>(content);
  const [mounted, setMounted] = useState(isOpen);
  const [visualOpen, setVisualOpen] = useState(isOpen);

  // When new content arrives, keep it.
  if (content != null) {
    lastContentRef.current = content;
  }

  // Mount immediately when opening; defer unmount until the transition ends.
  // Double-RAF guarantees the closed frame paints before we flip to open so
  // the browser actually transitions from 0fr → 1fr instead of mounting at 1fr.
  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setVisualOpen(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
      };
    }
    setVisualOpen(false);
    const timer = setTimeout(() => setMounted(false), EXPAND_MS);
    return () => clearTimeout(timer);
  }, [isOpen]);

  return { isOpen, mounted, visualOpen, lastContent: lastContentRef.current };
}

/** The animated grid frame that the reveal content sits in. */
export function ExpandRevealFrame({
  visualOpen,
  children,
}: {
  visualOpen: boolean;
  children: ReactNode;
}) {
  // Injected on mount — before `useExpandReveal` flips `visualOpen` (which
  // waits two animation frames), so the transition class is always in place
  // by the time the open animation starts.
  useEffect(() => {
    ensureRevealStyles();
  }, []);

  return (
    <div
      className={REVEAL_FRAME_CLASS}
      style={{
        display: "grid",
        gridTemplateRows: visualOpen ? "1fr" : "0fr",
        opacity: visualOpen ? 1 : 0,
      }}
    >
      <div style={{ overflow: "hidden" }}>{children}</div>
    </div>
  );
}

// ── Card mode ──────────────────────────────────────────────────────────────

/** Selection wiring forwarded from DataTable (state + helpers live there). */
export interface DataTableCardSelection<TRow> {
  selectedKeys: Set<string>;
  disabled?: boolean;
  isRowSelectable?: (row: TRow, index: number) => boolean;
  getRowLabel?: (row: TRow, index: number) => string;
  selectAllLabel?: string;
  checkboxSize: "sm" | "md" | "lg";
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
  onToggleRow: (key: string) => void;
}

export interface DataTableCardListProps<TRow> {
  rows: TRow[];
  renderCard: (row: TRow) => ReactNode;
  getRowKey: (row: TRow, index: number) => string;
  onRowPress?: (row: TRow, index: number) => void;
  renderExpandedRow?: (row: TRow, index: number) => ReactNode | null;
  emptyState: ReactNode;
  showLoadingSkeleton: boolean;
  loadingRowCount: number;
  testIdBase: string;
  qaId: string;
  selection?: DataTableCardSelection<TRow>;
}

// Hairline separators between cards; structure rules above and below the
// list. No side borders (the "open ledger" frame matches table mode). The
// rules are inline so they paint before the injected CSS exists; inside a
// `data-dt-frame` owner an injected !important rule removes them.
const CARD_BORDER = `1px solid ${DT_BORDER_SOFT}`;
const LIST_BORDER = `2px solid ${DT_BORDER}`;
const LIST_FRAME_STYLE = {
  borderTop: LIST_BORDER,
  borderBottom: LIST_BORDER,
  background: DT_SURFACE,
} as const;

/** Expanded detail rendered directly below a card. */
function ExpandableCardSection({
  content,
  isLast,
}: {
  content: ReactNode | null;
  isLast: boolean;
}) {
  const { isOpen, mounted, visualOpen, lastContent } = useExpandReveal(content);

  // Nothing to render at all (never been expanded).
  if (!mounted && !isOpen) return null;

  return (
    <div
      aria-hidden={!isOpen}
      style={{
        // Keep the separator visible while the section animates out, but
        // don't double up against the list's outer border on the last card.
        borderBottom: mounted && !isLast ? CARD_BORDER : "none",
      }}
    >
      <ExpandRevealFrame visualOpen={visualOpen}>
        {lastContent}
      </ExpandRevealFrame>
    </div>
  );
}

function CardSkeletonBar({ widthPercent }: { widthPercent: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        height: 12,
        width: `${widthPercent}%`,
        borderRadius: 0,
        background: DT_SURFACE_MUTED,
      }}
    />
  );
}

/**
 * Stacked vertical card list — DataTable's mobile rendering mode (web only).
 *
 * Preserves the table's row semantics: `onRowPress` fires on card tap (the
 * whole card is the tap target, keyboard activatable with a visible focus
 * state), `renderExpandedRow` reveals below the tapped card, selection
 * renders as a select-all bar plus per-card checkboxes, and row test ids
 * keep the `{testIdBase}-row-{key}` naming.
 */
export function DataTableCardList<TRow>({
  rows,
  renderCard,
  getRowKey,
  onRowPress,
  renderExpandedRow,
  emptyState,
  showLoadingSkeleton,
  loadingRowCount,
  testIdBase,
  qaId,
  selection,
}: DataTableCardListProps<TRow>) {
  const listRef = useRef<HTMLDivElement | null>(null);

  const automationProps = {
    "data-testid": testIdBase,
    "data-qa": qaId,
  } as const;

  // Arrow-key navigation between cards (mirrors the table's row navigation).
  const focusCard = useCallback((delta: number) => {
    const list = listRef.current;
    if (!list) return;
    const cards = Array.from(
      list.querySelectorAll<HTMLElement>("[data-row-key]"),
    );
    const current = cards.findIndex((c) => c === document.activeElement);
    const next = Math.max(0, Math.min(cards.length - 1, current + delta));
    cards[next]?.focus();
  }, []);

  const handleCardKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, row: TRow, index: number) => {
      // Only handle keys aimed at the card itself. Keys originating from
      // interactive content inside the card (the selection checkbox, or any
      // links/buttons a renderMobileCard provides) must keep their native
      // behavior — preventDefault here would cancel their activation.
      if (e.target !== e.currentTarget) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          focusCard(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          focusCard(-1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          onRowPress?.(row, index);
          break;
        case "Escape":
          (e.currentTarget as HTMLElement).blur();
          break;
        default:
          break;
      }
    },
    [focusCard, onRowPress],
  );

  if (showLoadingSkeleton) {
    return (
      <div
        {...automationProps}
        className={CARD_LIST_CLASS}
        style={LIST_FRAME_STYLE}
      >
        {Array.from({ length: loadingRowCount }).map((_, index) => (
          <div
            key={`card-skeleton-${index}`}
            aria-hidden="true"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              minHeight: 44,
              padding: 12,
              boxSizing: "border-box",
              borderBottom:
                index === loadingRowCount - 1 ? undefined : CARD_BORDER,
            }}
          >
            <CardSkeletonBar widthPercent={((index * 17 + 35) % 40) + 45} />
            <CardSkeletonBar widthPercent={((index * 23 + 15) % 30) + 25} />
          </div>
        ))}
      </div>
    );
  }

  // Empty state — no outer frame so caller-provided empty states (which often
  // bring their own border) don't end up double-framed.
  if (rows.length === 0) {
    return (
      <div {...automationProps} style={{ padding: "8px 0" }}>
        {emptyState}
      </div>
    );
  }

  return (
    <div
      {...automationProps}
      className={CARD_LIST_CLASS}
      style={LIST_FRAME_STYLE}
    >
      {selection ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            minHeight: 44,
            boxSizing: "border-box",
            borderBottom: `2px solid ${DT_BORDER_STRONG}`,
          }}
        >
          <Checkbox
            size={selection.checkboxSize}
            checked={
              selection.allSelected
                ? true
                : selection.someSelected
                  ? "indeterminate"
                  : false
            }
            onCheckedChange={selection.onToggleAll}
            disabled={selection.disabled}
            aria-label={selection.selectAllLabel}
            testIdBase={`${testIdBase}-select-all`}
          />
          {selection.selectAllLabel ? (
            // The checkbox already carries the accessible name via aria-label;
            // this is the sighted-user counterpart.
            <Text
              aria-hidden
              variant="caption"
              weight="bold"
              tone="muted"
              textTransform="uppercase"
              letterSpacing={0.6}
            >
              {selection.selectAllLabel}
            </Text>
          ) : null}
        </div>
      ) : null}

      <div ref={listRef} role="list">
        {rows.map((row, index) => {
          const key = getRowKey(row, index);
          const expandedContent = renderExpandedRow?.(row, index) ?? null;
          const isLast = index === rows.length - 1;
          const interactive = Boolean(onRowPress);
          const rowSelectable = selection
            ? (selection.isRowSelectable?.(row, index) ?? true)
            : false;
          const isSelected = Boolean(selection?.selectedKeys.has(key));

          return (
            // role="listitem" lives on a wrapper because the pressable card
            // below may carry role="button" — nesting both on one element
            // would be invalid.
            <div key={key} role="listitem">
              <div
                data-row-key={key}
                data-testid={`${testIdBase}-row-${key}`}
                className={`${HOVER_ROW_CLASS} ${FOCUS_ROW_CLASS}${
                  isSelected ? ` ${SELECTED_ROW_CLASS}` : ""
                }`}
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-expanded={
                  interactive && renderExpandedRow
                    ? expandedContent != null
                    : undefined
                }
                onClick={
                  interactive ? () => onRowPress?.(row, index) : undefined
                }
                onKeyDown={
                  interactive
                    ? (e) => handleCardKeyDown(e, row, index)
                    : undefined
                }
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  minHeight: 44,
                  padding: 12,
                  boxSizing: "border-box",
                  // A selected card takes its wash from SELECTED_ROW_CLASS;
                  // an inline background would silently override it.
                  background: isSelected ? undefined : DT_SURFACE,
                  borderBottom:
                    isLast && expandedContent == null ? undefined : CARD_BORDER,
                  cursor: interactive ? "pointer" : undefined,
                }}
              >
                {selection ? (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      alignSelf: "stretch",
                    }}
                  >
                    {rowSelectable ? (
                      <Checkbox
                        size={selection.checkboxSize}
                        checked={isSelected}
                        onCheckedChange={() => selection.onToggleRow(key)}
                        disabled={selection.disabled}
                        aria-label={selection.getRowLabel?.(row, index)}
                        testIdBase={`${testIdBase}-select-${key}`}
                      />
                    ) : null}
                  </div>
                ) : null}
                <div style={{ flex: 1, minWidth: 0 }}>{renderCard(row)}</div>
              </div>
              {renderExpandedRow ? (
                <ExpandableCardSection
                  content={expandedContent}
                  isLast={isLast}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
