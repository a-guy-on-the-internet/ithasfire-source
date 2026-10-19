"use client";

import { useEffect, useRef, type RefObject } from "react";
import {
  inferSizing,
  MEDIA_EMBED_PROVIDERS,
  type MediaEmbedProviderId,
} from "@th/core/lib/embeds";
import type { MediaEmbedAttrs, MediaEmbedRenderMode } from "./MediaEmbed";

const providerIds = new Set(
  Object.keys(MEDIA_EMBED_PROVIDERS) as MediaEmbedProviderId[],
);

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

export function useHydrateMediaEmbeds(
  containerRef: RefObject<HTMLElement | null>,
  deps?: unknown[],
) {
  const cleanupRef = useRef<(() => void)[]>([]);
  const hydratedRef = useRef(new WeakSet<HTMLElement>());

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function hydrate() {
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
      hydratedRef.current = new WeakSet();

      const figures = container!.querySelectorAll<HTMLElement>(
        'figure[data-type="media-embed"]',
      );
      figures.forEach((figure) => {
        if (hydratedRef.current.has(figure)) return;

        const embed = mediaEmbedAttrsFromElement(figure);
        // Mark the figure seen BEFORE the bail-out. An unreadable figure
        // (unknown provider, missing data-external-id / data-embed-url) left
        // out of `hydratedRef` reads as new to the observer below on every
        // later DOM mutation; each re-hydrate rebuilt the valid embeds beside
        // it, which mutated the DOM again: an endless loop that froze the tab.
        // Same fix as `useHydrateAudioBlocks`.
        hydratedRef.current.add(figure);
        if (!embed) return;

        figure.innerHTML = "";
        figure.removeAttribute("style");
        figure.style.margin = "16px 0";

        const cleanup = mountMediaEmbed(figure, embed);
        cleanupRef.current.push(cleanup);
      });
    }

    hydrate();

    const observer = new MutationObserver(() => {
      const figures = container.querySelectorAll<HTMLElement>(
        'figure[data-type="media-embed"]',
      );
      const hasUnhydrated = Array.from(figures).some(
        (figure) => !hydratedRef.current.has(figure),
      );
      if (hasUnhydrated) hydrate();
    });

    observer.observe(container, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      cleanupRef.current.forEach((fn) => fn());
      cleanupRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, ...(deps ?? [])]);
}

function mountMediaEmbed(
  container: HTMLElement,
  embed: MediaEmbedAttrs,
): () => void {
  const node = buildMediaEmbed(embed);
  container.appendChild(node);
  return () => node.remove();
}

function buildMediaEmbed(embed: MediaEmbedAttrs): HTMLElement {
  return isAllowedIframeUrl(embed)
    ? buildIframeEmbed(embed)
    : buildLinkEmbed(embed);
}

// BARE player — no labeled header, no visible container chrome. Mirrors the
// React <MediaEmbed> component: only the responsive box + sandboxed iframe show.
function buildIframeEmbed(embed: MediaEmbedAttrs): HTMLElement {
  const meta = MEDIA_EMBED_PROVIDERS[embed.provider];
  const title = getFrameTitle(embed);

  const outer = mk("div", playerWrapStyle);
  outer.setAttribute("data-testid", "media-embed");

  const frameWrap = mk("div", "width:100%;");
  applyEmbedSizing(frameWrap, embed);

  const iframe = document.createElement("iframe");
  iframe.src = embed.embedUrl;
  iframe.title = title;
  iframe.loading = "lazy";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.sandbox.add(
    "allow-scripts",
    "allow-same-origin",
    "allow-presentation",
    "allow-popups",
    "allow-popups-to-escape-sandbox",
  );
  iframe.allow = meta.iframeAllow;
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.style.display = "block";

  frameWrap.appendChild(iframe);
  outer.appendChild(frameWrap);
  return outer;
}

// Graceful external-link fallback (e.g. Bandcamp, whose EmbeddedPlayer needs a
// numeric id absent from the public URL — see MediaEmbed.tsx). A clean Swiss
// link card, not a broken-looking embed shell.
function buildLinkEmbed(embed: MediaEmbedAttrs): HTMLElement {
  const providerLabel = getProviderLabel(embed);
  const sourceUrl = safeHttpUrl(embed.sourceUrl);

  if (!sourceUrl) {
    const outer = mk(
      "div",
      linkCardStyle + "color:var(--colorMuted, #5C544A);cursor:default;",
    );
    outer.setAttribute("data-testid", "media-embed-link");
    outer.textContent = "Media link unavailable";
    return outer;
  }

  const link = document.createElement("a");
  link.href = sourceUrl.toString();
  link.target = "_blank";
  link.rel = "noopener noreferrer nofollow";
  link.setAttribute("style", linkCardStyle);
  link.setAttribute("data-testid", "media-embed-link");
  link.textContent = `Open on ${providerLabel}`;
  const arrow = document.createElement("span");
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = " ↗";
  link.appendChild(arrow);
  return link;
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

function applyEmbedSizing(el: HTMLElement, embed: MediaEmbedAttrs): void {
  const sizing = inferSizing(embed.provider, embed.kind);
  if (sizing.kind === "height") {
    el.style.height = `${sizing.px}px`;
  } else {
    el.style.aspectRatio = sizing.value;
  }
}

function getProviderLabel(embed: MediaEmbedAttrs): string {
  return MEDIA_EMBED_PROVIDERS[embed.provider]?.displayName ?? "Media";
}

// Accessible iframe title only — never surfaced as visible "X EMBED" chrome.
function getFrameTitle(embed: MediaEmbedAttrs): string {
  const title = embed.title?.trim();
  return title || `${getProviderLabel(embed)} player`;
}

function mk<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.setAttribute("style", style);
  return element;
}

const playerWrapStyle = "border-radius:0;overflow:hidden;";
const linkCardStyle =
  "display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:10px 16px;border:2px solid var(--borderColor, #211C16);border-radius:0;background:var(--surface, #FDFAF3);color:var(--accentText, #A8300F);font-size:13px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;text-decoration:none;";

function mediaEmbedAttrsFromElement(
  element: HTMLElement,
): MediaEmbedAttrs | null {
  const provider = element.getAttribute(
    "data-provider",
  ) as MediaEmbedProviderId | null;
  const sourceUrl = element.getAttribute("data-source-url");
  const embedUrl = element.getAttribute("data-embed-url");
  const externalId = element.getAttribute("data-external-id");
  const renderMode = element.getAttribute(
    "data-render-mode",
  ) as MediaEmbedRenderMode | null;

  if (!provider || !providerIds.has(provider)) return null;
  if (!sourceUrl || !embedUrl || !externalId) return null;
  if (renderMode !== "iframe" && renderMode !== "link") return null;

  return {
    provider,
    sourceUrl,
    embedUrl,
    externalId,
    renderMode,
    kind: element.getAttribute("data-kind") ?? undefined,
    title: element.getAttribute("data-title") ?? undefined,
    aspectRatio: element.getAttribute("data-aspect-ratio") ?? undefined,
  };
}
