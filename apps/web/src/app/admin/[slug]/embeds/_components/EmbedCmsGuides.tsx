"use client";

import {
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import { YStack, XStack } from "tamagui";
import { Text, Button, useTranslations } from "@th/ui";
import { ChevronDown, ChevronUp } from "lucide-react";

import { EmbedCodeBlock } from "@/components/embeds/EmbedCodeBlock";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

const STORAGE_KEY = "hf-embed-guides-open";

type Platform = "wordpress" | "squarespace" | "wix" | "shopify" | "other";

interface PlatformConfig {
  label: string;
  icon: string;
  steps: string[];
  note?: string;
}

type Translate = ReturnType<typeof useTranslations>;

/**
 * Platform names (WordPress, Squarespace…) are product names and stay
 * literal; every step and note is catalog copy, so a Spanish page reads
 * Spanish end to end.
 */
function buildPlatforms(
  t: Translate,
  siteUrl: string,
): Record<Platform, PlatformConfig> {
  return {
    wordpress: {
      label: "WordPress",
      icon: "🔷",
      steps: [
        String(t("admin.embedGuideWpStep1")),
        String(t("admin.embedGuideWpStep2")),
        String(t("admin.embedGuideWpStep3")),
        String(t("admin.embedGuideWpStep4")),
      ],
      note: String(t("admin.embedGuideWpNote")),
    },
    squarespace: {
      label: "Squarespace",
      icon: "⬛",
      steps: [
        String(t("admin.embedGuideSqStep1")),
        String(t("admin.embedGuideSqStep2")),
        String(t("admin.embedGuideSqStep3")),
        String(t("admin.embedGuideSqStep4")),
      ],
      note: String(t("admin.embedGuideSqNote")),
    },
    wix: {
      label: "Wix",
      icon: "🟧",
      steps: [
        String(t("admin.embedGuideWixStep1")),
        String(t("admin.embedGuideWixStep2")),
        String(t("admin.embedGuideWixStep3")),
        String(t("admin.embedGuideWixStep4")),
      ],
    },
    shopify: {
      label: "Shopify",
      icon: "🟩",
      steps: [
        String(t("admin.embedGuideShopifyStep1")),
        String(t("admin.embedGuideShopifyStep2")),
        String(t("admin.embedGuideShopifyStep3")),
        String(t("admin.embedGuideShopifyStep4")),
      ],
      note: String(t("admin.embedGuideShopifyNote")),
    },
    other: {
      // Short enough for one guide tab at 320 (the full "Other / Custom
      // HTML" ran past the card).
      label: String(t("admin.embedGuideOtherLabel")),
      icon: "🌐",
      steps: [
        String(t("admin.embedGuideOtherStep1")),
        String(t("admin.embedGuideOtherStep2")),
        String(t("admin.embedGuideOtherStep3", { siteUrl })),
        String(t("admin.embedGuideOtherStep4")),
      ],
    },
  };
}

const PLATFORM_TABS: Platform[] = [
  "wordpress",
  "squarespace",
  "wix",
  "shopify",
  "other",
];

interface EmbedCmsGuidesProps {
  htmlSnippet: string;
  siteUrl: string;
  /**
   * The domain this block's snippet is for. The Embeds page renders one
   * guides block per domain, open by default, so the toggle, the platform
   * group and the copy button carry it to keep accessible names unique.
   */
  domain?: string;
}

export function EmbedCmsGuides({
  htmlSnippet,
  siteUrl,
  domain,
}: EmbedCmsGuidesProps) {
  const t = useTranslations();
  // Open by default: a place owner pasting into Squarespace or Wix needs the
  // steps more than the page needs the space. A stored choice still wins.
  const [isOpen, setIsOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<Platform>("wordpress");
  const [copied, setCopied] = useState(false);
  const platforms = useMemo(
    () => buildPlatforms(t, siteUrl),
    [t, siteUrl],
  );

  // Read the stored open state from localStorage (client-only). Only an
  // explicit choice changes the default; no key means open. Layout effect, so
  // a stored "closed" applies before the browser paints the open panel.
  useLayoutEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "false") setIsOpen(false);
    } catch {
      // localStorage unavailable — keep the default (open)
    }
  }, []);

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  // The snippet can change under a live checkmark (switching the booking
  // Display mode rebuilds it), which would leave "Copied!" pointing at markup
  // the organiser never copied.
  useEffect(() => setCopied(false), [htmlSnippet]);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(htmlSnippet)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(traceIgnoredError("embed.cmsGuides.clipboardWrite"));
  }, [htmlSnippet]);

  const platform = platforms[activeTab];

  return (
    <div
      style={{
        borderTop: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
        marginTop: 4,
      }}
    >
      {/* Collapse toggle */}
      <button
        type="button"
        onClick={toggleOpen}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 0 12px 0",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "inherit",
          textAlign: "left",
        }}
        aria-expanded={isOpen}
        aria-label={
          domain
            ? String(t("admin.embedGuideHeadingFor", { domain }))
            : undefined
        }
      >
        <XStack
          gap="$2"
          alignItems="center"
          flexWrap="wrap"
          flexShrink={1}
          minWidth={0}
        >
          <Text variant="body" weight="bold">
            {String(t("admin.embedGuideHeading"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("admin.embedGuidePlatforms"))}
          </Text>
        </XStack>
        {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {/* Collapsible content */}
      {isOpen && (
        <YStack gap="$4" paddingBottom="$4">
          {/* Tab bar */}
          <XStack
            gap="$1"
            flexWrap="wrap"
            role="group"
            aria-label={
              domain
                ? String(t("admin.embedSiteBuildersFor", { domain }))
                : String(t("admin.embedSiteBuilders"))
            }
          >
            {PLATFORM_TABS.map((p) => (
              <Button
                key={p}
                size="$2"
                variant={activeTab === p ? "secondary" : "ghost"}
                onPress={() => setActiveTab(p)}
                aria-pressed={activeTab === p}
              >
                <Text variant="caption" tone="inherit" weight="bold">
                  {platforms[p].icon} {platforms[p].label}
                </Text>
              </Button>
            ))}
          </XStack>

          {/* Step list */}
          <YStack gap="$2">
            {platform.steps.map((step, i) => (
              <XStack key={i} gap="$2" alignItems="flex-start">
                <div
                  style={{
                    minWidth: 22,
                    height: 22,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "1.5px solid var(--brandSecondary, #E2481D)",
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                >
                  <Text
                    variant="caption"
                    weight="bold"
                    style={{
                      color: "var(--brandSecondary, #E2481D)",
                      fontSize: 11,
                    }}
                  >
                    {i + 1}
                  </Text>
                </div>
                <Text variant="body">{step}</Text>
              </XStack>
            ))}
            {platform.note && (
              <Text variant="caption" tone="muted" paddingLeft="$6">
                {String(t("admin.embedGuideNote", { note: platform.note }))}
              </Text>
            )}
          </YStack>

          {/* Code block — the same snippet chrome the EmbedCard above renders.
              Shares `EmbedCodeBlock` rather than forking it, so both blocks on
              this page stay byte-identical (and the code-editor palette lives
              in exactly one place). */}
          <EmbedCodeBlock
            code={htmlSnippet}
            isCopied={copied}
            onCopy={handleCopy}
            copyLabel={
              domain
                ? String(
                    t(
                      copied
                        ? "admin.embedGuideCopiedFor"
                        : "admin.embedGuideCopyFor",
                      { domain },
                    ),
                  )
                : copied
                  ? String(t("admin.embedGuideCopied"))
                  : String(t("admin.embedGuideCopy"))
            }
          />

          {/* Last verified */}
          <Text variant="caption" tone="muted">
            {String(t("admin.embedGuideLastVerified"))}
          </Text>
        </YStack>
      )}
    </div>
  );
}
