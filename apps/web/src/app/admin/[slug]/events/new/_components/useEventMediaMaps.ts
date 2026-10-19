"use client";

import { useEffect, useMemo, useState } from "react";

import type { ProseMirrorDoc } from "@th/schema";

import { trpc } from "@/trpc";

import type { AudioUrlMapEntry } from "./prose-editor";

/**
 * Resolves the media URL maps the prose editor (and the preview) need:
 * `imageId → publicUrl` and `audioUploadId → playback entry`.
 *
 * Extracted from EventBuilder so the resolution machinery lives in one place.
 * Behaviour is unchanged except for one deliberate perf guard: both maps are
 * rebuilt whenever the body doc changes (i.e. on every prose keystroke), so
 * they now keep their previous IDENTITY when the rebuilt contents are equal.
 * Without that, every keystroke handed BuilderDetailsSection a brand-new map
 * object and triggered an extra builder re-render for no visible change.
 */

/**
 * Audio upload statuses that are still in-flight (source not yet transcoded to
 * a playable HLS render). Mirrors the `AudioUploadStatus` Prisma enum: the
 * terminal states are `READY` and `FAILED`; everything else means the
 * transcoder still has work to do.
 */
const PENDING_AUDIO_STATUSES: ReadonlySet<string> = new Set([
  "PENDING",
  "UPLOADED",
  "TRANSCODING",
]);

/**
 * True only when at least one resolved audio item is still transcoding. Used
 * to gate `resolveAudio` polling: with no audio (empty `items`) or once every
 * item is READY/FAILED, polling stops instead of hammering the API forever.
 */
function hasPendingAudio(
  data: { items: { status: string }[] } | undefined,
): boolean {
  if (!data?.items?.length) return false;
  return data.items.some((item) => PENDING_AUDIO_STATUSES.has(item.status));
}

/**
 * Poll cadence for `resolveAudio` while something is still transcoding, ramped
 * by how long the pending upload has actually been pending.
 *
 * The old flat 10s meant the editor could keep spinning for up to ten seconds
 * after the transcode had ALREADY finished — and because most transcodes are
 * short, the flat interval spent the bulk of its budget waiting on work that
 * was already done. Poll tightly while a finish is plausibly imminent, then
 * back off so a genuinely slow job (long file, transcoder cold start) isn't
 * hammered for minutes.
 */
const AUDIO_POLL_STEPS: readonly { withinMs: number; intervalMs: number }[] = [
  { withinMs: 30_000, intervalMs: 2_000 },
  { withinMs: 120_000, intervalMs: 5_000 },
];

/** Cadence once a pending upload is older than every {@link AUDIO_POLL_STEPS} step. */
const AUDIO_POLL_MAX_INTERVAL_MS = 10_000;

type AudioPollItem = {
  status: string;
  createdAt?: Date | string | number | null;
};

type AudioPollData = { items: AudioPollItem[] } | undefined;

/**
 * Milliseconds since the YOUNGEST still-pending upload was created, or `null`
 * when no pending item carries a usable `createdAt`.
 *
 * Youngest rather than oldest: if anything was just uploaded, that's the item
 * about to finish, and it should set the tempo. Elapsed time comes from the
 * query data itself (`resolveAudio` items already carry `createdAt`), so this
 * needs no tick state or ref to stay current.
 */
function youngestPendingAgeMs(
  items: readonly AudioPollItem[],
  now: number,
): number | null {
  let youngest: number | null = null;
  for (const item of items) {
    if (!PENDING_AUDIO_STATUSES.has(item.status)) continue;
    if (item.createdAt === null || item.createdAt === undefined) continue;
    const createdMs = new Date(item.createdAt).getTime();
    if (!Number.isFinite(createdMs)) continue;
    const ageMs = now - createdMs;
    if (youngest === null || ageMs < youngest) youngest = ageMs;
  }
  return youngest;
}

/**
 * Next `resolveAudio` poll interval in ms, or `false` to stop polling.
 *
 * Returning `false` as soon as nothing is pending is load-bearing: with no
 * audio at all, or once every item is READY/FAILED, the query must go quiet
 * rather than hit the API forever.
 *
 * Exported for unit tests — the ramp is the whole point of the change.
 */
export function nextAudioPollInterval(
  data: AudioPollData,
  now: number,
): number | false {
  if (!hasPendingAudio(data)) return false;

  const ageMs = youngestPendingAgeMs(data?.items ?? [], now);
  // No usable timestamp anywhere — keep the old flat cadence rather than
  // guessing a tight one off a value we can't trust.
  if (ageMs === null) return AUDIO_POLL_MAX_INTERVAL_MS;

  for (const step of AUDIO_POLL_STEPS) {
    if (ageMs < step.withinMs) return step.intervalMs;
  }
  return AUDIO_POLL_MAX_INTERVAL_MS;
}

