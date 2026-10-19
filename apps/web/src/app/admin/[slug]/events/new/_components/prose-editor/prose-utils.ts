import { generateHTML, generateJSON } from "@tiptap/html";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Typography from "@tiptap/extension-typography";
import type { ProseMirrorDoc } from "@th/schema";
import { PROSE_HEADING_LEVELS } from "@th/schema";
import { ImageBlock } from "./extensions/ImageBlock";
import { AudioBlock } from "./extensions/AudioBlock";
import { MediaEmbed } from "./extensions/MediaEmbed";

/**
 * Extensions configured to match the ProseEditor.
 * Used for generating HTML from ProseMirror JSON.
 * Must stay in sync with the extensions in ProseEditor.tsx.
 */
const getExtensions = () => [
  StarterKit.configure({
    heading: {
      levels: [...PROSE_HEADING_LEVELS],
    },
    codeBlock: false,
    code: false,
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: "https",
      // Mirrors the editor's allowlist (see ProseEditor.tsx) so server-side
      // HTML generation rejects the same scheme set the editor refuses to
      // create.
      protocols: ["http", "https", "mailto", "tel"],
      isAllowedUri: (url: string) => /^(https?:|mailto:|tel:)/i.test(url),
      HTMLAttributes: {
        rel: "noopener noreferrer nofollow",
      },
    },
  }),
  TextAlign.configure({
    types: ["heading", "paragraph"],
  }),
  Highlight.configure({ multicolor: false }),
  Typography,
  ImageBlock,
  AudioBlock,
  MediaEmbed,
];

/**
 * Audio URL map entry — one entry per audioUploadId.
 */
export interface AudioUrlMapEntry {
  sourceUrl?: string | null;
  hlsPlaylistUrl?: string | null;
  status?: string;
  createdAt?: Date | null;
  waveformPeaks?: number[] | null;
}

/**
 * Convert ProseMirror JSON document to HTML string.
 * Useful for email rendering and server-side display.
 *
 * When `imageUrlMap` is provided, image URLs are resolved into the
 * document *before* calling tiptap's `generateHTML()`.  The ImageBlock
 * extension's `renderHTML()` then produces fully-styled output in a
 * single pass — no regex post-processing needed.
 *
 * When `audioUrlMap` is provided, audio URLs are similarly resolved into
 * `audioBlock` nodes so AudioBlock.renderHTML() can produce an <audio> tag.
 *
 * @param doc - ProseMirror document
 * @param imageUrlMap - Optional map of imageId to public URL for rendering images
 * @param audioUrlMap - Optional map of audioUploadId to audio URLs for rendering players
 */
export const proseMirrorDocToHtml = (
  doc: ProseMirrorDoc,
  imageUrlMap?: Record<string, string>,
  audioUrlMap?: Record<string, AudioUrlMapEntry>,
): string => {
  if (!doc?.content) return "";

  // Resolve image and audio IDs to URLs inside the doc tree
  let resolvedDoc = doc;
  if (imageUrlMap) {
    resolvedDoc = resolveImageUrls(resolvedDoc, imageUrlMap);
  }
  if (audioUrlMap) {
    resolvedDoc = resolveAudioUrls(resolvedDoc, audioUrlMap);
  }

  return generateHTML(resolvedDoc, getExtensions());
};

/**
 * Deep-clone a ProseMirror doc, injecting resolved `src` URLs into
 * every `imageBlock` node whose `imageId` appears in the map.
 * Nodes without a matching URL get `src` set to `null` so the
 * extension's renderHTML falls back to a placeholder.
 */
function resolveImageUrls(
  doc: ProseMirrorDoc,
  imageUrlMap: Record<string, string>,
): ProseMirrorDoc {
  return {
    ...doc,
    content: doc.content.map((node) => resolveNode(node, imageUrlMap)),
  };
}

/**
 * Deep-clone a ProseMirror doc, injecting resolved audio URLs into
 * every `audioBlock` node whose `audioUploadId` appears in the map.
 */
