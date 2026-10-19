"use client";

/**
 * The shift-preset editor inside the staff pack editor.
 *
 * The anchor control is NOT re-implemented here: it imports the organizer's
 * {@link ShiftAnchorFields} / {@link ShiftAnchorPreview} verbatim (FR-017 —
 * "the same editor component serves the staff pack editor"). A second
 * implementation would let a catalogue preset mean one thing when curated and
 * another when applied, which is the exact class of bug the anchor exists to
 * kill.
 *
 * The one field this editor adds is `notes` — the admin-only preset note that
 * rides onto every materialized shift. It has to be here rather than left out:
 * `upsertVolunteerPack` reconciles shifts as a REPLACE-SET (`notes: shift.notes
 * ?? null`), so an editor that never read the column would silently wipe a
 * seeded note on the first typo fix.
 */

import { XStack, YStack } from "tamagui";
import { Button, Text, TextInput, Tooltip, useTranslations } from "@th/ui";
import { Plus, Trash2 } from "lucide-react";

import {
  ShiftAnchorFields,
  ShiftAnchorPreview,
  useSampleShowtimeTargets,
} from "@/components/volunteering/ShiftAnchorFields";
import type { ShiftDraftFields } from "@/lib/template-shift-offset";

/** A pack shift draft: the shared editor shape plus the staff-only note. */
export type PackShiftDraft = ShiftDraftFields & { notes: string };

/** Mirrors `volunteerPackRoleInputSchema.shifts.max(25)`. */
export const MAX_PACK_ROLE_SHIFTS = 25;

const NATIVE_TIME_STYLE: React.CSSProperties = {
  height: 40,
  padding: "0 12px",
  border: "1px solid var(--borderColor, #211C16)",
  borderRadius: 0,
  backgroundColor: "var(--surface, #FDFAF3)",
  color: "var(--color, #211C16)",
  fontFamily: "inherit",
  fontSize: 14,
  width: "100%",
  boxSizing: "border-box",
};

const NATIVE_SELECT_STYLE: React.CSSProperties = NATIVE_TIME_STYLE;

