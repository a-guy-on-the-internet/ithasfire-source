import type { EventBody, EventPageBlock } from "@th/schema";
import {
  proseMirrorDocToHtml,
  type AudioUrlMapEntry,
} from "@/app/admin/[slug]/events/new/_components/prose-editor";
import { escapeHtml, safeHref } from "@/lib/escape-html";

/**
 * Flatten an EventBody (v1 sections or v0 flat blocks) into a single HTML
 * string.  Every block type is handled:
 *
 * - `richText` — ProseMirror doc → HTML via tiptap (images resolved inline).
 * - `image`   — standalone image block → `<figure><img /></figure>`.
 * - `spacer`  — vertical spacing div.
 * - `cta`     — call-to-action button link.
 *
 * This is the **only** place EventBody → HTML conversion should happen.
 * The admin EventPreview calls `proseMirrorDocToHtml` directly because its
 * content is always a single raw ProseMirrorDoc, not wrapped in EventBody.
 *
 * Bodies are user-authored (and can be proposed by anonymous visitors), so
 * every interpolated value is escaped and CTA hrefs are scheme-checked here
 * regardless of backend sanitization.
 */
export function eventBodyToHtml(
  body: EventBody | null | undefined,
  imageUrlMap: Record<string, string> = {},
  audioUrlMap?: Record<string, AudioUrlMapEntry>,
): string {
  if (!body) return "";

  // Extract blocks from either v1 (sections) or v0 (flat blocks) format
  const blocks: EventPageBlock[] = [];

  if ("version" in body && body.version === 1) {
    for (const section of body.sections) {
      if (section.layout.type === "singleColumn") {
        blocks.push(...section.layout.columns[0].blocks);
      } else {
        for (const col of section.layout.columns) {
          blocks.push(...col.blocks);
        }
      }
    }
  } else if ("blocks" in body) {
    blocks.push(...body.blocks);
  }

  const htmlParts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "richText": {
        if (block.doc) {
          const html = proseMirrorDocToHtml(
            block.doc,
            imageUrlMap,
            audioUrlMap,
          );
          if (html) htmlParts.push(html);
        }
        break;
      }

      case "image": {
        const url = imageUrlMap[block.asset.assetId];
        if (url) {
          const alt = block.alt || "Event image";
          htmlParts.push(
            `<figure style="margin: 16px auto; max-width: 100%;"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" style="width: 100%; height: auto; border-radius: 0; display: block;" /></figure>`,
          );
        }
        break;
      }

      case "spacer": {
        const heights: Record<string, number> = { sm: 16, md: 32, lg: 64 };
        const h = heights[block.size] ?? 32;
        htmlParts.push(
          `<div style="height: ${h}px;" aria-hidden="true"></div>`,
        );
        break;
      }

      case "cta": {
        // Design System v2 button grammar (fake button inside content —
        // stays an <a>, adopts the atom's look). Theme vars come from the
        // Tamagui theme / ActiveThemeInjector; every fallback is the STUB
        // value (what SSR paints before hydration). Primary rests on the
        // `brandSecondaryHover` (#B93312) rung with a WHITE label (5.92:1) —
        // NOT `brandSecondary` (#E2481D), which carries no AA small-text
        // foreground in either polarity. Secondary = ink outline.
        const isPrimary = block.variant === "primary";
        const bg = isPrimary
          ? "var(--brandSecondaryHover, #B93312)"
          : "transparent";
        const color = isPrimary
          ? "var(--onBrandSecondary, #FFFFFF)"
          : "var(--color, #211C16)";
        const border = isPrimary
          ? "none"
          : "2px solid var(--color, #211C16)";
        htmlParts.push(
          `<div style="text-align: center; margin: 16px 0;"><a href="${escapeHtml(safeHref(block.href))}" style="display: inline-block; padding: 12px 32px; background: ${bg}; color: ${color}; border: ${border}; border-radius: 0; text-decoration: none; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px;">${escapeHtml(block.label)}</a></div>`,
        );
        break;
      }
    }
  }

  return htmlParts.join("");
}
