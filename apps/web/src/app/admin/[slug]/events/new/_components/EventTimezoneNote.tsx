"use client";

import { styled, XStack, YStack } from "tamagui";

import { Text, useTranslations } from "@th/ui";

import type { TimezoneAdoptionSource } from "./event-timezone";

/**
 * "Which clock am I typing in?" — rendered directly under the event's
 * start/end fields in the full builder and under quick-create's starts-at.
 *
 * Why it exists: the builder's zone is not typed on this screen, it is ADOPTED
 * from the location set further down the form — the venue picked, or the
 * freeform address's coordinates (see `./event-timezone.ts`).
 * A zone that moves with no visible trace is the worst version of that
 * feature — on an already-saved event, adopting a new zone moves the show —
 * so the zone is always stated, and the moment it moves the move itself is
 * stated too, with the interpretation spelled out ("8:00 PM means 8:00 PM at
 * the venue").
 *
 * Shared by both callers so the two surfaces cannot drift apart in copy.
 */

/**
 * The whole block is the live region. It is rendered UNCONDITIONALLY (never
 * behind `adoptedFrom &&`) because an aria-live container has to be in the DOM
 * before its content changes to be announced reliably — and the thing that
 * changes it is a control further down the page, well away from the fields it
 * re-interprets.
 */
// No top margin/padding: the enclosing `Field` already carries the 6px rhythm,
// which is what visually attaches this note to the date inputs above it.
const NoteStack = styled(YStack, {
  gap: 6,
});

/**
 * The zone just moved. Strict Swiss: square, a 2px accent rule on the leading
 * edge (accent as a graphic, never as the label colour — it has no AA
 * foreground), muted fill so it reads as an aside, not an error.
 */
const AdoptedNote = styled(XStack, {
  paddingVertical: 8,
  paddingHorizontal: 10,
  borderRadius: 0,
  borderLeftWidth: 2,
  borderLeftColor: "$accent",
  backgroundColor: "$surfaceMuted",
});

export type EventTimezoneNoteProps = {
  /** IANA zone the date fields above are interpreted in at save time. */
  timezone: string;
  /**
   * What the zone was just adopted FROM, or null when the zone is whatever the
   * builder started with (a saved event's stored zone, or the browser's).
   *
   * A venue has a name to say; a freeform address does not, so it gets its own
   * sentence rather than an awkward blank in the venue one.
   */
  adoptedFrom: TimezoneAdoptionSource | null;
  /** Root test id; the adopted note gets `${testId}-adopted`. */
  testId?: string;
};

export function EventTimezoneNote({
  timezone,
  adoptedFrom,
  testId = "event-timezone-note",
}: EventTimezoneNoteProps) {
  const t = useTranslations();

  const standingKey = !adoptedFrom
    ? "admin.ebTimezoneNote"
    : adoptedFrom.kind === "venue"
      ? "admin.ebTimezoneVenueNote"
      : "admin.ebTimezoneAddressNote";

  return (
    <NoteStack role="status" aria-live="polite" data-testid={testId}>
      <Text variant="caption" tone="muted">
        {String(t(standingKey, { timezone }))}
      </Text>
      {adoptedFrom ? (
        <AdoptedNote data-testid={`${testId}-adopted`}>
          <Text variant="caption">
            {String(
              adoptedFrom.kind === "venue"
                ? t("admin.ebTimezoneAdoptedNote", {
                    timezone,
                    venue: adoptedFrom.name,
                  })
                : t("admin.ebTimezoneAdoptedAddressNote", { timezone }),
            )}
          </Text>
        </AdoptedNote>
      ) : null}
    </NoteStack>
  );
}

export default EventTimezoneNote;
