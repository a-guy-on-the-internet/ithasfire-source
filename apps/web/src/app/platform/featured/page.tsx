"use client";

import { useCallback, useState } from "react";
import { XStack, YStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";
import { Star } from "lucide-react";

import { trpc } from "@/trpc";
import { ACCENT } from "@/lib/design-tokens";

import {
  FeaturedItemForm,
  type FeaturedItemFormData,
} from "./_components/FeaturedItemForm";
import { FeaturedItemList } from "./_components/FeaturedItemList";
import { Container, PageTitle, Subtitle } from "./_components/styled";

type ItemType = "EVENT" | "HUMAN" | "ORGANIZATION" | "PLACE";

const isInternalPath = (value: string): boolean => /^\/(?!\/)/.test(value);
const ctaPathHintKeyByType: Record<ItemType, string> = {
  EVENT: "admin.featuredCtaPathHintEvent",
  HUMAN: "admin.featuredCtaPathHintHuman",
  ORGANIZATION: "admin.featuredCtaPathHintOrg",
  PLACE: "admin.featuredCtaPathHintPlace",
};

export default function FeaturedItemsPage() {
  const t = useTranslations();
  const utils = trpc.useUtils();

  const listQuery = trpc.featuredItems.listAdmin.useQuery(
    { limit: 50, offset: 0 },
    { staleTime: 30_000 },
  );

  const [formError, setFormError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);

  const upsertMutation = trpc.featuredItems.upsert.useMutation({
    onSuccess: () => {
      void utils.featuredItems.list.invalidate();
      void utils.featuredItems.listAdmin.invalidate();
      setFormError(null);
      setResetSignal((value) => value + 1);
    },
  });

  const removeMutation = trpc.featuredItems.remove.useMutation({
    onSuccess: () => {
      void utils.featuredItems.list.invalidate();
      void utils.featuredItems.listAdmin.invalidate();
    },
  });

  const handleSubmit = useCallback(
    (data: FeaturedItemFormData) => {
      if (data.heroImageUrl && !isInternalPath(data.heroImageUrl)) {
        setFormError(String(t("admin.featuredHeroImagePathHint")));
        return;
      }

      if (data.ctaUrl && !isInternalPath(data.ctaUrl)) {
        setFormError(String(t(ctaPathHintKeyByType[data.itemType])));
        return;
      }

      setFormError(null);
      upsertMutation.mutate(data);
    },
    [t, upsertMutation],
  );

  const handleRemove = useCallback(
    (itemType: ItemType, itemId: string) => {
      removeMutation.mutate({ itemType, itemId });
    },
    [removeMutation],
  );

  const items = listQuery.data?.items ?? [];

  return (
    <Container>
      <YStack gap={4}>
        <XStack alignItems="center" gap={10}>
          <Star size={20} color={ACCENT} />
          <PageTitle>{String(t("admin.featuredPageTitle"))}</PageTitle>
        </XStack>
        <Subtitle>{String(t("admin.featuredPageSubtitle"))}</Subtitle>
      </YStack>

      <FeaturedItemForm
        onSubmit={handleSubmit}
        isPending={upsertMutation.isPending}
        mutationErrorMessage={
          upsertMutation.isError ? upsertMutation.error.message : null
        }
        validationErrorMessage={formError}
        resetSignal={resetSignal}
      />

      <FeaturedItemList
        items={items}
        isLoading={listQuery.isLoading}
        errorMessage={listQuery.isError ? listQuery.error.message : null}
        onRemove={handleRemove}
      />

      {removeMutation.isError && (
        <Text fontSize={13} color="$danger">
          {removeMutation.error.message}
        </Text>
      )}
    </Container>
  );
}
