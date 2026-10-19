"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "@bprogress/next/app";
import { YStack } from "tamagui";

import { Spinner, Text, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";

export type VolunteeringGateProps = {
  slug: string;
  eventId: string;
  children: ReactNode;
};

/**
 * Gate for the volunteer sub-routes (roles / signups / rewards).
 *
 * Volunteering is opt-in per event. While these three lived as tabs inside one
 * page, the parent simply didn't render the tablist when the toggle was off.
 * As routes they are directly addressable — a bookmark or a stale link would
 * otherwise land on a roles table for an event that has no volunteering — so
 * each one redirects back to the setup page instead, mirroring how
 * `EventAdminPageShell`'s `requirePublished` redirects to `/edit`.
 *
 * Uses the same `{ eventId }` query key as the setup page and the builder, so
 * React Query dedupes this into a fetch that is usually already warm rather
 * than adding a round trip per navigation.
 */
export function VolunteeringGate({
  slug,
  eventId,
  children,
}: VolunteeringGateProps) {
  const t = useTranslations();
  const router = useRouter();
  const eventQuery = trpc.events.getEventForEdit.useQuery(
    { eventId },
    { staleTime: 10_000, retry: 1, enabled: Boolean(eventId) },
  );

  const enabled = eventQuery.data?.volunteeringEnabled ?? null;
  const setupHref = `/admin/${slug}/events/${eventId}/volunteers`;

  useEffect(() => {
    if (enabled === false) router.replace(setupHref);
  }, [enabled, router, setupHref]);

  // Loading, or redirecting — never flash the gated content.
  if (eventQuery.isPending || enabled === false) {
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
          {String(t("admin.loading"))}
        </Text>
      </YStack>
    );
  }

  // A failed fetch is NOT treated as "disabled" — bouncing the user out on a
  // transient error would be worse than letting the child surface its own
  // error state against the same query.
  return <>{children}</>;
}

VolunteeringGate.displayName = "VolunteeringGate";