const sameImageMap = (
  a: Record<string, string>,
  b: Record<string, string>,
): boolean => {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
};

const sameAudioMap = (
  a: Record<string, AudioUrlMapEntry>,
  b: Record<string, AudioUrlMapEntry>,
): boolean => {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    if (!left || !right) return false;
    return (
      left.hlsPlaylistUrl === right.hlsPlaylistUrl &&
      left.sourceUrl === right.sourceUrl &&
      left.status === right.status &&
      left.createdAt === right.createdAt &&
      left.waveformPeaks === right.waveformPeaks
    );
  });
};

export type EventMediaMaps = {
  imageUrlMap: Record<string, string>;
  audioUrlMap: Record<string, AudioUrlMapEntry>;
};

export function useEventMediaMaps(
  eventId: string,
  bodyContent: ProseMirrorDoc,
): EventMediaMaps {
  const [imageUrlMap, setImageUrlMap] = useState<Record<string, string>>({});
  const [audioUrlMap, setAudioUrlMap] = useState<
    Record<string, AudioUrlMapEntry>
  >({});

  // Extract image IDs from the body content for URL resolution
  const imageIds = useMemo(() => {
    const ids: string[] = [];
    const collectImageIds = (content: ProseMirrorDoc["content"]) => {
      if (!content) return;
      for (const node of content) {
        if (node.type === "imageBlock" && node.attrs?.imageId) {
          ids.push(node.attrs.imageId as string);
        }
        if ("content" in node && Array.isArray(node.content)) {
          collectImageIds(node.content as ProseMirrorDoc["content"]);
        }
      }
    };
    collectImageIds(bodyContent.content);
    return ids;
  }, [bodyContent]);

  // Query for image URLs when we have images to resolve
  const imageQuery = trpc.events.resolveImages.useQuery(
    { eventId, imageIds, strict: false },
    { enabled: imageIds.length > 0 },
  );

  // Build imageUrlMap from both server-resolved URLs and in-memory src attrs
  // (newly uploaded images have their publicUrl in the node's `src` attribute
  // but may not be returned by the resolveImages query yet).
  useEffect(() => {
    const newMap: Record<string, string> = {};

    // 1. Server-resolved URLs (authoritative)
    if (imageQuery.data?.images) {
      for (const img of imageQuery.data.images) {
        newMap[img.id] = img.publicUrl;
      }
    }

    // 2. Fill gaps from node `src` attrs (covers just-uploaded images)
    const fillFromNodes = (content: ProseMirrorDoc["content"]) => {
      if (!content) return;
      for (const node of content) {
        if (
          node.type === "imageBlock" &&
          node.attrs?.imageId &&
          node.attrs?.src &&
          !newMap[node.attrs.imageId as string]
        ) {
          newMap[node.attrs.imageId as string] = node.attrs.src as string;
        }
        if ("content" in node && Array.isArray(node.content)) {
          fillFromNodes(node.content as ProseMirrorDoc["content"]);
        }
      }
    };
    fillFromNodes(bodyContent.content);

    setImageUrlMap((prev) => (sameImageMap(prev, newMap) ? prev : newMap));
  }, [imageQuery.data?.images, bodyContent]);

  // ─── Audio URL resolution ───────────────────────────────────────────────
  // Query for all audio uploads for this event and build an audioUrlMap
  // keyed by audioUploadId so the ProseEditor can render inline players.
  const audioQuery = trpc.events.resolveAudio.useQuery(
    { eventId },
    {
      // Poll only while something is still transcoding; stop once every item
      // is READY/FAILED (or there's no audio at all) so we don't hit the API
      // forever. The cadence ramps 2s → 5s → 10s with the pending item's age
      // (see nextAudioPollInterval) so a short transcode isn't hidden behind a
      // flat interval that already elapsed.
      refetchInterval: (query) =>
        nextAudioPollInterval(query.state.data, Date.now()),
    },
  );

  useEffect(() => {
    const newMap: Record<string, AudioUrlMapEntry> = {};

    if (audioQuery.data?.items) {
      for (const item of audioQuery.data.items) {
        const audioItem = item as typeof item & {
          sourceUrl?: string | null;
          waveformPeaks?: AudioUrlMapEntry["waveformPeaks"];
        };
        newMap[item.id] = {
          hlsPlaylistUrl: item.hlsPlaylistUrl,
          sourceUrl: audioItem.sourceUrl ?? null,
          status: item.status,
          createdAt: item.createdAt,
          waveformPeaks: audioItem.waveformPeaks ?? null,
        };
      }
    }

    setAudioUrlMap((prev) => (sameAudioMap(prev, newMap) ? prev : newMap));
  }, [audioQuery.data?.items]);

  return { imageUrlMap, audioUrlMap };
}
