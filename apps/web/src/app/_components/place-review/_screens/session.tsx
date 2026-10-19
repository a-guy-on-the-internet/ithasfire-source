"use client";

import { YStack, XStack } from "tamagui";

import type { ScreenDef } from "../_shared/types";
import { INPUT_STYLE, MUTED } from "../_shared/tokens";
import { TIME_OF_DAY_LABELS } from "../_shared/labels";
import { ChipGroup } from "@th/ui";
import { Text } from "@th/ui";

// ─────────────────────────────────────────────────────────────────────────────
// Gig Time of Day — new screen after gig date
// ─────────────────────────────────────────────────────────────────────────────

export const GIG_TIME_SCREEN: ScreenDef = {
  id: "gigTimeOfDay",
  phase: "optional",
  question: "What time did you play?",
  helper:
    "A rough window is fine — helps us compare morning open mics to late-night sets.",
  autoAdvance: true,
  render: (d, onChange) => (
    <YStack gap={16}>
      <ChipGroup
        options={TIME_OF_DAY_LABELS}
        value={d.gigTimeOfDay}
        onChange={(val) => onChange({ gigTimeOfDay: val })}
        fillContainer
      />
      <YStack gap={4}>
        <Text fontSize={13} color={MUTED}>
          Or enter a specific time
        </Text>
        <input
          type="time"
          value={d.gigTimeExact}
          onChange={(e) => onChange({ gigTimeExact: e.target.value })}
          style={INPUT_STYLE}
        />
      </YStack>
    </YStack>
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Completion Incentive — trusted venues near you (shown after Page 1)
// ─────────────────────────────────────────────────────────────────────────────

export function buildCompletionIncentiveScreen(
  venues: Array<{
    placeId: string;
    name: string;
    /** Coarsened band from the public snapshot ("3".."19", "20+", "50+"). */
    reviewCountBand: string;
    /** 5%-stepped share (0–100) from the public snapshot. */
    wouldPlayAgainPct: number | null;
  }>,
  city: string | null,
  totalCount: number,
  emailCaptured: boolean,
): ScreenDef {
  return {
    id: "completionIncentive",
    phase: "bridge",
    question: "You just helped other artists.",
    helper: "Here's your reward:",
    render: () => (
      <YStack gap={16}>
        {city && (
          <Text
            fontSize={14}
            color={MUTED}
            fontWeight="600"
            style={{ textTransform: "uppercase", letterSpacing: 1 }}
          >
            Trusted places near {city}
          </Text>
        )}
        <YStack gap={8}>
          {venues.map((v) => (
            <XStack
              key={v.placeId}
              paddingVertical={10}
              paddingHorizontal={12}
              borderWidth={1}
              borderColor="$borderColor"
              alignItems="center"
              justifyContent="space-between"
            >
              <Text fontSize={14} fontWeight="600">
                {v.name}
              </Text>
              <Text fontSize={13} color={MUTED}>
                {v.wouldPlayAgainPct != null
                  ? `${v.wouldPlayAgainPct}% would return`
                  : ""}{" "}
                ({v.reviewCountBand} reviews)
              </Text>
            </XStack>
          ))}
        </YStack>
        {!emailCaptured && totalCount > venues.length && (
          <Text fontSize={13} color={MUTED} fontStyle="italic">
            +{totalCount - venues.length} more — drop your email above to see
            the full list
          </Text>
        )}
      </YStack>
    ),
  };
}
