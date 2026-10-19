"use client";

import { XStack } from "tamagui";
import { Mic } from "lucide-react";
import { Text, useFormatters, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { PerformerModeToggle } from "@/components/performers/PerformerModeToggle";
import { BookingAcceptanceToggle } from "@/components/performers/BookingAcceptanceToggle";
import { SectionCard } from "./settings-primitives";

/**
 * Account-settings Performer section: availability only — the human
 * performer-mode opt-in (performer-mode spec FR-001) and the organizer-booking
 * opt-in (FR-002). Org performer mode is managed in each group's settings —
 * this section only hints at it.
 *
 * The performer's reusable pitch values live in `BookingDefaultsSection`, and
 * the sent/received request lists in `BookingRequestsSection`. All three read
 * `performers.getMyStatus` with identical query options — react-query dedupes
 * the fetch, and keeping the options identical stops error behaviour drifting
 * between them.
 */
export function PerformerSection() {
  const t = useTranslations();
  const fmt = useFormatters();

  const statusQuery = trpc.performers.getMyStatus.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
  });

  const adminOrgIds = statusQuery.data?.orgs.map((o) => o.ownerId) ?? [];
  const human = statusQuery.data?.human;

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <Mic size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {String(t("account.sPerformerTitle"))}
        </Text>
      </XStack>

      <Text variant="bodySmall" tone="muted">
        {String(t("account.sPerformerDesc"))}
      </Text>

      <PerformerModeToggle
        owner={{ type: "human" }}
        label={String(t("account.sPerformerToggleLabel"))}
        onHelp={(enabledAt) =>
          String(
            t("account.sPerformerOnSince", {
              date: enabledAt
                ? fmt.dateTime(enabledAt, { dateStyle: "medium" })
                : "—",
            }),
          )
        }
        offHelp={String(t("account.sPerformerOffHelp"))}
        testId="performer-mode-switch"
      />

      {/* Organizer-booking-request opt-in (FR-002) — only meaningful while
          performer mode is on, since enabling requires it server-side. */}
      {human?.enabled && (
        <BookingAcceptanceToggle
          owner={{ type: "human" }}
          label={String(t("account.sPerformerAcceptLabel"))}
          onHelp={String(t("account.sPerformerAcceptOnHelp"))}
          offHelp={String(t("account.sPerformerAcceptOffHelp"))}
          testId="booking-acceptance-switch"
        />
      )}

      {adminOrgIds.length > 0 && (
        <Text variant="caption" tone="muted">
          {String(t("account.sPerformerOrgHint"))}
        </Text>
      )}
    </SectionCard>
  );
}
