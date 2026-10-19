"use client";

import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { styled, XStack, YStack } from "tamagui";

import { Text, useTranslations } from "@th/ui";

import type {
  EventReadiness,
  ReadinessItem,
  ReadinessItemId,
} from "./event-readiness";

/**
 * Publish-readiness rail (FR-104). Presentational only — the caller derives
 * `readiness` via `computeEventReadiness(mapReadinessInput(state).input)` and
 * passes the deep-link handlers; no gating logic lives here (FR-105).
 *
 * Two variants:
 * - `rail`: the sticky desktop card ("Ready to publish?" header + mono
 *   counter + fixed-order checklist).
 * - `summary`: the mobile disclosure — collapsed to "N of M ready · next: X",
 *   expanding to the same checklist. Plain conditional render, nothing to
 *   suppress under prefers-reduced-motion.
 *
 * Strict Swiss: radius 0, 2px borders, uppercase bold header, mono marks.
 * The numbered blocker marks use `$accentText` (accent at label legibility —
 * `$accent` itself fails AA as small text on Stub).
 */

type ScrollSectionId = "essentials" | "category" | "details" | "ticketTypes";

const SCROLL_SECTION_IDS: ReadonlyArray<ScrollSectionId> = [
  "essentials",
  "category",
  "details",
  "ticketTypes",
];

const isScrollSection = (id: ReadinessItemId): id is ScrollSectionId =>
  (SCROLL_SECTION_IDS as ReadonlyArray<ReadinessItemId>).includes(id);

const LABEL_KEYS: Record<ReadinessItemId, string> = {
  essentials: "admin.ebReadinessItemEssentials",
  category: "admin.ebReadinessItemCategory",
  details: "admin.ebReadinessItemDetails",
  ticketTypes: "admin.ebReadinessItemTickets",
  lineup: "admin.ebReadinessItemLineup",
  stripePayouts: "admin.ebReadinessItemStripe",
  chargebackTerms: "admin.ebReadinessItemTerms",
  hostAttestation: "admin.ebReadinessItemAttestation",
};

const DESCRIPTION_KEYS: Partial<Record<ReadinessItemId, string>> = {
  essentials: "admin.ebReadinessItemEssentialsDesc",
  category: "admin.ebReadinessItemCategoryDesc",
  details: "admin.ebReadinessItemDetailsDesc",
  ticketTypes: "admin.ebReadinessItemTicketsDesc",
  stripePayouts: "admin.ebReadinessItemStripeDesc",
  chargebackTerms: "admin.ebReadinessItemTermsDesc",
  hostAttestation: "admin.ebReadinessItemAttestationDesc",
};

// Action copy: the Stripe/terms items reuse the exact strings their banners
// used, so the deep-links read identically after the swap (FR-105).
const ACTION_KEYS: Partial<Record<ReadinessItemId, string>> = {
  essentials: "admin.ebReadinessActionGo",
  category: "admin.ebReadinessActionGo",
  details: "admin.ebReadinessActionGo",
  ticketTypes: "admin.ebReadinessActionGo",
  stripePayouts: "admin.ebStripeConnectBannerAction",
  chargebackTerms: "admin.ebChargebackTermsBannerAction",
  hostAttestation: "admin.ebReadinessActionConfirm",
};

const Card = styled(YStack, {
  width: "100%",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
});

const CardHeader = styled(XStack, {
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
});

/** Mobile collapsed header — a real <button> (WAI-ARIA disclosure). */
const SummaryToggle = styled(XStack, {
  tag: "button",
  width: "100%",
  alignItems: "center",
  gap: 10,
  paddingVertical: 12,
  paddingHorizontal: 16,
  minHeight: 52,
  cursor: "pointer",
  userSelect: "none",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  pressStyle: { backgroundColor: "$surfaceMuted" },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: -2,
  },
});

const ItemRow = styled(XStack, {
  gap: 12,
  alignItems: "flex-start",
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderBottomWidth: 1,
  borderBottomColor: "$borderColorSoft",
});

