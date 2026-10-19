"use client";

import type { CSSProperties, ReactNode } from "react";
import { XStack, YStack } from "tamagui";
import { Badge, Button, Text } from "@th/ui";
import {
  AlertTriangle,
  RefreshCw,
  ScanEye,
  ShieldQuestion,
} from "lucide-react";

import {
  categoryLabel,
  describeProviderBand,
  formatThreshold,
  resolveProviderStatus,
  splitCategoryThresholds,
  type ProviderBandTone,
} from "./image-moderation-ops.helpers";

/**
 * The most important thing on the page: WHAT is scanning uploads right now.
 *
 * Three real answers and two non-answers, and the band looks different for
 * each class. The rule this component exists to enforce is negative — it must
 * never render a provider value it did not receive. "stub" shown while the
 * jobs service is unreachable would read as "we checked, nothing is scanning,
 * that's expected", which is the single worst thing this page could say.
 *
 * `unknown` is deliberately NOT amber. Amber here means "configured, and you
 * need to know about it" (stub / fail-closed). A dashed rule and a question
 * mark mean "no answer", which is a different thing an operator acts on
 * differently (go look at the jobs service, not at the moderation config) —
 * so that state carries its OWN retry, rather than making the operator guess
 * that the page-level Refresh covers it.
 *
 * THE SEVERITY HISTOGRAM RIDES ALONG (the `histogram` slot). It is evidence for
 * the threshold this band prints, so it belongs to the claim rather than to a
 * section of its own — and it renders even on the `unknown` band, where the
 * distribution is still readable and only the threshold mark is missing.
 */

/**
 * Threshold cards only ever render for a genuine override, so the track can
 * be narrow. `min(Xpx, 100%)` rather than a bare floor: the platform shell's
 * rail means the content box is not a function of viewport width, and a bare
 * floor overflows the moment the container is narrower than it.
 */
const CATEGORY_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(min(140px, 100%), 1fr))",
  gap: 12,
  width: "100%",
};

/** An icon beside wrapping text is a flex item and WILL be squeezed to 0. */
const ICON: CSSProperties = { flexShrink: 0 };

const TABULAR: CSSProperties = { fontVariantNumeric: "tabular-nums" };

type BandChrome = {
  borderColor: string;
  borderStyle: "solid" | "dashed";
  backgroundColor: string;
  iconColor: string;
  badgeTone: "neutral" | "warning";
};

const BAND_CHROME: Record<ProviderBandTone, BandChrome> = {
  neutral: {
    borderColor: "$borderColor",
    borderStyle: "solid",
    backgroundColor: "$surface",
    iconColor: "var(--color, #211C16)",
    badgeTone: "neutral",
  },
  warning: {
    borderColor: "$warning",
    borderStyle: "solid",
    backgroundColor: "$surfaceMuted",
    iconColor: "var(--warning, #92400E)",
    badgeTone: "warning",
  },
  unknown: {
    borderColor: "$borderColorSoft",
    borderStyle: "dashed",
    backgroundColor: "$surfaceMuted",
    iconColor: "var(--colorMuted, #5C544A)",
    badgeTone: "neutral",
  },
};

export type ProviderBandProps = {
  /** `platformJobs.getModerationConfig` payload, or undefined when unreadable. */
  config:
    | {
        provider: string;
        reviewThreshold: number;
        categoryThresholds: Record<string, number>;
      }
    | undefined;
  isLoading: boolean;
  /** Re-reads the scanner configuration. Surfaced on the `unknown` band. */
  onRetry: () => void;
  isRetrying: boolean;
  /**
   * The severity histogram. A slot rather than props so this component keeps
   * knowing only about the provider; the chart owns its own states.
   */
  histogram?: ReactNode;
};

