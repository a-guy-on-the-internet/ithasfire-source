"use client";

/**
 * SaveTicketTypeTemplateDialog — captures the event's CURRENT ticket types as
 * a reusable, owner-scoped template (`ticketTypeTemplates.createTicketTypeTemplate`).
 *
 * The dialog is a thin write surface: the field mapping (drop event-specific
 * seating fields, trim + case-insensitively dedupe names) lives in the pure
 * `toTicketTypeTemplateEntries` helper so it stays unit-testable. A
 * TEMPLATE_NAME_TAKEN rejection renders as an inline field error (matching the
 * TemplateDialog idiom) instead of a toast, so the user can rename in place.
 */

import { useMemo, useState } from "react";
import { nanoid } from "nanoid";
import { YStack } from "tamagui";

import {
  Text,
  TextInput,
  Button,
  useNotify,
  useTranslations,
  useFormatters,
} from "@th/ui";

import { trpc } from "@/trpc";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";
import { fmtCurrency } from "@/lib/format";
import { buildTicketCardMeta } from "./TicketTypeEditor";
import { EventEditorSheet } from "./EventEditorSheet";
import {
  hasTimeBasedConfig,
  toTicketTypeTemplateEntries,
  type TicketTypeForTemplate,
} from "./ticket-type-template-helpers";
import type { TemplateOwnerRef } from "./TicketTypeTemplateControls";

export type SaveTicketTypeTemplateDialogProps = {
  owner: TemplateOwnerRef;
  ticketTypes: readonly TicketTypeForTemplate[];
  onClose: () => void;
};

export function SaveTicketTypeTemplateDialog({
  owner,
  ticketTypes,
  onClose,
}: SaveTicketTypeTemplateDialogProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const { gates } = useFeatureGates();
  const resaleEnabled = gates?.resale === true;

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  // Snapshot of what will be saved — trimmed, deduped, seating-free.
  const entries = useMemo(
    () => toTicketTypeTemplateEntries(ticketTypes),
    [ticketTypes],
  );

  /**
   * FR-011 round-trip: on-sale windows and scheduled price changes do NOT
   * travel with the template, because the ANCHOR they were meant against is
   * unrecoverable from a stored instant (see `toTicketTypeTemplateEntries`).
   * Declining is the safe half of that decision; saying so is the other half —
   * without this line the omission would be exactly the silent meaning-change
   * the decision exists to avoid.
   */
  const showsTimeNote = useMemo(
    () => hasTimeBasedConfig(ticketTypes),
    [ticketTypes],
  );

  const createMutation =
    trpc.ticketTypeTemplates.createTicketTypeTemplate.useMutation({
      retry: false,
      meta: { silent: true },
    });

  const formatPrice = (cents: number) =>
    cents === 0
      ? (t("admin.ttFree") as string)
      : fmtCurrency(fmt, cents, "usd");
  const capacityLabel = (capacity: number) =>
    String(t("admin.ttCapacityCount", { capacity }));

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || entries.length === 0 || createMutation.isPending) return;

    try {
      await createMutation.mutateAsync({
        ownerScope: owner.ownerScope,
        ownerId: owner.ownerId,
        name: trimmed,
        ticketTypes: entries,
        clientKey: nanoid(12),
      });
      void utils.ticketTypeTemplates.listTicketTypeTemplates.invalidate({
        ownerScope: owner.ownerScope,
        ownerId: owner.ownerId,
      });
      toast.success({
        id: "ticket-type-template-saved",
        title: t("admin.ttTplSavedTitle") as string,
        message: t("admin.ttTplSavedMessage", { name: trimmed }) as string,
      });
      onClose();
    } catch (error) {
      if (getAppErrorCode(error) === "TEMPLATE_NAME_TAKEN") {
        // Inline, next to the field — the user just needs a different name.
        setNameError(t("admin.ttTplNameTaken", { name: trimmed }) as string);
        return;
      }
      toast.danger({
        id: "ticket-type-template-save-failed",
        title: t("admin.ttTplSaveFailed") as string,
        message: formatErrorMessage(error, t),
      });
    }
  };

  const isSaving = createMutation.isPending;

  const footer = (
    <>
      <Button
        variant="ghost"
        size="$3"
        onPress={onClose}
        disabled={isSaving}
        data-testid="ticket-type-template-save-cancel"
      >
        {String(t("admin.ttCancel"))}
      </Button>
      <Button
        variant="primary"
        size="$3"
        onPress={() => {
          void handleSave();
        }}
        disabled={!name.trim() || entries.length === 0 || isSaving}
        data-testid="ticket-type-template-save-submit"
      >
        {isSaving
          ? String(t("admin.ttTplSaving"))
          : String(t("admin.ttTplSaveCta"))}
      </Button>
    </>
  );

  return (
    <EventEditorSheet
      open
      onClose={onClose}
      title={String(t("admin.ttTplSaveDialogTitle"))}
      subtitle={String(t("admin.ttTplSaveDialogSubtitle"))}
      footer={footer}
    >
      <YStack gap={16} data-testid="ticket-type-template-save-dialog">
        <YStack gap={4}>
          <Text
            variant="caption"
            tone="muted"
            style={{ textTransform: "uppercase" }}
          >
            {String(t("admin.ttTplNameLabel"))}
          </Text>
          <TextInput
            value={name}
            onChangeText={(v: string) => {
              setName(v);
              if (nameError) setNameError(null);
            }}
            placeholder={t("admin.ttTplNamePlaceholder") as string}
            maxLength={80}
            fullWidth
            autoFocus
            onSubmitEditing={() => {
              void handleSave();
            }}
            returnKeyType="done"
            testId="ticket-type-template-name"
          />
          {nameError ? (
            <Text
              variant="caption"
              tone="error"
              data-testid="ticket-type-template-name-error"
            >
              {nameError}
            </Text>
          ) : null}
        </YStack>

        {/* Read-only summary of what the template will contain. */}
        <YStack
          gap={10}
          padding={12}
          borderWidth={1}
          borderColor="$borderColor"
          backgroundColor="$surfaceMuted"
          data-testid="ticket-type-template-save-summary"
        >
          <Text variant="overline" tone="muted">
            {String(t("admin.ttTplSummaryLabel", { count: entries.length }))}
          </Text>
          {entries.map((entry) => (
            <YStack key={entry.name} gap={2}>
              <Text variant="bodySmall" weight="bold" color="$color">
                {entry.name}
              </Text>
              <Text variant="caption" tone="muted">
                {buildTicketCardMeta(entry, formatPrice, capacityLabel, {
                  resaleEnabled,
                })}
              </Text>
            </YStack>
          ))}
        </YStack>

        {showsTimeNote ? (
          <Text
            variant="caption"
            tone="muted"
            data-testid="ticket-type-template-time-note"
          >
            {String(t("admin.ttTplTimeNotCarriedNote"))}
          </Text>
        ) : null}
      </YStack>
    </EventEditorSheet>
  );
}
