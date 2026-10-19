"use client";

import { memo } from "react";
import { YStack } from "tamagui";

import { Button, Modal, Text, useTranslations } from "@th/ui";

/**
 * The confirm a moderator sees before saving a SCHEDULE or VENUE change to a
 * PUBLISHED community listing — and only then.
 *
 * ## Why this exists and a plain "Are you sure?" would not
 *
 * A live save has two different costs and they are not the same size. Fixing a
 * typo republishes a page. Moving the date or the address ALSO writes an
 * FR-013 change notice, which the drain fans out as an email and an in-app
 * notification to everyone who RSVP'd to or saved the listing. That second
 * thing is irreversible in the only way that matters — you cannot un-mail it —
 * and nothing else in the builder tells the moderator it is about to happen.
 *
 * So the dialog's whole job is to name the specific fact: WHICH group moved,
 * from WHAT to WHAT, and WHO hears about it. A confirmation that only asks
 * "are you sure?" adds a click and no information, and the moderator learns to
 * clear it without reading.
 *
 * It is deliberately NOT shown on a non-material save. A speed bump in front
 * of every title fix is a speed bump the reader stops seeing, which would cost
 * this dialog the one moment it is for.
 *
 * ## What it does not claim
 *
 * No recipient count. The builder has no cheap read for "how many people
 * RSVP'd or saved this", and a number invented here would be the most
 * believable thing on screen. The audience is named by its definition instead.
 *
 * Strict Swiss throughout: square, 2px rules, the mono label idiom on the
 * group names, ink on paper. No danger tone — this is a legitimate edit, not a
 * mistake, and tinting it red would teach the moderator that a reschedule is
 * an error.
 */

/**
 * `auto 1fr`: the mono tag column is as wide as the wider tag, the value
 * column takes the rest and wraps inside the panel at 320px.
 */
const CHANGE_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  columnGap: 12,
  rowGap: 4,
  alignItems: "baseline",
  minWidth: 0,
} as const;

export type CommunityLiveSaveChange = {
  /** Stored value, already formatted. */
  from: string;
  /** Pending value, already formatted. */
  to: string;
};

export type CommunityLiveSaveDialogProps = {
  open: boolean;
  saving: boolean;
  /** Present when this save moves startsAt / endsAt. */
  schedule: CommunityLiveSaveChange | null;
  /** Present when this save moves the address or the pin. */
  venue: CommunityLiveSaveChange | null;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * One moved group: what it is, what it was, what it becomes, and who hears.
 *
 * The before/after are LABELLED ("Now" / "After saving") rather than drawn as
 * a strikethrough and an arrow. Two reasons: a strikethrough says "deleted" to
 * a screen reader and nothing at all to one that ignores decoration, and two
 * full street addresses joined by an arrow reflow into an unreadable run at
 * 320px. Each value gets its own line, its own mono tag, and room to wrap.
 */
function ChangeRow({
  label,
  notice,
  change,
  nowLabel,
  afterLabel,
  testId,
}: {
  label: string;
  notice: string;
  change: CommunityLiveSaveChange;
  nowLabel: string;
  afterLabel: string;
  testId: string;
}) {
  return (
    <YStack
      data-testid={testId}
      gap="$2"
      padding="$3"
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      backgroundColor="$surfaceMuted"
    >
      <Text variant="overline">{label}</Text>
      {/* GRID, not two flex rows: the two values have to start at the same x,
          and the tag column has to size itself to the wider of two localized
          labels ("After saving" / "Al guardar") rather than to a px guess. */}
      <div style={CHANGE_GRID_STYLE}>
        <Text variant="overline" tone="muted">
          {nowLabel}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {change.from}
        </Text>
        <Text variant="overline">{afterLabel}</Text>
        <Text variant="body" weight="semibold">
          {change.to}
        </Text>
      </div>
      <Text variant="bodySmall" tone="muted">
        {notice}
      </Text>
    </YStack>
  );
}

function CommunityLiveSaveDialogImpl({
  open,
  saving,
  schedule,
  venue,
  onCancel,
  onConfirm,
}: CommunityLiveSaveDialogProps) {
  const t = useTranslations();
  const nowLabel = String(t("communityBuilder.liveSaveNow"));
  const afterLabel = String(t("communityBuilder.liveSaveAfter"));

  return (
    <Modal open={open} onClose={onCancel}>
      <Modal.Panel width={520} data-testid="community-live-save-dialog">
        <Modal.Header
          title={String(t("communityBuilder.liveSaveTitle"))}
          onClose={onCancel}
        />
        <Modal.Body>
          <YStack gap="$3">
            <Text variant="body">
              {String(t("communityBuilder.liveSaveLead"))}
            </Text>
            {schedule && (
              <ChangeRow
                testId="community-live-save-schedule"
                label={String(t("communityBuilder.liveSaveScheduleLabel"))}
                notice={String(t("communityBuilder.liveSaveScheduleNotice"))}
                nowLabel={nowLabel}
                afterLabel={afterLabel}
                change={schedule}
              />
            )}
            {venue && (
              <ChangeRow
                testId="community-live-save-venue"
                label={String(t("communityBuilder.liveSaveVenueLabel"))}
                notice={String(t("communityBuilder.liveSaveVenueNotice"))}
                nowLabel={nowLabel}
                afterLabel={afterLabel}
                change={venue}
              />
            )}
            {schedule && venue && (
              <Text variant="bodySmall" tone="muted">
                {String(t("communityBuilder.liveSaveBothNote"))}
              </Text>
            )}
          </YStack>
        </Modal.Body>
        {/* The buttons are DIRECT children of the footer: it already wraps
            them (`flexWrap`) for long localized labels, and an extra flex
            wrapper around them re-established a single unbreakable row that
            overflowed the panel to the left at 320px. */}
        <Modal.Footer>
          <Button
            variant="ghost"
            // $4 = 44px, the touch minimum. The default $3 (36px) is under it,
            // and this dialog's two actions are the last thing between the
            // moderator and an email to every RSVPer.
            size="$4"
            onPress={onCancel}
            disabled={saving}
            data-testid="community-live-save-cancel"
          >
            {String(t("communityBuilder.liveSaveCancel"))}
          </Button>
          <Button
            variant="primary"
            size="$4"
            onPress={onConfirm}
            disabled={saving}
            data-testid="community-live-save-confirm"
          >
            {saving
              ? String(t("pageActions.saving"))
              : String(t("communityBuilder.liveSaveConfirm"))}
          </Button>
        </Modal.Footer>
      </Modal.Panel>
    </Modal>
  );
}

export const CommunityLiveSaveDialog = memo(CommunityLiveSaveDialogImpl);

CommunityLiveSaveDialog.displayName = "CommunityLiveSaveDialog";
