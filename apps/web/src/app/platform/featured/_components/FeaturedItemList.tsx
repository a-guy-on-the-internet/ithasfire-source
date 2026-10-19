"use client";

import { useState, useCallback } from "react";
import { XStack, YStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";
import { Trash2 } from "lucide-react";

import {
  type ItemType,
  TYPE_BADGE_KEYS,
  SectionHeader,
  ItemCard,
  TypeBadge,
  StatusDot,
  RemoveButton,
  MonoText,
  EmptyState,
} from "./styled";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface FeaturedItem {
  id: string;
  itemType: ItemType;
  itemId: string;
  title: string | null;
  sortOrder: number;
  active: boolean;
}

export interface FeaturedItemListProps {
  items: FeaturedItem[];
  isLoading: boolean;
  errorMessage: string | null;
  onRemove: (itemType: ItemType, itemId: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function FeaturedItemList({
  items,
  isLoading,
  errorMessage,
  onRemove,
}: FeaturedItemListProps) {
  const t = useTranslations();
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const handleRemove = useCallback(
    (iType: ItemType, iId: string) => {
      onRemove(iType, iId);
      setConfirmRemoveId(null);
    },
    [onRemove],
  );

  return (
    <YStack gap={12}>
      <SectionHeader>
        <Text variant="kicker" tone="accent" style={{ marginRight: 8 }}>
          02.
        </Text>
        {String(t("admin.featuredPageTitle"))}
      </SectionHeader>

      {isLoading && (
        <Text tone="muted" fontSize={13}>
          {String(t("admin.featuredLoading"))}
        </Text>
      )}

      {errorMessage && (
        <EmptyState>
          <Text color="$danger" fontSize={14}>
            {String(t("admin.featuredLoadError"))}
          </Text>
          <Text tone="muted" fontSize={12}>
            {errorMessage}
          </Text>
        </EmptyState>
      )}

      {!isLoading && !errorMessage && items.length === 0 && (
        <EmptyState>
          <Text tone="muted" fontSize={14}>
            {String(t("admin.featuredEmpty"))}
          </Text>
        </EmptyState>
      )}

      <YStack gap={8}>
        {items.map((item) => {
          const isConfirming = confirmRemoveId === item.id;

          return (
            <ItemCard key={item.id}>
              {/* Type badge */}
              <TypeBadge itemType={item.itemType}>
                {String(t(TYPE_BADGE_KEYS[item.itemType]))}
              </TypeBadge>

              {/* Title */}
              <YStack flex={1} gap={2} minWidth={120}>
                <Text fontSize={14} weight="bold" color="$color">
                  {item.title ?? String(t("admin.featuredUntitled"))}
                </Text>
                <MonoText>{item.itemId.slice(0, 8)}…</MonoText>
              </YStack>

              {/* Sort order */}
              <MonoText>#{item.sortOrder}</MonoText>

              {/* Active status */}
              <XStack alignItems="center" gap={4}>
                <StatusDot active={item.active} />
                <Text
                  fontSize={11}
                  weight="bold"
                  textTransform="uppercase"
                  tone="muted"
                >
                  {item.active
                    ? String(t("admin.featuredStatusOn"))
                    : String(t("admin.featuredStatusOff"))}
                </Text>
              </XStack>

              {/* Remove */}
              {isConfirming ? (
                <XStack gap={6} alignItems="center">
                  <Text fontSize={12} tone="muted">
                    {String(t("admin.featuredRemoveConfirm"))}
                  </Text>
                  <RemoveButton
                    onPress={() => handleRemove(item.itemType, item.itemId)}
                    aria-label={String(t("admin.featuredRemove"))}
                  >
                    <Trash2 size={12} aria-hidden />
                    <Text
                      fontSize={11}
                      weight="bold"
                      tone="inherit"
                      textTransform="uppercase"
                    >
                      {String(t("admin.featuredRemove"))}
                    </Text>
                  </RemoveButton>
                  <button
                    type="button"
                    onClick={() => setConfirmRemoveId(null)}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "inherit",
                      fontSize: 12,
                      textDecoration: "underline",
                    }}
                  >
                    {String(t("admin.featuredCancel"))}
                  </button>
                </XStack>
              ) : (
                <RemoveButton
                  onPress={() => setConfirmRemoveId(item.id)}
                  aria-label={String(t("admin.featuredRemove"))}
                >
                  <Trash2 size={12} aria-hidden />
                </RemoveButton>
              )}
            </ItemCard>
          );
        })}
      </YStack>
    </YStack>
  );
}
