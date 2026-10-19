"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { styled, YStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

import { AvailabilityScopePanel } from "./AvailabilityScopePanel";
import { CalendarBlackoutEditor } from "./CalendarBlackoutEditor";
import { CalendarHoursEditor } from "./CalendarHoursEditor";
import { CalendarsSection } from "./CalendarsSection";
import { SpacesSection } from "./SpacesSection";
import type { AvailabilityScope } from "./venue-calendars-helpers";

const PageContainer = styled(YStack, {
  name: "CalendarsManagerPage",
  gap: "$6",
  padding: "$4",
  width: "100%",
  maxWidth: 1000,
  marginHorizontal: "auto",
  // No viewport media queries on admin surfaces (the 256px rail makes
  // viewport width lie about content width) — constant padding, wrap-based
  // rows inside.
});

/** Sentinel for the place-wide scope in the (string-typed) select. */
const ALL_SCOPE = "__all__";

/**
 * /admin/[slug]/places/[placeId]/calendars — venue-hierarchy management
 * (spec FR-002/FR-003/FR-007): spaces, named calendars, and the availability
 * editor re-targeted from Place to Calendar with an "All calendars"
 * (place-wide) scope.
 */
export function CalendarsManager() {
  const { placeId } = useParams<{ slug: string; placeId: string }>();
  const t = useTranslations();

  const calendarsQuery = trpc.places.listCalendars.useQuery(
    { placeId },
    { enabled: Boolean(placeId) },
  );
  const calendarsData = calendarsQuery.data;

  const [scopeValue, setScopeValue] = useState<string>(ALL_SCOPE);

  const scopeOptions = useMemo(
    () => [
      { value: ALL_SCOPE, label: String(t("admin.calMgrScopeAll")) },
      ...(calendarsData ?? []).map((c) => ({ value: c.id, label: c.name })),
    ],
    [calendarsData, t],
  );

  // A calendar deleted/renamed elsewhere: fall back to the place-wide scope
  // instead of pointing the editors at a dead id.
  const effectiveValue = scopeOptions.some((o) => o.value === scopeValue)
    ? scopeValue
    : ALL_SCOPE;
  const scope: AvailabilityScope =
    effectiveValue === ALL_SCOPE ? null : effectiveValue;
  const scopeLabel =
    scopeOptions.find((o) => o.value === effectiveValue)?.label ??
    String(t("admin.calMgrScopeAll"));

  return (
    <PageContainer testID="calendars-manager">
      <YStack gap="$1">
        <Text
          variant="h3"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          {String(t("admin.calMgrTitle"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.calMgrSubtitle"))}
        </Text>
      </YStack>

      <CalendarsSection placeId={placeId} />

      <SpacesSection placeId={placeId} />

      <YStack gap="$3" testID="availability-section">
        <YStack gap="$1">
          <Text variant="h4" weight="bold">
            {String(t("admin.calMgrAvailabilityTitle"))}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.calMgrAvailabilityHelp"))}
          </Text>
        </YStack>

        <AvailabilityScopePanel
          value={effectiveValue}
          options={scopeOptions}
          onChange={setScopeValue}
          scope={scope}
          scopeLabel={scopeLabel}
        />

        <CalendarHoursEditor
          placeId={placeId}
          scope={scope}
          scopeLabel={scopeLabel}
        />
        <CalendarBlackoutEditor
          placeId={placeId}
          scope={scope}
          scopeLabel={scopeLabel}
        />
      </YStack>
    </PageContainer>
  );
}
