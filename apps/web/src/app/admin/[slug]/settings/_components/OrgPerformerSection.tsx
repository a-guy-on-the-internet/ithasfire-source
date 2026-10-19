"use client";

import { YStack } from "tamagui";
import { Text, useFormatters, useTranslations } from "@th/ui";

import { PerformerModeToggle } from "@/components/performers/PerformerModeToggle";
import { BookingAcceptanceToggle } from "@/components/performers/BookingAcceptanceToggle";

import { useOrgPerformerEnabled } from "../_hooks/useOrgPerformerEnabled";
import { SectionHeading } from "./org-settings-primitives";

/**
 * "Performer" — the two org-level availability switches, and only those.
 *
 * The booking-defaults editor that used to hang off the bottom of this block is
 * its own route now (`settings/booking-defaults`, same "Getting booked" group).
 * The received-request inbox that also hung here left settings entirely — it is
 * a work queue, not configuration, and lives at `/admin/[slug]/bookings`. What
 * is left is the pair of toggles that answer "can this group be booked at all",
 * which is the question the section title asks.
 *
 * ORG performer mode stays HERE, not in `/account/settings`: the account page
 * is about the individual performer. This is the canonical home for group
 * booking configuration.
 */
export function OrgPerformerSection({
  orgId,
  canEdit,
}: {
  orgId: string;
  canEdit: boolean;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const { isEnabled } = useOrgPerformerEnabled(orgId, canEdit);

  return (
    <YStack gap="$4">
      <SectionHeading
        title={String(t("admin.settingsPerformer"))}
        description={String(t("admin.settingsPerformerDescription"))}
      />

      {canEdit && (
        <PerformerModeToggle
          owner={{ type: "org", orgId }}
          label={String(t("admin.performerModeLabel"))}
          onHelp={(enabledAt) =>
            String(
              t("admin.performerModeOnHelp", {
                date: enabledAt
                  ? fmt.dateTime(enabledAt, { dateStyle: "medium" })
                  : "—",
              }),
            )
          }
          offHelp={String(t("admin.performerModeOffHelp"))}
          testId="org-settings-performer-mode"
        />
      )}

      {/* Organizer-booking-request opt-in (FR-002) — directly under the
          performer-mode switch, only while it's on (enabling requires
          performer mode server-side). */}
      {canEdit && isEnabled && (
        <BookingAcceptanceToggle
          owner={{ type: "org", orgId }}
          label={String(t("admin.bkAcceptLabel"))}
          onHelp={String(t("admin.bkAcceptOnHelp"))}
          offHelp={String(t("admin.bkAcceptOffHelp"))}
          testId="org-settings-booking-acceptance"
        />
      )}

      {!canEdit && (
        <Text variant="caption" tone="muted">
          {String(t("admin.performerModeForbidden"))}
        </Text>
      )}
    </YStack>
  );
}
