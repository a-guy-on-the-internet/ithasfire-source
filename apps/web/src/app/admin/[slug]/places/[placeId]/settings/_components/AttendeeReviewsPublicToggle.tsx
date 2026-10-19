"use client";

import { useId, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Text, Switch, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

export interface AttendeeReviewsPublicToggleProps {
  placeId: string;
  initialIsPublic: boolean;
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
 * Owner opt-in that publishes the ATTENDEE rating summary on the public venue
 * page (venue-rating-block-and-owner-optin FR-004). Flips
 * `Place.attendeeReviewsPublic` via `places.setAttendeeReviewsPublic`; the actor
 * is injected server-side, so we only send `{ placeId, isPublic }`.
 *
 * Unlike the booking toggle there is NO verification gate — an owner may publish
 * or hide their attendee aggregate at any time. Off by default: attendee
 * feedback stays private until the owner publishes it. Performer stats are a
 * separate, owner-uncontrollable surface and are unaffected (FR-007).
 *
 * There IS an authority gate, and it is the same one the two booking switches
 * carry: a direct human owner or an org OWNER/ADMIN. The page around this
 * control loads for any org member, so without `canManage` a VIEWER saw a live
 * switch, published nothing, and got a toast. With no verification case to
 * collide with, this is the only reason the control is ever disabled.
 */
export function AttendeeReviewsPublicToggle({
  placeId,
  initialIsPublic,
  canManage,
  embedded = false,
}: AttendeeReviewsPublicToggleProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const [isPublic, setIsPublic] = useState(initialIsPublic);

  const mutation = trpc.places.setAttendeeReviewsPublic.useMutation({
    onSuccess: (result) => {
      setIsPublic(result.attendeeReviewsPublic);
      void utils.places.getPlaceForEdit.invalidate({ placeId });
    },
    onError: (err, variables) => {
      // Revert the optimistic flip.
      setIsPublic(!variables.isPublic);
      toast.danger({
        id: "attendee-reviews-public-failed",
        title: String(t("admin.peAttendeeReviewsPublicUpdateFailed")),
        // `t` is load-bearing, not decoration: the dictionary inside
        // `formatErrorMessage` is case-sensitive and has no NOT_RESOURCE_OWNER
        // key, so without a translator this toggle's own refusal — now
        // reachable for any org member below OWNER/ADMIN — renders as
        // "Something went wrong." The i18n path resolves
        // `errors.notResourceOwner`.
        message: formatErrorMessage(err, t),
      });
    },
  });

  const handleChange = (next: boolean) => {
    if (!canManage) return;
    setIsPublic(next); // optimistic
    mutation.mutate({ placeId, isPublic: next });
  };

  /**
   * Same wiring as the two booking switches: while the control is locked it is
   * DESCRIBED by the helper line on screen, so a dimmed switch no longer
   * announces nothing about why it is dimmed. The reason is a description, not
   * part of the name — the name stays the title.
   */
  const fieldId = useId();
  const helpId = `${fieldId}-help`;

  const row = (
    <XStack gap="$4" alignItems="center" justifyContent="space-between">
      <YStack gap="$1" flex={1}>
        <Text variant={embedded ? "body" : "h4"} weight="bold">
          {String(t("admin.peAttendeeReviewsPublicTitle"))}
        </Text>
        {/* The helper slot carries ONE line at a time — the refusal replaces
            the description of what publishing does, exactly as the booking
            switches replace theirs. Two stacked explanations is the thing the
            booking cards already decided against. */}
        <Text
          variant="bodySmall"
          tone="muted"
          id={helpId}
          testId="attendee-reviews-public-help"
        >
          {String(
            t(
              canManage
                ? "admin.peAttendeeReviewsPublicHelp"
                : "admin.placeSwitchNoPermission",
            ),
          )}
        </Text>
      </YStack>
      <Switch
        checked={isPublic}
        onCheckedChange={handleChange}
        disabled={!canManage}
        saving={mutation.isPending}
        aria-label={String(t("admin.peAttendeeReviewsPublicTitle"))}
        aria-describedby={canManage ? undefined : helpId}
        testId="attendee-reviews-public-switch"
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
