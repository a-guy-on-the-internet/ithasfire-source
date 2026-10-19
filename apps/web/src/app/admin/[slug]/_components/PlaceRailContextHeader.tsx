"use client";

import { YStack } from "tamagui";

import { Badge, useTranslations } from "@th/ui";

import { RailContextTitle } from "./RailContextTitle";
import {
  VERIFICATION_LABEL_KEYS,
  isKnownStatus,
  type PlaceVerificationStatus,
} from "./place-verification-labels";

export type { PlaceVerificationStatus };

export type PlaceRailContextHeaderProps = {
  /** Resolved place display name. */
  name: string | null;
  /** Raw verification status enum when known. */
  verification?: string;
};

/**
 * Rail context header for the place-context rail (place-admin-rail-context
 * FR-202): place name plus the verification chip, slotted between the
 * "← All places" back row and the Venue/Operate sections. Modeled on
 * EventRailContextHeader.
 */
export function PlaceRailContextHeader({
  name,
  verification,
}: PlaceRailContextHeaderProps) {
  const t = useTranslations();
  if (!name && !verification) return null;
  return (
    <YStack
      paddingHorizontal="$4"
      paddingBottom="$3"
      gap="$2"
      alignItems="flex-start"
      borderBottomWidth={1}
      borderBottomColor="$borderColorSoft"
      data-testid="place-rail-context-header"
    >
      {/* Same containment contract as the event rail: a long place name must
          clip to the rail rather than widen it. */}
      {name ? (
        <RailContextTitle title={name} testId="place-rail-context-title" />
      ) : null}
      {verification && isKnownStatus(verification) ? (
        <Badge
          tone={
            verification === "VERIFIED"
              ? "success"
              : verification === "PENDING"
                ? "warning"
                : "neutral"
          }
          size="sm"
        >
          {String(t(VERIFICATION_LABEL_KEYS[verification]))}
        </Badge>
      ) : null}
    </YStack>
  );
}

PlaceRailContextHeader.displayName = "PlaceRailContextHeader";
