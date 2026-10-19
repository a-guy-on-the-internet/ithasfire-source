"use client";

import type { CSSProperties } from "react";
import { ExternalLink } from "lucide-react";
import {
  inferSizing,
  MEDIA_EMBED_PROVIDERS,
  type MediaEmbedProviderId,
} from "@th/core/lib/embeds";

export type MediaEmbedRenderMode = "iframe" | "link";

export interface MediaEmbedAttrs {
  provider: MediaEmbedProviderId;
  sourceUrl: string;
  embedUrl: string;
  externalId: string;
  renderMode: MediaEmbedRenderMode;
  kind?: string;
  title?: string;
  aspectRatio?: string;
}

export interface MediaEmbedProps {
  embed: MediaEmbedAttrs;
  /**
   * Retained for call-site compatibility. The labeled header row was removed
   * (the product renders the BARE player — no "X EMBED" chrome), so this prop
   * no longer gates any UI on the iframe path.
   */
  compact?: boolean;
}

function safeHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isAllowedIframeUrl(embed: MediaEmbedAttrs): boolean {
  const meta = MEDIA_EMBED_PROVIDERS[embed.provider];
  if (!meta || meta.renderMode !== "iframe" || embed.renderMode !== "iframe")
    return false;

  const embedUrl = safeHttpUrl(embed.embedUrl);
  if (!embedUrl || embedUrl.protocol !== "https:") return false;

  const allowedHosts = meta.cspFrameSrc
    .map((source) => safeHttpUrl(source)?.hostname)
    .filter((host): host is string => Boolean(host));

  return allowedHosts.includes(embedUrl.hostname);
}

/**
 * Sizing CSS for the iframe wrapper.
 *
 * Audio providers use a fixed pixel height matching the provider's
 * intrinsic player size. Video providers use an aspect-ratio box that
 * scales with the column. Stored `aspectRatio` is intentionally NOT
 * honored — provider×kind sizing always wins so embeds render at the
 * size the provider actually expects.
 */
function getEmbedSizingStyle(embed: MediaEmbedAttrs): CSSProperties {
  const sizing = inferSizing(embed.provider, embed.kind);
  if (sizing.kind === "height") {
    return { height: `${sizing.px}px`, width: "100%" };
  }
  return { aspectRatio: sizing.value, width: "100%" };
}

function getProviderLabel(embed: MediaEmbedAttrs): string {
  return MEDIA_EMBED_PROVIDERS[embed.provider]?.displayName ?? "Media";
}

// BARE player wrapper — no labeled header, no visible container border/background.
// Only the responsive aspect-ratio (or fixed-height) box + the sandboxed iframe
// render, so the provider's own player chrome is the only chrome the user sees.
const playerWrapStyle: CSSProperties = {
  margin: "16px 0",
  borderRadius: 0,
  overflow: "hidden",
};

// Graceful external-link fallback. Used ONLY when the embed cannot resolve to a
// playable iframe (see the Bandcamp note below) — a deliberate, tasteful Swiss
// link card, not a broken-looking embed shell. accentText (#B93312) on surface
// clears AA (5.22:1); the ↗ trails as a "takes-you-somewhere" affordance.
const linkCardStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  margin: "16px 0",
  minHeight: 44,
  padding: "10px 16px",
  border: "2px solid var(--borderColor, #211C16)",
  borderRadius: 0,
  background: "var(--surface, #FDFAF3)",
  color: "var(--accentText, #A8300F)",
  fontSize: 13,
  fontWeight: 800,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  textDecoration: "none",
};

export function MediaEmbed({ embed }: MediaEmbedProps) {
  const providerLabel = getProviderLabel(embed);
  // The iframe still needs an accessible frame title; keep it descriptive but
  // never surface it as visible "X EMBED" chrome.
  const frameTitle = embed.title?.trim() || `${providerLabel} player`;
  const sourceUrl = safeHttpUrl(embed.sourceUrl);

  if (embed.renderMode === "iframe" && isAllowedIframeUrl(embed)) {
    const meta = MEDIA_EMBED_PROVIDERS[embed.provider];
    return (
      <div style={playerWrapStyle} data-testid="media-embed">
        <div style={getEmbedSizingStyle(embed)}>
          <iframe
            src={embed.embedUrl}
            title={frameTitle}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            allow={meta.iframeAllow}
            style={{
              width: "100%",
              height: "100%",
              border: 0,
              display: "block",
            }}
          />
        </div>
      </div>
    );
  }

  // Link fallback. Reached for provider×URL shapes that cannot produce a player
  // iframe. The notable case is BANDCAMP: its EmbeddedPlayer iframe requires the
  // numeric album/track id (bandcamp.com/EmbeddedPlayer/album=<id>/…), which is
  // NOT present in a public album/track page URL — it can only be resolved via
  // an oEmbed / page-meta lookup that this slice does not perform. Bandcamp is
  // therefore `renderMode: "link"` (providers.ts) with an empty CSP frame-src,
  // so a real player is not achievable from the URL alone. This clean CTA is the
  // sanctioned graceful outcome until an oEmbed resolver lands.
  const href = sourceUrl?.toString();
  if (!href) {
    return (
      <div
        data-testid="media-embed-link"
        style={{
          ...linkCardStyle,
          color: "var(--colorMuted, #5C544A)",
          cursor: "default",
        }}
      >
        Media link unavailable
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      style={linkCardStyle}
      data-testid="media-embed-link"
    >
      Open on {providerLabel}
      <ExternalLink size={16} aria-hidden="true" />
    </a>
  );
}
