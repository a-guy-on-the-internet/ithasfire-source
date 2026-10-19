/**
 * Listen-URL selection for lineup rows (lineup-listen-embeds spec §2).
 *
 * Given a page's blocks, pick the single best URL a visitor can *play inline*
 * for that act. Pure function — no I/O, never throws on malformed block data.
 */

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { parseEmbedUrl } from "./parse-embed-url";
import type { MediaEmbedProviderId } from "./providers";

/**
 * Providers whose iframe embeds are music players. Links-block candidates and
 * external-entry URLs are restricted to these — a YouTube URL in a links block
 * is usually social, not music, and `renderMode: "link"` providers (Bandcamp)
 * are not inline-playable.
 */
const MUSIC_EMBED_PROVIDERS: ReadonlySet<MediaEmbedProviderId> = new Set([
  "spotify",
  "soundcloud",
  "appleMusic",
]);

/**
 * Returns the canonical URL when `url` parses as an **iframe** embed for a
 * music provider (`spotify` / `soundcloud` / `appleMusic`), else `null`.
 *
 * Used for links-block candidates and for external lineup entries'
 * `externalUrl`. The canonical `sourceUrl` is returned (never the raw input)
 * so the client's re-parse (EpkEmbed discipline) sees a clean URL.
 */
export function toMusicListenUrl(url: unknown): string | null {
  const parsed = parseEmbedUrl(url);
  if (!parsed) return null;
  if (parsed.renderMode !== "iframe") return null;
  if (!MUSIC_EMBED_PROVIDERS.has(parsed.provider)) return null;
  return parsed.sourceUrl;
}

/** Any-provider variant: canonical URL iff it parses to an iframe embed. */
function toIframeListenUrl(url: unknown): string | null {
  const parsed = parseEmbedUrl(url);
  if (!parsed || parsed.renderMode !== "iframe") return null;
  return parsed.sourceUrl;
}

/**
 * Pick the first playable listen URL from a page's blocks.
 *
 * CONTRACT: `blocks` must already be visibility-filtered (the caller passes
 * only `visible` blocks of a PUBLIC page, in stored order) — this function
 * does NOT re-check `visible` or page visibility.
 *
 * Priority (spec §2):
 *  1. `tracks` block → first `tracks[].url` that parses to an iframe embed
 *     (any provider — the block is explicitly music-curated).
 *  2. else `music` block → first `embeds[].url`, same rule.
 *  3. else `links` block → first `links[].url` that is a music-provider
 *     iframe embed only (spotify / soundcloud / appleMusic).
 *
 * Malformed or empty block data is skipped, never throws. Returns the
 * canonical (parser-emitted) URL, or `null` when nothing is playable.
 */
export function pickListenUrl(blocks: PageBlockRecord[]): string | null {
  if (!Array.isArray(blocks)) return null;

  const fromTracks = firstUrl(blocks, "tracks", "tracks", toIframeListenUrl);
  if (fromTracks) return fromTracks;

  const fromMusic = firstUrl(blocks, "music", "embeds", toIframeListenUrl);
  if (fromMusic) return fromMusic;

  return firstUrl(blocks, "links", "links", toMusicListenUrl);
}

/**
 * Scan every block of `kind` (in stored order) and return the first entry of
 * `data[field]` whose `url` passes `accept`. Defensive against arbitrary
 * stored JSON — non-object data, non-array fields, and non-object items are
 * all skipped silently.
 */
function firstUrl(
  blocks: PageBlockRecord[],
  kind: string,
  field: string,
  accept: (url: unknown) => string | null,
): string | null {
  for (const block of blocks) {
    if (!block || block.kind !== kind) continue;
    const data = block.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      continue;
    }
    const items = (data as Record<string, unknown>)[field];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const url = (item as Record<string, unknown>).url;
      const accepted = accept(url);
      if (accepted) return accepted;
    }
  }
  return null;
}