export function ProviderBand({
  config,
  isLoading,
  onRetry,
  isRetrying,
  histogram,
}: ProviderBandProps) {
  const status = resolveProviderStatus({
    provider: config?.provider,
    isLoading,
  });
  const copy = describeProviderBand(status);
  const chrome = BAND_CHROME[copy.tone];

  // Thresholds render only alongside a provider we ACTUALLY RECEIVED. Gating
  // on `config !== undefined` alone was the weaker check the docblock above
  // already claimed not to make: numbers with no named provider to attach
  // them to invite exactly the inference this band exists to prevent.
  const showThresholds =
    config !== undefined && status !== "unknown" && status !== "loading";

  const categories = config
    ? splitCategoryThresholds(config.reviewThreshold, config.categoryThresholds)
    : null;

  const Icon =
    copy.tone === "warning"
      ? AlertTriangle
      : copy.tone === "unknown"
        ? ShieldQuestion
        : ScanEye;

  return (
    <YStack
      role="region"
      aria-label="Scanner configuration"
      borderWidth={2}
      borderRadius={0}
      borderColor={chrome.borderColor}
      borderStyle={chrome.borderStyle}
      backgroundColor={chrome.backgroundColor}
      padding="$4"
      gap="$3"
      flexShrink={1}
      minWidth={0}
    >
      <XStack
        gap="$3"
        alignItems="flex-start"
        flexWrap="wrap"
        flexShrink={1}
        minWidth={0}
      >
        <Icon size={20} color={chrome.iconColor} style={ICON} aria-hidden />
        {/* minWidth 0, NOT a pixel floor: a floor wider than the content box
            is an overflow, and at 320px inside the platform rail this box is
            ~200px. */}
        <YStack gap="$1" flex={1} flexShrink={1} minWidth={0}>
          <Text variant="bodySmall" weight="bold">
            {copy.headline}
          </Text>
          <Text variant="caption" tone="muted">
            {copy.detail}
          </Text>
        </YStack>
        <Badge tone={chrome.badgeTone} size="md" variant="outline">
          {copy.value}
        </Badge>
      </XStack>

      {copy.tone === "unknown" && status === "unknown" ? (
        <XStack flexShrink={1} minWidth={0}>
          <Button
            variant="secondary"
            size="$2"
            aria-label="Re-read the scanner configuration"
            disabled={isRetrying}
            onPress={onRetry}
          >
            <RefreshCw size={13} aria-hidden />
            {isRetrying ? "Checking…" : "Check again"}
          </Button>
        </XStack>
      ) : null}

      {showThresholds && config && categories ? (
        <YStack gap="$2" flexShrink={1} minWidth={0}>
          <XStack
            gap="$2"
            alignItems="baseline"
            flexWrap="wrap"
            flexShrink={1}
            minWidth={0}
          >
            <Text variant="overline" tone="muted">
              Review threshold
            </Text>
            <Text variant="bodySmall" weight="bold" style={TABULAR}>
              {formatThreshold(config.reviewThreshold)}
            </Text>
          </XStack>

          <Text variant="caption" tone="muted">
            {categories.uniform
              ? "Severity is 0–6; every category holds an image at or above this. No per-category overrides."
              : "Severity is 0–6; a category scoring at or above its threshold holds the image for a human. Categories below differ from the review threshold."}
          </Text>

          {/* Only genuine overrides get a card. Four boxes all reading "4" is
              noise that buries the headline — which, on the stub/fail-closed
              bands, is the actual alarm. */}
          {categories.overrides.length > 0 ? (
            <div style={CATEGORY_GRID}>
              {categories.overrides.map((entry) => (
                <YStack
                  key={entry.category}
                  gap="$1"
                  paddingVertical="$2"
                  paddingHorizontal="$3"
                  borderWidth={1}
                  borderRadius={0}
                  borderColor="$borderColorSoft"
                  backgroundColor="$surface"
                  minWidth={0}
                >
                  <Text variant="overline" tone="muted" truncate>
                    {categoryLabel(entry.category)}
                  </Text>
                  {/* `tag="span"`: a threshold VALUE is data, not a document
                      heading — the h4 variant is borrowed for its scale. */}
                  <Text variant="h4" tag="span" weight="bold" style={TABULAR}>
                    {entry.value === null
                      ? "unknown"
                      : formatThreshold(entry.value)}
                  </Text>
                </YStack>
              ))}
            </div>
          ) : null}
        </YStack>
      ) : null}

      {histogram ? (
        <YStack
          gap="$2"
          paddingTop="$3"
          borderTopWidth={1}
          borderColor="$borderColorSoft"
          flexShrink={1}
          minWidth={0}
        >
          {histogram}
        </YStack>
      ) : null}
    </YStack>
  );
}
