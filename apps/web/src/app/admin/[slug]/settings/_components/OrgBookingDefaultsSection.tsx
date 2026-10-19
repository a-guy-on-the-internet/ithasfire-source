"use client";

import { XStack, YStack } from "tamagui";
import { NextLinkAnchor, Spinner, Text, useTranslations } from "@th/ui";

import { BookingDefaultsEditor } from "@/app/account/settings/_components/BookingDefaultsEditor";

import { useOrgPerformerEnabled } from "../_hooks/useOrgPerformerEnabled";
import { orgSettingsSectionHref } from "../_lib/org-settings-routes";
import { SectionHeading } from "./org-settings-primitives";

/**
 * "Booking defaults" — the group's reusable pitch values (booking-review-data-
 * weave WS1), split out of the performer block into its own route.
 *
 * The editor mounts on exactly the same condition it did inside the performer
 * block (org performer mode on), because the tRPC procedures are keyed on
 * `{ ownerType, ownerId }`. What is new is the OFF state: as a rail
 * destination this route must render something, so it explains the
 * prerequisite and links to the switch instead of rendering an empty column.
 * The old "…above" copy no longer applies — performer mode is a route away.
 *
 * `BookingDefaultsEditor` renders its own `sBkDefTitle` header, so the heading
 * here is branch-local and the two are mutually exclusive: nobody sees the
 * title twice.
 */
export function OrgBookingDefaultsSection({
  orgId,
  slug,
}: {
  orgId: string;
  slug: string;
}) {
  const t = useTranslations();
  const { isEnabled, isLoading } = useOrgPerformerEnabled(orgId, true);

  if (isEnabled) {
    return (
      <YStack gap="$4">
        <BookingDefaultsEditor ownerType="org" ownerId={orgId} />
      </YStack>
    );
  }

  return (
    <YStack gap="$4">
      <SectionHeading title={String(t("admin.settingsBookingDefaults"))} />

      {isLoading ? (
        <XStack gap="$2" alignItems="center">
          <Spinner size="sm" />
          <Text variant="caption" tone="muted">
            {String(t("common.loading"))}
          </Text>
        </XStack>
      ) : (
        <YStack gap="$2">
          <Text variant="body" tone="muted">
            {String(t("admin.settingsBkDefPerformerOff"))}
          </Text>
          <NextLinkAnchor
            href={orgSettingsSectionHref(slug, "performer")}
            data-testid="org-settings-bkdef-performer-link"
            style={{ textDecoration: "none" }}
          >
            {/* Wrapper carries the 44px touch target; `accentText`, not
                `accent`, because this is an interactive control's accessible
                label and raw accent is 3.57:1 as small text on Stub. */}
            <XStack alignItems="center" minHeight={44}>
              <Text
                variant="caption"
                weight="bold"
                color="$accentText"
                textTransform="uppercase"
                letterSpacing={1.2}
              >
                {String(t("admin.settingsBkDefPerformerCta"))}
              </Text>
            </XStack>
          </NextLinkAnchor>
        </YStack>
      )}
    </YStack>
  );
}
