"use client";

import Link from "next/link";
import { Calendar, MapPin } from "lucide-react";
import { Card, Stack, XStack, YStack, styled } from "tamagui";

import { Badge, Text, useFormatters, useTranslations } from "@th/ui";

import { SaveHeart } from "@/components/saves/SaveHeart";

/**
 * The saved-event row and its skeleton.
 *
 * LIFTED verbatim (behaviour and markup) out of `app/saved/_components/
 * SavedEvents.tsx` when `/saved` was folded into `/my-tickets` — the page it
 * used to live on is now a redirect, and a second copy of this card is exactly
 * the divergence that merge was meant to avoid. It lives under
 * `components/saves/` beside `SaveHeart` / `useEventSaves` so the next surface
 * that needs a watchlist row (a profile tab, an embed) picks it up here rather
 * than re-deriving it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types (mirrors eventSaves.listMine output items)
// ─────────────────────────────────────────────────────────────────────────────

export type SavedEventItem = {
  saveId: string;
  savedAt: Date;
  event: {
    id: string;
    slug: string | null;
    title: string;
    startsAt: Date;
    endsAt: Date | null;
    timezone: string;
    status: string;
    visibility: string;
    heroImageId: string | null;
    heroImageUrl: string | null;
    addressText: string | null;
    locationLabel: string | null;
    placeId: string | null;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton
// ─────────────────────────────────────────────────────────────────────────────

const SkeletonPulse = styled(Stack, {
  name: "SavedSkeletonPulse",
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
  animation: "th-skeleton-pulse 1.8s ease-in-out infinite",
});

export const SavedEventCardSkeleton = () => (
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
// Card
// ─────────────────────────────────────────────────────────────────────────────

export const SavedEventCard = ({
  item,
  onUnsave,
}: {
  item: SavedEventItem;
  onUnsave: (eventId: string) => void;
}) => {
  const t = useTranslations();
  const fmt = useFormatters();

  const { event } = item;
  const isCancelled = event.status === "CANCELLED";
  const href = `/events/${event.slug ?? event.id}`;
  const where = event.locationLabel ?? event.addressText;

  const dateStr = fmt.dateTime(new Date(event.startsAt), {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(event.timezone ? { timeZone: event.timezone } : {}),
  });

  return (
    // The unsave heart is a SIBLING overlay of the anchor, not a child —
    // <button> inside <a> is invalid HTML and confuses assistive tech.
    <div role="listitem" style={{ position: "relative" }}>
      <Link href={href} style={{ textDecoration: "none", display: "block" }}>
        <Card
          padding="$4"
          borderRadius={0}
          opacity={isCancelled ? 0.85 : 1}
          hoverStyle={{ backgroundColor: "$backgroundHover" }}
          pressStyle={{ opacity: 0.85 }}
          cursor="pointer"
          data-testid={`saved-event-card-${event.id}`}
        >
          <XStack gap="$3" alignItems="stretch">
            {/* Hero thumbnail (EventCard dense convention: fixed-width thumb,
                cover fit). Decorative — the adjacent title carries the name,
                so alt stays empty for screen readers. Falls back to the
                text-first layout when the event has no hero image. */}
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
              {/* Top: title + cancelled badge. Right padding clears the
                  absolutely-positioned unsave heart overlay. */}
              <XStack
                alignItems="flex-start"
                gap="$2"
                flexWrap="wrap"
                paddingRight={40}
              >
                <Text variant="h4" tag="h3" weight="bold" flexShrink={1}>
                  {event.title}
                </Text>
                {isCancelled ? (
                  <Badge tone="danger" size="sm">
                    {String(t("saves.cancelledBadge"))}
                  </Badge>
                ) : null}
              </XStack>

              {/* Meta: when + where.
                  Both children need `minWidth={0}` + `flexShrink`: a Tamagui
                  flex item sizes to MAX-CONTENT by default, so without them the
                  `where` Text's `whiteSpace: nowrap` sets a floor the row cannot
                  go under — its ellipsis never engages and the whole card blows
                  past the viewport. Measured at 320: card clientWidth 288 vs
                  scrollWidth 495 before this. `where` also takes `flex={1}` so
                  it absorbs the leftover width and truncates there, not the date. */}
              <XStack gap="$4" flexWrap="wrap">
                <XStack gap="$2" alignItems="center" minWidth={0} flexShrink={1}>
                  <Calendar size={15} color="var(--colorMuted)" aria-hidden />
                  <Text variant="body" tone="muted">
                    {dateStr}
                  </Text>
                </XStack>
                {where ? (
                  <XStack gap="$2" alignItems="center" minWidth={0} flex={1} flexShrink={1}>
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

              <Text variant="body" color="$accentText" weight="bold">
                {String(t("saves.viewEvent"))} →
              </Text>
            </YStack>
          </XStack>
        </Card>
      </Link>
      <SaveHeart
        saved
        onToggle={() => onUnsave(event.id)}
        testId={`saved-event-card-${event.id}-unsave`}
        style={{ position: "absolute", top: 6, right: 6 }}
      />
    </div>
  );
};

SavedEventCard.displayName = "SavedEventCard";
