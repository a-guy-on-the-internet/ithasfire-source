"use client";

import { memo, useMemo } from "react";
import { XStack } from "tamagui";
import { MapPin } from "lucide-react";

import { Text } from "../typography/Text";

const KM_TO_MI = 0.621371;

export interface EventListDistanceProps {
  /** Distance in kilometres. */
  distanceKm: number;
  /** Display unit — defaults to "km". */
  unit?: "km" | "mi";
  /** Compact shows "2.3 mi"; non-compact shows "2.3 miles away". */
  compact?: boolean;
  testIdBase?: string;
}

const formatDistance = (
  km: number,
  unit: "km" | "mi",
  compact: boolean,
): string => {
  const value = unit === "mi" ? km * KM_TO_MI : km;
  const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  if (compact) {
    return `${rounded} ${unit}`;
  }
  const unitLabel = unit === "mi" ? "miles" : "km";
  return `${rounded} ${unitLabel} away`;
};

export const EventListDistance = memo<EventListDistanceProps>(
  ({ distanceKm, unit = "km", compact = true, testIdBase }) => {
    const label = useMemo(
      () => formatDistance(distanceKm, unit, compact),
      [distanceKm, unit, compact],
    );

    return (
      <XStack
        alignItems="center"
        gap="$1"
        {...(testIdBase ? { "data-testid": `${testIdBase}-distance` } : {})}
      >
        <MapPin size={12} color="$colorMuted" aria-hidden />
        <Text variant="caption" tone="muted">
          {label}
        </Text>
      </XStack>
    );
  },
);

EventListDistance.displayName = "EventListDistance";
