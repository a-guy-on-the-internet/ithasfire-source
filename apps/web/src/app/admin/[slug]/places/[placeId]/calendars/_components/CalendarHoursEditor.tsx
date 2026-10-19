"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import { Plus, Trash2 } from "lucide-react";
import { Button, Spinner, Text, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

import { AvailabilityScopeLine } from "./AvailabilityScopeLine";
import {
  DEFAULT_EXTRA_WINDOW,
  DEFAULT_WINDOW,
  WEEKDAY_ORDER,
  hoursUpsertFields,
  isOvernight,
  openWindowsForDay,
  timeInputStyle,
  windowError,
  type AvailabilityRow,
  type AvailabilityScope,
} from "./venue-calendars-helpers";

export interface CalendarHoursEditorProps {
  placeId: string;
  /** `null` = the place-wide "All calendars" scope. */
  scope: AvailabilityScope;
  /** Visible name of the selected scope, for per-row accessible labels. */
  scopeLabel: string;
}

/**
 * Weekly opening windows for ONE availability scope — a named calendar, or
 * "All calendars" (place-wide rows with `calendarId: null`).
 *
 * A weekday with no rows is dark; a weekday can hold more than one window, so
 * a venue that runs a matinee and an evening bill keeps them as separate
 * bookable inventory. Each window is its own `CalendarAvailability` row and
 * commits on blur — there is no save button to forget. Every write is a
 * FULL-PUT (see venue-calendars-helpers.ts).
 */
export function CalendarHoursEditor({
  placeId,
  scope,
  scopeLabel,
}: CalendarHoursEditorProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const query = trpc.places.listCalendarAvailability.useQuery({ placeId });
  const rows: AvailabilityRow[] = query.data ?? [];

  // Local text state per row, so typing "1" in an hour field doesn't fire a
  // write on every keystroke — the row commits on blur.
  const [drafts, setDrafts] = useState<
    Record<string, { start: string; end: string }>
  >({});

  const onError = (err: unknown) => {
    toast.danger({
      id: "calendar-hours-failed",
      title: String(t("admin.peHoursUpdateFailed")),
      message: formatErrorMessage(err, t),
    });
  };

  // The setup-state detector (availability-onboarding spec) counts rows, so
  // EVERY availability write moves it — creating the first row dismisses the
  // "acts can't reach you" warning, deleting the last one brings it back.
  const refresh = () =>
    Promise.all([
      utils.places.listCalendarAvailability.invalidate({ placeId }),
      utils.places.getAvailabilitySetupState.invalidate({ placeId }),
    ]);

  const upsert = trpc.places.upsertCalendarAvailability.useMutation({
    onSuccess: () => void refresh(),
    onError,
  });
  const remove = trpc.places.deleteCalendarAvailability.useMutation({
    onSuccess: () => void refresh(),
    onError,
  });

  const busy = upsert.isPending || remove.isPending;

  const dayLabels = [
    String(t("admin.peHoursSunday")),
    String(t("admin.peHoursMonday")),
    String(t("admin.peHoursTuesday")),
    String(t("admin.peHoursWednesday")),
    String(t("admin.peHoursThursday")),
    String(t("admin.peHoursFriday")),
    String(t("admin.peHoursSaturday")),
  ];

  const commit = (row: AvailabilityRow, dayOfWeek: number) => {
    const draft = drafts[row.id];
    if (!draft) return;
    const startTime = draft.start;
    const endTime = draft.end;
    if (startTime === row.startTime && endTime === row.endTime) return;
    if (windowError(startTime, endTime)) return;
    // FULL-PUT update: id + every field. Scope comes from the ROW (immutable
    // after create), never from the currently-selected UI scope.
    upsert.mutate({
      placeId,
      id: row.id,
      ...hoursUpsertFields({ scope, dayOfWeek, startTime, endTime, row }),
    });
  };

  return (
    <YStack gap="$3">
      <YStack gap="$1">
        <Text variant="body" weight="bold">
          {String(t("admin.peHoursTitle"))}
        </Text>
        {/* The scope reached this component as props that only ever showed up
            in aria-labels — a sighted owner got no signal at all. */}
        <AvailabilityScopeLine scope={scope} scopeLabel={scopeLabel} />
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.peHoursHelp"))}
        </Text>
      </YStack>

      {query.isPending ? (
        <XStack paddingVertical="$4" justifyContent="center">
          <Spinner size="sm" />
        </XStack>
      ) : query.error ? (
        /* A failed read must NOT render as "every day closed" with live
           buttons — an owner who re-adds their hours over a transient error
           ends up with duplicate rows once it clears. */
        <YStack gap="$3">
          <Text variant="body" tone="error">
            {formatErrorMessage(query.error, t)}
          </Text>
          <XStack>
            <Button
              variant="secondary"
              size="$2"
              onPress={() => void query.refetch()}
            >
              {String(t("admin.placesRetry"))}
            </Button>
          </XStack>
        </YStack>
      ) : (
        <YStack borderWidth={2} borderColor="$borderColor">
          {WEEKDAY_ORDER.map((day, index) => {
            const windows = openWindowsForDay(rows, scope, day);
            const isOpen = windows.length > 0;

            return (
              <XStack
                key={day}
                gap="$3"
                padding="$3"
                alignItems="flex-start"
                flexWrap="wrap"
                borderTopWidth={index === 0 ? 0 : 1}
                borderTopColor="$borderColor"
                backgroundColor={isOpen ? "transparent" : "$surfaceMuted"}
              >
                <Text variant="overline" width={92} paddingTop="$2">
                  {dayLabels[day]}
                </Text>

                {/* flexBasis 220 (NOT flex:1 + minWidth): a 0% basis never
                    triggers flexWrap, so at 320px the min-width used to force
                    this column ~60px past the row border. With a real basis
                    the column wraps onto its own full-width line instead. */}
                <YStack flexGrow={1} flexShrink={1} flexBasis={220} gap="$2">
                  {isOpen ? (
                    windows.map((row) => {
                      const draft = drafts[row.id] ?? {
                        start: row.startTime ?? "",
                        end: row.endTime ?? "",
                      };
                      const error = windowError(draft.start, draft.end);
                      const overnight =
                        !error && isOvernight(draft.start, draft.end);

                      return (
                        <YStack key={row.id} gap="$1">
                          <XStack gap="$2" alignItems="center" flexWrap="wrap">
                            <input
                              type="time"
                              value={draft.start}
                              // The time range keeps the name unique when a
                              // weekday holds more than one window.
                              aria-label={String(
                                t("admin.peHoursOpensAt", {
                                  scope: scopeLabel,
                                  day: dayLabels[day],
                                  start: draft.start,
                                  end: draft.end,
                                }),
                              )}
                              style={timeInputStyle(!!error)}
                              onChange={(e) =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [row.id]: { ...draft, start: e.target.value },
                                }))
                              }
                              onBlur={() => commit(row, day)}
                            />
                            <Text variant="bodySmall" tone="muted">
                              –
                            </Text>
                            <input
                              type="time"
                              value={draft.end}
                              aria-label={String(
                                t("admin.peHoursClosesAt", {
                                  scope: scopeLabel,
                                  day: dayLabels[day],
                                  start: draft.start,
                                  end: draft.end,
                                }),
                              )}
                              style={timeInputStyle(!!error)}
                              onChange={(e) =>
                                setDrafts((prev) => ({
                                  ...prev,
                                  [row.id]: { ...draft, end: e.target.value },
                                }))
                              }
                              onBlur={() => commit(row, day)}
                            />
                            {overnight && (
                              <Text
                                variant="caption"
                                weight="bold"
                                color="$accentText"
                                style={{ textTransform: "uppercase" }}
                              >
                                {String(t("admin.peHoursNextDay"))}
                              </Text>
                            )}
                            <Button
                              variant="ghost"
                              size="$2"
                              disabled={busy}
                              onPress={() =>
                                remove.mutate({ placeId, id: row.id })
                              }
                              aria-label={String(
                                t("admin.peHoursRemoveWindow", {
                                  scope: scopeLabel,
                                  day: dayLabels[day],
                                  start: draft.start,
                                  end: draft.end,
                                }),
                              )}
                            >
                              <Trash2 size={15} />
                            </Button>
                          </XStack>
                          {error && (
                            <Text variant="caption" tone="error">
                              {String(
                                t(
                                  error === "empty"
                                    ? "admin.peHoursErrorEmpty"
                                    : "admin.peHoursErrorInvalid",
                                ),
                              )}
                            </Text>
                          )}
                        </YStack>
                      );
                    })
                  ) : (
                    <Text variant="bodySmall" tone="muted" paddingTop="$2">
                      {String(t("admin.peHoursClosedHint"))}
                    </Text>
                  )}

                  {isOpen && (
                    <XStack>
                      <Button
                        variant="ghost"
                        size="$2"
                        disabled={busy}
                        onPress={() =>
                          upsert.mutate({
                            placeId,
                            ...hoursUpsertFields({
                              scope,
                              dayOfWeek: day,
                              ...DEFAULT_EXTRA_WINDOW,
                            }),
                          })
                        }
                        aria-label={`${String(t("admin.peHoursAddWindow"))} — ${scopeLabel}, ${dayLabels[day]}`}
                      >
                        <XStack gap="$1" alignItems="center">
                          <Plus size={14} />
                          <Text variant="caption" weight="bold">
                            {String(t("admin.peHoursAddWindow"))}
                          </Text>
                        </XStack>
                      </Button>
                    </XStack>
                  )}
                </YStack>

                {/* Secondary in both states (one primary per viewport — the
                    page's is "Create calendar"); the muted row background is
                    what carries the closed state. */}
                <Button
                  variant="secondary"
                  size="$2"
                  disabled={busy}
                  onPress={() => {
                    if (isOpen) {
                      // Dark day = no rows at all in this scope, which is what
                      // the booking calendar reads as "closed".
                      windows.forEach((row) =>
                        remove.mutate({ placeId, id: row.id }),
                      );
                    } else {
                      upsert.mutate({
                        placeId,
                        ...hoursUpsertFields({
                          scope,
                          dayOfWeek: day,
                          ...DEFAULT_WINDOW,
                        }),
                      });
                    }
                  }}
                  aria-label={`${String(
                    t(
                      isOpen ? "admin.peHoursCloseDay" : "admin.peHoursOpenDay",
                    ),
                  )} — ${scopeLabel}, ${dayLabels[day]}`}
                  aria-pressed={!isOpen}
                >
                  {String(
                    t(
                      isOpen ? "admin.peHoursCloseDay" : "admin.peHoursOpenDay",
                    ),
                  )}
                </Button>
              </XStack>
            );
          })}
        </YStack>
      )}

      <Text variant="caption" tone="muted">
        {String(t("admin.peHoursFooter"))}
      </Text>
    </YStack>
  );
}
