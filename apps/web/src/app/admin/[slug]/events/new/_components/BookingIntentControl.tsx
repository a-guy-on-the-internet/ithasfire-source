"use client";

import { XStack, styled } from "tamagui";

import { Text } from "@th/ui";

import {
  BOOKING_INTENTS,
  intentDomId,
  nextIntentForKey,
  type BookingIntent,
} from "./builder-placement.helpers";

/**
 * "Book this place for": Play here / Rent a space / Use a space.
 *
 * A radiogroup, not tabs — the choice filters ONE cascade (calendar → space)
 * below it, it does not swap panels. Hand-rolled rather than `@th/ui`'s
 * `SegmentedControl` for one reason that molecule cannot meet: an intent the
 * venue does not offer is rendered DISABLED with a hint, not hidden (spec:
 * "offering only what the calendar allows" — but the organizer should see
 * what exists), and `SegmentedControl` has no per-option disabled state.
 *
 * Keyboard model is the house radiogroup one (`SecureMethodChoice`): one tab
 * stop (roving tabindex on the selected radio), arrows/Home/End move focus AND
 * selection through the ENABLED radios only, wrapping at both ends. Each radio
 * is a real `<button>`, so Space and Enter select natively. The pure key
 * grammar lives in `builder-placement.helpers.ts` (`nextIntentForKey`).
 *
 * Selected = accent border + accent wash + ink label (the v2 `.chip.on`
 * grammar, same as `SegmentedControl`) — never the full accent fill, which
 * the Address / My Places toggle directly above already spends. The focus
 * ring is the house `$focus` outline, deliberately NOT a restyle of the
 * selected state, so a radio that is focused-but-unselected never reads as
 * chosen.
 *
 * Unavailable = dimmed BY TOKEN, not by alpha: a soft border and a muted
 * label (`$colorMuted`, AA on `$surface`), so the label stays legible while
 * the hint line under the group explains why it is off. Whole-segment
 * opacity would drop the label under 3:1.
 *
 * Wrapping: three labels do not fit one row at 320px. The segments are
 * separate boxed chips with a gap (not a joined bar with overlapping
 * borders), so a wrapped third segment keeps a clean 2px edge on every side;
 * the label itself wraps to two lines rather than truncating.
 */

const Group = styled(XStack, {
  name: "BookingIntentGroup",
  flexWrap: "wrap",
  gap: 8,
});

const Segment = styled(XStack, {
  name: "BookingIntentSegment",
  tag: "button",
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: "auto",
  minWidth: 96,
  minHeight: 44,
  paddingVertical: 10,
  paddingHorizontal: 12,
  alignItems: "center",
  justifyContent: "center",
  borderWidth: 2,
  borderStyle: "solid",
  borderRadius: 0,
  borderColor: "$borderColorStrong",
  backgroundColor: "$surface",
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$focus",
    outlineOffset: 2,
  },
  variants: {
    selected: {
      true: {
        backgroundColor: "$accentSoft",
        borderColor: "$accent",
        hoverStyle: { backgroundColor: "$accentSoft" },
      },
    },
    unavailable: {
      true: {
        borderColor: "$borderColorSoft",
        cursor: "not-allowed",
        hoverStyle: { backgroundColor: "$surface" },
      },
    },
  } as const,
});

export type BookingIntentControlProps = {
  value: BookingIntent;
  /** Intents at least one calendar accepts; the rest render disabled. */
  offered: readonly BookingIntent[];
  onChange: (next: BookingIntent) => void;
  /** Control labels, keyed by intent (translated by the caller). */
  labels: Record<BookingIntent, string>;
  /** DOM id of the visible label the group is named by. */
  labelledBy: string;
  /** Prefix for the radios' DOM ids (focus follows selection through them). */
  idBase: string;
  testIdBase?: string;
};

export function BookingIntentControl({
  value,
  offered,
  onChange,
  labels,
  labelledBy,
  idBase,
  testIdBase = "booking-intent",
}: BookingIntentControlProps) {
  const enabledOrder = BOOKING_INTENTS.filter((intent) =>
    offered.includes(intent),
  );
  // The roving tab stop. When the current value is NOT offered (a hydrated
  // intent the venue has since switched off, or a provisional guess at a
  // rent-only venue) the selected radio is disabled, so the first ENABLED
  // radio takes the stop instead — the group must never lose its tab stop.
  const tabStop: BookingIntent | undefined = offered.includes(value)
    ? value
    : enabledOrder[0];

  const handleKeyDown = (event: {
    key: string;
    preventDefault: () => void;
  }) => {
    const target = nextIntentForKey(value, event.key, enabledOrder);
    if (!target) return;
    event.preventDefault();
    if (target !== value) onChange(target);
    document.getElementById(intentDomId(idBase, target))?.focus();
  };

  return (
    <Group
      role="radiogroup"
      aria-labelledby={labelledBy}
      data-testid={`${testIdBase}-group`}
      // Tamagui's view types are RN-first and omit the DOM `onKeyDown`; the
      // cast spread is the established pattern here (see SegmentedControl).
      {...({ onKeyDown: handleKeyDown } as object)}
    >
      {BOOKING_INTENTS.map((intent) => {
        const enabled = offered.includes(intent);
        const selected = intent === value;
        // Web-only attributes — valid on the rendered <button>, absent from
        // Tamagui's RN prop types. `type` too: a styled `tag: "button"`
        // otherwise defaults to submit inside a form.
        const a11y = {
          type: "button",
          id: intentDomId(idBase, intent),
          tabIndex: !enabled ? -1 : intent === tabStop ? 0 : -1,
          "aria-disabled": enabled ? undefined : true,
        };
        return (
          <Segment
            key={intent}
            role="radio"
            aria-checked={selected}
            selected={selected}
            unavailable={!enabled}
            data-testid={`${testIdBase}-${intent.toLowerCase()}`}
            onPress={() => {
              if (enabled && intent !== value) onChange(intent);
            }}
            {...a11y}
          >
            <Text
              variant="bodySmall"
              weight="bold"
              color={enabled ? "$color" : "$colorMuted"}
              textAlign="center"
            >
              {labels[intent]}
            </Text>
          </Segment>
        );
      })}
    </Group>
  );
}

BookingIntentControl.displayName = "BookingIntentControl";
