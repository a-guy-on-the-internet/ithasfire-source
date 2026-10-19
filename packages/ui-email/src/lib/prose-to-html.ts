/**
 * Lightweight ProseMirror JSON to HTML converter for email rendering.
 * Does not depend on TipTap or ProseMirror libraries.
 */

import libEscapeHtml from "escape-html";

import { tokens } from "../theme/tokens";

export type ProseMirrorNode = {
  type: string;
  text?: string;
  content?: ProseMirrorNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

export type ProseMirrorDoc = {
  type: "doc";
  content: ProseMirrorNode[];
};

/**
 * Escape HTML special characters. Delegates to the maintained `escape-html`
 * package, which escapes `&`, `<`, `>`, `"` and `'` — safe for both text
 * content and double/single-quoted attribute values (e.g. link `href`s).
 */
const escapeHtml = (text: string): string => libEscapeHtml(text);

const ALLOWED_HREF_SCHEMES = /^(?:https?:|mailto:|tel:)/i;

/**
 * Allow only `http:`, `https:`, `mailto:`, `tel:` and same-origin relative
 * hrefs; everything else (`javascript:`, `data:`, protocol-relative `//host`
 * — including the `/\host` backslash form the URL parser normalizes to
 * `//host` — unknown schemes) becomes `"#"`. Browsers/mail clients strip
 * tab/CR/LF and leading/trailing control characters before parsing URLs, so
 * the checks run against a control-stripped copy to defeat obfuscations like
 * `"java\tscript:"`. Mirrors `apps/web/src/lib/escape-html.ts`'s `safeHref`
 * (this package deliberately has no cross-app dependency, so the logic is
 * duplicated locally rather than imported).
 */
const safeHref = (value: string): string => {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point (see comment above)
  const stripped = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  if (stripped.startsWith("/")) {
    // 47 = "/", 92 = backslash — the URL parser maps backslash to "/" in the
    // authority position for http(s), so "/\host" is protocol-relative too.
    const second = stripped.charCodeAt(1);
    return second === 47 || second === 92 ? "#" : value.trim();
  }
  return ALLOWED_HREF_SCHEMES.test(stripped) ? value.trim() : "#";
};

/**
 * Convert marks (bold, italic, link, etc.) to HTML wrapper.
 */
const renderMarks = (
  text: string,
  marks?: ProseMirrorNode["marks"],
): string => {
  if (!marks || marks.length === 0) return escapeHtml(text);

  let result = escapeHtml(text);

  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        result = `<strong>${result}</strong>`;
        break;
      case "italic":
        result = `<em>${result}</em>`;
        break;
      case "strike":
        result = `<s>${result}</s>`;
        break;
      case "link": {
        const href = mark.attrs?.href ?? "#";
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const safeLinkHref = safeHref(String(href));
        result = `<a href="${escapeHtml(safeLinkHref)}" style="color: ${tokens.colors.brandAccent}; text-decoration: underline;">${result}</a>`;
        break;
      }
      default:
        // Unknown mark, keep text as-is
        break;
    }
  }

  return result;
};

/**
 * Convert a single ProseMirror node to HTML.
 */
const renderNode = (node: ProseMirrorNode): string => {
  switch (node.type) {
    case "text":
      return renderMarks(node.text ?? "", node.marks);

    case "paragraph":
      if (!node.content || node.content.length === 0) {
        return "<p>&nbsp;</p>";
      }
      return `<p style="margin: 0 0 16px 0; line-height: 1.6;">${(node.content ?? []).map(renderNode).join("")}</p>`;

    case "heading": {
      // `attrs` is stored JSON, not a typed number: it was interpolated
      // straight into the tag name, so `level: "1 onclick=…><a href=…"`
      // injected raw HTML into the email. Clamp to the three sizes we style.
      const rawLevel = Number(node.attrs?.level);
      const level =
        rawLevel === 1 || rawLevel === 2 || rawLevel === 3 ? rawLevel : 2;
      const sizes: Record<number, string> = {
        1: "24px",
        2: "20px",
        3: "18px",
      };
      const fontSize = sizes[level] ?? "18px";
      const content = (node.content ?? []).map(renderNode).join("");
      return `<h${level} style="margin: 0 0 12px 0; font-size: ${fontSize}; font-weight: 600; line-height: 1.3;">${content}</h${level}>`;
    }

    case "bulletList":
      return `<ul style="margin: 0 0 16px 0; padding-left: 24px;">${(node.content ?? []).map(renderNode).join("")}</ul>`;

    case "orderedList":
      return `<ol style="margin: 0 0 16px 0; padding-left: 24px;">${(node.content ?? []).map(renderNode).join("")}</ol>`;

    case "listItem":
      return `<li style="margin-bottom: 8px;">${(node.content ?? []).map(renderNode).join("")}</li>`;

    case "blockquote":
      return `<blockquote style="margin: 0 0 16px 0; padding-left: 16px; border-left: 3px solid ${tokens.colors.border}; color: ${tokens.colors.mutedText};">${(node.content ?? []).map(renderNode).join("")}</blockquote>`;

    case "horizontalRule":
      return `<hr style="border: none; border-top: 1px solid ${tokens.colors.border}; margin: 24px 0;" />`;

    case "hardBreak":
      return "<br />";

    default:
      // Unknown node type, try to render content if present
      if (node.content) {
        return (node.content ?? []).map(renderNode).join("");
      }
      return "";
  }
};

/**
 * Convert a ProseMirror document to HTML suitable for email rendering.
 */
export const proseMirrorDocToEmailHtml = (
  doc: ProseMirrorDoc | null,
): string => {
  if (!doc?.content) return "";
  return doc.content.map(renderNode).join("");
};

/**
 * Check if a ProseMirror doc has any meaningful content.
 */
export const hasContent = (doc: ProseMirrorDoc | null): boolean => {
  if (!doc?.content) return false;

  const checkNode = (node: ProseMirrorNode): boolean => {
    if (node.type === "text" && node.text?.trim()) {
      return true;
    }
    if (node.content) {
      return node.content.some(checkNode);
    }
    return false;
  };

  return doc.content.some(checkNode);
};
