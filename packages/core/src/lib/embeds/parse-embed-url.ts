/**
 * Pure URL parser for media embed providers.
 *
 * - Strict allowlist of hostnames per provider.
 * - Returns `null` for any URL that doesn't cleanly match.
 * - `embedUrl` is constructed deterministically from the parsed external id;
 *   the user's pasted URL is never reflected verbatim into the iframe `src`.
 * - Never accepts iframe HTML — only plain URLs.
 */

import { MEDIA_EMBED_PROVIDERS, type MediaEmbedProviderId } from "./providers";

export type MediaEmbedRenderMode = "iframe" | "link";

export type ParsedMediaEmbed = {
  provider: MediaEmbedProviderId;
  /** Canonicalized version of the user's pasted URL. */
  sourceUrl: string;
  /** URL we will put in the iframe `src` attribute. */
  embedUrl: string;
  /** Provider-specific id (video id, track id, …). */
  externalId: string;
  /** Renderer contract; Bandcamp is link-card-only until oEmbed resolves player ids. */
  renderMode: MediaEmbedRenderMode;
  /** Optional sub-kind (e.g. "track", "album", "playlist"). */
  kind?: string;
};

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const NUMERIC_ID_RE = /^[0-9]+$/;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;
const APPLE_MUSIC_KINDS = new Set([
  "album",
  "playlist",
  "song",
  "music-video",
  "station",
]);
const SPOTIFY_KINDS = new Set([
  "track",
  "album",
  "playlist",
  "artist",
  "episode",
  "show",
]);

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);

const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);

const SPOTIFY_HOSTS = new Set(["open.spotify.com"]);

const APPLE_MUSIC_HOSTS = new Set(["music.apple.com", "embed.music.apple.com"]);

const SOUNDCLOUD_HOSTS = new Set([
  "soundcloud.com",
  "www.soundcloud.com",
  "m.soundcloud.com",
  "on.soundcloud.com",
]);

/**
 * Host-only provider match — the domain-allowlist half of `parseEmbedUrl`,
 * exposed as a single source of truth for storage-time validation (musician
 * EPK `music` / `tracks` blocks, NFR-003). Returns the provider whose
 * allowlisted hostname the URL belongs to, or `null` for any off-allowlist /
 * non-http(s) / credential-bearing URL. Unlike `parseEmbedUrl` it does NOT
 * require a parseable track/video id, so bare profile URLs still validate;
 * renderers re-run the full `parseEmbedUrl` before building any iframe `src`.
 */
export function matchEmbedProviderByHost(
  input: unknown,
): MediaEmbedProviderId | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) return "youtube";
  if (VIMEO_HOSTS.has(host)) return "vimeo";
  if (SPOTIFY_HOSTS.has(host)) return "spotify";
  if (APPLE_MUSIC_HOSTS.has(host)) return "appleMusic";
  if (SOUNDCLOUD_HOSTS.has(host)) return "soundcloud";
  // Bandcamp needs an artist subdomain; the bare apex is not a player host.
  if (host.endsWith(".bandcamp.com")) return "bandcamp";
  return null;
}

