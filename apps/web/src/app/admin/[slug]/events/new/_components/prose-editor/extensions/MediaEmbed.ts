/**
 * Custom TipTap extension for canonical media embeds.
 *
 * ProseMirror node structure:
 * - type: "mediaEmbed"
 * - attrs: { provider, sourceUrl, embedUrl, externalId, renderMode, kind?, title?, aspectRatio? }
 */

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import {
  inferAspectRatio,
  MEDIA_EMBED_PROVIDERS,
  type MediaEmbedProviderId,
  type MediaEmbedRenderMode,
  type ParsedMediaEmbed,
} from "@th/core/lib/embeds";
import { safeHref } from "@/lib/escape-html";
import { MediaEmbedNodeView } from "./MediaEmbedNodeView";
import { mediaLayoutCss } from "./media-layout";

export type MediaEmbedAlignment = "left" | "center" | "right";
export type MediaEmbedFloat = "none" | "left" | "right";

export interface MediaEmbedAttributes {
  provider: MediaEmbedProviderId;
  sourceUrl: string;
  embedUrl: string;
  externalId: string;
  renderMode: MediaEmbedRenderMode;
  kind?: string;
  title?: string;
  aspectRatio?: string;
  /** Block alignment when float is "none" (left | center | right). */
  align?: MediaEmbedAlignment;
  /** Side-column float (none | left | right). Wins over `align` when set. */
  float?: MediaEmbedFloat;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mediaEmbed: {
      insertMediaEmbed: (attrs: MediaEmbedAttributes) => ReturnType;
      updateMediaEmbed: (attrs: Partial<MediaEmbedAttributes>) => ReturnType;
    };
  }
}

export function mediaEmbedAttrsFromParsed(
  parsed: ParsedMediaEmbed,
  extras: Pick<MediaEmbedAttributes, "title" | "aspectRatio"> = {},
): MediaEmbedAttributes {
  const attrs: MediaEmbedAttributes = {
    provider: parsed.provider,
    sourceUrl: parsed.sourceUrl,
    embedUrl: parsed.embedUrl,
    externalId: parsed.externalId,
    renderMode: parsed.renderMode,
    aspectRatio:
      extras.aspectRatio ?? inferAspectRatio(parsed.provider, parsed.kind),
  };

  if (parsed.kind) attrs.kind = parsed.kind;
  if (extras.title?.trim()) attrs.title = extras.title.trim();
  return attrs;
}

const optionalDataAttr = (key: string, value: unknown) => {
  if (typeof value !== "string" || value.length === 0) return {};
  return { [key]: value };
};

export const MediaEmbed = Node.create({
  name: "mediaEmbed",

  group: "block",
  content: "",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      provider: {
        default: undefined,
        parseHTML: (element) => element.getAttribute("data-provider"),
        renderHTML: (attributes) =>
          optionalDataAttr("data-provider", attributes.provider),
      },
      sourceUrl: {
        default: undefined,
        parseHTML: (element) => element.getAttribute("data-source-url"),
        renderHTML: (attributes) =>
          optionalDataAttr("data-source-url", attributes.sourceUrl),
      },
      embedUrl: {
        default: undefined,
        parseHTML: (element) => element.getAttribute("data-embed-url"),
        renderHTML: (attributes) =>
          optionalDataAttr("data-embed-url", attributes.embedUrl),
      },
      externalId: {
        default: undefined,
        parseHTML: (element) => element.getAttribute("data-external-id"),
        renderHTML: (attributes) =>
          optionalDataAttr("data-external-id", attributes.externalId),
      },
      renderMode: {
        default: undefined,
        parseHTML: (element) => element.getAttribute("data-render-mode"),
        renderHTML: (attributes) =>
          optionalDataAttr("data-render-mode", attributes.renderMode),
      },
      kind: {
        default: undefined,
        parseHTML: (element) => element.getAttribute("data-kind") ?? undefined,
        renderHTML: (attributes) =>
          optionalDataAttr("data-kind", attributes.kind),
      },
      title: {
        default: undefined,
        parseHTML: (element) => element.getAttribute("data-title") ?? undefined,
        renderHTML: (attributes) =>
          optionalDataAttr("data-title", attributes.title),
      },
      aspectRatio: {
        default: undefined,
        parseHTML: (element) =>
          element.getAttribute("data-aspect-ratio") ?? undefined,
        renderHTML: (attributes) =>
          optionalDataAttr("data-aspect-ratio", attributes.aspectRatio),
      },
      align: {
        default: "center",
        parseHTML: (element) =>
          (element.getAttribute("data-align") as MediaEmbedAlignment) ??
          "center",
        renderHTML: (attributes) => ({
          "data-align": attributes.align ?? "center",
        }),
      },
      float: {
        default: "none",
        parseHTML: (element) =>
          (element.getAttribute("data-float") as MediaEmbedFloat) ?? "none",
        renderHTML: (attributes) => ({
          "data-float": attributes.float ?? "none",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-type="media-embed"]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as Partial<MediaEmbedAttributes>;
    const provider = attrs.provider
      ? MEDIA_EMBED_PROVIDERS[attrs.provider]
      : null;
    const label =
      attrs.title ||
      (provider ? `${provider.displayName} embed` : "Media embed");
    // Doc attrs are user-authored: the DOMSerializer escapes the attribute
    // value but does not scheme-check it, so validate here.
    const href = safeHref(attrs.sourceUrl || attrs.embedUrl || "#");
    const layoutStyle = mediaLayoutCss(attrs.align, attrs.float);

    return [
      "figure",
      mergeAttributes(HTMLAttributes, {
        "data-type": "media-embed",
        style: `${layoutStyle}padding:0;border:2px solid var(--borderColor, #211C16);border-radius:0;background:var(--surface, #FDFAF3);overflow:hidden;`,
      }),
      [
        "a",
        {
          href,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
          style:
            "display:block;padding:12px 14px;color:var(--accentHard, #B93312);font-size:12px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;text-decoration:none;",
        },
        label,
      ],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MediaEmbedNodeView as any);
  },

  addCommands() {
    return {
      insertMediaEmbed:
        (attrs) =>
        ({ commands }) =>
          // See ImageBlock for rationale — trailing paragraph so the cursor
          // lands beneath the embed rather than on an atomic node.
          commands.insertContent([
            { type: this.name, attrs },
            { type: "paragraph" },
          ]),
      updateMediaEmbed:
        (attrs) =>
        ({ commands }) =>
          commands.updateAttributes(this.name, attrs),
    };
  },
});
