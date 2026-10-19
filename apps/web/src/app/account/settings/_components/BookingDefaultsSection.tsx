"use client";

import { XStack } from "tamagui";
import { CalendarCheck } from "lucide-react";
import { Spinner, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { BookingDefaultsEditor } from "./BookingDefaultsEditor";
import { SectionCard } from "./settings-primitives";

/**
 * "Booking defaults" — the human performer's reusable pitch values, split out
 * of `PerformerSection` so the availability toggles and the (long) defaults
 * form stop sharing a card.
 *
 * The editor mounts on exactly the same condition it did inside
 * PerformerSection (performer mode on AND a human owner id), because the tRPC
 * procedures are keyed on `{ ownerType, ownerId }`. What's new is that the card
 * itself always renders: it's now a top-level rail destination, and every other
 * section on this page renders a card with an in-card empty state rather than
 * vanishing — a section that disappears would leave a phantom `gap` slot in the
 * page column and a rail entry that scrolls nowhere.
 *
 * The heading is deliberately branch-local: `BookingDefaultsEditor` renders its
 * own `sBkDefTitle` / `sBkDefDesc` header (it's shared verbatim with
 * `OrgSettingsView`, which mounts it the same bare way), so the two branches are
 * mutually exclusive and no user ever sees the title twice.
 *
 * Query options must stay identical to PerformerSection's copy of
 * `performers.getMyStatus` — react-query dedupes them, and divergent options
 * would silently change retry/error behaviour for whichever mounts first.
 */
export function BookingDefaultsSection() {
  const t = useTranslations();

  const statusQuery = trpc.performers.getMyStatus.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
  });

  const human = statusQuery.data?.human;
  const ownerId = human?.enabled ? human.ownerId : null;

  if (ownerId) {
    return (
      <SectionCard>
        <BookingDefaultsEditor ownerType="human" ownerId={ownerId} />
      </SectionCard>
    );
  }

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <CalendarCheck size={18} color="$colorMuted" />
        <Text variant="h4" weight="bold">
          {String(t("account.sBkDefTitle"))}
        </Text>
      </XStack>

      <Text variant="bodySmall" tone="muted">
        {String(t("account.sBkDefDesc"))}
      </Text>

      {statusQuery.isLoading ? (
        <XStack gap="$2" alignItems="center">
          <Spinner size="sm" />
          <Text variant="caption" tone="muted">
            {String(t("common.loading"))}
          </Text>
        </XStack>
      ) : (
        <Text variant="caption" tone="muted">
          {String(t("account.sBkDefPerformerOff"))}
        </Text>
      )}
    </SectionCard>
  );
}
