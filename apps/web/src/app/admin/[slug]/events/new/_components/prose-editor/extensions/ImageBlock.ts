/**
 * Custom TipTap extension for image blocks.
 *
 * Unlike the default Image extension, this stores image IDs rather than URLs,
 * allowing server-side image management and deferred URL resolution.
 *
 * ProseMirror node structure:
 * - type: "imageBlock"
 * - attrs: { imageId, alt, align, width, float, caption }
 */

import { Node, mergeAttributes } from "@tiptap/core";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { safeHref } from "@/lib/escape-html";
import { ImageBlockNodeView } from "./ImageBlockNodeView";

/**
 * The only `width` shapes the editor produces ("42%", "300px"). Doc attrs
 * are user-authored, so anything else falls back to "100%" in renderHTML
 * rather than being interpolated into the figure's style attribute.
 */
const SAFE_CSS_WIDTH = /^\d{1,4}(?:\.\d+)?(?:px|%)$/;

/** A caption is one short line under the image. */
export const IMAGE_CAPTION_MAX_LENGTH = 200;

/**
 * The stored form of a caption: one line (control characters and line
 * breaks become spaces, runs of whitespace collapse), trimmed, at most
 * {@link IMAGE_CAPTION_MAX_LENGTH} characters. Empty → null, so an image
 * with no caption renders no <figcaption>. Doc attrs are user-authored, so
 * parseHTML and renderHTML both pass through here, which also keeps
 * HTML → doc → HTML stable.
 */
export function normalizeImageCaption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const oneLine = raw
    // eslint-disable-next-line no-control-regex -- control chars are the point
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, IMAGE_CAPTION_MAX_LENGTH)
    .trim();
  return oneLine || null;
}

export type ImageBlockAlignment = "left" | "center" | "right";
export type ImageBlockFloat = "none" | "left" | "right";

export interface ImageBlockOptions {
  HTMLAttributes: Record<string, unknown>;
  /** Max width for images (default: 100%) */
  maxWidth?: string;
}

export interface ImageBlockAttributes {
  /** Reference to Image record by ID */
  imageId: string;
  /** Alt text for accessibility */
  alt?: string;
  /** Image alignment in the document */
  align?: ImageBlockAlignment;
  /** Display width (CSS string, e.g., "100%", "300px") */
  width?: string;
  /** Float mode: text wraps around the image when "left" or "right" */
  float?: ImageBlockFloat;
  /** Resolved public URL (populated by client) */
  src?: string;
  /** Optional one-line caption shown under the image */
  caption?: string | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    imageBlock: {
      /**
       * Insert an image block at the current position
       */
      insertImageBlock: (attrs: ImageBlockAttributes) => ReturnType;
      /**
       * Update image block attributes
       */
      updateImageBlock: (attrs: Partial<ImageBlockAttributes>) => ReturnType;
    };
  }
}

