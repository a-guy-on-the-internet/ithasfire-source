/**
 * Custom TipTap extension for audio blocks.
 *
 * Stores an audio upload ID and renders a player via a React node view.
 * The HLS playlist URL and transcoding status are resolved at runtime
 * through the audioUrlMap prop (same pattern as ImageBlock + imageUrlMap).
 *
 * ProseMirror node structure:
 * - type: "audioBlock"
 * - attrs: { audioUploadId, title, status, hlsPlaylistUrl, sourceUrl }
 */

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { safeHref } from "@/lib/escape-html";
import { AudioBlockNodeView } from "./AudioBlockNodeView";
import { audioLayoutCss } from "./media-layout";

export type AudioUploadStatus =
  | "PENDING"
  | "UPLOADED"
  | "TRANSCODING"
  | "READY"
  | "FAILED";

/** Block-level alignment when the audio block is rendered as a full-width row. */
export type AudioBlockAlignment = "left" | "center" | "right";

/**
 * "Side column" mode: when set, the block floats to the named side and
 * subsequent paragraphs wrap around it. Mirrors ImageBlock's float model so
 * audio embeds can sit beside body copy instead of always taking a full row.
 */
export type AudioBlockFloat = "none" | "left" | "right";

export interface AudioBlockAttributes {
  /** Reference to AudioUpload record by ID */
  audioUploadId: string;
  /** Display title (defaults to filename) */
  title?: string;
  /** Block alignment when float is "none" (left | center | right). */
  align?: AudioBlockAlignment;
  /** Side-column float (none | left | right). Wins over `align` when set. */
  float?: AudioBlockFloat;
  /** Current transcoding status — resolved at runtime, not persisted */
  status?: AudioUploadStatus;
  /** HLS playlist URL — resolved at runtime */
  hlsPlaylistUrl?: string | null;
  /** Direct source URL — resolved at runtime (fallback when HLS isn't ready) */
  sourceUrl?: string | null;
  /** Upload creation timestamp — resolved at runtime, used for timeout detection */
  uploadStartedAt?: string | null;
  /** Normalized amplitude peaks (200 floats 0-1) — resolved at runtime */
  waveformPeaks?: number[] | null;
  /**
   * When true, the public player exposes a download button for the direct
   * source file. Opt-in per embed — defaults to false so audio isn't
   * downloadable unless the organiser explicitly allows it.
   */
  allowDownload?: boolean;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    audioBlock: {
      /** Insert an audio block at the current position */
      insertAudioBlock: (attrs: AudioBlockAttributes) => ReturnType;
      /** Update audio block attributes */
      updateAudioBlock: (attrs: Partial<AudioBlockAttributes>) => ReturnType;
    };
  }
}

