// @ts-nocheck — WIP volunteering feature; createBatch type resolution differs between local/CI Turbopack builds
"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { XStack, YStack, styled } from "tamagui";
import {
  Button,
  Text,
  TextInput,
  Tooltip,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Clock, Copy, HelpCircle, Plus, Trash2 } from "lucide-react";

import { formatErrorMessage } from "@/lib/format-error-message";
import { trpc } from "@/trpc";
import { DateTimeLocalInput } from "@/components/forms/DateTimeLocalInput";
import { isoToLocalInput, localInputToIso } from "@/lib/datetime-local";
import {
  ShiftAnchorFields,
  ShiftAnchorPreview,
  shiftAnchorUnavailableMessage,
} from "@/components/volunteering/ShiftAnchorFields";
import {
  emptyShiftDraftFields,
  resolveTemplateShift,
  shiftDraftDurationMinutes,
  withShiftDraftDurationMinutes,
  type ShiftDraftFields,
  type ShiftResolutionTarget,
} from "@/lib/template-shift-offset";

import {
  createEmptyShiftComposerRow,
  createPresetShiftComposerRow,
  duplicateShiftComposerRow,
  repeatShiftComposerRowAcrossDays,
  rowHasErrors,
  shiftComposerPresetOrder,
  toCreateShiftBatchItem,
  type ShiftComposerDraftRow,
  type ShiftComposerDraftRowErrors,
  type ShiftComposerFieldErrorCode,
  type ShiftComposerPresetKey,
  validateShiftComposerRow,
} from "./shift-composer-helpers";

const MAX_BATCH_ROWS = 25;

/**
 * Match the visual height/padding of the design system's TextInput so that
 * native `<input type="datetime-local">` lines up cleanly when stacked.
 */
const NATIVE_DATETIME_STYLE: React.CSSProperties = {
  height: 40,
  padding: "0 12px",
  border: "1px solid var(--borderColor)",
  borderRadius: 0,
  backgroundColor: "var(--surface)",
  color: "var(--color)",
  fontFamily: "inherit",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};

const ComposerCard = styled(YStack, {
  name: "VolunteerShiftComposerCard",
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surfaceMuted",
  padding: "$3",
  gap: "$3",
});

const DraftCard = styled(YStack, {
  name: "VolunteerShiftComposerDraftCard",
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  padding: "$3",
  gap: "$3",
});

/**
 * Draft shift handed in from the apply-template flow. Already
 * materialized to ISO timestamps — the composer treats these like any
 * other draft row, so the user can adjust dates/times before saving.
 */
export interface SeedDraft {
  label: string;
  startsAtIso: string;
  endsAtIso: string;
  capacity: number | null;
}

interface InlineShiftComposerProps {
  roleId: string;
  eventStartsAt: Date | null | undefined;
  eventEndsAt: Date | null | undefined;
  /**
   * The event's IANA zone (`Event.timezone`), for display only.
   *
   * The `<input type="datetime-local">` fields below render and parse in the
   * BROWSER's zone — that's what the native control does and we're not
   * replacing it here. Template presets, though, are materialized in the
   * event's zone (FR-006), so an organizer in London applying an 18:00 Nashville
   * preset sees "00:00 the next day" in the input and would reasonably "correct"
   * it back to 18:00 — which the input re-parses as 18:00 London and persists,
   * recreating the bug. Echoing the venue-time reading under each field makes
   * the displayed value intelligible instead of looking wrong.
   *
   * Rendering + parsing directly in the event zone is the real fix and a larger
   * change; this is the guardrail until then.
   */
  eventTimezone?: string | null;
  /**
   * Optional pre-populated drafts (e.g. from a template apply). The
   * composer reads these once on mount and prepends them to the empty
   * draft list. Pass a fresh array if you want to re-seed.
   */
  seedDrafts?: SeedDraft[];
  /** Fired after `seedDrafts` has been consumed so the parent can clear it. */
  onSeedConsumed?: () => void;
  onCreated: () => void;
}

function hasErrors(errors: ShiftComposerDraftRowErrors | undefined) {
  return errors ? rowHasErrors(errors) : false;
}

