"use client";

import { useId, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Text, Switch, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

export interface CommunityReviewsToggleProps {
  placeId: string;
  initialEnabled: boolean;
  /**
   * `place.viewerCanManageSwitches` from `places.getPlaceForEdit`. REQUIRED,
   * and a prop rather than a query: this component is rendered inside the page
   * editor, which already holds that read — a second subscription here would
   * buy nothing but another cache key to keep in step.
   */
  canManage: boolean;
  /**
   * Drop the standalone bordered card so the control sits cleanly as a
   * subsection inside the Page Settings drawer (no nested cards).
   */
  embedded?: boolean;
}

/**
 * The PERFORMER-review switch (venue-track-record-and-review-switch R1/FR-007,
 * the reversal of 2026-07-23 FR-007). Flips `Place.communityReviewsEnabled`
 * via `places.setCommunityReviewsEnabled`; the actor is injected server-side,
 * so we only send `{ placeId, enabled }`.
 *
 * OFF refuses new performer submissions and hides every public performer
 * surface (the `venue_stats` block, the request-to-play stats clauses).
 * Nothing is deleted: reviews already written stay readable to the owner —
 * the off-state help line says so, because "turn it off" reads as "throw
 * them away" otherwise. Attendee reviews and the track record are separate
 * and unaffected.
 *
 * The authority gate is the one the other place switches carry: a direct
 * human owner or an org OWNER/ADMIN. The page around this control loads for
 * any org member, so without `canManage` a VIEWER would see a live switch,
 * flip nothing, and get a toast.
 */
export function CommunityReviewsToggle({
  placeId,
  initialEnabled,
  canManage,
  embedded = false,
}: CommunityReviewsToggleProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const [enabled, setEnabled] = useState(initialEnabled);

  const mutation = trpc.places.setCommunityReviewsEnabled.useMutation({
    onSuccess: (result) => {
      setEnabled(result.communityReviewsEnabled);
      void utils.places.getPlaceForEdit.invalidate({ placeId });
    },
    onError: (err, variables) => {
      // Revert the optimistic flip.
      setEnabled(!variables.enabled);
      toast.danger({
        id: "community-reviews-failed",
        title: String(t("admin.peCommunityReviewsUpdateFailed")),
        // `t` is load-bearing, not decoration: without the translator the
        // dictionary inside `formatErrorMessage` has no NOT_RESOURCE_OWNER
        // key and this switch's own refusal renders as "Something went
        // wrong." The i18n path resolves `errors.notResourceOwner`.
        message: formatErrorMessage(err, t),
      });
    },
  });

  const handleChange = (next: boolean) => {
    if (!canManage) return;
    setEnabled(next); // optimistic
    mutation.mutate({ placeId, enabled: next });
  };

  /**
   * Same wiring as the sibling switches: the helper line DESCRIBES the control
   * while it is locked, so a dimmed switch announces why. The reason is a
   * description, not part of the name — the name stays the title.
   */
  const fieldId = useId();
  const helpId = `${fieldId}-help`;

  // ONE line at a time in the helper slot: the refusal replaces the state
  // description, and the state description says what the CURRENT position
  // means — on: reviews come in and show; off: none come in, existing stay.
  const helpKey = !canManage
    ? "admin.placeSwitchNoPermission"
    : enabled
      ? "admin.peCommunityReviewsHelpOn"
      : "admin.peCommunityReviewsHelpOff";

  const row = (
    <XStack gap="$4" alignItems="center" justifyContent="space-between">
      <YStack gap="$1" flex={1}>
        <Text variant={embedded ? "body" : "h4"} weight="bold">
          {String(t("admin.peCommunityReviewsTitle"))}
        </Text>
        <Text
          variant="bodySmall"
          tone="muted"
          id={helpId}
          testId="community-reviews-help"
        >
          {String(t(helpKey))}
        </Text>
      </YStack>
      <Switch
        checked={enabled}
        onCheckedChange={handleChange}
        disabled={!canManage}
        saving={mutation.isPending}
        aria-label={String(t("admin.peCommunityReviewsTitle"))}
        aria-describedby={helpId}
        testId="community-reviews-switch"
      />
    </XStack>
  );

  if (embedded) {
    return row;
  }

  return (
    <YStack
      padding="$4"
      gap="$3"
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      backgroundColor="$surface"
    >
      {row}
    </YStack>
  );
}