export const AudioBlock = Node.create({
  name: "audioBlock",

  group: "block",

  // Audio blocks are leaf nodes (no children)
  content: "",

  // Not editable inline
  atom: true,

  // Allow dragging
  draggable: true,

  addAttributes() {
    return {
      audioUploadId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-audio-upload-id"),
        renderHTML: (attributes) => {
          if (!attributes.audioUploadId) return {};
          return { "data-audio-upload-id": attributes.audioUploadId };
        },
      },
      title: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-title") ?? "",
        renderHTML: (attributes) => {
          if (!attributes.title) return {};
          return { "data-title": attributes.title };
        },
      },
      align: {
        default: "center",
        parseHTML: (element) =>
          (element.getAttribute("data-align") as AudioBlockAlignment) ??
          "center",
        renderHTML: (attributes) => ({
          "data-align": attributes.align ?? "center",
        }),
      },
      float: {
        default: "none",
        parseHTML: (element) =>
          (element.getAttribute("data-float") as AudioBlockFloat) ?? "none",
        renderHTML: (attributes) => ({
          "data-float": attributes.float ?? "none",
        }),
      },
      // Server-resolved attributes, refreshed from `audioUrlMap` by the editor
      // effect and re-resolved on render.
      //
      // NOT "runtime-only", despite what this comment used to claim:
      // `renderHTML: () => ({})` suppresses them from the serialized HTML, but
      // `editor.getJSON()` serializes EVERY attr, so whatever sits here is
      // persisted into `Event.body`. That is how saved documents ended up
      // carrying a presigned `sourceUrl` — a credential with an expiry — long
      // after the URL had died. The public renderer now treats the resolved
      // map as authoritative (see `resolveAudioNode`), so a stale baked value
      // is ignored rather than served; do not rely on it being absent.
      status: {
        default: "PENDING",
        // These are populated by the editor effect, not parsed from HTML
        renderHTML: () => ({}),
      },
      hlsPlaylistUrl: {
        default: null,
        renderHTML: () => ({}),
      },
      sourceUrl: {
        default: null,
        renderHTML: (attributes) => {
          if (!attributes.sourceUrl) return {};
          // The public download button treats data-source-url as a navigable
          // target (fetch + window.open fallback), so scheme-check it exactly
          // like the <audio src> below — a hostile stored doc must never bake
          // a javascript:/data: URL into this attribute ("#" is inert).
          return { "data-source-url": safeHref(attributes.sourceUrl) };
        },
      },
      uploadStartedAt: {
        default: null,
        renderHTML: () => ({}),
      },
      waveformPeaks: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute("data-waveform");
          if (!raw) return null;
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        },
        renderHTML: (attributes) => {
          if (!attributes.waveformPeaks) return {};
          return { "data-waveform": JSON.stringify(attributes.waveformPeaks) };
        },
      },
      allowDownload: {
        // Opt-in: audio is not downloadable unless the organiser flips this on.
        default: false,
        parseHTML: (element) =>
          element.getAttribute("data-allow-download") === "true",
        renderHTML: (attributes) => {
          // Emit the attribute only when true so the public HTML stays clean
          // and the hydrator's presence-check is unambiguous.
          if (!attributes.allowDownload) return {};
          return { "data-allow-download": "true" };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-type="audio-block"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as AudioBlockAttributes;
    const title = attrs.title || "Audio";
    // `||`, not `??`: an empty-string URL is "missing" here, exactly as in
    // AudioBlockNodeView (`attrs.sourceUrl || attrs.hlsPlaylistUrl`), so the
    // editor, the builder Preview and the public page pick the same file.
    const sourceUrl = attrs.sourceUrl || null;
    const hlsPlaylistUrl = attrs.hlsPlaylistUrl || null;
    const layoutStyle = audioLayoutCss(attrs.align, attrs.float);

    // For server-side HTML generation, produce a <figure> with an <audio>
    // element. Prefer `sourceUrl` (the original file): it plays from a plain
    // <audio src> everywhere, with no hls.js download. The playlist is the
    // fallback: the hydrator (`useHydrateAudioBlocks`) hands this src to
    // `attachAudioSource`, which plays an `.m3u8` natively where the browser
    // can (Safari) and through a lazily imported hls.js elsewhere
    // (Chrome/Firefox). resolveAudio returns an HLS-only item only when the
    // original could not be signed (object gone, or a signing failure it
    // reports), since the transcoder is dispatched with
    // `deleteSourceOnSuccess: false`. A browser with neither native HLS nor
    // Media Source Extensions still gets a dead player for that block.
    const audioSrc = sourceUrl || hlsPlaylistUrl;

    if (audioSrc) {
      return [
        "figure",
        mergeAttributes(HTMLAttributes, {
          "data-type": "audio-block",
          style: `${layoutStyle}padding: 12px 16px; background: var(--backgroundHover, #EFE7D6); border: 2px solid var(--borderColor, #211C16); border-radius: 0;`,
        }),
        [
          "audio",
          {
            controls: "true",
            preload: "metadata",
            // URLs normally come from the server-resolved audioUrlMap, but
            // doc-baked values survive resolution, so scheme-check them here
            // ("#" is an inert src for hostile docs).
            src: safeHref(audioSrc),
            style: "width: 100%; border-radius: 0;",
          },
        ],
        [
          "figcaption",
          {
            style:
              "font-size: 11px; color: var(--colorMuted, #5C544A); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700;",
          },
          title,
        ],
      ];
    }

    // Fallback: no playable URL. Most of the time this state will not change
    // on its own (the original is gone and there is no HLS, the upload never
    // finished, or the page's audio read failed with no baked URL), so only an
    // upload genuinely in flight says "processing"; anything else is neutral.
    // A titled block keeps showing its title, as before.
    const inFlight =
      attrs.status === "PENDING" ||
      attrs.status === "UPLOADED" ||
      attrs.status === "TRANSCODING";
    const placeholderText =
      attrs.title ||
      (inFlight ? "Audio processing\u2026" : "Audio unavailable");

    return [
      "figure",
      mergeAttributes(HTMLAttributes, {
        "data-type": "audio-block",
        style: `${layoutStyle}padding: 16px; background: var(--backgroundHover, #EFE7D6); border: 2px solid var(--borderColor, #211C16); border-radius: 0; text-align: center; color: var(--colorMuted, #5C544A);`,
      }),
      ["span", {}, placeholderText],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AudioBlockNodeView as any);
  },

  addCommands() {
    return {
      insertAudioBlock:
        (attrs) =>
        ({ commands }) => {
          // See ImageBlock for rationale — append an empty paragraph so the
          // cursor lands beneath the audio block instead of getting stuck
          // on an atomic node.
          return commands.insertContent([
            { type: this.name, attrs },
            { type: "paragraph" },
          ]);
        },
      updateAudioBlock:
        (attrs) =>
        ({ commands }) => {
          return commands.updateAttributes(this.name, attrs);
        },
    };
  },
});
