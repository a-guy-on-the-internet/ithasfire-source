"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  Modal,
  Spinner,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

import { CalendarHoursEditor } from "./CalendarHoursEditor";
import {
  HOURS_PRESETS,
  presetUpsertFields,
  setupScope,
  shouldOfferPresets,
  type HoursPreset,
  type HoursPresetId,
} from "./availability-setup-helpers";

export interface SetHoursModalProps {
  placeId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * "Set your hours" — the fix, one click away from the place the mistake is
 * made (availability-onboarding spec, FR-002).
 *
 * Embeds the EXISTING `CalendarHoursEditor` — the same commits-on-blur,
 * full-PUT editor the calendars page mounts — rather than forking a second
 * hours surface that could drift. The modal's only additions are:
 *
 *  - SCOPE RESOLUTION: it opens on the place's default calendar when the
 *    detector reports one, else the place-wide `null` scope (one row set that
 *    covers every calendar).
 *  - PRESETS, only while unconfigured. Each preset seeds rows through
 *    `places.upsertCalendarAvailability` — the editor's own write path — and
 *    the seeded rows appear in the editor below immediately. Once ANY row
 *    exists the presets unmount: a preset that replaced a venue's real hours
 *    would be a data-loss bug, so "rows exist" is the end of preset land.
 *
 * Every availability write invalidates `places.getAvailabilitySetupState`
 * (the editors do this themselves — see their `refresh`), so the FR-001
 * warning under the booking toggle drops the moment rows exist, no reload.
 * Focus: the shared Modal moves focus into the panel on open and restores it
 * to the opener on close.
 */
export function SetHoursModal({ placeId, open, onClose }: SetHoursModalProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const enabled = open && Boolean(placeId);
  const setupQuery = trpc.places.getAvailabilitySetupState.useQuery(
    { placeId },
    { enabled },
  );
  // Only for the default calendar's visible name — the detector carries the id.
  const calendarsQuery = trpc.places.listCalendars.useQuery(
    { placeId },
    { enabled },
  );

  const setup = setupQuery.data;
  const scope = setupScope(setup);
  const scopeLabel =
    (scope !== null &&
      calendarsQuery.data?.find((c) => c.id === scope)?.name) ||
    String(t("admin.calMgrScopeAll"));

  /** Which preset is mid-write; all preset buttons disable while one runs. */
  const [applyingId, setApplyingId] = useState<HoursPresetId | null>(null);

  const upsert = trpc.places.upsertCalendarAvailability.useMutation();

  const applyPreset = async (preset: HoursPreset) => {
    if (applyingId !== null) return;
    setApplyingId(preset.id);
    try {
      // Sequential on purpose: a handful of rows, and a deterministic order
      // beats racing seven writes against per-row validation.
      for (const fields of presetUpsertFields(preset, scope)) {
        await upsert.mutateAsync({ placeId, ...fields });
      }
    } catch (err) {
      // Partial writes are NOT rolled back — whatever landed is real and shows
      // in the editor below, which is the honest recovery surface.
      toast.danger({
        id: "calendar-hours-preset-failed",
        title: String(t("admin.calHoursPresetFailed")),
        message: formatErrorMessage(err, t),
      });
    } finally {
      // Both reads move together: the editor's rows AND the detector every
      // surface (FR-001 warning included) hangs off.
      await Promise.all([
        utils.places.listCalendarAvailability.invalidate({ placeId }),
        utils.places.getAvailabilitySetupState.invalidate({ placeId }),
      ]);
      setApplyingId(null);
      // A successful preset flips the detector to configured, which unmounts
      // the preset block — including the button that held focus. Reseat focus
      // on the dialog panel so Tab cannot silently walk out of the modal.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body) {
          document
            .querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
            ?.focus();
        }
      });
    }
  };

  const isPending = setupQuery.isPending || calendarsQuery.isPending;

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel width={680}>
        <Modal.Header
          title={String(t("admin.calHoursModalTitle"))}
          subtitle={String(t("admin.calHoursModalSubtitle"))}
          onClose={onClose}
        />
        <Modal.Body>
          {isPending ? (
            <XStack paddingVertical="$6" justifyContent="center">
              <Spinner size="sm" />
            </XStack>
          ) : setupQuery.error ? (
            /* Same posture as the editor's own failed read: no live controls
               over a state we cannot vouch for. */
            <YStack gap="$3">
              <Text variant="body" tone="error">
                {formatErrorMessage(setupQuery.error, t)}
              </Text>
              <XStack>
                <Button
                  variant="secondary"
                  size="$2"
                  onPress={() => void setupQuery.refetch()}
                >
                  {String(t("admin.placesRetry"))}
                </Button>
              </XStack>
            </YStack>
          ) : (
            <YStack gap="$5">
              {shouldOfferPresets(setup) && (
                <YStack
                  gap="$3"
                  padding="$4"
                  borderWidth={2}
                  borderColor="$borderColor"
                  backgroundColor="$surfaceRaised"
                  testID="hours-presets"
                >
                  <YStack gap="$1">
                    <Text variant="overline">
                      {String(t("admin.calHoursPresetsTitle"))}
                    </Text>
                    <Text variant="bodySmall" tone="muted">
                      {String(t("admin.calHoursPresetsHelp"))}
                    </Text>
                  </YStack>
                  <YStack gap="$2">
                    {HOURS_PRESETS.map((preset) => (
                      <XStack
                        key={preset.id}
                        gap="$3"
                        alignItems="center"
                        flexWrap="wrap"
                      >
                        <Button
                          variant="secondary"
                          // $4 = 44px — touch floor for the modal's main act.
                          size="$4"
                          disabled={applyingId !== null}
                          onPress={() => void applyPreset(preset)}
                          testID={`hours-preset-${preset.id}`}
                          aria-label={String(
                            t("admin.calHoursPresetApplyAria", {
                              label: String(t(preset.labelKey)),
                              start: preset.startTime,
                              end: preset.endTime,
                            }),
                          )}
                        >
                          {String(t(preset.labelKey))}
                        </Button>
                        {/* The window itself, in the editor's own 24h idiom,
                            so "evenings" is a checkable claim, not a vibe. */}
                        <Text variant="overline" tone="muted">
                          {preset.startTime}–{preset.endTime}
                        </Text>
                        {applyingId === preset.id && <Spinner size="sm" />}
                      </XStack>
                    ))}
                  </YStack>
                </YStack>
              )}

              <CalendarHoursEditor
                placeId={placeId}
                scope={scope}
                scopeLabel={scopeLabel}
              />
            </YStack>
          )}
        </Modal.Body>
      </Modal.Panel>
    </Modal>
  );
}
