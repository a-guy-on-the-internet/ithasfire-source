"use client";

import { useCallback, useState } from "react";
import type { ImageBlockAttributes } from "./prose-editor";
import { trpc } from "@/trpc";
import { prepareImageForUpload } from "@/lib/images/prepare-image-upload";
import {
  EVENT_IMAGE_UPLOAD_TYPES,
  validateImageUploadType,
} from "@/lib/images/event-image-upload";

// Keep in sync with MAX_EVENT_IMAGE_BYTES in
// packages/core/src/use-cases/events/request-event-image-upload.ts
export const MAX_EVENT_IMAGE_BYTES = 25 * 1024 * 1024;

export interface UseEventImageUploadOptions {
  /** Event ID to associate uploaded images with */
  eventId: string;
  /** Callback when upload fails */
  onError?: (error: Error) => void;
  /**
   * Content-type allowlist enforced after HEIC→JPEG prep. Defaults to the
   * event-pipeline set (raster only). Override to narrow it further on a
   * specific surface; a file picked via "All Files" is then rejected
   * client-side, not just discouraged by the input's `accept`.
   * Pass a module-level constant (or memoized set) — it participates in
   * `uploadImage`'s dependency array.
   */
  allowedTypes?: ReadonlySet<string>;
}

export interface UseEventImageUploadResult {
  /**
   * Upload an image file and return the attributes for the editor.
   * Returns null if the upload fails.
   */
  uploadImage: (file: File) => Promise<ImageBlockAttributes | null>;
  /**
   * Resolve image URLs for the given event.
   * Returns a map of imageId to public URL.
   */
  resolveImageUrls: (imageIds: string[]) => Promise<Record<string, string>>;
  /** Whether an upload is currently in progress */
  isUploading: boolean;
}

/**
 * Hook for handling event image uploads in the ProseEditor.
 *
 * Provides an upload handler that:
 * 1. Requests a presigned upload URL from the server
 * 2. Uploads the file directly to R2
 * 3. Finalizes the upload and returns the image attributes
 */
export function useEventImageUpload({
  eventId,
  onError,
  allowedTypes = EVENT_IMAGE_UPLOAD_TYPES,
}: UseEventImageUploadOptions): UseEventImageUploadResult {
  const [isUploading, setIsUploading] = useState(false);

  const requestUpload = trpc.events.requestImageUpload.useMutation();
  const finalizeUpload = trpc.events.finalizeImageUpload.useMutation();
  const resolveImages = trpc.events.resolveImages.useQuery;

  const uploadImage = useCallback(
    async (file: File): Promise<ImageBlockAttributes | null> => {
      if (!eventId) {
        onError?.(new Error("Event ID is required"));
        return null;
      }

      // Convert HEIC/HEIF (iPhone photos) to JPEG before any size check or
      // presign so the size cap runs against the JPEG and the server gets a
      // supported content-type.
      try {
        file = await prepareImageForUpload(file);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
        return null;
      }

      // Mirror the caller's content-type allowlist (default: the server's
      // jpeg/png/gif/webp set) so a bad file fails fast with a mapped
      // error instead of a presign 400. Runs after HEIC prep, so iPhone
      // photos have already become JPEG.
      const typeCheck = validateImageUploadType(file, allowedTypes);
      if (!typeCheck.ok) {
        onError?.(new Error(typeCheck.error));
        return null;
      }

      if (file.size > MAX_EVENT_IMAGE_BYTES) {
        onError?.(new Error("image_too_large"));
        return null;
      }

      setIsUploading(true);

      try {
        // Step 1: Request presigned upload URL
        const { imageId, uploadUrl, uploadHeaders } =
          await requestUpload.mutateAsync({
            eventId,
            contentType: file.type,
            sizeBytes: file.size,
          });

        // Step 2: Upload file directly to R2 using presigned URL.
        // Send the server-provided headers VERBATIM — they are signed into the
        // presigned URL, so hand-building headers here would 403 the PUT.
        const uploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          headers: uploadHeaders,
          body: file,
        });

        if (!uploadResponse.ok) {
          const statusText = uploadResponse.statusText || "unknown";
          throw new Error(
            `Storage upload failed (HTTP ${uploadResponse.status} ${statusText}). ` +
              `This may be a temporary issue — please try again.`,
          );
        }

        // Step 3: Finalize upload and get public URL
        const { publicUrl } = await finalizeUpload.mutateAsync({
          imageId,
        });

        // Return attributes for the imageBlock
        return {
          imageId,
          src: publicUrl,
          alt: file.name.replace(/\.[^/.]+$/, ""), // Use filename without extension as default alt
          align: "center",
          width: "100%",
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        onError?.(error);
        console.error("Event image upload failed:", error);
        return null;
      } finally {
        setIsUploading(false);
      }
    },
    [eventId, requestUpload, finalizeUpload, onError, allowedTypes],
  );

  const resolveImageUrls = useCallback(
    async (imageIds: string[]): Promise<Record<string, string>> => {
      if (imageIds.length === 0) return {};

      try {
        // We need to use the tRPC client directly for an imperative call
        // This is a query, so we would need to use queryClient or a different approach
        // For now, return empty - this will be populated through React Query
        return {};
      } catch (err) {
        console.error("Failed to resolve image URLs:", err);
        return {};
      }
    },
    [],
  );

  return {
    uploadImage,
    resolveImageUrls,
    isUploading,
  };
}
