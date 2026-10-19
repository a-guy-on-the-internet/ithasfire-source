"use client";

import { useCallback, useRef, type KeyboardEvent } from "react";
import { XStack, styled, type GetProps } from "tamagui";

import { Text } from "../typography/Text";

/**
 * SegmentedControl — Design System v2 molecule.
 *
 * A row of mutually-exclusive options (a filter/scope toggle). The SELECTED
 * segment uses the v2 `.chip.on` grammar — accent border + a subtle accent
 * wash (`$accentSoft`) + ink label — NOT a full accent fill. The full accent
 * fill is `variant="primary"`, reserved for the ONE primary action per
 * viewport (Section 03); a selected toggle wearing it violates that budget,
 * which is what the Button-`primary`/`secondary` segmented hacks were doing.
 *
 * Same treatment as `ViewToggle` (the icon segmented control), generalized to
 * N text options. Radius 0, 2px borders, joined via a −2px overlap so the
 * selected segment's accent border draws cleanly over its neighbors.
 */

const SegmentRow = styled(XStack, {
  name: "SegmentedControl",
  alignItems: "stretch",
});

const Segment = styled(XStack, {
  name: "SegmentedControlSegment",
  alignItems: "center",
  justifyContent: "center",
  borderWidth: 2,
  borderRadius: 0,
  paddingHorizontal: "$4",
  cursor: "pointer",
  transition: "all 150ms ease-out",
  pressStyle: { scale: 0.98 },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$focus",
    outlineOffset: 2,
  },

  variants: {
    size: {
      sm: { minHeight: 32 },
      md: { minHeight: 38 },
    },
    // Selected: accent border + accent wash + ink label (v2 .chip.on).
    selected: {
      true: {
        backgroundColor: "$accentSoft",
        borderColor: "$accent",
        zIndex: 1,
        hoverStyle: { backgroundColor: "$accentSoft" },
      },
      false: {
        backgroundColor: "transparent",
        borderColor: "$borderColor",
        // Subtle accent hint on hover, like the v2 chip.
        hoverStyle: { borderColor: "$accent" },
      },
    },
    fullWidth: {
      true: { flex: 1 },
      false: {},
    },
  } as const,

  defaultVariants: {
    size: "md",
    selected: false,
    fullWidth: false,
  },
});

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> extends Omit<
  GetProps<typeof SegmentRow>,
  "children" | "onChange" | "size"
> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  /**
   * Segments grow to fill the row. Each keeps its label's width as its
   * starting size (`flex: 1` with an auto basis), so a longer label gets a
   * wider segment; pair with `equalSegments` for equal widths.
   */
  fullWidth?: boolean;
  /**
   * Every segment the same width (a zero flex basis: the row's width is split
   * evenly). A segment still never shrinks below its own label. Opt-in so
   * existing `fullWidth` rows keep their layout.
   */
  equalSegments?: boolean;
  /** Accessible name for the radiogroup. */
  ariaLabel?: string;
  /** Per-segment test id base → `${testIdBase}-${option.value}`. */
  testIdBase?: string;
  /**
   * Let the row wrap onto more lines and a label wrap inside its segment
   * (default false: one line, segments never shrink). For rows whose labels
   * can outgrow a narrow container, such as a long place name at 320px.
   * Wrapped lines keep their joined borders square with the container edge.
   */
  wrap?: boolean;
  /** Dim + block interaction (mirrors a disabled control; sets aria-disabled). */
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  fullWidth = false,
  equalSegments = false,
  ariaLabel,
  testIdBase,
  wrap = false,
  disabled = false,
  ...rest
}: SegmentedControlProps<T>) {
  const segmentRefs = useRef<(HTMLElement | null)[]>([]);

  const select = useCallback(
    (next: T) => {
      if (!disabled && next !== value) onChange(next);
    },
    [disabled, value, onChange],
  );

  // WAI-ARIA radiogroup keyboard model: roving tabindex (only the selected
  // segment is tabbable); arrows/Home/End move AND select; Enter/Space
  // activate the focused segment. Handled on the group so it catches the
  // focused segment's key events.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (disabled) return;
      const len = options.length;
      const current = options.findIndex((o) => o.value === value);
      let next: number | null = null;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          next = (current + 1) % len;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          next = (current - 1 + len) % len;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = len - 1;
          break;
        case " ":
        case "Enter":
          next = current; // activate the focused (selected) segment
          break;
        default:
          return;
      }
      event.preventDefault();
      const target = options[next];
      if (target) {
        select(target.value);
        segmentRefs.current[next]?.focus();
      }
    },
    [disabled, options, value, select],
  );

  return (
    <SegmentRow
      role="radiogroup"
      aria-label={ariaLabel}
      {...(disabled ? { "aria-disabled": true, opacity: 0.5 } : {})}
      // Segments join by a −2px left margin (shared borders), which would push
      // the first segment of every WRAPPED line 2px past the container edge.
      // So when wrapping, every segment takes the −2px and the row pads 2px
      // on the left: each line's first border lands on the edge.
      {...(wrap ? { flexWrap: "wrap", rowGap: "$2", paddingLeft: 2 } : {})}
      // Tamagui's view types are RN-first and omit the DOM `onKeyDown`; spread
      // via a cast (the established pattern for web key handlers here).
      {...({ onKeyDown: handleKeyDown } as object)}
      {...rest}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Segment
            key={option.value}
            ref={(el: unknown) => {
              segmentRefs.current[index] = (el as HTMLElement) ?? null;
            }}
            role="radio"
            aria-checked={selected}
            // Roving tabindex — only the selected segment is a tab stop.
            tabIndex={disabled ? -1 : selected ? 0 : -1}
            size={size}
            selected={selected}
            fullWidth={fullWidth}
            {...(equalSegments ? { flexGrow: 1, flexBasis: 0 } : {})}
            onPress={() => select(option.value)}
            {...(disabled ? { pointerEvents: "none" } : {})}
            // Overlap adjacent 2px borders into a single shared edge; the
            // selected segment (zIndex 1) draws its accent border on top.
            marginLeft={index === 0 && !wrap ? 0 : -2}
            // Segments don't shrink by default; when wrapping, one wider than
            // its line shrinks and wraps its label instead of overflowing.
            {...(wrap ? { flexShrink: 1, minWidth: 0 } : {})}
            {...(testIdBase
              ? { "data-testid": `${testIdBase}-${option.value}` }
              : {})}
          >
            {/* v2 .chip label grammar — Montserrat 700 / uppercase / +1
                tracking. Ink when selected, muted otherwise (the wash +
                border carry accent). */}
            <Text
              variant="span"
              fontSize={size === "sm" ? 11 : 12}
              letterSpacing={1}
              textTransform="uppercase"
              weight="bold"
              color={selected ? "$color" : "$colorMuted"}
              {...(wrap
                ? { textAlign: "center", style: { overflowWrap: "anywhere" } }
                : {})}
            >
              {option.label}
            </Text>
          </Segment>
        );
      })}
    </SegmentRow>
  );
}

SegmentedControl.displayName = "SegmentedControl";
