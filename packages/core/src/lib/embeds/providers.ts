/**
 * Media embed provider allowlist.
 *
 * Anything outside this list must be rejected by `parseEmbedUrl` and the
 * `mediaEmbedNodeSchema` in `@th/schema`. New providers MUST be added in both
 * places (the schema's literal list mirrors `MEDIA_EMBED_PROVIDER_IDS` and is
 * asserted equivalent by tests).
 */

export const MEDIA_EMBED_PROVIDER_IDS = [
  "youtube",
  "spotify",
  "appleMusic",
  "soundcloud",
  "bandcamp",
  "vimeo",
] as const;

export type MediaEmbedProviderId = (typeof MEDIA_EMBED_PROVIDER_IDS)[number];

export type MediaEmbedProviderMeta = {
  id: MediaEmbedProviderId;
  displayName: string;
  /** Whether this provider renders as a sandboxed iframe or a safe external-link card. */
  renderMode: "iframe" | "link";
  /**
   * Default sizing strategy for the iframe wrapper.
   *
   * - `aspectRatio` providers (video) get a CSS `aspect-ratio` box that
   *   fills the column width and scales height proportionally.
   * - `height` providers (audio players) get a fixed pixel height matching
   *   the provider's intrinsic player size — Spotify track 152 px etc. —
   *   so a track doesn't render as a column-width square.
   *
   * `inferSizing(provider, kind)` picks the right one for a given embed.
   */
  defaultSizing: EmbedSizing;
  /** Value for the iframe's `allow=` attribute. */
  iframeAllow: string;
  /** Hostnames that must appear in the page's CSP `frame-src` directive. */
  cspFrameSrc: readonly string[];
};

export type EmbedSizing =
  | { kind: "aspectRatio"; value: string }
  | { kind: "height"; px: number };

export const MEDIA_EMBED_PROVIDERS: Record<
  MediaEmbedProviderId,
  MediaEmbedProviderMeta
> = {
  youtube: {
    id: "youtube",
    displayName: "YouTube",
    renderMode: "iframe",
    defaultSizing: { kind: "aspectRatio", value: "16/9" },
    iframeAllow:
      "accelerometer; autoplay; clipboard-write; encrypted-media; fullscreen; gyroscope; picture-in-picture; web-share",
    cspFrameSrc: [
      "https://www.youtube.com",
      "https://www.youtube-nocookie.com",
    ],
  },
  vimeo: {
    id: "vimeo",
    displayName: "Vimeo",
    renderMode: "iframe",
    defaultSizing: { kind: "aspectRatio", value: "16/9" },
    iframeAllow:
      "autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media",
    cspFrameSrc: ["https://player.vimeo.com"],
  },
  spotify: {
    id: "spotify",
    displayName: "Spotify",
    renderMode: "iframe",
    // Default to album-sized; track size is selected via inferSizing(kind).
    defaultSizing: { kind: "height", px: 352 },
    iframeAllow:
      "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture",
    cspFrameSrc: ["https://open.spotify.com"],
  },
  appleMusic: {
    id: "appleMusic",
    displayName: "Apple Music",
    renderMode: "iframe",
    // Default to album-sized; song / music-video sizes are selected via inferSizing(kind).
    defaultSizing: { kind: "height", px: 450 },
    iframeAllow: "autoplay *; encrypted-media *; fullscreen *; clipboard-write",
    cspFrameSrc: ["https://embed.music.apple.com"],
  },
  soundcloud: {
    id: "soundcloud",
    displayName: "SoundCloud",
    renderMode: "iframe",
    // Default to playlist-sized; track size is selected via inferSizing(kind).
    defaultSizing: { kind: "height", px: 450 },
    iframeAllow: "autoplay; encrypted-media; fullscreen",
    cspFrameSrc: ["https://w.soundcloud.com"],
  },
  bandcamp: {
    id: "bandcamp",
    displayName: "Bandcamp",
    renderMode: "link",
    // Bandcamp public URLs do not include the numeric player id required for
    // an iframe. v1 renders a safe link card; oEmbed (Stage 2) upgrades to
    // an iframe at the height below.
    defaultSizing: { kind: "height", px: 470 },
    iframeAllow: "",
    cspFrameSrc: [],
  },
};

/**
 * Pick a sizing strategy for a given provider/kind combination.
 *
 * Audio players use fixed pixel heights matching the provider's intrinsic
 * player size — Spotify track ~152 px, album ~352 px, etc. — so a single
 * track doesn't render as a column-width square.
 *
 * Video players (YouTube, Vimeo, Apple Music music-videos) use 16:9
 * aspect-ratio so they scale with column width.
 *
 * Falls back to the provider's default when `kind` is unknown.
 */
export function inferSizing(
  provider: MediaEmbedProviderId,
  kind?: string,
): EmbedSizing {
  const meta = MEDIA_EMBED_PROVIDERS[provider];
  if (!kind) return meta.defaultSizing;

  switch (provider) {
    case "spotify":
      // Track player is the compact bar; album/playlist/show/episode are taller.
      if (kind === "track") return { kind: "height", px: 152 };
      return { kind: "height", px: 352 };
    case "appleMusic":
      // Music videos are video; songs are the small audio player; albums and
      // playlists are tall.
      if (kind === "music-video") return { kind: "aspectRatio", value: "16/9" };
      if (kind === "song") return { kind: "height", px: 175 };
      return { kind: "height", px: 450 };
    case "soundcloud":
      // Compact bar for tracks; tall block for playlists/sets and user
      // profiles (the widget lists the user's uploads like a playlist).
      if (kind === "set" || kind === "playlist" || kind === "user")
        return { kind: "height", px: 450 };
      return { kind: "height", px: 166 };
    case "bandcamp":
      // Album / track players are the same height in Bandcamp's iframe.
      return { kind: "height", px: 470 };
    default:
      return meta.defaultSizing;
  }
}

/**
 * Backwards-compat shim: legacy code paths (and stored `aspectRatio` field
 * on existing embeds) still ask for an aspect ratio string. For audio
 * providers the new sizing is height-based, so we synthesize an effective
 * aspect ratio from the height assuming a 600 px column width — this is
 * approximate but matches the previous renderer's behavior closely enough
 * for tests and serialization round-trips.
 *
 * Prefer `inferSizing` in renderers.
 */
export function inferAspectRatio(
  provider: MediaEmbedProviderId,
  kind?: string,
): string {
  const sizing = inferSizing(provider, kind);
  if (sizing.kind === "aspectRatio") return sizing.value;
  // Approximate: assume 600 px column width. Renderers that respect the
  // height directly should not call this.
  const widthPx = 600;
  return `${widthPx}/${sizing.px}`;
}