export function PackShiftsEditor({
  shifts,
  onChange,
  disabled,
  testIdBase,
}: {
  shifts: PackShiftDraft[];
  onChange: (next: PackShiftDraft[]) => void;
  disabled?: boolean;
  testIdBase: string;
}) {
  const t = useTranslations();
  // Two CONTRASTING showtimes: a preset anchored "3 hours before the show"
  // reads 5:00 PM against one and 11:00 AM against the other. Seeing both is
  // the only way a curator catches a wrong anchor before it ships platform-wide.
  const previewTargets = useSampleShowtimeTargets();

  const updateShift = (index: number, patch: Partial<PackShiftDraft>) => {
    onChange(shifts.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  return (
    <YStack gap="$2">
      <XStack
        justifyContent="space-between"
        alignItems="center"
        gap="$2"
        flexWrap="wrap"
      >
        <Text variant="label">
          {String(t("admin.volunteerTemplateShiftsLabel"))}
        </Text>
        <Button
          variant="secondary"
          size="$2"
          onPress={() => onChange([...shifts, emptyPackShiftDraft()])}
          disabled={disabled || shifts.length >= MAX_PACK_ROLE_SHIFTS}
          data-testid={`${testIdBase}-add-shift`}
        >
          <Plus size={14} aria-hidden />
          {String(t("admin.volunteerTemplateShiftAddCta"))}
        </Button>
      </XStack>

      {shifts.length === 0 ? (
        <Text variant="caption" tone="muted">
          {String(t("admin.volunteerPackShiftsEmpty"))}
        </Text>
      ) : (
        <YStack gap="$3">
          {shifts.map((shift, index) => (
            <YStack
              key={shift.id}
              gap="$2"
              borderWidth={1}
              borderColor="$borderColor"
              backgroundColor="$surface"
              padding="$3"
              data-testid={`${testIdBase}-shift-${index}`}
            >
              <XStack gap="$2" alignItems="flex-end" flexWrap="wrap">
                <YStack flex={1} minWidth={180} gap="$1">
                  <Text variant="label">
                    {String(t("admin.volunteerTemplateShiftFieldLabelLabel"))}
                  </Text>
                  <TextInput
                    value={shift.label}
                    onChangeText={(value) =>
                      updateShift(index, { label: value })
                    }
                    placeholder={String(
                      t("admin.volunteerTemplateShiftFieldLabelPlaceholder"),
                    )}
                    maxLength={120}
                    disabled={disabled}
                    fullWidth
                    // `Text variant="label"` is a <span>, not a <label htmlFor>,
                    // so without this the box is unlabelled to a screen reader.
                    // The native <select> / <input type="time"> below and every
                    // numeric box in `ShiftAnchorFields` already do this.
                    aria-label={String(
                      t("admin.volunteerTemplateShiftFieldLabelLabel"),
                    )}
                    testId={`${testIdBase}-shift-${index}-label`}
                  />
                </YStack>
                <Tooltip
                  anchor={
                    <Button
                      variant="ghost"
                      size="$2"
                      onPress={() =>
                        onChange(shifts.filter((_, i) => i !== index))
                      }
                      disabled={disabled}
                      aria-label={String(
                        t("admin.volunteerTemplateShiftRemoveCta"),
                      )}
                      data-testid={`${testIdBase}-shift-${index}-remove`}
                    >
                      <Trash2 size={14} />
                    </Button>
                  }
                  placement="top"
                >
                  {String(t("admin.volunteerTemplateShiftRemoveCta"))}
                </Tooltip>
              </XStack>

              <ShiftAnchorFields
                fields={shift}
                onChange={(patch) => updateShift(index, patch)}
                disabled={disabled}
                testIdBase={`${testIdBase}-shift-${index}`}
              />

              <XStack gap="$3" flexWrap="wrap">
                {/*
                  The clock fields only mean anything on a WALL_CLOCK preset.
                  On an anchored one they carry the DURATION, which the "Lasts"
                  control above edits — showing both would be two controls
                  writing the same two columns.
                */}
                {(shift.anchor ?? "WALL_CLOCK") === "WALL_CLOCK" ? (
                  <>
                    <YStack width={140} minWidth={140} gap="$1">
                      <Text variant="label">
                        {String(t("admin.volunteerTemplateShiftStartLabel"))}
                      </Text>
                      <input
                        type="time"
                        aria-label={String(
                          t("admin.volunteerTemplateShiftStartLabel"),
                        )}
                        value={shift.startTime}
                        onChange={(e) =>
                          updateShift(index, { startTime: e.target.value })
                        }
                        disabled={disabled}
                        data-testid={`${testIdBase}-shift-${index}-start`}
                        style={NATIVE_TIME_STYLE}
                      />
                    </YStack>
                    <YStack width={140} minWidth={140} gap="$1">
                      <Text variant="label">
                        {String(t("admin.volunteerTemplateShiftEndLabel"))}
                      </Text>
                      <input
                        type="time"
                        aria-label={String(
                          t("admin.volunteerTemplateShiftEndLabel"),
                        )}
                        value={shift.endTime}
                        onChange={(e) =>
                          updateShift(index, { endTime: e.target.value })
                        }
                        disabled={disabled}
                        data-testid={`${testIdBase}-shift-${index}-end`}
                        style={NATIVE_TIME_STYLE}
                      />
                    </YStack>
                  </>
                ) : null}
                <YStack width={180} minWidth={180} gap="$1">
                  <Text variant="label">
                    {String(t("admin.volunteerTemplateShiftDayLabel"))}
                  </Text>
                  <select
                    value={shift.dayOffset}
                    onChange={(e) =>
                      updateShift(index, { dayOffset: e.target.value })
                    }
                    disabled={disabled}
                    aria-label={String(
                      t("admin.volunteerTemplateShiftDayLabel"),
                    )}
                    data-testid={`${testIdBase}-shift-${index}-day`}
                    style={NATIVE_SELECT_STYLE}
                  >
                    <option value="-2">
                      {String(t("admin.volunteerTemplateShiftDayMinus2"))}
                    </option>
                    <option value="-1">
                      {String(t("admin.volunteerTemplateShiftDayMinus1"))}
                    </option>
                    <option value="0">
                      {String(t("admin.volunteerTemplateShiftDayZero"))}
                    </option>
                    <option value="1">
                      {String(t("admin.volunteerTemplateShiftDayPlus1"))}
                    </option>
                    <option value="2">
                      {String(t("admin.volunteerTemplateShiftDayPlus2"))}
                    </option>
                  </select>
                </YStack>
                <YStack width={140} minWidth={140} gap="$1">
                  <Text variant="label">
                    {String(t("admin.volunteerTemplateShiftCapacityLabel"))}
                  </Text>
                  <TextInput
                    value={shift.capacity}
                    onChangeText={(value) =>
                      updateShift(index, { capacity: value })
                    }
                    placeholder={String(
                      t("admin.volunteerTemplateShiftCapacityPlaceholder"),
                    )}
                    inputMode="numeric"
                    disabled={disabled}
                    fullWidth
                    aria-label={String(
                      t("admin.volunteerTemplateShiftCapacityLabel"),
                    )}
                    testId={`${testIdBase}-shift-${index}-capacity`}
                  />
                </YStack>
              </XStack>

              <YStack gap="$1">
                <Text variant="label">
                  {String(t("admin.volunteerPackShiftNotesLabel"))}
                </Text>
                <TextInput
                  value={shift.notes}
                  onChangeText={(value) => updateShift(index, { notes: value })}
                  placeholder={String(
                    t("admin.volunteerPackShiftNotesPlaceholder"),
                  )}
                  maxLength={2000}
                  disabled={disabled}
                  fullWidth
                  aria-label={String(t("admin.volunteerPackShiftNotesLabel"))}
                  testId={`${testIdBase}-shift-${index}-notes`}
                />
              </YStack>

              <ShiftAnchorPreview
                fields={shift}
                previewTargets={previewTargets}
                testIdBase={`${testIdBase}-shift-${index}`}
              />
            </YStack>
          ))}
        </YStack>
      )}
    </YStack>
  );
}

const newDraftId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `pack-shift-${Math.random().toString(36).slice(2, 10)}`;

export function emptyPackShiftDraft(): PackShiftDraft {
  return {
    id: newDraftId(),
    label: "",
    startTime: "",
    endTime: "",
    dayOffset: "0",
    capacity: "",
    anchor: "WALL_CLOCK",
    offsetMinutes: "0",
    notes: "",
  };
}
