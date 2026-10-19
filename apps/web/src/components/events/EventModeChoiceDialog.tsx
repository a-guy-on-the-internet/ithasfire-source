"use client";

import type { ReactNode } from "react";
import { styled, XStack, YStack } from "tamagui";
import { Ticket, Users } from "lucide-react";

import { Button, Modal, Text, useTranslations } from "@th/ui";

/**
 * "Ticketed event vs Community listing" mode choice, shown before draft
 * creation ONLY for verified community moderators (community-managed-event-
 * listings spec — the event builder's top-level mode choice, FR-005).
 *
 * Non-moderators never see this dialog: `useCreateDraftEvent` routes them
 * straight to today's draft flow.
 */
export type EventModeChoiceDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Today's flow: create a draft ticketed event and open the builder. */
  onTicketed: () => void;
  /** Navigate to the community-listing create form. */
  onCommunity: () => void;
  /** True while ticketed draft creation is in flight. */
  pending?: boolean;
};

/**
 * Strict-Swiss option tile: square, thick border, uppercase label. Renders
 * as a real `<button>` so keyboard focus/activation come for free.
 */
const OptionTile = styled(YStack, {
  tag: "button",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "transparent",
  paddingVertical: "$3",
  paddingHorizontal: "$4",
  gap: "$1",
  alignItems: "flex-start",
  minHeight: 72,
  width: "100%",
  cursor: "pointer",
  hoverStyle: {
    borderColor: "$accent",
    backgroundColor: "$backgroundHover",
  },
  focusStyle: {
    borderColor: "$accent",
  },
  pressStyle: {
    opacity: 0.9,
  },
  variants: {
    disabled: {
      true: {
        opacity: 0.5,
        cursor: "not-allowed",
      },
    },
  } as const,
});

function ModeOption({
  icon,
  label,
  hint,
  onPress,
  disabled,
  testId,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  onPress: () => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <OptionTile
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      data-testid={testId}
    >
      <XStack gap="$2" alignItems="center">
        {icon}
        <Text
          variant="bodySmall"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={1}
        >
          {label}
        </Text>
      </XStack>
      <Text variant="caption" tone="muted" textAlign="left">
        {hint}
      </Text>
    </OptionTile>
  );
}

export function EventModeChoiceDialog({
  open,
  onClose,
  onTicketed,
  onCommunity,
  pending,
}: EventModeChoiceDialogProps) {
  const t = useTranslations();

  return (
    <Modal open={open} onClose={onClose}>
      <Modal.Panel width={480}>
        <Modal.Header
          title={String(t("communityCreate.modeDialogTitle"))}
          onClose={onClose}
        />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="bodySmall" tone="muted">
              {String(t("communityCreate.modeDialogSubtitle"))}
            </Text>
            <ModeOption
              icon={<Ticket size={16} aria-hidden />}
              label={String(t("communityCreate.modeTicketedLabel"))}
              hint={String(t("communityCreate.modeTicketedHint"))}
              onPress={onTicketed}
              disabled={pending}
              testId="event-mode-choice-ticketed"
            />
            <ModeOption
              icon={<Users size={16} aria-hidden />}
              label={String(t("communityCreate.modeCommunityLabel"))}
              // …HintDraft, not …Hint: since the builder took over community
              // authoring, choosing this mints a DRAFT and opens the editor.
              // The old copy promised it published immediately.
              hint={String(t("communityCreate.modeCommunityHintDraft"))}
              onPress={onCommunity}
              disabled={pending}
              testId="event-mode-choice-community"
            />
          </YStack>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onPress={onClose} disabled={pending}>
            {String(t("communityCreate.modeCancel"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

EventModeChoiceDialog.displayName = "EventModeChoiceDialog";
