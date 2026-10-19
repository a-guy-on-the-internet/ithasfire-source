"use client";

import { useCallback, useState } from "react";
import { styled } from "tamagui";
import { useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { prepareImageForUpload } from "@/lib/images/prepare-image-upload";

type PageOwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";

// The server's presign/finalize schemas only accept these content types and
// stay strict on purpose. HEIC/HEIF is converted to JPEG client-side by
// `prepareImageForUpload` before it ever reaches these checks.
export type PageImageUploadContentType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export const PAGE_IMAGE_UPLOAD_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Allow HEIC/HEIF selection in the OS picker even though the server only
// accepts jpeg/png/gif/webp — `prepareImageForUpload` converts HEIC to JPEG
// before upload.
export const PAGE_IMAGE_UPLOAD_ACCEPT =
  "image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,.heic,.heif";

// Keep in sync with MAX_ENTITY_PAGE_IMAGE_BYTES in
// packages/core/src/use-cases/entity-pages/page-image-upload-helpers.ts
export const MAX_PAGE_IMAGE_BYTES = 25 * 1024 * 1024;

// Visually-hidden file input (the styled <label> Button is the real trigger).
//
// `whiteSpace: "nowrap"` is deliberately NOT here: it is part of the classic
// sr-only recipe for TEXT, and on a styled DOM `input` Tamagui forwards it
// straight through as a React prop — which logs "React does not recognize the
// whiteSpace prop on a DOM element" to the console on every render of the
// page-settings panel. A file input has no text to wrap, so dropping it costs
// nothing and clears a real console error.
// @ts-ignore — Tamagui supports styled DOM inputs at runtime; typings are RN-oriented.
export const NativeFileInput = styled("input", {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  borderWidth: 0,
});

/**
 * Shared upload pipeline for entity-page images (banner, avatar, block photos).
 *
 * Encapsulates HEIC→JPEG prep, client-side type/size validation, the presign
 * PUT to storage, and finalize. Errors are surfaced via a danger toast and the
 * call resolves to `null`; on success it resolves to the public URL. Callers
 * decide what to do with the URL (set local state) and whether to show a
 * success toast, since the "what to do next" copy differs per surface.
 */
export function usePageImageUpload({
  ownerType,
  ownerId,
}: {
  ownerType: PageOwnerType;
  ownerId: string;
}) {
  const t = useTranslations();
  const { toast } = useNotify();
  const requestUpload = trpc.entityPages.requestImageUpload.useMutation();
  const finalizeUpload = trpc.entityPages.finalizeImageUpload.useMutation();
  const [isUploading, setIsUploading] = useState(false);

  const upload = useCallback(
    async (input: File): Promise<string | null> => {
      // Flip busy on immediately — before HEIC→JPEG conversion (which can take
      // seconds) and validation — so the caller's control shows a spinner for
      // the whole operation and a rapid second pick is guarded. Always reset in
      // the `finally`.
      setIsUploading(true);
      try {
        // Convert HEIC/HEIF (iPhone photos) to JPEG before the type/size checks
        // so the size cap runs against the JPEG and the server gets a supported
        // content-type.
        let file = input;
        try {
          file = await prepareImageForUpload(file);
        } catch (err) {
          toast.danger({
            id: "page-image-upload-failed",
            title: String(t("admin.peBlockImageUploadFailed")),
            message: formatErrorMessage(err, t),
          });
          return null;
        }

        if (!PAGE_IMAGE_UPLOAD_TYPES.has(file.type)) {
          toast.danger({
            id: "page-image-upload-invalid-type",
            title: String(t("admin.peBlockImageUploadFailed")),
            message: String(t("admin.peBlockImageUploadInvalidType")),
          });
          return null;
        }

        if (file.size > MAX_PAGE_IMAGE_BYTES) {
          toast.danger({
            id: "page-image-upload-too-large",
            title: String(t("admin.peBlockImageUploadFailed")),
            message: String(t("admin.peBlockImageUploadTooLarge")),
          });
          return null;
        }

        const contentType = file.type as PageImageUploadContentType;
        const { key, uploadUrl } = await requestUpload.mutateAsync({
          ownerType,
          ownerId,
          contentType,
          sizeBytes: file.size,
        });

        const uploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: file,
        });

        if (!uploadResponse.ok) {
          throw new Error(
            `Storage upload failed (HTTP ${uploadResponse.status} ${uploadResponse.statusText || "unknown"})`,
          );
        }

        const { publicUrl } = await finalizeUpload.mutateAsync({
          ownerType,
          ownerId,
          key,
        });

        return publicUrl;
      } catch (err) {
        toast.danger({
          id: "page-image-upload-failed",
          title: String(t("admin.peBlockImageUploadFailed")),
          message: formatErrorMessage(err, t),
        });
        return null;
      } finally {
        setIsUploading(false);
      }
    },
    [finalizeUpload, ownerId, ownerType, requestUpload, t, toast],
  );

  return { upload, isUploading };
}