function getFieldErrorMessage(
  t: ReturnType<typeof useTranslations>,
  code: ShiftComposerFieldErrorCode | undefined,
) {
  if (code === "required") {
    return String(t("admin.volunteerShiftComposerFieldRequired"));
  }
  if (code === "ends_before_start") {
    return String(t("admin.volunteerShiftComposerFieldEndsAfterStart"));
  }
  if (code === "invalid_capacity") {
    return String(t("admin.volunteerShiftComposerFieldCapacityInvalid"));
  }
  return null;
}

function getPresetLabel(
  t: ReturnType<typeof useTranslations>,
  preset: ShiftComposerPresetKey,
) {
  if (preset === "setup") {
    return String(t("admin.volunteerShiftComposerPresetSetup"));
  }
  if (preset === "doors") {
    return String(t("admin.volunteerShiftComposerPresetDoors"));
  }
  if (preset === "main") {
    return String(t("admin.volunteerShiftComposerPresetMain"));
  }
  return String(t("admin.volunteerShiftComposerPresetCleanup"));
}

export function InlineShiftComposer({
  roleId,
  eventStartsAt,
  eventEndsAt,
  eventTimezone,
  seedDrafts,
  onSeedConsumed,
  onCreated,
}: InlineShiftComposerProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const notify = useNotify();
  const [rows, setRows] = useState<ShiftComposerDraftRow[]>([]);
  const [rowErrors, setRowErrors] = useState<
    Record<string, ShiftComposerDraftRowErrors>
  >({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Hydrate seed drafts on first arrival. We watch the array reference
  // so the parent can re-seed by handing in a new array. Each seed run
  // fires `onSeedConsumed` so the parent can clear its slot — keeps the
  // composer authoritative for what's currently editable.
  useEffect(() => {
    if (!seedDrafts || seedDrafts.length === 0) return;
    setRows((current) => [
      ...seedDrafts.map(
        (draft): ShiftComposerDraftRow => ({
          id:
            globalThis.crypto?.randomUUID?.() ??
            `seed-${Math.random().toString(36).slice(2, 10)}`,
          startsAt: draft.startsAtIso,
          endsAt: draft.endsAtIso,
          label: draft.label,
          capacity: draft.capacity != null ? String(draft.capacity) : "",
        }),
      ),
      ...current,
    ]);
    onSeedConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedDrafts]);

  const createBatchMutation = trpc.volunteer.shifts.createBatch.useMutation({
    meta: { silent: true },
  });

  const eventStartsAtIso = eventStartsAt?.toISOString();
  const eventEndsAtIso = eventEndsAt?.toISOString();
  const canAddMore = rows.length < MAX_BATCH_ROWS;
  const presetsDisabled =
    !eventStartsAtIso || createBatchMutation.isPending || !canAddMore;

  const clearErrorsForRow = (
    rowId: string,
    fields: Array<keyof ShiftComposerDraftRowErrors>,
  ) => {
    setRowErrors((current) => {
      const existing = current[rowId];
      if (!existing) return current;

      const nextRowErrors = { ...existing };
      for (const field of fields) {
        delete nextRowErrors[field];
      }

      if (!rowHasErrors(nextRowErrors)) {
        const next = { ...current };
        delete next[rowId];
        return next;
      }

      return { ...current, [rowId]: nextRowErrors };
    });
  };

  const insertRow = (nextRow: ShiftComposerDraftRow, afterRowId?: string) => {
    setRows((current) => {
      if (!afterRowId) {
        return [...current, nextRow];
      }

      const afterIndex = current.findIndex((row) => row.id === afterRowId);
      if (afterIndex === -1) {
        return [...current, nextRow];
      }

      return [
        ...current.slice(0, afterIndex + 1),
        nextRow,
        ...current.slice(afterIndex + 1),
      ];
    });
    setSubmitError(null);
  };

  const removeRow = (rowId: string) => {
    setRows((current) => current.filter((row) => row.id !== rowId));
    setRowErrors((current) => {
      if (!(rowId in current)) return current;
      const next = { ...current };
      delete next[rowId];
      return next;
    });
    setSubmitError(null);
  };

  const addBlankRow = (afterRowId?: string) => {
    if (!canAddMore) return;
    const previousRow = afterRowId
      ? rows.find((row) => row.id === afterRowId)
      : rows[rows.length - 1];

    insertRow(
      createEmptyShiftComposerRow({
        eventStartsAt: eventStartsAtIso,
        previousRow,
      }),
      afterRowId,
    );
  };

  const addPresetRow = (preset: ShiftComposerPresetKey) => {
    const nextRow = createPresetShiftComposerRow({
      preset,
      eventStartsAt: eventStartsAtIso,
      eventEndsAt: eventEndsAtIso,
      label: getPresetLabel(t, preset),
    });
    if (!nextRow) return;
    insertRow(nextRow);
  };

  const duplicateRow = (rowId: string) => {
    if (!canAddMore) return;
    const row = rows.find((entry) => entry.id === rowId);
    if (!row) return;
    insertRow(duplicateShiftComposerRow(row), rowId);
  };

  /**
   * Multi-day repeat: clones the row across the next N days, capped by
   * the global draft limit so we never silently drop user input.
   */
  const repeatRowAcrossDays = (rowId: string, days: number) => {
    const row = rows.find((entry) => entry.id === rowId);
    if (!row) return;
    const remaining = MAX_BATCH_ROWS - rows.length;
    if (remaining <= 0) return;
    const cappedDays = Math.min(days, remaining);
    const copies = repeatShiftComposerRowAcrossDays(row, cappedDays);
    if (copies.length === 0) return;
    setRows((current) => {
      const afterIndex = current.findIndex((entry) => entry.id === rowId);
      if (afterIndex === -1) return [...current, ...copies];
      return [
        ...current.slice(0, afterIndex + 1),
        ...copies,
        ...current.slice(afterIndex + 1),
      ];
    });
    setSubmitError(null);
  };

  const handleFieldChange = (
    rowId: string,
    patch: Partial<ShiftComposerDraftRow>,
    fieldsToClear: Array<keyof ShiftComposerDraftRowErrors>,
  ) => {
    setRows((current) =>
      current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
    );
    clearErrorsForRow(rowId, fieldsToClear);
    setSubmitError(null);
  };

  const handleDateFieldChange = (
    row: ShiftComposerDraftRow,
    patch: Pick<ShiftComposerDraftRow, "startsAt" | "endsAt">,
  ) => {
    const nextRow = { ...row, ...patch };

    setRows((current) =>
      current.map((entry) => (entry.id === row.id ? nextRow : entry)),
    );
    setRowErrors((current) => {
      const nextErrors = validateShiftComposerRow(nextRow);

      if (!rowHasErrors(nextErrors)) {
        if (!(row.id in current)) return current;
        const next = { ...current };
        delete next[row.id];
        return next;
      }

      return { ...current, [row.id]: nextErrors };
    });
    setSubmitError(null);
  };

  const handleTextFieldKeyDown =
    (rowId: string) => (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        addBlankRow(rowId);
      }

      if (event.key === "Escape") {
        event.preventDefault();
        removeRow(rowId);
      }
    };

  const handleSave = () => {
    const nextErrors: Record<string, ShiftComposerDraftRowErrors> = {};
    const validRows: ShiftComposerDraftRow[] = [];

    for (const row of rows) {
      const errors = validateShiftComposerRow(row);
      if (rowHasErrors(errors)) {
        nextErrors[row.id] = errors;
        continue;
      }
      validRows.push(row);
    }

    setRowErrors(nextErrors);

    if (validRows.length === 0) {
      setSubmitError(String(t("admin.volunteerShiftComposerFixErrors")));
      return;
    }

    const savedRowIds = new Set(validRows.map((row) => row.id));
    setSubmitError(null);

    createBatchMutation.mutate(
      {
        roleId,
        shifts: validRows.map(toCreateShiftBatchItem),
      },
      {
        onSuccess: (createdRows) => {
          notify.toast.success({
            id: `volunteer-shift-composer-created-${roleId}`,
            title: String(
              t("admin.volunteerShiftComposerSaved", {
                count: createdRows.length,
              }),
            ),
          });
          onCreated();
          setRows((current) =>
            current.filter((row) => !savedRowIds.has(row.id)),
          );
          setRowErrors((current) => {
            const next = { ...current };
            for (const rowId of savedRowIds) {
              delete next[rowId];
            }
            return next;
          });
          setSubmitError(
            Object.keys(nextErrors).length > 0
              ? String(t("admin.volunteerShiftComposerSavedWithErrors"))
              : null,
          );
        },
        onError: (error) => {
          const message = formatErrorMessage(error, t);
          setSubmitError(message);
          notify.toast.danger({
            id: `volunteer-shift-composer-save-failed-${roleId}`,
            title: String(t("admin.volunteerShiftSaveFailed")),
            message,
          });
        },
      },
    );
  };

  // Only worth showing when the venue's clock actually differs from the
  // organizer's — otherwise it's noise repeating what the input already says.
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const showVenueTime = Boolean(
    eventTimezone && eventTimezone !== browserTimeZone,
  );

  /**
   * The same instant read on the venue's wall clock, e.g. "Jun 15, 6:00 PM CDT".
   * Pure formatted data — no sentence to translate; `fmt.dateTime` localizes the
   * date parts and `timeZoneName` supplies the zone.
   */
  const venueTimeHint = (iso: string): string | null => {
    if (!showVenueTime || !iso) return null;
    const instant = new Date(iso);
    if (Number.isNaN(instant.getTime())) return null;
    try {
      return fmt.dateTime(instant, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: eventTimezone as string,
        timeZoneName: "short",
      });
    } catch {
      // Unknown zone id — Intl throws RangeError. Drop the hint rather than
      // taking the whole composer down over a decoration.
      return null;
    }
  };

  return (
    <ComposerCard>
      <YStack gap="$1">
        <Text variant="label">
          {String(t("admin.volunteerShiftComposerTitle"))}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("admin.volunteerShiftComposerDescription"))}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("admin.volunteerShiftComposerPresetHelp"))}
        </Text>
      </YStack>

      <XStack gap="$2" flexWrap="wrap">
        {shiftComposerPresetOrder.map((preset) => (
          <Button
            key={preset}
            variant="secondary"
            size="$2"
            onPress={() => addPresetRow(preset)}
            disabled={presetsDisabled}
          >
            {getPresetLabel(t, preset)}
          </Button>
        ))}
        <Button
          variant="primary"
          size="$2"
          onPress={() => addBlankRow()}
          disabled={createBatchMutation.isPending || !canAddMore}
        >
          <Plus size={14} aria-hidden />
          {String(t("admin.volunteerShiftAddCta"))}
        </Button>
      </XStack>

      {!eventStartsAtIso ? (
        <Text variant="caption" tone="muted">
          {String(t("admin.volunteerShiftComposerEventStartHint"))}
        </Text>
      ) : null}

      {!canAddMore ? (
        <Text variant="caption" tone="muted">
          {String(t("admin.volunteerShiftComposerLimitHint"))}
        </Text>
      ) : null}

      {rows.length > 0 ? (
        <YStack gap="$3">
          {rows.map((row, index) => {
            const errors = rowErrors[row.id];
            return (
              <DraftCard
                key={row.id}
                borderColor={hasErrors(errors) ? "$danger" : "$borderColor"}
              >
                <XStack
                  justifyContent="space-between"
                  gap="$2"
                  flexWrap="wrap"
                  alignItems="center"
                >
                  <Text variant="label">
                    {String(
                      t("admin.volunteerShiftComposerDraftLabel", {
                        count: index + 1,
                      }),
                    )}
                  </Text>
                  <XStack gap="$2" flexWrap="wrap" alignItems="center">
                    <Button
                      variant="ghost"
                      size="$2"
                      onPress={() => duplicateRow(row.id)}
                      disabled={createBatchMutation.isPending || !canAddMore}
                    >
                      <Copy size={14} aria-hidden />
                      {String(t("admin.volunteerShiftComposerDuplicateCta"))}
                    </Button>
                    <RepeatAcrossDaysControl
                      disabled={
                        createBatchMutation.isPending ||
                        !canAddMore ||
                        !row.startsAt
                      }
                      remaining={MAX_BATCH_ROWS - rows.length}
                      onRepeat={(days) => repeatRowAcrossDays(row.id, days)}
                      labels={{
                        trigger: String(
                          t("admin.volunteerShiftComposerRepeatDaysCta"),
                        ),
                        prompt: String(
                          t("admin.volunteerShiftComposerRepeatDaysPrompt"),
                        ),
                        confirm: String(
                          t("admin.volunteerShiftComposerRepeatDaysConfirm"),
                        ),
                        cancel: String(t("common.cancel")),
                      }}
                    />
                    <Tooltip
                      anchor={
                        <Button
                          variant="ghost"
                          size="$2"
                          onPress={() => removeRow(row.id)}
                          disabled={createBatchMutation.isPending}
                          aria-label={String(
                            t("admin.volunteerShiftComposerRemoveDraft"),
                          )}
                        >
                          <Trash2 size={14} />
                        </Button>
                      }
                      placement="top"
                    >
                      {String(t("admin.volunteerShiftComposerRemoveDraft"))}
                    </Tooltip>
                  </XStack>
                </XStack>

                <XStack gap="$3" flexWrap="wrap" alignItems="flex-start">
                  <YStack flex={1} minWidth={220} gap="$1">
                    <Text variant="label">
                      {String(t("admin.volunteerShiftFieldStartsAtLabel"))}
                    </Text>
                    <DateTimeLocalInput
                      type="datetime-local"
                      aria-label={String(
                        t("admin.volunteerShiftFieldStartsAtLabel"),
                      )}
                      value={isoToLocalInput(row.startsAt)}
                      onChange={(e) =>
                        handleDateFieldChange(row, {
                          startsAt: localInputToIso(e.target.value),
                        })
                      }
                      disabled={createBatchMutation.isPending}
                      data-testid={`volunteer-shift-draft-${row.id}-starts-at`}
                      style={NATIVE_DATETIME_STYLE}
                    />
                    {venueTimeHint(row.startsAt) ? (
                      <Text
                        variant="caption"
                        tone="muted"
                        data-testid={`volunteer-shift-draft-${row.id}-starts-at-venue-time`}
                      >
                        {venueTimeHint(row.startsAt)}
                      </Text>
                    ) : null}
                    {errors?.startsAt ? (
                      <Text variant="caption" tone="error">
                        {getFieldErrorMessage(t, errors.startsAt)}
                      </Text>
                    ) : null}
                  </YStack>
                  <YStack flex={1} minWidth={220} gap="$1">
                    <Text variant="label">
                      {String(t("admin.volunteerShiftFieldEndsAtLabel"))}
                    </Text>
                    <DateTimeLocalInput
                      type="datetime-local"
                      aria-label={String(
                        t("admin.volunteerShiftFieldEndsAtLabel"),
                      )}
                      value={isoToLocalInput(row.endsAt)}
                      onChange={(e) =>
                        handleDateFieldChange(row, {
                          endsAt: localInputToIso(e.target.value),
                        })
                      }
                      disabled={createBatchMutation.isPending}
                      data-testid={`volunteer-shift-draft-${row.id}-ends-at`}
                      style={NATIVE_DATETIME_STYLE}
                    />
                    {venueTimeHint(row.endsAt) ? (
                      <Text
                        variant="caption"
                        tone="muted"
                        data-testid={`volunteer-shift-draft-${row.id}-ends-at-venue-time`}
                      >
                        {venueTimeHint(row.endsAt)}
                      </Text>
                    ) : null}
                    {errors?.endsAt ? (
                      <Text variant="caption" tone="error">
                        {getFieldErrorMessage(t, errors.endsAt)}
                      </Text>
                    ) : null}
                  </YStack>
                </XStack>

                <AnchoredTimingControl
                  disabled={createBatchMutation.isPending}
                  eventStartsAt={eventStartsAt ?? null}
                  eventEndsAt={eventEndsAt ?? null}
                  timeZone={eventTimezone || browserTimeZone}
                  testIdBase={`volunteer-shift-draft-${row.id}`}
                  onApply={(startsAtIso, endsAtIso) =>
                    handleDateFieldChange(row, {
                      startsAt: startsAtIso,
                      endsAt: endsAtIso,
                    })
                  }
                />

                <XStack gap="$3" flexWrap="wrap" alignItems="flex-start">
                  <YStack flex={1} minWidth={220} gap="$1">
                    <Text variant="label">
                      {String(t("admin.volunteerShiftFieldLabelLabel"))}
                    </Text>
                    <TextInput
                      value={row.label}
                      onChangeText={(value) =>
                        handleFieldChange(row.id, { label: value }, [])
                      }
                      onKeyDown={handleTextFieldKeyDown(row.id)}
                      placeholder={String(
                        t("admin.volunteerShiftFieldLabelPlaceholder"),
                      )}
                      maxLength={200}
                      disabled={createBatchMutation.isPending}
                      fullWidth
                      testId={`volunteer-shift-draft-${row.id}-label`}
                    />
                  </YStack>
                  <YStack width={180} minWidth={180} gap="$1">
                    <XStack gap="$2" alignItems="center">
                      <Text variant="label">
                        {String(t("admin.volunteerShiftFieldCapacityLabel"))}
                      </Text>
                      <Tooltip
                        anchor={
                          <button
                            type="button"
                            aria-label={String(
                              t("admin.volunteerShiftFieldCapacityHint"),
                            )}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 18,
                              height: 18,
                              padding: 0,
                              background: "transparent",
                              border: "none",
                              color: "var(--colorMuted)",
                              cursor: "help",
                            }}
                          >
                            <HelpCircle size={12} />
                          </button>
                        }
                        placement="top"
                      >
                        {String(t("admin.volunteerShiftFieldCapacityHint"))}
                      </Tooltip>
                    </XStack>
                    <TextInput
                      value={row.capacity}
                      onChangeText={(value) =>
                        handleFieldChange(row.id, { capacity: value }, [
                          "capacity",
                        ])
                      }
                      onKeyDown={handleTextFieldKeyDown(row.id)}
                      placeholder={String(
                        t("admin.volunteerShiftFieldCapacityPlaceholder"),
                      )}
                      inputMode="numeric"
                      disabled={createBatchMutation.isPending}
                      fullWidth
                      testId={`volunteer-shift-draft-${row.id}-capacity`}
                    />
                    {errors?.capacity ? (
                      <Text variant="caption" tone="error">
                        {getFieldErrorMessage(t, errors.capacity)}
                      </Text>
                    ) : null}
                  </YStack>
                </XStack>
              </DraftCard>
            );
          })}

          <XStack
            justifyContent="space-between"
            alignItems="center"
            gap="$2"
            flexWrap="wrap"
          >
            <Button
              variant="ghost"
              size="$2"
              onPress={() => {
                setRows([]);
                setRowErrors({});
                setSubmitError(null);
              }}
              disabled={createBatchMutation.isPending}
            >
              {String(t("common.cancel"))}
            </Button>
            <Button
              variant="primary"
              size="$2"
              onPress={handleSave}
              disabled={createBatchMutation.isPending}
            >
              {String(t("admin.volunteerShiftComposerCreateCta"))}
            </Button>
          </XStack>
        </YStack>
      ) : null}

      {submitError ? (
        <Text variant="caption" tone="error">
          {submitError}
        </Text>
      ) : null}
    </ComposerCard>
  );
}

