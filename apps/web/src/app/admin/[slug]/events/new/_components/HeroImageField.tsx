"use client";

import { useCallback, useRef } from "react";
import { styled, useTheme, XStack, YStack } from "tamagui";
import { Upload, X } from "lucide-react";
import { Text } from "@th/ui";
import { useTranslations } from "@th/ui";
import { EVENT_IMAGE_UPLOAD_ACCEPT } from "@/lib/images/event-image-upload";

// ── Styled primitives ────────────────────────────────────────────────────────

const HeroImageContainer = styled(YStack, {
  borderWidth: 2,
  borderStyle: "dashed",
  borderColor: "$borderColor",
  minHeight: 200,
  justifyContent: "center",
  alignItems: "center",
  cursor: "pointer",
  overflow: "hidden",
  position: "relative",
  hoverStyle: {
    borderColor: "$borderColorHover",
  },
});

const RemoveImageButton = styled(XStack, {
  position: "absolute",
  top: 8,
  right: 8,
  width: 32,
  height: 32,
  borderRadius: 0,
  backgroundColor: "$accent",
  justifyContent: "center",
  alignItems: "center",
  cursor: "pointer",
  zIndex: 10,
});

// ── Props ────────────────────────────────────────────────────────────────────

export type HeroImageFieldProps = {
  imageUrl: string | undefined;
  onImageSelected: (file: File, previewUrl: string) => void | Promise<void>;
  onImageRemoved: () => void;
  /**
   * File-input `accept`. Defaults to the event pipeline's allowlist
   * (raster + HEIC). Pass a narrower string to restrict a specific surface.
   */
  accept?: string;
};

// ── Component ────────────────────────────────────────────────────────────────

export function HeroImageField({
  imageUrl,
  onImageSelected,
  onImageRemoved,
  accept = EVENT_IMAGE_UPLOAD_ACCEPT,
}: HeroImageFieldProps) {
  const theme = useTheme();
  const t = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        const url = URL.createObjectURL(file);
        void onImageSelected(file, url);
      }
    },
    [onImageSelected],
  );

  const handleRemove = useCallback(
    (e: { stopPropagation?: () => void }) => {
      e.stopPropagation?.();
      onImageRemoved();
    },
    [onImageRemoved],
  );

  return (
    <HeroImageContainer onPress={handleClick} data-testid="hero-image-upload">
      {imageUrl ? (
        <>
          <img
            src={imageUrl}
            alt="Hero"
            style={{
              width: "100%",
              height: 200,
              objectFit: "cover",
            }}
          />
          <RemoveImageButton onPress={handleRemove}>
            <X size={16} color={theme.colorInverted?.val} />
          </RemoveImageButton>
        </>
      ) : (
        <YStack alignItems="center" gap={8}>
          <Upload size={32} color={theme.colorMuted?.val} />
          <Text variant="body" tone="muted">
            {String(t("admin.ebClickToUpload"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("admin.ebRecommendedSize"))}
          </Text>
        </YStack>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        onChange={handleFileChange}
        style={{ display: "none" }}
      />
    </HeroImageContainer>
  );
}