export const ImageBlock = Node.create<ImageBlockOptions>({
  name: "imageBlock",

  group: "block",

  // Images are leaf nodes (no children)
  content: "",

  // Not editable inline
  atom: true,

  // Allow dragging
  draggable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      maxWidth: "100%",
    };
  },

  addAttributes() {
    return {
      imageId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-image-id"),
        renderHTML: (attributes) => {
          if (!attributes.imageId) return {};
          return { "data-image-id": attributes.imageId };
        },
      },
      alt: {
        default: "",
        parseHTML: (element) =>
          element.querySelector("img")?.getAttribute("alt") ?? "",
        renderHTML: (attributes) => ({}), // Rendered in img tag
      },
      align: {
        default: "center",
        parseHTML: (element) =>
          (element.getAttribute("data-align") as ImageBlockAlignment) ??
          "center",
        renderHTML: (attributes) => {
          return { "data-align": attributes.align ?? "center" };
        },
      },
      width: {
        default: "100%",
        parseHTML: (element) => element.getAttribute("data-width") ?? "100%",
        renderHTML: (attributes) => {
          return { "data-width": attributes.width ?? "100%" };
        },
      },
      float: {
        default: "none",
        parseHTML: (element) =>
          (element.getAttribute("data-float") as ImageBlockFloat) ?? "none",
        renderHTML: (attributes) => {
          return { "data-float": attributes.float ?? "none" };
        },
      },
      // src is resolved at runtime (not stored in doc).
      // The value is passed through so the node-level renderHTML()
      // can produce ready-to-display output during server-side
      // HTML generation (generateHTML).  In the interactive editor
      // the React node view takes over and ignores this.
      src: {
        default: null,
        parseHTML: (element) =>
          element.querySelector("img")?.getAttribute("src"),
        renderHTML: (attributes) => {
          if (!attributes.src) return {};
          // Doc-baked src values reach renderHTML when no imageUrlMap is
          // provided (e.g. announcement previews), so scheme-check them.
          return { src: safeHref(attributes.src) };
        },
      },
      // Rendered as the figure's <figcaption> child by the node-level
      // renderHTML, never as an attribute.
      caption: {
        default: null,
        parseHTML: (element) =>
          normalizeImageCaption(
            element.querySelector("figcaption")?.textContent,
          ),
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-type="image-block"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    // Use the node's own attrs for styling logic — these are the raw
    // values (align, width, float, src, alt) rather than the data-*
    // HTML attribute names produced by attribute-level renderHTML.
    const attrs = node.attrs as ImageBlockAttributes;
    const align = attrs.align ?? "center";
    const rawWidth = attrs.width ?? "100%";
    const width = SAFE_CSS_WIDTH.test(rawWidth) ? rawWidth : "100%";
    const floatMode = attrs.float ?? "none";
    const src = attrs.src ?? null;
    const alt = attrs.alt ?? "";
    const caption = normalizeImageCaption(attrs.caption);
    // Text child, so the DOMSerializer escapes it.
    const captionChild: DOMOutputSpec[] = caption
      ? [["figcaption", {}, caption]]
      : [];

    // Strip keys from HTMLAttributes that should not appear directly
    // on the <figure> element (they go on <img> or are only styling hints).
    const { src: _src, ...figureAttrs } = HTMLAttributes;

    // When a resolved src is available (server-side HTML generation),
    // render a fully-styled <figure>+<img> so the output is ready to
    // display without any post-processing.
    if (src) {
      const imgStyle =
        "width: 100%; height: auto; border-radius: 8px; display: block;";
      let figureStyle: string;

      if (floatMode === "left") {
        figureStyle = `float: left; margin: 0 16px 8px 0; width: ${width}; max-width: 75%;`;
      } else if (floatMode === "right") {
        figureStyle = `float: right; margin: 0 0 8px 16px; width: ${width}; max-width: 75%;`;
      } else if (align === "center") {
        figureStyle = `margin: 16px auto; width: ${width}; max-width: 100%;`;
      } else if (align === "right") {
        figureStyle = `margin: 16px 0 16px auto; width: ${width}; max-width: 100%;`;
      } else {
        figureStyle = `margin: 16px auto 16px 0; width: ${width}; max-width: 100%;`;
      }

      return [
        "figure",
        mergeAttributes(this.options.HTMLAttributes, figureAttrs, {
          "data-type": "image-block",
          style: figureStyle,
        }),
        [
          "img",
          { src: safeHref(src), alt: alt || "Event image", style: imgStyle },
        ],
        ...captionChild,
      ];
    }

    // Fallback: no src resolved yet (interactive editor uses the React
    // node view instead, so this path is only hit during generateHTML
    // calls where no imageUrlMap was provided).
    return [
      "figure",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-type": "image-block",
      }),
      ["img", { src: "", alt: alt || "" }],
      ...captionChild,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageBlockNodeView as any);
  },

  addCommands() {
    return {
      insertImageBlock:
        (attrs) =>
        ({ commands }) => {
          // Insert the image followed by an empty paragraph so the cursor
          // lands beneath the image and the user can keep typing without
          // being trapped at the end of an atomic node. Without this, a
          // floated/centered image inserted at the end of the document
          // leaves no caret target and Enter just nudges the image.
          return commands.insertContent([
            { type: this.name, attrs },
            { type: "paragraph" },
          ]);
        },
      updateImageBlock:
        (attrs) =>
        ({ commands }) => {
          return commands.updateAttributes(this.name, attrs);
        },
    };
  },
});
