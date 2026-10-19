"use client";

import { use } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack } from "tamagui";

import { Button, Spinner, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

import { EventAdminPageShell } from "../_components/EventAdminPageShell";
import { EventOpsShell } from "../_components/EventOpsShell";
import { SeriesDatesView } from "./_components/SeriesDatesView";

type PageProps = {
  params: Promise<{ slug: string; id: string }>;
};

/**
 * Per-series "Dates" management surface (recurring-series redesign Phase 2) —
 * one row per occurrence with status, readiness meta, and per-row actions.
 * Route segment mirrors the other ops surfaces split out of the builder
 * (attendees / volunteers / comp-tickets, FR-201). Requires edit rights:
 * every action here (publish, skip, add) is a mutation.
 */
export default function AdminEventDatesPage({ params }: PageProps) {
  const { slug, id: eventId } = use(params);
  const t = useTranslations();

  return (
    <EventAdminPageShell slug={slug} eventId={eventId} requireEdit>
      {() => (
        // Dates was the sixth surface on the old bare frame — not in the
        // original five, but it carried its own 960 container and no heading,
        // so it joins the shell rather than being handed a replacement div.
        // `SeriesDatesView` keeps its internal 960 reading measure as a content
        // constraint inside the shell's 1200 container.
        <EventOpsShell
          title={String(t("admin.sdTitle"))}
          purpose={String(t("admin.opsDatesPurpose"))}
        >
          <SeriesResolver slug={slug} eventId={eventId} />
        </EventOpsShell>
      )}
    </EventAdminPageShell>
  );
}

/**
 * Resolves the event's series id. Uses the SAME query key EventBuilder uses
 * (`{ eventId }`) so React Query dedupes this into the edit surface's fetch
 * when the cache is warm. Non-series events get a terminal state pointing at
 * the canonical schedule editor instead of a broken list.
 */
function SeriesResolver({ slug, eventId }: { slug: string; eventId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const eventForEditQuery = trpc.events.getEventForEdit.useQuery({ eventId });

  if (eventForEditQuery.isPending) {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={240}
        gap="$3"
      >
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          {String(t("admin.sdLoading"))}
        </Text>
      </YStack>
    );
  }

  if (eventForEditQuery.isError) {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={240}
        gap="$3"
      >
        <Text variant="h4" weight="bold">
          {String(t("admin.sdLoadErrorTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          {String(t("admin.sdLoadErrorBody"))}
        </Text>
        <Button
          variant="secondary"
          size="$3"
          onPress={() => void eventForEditQuery.refetch()}
          disabled={eventForEditQuery.isFetching}
        >
          {String(
            t(
              eventForEditQuery.isFetching ? "common.loading" : "admin.sdRetry",
            ),
          )}
        </Button>
      </YStack>
    );
  }

  const seriesId = eventForEditQuery.data?.seriesId ?? null;

  if (!seriesId) {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={240}
        gap="$3"
      >
        <Text variant="h4" weight="bold">
          {String(t("admin.sdNotSeriesTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          {String(t("admin.sdNotSeriesBody"))}
        </Text>
        <Button
          variant="secondary"
          size="$3"
          onPress={() => {
            router.push(
              `/admin/${slug}/events/${eventId}/edit?section=scheduling`,
            );
          }}
        >
          {String(t("admin.sdEditSchedule"))}
        </Button>
      </YStack>
    );
  }

  return <SeriesDatesView slug={slug} eventId={eventId} seriesId={seriesId} />;
}