/** Mono mark square: ✓ for done, blocker index for todo, empty for info. */
const ItemMark = styled(YStack, {
  width: 24,
  height: 24,
  alignItems: "center",
  justifyContent: "center",
  borderWidth: 2,
  borderRadius: 0,
  flexShrink: 0,
  variants: {
    kind: {
      done: { borderColor: "$borderColorSoft" },
      todo: { borderColor: "$accentText" },
      info: { borderColor: "$borderColorSoft" },
    },
  } as const,
});

/**
 * Trailing uppercase action affordance. `margin-left: auto` pins it to the
 * row end (the sanctioned auto-margin pinning exception).
 */
const ActionLink = styled(XStack, {
  tag: "button",
  alignItems: "center",
  marginLeft: "auto",
  paddingVertical: 4,
  paddingHorizontal: 0,
  cursor: "pointer",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  flexShrink: 0,
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
});

const actionTextProps = {
  variant: "caption" as const,
  weight: "bold" as const,
  color: "$accentText",
  letterSpacing: 1.2,
  textTransform: "uppercase" as const,
};

export type PublishReadinessRailProps = {
  readiness: EventReadiness;
  /** Omit the Stripe item entirely (status unknowable — mirrors banner silence). */
  hideStripeItem: boolean;
  /** `/admin/{slug}/payouts` — the Stripe item's deep-link. */
  paymentsHref: string;
  /** Scroll the corresponding builder section into view. */
  onJumpToSection: (sectionId: ScrollSectionId) => void;
  /** Opens the existing standalone chargeback-terms dialog. */
  onOpenChargebackTerms: () => void;
  /** Opens the existing host-attestation dialog (shared with the publish flow). */
  onOpenHostAttestation: () => void;
  variant: "rail" | "summary";
  /** DOM id for the checklist — `aria-describedby` target for the Publish CTA. */
  listId?: string;
};

