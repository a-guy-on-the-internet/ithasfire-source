"use client";

import { XStack, YStack } from "tamagui";

import {
  Button,
  Checkbox,
  Modal,
  Radio,
  RadioGroupField,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";

import {
  offersArrivalAreaSync,
  type SeriesEditScope,
} from "./series-scope-helpers";

export type SeriesEditScopeDialogProps = {
  open: boolean;
  /**
   * Mono "FRI JUL 31" label of the show being saved, formatted in the EVENT
   * timezone from the current form value (the date the save will write),
   * falling back to the stored start when the form field is empty.
   */
  dateLabel: string;
  value: SeriesEditScope;
  /** Busy through the whole save + draft-propagation round trip. */
  saving: boolean;
  onChange: (scope: SeriesEditScope) => void;
  /** The `arrivalAreas` feature gate; off hides the areas checkbox. */
  arrivalAreasGateOn?: boolean;
  /** "Also replace parking and drop-off areas on these shows". Unticked by default. */
  includeArrivalAreas?: boolean;
  onIncludeArrivalAreasChange?: (next: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * Pre-save scope dialog for events that already belong to a series (recurring-
 * series redesign Phase 3 — the canonical Google-style "this / following /
 * all" chooser). It governs ONLY the propagation of the event's own definition
 * fields onto sibling drafts; repeat-schedule changes always apply series-wide
 * regardless of the choice (the inline note says so).
 */
export function SeriesEditScopeDialog({
  open,
  dateLabel,
  value,
  saving,
  onChange,
  arrivalAreasGateOn = false,
  includeArrivalAreas = false,
  onIncludeArrivalAreasChange,
  onCancel,
  onConfirm,
}: SeriesEditScopeDialogProps) {
  const t = useTranslations();

  return (
    <Modal open={open} onClose={saving ? () => {} : onCancel}>
      <Modal.Panel width={480}>
        {/* Hide the X while saving — closing mid-flight would silently drop a
            later failure. Overlay/Esc are guarded the same way (SkipDateDialog
            pattern). */}
        <Modal.Header
          title={String(t("admin.ebScopeDialogTitle"))}
          onClose={saving ? undefined : onCancel}
        />
        <Modal.Body>
          <YStack gap="$3">
            <RadioGroupField
              value={value}
              onValueChange={(next: string) =>
                onChange(next as SeriesEditScope)
              }
              aria-label={String(t("admin.ebScopeDialogTitle"))}
            >
              <YStack gap="$3">
                <Radio
                  value="this"
                  testIdBase="eb-scope-this"
                  disabled={saving}
                  label={String(t("admin.ebScopeThisLabel"))}
                  description={String(
                    t("admin.ebScopeThisDesc", { date: dateLabel }),
                  )}
                />
                <Radio
                  value="following"
                  testIdBase="eb-scope-following"
                  disabled={saving}
                  label={String(t("admin.ebScopeFollowingLabel"))}
                  description={String(t("admin.ebScopeFollowingDesc"))}
                />
                <Radio
                  value="all"
                  testIdBase="eb-scope-all"
                  disabled={saving}
                  label={String(t("admin.ebScopeAllLabel"))}
                  description={String(t("admin.ebScopeAllDesc"))}
                />
              </YStack>
            </RadioGroupField>
            {/* Arrival areas are their own opt-in (owner ruling Q13): a sync
                that replaced a sibling's parking without asking would undo
                per-show edits. Only for the scopes that sync at all. The row
                is 44px tall; the label is a real <label> for the box. */}
            {offersArrivalAreaSync(value, arrivalAreasGateOn) && (
              <XStack minHeight={44} alignItems="center">
                <Checkbox
                  id="eb-scope-include-arrival-areas"
                  testIdBase="eb-scope-include-arrival-areas"
                  label={String(t("admin.ebScopeIncludeArrivalAreas"))}
                  checked={includeArrivalAreas}
                  disabled={saving}
                  onCheckedChange={(checked) =>
                    onIncludeArrivalAreasChange?.(checked === true)
                  }
                />
              </XStack>
            )}
            {/* The dialog is only about the event's own details — never let it
                read as if it also scopes the repeat schedule. */}
            <Text variant="caption" tone="muted">
              {String(t("admin.ebScopeScheduleNote"))}
            </Text>
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outlined"
            size="$3"
            onPress={onCancel}
            disabled={saving}
            data-testid="eb-scope-cancel"
          >
            {String(t("common.cancel"))}
          </Button>
          <Button
            variant="primary"
            size="$3"
            onPress={onConfirm}
            disabled={saving}
            data-testid="eb-scope-save"
          >
            {saving && (
              <Spinner
                width={14}
                height={14}
                borderWidth={2}
                style={{ marginRight: 6 }}
              />
            )}
            {String(t(saving ? "admin.ebSaving" : "common.save"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

SeriesEditScopeDialog.displayName = "SeriesEditScopeDialog";
