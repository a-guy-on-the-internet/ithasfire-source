"use client";

import { useCallback, useState, useRef, useEffect } from "react";
import { NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { XStack, YStack, styled } from "tamagui";
import {
  Image as ImageIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Trash2,
  WrapText,
  Square,
} from "lucide-react";
import { Text, Spinner, useTranslations } from "@th/ui";
import { Link2 } from "lucide-react";

import {
  IMAGE_CAPTION_MAX_LENGTH,
  normalizeImageCaption,
  type ImageBlockAttributes,
  type ImageBlockAlignment,
  type ImageBlockFloat,
} from "./ImageBlock";

const ImageContainer = styled(YStack, {
  position: "relative",
  marginVertical: "$3",
  variants: {
    selected: {
      true: {
        outlineWidth: 2,
        outlineStyle: "solid",
        outlineColor: "$accentHard",
        outlineOffset: 2,
        borderRadius: 0,
      },
    },
  },
});

const ImageWrapper = styled(YStack, {
  position: "relative",
  borderRadius: 0,
  overflow: "hidden",
  backgroundColor: "$backgroundHover",
});

// Use inline styles for img element since styled("img") has typing issues
const imageBaseStyles: React.CSSProperties = {
  display: "block",
  maxWidth: "100%",
  height: "auto",
  borderRadius: 0,
};

// The caption, editable or not, wears the page's <figcaption> look
// (event-body-typography.css): small, muted, left edge on the image's.
const captionBaseStyles: React.CSSProperties = {
  display: "block",
  maxWidth: "100%",
  marginTop: 8,
  padding: 0,
  fontFamily: "inherit",
  fontSize: 14,
  lineHeight: 1.5,
  color: "var(--colorMuted, #5C544A)",
  textAlign: "left",
  overflowWrap: "anywhere",
};

const PlaceholderContainer = styled(YStack, {
  padding: "$6",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "$backgroundHover",
  borderRadius: 0,
  borderWidth: 1,
  borderStyle: "dashed",
  borderColor: "$borderColor",
  gap: "$2",
});

// A fixed black bar floating over arbitrary user imagery in every theme — so
// its child glyphs correctly carry literal `white` (this file is a listed
// white-permanent; see eslint-white-permanents.mjs). Fixed background ⇒ fixed
// foreground: a themed token could drift off a fill that never moves.
const ControlsOverlay = styled(XStack, {
  position: "absolute",
  top: "$2",
  right: "$2",
  gap: "$1",
  backgroundColor: "rgba(0, 0, 0, 0.6)",
  borderRadius: 0,
  padding: "$1",
  opacity: 0,
  transition: "opacity 0.2s ease",
  variants: {
    visible: {
      true: {
        opacity: 1,
      },
    },
  },
});

const ControlButton = styled(XStack, {
  padding: "$2",
  borderRadius: 0,
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  hoverStyle: {
    backgroundColor: "rgba(255, 255, 255, 0.2)",
  },
  variants: {
    active: {
      true: {
        backgroundColor: "rgba(255, 255, 255, 0.3)",
      },
    },
  },
});

const ControlDivider = styled(YStack, {
  width: 1,
  alignSelf: "stretch",
  marginVertical: "$1",
  backgroundColor: "rgba(255, 255, 255, 0.25)",
});

// ---------------------------------------------------------------------------
// Resize handle styles (edge/corner grab affordances)
// ---------------------------------------------------------------------------

const HANDLE_SIZE = 8;

const resizeHandleBase: React.CSSProperties = {
  position: "absolute",
  backgroundColor: "var(--accentHard, #B93312)",
  borderRadius: 0,
  zIndex: 20,
  opacity: 0,
  transition: "opacity 0.15s ease",
};

const resizeHandleVisible: React.CSSProperties = { opacity: 1 };

const rightHandleStyle: React.CSSProperties = {
  ...resizeHandleBase,
  width: HANDLE_SIZE,
  height: 40,
  right: -HANDLE_SIZE / 2,
  top: "50%",
  transform: "translateY(-50%)",
  cursor: "ew-resize",
};

const leftHandleStyle: React.CSSProperties = {
  ...resizeHandleBase,
  width: HANDLE_SIZE,
  height: 40,
  left: -HANDLE_SIZE / 2,
  top: "50%",
  transform: "translateY(-50%)",
  cursor: "ew-resize",
};

const bottomRightHandleStyle: React.CSSProperties = {
  ...resizeHandleBase,
  width: HANDLE_SIZE * 1.5,
  height: HANDLE_SIZE * 1.5,
  right: -HANDLE_SIZE / 2,
  bottom: -HANDLE_SIZE / 2,
  cursor: "nwse-resize",
  borderRadius: 0,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_WIDTH_PX = 80;
const MAX_WIDTH_PERCENT = 100;

type ImageBlockNodeViewProps = NodeViewProps;

export const ImageBlockNodeView = ({
  node,
  editor,
  updateAttributes,
  deleteNode,
  selected,
  getPos,
}: ImageBlockNodeViewProps) => {
  const attrs = node.attrs as ImageBlockAttributes;
  const {
    imageId,
    alt,
    align = "center",
    width = "100%",
    float: floatMode = "none",
    src,
    caption,
  } = attrs;

  const t = useTranslations();
  const [isHovered, setIsHovered] = useState(false);
  const [isLoading, setIsLoading] = useState(!!src);
  const [hasError, setHasError] = useState(false);

  // Resize state
  const [isResizing, setIsResizing] = useState(false);
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const resizeDirectionRef = useRef<"left" | "right" | "corner">("right");

  const effectiveAlign: ImageBlockAlignment =
    floatMode === "left" ? "left" : floatMode === "right" ? "right" : align;

  // ---------------------------------------------------------------------------
  // Resize handlers
  // ---------------------------------------------------------------------------

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, direction: "left" | "right" | "corner") => {
      e.preventDefault();
      e.stopPropagation();
      if (!containerRef.current) return;

      const parentEl = containerRef.current.closest(
        ".tiptap",
      ) as HTMLElement | null;
      const parentWidth =
        parentEl?.clientWidth ?? containerRef.current.clientWidth;
      const wrapperEl = containerRef.current.querySelector(
        "[data-image-wrapper]",
      ) as HTMLElement | null;
      const currentPx = wrapperEl?.clientWidth ?? parentWidth;

      startXRef.current = e.clientX;
      startWidthRef.current = currentPx;
      resizeDirectionRef.current = direction;
      setIsResizing(true);
      setResizeWidth(currentPx);
    },
    [],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const parentEl = containerRef.current?.closest(
        ".tiptap",
      ) as HTMLElement | null;
      const parentWidth = parentEl?.clientWidth ?? 600;

      const delta = e.clientX - startXRef.current;
      const dir = resizeDirectionRef.current;
      // Dragging the left handle leftward grows the image
      const sign = dir === "left" ? -1 : 1;
      let newWidth = startWidthRef.current + delta * sign;

      const maxPx = parentWidth * (MAX_WIDTH_PERCENT / 100);
      newWidth = Math.max(MIN_WIDTH_PX, Math.min(newWidth, maxPx));
      setResizeWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (resizeWidth != null && containerRef.current) {
        const parentEl = containerRef.current.closest(
          ".tiptap",
        ) as HTMLElement | null;
        const parentWidth = parentEl?.clientWidth ?? 600;
        const pct = Math.round((resizeWidth / parentWidth) * 100);
        const clampedPct = Math.max(10, Math.min(pct, MAX_WIDTH_PERCENT));
        updateAttributes({ width: `${clampedPct}%` });
      }
      setIsResizing(false);
      setResizeWidth(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, resizeWidth, updateAttributes]);

  // ---------------------------------------------------------------------------
  // Control handlers
  // ---------------------------------------------------------------------------

  const handleAlignmentChange = useCallback(
    (newAlign: ImageBlockAlignment) => {
      updateAttributes({ align: newAlign, float: "none" });
    },
    [updateAttributes],
  );

  const handleFloatChange = useCallback(
    (newFloat: ImageBlockFloat) => {
      const updates: Partial<ImageBlockAttributes> = { float: newFloat };
      // Default to ~50% width when switching to float from full width
      if (newFloat !== "none" && (width === "100%" || !width)) {
        updates.width = "50%";
      }
      if (newFloat !== "none") {
        updates.align = newFloat as ImageBlockAlignment;
      }
      updateAttributes(updates);
    },
    [updateAttributes, width],
  );

  // Typing keeps the raw line (a trailing space mid-word must survive);
  // blur and Enter store the normalized caption.
  const handleCaptionChange = useCallback(
    (value: string) => {
      const oneLine = value
        .replace(/[\r\n]+/g, " ")
        .slice(0, IMAGE_CAPTION_MAX_LENGTH);
      updateAttributes({ caption: oneLine || null });
    },
    [updateAttributes],
  );

  const commitCaption = useCallback(
    (value: string) => {
      const next = normalizeImageCaption(value);
      if (next !== (caption ?? null)) updateAttributes({ caption: next });
    },
    [caption, updateAttributes],
  );

  // Enter leaves the caption for the text after the image, adding an empty
  // paragraph when the image is the last block.
  const focusAfterImage = useCallback(() => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (typeof pos !== "number" || !editor) return;
    const after = pos + node.nodeSize;
    if (editor.state.doc.nodeAt(after)?.isTextblock) {
      editor.chain().focus(after + 1).run();
      return;
    }
    editor
      .chain()
      .insertContentAt(after, { type: "paragraph" })
      .focus(after + 1)
      .run();
  }, [editor, getPos, node]);

  const handleCaptionKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
      e.preventDefault();
      commitCaption(e.currentTarget.value);
      focusAfterImage();
    },
    [commitCaption, focusAfterImage],
  );

  const handleImageLoad = useCallback(() => setIsLoading(false), []);
  const handleImageError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
  }, []);

  const showControls = isHovered || selected || isResizing;
  const isEditable = editor?.isEditable ?? false;

  // ---------------------------------------------------------------------------
  // Container layout styles (float vs. block alignment)
  // ---------------------------------------------------------------------------

  const containerStyle: React.CSSProperties = {};
  const displayWidth =
    isResizing && resizeWidth != null ? `${resizeWidth}px` : (width ?? "100%");
  // The caption spans the image, not the column: a narrow centred image
  // gets a caption under it, not one stretched across the page.
  const captionWidth = floatMode !== "none" ? "100%" : displayWidth;
  const readOnlyCaption = normalizeImageCaption(caption);

  if (floatMode === "left") {
    containerStyle.float = "left";
    containerStyle.marginRight = 16;
    containerStyle.marginBottom = 8;
    containerStyle.width = displayWidth;
    containerStyle.maxWidth = "75%";
    containerStyle.clear = "right";
  } else if (floatMode === "right") {
    containerStyle.float = "right";
    containerStyle.marginLeft = 16;
    containerStyle.marginBottom = 8;
    containerStyle.width = displayWidth;
    containerStyle.maxWidth = "75%";
    containerStyle.clear = "left";
  } else {
    containerStyle.width = "100%";
    containerStyle.display = "flex";
    containerStyle.flexDirection = "column";
    containerStyle.alignItems =
      effectiveAlign === "left"
        ? "flex-start"
        : effectiveAlign === "right"
          ? "flex-end"
          : "center";
  }

  // ---------------------------------------------------------------------------
  // Placeholders
  // ---------------------------------------------------------------------------

  if (!src && !imageId) {
    return (
      <NodeViewWrapper>
        <ImageContainer
          {...({ selected } as any)}
          style={{ width: "100%", ...containerStyle }}
        >
          <PlaceholderContainer>
            {hasError ? (
              <>
                <ImageIcon size={32} color="gray" />
                <Text variant="caption" tone="muted">
                  {String(t("admin.ibFailedToLoad"))}
                </Text>
              </>
            ) : (
              <XStack width="100%" alignItems="center" gap="$2">
                <Link2 size={16} color="gray" style={{ flexShrink: 0 }} />
                <input
                  type="text"
                  placeholder={String(
                    t("admin.ibPasteImageUrl") ?? "Paste image URL\u2026",
                  )}
                  style={{
                    flex: 1,
                    border: "none",
                    background: "transparent",
                    fontSize: 14,
                    color: "inherit",
                    padding: 0,
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const value = (e.target as HTMLInputElement).value.trim();
                      if (!value) return;
                      try {
                        new URL(value);
                      } catch {
                        return;
                      }
                      const segments = value.split("/");
                      const filename =
                        segments[segments.length - 1]?.split("?")[0] ?? "";
                      const derivedAlt =
                        filename.replace(/\.[^/.]+$/, "") || "Image";
                      updateAttributes({ src: value, alt: derivedAlt });
                    }
                  }}
                />
              </XStack>
            )}
          </PlaceholderContainer>
        </ImageContainer>
      </NodeViewWrapper>
    );
  }

  if (imageId && !src) {
    return (
      <NodeViewWrapper>
        <ImageContainer
          {...({ selected } as any)}
          style={{ width: "100%", ...containerStyle }}
        >
          <PlaceholderContainer>
            <Spinner size="md" indicatorColor="gray" />
            <Text variant="caption" tone="muted">
              {String(t("admin.ibImageLoading"))}
            </Text>
          </PlaceholderContainer>
        </ImageContainer>
      </NodeViewWrapper>
    );
  }

  // ---------------------------------------------------------------------------
  // Loaded image with controls + resize handles
  // ---------------------------------------------------------------------------

  return (
    <NodeViewWrapper style={floatMode !== "none" ? containerStyle : undefined}>
      <ImageContainer
        ref={containerRef}
        {...({ selected } as any)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          if (!isResizing) setIsHovered(false);
        }}
        data-testid="prose-image-block"
        style={floatMode === "none" ? containerStyle : undefined}
      >
        <ImageWrapper
          data-image-wrapper
          style={{
            width: floatMode !== "none" ? "100%" : displayWidth,
            maxWidth: "100%",
            position: "relative",
          }}
        >
          {isLoading && (
            <PlaceholderContainer>
              <Spinner size="md" indicatorColor="gray" />
              <Text variant="caption" tone="muted">
                {String(t("admin.ibLoading"))}
              </Text>
            </PlaceholderContainer>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt ?? ""}
            onLoad={handleImageLoad}
            onError={handleImageError}
            data-testid="prose-image-block-img"
            draggable={false}
            style={{
              ...imageBaseStyles,
              display: isLoading ? "none" : "block",
              width: "100%",
              ...(isResizing
                ? ({
                    pointerEvents: "none",
                    userSelect: "none",
                  } as React.CSSProperties)
                : {}),
            }}
          />

          {/* Controls overlay */}
          <ControlsOverlay visible={showControls && isEditable}>
            {/* Alignment (only when not floating) */}
            {floatMode === "none" && (
              <>
                <ControlButton
                  active={align === "left"}
                  onPress={() => handleAlignmentChange("left")}
                  aria-label={t("admin.ibAlignLeft") as string}
                >
                  <AlignLeft size={14} color="white" />
                </ControlButton>
                <ControlButton
                  active={align === "center" || !align}
                  onPress={() => handleAlignmentChange("center")}
                  aria-label={t("admin.ibAlignCenter") as string}
                >
                  <AlignCenter size={14} color="white" />
                </ControlButton>
                <ControlButton
                  active={align === "right"}
                  onPress={() => handleAlignmentChange("right")}
                  aria-label={t("admin.ibAlignRight") as string}
                >
                  <AlignRight size={14} color="white" />
                </ControlButton>
                <ControlDivider />
              </>
            )}

            {/* Float / text-wrap controls */}
            <ControlButton
              active={floatMode === "left"}
              onPress={() =>
                handleFloatChange(floatMode === "left" ? "none" : "left")
              }
              aria-label="Float left (text wraps right)"
            >
              <WrapText
                size={14}
                color="white"
                style={{ transform: "scaleX(-1)" }}
              />
            </ControlButton>
            <ControlButton
              active={floatMode === "none" && (align === "center" || !align)}
              onPress={() => handleFloatChange("none")}
              aria-label="No float (block)"
            >
              <Square size={14} color="white" />
            </ControlButton>
            <ControlButton
              active={floatMode === "right"}
              onPress={() =>
                handleFloatChange(floatMode === "right" ? "none" : "right")
              }
              aria-label="Float right (text wraps left)"
            >
              <WrapText size={14} color="white" />
            </ControlButton>

            <ControlDivider />

            {/* Delete */}
            <ControlButton
              onPress={() => deleteNode()}
              aria-label={t("admin.ibDeleteImage") as string}
            >
              <Trash2 size={14} color="#ff6b6b" />
            </ControlButton>
          </ControlsOverlay>

          {/* Resize handles (visible when hovered/selected) */}
          {isEditable && (
            <>
              <div
                style={{
                  ...rightHandleStyle,
                  ...(showControls ? resizeHandleVisible : {}),
                }}
                onMouseDown={(e) => handleResizeStart(e, "right")}
                data-testid="prose-image-resize-right"
              />
              <div
                style={{
                  ...leftHandleStyle,
                  ...(showControls ? resizeHandleVisible : {}),
                }}
                onMouseDown={(e) => handleResizeStart(e, "left")}
                data-testid="prose-image-resize-left"
              />
              <div
                style={{
                  ...bottomRightHandleStyle,
                  ...(showControls ? resizeHandleVisible : {}),
                }}
                onMouseDown={(e) => handleResizeStart(e, "corner")}
                data-testid="prose-image-resize-corner"
              />
            </>
          )}

          {/* Width indicator while resizing */}
          {isResizing && resizeWidth != null && containerRef.current && (
            <div
              style={{
                position: "absolute",
                bottom: 8,
                left: "50%",
                transform: "translateX(-50%)",
                backgroundColor: "rgba(0, 0, 0, 0.7)",
                color: "white",
                fontSize: 11,
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: 0,
                pointerEvents: "none",
                zIndex: 30,
              }}
            >
              {Math.round(
                (resizeWidth /
                  ((containerRef.current.closest(".tiptap") as HTMLElement)
                    ?.clientWidth ?? 600)) *
                  100,
              )}
              %
            </div>
          )}
        </ImageWrapper>

        {isEditable ? (
          <input
            type="text"
            value={caption ?? ""}
            maxLength={IMAGE_CAPTION_MAX_LENGTH}
            onChange={(e) => handleCaptionChange(e.target.value)}
            onKeyDown={handleCaptionKeyDown}
            aria-label={String(t("admin.ibCaptionLabel") ?? "Image caption")}
            placeholder={String(
              t("admin.ibCaptionPlaceholder") ?? "Add a caption",
            )}
            style={{
              ...captionBaseStyles,
              width: captionWidth,
              border: "none",
              borderBottom: "1px solid transparent",
              background: "transparent",
              transition: "border-color 0.15s ease",
            }}
            onFocus={(e) => {
              (e.target as HTMLInputElement).style.borderBottomColor =
                "var(--borderColor, #211C16)";
            }}
            onBlur={(e) => {
              (e.target as HTMLInputElement).style.borderBottomColor =
                "transparent";
              commitCaption(e.target.value);
            }}
            data-testid="prose-image-caption-input"
          />
        ) : (
          readOnlyCaption && (
            <div
              style={{ ...captionBaseStyles, width: captionWidth }}
              data-testid="prose-image-caption"
            >
              {readOnlyCaption}
            </div>
          )
        )}

        {/* Alt text — always-visible inline input that spans the image width */}
        {isEditable && (
          <input
            value={alt ?? ""}
            onChange={(e) =>
              updateAttributes({ alt: e.target.value || undefined })
            }
            placeholder={String(
              t("admin.ibAltPlaceholder") ?? "Describe this image...",
            )}
            style={{
              width: "100%",
              fontSize: 12,
              color: "var(--colorMuted, #5C544A)",
              padding: "4px 0",
              border: "none",
              borderBottom: "1px solid transparent",
              background: "transparent",
              fontFamily: "inherit",
              // Caption is always centered regardless of image alignment —
              // a left-floated image with a left-aligned caption next to it
              // looks cramped, and a right-aligned single-word caption looks
              // accidental. Center reads as "deliberate label" for any pose.
              textAlign: "center",
              marginTop: 4,
              transition: "border-color 0.15s ease",
            }}
            onFocus={(e) => {
              (e.target as HTMLInputElement).style.borderBottomColor =
                "var(--borderColor, #211C16)";
            }}
            onBlur={(e) => {
              (e.target as HTMLInputElement).style.borderBottomColor =
                "transparent";
            }}
            data-testid="prose-image-alt-input"
          />
        )}
      </ImageContainer>
    </NodeViewWrapper>
  );
};

ImageBlockNodeView.displayName = "ImageBlockNodeView";