/**
 * "Time it from the event" — the anchor control on a concrete draft shift
 * (FR-017).
 *
 * The draft rows above hold absolute instants, which is what the API stores.
 * This control is how an organizer *expresses* one relative to the show —
 * "load-in, 3 hours before doors, lasting 2h30" — without doing the arithmetic
 * against a 14:00 matinee in their head. It resolves through the same
 * {@link resolveTemplateShift} the template-apply flow uses, so the composer
 * and the catalogue can never drift into two different readings of an anchor.
 *
 * It writes instants and then gets out of the way: the row's date-time inputs
 * stay the source of truth and remain editable afterwards. Collapsed by
 * default so the common case (type the times) is undisturbed.
 *
 * `WALL_CLOCK` is deliberately not offered — the row's own date-time fields
 * already are the clock-time mode.
 */
function AnchoredTimingControl({
  disabled,
  eventStartsAt,
  eventEndsAt,
  timeZone,
  testIdBase,
  onApply,
}: {
  disabled: boolean;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  timeZone: string;
  testIdBase: string;
  onApply: (startsAtIso: string, endsAtIso: string) => void;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  /**
   * Held HERE, above the collapse: Cancel unmounts `ShiftAnchorFields` while
   * this survives, so every part of the organizer's intent has to live on the
   * row — including `offsetDirection`, which the control writes back through
   * `onChange`. Seeding `offsetMinutes: "0"` leaves the sign carrying no
   * information, which is exactly why the direction cannot be re-derived from
   * it on reopen.
   */
  const [fields, setFields] = useState<ShiftDraftFields>(() => {
    const base = emptyShiftDraftFields();
    return {
      ...base,
      anchor: "EVENT_START",
      offsetMinutes: "0",
      // Two hours is a starting point, not a claim — the organizer sets the
      // real duration before applying, and the preview shows the result.
      ...withShiftDraftDurationMinutes(base, 120),
    };
  });

  const target: ShiftResolutionTarget = {
    timeZone,
    reference: eventStartsAt ?? new Date(),
    startsAt: eventStartsAt,
    endsAt: eventEndsAt,
  };

  const duration = shiftDraftDurationMinutes(fields);
  const resolved =
    duration === null
      ? null
      : resolveTemplateShift(
          {
            startMinuteOfDay: 0,
            endMinuteOfDay: duration % (24 * 60),
            startDayOffset: 0,
            endsNextDay: false,
            anchor: fields.anchor,
            offsetMinutes: Number(fields.offsetMinutes || "0"),
          },
          target,
        );

  if (!open) {
    return (
      <XStack>
        <Button
          variant="ghost"
          size="$2"
          onPress={() => setOpen(true)}
          disabled={disabled}
          data-testid={`${testIdBase}-anchor-open`}
        >
          <Clock size={14} aria-hidden />
          {String(t("admin.volunteerShiftAnchorComposerCta"))}
        </Button>
      </XStack>
    );
  }

  return (
    <YStack
      gap="$2"
      borderWidth={1}
      borderColor="$borderColor"
      backgroundColor="$surfaceMuted"
      padding="$3"
      data-testid={`${testIdBase}-anchor-panel`}
    >
      <ShiftAnchorFields
        fields={fields}
        onChange={(patch) => setFields((current) => ({ ...current, ...patch }))}
        disabled={disabled}
        testIdBase={testIdBase}
        anchorOptions={["EVENT_START", "EVENT_END"]}
      />

      <ShiftAnchorPreview
        fields={fields}
        previewTargets={[
          {
            id: "event",
            label: String(t("admin.volunteerShiftAnchorPreviewThisEvent")),
            target,
            alwaysShowDate: true,
          },
        ]}
        testIdBase={testIdBase}
      />

      {resolved && !resolved.ok ? (
        <Text
          variant="caption"
          tone="error"
          data-testid={`${testIdBase}-anchor-unavailable`}
        >
          {shiftAnchorUnavailableMessage(t, resolved.reason)}
        </Text>
      ) : null}

      <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap">
        <Button
          variant="ghost"
          size="$2"
          onPress={() => setOpen(false)}
          disabled={disabled}
        >
          {String(t("common.cancel"))}
        </Button>
        <Button
          variant="secondary"
          size="$2"
          onPress={() => {
            if (!resolved?.ok) return;
            onApply(resolved.startsAt, resolved.endsAt);
            setOpen(false);
          }}
          disabled={disabled || !resolved?.ok}
          data-testid={`${testIdBase}-anchor-apply`}
        >
          {String(t("admin.volunteerShiftAnchorComposerApply"))}
        </Button>
      </XStack>
    </YStack>
  );
}

/**
 * Inline "Repeat on next N days" control. Stays collapsed as a single
 * button until the user clicks it, then reveals a small numeric stepper
 * inline. Picked over a popover for accessibility (no focus traps) and
 * mobile-friendliness (no overlay clipping in scroll containers).
 */
function RepeatAcrossDaysControl({
  disabled,
  remaining,
  onRepeat,
  labels,
}: {
  disabled: boolean;
  /** Max additional rows we can still create within the global limit. */
  remaining: number;
  onRepeat: (days: number) => void;
  labels: { trigger: string; prompt: string; confirm: string; cancel: string };
}) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState("1");

  const cap = Math.max(0, remaining);
  const parsed = Number(days);
  const isValid = Number.isInteger(parsed) && parsed >= 1 && parsed <= cap;

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="$2"
        onPress={() => setOpen(true)}
        disabled={disabled || cap === 0}
      >
        <Copy size={14} aria-hidden />
        {labels.trigger}
      </Button>
    );
  }

  return (
    <XStack gap="$2" alignItems="center" flexWrap="wrap">
      <Text variant="caption">{labels.prompt}</Text>
      <TextInput
        value={days}
        onChangeText={setDays}
        inputMode="numeric"
        disabled={disabled}
        containerWidth={64}
        testId="volunteer-shift-repeat-days"
      />
      <Button
        variant="primary"
        size="$2"
        onPress={() => {
          if (!isValid) return;
          onRepeat(parsed);
          setOpen(false);
          setDays("1");
        }}
        disabled={disabled || !isValid}
      >
        {labels.confirm}
      </Button>
      <Button
        variant="ghost"
        size="$2"
        onPress={() => {
          setOpen(false);
          setDays("1");
        }}
        disabled={disabled}
      >
        {labels.cancel}
      </Button>
    </XStack>
  );
}
