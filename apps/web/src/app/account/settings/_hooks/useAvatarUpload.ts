"use client";

import { useCallback, useState } from "react";
import { trpc } from "@/trpc";
import { prepareImageForUpload } from "@/lib/images/prepare-image-upload";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export interface UseAvatarUploadOptions {
  onSuccess?: (avatarUrl: string) => void;
  onError?: (error: Error) => void;
}

export interface UseAvatarUploadResult {
  /** Upload a file — validates, presigns, PUTs to R2, finalises. */
  uploadAvatar: (file: File) => Promise<string | null>;
  /** Whether an upload is currently in progress. */
  isUploading: boolean;
}

/**
 * Hook for uploading a user profile avatar.
 *
 * Flow:
 *  1. Validate file type + size on the client.
 *  2. `requestAvatarUpload` → presigned URL from server.
 *  3. `PUT` the file directly to R2.
 *  4. `setAvatarFromUpload` → server confirms + returns public URL.
 */
export function useAvatarUpload({
  onSuccess,
  onError,
}: UseAvatarUploadOptions = {}): UseAvatarUploadResult {
  const [isUploading, setIsUploading] = useState(false);

  const utils = trpc.useUtils();
  const requestUpload = trpc.entityPages.requestAvatarUpload.useMutation();
  const setAvatar = trpc.entityPages.setAvatarFromUpload.useMutation();

  const uploadAvatar = useCallback(
    async (file: File): Promise<string | null> => {
      // Convert HEIC/HEIF (iPhone photos) to JPEG before validation so the
      // type/size checks run against the JPEG the server will actually accept.
      try {
        file = await prepareImageForUpload(file);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
        return null;
      }

      // ── Client-side validation ──────────────────────────
      if (!ALLOWED_TYPES.has(file.type)) {
        const err = new Error("INVALID_TYPE");
        onError?.(err);
        return null;
      }
      if (file.size > MAX_SIZE_BYTES) {
        const err = new Error("TOO_LARGE");
        onError?.(err);
        return null;
      }

      setIsUploading(true);

      try {
        // Step 1: Get presigned upload URL
        const { key, uploadUrl } = await requestUpload.mutateAsync({
          contentType: file.type as "image/jpeg" | "image/png" | "image/webp",
          sizeBytes: file.size,
        });

        // Step 2: PUT file to R2
        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });

        if (!putRes.ok) {
          throw new Error(
            `Storage upload failed (HTTP ${putRes.status} ${putRes.statusText || "unknown"})`,
          );
        }

        // Step 3: Finalise — server verifies object + updates profile
        const { avatarUrl } = await setAvatar.mutateAsync({ key });

        // Invalidate profile query so the UI picks up the new URL
        await utils.entityPages.getMyProfile.invalidate();

        onSuccess?.(avatarUrl);
        return avatarUrl;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        onError?.(error);
        console.error("Avatar upload failed:", error);
        return null;
      } finally {
        setIsUploading(false);
      }
    },
    [requestUpload, setAvatar, utils, onSuccess, onError],
  );

  return { uploadAvatar, isUploading };
}
