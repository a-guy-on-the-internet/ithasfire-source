"use client";

import { parseEmbedUrl } from "@th/core/lib/embeds";

import { MediaEmbed, type MediaEmbedAttrs } from "@/components/embeds/MediaEmbed";
import { BlockPillLink } from "./block-primitives";
import { getSafeExternalHref } from "./safe-block-url";

type Props = {
  url: string;
  /** Optional title shown in the embed header (used for curated track labels). */
  title?: string;
};

/**
 * Renders a single musician-EPK media embed through the sanctioned
 * `MediaEmbed` player. Host validation is already enforced server-side, but
 * re-parsing here guarantees the iframe `src` is provider-derived (never the
 * owner's raw string) and picks the correct CSP/sizing for the provider.
 *
 * Falls back to a safe external link when the URL cannot be resolved into a
 * playable embed (e.g. a bare profile URL with no track id), so the owner's
 * link is never silently dropped at render time.
 */
export function EpkEmbed({ url, title }: Props) {
  const parsed = parseEmbedUrl(url);

  if (parsed) {
    const embed: MediaEmbedAttrs = {
      provider: parsed.provider,
      sourceUrl: parsed.sourceUrl,
      embedUrl: parsed.embedUrl,
      externalId: parsed.externalId,
      renderMode: parsed.renderMode,
      kind: parsed.kind,
      title,
    };
    return <MediaEmbed embed={embed} />;
  }

  const safeUrl = getSafeExternalHref(url);
  if (!safeUrl) return null;
  return (
    <BlockPillLink href={safeUrl} external>
      {/* Keep the label and the ↗ as separate flex children so a long URL wraps
          inside the label span while the arrow stays put — it never lands on a
          line by itself. */}
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        {title || safeUrl}
      </span>
      <span aria-hidden style={{ whiteSpace: "nowrap" }}>
        &#8599;
      </span>
    </BlockPillLink>
  );
}
