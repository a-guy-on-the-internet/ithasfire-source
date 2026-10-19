"use client";

import { YStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";

import { AsksList } from "@/components/volunteering/AsksList";

type PlaceVolunteersViewProps = {
  slug: string;
  placeId: string;
};

/**
 * Place volunteers tab (generic-volunteering-asks): PLACE-subject asks for
 * a standing pool of venue help. Rendered inside the place detail layout's
 * tab bar; management links go to the shared ask manage page.
 */
export function PlaceVolunteersView({ slug, placeId }: PlaceVolunteersViewProps) {
  const t = useTranslations();

  return (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      <YStack gap="$1">
        <Text tag="h2" variant="h3" weight="bold">
          {String(t("volunteering.placeAsksTitle"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("volunteering.placeAsksSubtitle"))}
        </Text>
      </YStack>
      <AsksList slug={slug} subject={{ kind: "place", placeId }} />
    </YStack>
  );
}
