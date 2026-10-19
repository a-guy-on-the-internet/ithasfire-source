"use client";

import { useCallback, useState } from "react";
import type { AudioBlockAttributes } from "./prose-editor";
import { trpc } from "@/trpc";

export interface UseEventAudioUploadOptions {
  /** Event ID to associate uploaded audio with */
  eventId: string;
  /** Callback when upload fails */
  onError?: (error: Error) => void;
}

export interface UseEventAudioUploadResult {
  /**
   * Upload an audio file and return the attributes for the editor.
   * Returns null if the upload fails.
   */
  uploadAudio: (file: File) => Promise<AudioBlockAttributes | null>;
  /** Whether an upload is currently in progress */
  isUploadingAudio: boolean;
}

/**
 * Hook for handling event audio uploads in the ProseEditor.
 *
 * Provides an upload handler that:
 * 1. Requests a presigned upload URL from the server
 * 2. Uploads the file directly to R2
 * 3. Finalizes the upload to trigger transcoding
 * 4. Invalidates `events.resolveAudio` so the status poller wakes up
 */
export function useEventAudioUpload({
  eventId,
  onError,
}: UseEventAudioUploadOptions): UseEventAudioUploadResult {
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);

  const utils = trpc.useUtils();
  const requestUpload = trpc.events.requestAudioUpload.useMutation();
  const finalizeUpload = trpc.events.finalizeAudioUpload.useMutation();

  const uploadAudio = useCallback(
    async (file: File): Promise<AudioBlockAttributes | null> => {
      if (!eventId) {
        onError?.(new Error("Event ID is required"));
        return null;
      }

      // Stamped BEFORE the presign so the inserted node can date its own
      // progress immediately. `useEventMediaMaps` later overwrites this with
      // the server's `createdAt` on the first successful poll, but the node
      // view's 5-minute "Still working" branch keys off this attribute — and
      // the case it exists for is precisely the one where polling never
      // delivers. Without a value at insert time that branch is unreachable.
      const uploadStartedAt = new Date().toISOString();

      setIsUploadingAudio(true);

      try {
        // Step 1: Compute SHA-256 checksum client-side for integrity verification.
        // Web Crypto API is available in all modern browsers.
        const fileBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);
        const checksumSHA256 = btoa(
          String.fromCharCode(...new Uint8Array(hashBuffer)),
        );

        // Step 2: Request presigned upload URL (includes the checksum in the signature)
        const { audioUploadId, uploadUrl } = await requestUpload.mutateAsync({
          eventId,
          contentType: file.type,
          sizeBytes: file.size,
          checksumSHA256,
        });

        // Step 3: Upload file directly to R2 using presigned URL.
        // The x-amz-checksum-sha256 header MUST match the checksum signed into the URL.
        const uploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": file.type,
            "x-amz-checksum-sha256": checksumSHA256,
          },
          body: file,
        });

        if (!uploadResponse.ok) {
          const statusText = uploadResponse.statusText || "unknown";
          throw new Error(
            `Storage upload failed (HTTP ${uploadResponse.status} ${statusText}). ` +
              `This may be a temporary issue — please try again.`,
          );
        }

        // Step 3: Finalize upload (marks as UPLOADED and triggers transcoding)
        const { status } = await finalizeUpload.mutateAsync({
          audioUploadId,
        });

        // Step 4: Wake the status poller.
        //
        // `useEventMediaMaps` drives `resolveAudio` with a `refetchInterval`
        // callback that returns `false` while nothing is pending. React Query
        // only recomputes that callback on a query STATE change, so on an
        // editor whose event had no audio at mount the timer parks at `false`
        // and never restarts on its own: the node is inserted client-side and
        // nothing touches the query. Measured symptom — zero `resolveAudio`
        // requests in the six minutes after an upload, block stuck on its
        // skeleton until a full page reload.
        //
        // Invalidating here is the state change that restarts it; the ramp in
        // `nextAudioPollInterval` then owns the cadence and still returns
        // `false` (parking the query again) once every item is READY/FAILED.
        // Fire-and-forget: the node must appear now, not a round trip later.
        void utils.events.resolveAudio.invalidate({ eventId });

        // Return attributes for the audioBlock
        return {
          audioUploadId,
          title: file.name.replace(/\.[^/.]+$/, ""), // filename without extension
          status: status as AudioBlockAttributes["status"],
          uploadStartedAt,
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        onError?.(error);
        console.error("Event audio upload failed:", error);
        return null;
      } finally {
        setIsUploadingAudio(false);
      }
    },
    [eventId, requestUpload, finalizeUpload, onError, utils],
  );

  return {
    uploadAudio,
    isUploadingAudio,
  };
}