export function parseEmbedUrl(input: unknown): ParsedMediaEmbed | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  // Reject anything with credentials in the URL.
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase();

  if (YOUTUBE_HOSTS.has(host)) return parseYouTube(url, host);
  if (VIMEO_HOSTS.has(host)) return parseVimeo(url, host);
  if (SPOTIFY_HOSTS.has(host)) return parseSpotify(url);
  if (APPLE_MUSIC_HOSTS.has(host)) return parseAppleMusic(url);
  if (SOUNDCLOUD_HOSTS.has(host)) return parseSoundCloud(url);
  // Bandcamp uses subdomains (artist.bandcamp.com) plus the bare domain for
  // label pages. We accept any *.bandcamp.com but reject bandcamp.com itself
  // since artist subdomain is required for track/album pages.
  if (host === "bandcamp.com" || host.endsWith(".bandcamp.com")) {
    return parseBandcamp(url, host);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// YouTube
// ─────────────────────────────────────────────────────────────────────────────

function parseYouTube(url: URL, host: string): ParsedMediaEmbed | null {
  const path = url.pathname;
  let videoId: string | null = null;

  if (host === "youtu.be") {
    // https://youtu.be/{id}
    const seg = path.split("/").filter(Boolean)[0];
    if (seg) videoId = seg;
  } else {
    // /watch?v=ID
    if (path === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      // /embed/ID, /v/ID, /shorts/ID
      const match = path.match(/^\/(?:embed|v|shorts)\/([^/]+)/);
      if (match) videoId = match[1] ?? null;
    }
  }

  if (!videoId || !YOUTUBE_VIDEO_ID_RE.test(videoId)) return null;

  // Build embed URL using the privacy-friendly host. Carry over a small
  // allowlist of known-safe query params (start/end as integers, list as
  // playlist id matching the safe-id regex).
  const params = new URLSearchParams();
  const start = url.searchParams.get("start") ?? url.searchParams.get("t");
  if (start && /^[0-9]{1,6}$/.test(start)) params.set("start", start);
  const end = url.searchParams.get("end");
  if (end && /^[0-9]{1,6}$/.test(end)) params.set("end", end);
  const list = url.searchParams.get("list");
  if (list && SAFE_ID_RE.test(list) && list.length <= 64) {
    params.set("list", list);
  }

  const query = params.toString();
  const embedUrl =
    `https://www.youtube-nocookie.com/embed/${videoId}` +
    (query ? `?${query}` : "");

  return {
    provider: "youtube",
    sourceUrl:
      `https://www.youtube.com/watch?v=${videoId}` + (query ? `&${query}` : ""),
    embedUrl,
    externalId: videoId,
    renderMode: MEDIA_EMBED_PROVIDERS.youtube.renderMode,
    kind: "video",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vimeo
// ─────────────────────────────────────────────────────────────────────────────

function parseVimeo(url: URL, host: string): ParsedMediaEmbed | null {
  const segments = url.pathname.split("/").filter(Boolean);
  let videoId: string | null = null;

  if (host === "player.vimeo.com") {
    // /video/{id}
    if (segments[0] === "video" && segments[1]) videoId = segments[1];
  } else {
    // /{id} or /{user}/{id} — only accept numeric ids.
    for (const seg of segments) {
      if (NUMERIC_ID_RE.test(seg)) {
        videoId = seg;
        break;
      }
    }
  }

  if (!videoId || !NUMERIC_ID_RE.test(videoId) || videoId.length > 16)
    return null;

  return {
    provider: "vimeo",
    sourceUrl: `https://vimeo.com/${videoId}`,
    embedUrl: `https://player.vimeo.com/video/${videoId}`,
    externalId: videoId,
    renderMode: MEDIA_EMBED_PROVIDERS.vimeo.renderMode,
    kind: "video",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spotify
// ─────────────────────────────────────────────────────────────────────────────

function parseSpotify(url: URL): ParsedMediaEmbed | null {
  // Path forms: /{kind}/{id}  or  /embed/{kind}/{id}
  const segments = url.pathname.split("/").filter(Boolean);
  let kind: string | null = null;
  let id: string | null = null;

  if (segments[0] === "embed" && segments.length >= 3) {
    kind = segments[1] ?? null;
    id = segments[2] ?? null;
  } else if (segments.length >= 2) {
    kind = segments[0] ?? null;
    id = segments[1] ?? null;
  }

  if (!kind || !id) return null;
  if (!SPOTIFY_KINDS.has(kind)) return null;
  if (!SPOTIFY_ID_RE.test(id)) return null;

  return {
    provider: "spotify",
    sourceUrl: `https://open.spotify.com/${kind}/${id}`,
    embedUrl: `https://open.spotify.com/embed/${kind}/${id}`,
    externalId: id,
    renderMode: MEDIA_EMBED_PROVIDERS.spotify.renderMode,
    kind,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Apple Music
// ─────────────────────────────────────────────────────────────────────────────

function parseAppleMusic(url: URL): ParsedMediaEmbed | null {
  // Path forms:
  //   /{country}/{kind}/{slug}/{id}
  //   /{country}/{kind}/{id}
  // Optional `?i={trackId}` for individual songs inside an album.
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 3) return null;

  const country = segments[0]!;
  const kind = segments[1]!;
  if (!COUNTRY_RE.test(country)) return null;
  if (!APPLE_MUSIC_KINDS.has(kind)) return null;

  // The trailing segment is the numeric id; anything before it (after kind)
  // is an optional human-readable slug.
  const last = segments[segments.length - 1]!;
  if (!NUMERIC_ID_RE.test(last) || last.length > 24) return null;
  const externalId = last;

  // Reconstruct the path, preserving the slug if present, and lowercasing
  // the country for canonical form.
  const slugSegments = segments.slice(2, segments.length - 1);
  for (const seg of slugSegments) {
    if (!SAFE_ID_RE.test(seg) && !/^[\w%-]+$/.test(seg)) {
      return null;
    }
  }
  const tail = [...slugSegments, externalId].join("/");
  const canonicalCountry = country.toLowerCase();

  // Optional `?i=` track id (numeric, capped length).
  const innerTrack = url.searchParams.get("i");
  let query = "";
  if (innerTrack && NUMERIC_ID_RE.test(innerTrack) && innerTrack.length <= 24) {
    query = `?i=${innerTrack}`;
  }

  return {
    provider: "appleMusic",
    sourceUrl: `https://music.apple.com/${canonicalCountry}/${kind}/${tail}${query}`,
    embedUrl: `https://embed.music.apple.com/${canonicalCountry}/${kind}/${tail}${query}`,
    externalId,
    renderMode: MEDIA_EMBED_PROVIDERS.appleMusic.renderMode,
    kind,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SoundCloud
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single-segment SoundCloud paths that are site pages, never user profiles.
 * A blocklisted single segment returns `null` (lineup-listen-embeds spec §1).
 */
const SOUNDCLOUD_RESERVED_PATHS = new Set([
  "discover",
  "search",
  "stream",
  "upload",
  "you",
  "pages",
  "charts",
  "feed",
  "messages",
  "notifications",
  "settings",
  "terms-of-use",
  "imprint",
  "jobs",
  "logout",
  "signin",
  "popular",
  "tags",
]);

function parseSoundCloud(url: URL): ParsedMediaEmbed | null {
  // Reject the share-shortener host; it requires an upstream resolve.
  if (url.hostname.toLowerCase() === "on.soundcloud.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 1) return null;

  // Validate path segments — narrow set of safe characters only.
  const slugRe = /^[A-Za-z0-9_.-]+$/;
  for (const seg of segments) {
    if (!slugRe.test(seg) || seg.length > 128) return null;
  }

  let kind: string | undefined;
  if (segments.length === 1) {
    // Bare profile path (soundcloud.com/{user}). The widget plays the user's
    // uploads, but reserved site paths (discover, search, …) are never users.
    if (SOUNDCLOUD_RESERVED_PATHS.has(segments[0]!.toLowerCase())) return null;
    kind = "user";
  } else if (segments[1] === "sets") {
    if (segments.length < 3) return null;
    kind = "set";
  } else {
    kind = "track";
  }

  // Build the canonical URL we will hand to the widget. We do NOT pass the
  // user-supplied URL straight through — we re-emit only the path.
  const canonical = `https://soundcloud.com/${segments.join("/")}`;
  const widgetParams = new URLSearchParams({
    url: canonical,
    color: "#000000",
    auto_play: "false",
    hide_related: "false",
    show_comments: "true",
    show_user: "true",
    show_reposts: "false",
    show_teaser: "true",
  });

  return {
    provider: "soundcloud",
    sourceUrl: canonical,
    embedUrl: `https://w.soundcloud.com/player/?${widgetParams.toString()}`,
    externalId: segments.join("/"),
    renderMode: MEDIA_EMBED_PROVIDERS.soundcloud.renderMode,
    kind,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bandcamp
// ─────────────────────────────────────────────────────────────────────────────

function parseBandcamp(url: URL, host: string): ParsedMediaEmbed | null {
  // Bandcamp embed iframes require the numeric album/track id, which is NOT
  // present in the public URL — it must be resolved via oEmbed or the page
  // meta tag. v1 accepts the URL and falls back to a link card; the web slice
  // (or a future oEmbed adapter) will replace `embedUrl` with the real
  // EmbeddedPlayer URL once the id is known.
  if (host === "bandcamp.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;

  const [kindSeg, slug] = segments;
  let kind: string;
  if (kindSeg === "album") kind = "album";
  else if (kindSeg === "track") kind = "track";
  else return null;

  if (!slug || !/^[A-Za-z0-9_-]+$/.test(slug) || slug.length > 128) return null;

  const canonical = `https://${host}/${kind}/${slug}`;
  return {
    provider: "bandcamp",
    sourceUrl: canonical,
    // Public Bandcamp URLs are not iframe player URLs. The web renderer must
    // render this as a link card until oEmbed resolves an EmbeddedPlayer URL.
    embedUrl: canonical,
    externalId: `${host}/${kind}/${slug}`,
    renderMode: MEDIA_EMBED_PROVIDERS.bandcamp.renderMode,
    kind,
  };
}
