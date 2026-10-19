"use client";

import { useEffect, useState } from "react";
import { XStack, YStack } from "tamagui";
import { AmountInput, Text } from "@th/ui";

import { AmountSlider } from "@/components/pricing/AmountSlider";

import { formatCents } from "@/lib/format";
import {
  adjustableSliderMaxCents,
  centsToEditableDollars,
  parseDollarsToCents,
  type SellableItem,
} from "./sell-cart";

/**
 * "Pay what you can" — the buyer names their price, above a floor the
 * organiser sets.
 *
 * THE WORDS ARE THE FEATURE. That exact phrase, nowhere near "donation",
 * "sliding scale", "tip" or "contribution". It says: the same ticket, at a
 * price you can meet. Someone paying the floor is a full customer, and no
 * string on this screen may imply otherwise. `ADJUSTABLE` stays the internal
 * pricing mode and `donationAmountCents` is still the wire field — that name
 * imports precisely the framing this control exists to avoid, and it is worth
 * renaming before more surfaces copy it.
 *
 * Two inputs, one number:
 *   - The SLIDER is imprecise, so it gets helped: the handle is magnetized to
 *     round money (see `magnetizeAmountCents`). A fast drag lands on $20, the number
 *     someone would say out loud, not $19.85.
 *   - The FIELD is the authority, not a mirror. It accepts anything at or above
 *     the floor, INCLUDING above the slider's range — the ceiling is a
 *     convenience, not a limit. Typed amounts are never magnetized: dragging is
 *     imprecise, typing is a statement of intent, so $17.35 typed stays $17.35.
 *
 * Keyboard moves in money, not in cents: the shared slider (`AmountSlider`)
 * takes the keys itself — $1 on the arrows, $5 on Page Up/Down — while the
 * range input underneath steps 5¢ for dragging, because nobody should nudge
 * 5¢ at a time to reach $30.
 *
 * The amount is PER TICKET — that is how the sell contract reads it — so the
 * readout says so and the line total does the multiplying where the operator
 * can see it.
 */
export function PayWhatYouCanControl({
  item,
  amountCents,
  qty,
  onChange,
}: {
  item: SellableItem;
  amountCents: number;
  qty: number;
  onChange: (cents: number) => void;
}) {
  const floorCents = item.minimumCents ?? 0;
  const maxCents = adjustableSliderMaxCents(item);
  const standardCents = item.suggestedCents;

  /**
   * The field's text is local while it's being edited, so a half-typed "1"
   * inside "17.35" doesn't reprice the cart to $1 and yank the slider with it.
   * It resyncs whenever the committed amount changes from anywhere else (the
   * slider, a preset, resetting the cart).
   */
  const [draft, setDraft] = useState(() => centsToEditableDollars(amountCents));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(centsToEditableDollars(amountCents));
  }, [amountCents, editing]);

  const commitDraft = (raw: string) => {
    const parsed = parseDollarsToCents(raw);
    if (parsed == null) {
      // Junk or empty — keep the last good amount rather than snapping to $0.
      setDraft(centsToEditableDollars(amountCents));
      return;
    }
    // Typed amounts are NOT magnetized, but the floor is a server-enforced
    // refusal, so clamping up to it here saves a round trip at a door.
    onChange(Math.max(floorCents, parsed));
  };

  /**
   * The presets. "Covers another" is the honest name for 2× the standard: it
   * says what the money does without asking for a favour.
   */
  const presets: Array<{ cents: number; label: string }> = [
    { cents: floorCents, label: "Floor" },
    ...(standardCents != null && standardCents > floorCents
      ? [{ cents: standardCents, label: "Standard" }]
      : []),
    ...(standardCents != null && standardCents > 0
      ? [{ cents: standardCents * 2, label: "Covers another" }]
      : []),
  ];

  // Above the slider's ceiling the handle pins at the end — and says so, so a
  // pinned handle never reads as a value that failed to take.
  const pinned = amountCents > maxCents;
  const lineTotalCents = amountCents * qty;

  return (
    <YStack gap="$3" paddingTop="$2">
      <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
        <Text variant="h4" weight="bold">
          {formatCents(amountCents)}
        </Text>
        <Text variant="caption" tone="muted">
          per ticket
        </Text>
        {pinned ? (
          <Text variant="caption" tone="muted">
            · above the slider&rsquo;s range
          </Text>
        ) : null}
      </XStack>

      {/* The shared money slider: round-money magnet on a drag, $1/$5 key
          steps, Home/End to the ends. Its keyboard stays open-ended here, as
          it always was: a key press past the track end moves the amount and
          the handle pins. */}
      <AmountSlider
        valueCents={amountCents}
        floorCents={floorCents}
        maxCents={maxCents}
        onChange={onChange}
        label={`Pay what you can amount — ${item.name}`}
        valueText={`${formatCents(amountCents)} per ticket`}
        testId={`pwyc-slider-${item.ticketTypeId}`}
      />

      <XStack justifyContent="space-between">
        <Text variant="caption" tone="muted">
          {formatCents(floorCents)} floor
        </Text>
        <Text variant="caption" tone="muted">
          {formatCents(maxCents)}
        </Text>
      </XStack>

      <XStack gap="$2" flexWrap="wrap">
        {presets.map((preset) => {
          const active = amountCents === preset.cents;
          return (
            <YStack
              key={`${preset.label}-${preset.cents}`}
              // Real <button>: Enter/Space come free, so no keydown handler.
              tag="button"
              // The item name is load-bearing, not decoration: an event with
              // two pay-what-you-can tiers on the same floor and standard
              // renders six presets, three pairs of which would otherwise
              // share an accessible name and leave a screen-reader user unable
              // to tell which tier they are pricing. Same defect class as the
              // card-readers input that announced its own placeholder.
              aria-label={`Set to ${formatCents(preset.cents)} — ${preset.label} — ${item.name}`}
              aria-pressed={active}
              onPress={() => onChange(preset.cents)}
              cursor="pointer"
              paddingVertical="$2"
              paddingHorizontal="$3"
              minHeight={44}
              justifyContent="center"
              borderWidth={2}
              borderColor={active ? "$accent" : "$borderColor"}
              backgroundColor={active ? "$surfaceMuted" : "transparent"}
              hoverStyle={{ backgroundColor: "$surfaceOverlay" }}
              focusStyle={{
                outlineWidth: 2,
                outlineColor: "$accent",
                outlineStyle: "solid",
                outlineOffset: 2,
              }}
            >
              <Text variant="bodySmall" weight="bold">
                {formatCents(preset.cents)}
              </Text>
              <Text variant="caption" tone="muted">
                {preset.label}
              </Text>
            </YStack>
          );
        })}
      </XStack>

      <YStack gap="$2" maxWidth={220}>
        <Text variant="caption" tone="muted">
          Or type it
        </Text>
        <AmountInput
          prefix="$"
          value={draft}
          onChangeText={setDraft}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false);
            commitDraft(draft);
          }}
          onSubmitEditing={() => commitDraft(draft)}
          inputMode="decimal"
          // Without this the accessible name falls back to the placeholder, so
          // a screen reader announces the field as its own example value. The
          // card-readers page shipped exactly that bug and only driving the
          // page in a browser caught it.
          aria-label={`Pay what you can amount in dollars — ${item.name}`}
          fullWidth
        />
      </YStack>

      {qty > 1 ? (
        <Text variant="caption" tone="muted">
          {qty} × {formatCents(amountCents)} = {formatCents(lineTotalCents)}
        </Text>
      ) : null}
    </YStack>
  );
}
