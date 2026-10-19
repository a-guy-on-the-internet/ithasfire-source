import type { ReactElement } from "react";
import { Fragment } from "react";
import { XStack, YStack } from "tamagui";

import type { EventBody } from "@th/schema";
import { sanitizeAndNormalizeRichTextHtml } from "./sanitize";

import { Text } from "../tamagui/components";
import { hexToRgba } from "../tamagui/components/shared";
import { colorTokens } from "../tamagui/tokens/colors";

import { normalizeEventBodyToRendered } from "./normalize";
import type { RenderedEventPageBlock, RenderedEventPageSection } from "./types";

export type EventPageRendererProps = {
  content: EventBody | null | undefined;
  /** Map of image-id → public URL for resolving image blocks. */
  imageMap?: Record<string, string>;
};

const sectionOuterPaddingByDensity: Record<string, "$4" | "$6" | "$8"> = {
  tight: "$4",
  normal: "$6",
  loose: "$8",
};

const maxWidthByPreset: Record<string, number | string> = {
  prose: 720,
  wide: 1040,
  full: "100%",
};

const columnWidthsForRatio = (ratio: string): [number, number] => {
  switch (ratio) {
    case "33/67":
      return [1, 2];
    case "67/33":
      return [2, 1];
    case "50/50":
    default:
      return [1, 1];
  }
};

const spacerSizeMap: Record<string, "$2" | "$4" | "$8"> = {
  sm: "$2",
  md: "$4",
  lg: "$8",
};

const renderBlock = (
  block: RenderedEventPageBlock,
  imageMap: Record<string, string>,
): ReactElement => {
  switch (block.type) {
    case "richText":
      // Canonical rich text is stored as HTML. The server sanitizes on save,
      // but we sanitize again here so previews are safe even for unsaved drafts.
      return (
        <YStack gap="$2">
          <YStack
            // This is intentionally a div-like container for HTML rendering.
            // We sanitize + normalize first.
            dangerouslySetInnerHTML={{
              __html: sanitizeAndNormalizeRichTextHtml(block.html),
            }}
          />
        </YStack>
      );

    case "image": {
      const url = imageMap[block.id];
      if (!url) {
        // Image not resolvable — silently skip to avoid breaking layout.
        return <YStack />;
      }
      return (
        <YStack width="100%" alignItems="center">
          <img
            src={url}
            alt={block.alt ?? ""}
            style={{
              width: "100%",
              maxWidth: "100%",
              height: "auto",
              borderRadius: 0,
              objectFit: "cover",
              display: "block",
            }}
          />
        </YStack>
      );
    }

    case "spacer":
      return <YStack height={spacerSizeMap[block.size] ?? "$4"} />;

    case "cta":
      return (
        <YStack alignItems="center" paddingVertical="$2">
          <a
            href={block.href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-block",
              padding: "12px 32px",
              borderRadius: 0,
              fontWeight: 700,
              fontSize: 16,
              textDecoration: "none",
              textAlign: "center",
              color:
                block.variant === "secondary"
                  ? "var(--color, #1a1a1a)"
                  : "var(--surface, #ffffff)",
              backgroundColor:
                block.variant === "secondary"
                  ? "transparent"
                  : "var(--color, #1a1a1a)",
              border:
                block.variant === "secondary"
                  ? "2px solid var(--borderColorStrong, #1a1a1a)"
                  : "2px solid transparent",
            }}
          >
            {block.label}
          </a>
        </YStack>
      );

    case "unknown":
      return <YStack />;
  }
};

const renderSection = (
  section: RenderedEventPageSection,
  imageMap: Record<string, string>,
): ReactElement => {
  const padding = sectionOuterPaddingByDensity[section.style.density] ?? "$6";
  const maxWidth =
    maxWidthByPreset[section.style.maxWidth] ?? maxWidthByPreset.prose;
  const textAlign = section.style.textAlign === "center" ? "center" : "left";

  const backgroundColor =
    section.style.background === "muted"
      ? "$surfaceMuted"
      : section.style.background === "brand"
        ? // brand-orange tint (#FF5721) — previously mis-painted teal
          hexToRgba(colorTokens.color.brandSecondary, 0.08)
        : "transparent";

  return (
    <YStack
      width="100%"
      padding={padding}
      backgroundColor={backgroundColor}
      alignItems="center"
    >
      <YStack width="100%" maxWidth={maxWidth}>
        {section.layout.type === "singleColumn" ? (
          <YStack gap="$4" style={{ textAlign }}>
            {section.layout.columns[0].blocks.map((block) => (
              <Fragment key={block.id}>{renderBlock(block, imageMap)}</Fragment>
            ))}
          </YStack>
        ) : (
          (() => {
            const [leftWeight, rightWeight] = columnWidthsForRatio(
              section.layout.ratio,
            );
            const [left, right] = section.layout.columns;
            return (
              <XStack gap="$6" flexWrap="wrap" alignItems="flex-start">
                <YStack
                  flex={leftWeight}
                  gap="$4"
                  minWidth={260}
                  style={{ textAlign }}
                >
                  {left.blocks.map((block) => (
                    <Fragment key={block.id}>
                      {renderBlock(block, imageMap)}
                    </Fragment>
                  ))}
                </YStack>
                <YStack
                  flex={rightWeight}
                  gap="$4"
                  minWidth={260}
                  style={{ textAlign }}
                >
                  {right.blocks.map((block) => (
                    <Fragment key={block.id}>
                      {renderBlock(block, imageMap)}
                    </Fragment>
                  ))}
                </YStack>
              </XStack>
            );
          })()
        )}
      </YStack>
    </YStack>
  );
};

export function EventPageRenderer({
  content,
  imageMap = {},
}: EventPageRendererProps): ReactElement {
  const normalized = normalizeEventBodyToRendered(content ?? null);

  if (!normalized.ok) {
    return (
      <YStack
        padding="$4"
        gap="$2"
        borderRadius={0}
        backgroundColor={hexToRgba(colorTokens.color.danger, 0.08)}
      >
        <Text variant="subtitle" weight="bold">
          Invalid event body
        </Text>
        {/* Deliberate $mono: raw JSON diagnostics are code-like content —
            one of the two sanctioned $mono sites pinned by
            design-system-v2.test.ts. */}
        <Text variant="bodySmall" color="$colorMuted" fontFamily="$mono">
          {JSON.stringify(normalized.issues ?? {})}
        </Text>
      </YStack>
    );
  }

  const { sections } = normalized.body;

  if (!sections.length) {
    return (
      <YStack
        padding="$4"
        borderRadius={0}
        backgroundColor="$surfaceMuted"
      >
        <Text variant="body" color="$colorMuted">
          No page content yet.
        </Text>
      </YStack>
    );
  }

  return (
    <YStack width="100%" gap={0}>
      {sections.map((section) => (
        <Fragment key={section.id}>{renderSection(section, imageMap)}</Fragment>
      ))}
    </YStack>
  );
}
