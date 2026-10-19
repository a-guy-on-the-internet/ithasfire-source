"use client";

import { useCallback } from "react";
import { XStack, YStack, styled } from "tamagui";
import { Badge, Spinner, Text, useTranslations } from "@th/ui";
import { CalendarDays } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  PlacePicker,
  type PlacePickerItem,
} from "@/components/places/PlacePicker";

// ─────────────────────────────────────────────────────────────────────────────
// Calendar subject picker (venue-hierarchy FR-010).
//
// A named Calendar is a child of a Place, so the subject is chosen in two
// steps — place, then one of that place's calendars. Grouping the rows under
// their place is not decoration: calendar names are place-local ("Live Music"
// exists at three of your spaces), so a flat list of them would be ambiguous by
// construction.
//
// The place half reuses PlacePicker verbatim — the same control the Booking
// tab and the event builder use, with the same org scoping — so this file only
// owns the calendar rows.
// ─────────────────────────────────────────────────────────────────────────────

export type CalendarSubjectOption = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  spaceCount: number;
};

const CalendarRowButton = styled(XStack, {
  name: "EmbedCalendarRow",
  tag: "button",
  width: "100%",
  minHeight: 44,
  alignItems: "center",
  gap: "$3",
  paddingHorizontal: "$4",
  paddingVertical: "$3",
  borderRadius: 0,
  borderWidth: 1,
  borderColor: "$borderColorStrong",
  backgroundColor: "$surface",
  cursor: "pointer",
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: -2,
  },
  variants: {
    selected: {
      true: {
        borderColor: "$accent",
        backgroundColor: "$accentSoft",
      },
    },
  } as const,
});

export function CalendarSubjectPicker({
  place,
  onPlaceChange,
  value,
  onChange,
  orgId,
  adminSlug,
}: {
  place: PlacePickerItem | null;
  onPlaceChange: (place: PlacePickerItem | null) => void;
  value: CalendarSubjectOption | null;
  onChange: (calendar: CalendarSubjectOption | null) => void;
  orgId?: string;
  adminSlug?: string;
}) {
  const t = useTranslations();
  const calendarsQuery = trpc.places.listCalendars.useQuery(
    { placeId: place?.placeId ?? "" },
    { enabled: Boolean(place?.placeId), staleTime: 30_000, retry: 1 },
  );

  // Changing place must clear the calendar — a calendar id from the previous
  // place would be a cross-place subject the server rejects.
  const handlePlaceChange = useCallback(
    (next: PlacePickerItem | null) => {
      onChange(null);
      onPlaceChange(next);
    },
    [onChange, onPlaceChange],
  );

  const calendars = calendarsQuery.data ?? [];

  return (
    <YStack gap="$3">
      <PlacePicker
        value={place}
        onChange={handlePlaceChange}
        orgId={orgId}
        adminSlug={adminSlug}
        placeholder={String(t("admin.embedSelectPlace"))}
      />

      {place && (
        <YStack gap="$2" data-testid="embed-calendar-rows">
          {/* The place name is the GROUP header — see the module note on why
              calendar names alone are ambiguous. Uppercased in CSS, not with
              `.toUpperCase()`: a screen reader announces an all-caps STRING
              letter by letter, and casing is locale-sensitive. */}
          <Text
            variant="caption"
            weight="bold"
            tone="muted"
            textTransform="uppercase"
            letterSpacing={0.6}
          >
            {String(
              t("admin.embedCalendarGroupHeading", { place: place.name }),
            )}
          </Text>

          {calendarsQuery.isLoading ? (
            <XStack padding="$3" justifyContent="center">
              <Spinner size="sm" />
            </XStack>
          ) : calendarsQuery.error ? (
            <Text variant="caption" tone="error" role="alert">
              {formatErrorMessage(calendarsQuery.error, t)}
            </Text>
          ) : calendars.length === 0 ? (
            // Every place mints a default calendar (FR-002), so this is only
            // reachable for a pre-hierarchy row — say what to do, don't blank.
            <Text variant="caption" tone="muted">
              {String(t("admin.embedCalendarNoneInPlace"))}
            </Text>
          ) : (
            // Deliberately NOT `role="radiogroup"` / `role="radio"`. Those roles
            // promise roving-tabindex + Arrow/Home/End navigation, and these
            // rows are plain <button>s that do none of it — an AT user who
            // trusts the announced semantics would be stranded. They behave as
            // toggle buttons, so they are announced as toggle buttons:
            // `aria-pressed` on a native button, in a plain group.
            <YStack
              gap="$2"
              role="group"
              aria-label={String(t("admin.embedCalendarListLabel"))}
            >
              {calendars.map((calendar) => {
                const spaceCount = calendar.spaces.filter(
                  (r) => r.status === "ACTIVE",
                ).length;
                const selected = value?.id === calendar.id;
                return (
                  <CalendarRowButton
                    key={calendar.id}
                    selected={selected}
                    aria-pressed={selected}
                    testID={`embed-calendar-row-${calendar.slug}`}
                    onPress={() =>
                      onChange({
                        id: calendar.id,
                        name: calendar.name,
                        slug: calendar.slug,
                        isDefault: calendar.isDefault,
                        spaceCount,
                      })
                    }
                  >
                    <CalendarDays size={16} style={{ flexShrink: 0 }} aria-hidden />
                    {/* flexBasis + minWidth, never `flex: 1` alone: Tamagui
                        inherits RN's `flexShrink: 0`, so a long calendar name
                        would hold its max-content width and push the badges
                        out of the row. */}
                    {/* `textAlign="left"` is load-bearing: the row renders as
                        a native <button>, whose UA style is
                        `text-align: center`, and it inherits straight into
                        these labels. Without it the name floats mid-row. */}
                    <YStack
                      flexBasis={0}
                      flexGrow={1}
                      flexShrink={1}
                      minWidth={0}
                      alignItems="flex-start"
                    >
                      <Text variant="bodySmall" weight="bold" truncate textAlign="left">
                        {calendar.name}
                      </Text>
                      <Text variant="caption" tone="muted" truncate textAlign="left">
                        {String(
                          t("admin.embedCalendarSpaceCount", {
                            count: spaceCount,
                          }),
                        )}
                      </Text>
                    </YStack>
                    {calendar.isDefault && (
                      <Badge tone="neutral" size="sm">
                        {String(t("admin.embedCalendarDefaultBadge"))}
                      </Badge>
                    )}
                  </CalendarRowButton>
                );
              })}
            </YStack>
          )}
        </YStack>
      )}
    </YStack>
  );
}
