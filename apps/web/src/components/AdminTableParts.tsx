"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { YStack, XStack } from "tamagui";
import { Button, Popover, Text, TextInput, useTranslations } from "@th/ui";
import {
  RefreshCw,
  Plus,
  Search,
  Filter,
  X,
  ChevronLeft,
  ChevronRight,
  Columns3,
  AlertTriangle,
} from "lucide-react";

import { useIsMobile } from "@/hooks/useIsMobile";

// ─────────────────────────────────────────────────────────────────────────────
// Error state (shared retry surface for admin tables)
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminTableErrorStateProps {
  /** Already-formatted error message (e.g. via formatErrorMessage). */
  message: string;
  /** Called when the user presses retry. */
  onRetry: () => void;
  /** Optional override for the retry button label. Defaults to `admin.retryLoad`. */
  retryLabel?: string;
  /** Test id base — applied to the retry button. */
  testId?: string;
}

/**
 * Bordered error card used in place of an admin table when its underlying
 * query fails. Matches the visual language of `SkeletonEmptyState` so the
 * page does not collapse to bare text on error.
 *
 * Previously inlined per-page (events, places, audiences, …); centralising
 * it ensures the icon, copy, and retry affordance stay in lock-step.
 */
export function AdminTableErrorState({
  message,
  onRetry,
  retryLabel,
  testId,
}: AdminTableErrorStateProps) {
  const t = useTranslations();
  return (
    <YStack
      padding="$6"
      gap="$3"
      alignItems="center"
      justifyContent="center"
      minHeight={240}
      borderRadius={0}
      borderWidth={2}
      borderColor="$borderColor"
      data-testid={testId ?? "admin-table-error-state"}
    >
      <AlertTriangle size={28} color="var(--danger, #B91C1C)" aria-hidden />
      <Text variant="body" tone="error" textAlign="center" maxWidth={420}>
        {message}
      </Text>
      <Button
        variant="outlined"
        size="$2"
        onPress={onRetry}
        data-testid={`${testId ?? "admin-table-error-state"}-retry`}
      >
        <RefreshCw size={14} />
        {retryLabel ?? String(t("admin.retryLoad"))}
      </Button>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton empty state
// ─────────────────────────────────────────────────────────────────────────────

export interface SkeletonEmptyStateProps {
  /** Headline in the overlay CTA */
  title: string;
  /** Body copy below the headline */
  description: string;
  /** Label for the primary CTA button */
  ctaLabel: string;
  /** Fired when the CTA is pressed */
  onCtaPress: () => void;
  /** Disable the CTA (e.g. while creating) */
  ctaDisabled?: boolean;
  /** Number of skeleton ghost rows (default 4) */
  rows?: number;
  /** Number of "columns" per ghost row (default 3) */
  columns?: number;
}

/**
 * Ghost-row table overlay used as the empty state for admin list views.
 * Previously duplicated across EventsManager, AudiencesView, etc.
 */
export function SkeletonEmptyState({
  title,
  description,
  ctaLabel,
  onCtaPress,
  ctaDisabled,
  rows = 4,
  columns = 3,
}: SkeletonEmptyStateProps) {
  return (
    <YStack position="relative" minHeight={300}>
      {/* Ghost rows */}
      <YStack
        borderRadius={0}
        borderWidth={2}
        borderColor="$borderColor"
        overflow="hidden"
        opacity={0.4}
      >
        {Array.from({ length: rows }).map((_, i) => (
          <XStack
            key={i}
            paddingHorizontal="$4"
            paddingVertical="$3"
            borderBottomWidth={i < rows - 1 ? 1 : 0}
            borderBottomColor="$borderColor"
            gap="$4"
          >
            {Array.from({ length: columns }).map((_, j) => (
              <YStack
                key={j}
                flex={j === 0 ? 2 : 1}
                height={14}
                borderRadius={0}
                backgroundColor="$surfaceMuted"
              />
            ))}
          </XStack>
        ))}
      </YStack>

      {/* Overlay CTA */}
      <YStack
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        alignItems="center"
        justifyContent="center"
        gap="$3"
        zIndex={1}
      >
        <Text variant="h4" weight="bold" textAlign="center">
          {title}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={320}>
          {description}
        </Text>
        <Button
          variant="primary"
          size="$3"
          onPress={onCtaPress}
          disabled={ctaDisabled}
        >
          <Plus size={18} />
          {ctaLabel}
        </Button>
      </YStack>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Action bar
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionBarProps {
  onRefresh: () => void;
  /** E.g. "3 of 12 events" */
  countLabel?: string;
  /** Extra elements rendered between Refresh and the count */
  children?: ReactNode;
  /**
   * Controls slide animation. `true` (default) slides the bar into view;
   * `false` collapses it with a smooth transition. The consuming page
   * decides when to show or hide the bar.
   */
  visible?: boolean;
}

/**
 * Sub-header that sits above a DataTable, providing Refresh + count.
 *
 * The page controls visibility via the `visible` prop. When `false` the
 * bar smoothly collapses to zero height; when `true` it slides back in.
 */
export function ActionBar({
  onRefresh,
  countLabel,
  children,
  visible = true,
}: ActionBarProps) {
  const t = useTranslations();
  return (
    <XStack
      paddingHorizontal="$3"
      paddingVertical="$2"
      gap={0}
      alignItems="center"
      // Phones: refresh + search (+ count) wrap onto extra lines instead
      // of pushing the search input past the right edge of the viewport.
      flexWrap="wrap"
      borderBottomWidth={2}
      borderBottomColor="$borderColor"
      style={
        {
          overflow: "hidden" as never,
          // Cap exists only so the collapse can animate max-height → 0;
          // keep it comfortably above the tallest realistic stack (refresh
          // button + wrapped 36/44px responsive search + count label at
          // ~320px widths) so the overflow:hidden never clips visible
          // content.
          maxHeight: visible ? 200 : 0,
          opacity: visible ? 1 : 0,
          paddingTop: visible ? undefined : 0,
          paddingBottom: visible ? undefined : 0,
          borderBottomWidth: visible ? undefined : 0,
          transition:
            "max-height 200ms ease-out, opacity 150ms ease-out, padding 200ms ease-out, border-bottom-width 200ms ease-out",
        } as never
      }
    >
      <Button
        variant="ghost"
        size="$2"
        onPress={onRefresh}
        aria-label={t("admin.atRefresh") as string}
        paddingHorizontal="$3"
      >
        <XStack gap="$2" alignItems="center">
          <RefreshCw size={14} />
          <Text variant="overline">{String(t("admin.atRefresh"))}</Text>
        </XStack>
      </Button>
      {children}
      <XStack flex={1} />
      {countLabel && (
        <Text
          variant="overline"
          tone="muted"
          paddingHorizontal="$3"
          style={{
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {countLabel}
        </Text>
      )}
    </XStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk action bar
// ─────────────────────────────────────────────────────────────────────────────

export interface BulkActionBarProps {
  /** Number of selected rows. The bar renders nothing when `count <= 0`. */
  count: number;
  /** Clears the selection (also fired by the dismiss × and the Escape key). */
  onClear: () => void;
  /**
   * Action buttons for the selection.
   *
   * CONVENTION (v2 one-primary rule): at most ONE `variant="primary"` action
   * in this slot — every other action is `variant="secondary"` or below.
   * NOTE: the bar is a full ink inversion (`$surfaceStrong` fill), so
   * `secondary`'s ink outline is invisible on it — re-point that ladder at
   * `$onStructure` per instance (see SignupsTab for the reference pattern).
   */
  children?: ReactNode;
  /**
   * Overlay mode: absolutely fills its nearest `position: relative` parent so
   * the bar REPLACES an `ActionBar`'s row content in the same vertical space
   * (no layout jump). Default `false` renders a normal block.
   */
  overlay?: boolean;
  /**
   * Focused after the selection is cleared via the dismiss × or Escape.
   * Clearing removes the bar (and the focused × with it) — without a
   * restore target, keyboard focus drops to <body>. Point this at the
   * table region or its heading.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Test id applied to the bar region. */
  testId?: string;
}

/** Screen-reader-only box for the persistent live region below. */
const visuallyHiddenStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * Ink-inverted bar shown while a table has selected rows. Replaces the
 * hand-rolled per-page "N selected" boxes with one shared treatment:
 * `$surfaceStrong` fill + `$onStructure` text (inverts correctly if Ember
 * ships later), count kicker, actions slot, dismiss ×. Escape clears the
 * selection too (suppressed while a dialog is open so Escape-to-close-dialog
 * does not also wipe the selection).
 *
 * Labels are deliberately plain English — this is an admin-only surface and
 * new i18n keys would require editing the locale JSON catalogs.
 */
export function BulkActionBar({
  count,
  onClear,
  children,
  overlay = false,
  restoreFocusRef,
  testId,
}: BulkActionBarProps) {
  // Clear + focus restoration for the two bar-owned clear paths (× /
  // Escape). Clearing unmounts the bar, so without a restore target the
  // focus that was on the × drops to <body>.
  const handleClear = useCallback(() => {
    onClear();
    restoreFocusRef?.current?.focus();
  }, [onClear, restoreFocusRef]);

  useEffect(() => {
    if (count <= 0) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // A MODAL dialog owns Escape while open (e.g. a bulk-reject
      // confirm) — clearing the selection underneath it would strand the
      // workflow. Matched narrowly on aria-modal so non-modal dialogs
      // (the support chat widget) don't starve Escape-clear.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      handleClear();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [count, handleClear]);

  // Persistent live region: must stay mounted across the bar's own
  // mount/unmount so BOTH the first selection and "Selection cleared"
  // announce (a region that appears/disappears with the bar misses both
  // edges). Empty until the first selection so mount announces nothing.
  const prevCountRef = useRef(0);
  useEffect(() => {
    prevCountRef.current = count;
  });
  const liveText =
    count > 0
      ? `${count} selected`
      : prevCountRef.current > 0
        ? "Selection cleared"
        : "";
  const liveRegion = (
    <span aria-live="polite" style={visuallyHiddenStyle}>
      {liveText}
    </span>
  );

  if (count <= 0) return liveRegion;

  return (
    <>
      {liveRegion}
      <XStack
        role="region"
        aria-label="Bulk actions"
        data-testid={testId}
        alignItems="center"
        gap="$3"
        flexWrap="wrap"
        paddingHorizontal="$3"
        paddingVertical="$2"
        borderRadius={0}
        backgroundColor="$surfaceStrong"
        {...(overlay
          ? {
              position: "absolute" as const,
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 10,
            }
          : {})}
      >
        <Text
          color="$onStructure"
          style={{
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 2,
            textTransform: "uppercase",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {count} selected
        </Text>
        {children ? (
          <XStack
            gap="$2"
            alignItems="center"
            flexWrap="wrap"
            flexShrink={1}
            minWidth={0}
          >
            {children}
          </XStack>
        ) : null}
        <XStack flex={1} />
        {/* ghostInverted: the ghost ladder for filled/inverted surfaces —
            paper glyph at rest, cream chrome fill + ink glyph on hover. */}
        <Button
          variant="ghostInverted"
          icon
          size="$4"
          aria-label="Clear selection"
          onPress={handleClear}
          data-testid={testId ? `${testId}-clear` : undefined}
        >
          <X size={16} strokeWidth={2} />
        </Button>
      </XStack>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Table container
// ─────────────────────────────────────────────────────────────────────────────

export interface TableContainerProps {
  children: ReactNode;
  maxHeight?: number | string;
}

/**
 * Wrapper for the DataTable below an `ActionBar`.
 *
 * Uses `flex: 1` + `minHeight: 0` so the table fills whatever vertical
 * space its parent flex column provides, scrolling when it overflows.
 *
 * Frame is an "open ledger": 2px structure rules above and below, no side
 * borders, so the header baseline and row hairlines run edge to edge.
 * `data-dt-frame` tells DataTable this wrapper owns those rules, so its
 * card-mode list (phones) drops its own and the rules don't double.
 */
export function TableContainer({ children, maxHeight }: TableContainerProps) {
  return (
    <YStack
      flex={1}
      minHeight={0}
      borderRadius={0}
      // Tamagui's `overflow` prop type has no "auto"; the DOM style does. Auto
      // (not "scroll") so scrollbars appear only when content overflows.
      style={{ overflow: "auto" }}
      borderTopWidth={2}
      borderBottomWidth={2}
      borderLeftWidth={0}
      borderRightWidth={0}
      borderColor="$borderColor"
      data-dt-frame=""
      {...(maxHeight ? { maxHeight } : {})}
    >
      {children}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Search bar
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchBarProps {
  /** Current search value (controlled). */
  value: string;
  /** Called on every keystroke. */
  onChangeText: (next: string) => void;
  /** Placeholder text. Falls back to a generic i18n string. */
  placeholder?: string;
  /** Test id applied to the input. */
  testId?: string;
  /**
   * Receives the underlying `<input>` element — for programmatic refocus
   * (e.g. after a clear button empties the field).
   */
  inputRef?: RefObject<HTMLInputElement | null>;
  /**
   * Native maxLength forwarded to the input. Match the server's cap (most
   * admin search endpoints validate `z.string().max(200)`) so an oversized
   * paste truncates instead of turning "no results" into an error card.
   */
  maxLength?: number;
  /** Extra content rendered after the input (e.g. a clear button). */
  children?: ReactNode;
}

/**
 * A search input with a leading magnifier icon.
 *
 * MUST be rendered inside a ROW — either `<FilterRow>` (orders, places,
 * promos, resale, attendees) or an `<ActionBar>`'s children slot
 * (EventsManager). The frame carries `flex: 1` so it absorbs the row's spare
 * width; dropped bare into a `YStack` that `flex` grows along the COLUMN's
 * main axis instead, stretching the bar vertically and centring the input in
 * a tall empty band. AttendeesTab hit exactly that.
 *
 * Debouncing is intentionally left to the consumer so the same component
 * works for both client-side and server-side search patterns.
 */
export function SearchBar({
  value,
  onChangeText,
  placeholder,
  testId,
  inputRef,
  maxLength,
  children,
}: SearchBarProps) {
  const t = useTranslations();

  // 44px tap floor is a touch-device requirement; on pointer viewports the
  // field sits on the sm control scale next to 34px buttons. useIsMobile is
  // SSR-safe (desktop-first), flipping to 44 below the shared 600px
  // breakpoint after mount. Tamagui's Input carries a default `size` variant
  // that sets an explicit `height` (44 via the $true size token), so
  // minHeight alone can't shrink it — override height too.
  const isMobile = useIsMobile();
  const controlHeight = isMobile ? 44 : 36;

  // TextInput's forwarded ref may hand back the raw <input> or a styled
  // wrapper around it — resolve to the DOM input so `.focus()` always works.
  const resolveInputRef = useCallback(
    (node: unknown) => {
      if (!inputRef) return;
      inputRef.current =
        node instanceof HTMLInputElement
          ? node
          : ((node as HTMLElement | null)?.querySelector?.("input") ?? null);
    },
    [inputRef],
  );

  return (
    <XStack
      gap="$2"
      alignItems="center"
      flex={1}
      maxWidth={360}
      // Shrink with the viewport instead of overflowing it — the inner
      // TextInput frame defaults to a fixed 240px without fullWidth.
      minWidth={0}
      flexShrink={1}
    >
      <Search size={16} color="var(--colorMuted)" />
      {/* Wrapper owns the flexing: TextInput's outer frame is not a flex
          child we can control directly (it defaults to a fixed 240px).
          th-no-zoom (globals.css) forces a 16px font on the inner
          <input> — iOS Safari auto-zooms inputs with smaller text, and
          Tamagui drops both `fontSize` and `style` props here. */}
      <XStack flex={1} minWidth={0} className="th-no-zoom">
        <TextInput
          fullWidth
          ref={inputRef ? resolveInputRef : undefined}
          value={value}
          onChangeText={onChangeText}
          minHeight={controlHeight}
          height={controlHeight}
          {...(maxLength !== undefined ? { maxLength } : {})}
          placeholder={placeholder ?? String(t("admin.atSearchPlaceholder"))}
          // MUST be `testId`, not `data-testid`: a spread `data-*` prop dies
          // in react-native-web's TextInput allow-list and never reaches the
          // DOM. TextInput's `testId` prop patches the attribute onto the
          // real <input> imperatively (see patchInputDOM in @th/ui).
          testId={testId ?? "at-search-input"}
        />
      </XStack>
      {children}
    </XStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter chips
// ─────────────────────────────────────────────────────────────────────────────

export interface FilterChipOption<T extends string = string> {
  value: T;
  label: string;
}

export interface FilterChipsProps<T extends string = string> {
  /** Available filter options. */
  options: FilterChipOption<T>[];
  /** Currently selected value (`undefined` = none selected). */
  selected: T | undefined;
  /** Called when a chip is toggled. Passes `undefined` when deselecting. */
  onSelect: (value: T | undefined) => void;
  /** Leading icon — defaults to Filter. Pass `null` to hide. */
  icon?: ReactNode | null;
  /**
   * Accessible name for the chip set, announced as a group. Defaults to
   * "Filters"; override when a row carries MORE than one group (e.g. places
   * renders a lifecycle-scope group and an independent verified toggle) so
   * the two don't share a name.
   *
   * Plain English by design — all 14 call sites are /admin or /platform
   * surfaces (checked individually), so the admin-only-chrome convention
   * applies and no locale catalog entry is needed.
   */
  ariaLabel?: string;
}

/**
 * A row of mutually exclusive filter chips with a leading icon.
 *
 * Pressing an already-active chip deselects it (toggles to `undefined`).
 *
 * Convention: `undefined` selection = the table's default scope. Provide
 * chips only for non-default scopes — never render a chip for the default
 * that would sit permanently selected.
 */
export function FilterChips<T extends string = string>({
  options,
  selected,
  onSelect,
  icon,
  ariaLabel = "Filters",
}: FilterChipsProps<T>) {
  return (
    <XStack
      gap="$2"
      flexWrap="wrap"
      alignItems="center"
      // REQUIRED for the wrap to ever engage. Tamagui's web Stack default is
      // `flex-shrink: 0` (see @tamagui/web webViewFlexCompatStyles), so as a
      // flex item of FilterRow's row this container kept its full content
      // width — 583px inside a 206px parent at 320px — and its own
      // `flex-wrap: wrap` never got a narrower line box to break into. The
      // chips ran off-screen with no affordance (document overflow stayed
      // clean; only the shell's overflow-x:auto could reach them).
      // `minWidth` is NOT needed: Tamagui already defaults it to 0.
      //
      // NOTE: this only helps if every ROW ancestor between here and the page
      // column is shrinkable too — one `flex-shrink: 0` wrapper hands this
      // container a content-width containing block and the wrap dies again.
      // `PlatformFilterBar` needed the same fix for exactly that reason.
      flexShrink={1}
      role="group"
      aria-label={ariaLabel}
    >
      {icon !== null &&
        (icon ?? <Filter size={14} color="var(--colorMuted)" />)}
      {options.map((opt) => {
        const isOn = selected === opt.value;
        return (
          <Button
            key={opt.value}
            // Both states ride `secondary` — the v2 structure outline with an
            // INK label — and differ only in border/fill below. `outlined` is
            // the DEPRECATED v2 accent outline ("prefer variant='secondary'",
            // button-variants.ts) and painted an accent border + accent label
            // on every unselected chip; `primary` is the full accent fill,
            // which SegmentedControl's docstring reserves for the ONE primary
            // action per viewport (v2 §03) and names the "Button-primary
            // segmented hack" by name. A selected chip wearing it put a second
            // accent fill next to CREATE EVENT.
            variant="secondary"
            // v2 `.chip.on` grammar, matching the DS's own SegmentedControl:
            //   ON  — $accentSoft wash + $accent border + ink label
            //   OFF — transparent + $borderColor + ink label
            // Measured (border vs page canvas / ink label on fill), all three
            // themes: ON 3.57–6.97 / 12.86–15.78; OFF 3.36–16.22 / ink.
            //
            // NOT `secondary`'s own `$structure` border for the OFF state:
            // 2.46:1 on ember ($background) / 2.25:1 ($surface), under WCAG
            // 1.4.11's 3:1 for a control's visual boundary — and an unfilled
            // chip's border IS its boundary.
            //
            // The wash alone is only 1.13–1.22:1 against the canvas, so it is
            // deliberately NOT the state cue on its own: the accent border
            // carries it visually and `aria-pressed` carries it for AT.
            //
            // Hover keeps `secondary`'s inversion ($structure fill +
            // $onStructure label, measured AA on every theme: 16.22 / 6.97 /
            // 6.97), but the SELECTED chip holds its accent border through it.
            // Without that, a hovered selected chip was pixel-identical to a
            // hovered unselected one, so a single-select row read as "nothing
            // selected" and the next click surprised the user by deselecting.
            //
            // Overriding ONE pseudo key is safe: getSplitStyles keys pseudo
            // styles per-property-per-pseudo (`${property}${PROP_SPLIT}hover`,
            // getSplitStyles.tsx:728) and Button spreads `variant` BEFORE
            // `{...restProps}` (Button.tsx:283/287), so this replaces only
            // `borderColor-hover` and leaves the variant's fill and label
            // colour in force. That is also why the wash canNOT be held here:
            // a `backgroundColor`-only override would strand `$onStructure`
            // (near-white) on a pale wash, and `ButtonProps` types
            // `hoverStyle` as `StackStyleBase`, which has no `color` to fix it.
            {...(isOn
              ? {
                  backgroundColor: "$accentSoft",
                  borderColor: "$accent",
                  hoverStyle: { borderColor: "$accent" },
                }
              : { borderColor: "$borderColor" })}
            size="$2"
            // Selection was conveyed by colour alone (filled vs outlined) —
            // no state reached assistive tech at all (WCAG 1.4.1). Mirrors the
            // density toggle in ActionBar.
            aria-pressed={isOn}
            onPress={() => onSelect(isOn ? undefined : opt.value)}
          >
            <Text
              variant="bodySmall"
              tone="inherit"
              weight={isOn ? "semibold" : "regular"}
            >
              {opt.label}
            </Text>
          </Button>
        );
      })}
    </XStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter row (search + chips + clear)
// ─────────────────────────────────────────────────────────────────────────────

export interface FilterRowProps {
  /** Whether any search query or filter is active. */
  hasActiveFilters: boolean;
  /** Clears all search + filter state. */
  onClearAll: () => void;
  /** Child slots — typically `<SearchBar>` and/or `<FilterChips>`. */
  children: ReactNode;
}

/**
 * Wraps search + filter controls in a consistent vertical layout.
 *
 * Shows a "Clear filters" ghost button when any filter is active.
 */
export function FilterRow({
  hasActiveFilters,
  onClearAll,
  children,
}: FilterRowProps) {
  const t = useTranslations();
  return (
    <YStack gap="$3">
      <XStack gap="$3" flexWrap="wrap" alignItems="center">
        {children}
        {hasActiveFilters && (
          <Button variant="ghost" size="$2" onPress={onClearAll}>
            <X size={14} />
            <Text variant="bodySmall">{String(t("admin.atClearFilters"))}</Text>
          </Button>
        )}
      </XStack>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

export interface PaginationProps {
  /** Zero-based current page index. */
  page: number;
  /** Total number of pages. */
  totalPages: number;
  /** Called with the new zero-based page index. */
  onPageChange: (page: number) => void;
  /** Current rows-per-page value. When provided the page-size selector renders. */
  pageSize?: number;
  /** Called when the user picks a different page size. */
  onPageSizeChange?: (size: number) => void;
  /** Available page-size options (defaults to [10, 25, 50, 100]). */
  pageSizeOptions?: readonly number[];
  /**
   * Total row count. When provided (with `pageSize`) a "ROWS 1–25 OF 128"
   * range label renders next to the pager. Hidden when absent.
   */
  total?: number;
}

const DEFAULT_PS_OPTIONS = [10, 25, 50, 100] as const;

/**
 * Pagination labels — the mono label idiom at the `sm` rung (IBM Plex Mono
 * 11px / 2px / 600, uppercase). `tabular-nums` is kept even though a monospace
 * face is already fixed-width: the fallback stack is what paints before the
 * webfont lands, and a row count that reflows on font swap is exactly the
 * jitter this style exists to prevent.
 */
const paginationKickerStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontWeight: 600,
  fontSize: 11,
  letterSpacing: 2,
  textTransform: "uppercase",
  fontVariantNumeric: "tabular-nums",
};

/**
 * Previous / Next pagination bar with an optional rows-per-page selector on
 * the left and an optional "ROWS 1–25 OF 128" range label (pass `total`).
 *
 * Renders nothing when `totalPages <= 1` **and** no page-size selector is shown.
 *
 * The range label is translated (`admin.atRowsRange`), NOT a plain-English
 * literal: this component is reused by SELLER-facing pages (sell/listings,
 * sell/claims, sell/payouts), where English chrome is a localization
 * regression rather than an accepted admin-surface trade-off.
 */
export function Pagination({
  page,
  totalPages,
  onPageChange,
  pageSize,
  onPageSizeChange,
  pageSizeOptions = DEFAULT_PS_OPTIONS,
  total,
}: PaginationProps) {
  const t = useTranslations();

  const showPageSize = pageSize !== undefined && onPageSizeChange !== undefined;
  if (totalPages <= 1 && !showPageSize) return null;

  // Range label: "ROWS 1–25 OF 128". Needs both total and pageSize; hidden
  // for zero rows (the table's empty state already says so) and for
  // out-of-range pages (a stale `?p=` URL would otherwise render nonsense
  // like "Rows 201–30 of 30").
  const rangeStart = page * (pageSize ?? 0) + 1;
  const rangeEnd = Math.min((page + 1) * (pageSize ?? 0), total ?? 0);
  const showRange =
    total !== undefined &&
    total > 0 &&
    pageSize !== undefined &&
    rangeStart <= rangeEnd;

  return (
    <XStack
      justifyContent="center"
      alignItems="center"
      gap="$3"
      // Phones: rows-per-page + prev/next wrap onto extra lines instead of
      // overflowing the viewport horizontally.
      flexWrap="wrap"
      paddingVertical="$3"
      borderTopWidth={2}
      borderTopColor="$borderColor"
      marginTop="$2"
      // Hook for globals.css: directly after a TableContainer (data-dt-frame)
      // this top rule stands down, so the frame's bottom rule is the only one.
      data-dt-pager=""
    >
      {/* ── Rows-per-page selector (left) ── */}
      {showPageSize && (
        <XStack gap="$2" alignItems="center" marginRight="auto">
          <Text variant="bodySmall" tone="muted" style={paginationKickerStyle}>
            {String(t("admin.atRowsPerPage"))}
          </Text>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label={String(t("admin.atRowsPerPage"))}
            style={{
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 2,
              minHeight: 36,
              padding: "6px 10px",
              borderRadius: 0,
              border: "2px solid var(--borderColor, #211C16)",
              background: "transparent",
              color: "var(--color, #211C16)",
              cursor: "pointer",
              fontVariantNumeric: "tabular-nums",
            }}
            // Focus ring via handlers: inline styles can't express
            // :focus-visible, and the native ring is suppressed above.
            onFocus={(e) => {
              e.currentTarget.style.outline =
                "2px solid var(--accent, #E2481D)";
              e.currentTarget.style.outlineOffset = "2px";
            }}
            onBlur={(e) => {
              e.currentTarget.style.outline = "none";
            }}
          >
            {pageSizeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </XStack>
      )}

      {/* ── Range label / Prev / Next ── */}
      {showRange && (
        <Text variant="caption" tone="muted" style={paginationKickerStyle}>
          {String(
            t("admin.atRowsRange", {
              start: rangeStart,
              end: rangeEnd,
              total,
            }),
          )}
        </Text>
      )}
      {totalPages > 1 && (
        <>
          <Button
            variant="outlined"
            size="$3"
            icon
            aria-label={String(t("admin.atPrevious"))}
            onPress={() => onPageChange(Math.max(0, page - 1))}
            disabled={page === 0}
          >
            {/* 2.5 stroke per the v2 arrow rule. */}
            <ChevronLeft size={16} strokeWidth={2.5} />
          </Button>
          {!showRange && (
            <Text
              variant="bodySmall"
              tone="muted"
              style={paginationKickerStyle}
            >
              {String(
                t("admin.atPageOf", { page: page + 1, total: totalPages }),
              )}
            </Text>
          )}
          <Button
            variant="outlined"
            size="$3"
            icon
            aria-label={String(t("admin.atNext"))}
            onPress={() => onPageChange(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
          >
            <ChevronRight size={16} strokeWidth={2.5} />
          </Button>
        </>
      )}
    </XStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// No-results empty state
// ─────────────────────────────────────────────────────────────────────────────

export interface NoResultsProps {
  /** Main heading, e.g. "No matching orders". */
  title: string;
  /** Supporting copy, e.g. "Try adjusting your filters." */
  description?: string;
  /** Show a clear-filters button. */
  onClearFilters?: () => void;
  /**
   * Overrides the clear button's label. The default (`admin.atClearFiltersShowAll`)
   * is DISTINCT from `FilterRow`'s `admin.atClearFilters` on purpose: both
   * buttons are on screen at once in the filtered-empty state, and two
   * controls sharing one accessible name is ambiguous for screen-reader and
   * voice-control users.
   *
   * Translated, not a literal: several consumers (sell/claims, sell/payouts,
   * sell/listings) are SELLER-facing, so a hardcoded English default would
   * regress es users on a surface that was previously localized.
   */
  clearLabel?: string;
}

/**
 * Empty state shown inside a DataTable when filters yield zero rows.
 */
export function NoResults({
  title,
  description,
  onClearFilters,
  clearLabel,
}: NoResultsProps) {
  const t = useTranslations();
  return (
    <YStack padding="$8" alignItems="center" justifyContent="center" gap="$3">
      <Text variant="h4" weight="bold">
        {title}
      </Text>
      {description && (
        <Text variant="body" tone="muted" textAlign="center" maxWidth={360}>
          {description}
        </Text>
      )}
      {onClearFilters && (
        <Button variant="outlined" size="$2" onPress={onClearFilters}>
          {clearLabel ?? String(t("admin.atClearFiltersShowAll"))}
        </Button>
      )}
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Column selector
// ─────────────────────────────────────────────────────────────────────────────

export interface ColumnOption {
  /** Must match `DataTableColumn.id`. */
  id: string;
  /** Human-readable column header label. */
  label: string;
}

export interface ColumnSelectorProps {
  /** All available columns. */
  options: ColumnOption[];
  /** Whether a column is currently visible. */
  isVisible: (id: string) => boolean;
  /** Toggle a column on/off. */
  onToggle: (id: string) => void;
  /** Show all columns. */
  onShowAll: () => void;
  /** True when at least one column is hidden. */
  hasHidden: boolean;
}

/**
 * A dropdown button that lets users show/hide individual table columns.
 *
 * Built on the shared `@th/ui` Popover (Floating UI): portals to <body> so
 * the panel is never clipped by the TableContainer's `overflow: auto`, and
 * repositions on scroll/resize. Escape and outside clicks close it.
 */
export function ColumnSelector({
  options,
  isVisible,
  onToggle,
  onShowAll,
  hasHidden,
}: ColumnSelectorProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape, returning focus to the trigger.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  return (
    <Popover
      open={open}
      placement="bottom-end"
      matchAnchorWidth={false}
      contentProps={{
        backgroundColor: "$surface",
        minWidth: 180,
        zIndex: 1200,
      }}
      anchor={
        // The Popover clones its anchor to attach the Floating UI reference
        // ref — the span wrapper takes it so the button keeps `triggerRef`.
        <span style={{ display: "inline-flex" }}>
          <button
            ref={triggerRef}
            type="button"
            // "dialog": the panel is a checkbox group, not a menu of
            // commands — "menu"/"true" would set the wrong SR expectations.
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((prev) => !prev)}
            style={{
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              padding: "4px 12px",
              borderRadius: 0,
              border: "2px solid var(--borderColor, #211C16)",
              background: "transparent",
              color: "var(--color, inherit)",
              userSelect: "none",
              textTransform: "uppercase",
              letterSpacing: 0.8,
              fontWeight: 600,
            }}
          >
            <Columns3 size={14} />
            <span>{String(t("admin.atColumns"))}</span>
          </button>
        </span>
      }
    >
      <div
        ref={panelRef}
        role="group"
        aria-label={String(t("admin.atColumns"))}
        style={{ maxHeight: 320, overflowY: "auto", padding: "6px 0" }}
      >
        {options.map((opt) => (
          <label
            key={opt.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 14px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={isVisible(opt.id)}
              onChange={() => onToggle(opt.id)}
              style={{ accentColor: "var(--structure, #211C16)" }}
            />
            {opt.label}
          </label>
        ))}

        {hasHidden && (
          <div
            style={{
              borderTop: "2px solid var(--borderColor, #211C16)",
              marginTop: 4,
              paddingTop: 4,
            }}
          >
            <button
              type="button"
              onClick={() => {
                onShowAll();
                setOpen(false);
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 14px",
                fontSize: 11,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                // accentText, not accent: interactive labels need the
                // AA-legible accent rung (v2 §Divergences).
                color: "var(--accentText, #A8300F)",
                textTransform: "uppercase",
                letterSpacing: 0.8,
                fontWeight: 600,
              }}
            >
              {String(t("admin.atShowAllColumns"))}
            </button>
          </div>
        )}
      </div>
    </Popover>
  );
}
