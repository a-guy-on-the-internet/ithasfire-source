"use client";

import { useCallback, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { Text as TamaguiText, XStack, YStack, styled } from "tamagui";
import { AlertCircle, Check, Trash2 } from "lucide-react";
import { Button, Text, useTranslations } from "@th/ui";
import { parseEmbedUrl } from "@th/core/lib/embeds";
import { MediaEmbed as MediaEmbedRenderer } from "@/components/embeds/MediaEmbed";
import type { MediaEmbedAttributes } from "./MediaEmbed";
import { mediaEmbedAttrsFromParsed } from "./MediaEmbed";
import { mediaLayoutStyle } from "./media-layout";

const EditorWrapper = styled(YStack, {
  position: "relative",
  marginVertical: "$4",
  gap: "$2",
});

const UrlBar = styled(XStack, {
  gap: "$2",
  alignItems: "flex-end",
  padding: "$2",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$backgroundHover",
});

// Text base, not XStack: only text bases model `color`, which the lucide glyph
// inherits via currentColor. TextStyle extends ViewStyle, so box styles apply.
const DeleteBtn = styled(TamaguiText, {
  position: "absolute",
  top: 4,
  right: 4,
  padding: "$2",
  borderRadius: 0,
  // Text defaults to display:inline — restore XStack's box.
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  opacity: 0.45,
  zIndex: 10,
  // Glyph rides currentColor: danger at rest, inverted on the danger hover
  // fill (danger-on-danger vanishes).
  color: "$danger",
  hoverStyle: {
    opacity: 1,
    backgroundColor: "$danger",
    color: "$colorInverted",
  },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineColor: "$brandSecondary",
    outlineStyle: "solid",
  },
});

const inputStyle: CSSProperties = {
  width: "100%",
  minHeight: 44,
  padding: "8px 10px",
  border: "2px solid var(--borderColor, #211C16)",
  borderRadius: 0,
  background: "var(--surface, #FDFAF3)",
  color: "var(--color, #211C16)",
  fontSize: 16,
  fontFamily: "inherit",
};

export function MediaEmbedNodeView({
  node,
  selected,
  editor,
  updateAttributes,
  deleteNode,
}: NodeViewProps) {
  const t = useTranslations();
  const attrs = node.attrs as MediaEmbedAttributes;
  const isEditable = editor.isEditable;
  const [urlInput, setUrlInput] = useState(attrs.sourceUrl ?? "");
  const [error, setError] = useState<string | null>(null);

  const mediaEmbedUrlLabel = String(t("admin.peMediaEmbedUrl") ?? "Media URL");
  const invalidMessage = String(
    t("admin.peMediaEmbedInvalid") ?? "Paste a supported media URL.",
  );

  const handleApplyUrl = useCallback(() => {
    const parsed = parseEmbedUrl(urlInput);
    if (!parsed) {
      setError(invalidMessage);
      return;
    }
    const nextAttrs = mediaEmbedAttrsFromParsed(parsed, { title: attrs.title });
    updateAttributes(nextAttrs);
    setUrlInput(parsed.sourceUrl);
    setError(null);
  }, [attrs.title, invalidMessage, updateAttributes, urlInput]);

  // Side-column float vs. full-width block layout — shared helper, see
  // `media-layout.ts`.
  const layoutStyle = mediaLayoutStyle(attrs.align, attrs.float);

  return (
    <NodeViewWrapper
      data-testid="media-embed-node"
      contentEditable={false}
      style={layoutStyle}
    >
      <EditorWrapper>
        {isEditable && (
          <DeleteBtn
            {...({
              onPress: deleteNode,
              role: "button",
              tabIndex: 0,
              "aria-label": String(
                t("admin.peRemoveMediaEmbed") ?? "Remove media embed",
              ),
              "data-testid": "media-embed-delete",
              onKeyDown: (event: ReactKeyboardEvent) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  deleteNode();
                }
              },
            } as Record<string, unknown>)}
          >
            <Trash2 size={14} color="currentColor" />
          </DeleteBtn>
        )}

        {isEditable && (
          <UrlBar data-testid="media-embed-edit-bar">
            <YStack flex={1} gap="$1">
              <Text
                tag="label"
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
                weight="bold"
                tone="muted"
              >
                {mediaEmbedUrlLabel}
              </Text>
              <input
                type="url"
                value={urlInput}
                onChange={(event) => {
                  setUrlInput(event.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleApplyUrl();
                  }
                }}
                placeholder="https://..."
                autoComplete="off"
                enterKeyHint="done"
                aria-label={mediaEmbedUrlLabel}
                style={inputStyle}
                data-testid="media-embed-url-input"
              />
            </YStack>
            <Button
              size="$2"
              variant="primary"
              onPress={handleApplyUrl}
              disabled={!urlInput.trim()}
            >
              <Check size={14} aria-hidden="true" />
              {String(t("admin.peUpdateMediaEmbed") ?? "Update")}
            </Button>
          </UrlBar>
        )}

        {error && (
          <XStack gap="$2" alignItems="center" aria-live="assertive">
            <AlertCircle size={14} color="var(--danger)" aria-hidden="true" />
            <Text
              tag="span"
              style={{ fontSize: 12 }}
              tone="error"
              weight="bold"
            >
              {error}
            </Text>
          </XStack>
        )}

        <MediaEmbedRenderer embed={attrs} compact={false} />

        {selected && (
          <div
            style={{
              position: "absolute",
              inset: -2,
              border: "2px solid var(--accentHard, #B93312)",
              pointerEvents: "none",
            }}
          />
        )}
      </EditorWrapper>
    </NodeViewWrapper>
  );
}
