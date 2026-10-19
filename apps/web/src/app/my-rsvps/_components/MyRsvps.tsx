"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, Card, Stack, styled } from "tamagui";
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  CalendarCheck,
  Check,
  MapPin,
  Search,
} from "lucide-react";

import { Text, Button, Badge, useTranslations, useFormatters } from "@th/ui";

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";

// ─────────────────────────────────────────────────────────────────────────────
// Types — derived from the router output so the shape can't silently drift
// from `listMyRsvpsOutputSchema`.
// ─────────────────────────────────────────────────────────────────────────────

type RsvpItem =
  inferRouterOutputs<AppRouter>["community"]["myRsvps"]["items"][number];

const PAGE_LIMIT = 20;

/** Compose a compact "where" line from the freeform address or locality/region. */
const whereLine = (event: RsvpItem["event"]): string | null => {
  if (event.addressText) return event.addressText;
  const parts = [event.locality, event.region].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton loading (matches the /saved pattern)
// ─────────────────────────────────────────────────────────────────────────────

const SkeletonPulse = styled(Stack, {
  name: "MyRsvpsSkeletonPulse",
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
  animation: "th-skeleton-pulse 1.8s ease-in-out infinite",
});

const RsvpCardSkeleton = () => (
  <Card
    padding="$4"
    borderRadius={0}
    borderTopWidth={2}
    borderTopColor="$borderColor"
    borderBottomWidth={1}
    borderBottomColor="$borderColor"
  >
    <YStack gap="$3">
      <XStack justifyContent="space-between" alignItems="center">
        <SkeletonPulse height={20} width="60%" />
        <SkeletonPulse height={22} width={44} borderRadius={0} />
      </XStack>
      <XStack gap="$4" flexWrap="wrap">
        <SkeletonPulse height={16} width={140} />
        <SkeletonPulse height={16} width={110} />
      </XStack>
    </YStack>
  </Card>
);

// ─────────────────────────────────────────────────────────────────────────────
// RSVP event card
// ─────────────────────────────────────────────────────────────────────────────

const RsvpEventCard = ({ item }: { item: RsvpItem }) => {
  const t = useTranslations();
  const fmt = useFormatters();

  const { event } = item;
  const isCancelled = event.status === "CANCELLED";
  const isPast =
    new Date(event.endsAt ?? event.startsAt).getTime() < Date.now();
  const href = `/events/${event.slug ?? event.id}`;
  const where = whereLine(event);

  const dateStr = fmt.dateTime(new Date(event.startsAt), {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(event.timezone ? { timeZone: event.timezone } : {}),
  });

  return (
    <div role="listitem">
      <Link href={href} style={{ textDecoration: "none", display: "block" }}>
        <Card
          padding="$4"
          borderRadius={0}
          opacity={isCancelled || isPast ? 0.85 : 1}
          hoverStyle={{ backgroundColor: "$backgroundHover" }}
          pressStyle={{ opacity: 0.85 }}
          cursor="pointer"
          data-testid={`rsvp-event-card-${event.id}`}
        >
          <XStack gap="$3" alignItems="stretch">
            {/* Hero thumbnail (dense EventCard convention). Decorative — the
                adjacent title carries the name, so alt stays empty. */}
            {event.heroImageUrl ? (
              <div
                style={{
                  width: 96,
                  minHeight: 96,
                  flexShrink: 0,
                  alignSelf: "stretch",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                <img
                  src={event.heroImageUrl}
                  alt=""
                  aria-hidden
                  loading="lazy"
                  style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              </div>
            ) : null}

            <YStack gap="$3" flex={1} minWidth={0}>
              <XStack alignItems="flex-start" gap="$2" flexWrap="wrap">
                <Text variant="h4" tag="h3" weight="bold" flexShrink={1}>
                  {event.title}
                </Text>
                {isCancelled ? (
                  <Badge tone="danger" size="sm">
                    {String(t("rsvp.cancelledBadge"))}
                  </Badge>
                ) : isPast ? (
                  <Badge tone="neutral" size="sm">
                    {String(t("rsvp.endedBadge"))}
                  </Badge>
                ) : null}
              </XStack>

              {/* Meta: when + where */}
              <XStack gap="$4" flexWrap="wrap">
                <XStack gap="$2" alignItems="center">
                  <Calendar size={15} color="var(--colorMuted)" aria-hidden />
                  <Text variant="body" tone="muted">
                    {dateStr}
                  </Text>
                </XStack>
                {where ? (
                  <XStack gap="$2" alignItems="center">
                    <MapPin size={15} color="var(--colorMuted)" aria-hidden />
                    <Text
                      variant="body"
                      tone="muted"
                      overflow="hidden"
                      whiteSpace="nowrap"
                      textOverflow="ellipsis"
                    >
                      {where}
                    </Text>
                  </XStack>
                ) : null}
              </XStack>

              <Text variant="body" color="$accent" weight="bold">
                {String(t("rsvp.viewEvent"))} →
              </Text>
            </YStack>
          </XStack>
        </Card>
      </Link>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Signed-out promo
// ─────────────────────────────────────────────────────────────────────────────

const SignedOutPromo = () => {
  const t = useTranslations();
  const { showSignInOverlay } = useAppOverlay();

  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      padding="$10"
      gap="$5"
      data-testid="my-rsvps-signed-out"
    >
      <YStack
        width={80}
        height={80}
        borderRadius={0}
        backgroundColor="$surfaceMuted"
        justifyContent="center"
        alignItems="center"
      >
        <CalendarCheck size={36} color="var(--colorMuted)" aria-hidden />
      </YStack>
      <YStack gap="$2" alignItems="center">
        <Text variant="h3" weight="bold" textAlign="center">
          {String(t("rsvp.signedOutTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={340}>
          {String(t("rsvp.signedOutDescription"))}
        </Text>
      </YStack>
      <Button
        variant="primary"
        size="$4"
        onPress={() => showSignInOverlay({ redirect: "/my-rsvps" })}
        data-testid="my-rsvps-sign-in-cta"
      >
        {String(t("rsvp.signIn"))}
      </Button>
    </YStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────────────────────

const EmptyState = () => {
  const t = useTranslations();

  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      padding="$8"
      gap="$4"
      data-testid="my-rsvps-empty"
    >
      <YStack
        width={64}
        height={64}
        borderRadius={0}
        backgroundColor="$surfaceMuted"
        justifyContent="center"
        alignItems="center"
      >
        <Check size={28} color="var(--colorMuted)" aria-hidden />
      </YStack>
      <YStack gap="$2" alignItems="center">
        <Text variant="h4" weight="bold">
          {String(t("rsvp.emptyTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={320}>
          {String(t("rsvp.emptyDescription"))}
        </Text>
      </YStack>
      <Link href="/search">
        <Button tag="span" variant="primary" size="$4">
          <Search size={16} aria-hidden />
          {String(t("rsvp.discoverEvents"))}
        </Button>
      </Link>
    </YStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Page body
// ─────────────────────────────────────────────────────────────────────────────

export const MyRsvps = () => {
  const t = useTranslations();
  const router = useRouter();

  const sessionQuery = authClient.useSession();
  const sessionResolved = !sessionQuery.isPending;
  const isSignedIn = Boolean(sessionQuery.data?.user);

  // useInfiniteQuery injects a top-level `direction` into the input; the
  // community.myRsvps procedure allows+strips it (mirrors eventSaves.listMine),
  // so scrolling/paginating never 400s on the strict base schema.
  const listQuery = trpc.community.myRsvps.useInfiniteQuery(
    { limit: PAGE_LIMIT },
    {
      enabled: isSignedIn,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  const items = useMemo<RsvpItem[]>(() => {
    const pages = listQuery.data?.pages ?? [];
    return pages.flatMap((page) => page.items);
  }, [listQuery.data?.pages]);

  const isInitialLoading =
    !sessionResolved || (isSignedIn && listQuery.isLoading);
  const showSkeleton = useDelayedFlag(isInitialLoading, 200);

  // ── Signed out ─────────────────────────────────────────────────────────────
  if (sessionResolved && !isSignedIn) {
    return <SignedOutPromo />;
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isInitialLoading) {
    if (!showSkeleton) {
      return <YStack gap="$4" data-testid="my-rsvps-loading" />;
    }
    return (
      <YStack gap="$4" data-testid="my-rsvps-loading">
        <SkeletonPulse height={28} width="40%" />
        <SkeletonPulse height={14} width={140} />
        <YStack gap="$2">
          <RsvpCardSkeleton />
          <RsvpCardSkeleton />
          <RsvpCardSkeleton />
        </YStack>
      </YStack>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (listQuery.error) {
    return (
      <YStack alignItems="center" justifyContent="center" padding="$8" gap="$4">
        <YStack
          width={64}
          height={64}
          borderRadius={0}
          backgroundColor="$red3"
          justifyContent="center"
          alignItems="center"
        >
          <AlertCircle size={28} color="var(--danger)" aria-hidden />
        </YStack>
        {/* Keep the raw error out of the UI — translated copy only. */}
        <Text variant="h4" color="$red10">
          {String(t("rsvp.unableToLoad"))}
        </Text>
        <Button variant="secondary" onPress={() => listQuery.refetch()}>
          {String(t("rsvp.tryAgain"))}
        </Button>
      </YStack>
    );
  }

  // ── Content ────────────────────────────────────────────────────────────────
  return (
    <YStack gap="$4" data-testid="my-rsvps-content">
      {/* Header */}
      <XStack gap="$3" alignItems="center">
        {/* Accent lives on the Button frame (not an inner Text override) so
            the icon + label ride currentColor per the v2 atom grammar. */}
        <Button
          variant="ghost"
          size="$3"
          color="$accent"
          onPress={() => router.push("/")}
          aria-label={t("common.backToHome") as string}
          paddingHorizontal="$2"
          paddingVertical="$2"
        >
          <ArrowLeft size={16} strokeWidth={2.5} aria-hidden />
          {String(t("common.backToHome"))}
        </Button>
        <YStack gap="$1" flex={1}>
          <Text
            variant="h2"
            tag="h1"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={-0.5}
          >
            {String(t("rsvp.listTitle"))}
          </Text>
          <Text variant="body" tone="muted">
            {String(t("rsvp.listSubtitle"))}
          </Text>
        </YStack>
      </XStack>

      {items.length === 0 && !listQuery.isFetching ? (
        <EmptyState />
      ) : (
        <YStack gap="$2" role="list" aria-label={String(t("rsvp.listTitle"))}>
          {items.map((item) => (
            <RsvpEventCard key={item.rsvp.id} item={item} />
          ))}
        </YStack>
      )}

      {listQuery.hasNextPage ? (
        <XStack justifyContent="center" paddingVertical="$2">
          <Button
            variant="secondary"
            size="$3"
            disabled={listQuery.isFetchingNextPage}
            onPress={() => void listQuery.fetchNextPage()}
            data-testid="my-rsvps-load-more"
          >
            {String(
              t(
                listQuery.isFetchingNextPage
                  ? "common.loading"
                  : "rsvp.loadMore",
              ),
            )}
          </Button>
        </XStack>
      ) : null}
    </YStack>
  );
};

MyRsvps.displayName = "MyRsvps";
