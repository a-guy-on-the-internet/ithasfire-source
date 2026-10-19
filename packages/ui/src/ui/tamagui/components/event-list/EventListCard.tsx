"use client";

import { memo, useCallback, useMemo } from "react";
import { Platform } from "react-native";
import {
  Image,
  Stack,
  XStack,
  YStack,
  styled,
  useTheme,
  getVariableValue,
} from "tamagui";
import { Calendar, MapPin, ExternalLink } from "lucide-react";

import { Text } from "../typography/Text";
import type { EventSummary, EventSummaryMedia } from "../event-grid/types";
import { EventListDistance } from "./EventListDistance";

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives
// ─────────────────────────────────────────────────────────────────────────────

const isWeb = Platform.OS === "web";

const CardSurface = styled(XStack, {
  name: "EventListCardSurface",
  backgroundColor: "$surface",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  overflow: "hidden",
  cursor: "pointer",
  transition: "all $motionFast",
  hoverStyle: {
    backgroundColor: "$backgroundHover",
    borderColor: "$borderColorSoft",
  },
  pressStyle: {
    scale: 0.98,
  },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$focus",
    outlineOffset: 2,
  },
});

const THUMBNAIL_SIZE = 80;

const ThumbnailContainer = styled(Stack, {
  name: "EventListCardThumbnail",
  width: THUMBNAIL_SIZE,
  height: THUMBNAIL_SIZE,
  minWidth: THUMBNAIL_SIZE,
  minHeight: THUMBNAIL_SIZE,
  flexShrink: 0,
  overflow: "hidden",
  backgroundColor: "$surfaceMuted",
  alignItems: "center",
  justifyContent: "center",
});

const PlaceholderGradient = styled(Stack, {
  name: "EventListCardPlaceholder",
  width: "100%",
  height: "100%",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "$brandPrimaryMuted",
});

const ContentContainer = styled(YStack, {
  name: "EventListCardContent",
  flex: 1,
  paddingHorizontal: "$3",
  paddingVertical: "$2.5",
  gap: "$1",
  justifyContent: "center",
});

const MetaRow = styled(XStack, {
  name: "EventListCardMetaRow",
  alignItems: "center",
  gap: "$1.5",
});

const TagsRow = styled(XStack, {
  name: "EventListCardTagsRow",
  alignItems: "center",
  gap: "$1.5",
  flexWrap: "wrap",
});

const TagPill = styled(Stack, {
  name: "EventListCardTagPill",
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
  paddingHorizontal: "$2",
  paddingVertical: "$0.5",
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const resolveAutomationProps = (testId?: string, qaId?: string) => {
  if (!testId) return {};
  if (isWeb) {
    return {
      "data-testid": testId,
      ...(qaId ? { "data-qa": qaId } : {}),
    } as Record<string, unknown>;
  }
  return {
    testID: testId,
    ...(qaId ? { accessibilityLabel: qaId } : {}),
  } as Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface EventListCardProps {
  event: EventSummary;
  onPress?: (event: EventSummary) => void;
  /** Display unit for distance badge. */
  distanceUnit?: "km" | "mi";
  /** Show distance badge. Defaults to true when distanceKm is set. */
  showDistance?: boolean;
  /** Show tag pills. */
  showTags?: boolean;
  testIdBase?: string;
  qaId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const EventListCard = memo<EventListCardProps>(
  ({
    event,
    onPress,
    distanceUnit = "km",
    showDistance,
    showTags = true,
    testIdBase,
    qaId,
  }) => {
    const theme = useTheme();
    const automationId = testIdBase ?? `event-list-card-${event.id}`;
    const automationQa = qaId ?? automationId;

    const mutedIconColor = useMemo(() => {
      const variable = theme.colorMuted;
      return getVariableValue(variable ?? "$colorMuted");
    }, [theme]);

    const handlePress = useCallback(() => {
      onPress?.(event);
    }, [event, onPress]);

    const shouldShowDistance =
      showDistance !== undefined
        ? showDistance
        : event.distanceKm != null && event.distanceKm >= 0;

    const visibleTags = useMemo(() => {
      if (!showTags || !event.tags?.length) return [];
      return event.tags.slice(0, 3); // max 3 tags
    }, [showTags, event.tags]);

    const cardRole = isWeb && onPress ? "link" : undefined;

    return (
      <CardSurface
        onPress={onPress ? handlePress : undefined}
        role={cardRole}
        accessibilityRole={cardRole}
        accessibilityLabel={event.title}
        tabIndex={onPress ? 0 : undefined}
        {...resolveAutomationProps(automationId, automationQa)}
      >
        {/* Thumbnail */}
        <ThumbnailContainer>
          {event.media?.url ? (
            <Image
              accessibilityLabel={event.media.alt}
              resizeMode="cover"
              source={{ uri: event.media.url }}
              style={
                {
                  width: "100%",
                  height: "100%",
                } as any
              }
            />
          ) : (
            <PlaceholderGradient>
              <Text
                variant="h4"
                weight="bold"
                color="$brandPrimary"
                aria-hidden
              >
                {event.title.charAt(0).toUpperCase()}
              </Text>
            </PlaceholderGradient>
          )}
        </ThumbnailContainer>

        {/* Content */}
        <ContentContainer>
          {/* Title row with optional distance */}
          <XStack
            justifyContent="space-between"
            alignItems="flex-start"
            gap="$2"
          >
            <Text
              variant="bodySmall"
              weight="bold"
              truncate
              flex={1}
              {...resolveAutomationProps(`${automationId}-title`)}
            >
              {event.title}
            </Text>
            {shouldShowDistance && event.distanceKm != null ? (
              <EventListDistance
                distanceKm={event.distanceKm}
                unit={distanceUnit}
                compact
                testIdBase={automationId}
              />
            ) : null}
          </XStack>

          {/* Date */}
          <MetaRow>
            <Calendar size={12} color={mutedIconColor} aria-hidden />
            <Text variant="caption" tone="muted" truncate>
              {event.date}
            </Text>
          </MetaRow>

          {/* Venue / location */}
          <MetaRow>
            <MapPin size={12} color={mutedIconColor} aria-hidden />
            <Text variant="caption" tone="muted" truncate>
              {event.venue}
            </Text>
          </MetaRow>

          {/* Tags */}
          {visibleTags.length > 0 ? (
            <TagsRow>
              {visibleTags.map((tag) => (
                <TagPill key={tag}>
                  <Text variant="overline" tone="muted">
                    {tag}
                  </Text>
                </TagPill>
              ))}
            </TagsRow>
          ) : null}
        </ContentContainer>
      </CardSurface>
    );
  },
);

EventListCard.displayName = "EventListCard";
