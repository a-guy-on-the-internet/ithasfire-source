"use client";

import { useMemo } from "react";
import { XStack, YStack } from "tamagui";
import { ArrowRight, CalendarClock, Copy, Mail } from "lucide-react";

import { Button, NextLinkAnchor, Spinner, Text } from "@th/ui";

import { trpc } from "@/trpc";

import {
  Card,
  CardLabel,
  formatLocalDateTime,
  type CopyHandler,
} from "./scanner-setup-shared";

export function PersonalScannerCard({
  slug,
  humanId,
  onCopy,
}: {
  slug: string;
  humanId: string;
  onCopy: CopyHandler;
}) {
  const eventsQuery = trpc.events.listMine.useQuery(
    {
      ownerType: "HUMAN" as const,
      ownerId: humanId,
      limit: 10,
      offset: 0,
    },
    { staleTime: 60_000 },
  );

  const nextEvent = useMemo(() => {
    const items = eventsQuery.data?.items ?? [];
    if (items.length === 0) return null;
    const now = Date.now();
    const upcoming = items
      .filter(
        (e): e is typeof e & { startsAt: Date } =>
          e.startsAt != null && e.startsAt.getTime() >= now,
      )
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    return upcoming[0] ?? items[0] ?? null;
  }, [eventsQuery.data?.items]);

  const scanHref = `/admin/${slug}/scan`;

  const handleCopyScanLink = () => {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}${scanHref}`
        : scanHref;
    onCopy(url, "Scan link");
  };

  return (
    <Card>
      <YStack gap="$1">
        <CardLabel>03. Use the scanner yourself</CardLabel>
        <Text variant="h4" textTransform="uppercase">
          Personal events
        </Text>
        <Text tone="muted" fontSize="$2">
          You manage events under your own profile, so you don't issue setup
          links to anyone else. Install the scanner app on your phone and sign
          in with the same email you use here.
        </Text>
      </YStack>

      <YStack gap="$3">
        <XStack gap="$3" alignItems="flex-start">
          <Mail size={18} color="var(--brandSecondary)" aria-hidden />
          <YStack gap="$1" flex={1}>
            <Text variant="body" weight="bold">
              Sign in with a magic link
            </Text>
            <Text fontSize="$2" tone="muted">
              Open the scanner app, enter your email, and tap the link from your
              inbox.
            </Text>
          </YStack>
        </XStack>

        <XStack gap="$3" alignItems="flex-start">
          <CalendarClock size={18} color="var(--brandSecondary)" aria-hidden />
          <YStack gap="$1" flex={1}>
            <Text variant="body" weight="bold">
              Pick the event you're staffing
            </Text>
            {eventsQuery.isLoading ? (
              <XStack gap="$2" alignItems="center">
                <Spinner size="small" />
                <Text fontSize="$2" tone="muted">
                  Loading your events…
                </Text>
              </XStack>
            ) : nextEvent ? (
              <Text fontSize="$2" tone="muted">
                Next up:{" "}
                <Text fontWeight="600">{nextEvent.title ?? nextEvent.id}</Text>
                {nextEvent.startsAt
                  ? ` — ${formatLocalDateTime(nextEvent.startsAt)}`
                  : ""}
              </Text>
            ) : (
              <Text fontSize="$2" tone="muted">
                You don't have any personal events yet.
              </Text>
            )}
          </YStack>
        </XStack>
      </YStack>

      <XStack gap="$2" flexWrap="wrap">
        <NextLinkAnchor href={scanHref}>
          <Button variant="primary" size="$3">
            {nextEvent ? "Open admin web scanner" : "Open admin scan"}
            <ArrowRight size={14} aria-hidden />
          </Button>
        </NextLinkAnchor>
        {nextEvent && (
          <Button
            onPress={handleCopyScanLink}
            variant="ghost"
            size="$3"
            aria-label="Copy scan link"
          >
            <Copy size={14} aria-hidden />
            Copy scan link
          </Button>
        )}
      </XStack>
    </Card>
  );
}
