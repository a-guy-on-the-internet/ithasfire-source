"use client";

import { XStack, styled } from "tamagui";
import { Text } from "@th/ui";

/**
 * The status filter both org Bookings lists sit under — Open / Accepted / All.
 *
 * DELIBERATELY NOT A SECOND `role="tablist"`. The page already owns one (To
 * your venues / To you as an act / Sent to acts), and a tablist nested inside a
 * tabpanel gives assistive tech two competing "which view am I on?" answers for
 * one screen. This is a pressed-toggle group instead: `role="group"` plus
 * `aria-pressed` per segment, which announces as "Open, 5, toggle button,
 * pressed" and leaves the page's tab semantics unambiguous.
 *
 * SEPARATELY BORDERED SEGMENTS, NOT ONE BORDERED STRIP. Measured inside the
 * admin shell at 320px, the filter row gets 206px of content width; three
 * uppercase segments with their counts need ~267px. Tamagui inherits RN's
 * `flexShrink: 0`, so a single-outline segmented control cannot wrap without
 * the outline cutting through the wrap — the group therefore wraps as
 * individually-outlined chips, which is also the design system's rule for
 * chips (flex, content-sized, wraps).
 *
 * The counts passed in MUST come from the same filter the panel renders. A tab
 * advertising a number it does not show is the specific bug the Accepted view
 * exists to fix.
 */
const SegmentRow = styled(XStack, {
  name: "BookingsStatusSegments",
  gap: "$1",
  flexWrap: "wrap",
  alignSelf: "flex-start",
});

// A native <button> so Enter and Space activate it with no bespoke key handler.
const Segment = styled(XStack, {
  name: "BookingsStatusSegment",
  tag: "button",
  backgroundColor: "transparent",
  borderWidth: 1,
  borderColor: "$borderColor",
  borderStyle: "solid",
  borderRadius: 0,
  paddingHorizontal: "$3",
  minHeight: 44,
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  variants: {
    // Decisive Swiss inversion — not a tint. The active segment becomes an ink
    // block with a canvas-coloured label.
    active: {
      true: { backgroundColor: "$color", borderColor: "$color" },
    },
  } as const,
});

export interface StatusSegmentsProps<K extends string> {
  segments: { key: K; label: string }[];
  value: K;
  onChange: (next: K) => void;
  /** Accessible name for the group wrapper. */
  ariaLabel: string;
  /** `{testIdBase}` on the group, `{testIdBase}-{key}` on each segment. */
  testIdBase: string;
}

export function StatusSegments<K extends string>({
  segments,
  value,
  onChange,
  ariaLabel,
  testIdBase,
}: StatusSegmentsProps<K>) {
  return (
    <SegmentRow role="group" aria-label={ariaLabel} testID={testIdBase}>
      {segments.map(({ key, label }) => {
        const active = value === key;
        return (
          <Segment
            key={key}
            active={active}
            onPress={() => onChange(key)}
            testID={`${testIdBase}-${key}`}
            // Valid on the rendered <button>, absent from Tamagui's RN prop
            // types — the spread keeps the escape hatch scoped. `type` is
            // included because a styled `tag: "button"` defaults to
            // type="submit" and would submit any enclosing form.
            {...({ type: "button", "aria-pressed": active } as Record<
              string,
              unknown
            >)}
          >
            <Text
              variant="caption"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={0.6}
              color={active ? "$background" : "$colorMuted"}
            >
              {label}
            </Text>
          </Segment>
        );
      })}
    </SegmentRow>
  );
}