function resolveAudioUrls(
  doc: ProseMirrorDoc,
  audioUrlMap: Record<string, AudioUrlMapEntry>,
): ProseMirrorDoc {
  return {
    ...doc,
    content: doc.content.map((node) => resolveAudioNode(node, audioUrlMap)),
  };
}

function resolveNode(
  node: ProseMirrorDoc["content"][number],
  imageUrlMap: Record<string, string>,
): ProseMirrorDoc["content"][number] {
  if (node.type === "imageBlock") {
    const imageId = (node as any).attrs?.imageId as string | undefined;
    const url = imageId ? imageUrlMap[imageId] : undefined;
    return {
      ...node,
      attrs: {
        ...(node as any).attrs,
        src: url ?? null,
      },
    };
  }

  // Recurse into children
  if ((node as any).content) {
    return {
      ...node,
      content: (node as any).content.map((child: any) =>
        resolveNode(child, imageUrlMap),
      ),
    } as any;
  }

  return node;
}

function resolveAudioNode(
  node: ProseMirrorDoc["content"][number],
  audioUrlMap: Record<string, AudioUrlMapEntry>,
): ProseMirrorDoc["content"][number] {
  if (node.type === "audioBlock") {
    const audioUploadId = (node as any).attrs?.audioUploadId as
      | string
      | undefined;
    const resolved =
      audioUploadId !== undefined && audioUploadId in audioUrlMap;
    const entry = audioUploadId ? audioUrlMap[audioUploadId] : undefined;
    const existing = (node as any).attrs ?? {};
    // PRESENCE in the map is authoritative for `sourceUrl`, not truthiness.
    //
    // `sourceUrl` is a presigned credential that the server now mints per read
    // and that the editor may have baked into the saved document at some point
    // in the past. When the server HAS resolved this upload and deliberately
    // returned no source URL — the object is gone, or signing failed — falling
    // back to the baked copy hands the browser a dead credential, and because
    // `AudioBlock.renderHTML` prefers `sourceUrl` over `hlsPlaylistUrl`, it
    // also prevents the HLS fallback from ever being reached. Only use the
    // baked value when the server said nothing about this upload at all.
    //
    // The other attrs keep `??` fallbacks: they are plain metadata, not
    // credentials, and a stale title or waveform is harmless.
    return {
      ...node,
      attrs: {
        ...existing,
        sourceUrl: resolved
          ? (entry?.sourceUrl ?? null)
          : (existing.sourceUrl ?? null),
        hlsPlaylistUrl:
          entry?.hlsPlaylistUrl ?? existing.hlsPlaylistUrl ?? null,
        status: entry?.status ?? existing.status ?? "PENDING",
        waveformPeaks: entry?.waveformPeaks ?? existing.waveformPeaks ?? null,
      },
    };
  }

  // Recurse into children
  if ((node as any).content) {
    return {
      ...node,
      content: (node as any).content.map((child: any) =>
        resolveAudioNode(child, audioUrlMap),
      ),
    } as any;
  }

  return node;
}

/**
 * Convert HTML string to ProseMirror JSON document.
 * Useful for importing content from other sources.
 */
export const htmlToProseMirrorDoc = (html: string): ProseMirrorDoc => {
  return generateJSON(html, getExtensions()) as ProseMirrorDoc;
};

/**
 * Check if a ProseMirror doc has any meaningful content.
 * Returns false for empty docs or docs with only empty paragraphs.
 */
export const hasContent = (doc: ProseMirrorDoc | null): boolean => {
  if (!doc?.content) return false;

  return doc.content.some((node) => {
    if (node.type === "paragraph") {
      // Check if paragraph has text content
      return (node as any).content?.some(
        (child: { type: string; text?: string }) =>
          child.type === "text" && child.text?.trim(),
      );
    }
    // Non-paragraph nodes count as content
    return true;
  });
};

/**
 * Create an empty ProseMirror document.
 */
export const createEmptyDoc = (): ProseMirrorDoc => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});
