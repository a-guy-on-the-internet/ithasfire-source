"use client";

import { useId } from "react";
import { XStack } from "tamagui";

import { Button, Text, useTranslations } from "@th/ui";

import {
  DESCRIPTION_STARTER_KINDS,
  type DescriptionStarterKind,
} from "./description-starters";

/**
 * One quiet row under the description heading: "Start from  Open mic ·
 * Comedy night · …". Rendered only while the description is empty; the
 * parent hides it the moment there is content.
 */
export function DescriptionStarters({
  onPick,
  suggestedStarter = null,
}: {
  onPick: (kind: DescriptionStarterKind) => void;
  /** The kind that fits the event's category: listed first, one step up from
   * ghost. Nothing is inserted until the organiser presses it. */
  suggestedStarter?: DescriptionStarterKind | null;
}) {
  const t = useTranslations();
  const labelId = useId();
  const kinds = suggestedStarter
    ? [
        suggestedStarter,
        ...DESCRIPTION_STARTER_KINDS.filter((k) => k !== suggestedStarter),
      ]
    : DESCRIPTION_STARTER_KINDS;

  return (
    <XStack
      role="group"
      aria-labelledby={labelId}
      gap={4}
      flexWrap="wrap"
      alignItems="center"
      data-testid="description-starters"
    >
      <Text id={labelId} variant="bodySmall" color="$textMuted">
        {String(t("admin.ebStarterLabel"))}
      </Text>
      {kinds.map((kind) => (
        <Button
          key={kind}
          variant={kind === suggestedStarter ? "secondary" : "ghost"}
          data-suggested={kind === suggestedStarter ? "true" : undefined}
          size="$2"
          minHeight={44}
          onPress={() => onPick(kind)}
          data-testid={`description-starter-${kind}`}
        >
          {String(t(`admin.ebStarter${kind}Name`))}
        </Button>
      ))}
    </XStack>
  );
}
