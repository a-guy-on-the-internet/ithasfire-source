"use client";

import { ChevronRight } from "lucide-react";
import { styled, XStack, YStack } from "tamagui";

import { Text, useTranslations } from "@th/ui";

import {
  sectionPriceText,
  type FormatCents,
  type SeatPriceTranslate,
} from "./seat-price-labels";
import type { SectionModel } from "./seat-price-model";

/**
 * A section in the sidebar's list. Borders overlap by a pixel so a stack of
 * cards shares its rules; the active one lifts its accent border on top.
 */
const SectionCard = styled(XStack, {
  name: "SeatPriceSectionCard",
  tag: "button",
  width: "100%",
  alignItems: "center",
  gap: 12,
  minHeight: 44,
  padding: 12,
  borderWidth: 1,
  borderColor: "$borderColorSoft",
  borderRadius: 0,
  backgroundColor: "transparent",
  cursor: "pointer",
  hoverStyle: { borderColor: "$accent", zIndex: 1 },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$focus",
    outlineOffset: -2,
    zIndex: 2,
  },
  variants: {
    active: {
      true: {
        borderColor: "$accent",
        backgroundColor: "$surfaceMuted",
        zIndex: 1,
      },
    },
  } as const,
});

export type SeatPriceSectionNavProps = {
  sections: SectionModel[];
  activeSectionId: string | null;
  /** Show the section: the List opens and scrolls to it; the Map (5b-2) frames it. */
  onSelectSection: (sectionId: string) => void;
  formatCents: FormatCents;
  /** Say "not on the map, use List". Off until the Map view exists. */
  showMapHints: boolean;
};

/** The sidebar's list of sections, shared by the List and Map views. */
export function SeatPriceSectionNav({
  sections,
  activeSectionId,
  onSelectSection,
  formatCents,
  showMapHints,
}: SeatPriceSectionNavProps) {
  const t = useTranslations();
  return (
    <nav aria-label={String(t("admin.seatPricesSectionsLabel"))}>
      <YStack>
        {sections.map((section, index) => {
          const active = section.id === activeSectionId;
          return (
            <SectionCard
              key={section.id}
              {...({ type: "button" } as object)}
              active={active}
              aria-current={active ? "true" : undefined}
              marginTop={index === 0 ? 0 : -1}
              onPress={() => onSelectSection(section.id)}
              data-testid={`seat-price-section-nav-${section.id}`}
            >
              <YStack tag="span" flex={1} minWidth={0} gap={2}>
                <Text variant="bodySmall" weight="bold" textAlign="left">
                  {section.name}
                </Text>
                <Text variant="caption" tone="muted" textAlign="left">
                  {navMeta(section, formatCents, showMapHints, t)}
                </Text>
              </YStack>
              <ChevronRight size={16} aria-hidden />
            </SectionCard>
          );
        })}
      </YStack>
    </nav>
  );
}

SeatPriceSectionNav.displayName = "SeatPriceSectionNav";

/** "70 seats · Standard $45.00 · 3 custom prices" */
function navMeta(
  section: SectionModel,
  formatCents: FormatCents,
  showMapHints: boolean,
  t: SeatPriceTranslate,
): string {
  const parts = [
    String(t("admin.seatPricesSeatCount", { count: section.seatCount })),
  ];
  const fixed = section.fixedPrice;
  if (section.setRefusal === "ADJUSTABLE_TIER") {
    parts.push(
      [
        ...section.payWhatYouWantTypes.map((type) => type.name),
        String(t("admin.seatPricesPayWhatYouWant")),
      ].join(", "),
    );
  } else if (fixed?.ticketTypes.length === 1) {
    parts.push(`${fixed.ticketTypes[0]!.name} ${formatCents(fixed.minCents)}`);
  } else {
    const price = sectionPriceText(section, formatCents, t);
    if (price) parts.push(price);
  }
  if (section.customCount > 0) {
    parts.push(
      String(
        t("admin.seatPricesCustomPriceCount", { count: section.customCount }),
      ),
    );
  }
  if (showMapHints && !section.onMap) {
    parts.push(String(t("admin.seatPricesNotOnMapUseList")));
  }
  return parts.join(" · ");
}
