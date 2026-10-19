"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";

import { Text, type TextProps } from "../typography/Text";
import {
  Tooltip,
  TOOLTIP_CLOSE_DELAY_MS,
  type TooltipPlacement,
  type TooltipTone,
} from "./Tooltip";

const isWeb = Platform.OS === "web";

/**
 * SSR-safe layout effect: `useLayoutEffect` on the client, `useEffect` on the
 * server (where it would otherwise warn). Mirrors how `Tooltip.tsx` guards its
 * web-only layout work.
 */
const useIsomorphicLayoutEffect =
  isWeb && typeof window !== "undefined" ? useLayoutEffect : useEffect;

// Forces a single clipped line with `…` ellipsis across every Text variant
// (including inline ones like `code`), so measurement + the visual affordance
// are reliable regardless of the caller's variant.
const CLIP_STYLE = {
  display: "block" as const,
  width: "100%" as const,
  minWidth: 0,
  overflow: "hidden" as const,
  textOverflow: "ellipsis" as const,
  whiteSpace: "nowrap" as const,
};

export interface OverflowTooltipProps
  extends Omit<TextProps, "children" | "truncate"> {
  /** The single-line value to render (truncated when it overflows). */
  text: string;
  /** Full value revealed in the tooltip. Defaults to `text`. */
  tooltipText?: string;
  /** Tooltip placement relative to the text. Defaults to `"top"`. */
  placement?: TooltipPlacement;
  /**
   * Tooltip bubble tone. Named distinctly from Text's `tone` (which still
   * passes through to style the visible label). Defaults to `"neutral"`.
   */
  tooltipTone?: TooltipTone;
  /** Max width of the tooltip bubble in px. Defaults to `320`. */
  tooltipMaxWidth?: number;
}

/**
 * Single-line, ellipsis-truncated text that reveals its FULL value in a
 * `Tooltip` on hover — but ONLY when the text is actually clipped (visually
 * overflowing). The generic overflow-with-tooltip solution for NON-table
 * surfaces (the `DataTable` has its own per-column `tooltipValue` mechanism).
 *
 * Web: renders the text on one line with `text-overflow: ellipsis`, measures
 * `scrollWidth > clientWidth` to detect clipping, and re-measures on the text
 * value changing and on container resize (`ResizeObserver`). The hover tooltip
 * is mounted as an absolutely-positioned sibling overlay, so toggling it never
 * changes the measured element's layout (no flip-flop remeasure loop). The full
 * value already lives in the DOM (only visually clipped), so screen readers get
 * it without the tooltip.
 *
 * Native: renders a plain `<Text truncate>` single line — no measurement, no
 * tooltip, no extra dependencies.
 */
export const OverflowTooltip = forwardRef<HTMLDivElement, OverflowTooltipProps>(
  (
    {
      text,
      tooltipText,
      placement = "top",
      tooltipTone = "neutral",
      tooltipMaxWidth = 320,
      style,
      ...textProps
    },
    forwardedRef,
  ) => {
    const measureRef = useRef<HTMLElement | null>(null);
    const [isOverflowing, setIsOverflowing] = useState(false);
    const [size, setSize] = useState<{ width: number; height: number }>({
      width: 0,
      height: 0,
    });

    const measure = useCallback(() => {
      const el = measureRef.current;
      if (!el) return;
      // +1 tolerance guards against sub-pixel rounding false positives.
      setIsOverflowing(el.scrollWidth > el.clientWidth + 1);
      setSize((prev) =>
        prev.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight },
      );
    }, []);

    useIsomorphicLayoutEffect(() => {
      if (!isWeb) return;
      measure();
    }, [measure, text, tooltipText]);

    useEffect(() => {
      if (!isWeb || typeof ResizeObserver === "undefined") return;
      const el = measureRef.current;
      if (!el) return;
      const observer = new ResizeObserver(() => measure());
      observer.observe(el);
      return () => observer.disconnect();
    }, [measure]);

    // ── Hover state + anchor→bubble gap bridge ────────────────────────────
    // The overlay carrying the Tooltip is `pointerEvents:none` so it never eats
    // selection of the visible clipped Text beneath it. Hover is driven from the
    // container (which wraps that Text), and the Tooltip runs CONTROLLED. The
    // bubble is portalled outside the container, so leaving the Text toward it
    // fires the container's pointerleave — we schedule the close and let the
    // bubble's own pointer-enter (relayed via onBubblePointerEnter) cancel it,
    // making the full value reachable/copyable. None of this touches the
    // measured Text, so measurement stays independent of open state.
    const [isTooltipOpen, setIsTooltipOpen] = useState(false);
    const closeTimerRef = useRef<number | null>(null);

    const clearCloseTimer = useCallback(() => {
      if (closeTimerRef.current !== null) {
        if (typeof window !== "undefined") {
          window.clearTimeout(closeTimerRef.current);
        }
        closeTimerRef.current = null;
      }
    }, []);

    const openTooltip = useCallback(() => {
      clearCloseTimer();
      setIsTooltipOpen(true);
    }, [clearCloseTimer]);

    const scheduleCloseTooltip = useCallback(() => {
      clearCloseTimer();
      if (typeof window === "undefined") {
        setIsTooltipOpen(false);
        return;
      }
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        setIsTooltipOpen(false);
      }, TOOLTIP_CLOSE_DELAY_MS);
    }, [clearCloseTimer]);

    useEffect(() => clearCloseTimer, [clearCloseTimer]);

    // ── Native: plain truncated line, no measurement, no tooltip ──────────
    // `forwardedRef` is intentionally NOT attached here: the ref is typed as
    // an HTMLDivElement (web container) and there is no measurement/overlay to
    // reference on native. This is deliberate, not an oversight.
    if (!isWeb) {
      return (
        <Text truncate style={style} {...textProps}>
          {text}
        </Text>
      );
    }

    const providedStyle = Array.isArray(style) ? style : style ? [style] : [];
    const resolvedTooltip = tooltipText ?? text;

    return (
      <div
        ref={forwardedRef}
        data-overflowing={isOverflowing ? "true" : "false"}
        onPointerEnter={isOverflowing ? openTooltip : undefined}
        onPointerLeave={isOverflowing ? scheduleCloseTooltip : undefined}
        style={{
          position: "relative",
          display: "block",
          width: "100%",
          minWidth: 0,
        }}
      >
        <Text
          ref={measureRef as never}
          style={[CLIP_STYLE, ...providedStyle]}
          {...textProps}
        >
          {text}
        </Text>
        {isOverflowing ? (
          // Absolutely-positioned overlay: out of flow, so mounting/unmounting
          // it never re-flows (and never re-measures) the clipped Text above.
          // `pointerEvents:none` keeps it from eating selection of the visible
          // Text — hover is driven from the container above and the Tooltip runs
          // controlled, so the user can select the clipped label AND hover into
          // the (copyable) bubble.
          <div
            aria-hidden
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            <Tooltip
              open={isTooltipOpen}
              onBubblePointerEnter={openTooltip}
              onBubblePointerLeave={scheduleCloseTooltip}
              anchor={
                <div
                  style={{
                    display: "block",
                    width: size.width || "100%",
                    height: size.height || "100%",
                  }}
                />
              }
              placement={placement}
              tone={tooltipTone}
              maxWidth={tooltipMaxWidth}
            >
              {resolvedTooltip}
            </Tooltip>
          </div>
        ) : null}
      </div>
    );
  },
);

OverflowTooltip.displayName = "OverflowTooltip";