export function PublishReadinessRail({
  readiness,
  hideStripeItem,
  paymentsHref,
  onJumpToSection,
  onOpenChargebackTerms,
  onOpenHostAttestation,
  variant,
  listId,
}: PublishReadinessRailProps) {
  const t = useTranslations();
  const regionId = useId();
  const [expanded, setExpanded] = useState(false);

  const { items, doneCount, totalCount, blockerNumbers, firstBlocker } =
    useMemo(() => {
      const visible = readiness.items.filter(
        (item) => !(item.id === "stripePayouts" && hideStripeItem),
      );
      // Counter counts non-info items only — the "Lineup — optional" nudge
      // never inflates N or M.
      const counted = visible.filter((item) => item.status !== "info");
      // Numbered marks: 1,2,… across unmet blocking items, in display order.
      const numbers = new Map<ReadinessItemId, number>();
      for (const item of visible) {
        if (item.blocking && item.status === "todo") {
          numbers.set(item.id, numbers.size + 1);
        }
      }
      const first =
        visible.find((item) => item.blocking && item.status === "todo") ?? null;
      return {
        items: visible,
        doneCount: counted.filter((item) => item.status === "done").length,
        totalCount: counted.length,
        blockerNumbers: numbers,
        firstBlocker: first,
      };
    }, [readiness.items, hideStripeItem]);

  const renderAction = (item: ReadinessItem) => {
    const actionKey = ACTION_KEYS[item.id];
    if (!actionKey) return null;
    const label = String(t(actionKey));

    if (item.id === "stripePayouts") {
      return (
        <a
          href={paymentsHref}
          style={{
            textDecoration: "none",
            marginLeft: "auto",
            flexShrink: 0,
            display: "inline-flex",
          }}
          data-testid="readiness-action-stripePayouts"
        >
          <Text {...actionTextProps} tag="span">
            {label}
          </Text>
        </a>
      );
    }

    const onPress =
      item.id === "chargebackTerms"
        ? onOpenChargebackTerms
        : item.id === "hostAttestation"
          ? onOpenHostAttestation
          : isScrollSection(item.id)
            ? () => onJumpToSection(item.id as ScrollSectionId)
            : undefined;
    if (!onPress) return null;

    return (
      <ActionLink
        onPress={onPress}
        data-testid={`readiness-action-${item.id}`}
      >
        <Text {...actionTextProps}>{label}</Text>
      </ActionLink>
    );
  };

  const renderItem = (item: ReadinessItem) => {
    const isTodo = item.blocking && item.status === "todo";
    const isInfo = item.status === "info";
    const label = String(
      t(
        isInfo && item.id === "lineup"
          ? "admin.ebReadinessItemLineupOptional"
          : LABEL_KEYS[item.id],
      ),
    );
    const descriptionKey = DESCRIPTION_KEYS[item.id];

    return (
      <ItemRow
        key={item.id}
        role="listitem"
        data-testid={`readiness-item-${item.id}`}
        data-status={item.status}
      >
        <ItemMark kind={isTodo ? "todo" : isInfo ? "info" : "done"}>
          {isTodo ? (
            <Text
              fontFamily="$mono"
              fontSize={12}
              weight="bold"
              color="$accentText"
              aria-hidden
            >
              {blockerNumbers.get(item.id)}
            </Text>
          ) : item.status === "done" ? (
            <Text fontFamily="$mono" fontSize={12} tone="muted" aria-hidden>
              ✓
            </Text>
          ) : null}
        </ItemMark>
        <YStack gap={2} flexShrink={1} minWidth={0}>
          <Text
            variant="bodySmall"
            weight={isTodo ? "bold" : "regular"}
            tone={isTodo ? undefined : "muted"}
          >
            {label}
          </Text>
          {isTodo && descriptionKey ? (
            <Text variant="caption" tone="muted">
              {String(t(descriptionKey))}
            </Text>
          ) : null}
        </YStack>
        {isTodo ? renderAction(item) : null}
      </ItemRow>
    );
  };

  const counter = String(
    t("admin.ebReadinessCounter", { done: doneCount, total: totalCount }),
  );

  const list = (
    <YStack id={listId} role="list">
      {items.map(renderItem)}
    </YStack>
  );

  if (variant === "summary") {
    return (
      <Card data-testid="publish-readiness-summary">
        <SummaryToggle
          onPress={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-controls={regionId}
          data-testid="readiness-summary-toggle"
        >
          <YStack gap={2} flex={1} minWidth={0} alignItems="flex-start">
            <Text
              variant="bodySmall"
              weight="bold"
              fontSize={12}
              letterSpacing={1.2}
              textTransform="uppercase"
              style={{ textAlign: "left" }}
            >
              {String(t("admin.ebReadinessTitle"))}
            </Text>
            <Text
              variant="caption"
              tone="muted"
              fontFamily="$mono"
              truncate
              style={{ maxWidth: "100%" }}
            >
              {String(
                t("admin.ebReadinessSummaryReady", {
                  done: doneCount,
                  total: totalCount,
                }),
              )}
              {firstBlocker
                ? ` · ${String(
                    t("admin.ebReadinessSummaryNext", {
                      label: String(t(LABEL_KEYS[firstBlocker.id])),
                    }),
                  )}`
                : ""}
            </Text>
          </YStack>
          {expanded ? (
            <ChevronDown size={18} aria-hidden style={{ flexShrink: 0 }} />
          ) : (
            <ChevronRight size={18} aria-hidden style={{ flexShrink: 0 }} />
          )}
        </SummaryToggle>
        {expanded && (
          <YStack
            id={regionId}
            role="region"
            aria-label={String(t("admin.ebReadinessTitle"))}
            borderTopWidth={2}
            borderTopColor="$borderColor"
          >
            {list}
          </YStack>
        )}
      </Card>
    );
  }

  return (
    <Card
      role="region"
      aria-label={String(t("admin.ebReadinessTitle"))}
      data-testid="publish-readiness-rail"
    >
      <CardHeader>
        <Text
          variant="bodySmall"
          weight="bold"
          fontSize={12}
          letterSpacing={1.2}
          textTransform="uppercase"
        >
          {String(t("admin.ebReadinessTitle"))}
        </Text>
        <Text variant="caption" tone="muted" fontFamily="$mono" flexShrink={0}>
          {counter}
        </Text>
      </CardHeader>
      {list}
    </Card>
  );
}

PublishReadinessRail.displayName = "PublishReadinessRail";
